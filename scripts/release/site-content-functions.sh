#!/usr/bin/env bash
# Shared read-only verification functions. Caller supplies the validated manifest.
# fetch_code <body> <headers> <transport> <command...>：执行只读 HTTP 请求命令并输出最后一次的状态码（同 shadow-devkit
# 模板）。是否成功、重试或失败由同目录的 transport-policy.mjs 按命令退出码、HTTP 状态和最终响应的 Retry-After 判定：
# 只有命令退出 0 且 HTTP 200 才成功（返回 0）；HTTP 200 但 curl 中途失败（exit 18/28/56）、没有 HTTP 响应（000）和
# HTTP 408/429/500/502/503/504 有界重试，最多 TRANSPORT_ATTEMPTS 次，按 Retry-After 或指数退避等待；其他状态（如
# 404）、命令在发出请求前失败（输出不是三位状态码）和重试耗尽都返回 1。每次请求前删除上一次的正文与响应头，
# 残留内容不会被当成本次响应。只用于读取，不用于 deploy、promote。
TRANSPORT_ATTEMPTS=3
fetch_code() {
  local body="$1" headers="$2" transport="$3" attempt=1 code status decision action wait_ms
  shift 3
  while :; do
    rm -f "$body" "$headers" || { echo "❌ 无法清理上次响应文件" >&2; return 1; }
    status=0
    code="$("$@")" || status=$?
    # Fast path for the policy's own first rule (exit 0 and HTTP 200 is success): a release reads every manifest
    # entry three times, and starting node for each success would add seconds without changing any decision.
    if [ "$status" = 0 ] && [ "$code" = 200 ]; then printf '%s' "$code"; return 0; fi
    decision="$(node "$ROOT_DIR/scripts/release/transport-policy.mjs" "$status" "$code" "$attempt" "$headers" "$transport")" || return 1
    action="${decision%% *}"
    wait_ms="${decision#* }"
    case "$action" in
      success) printf '%s' "$code"; return 0 ;;
      fail) printf '%s' "$code"; return 1 ;;
      retry) echo "⚠️  请求未完成（HTTP ${code:-无}，exit ${status}；第 ${attempt}/${TRANSPORT_ATTEMPTS} 次），${wait_ms} ms 后重试" >&2 ;;
      *) return 1 ;;
    esac
    sleep "$(awk -v ms="$wait_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
    attempt=$((attempt + 1))
  done
}

sha256_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

verify_against_commit() {
  local base_url="$1"
  local label="$2"
  local access="${3:-public}"
  local file request_path expected_types body headers code content_type local_hash remote_hash
  local verified_count=0
  while IFS=$'\t' read -r file request_path expected_types; do
    body="$(mktemp)"
    headers="$(mktemp)"
    if [ "$access" = "deployment" ]; then
      if ! code="$(PATH="$ROOT_DIR/scripts/release/http-bin:$PATH" fetch_code "$body" "$headers" vercel vercel curl "$request_path" --deployment "$base_url" --scope "$TEAM_ID" --yes -- --request GET --no-location --max-redirs 0 --silent --show-error --max-time 30 -D "$headers" -o "$body" -w "%{http_code}")"; then
        rm -f "$body" "$headers"
        echo "❌ ${label}: ${request_path} 候选读取失败（HTTP ${code:-无}）" >&2
        return 1
      fi
    else
      if ! code="$(fetch_code "$body" "$headers" curl curl --disable --request GET --no-location --max-redirs 0 --silent --show-error --max-time 30 -D "$headers" -o "$body" -w "%{http_code}" "${base_url}${request_path}")"; then
        rm -f "$body" "$headers"
        echo "❌ ${label}: ${base_url}${request_path} 读取失败（HTTP ${code:-无}）" >&2
        return 1
      fi
    fi
    if [ "$code" != "200" ] || ! awk '{ gsub(/\r/, "") } /^HTTP\// && $2 ~ /^3[0-9][0-9]$/ { bad=1 } END { exit bad }' "$headers"; then
      rm -f "$body" "$headers"
      echo "❌ ${label}: ${base_url}${request_path} 返回 HTTP ${code}" >&2
      return 1
    fi
    content_type="$(awk 'tolower($1) == "content-type:" { split($2, value, ";"); type=tolower(value[1]); gsub(/\r/, "", type) } END { print type }' "$headers")"
    case ",$expected_types," in
      *",$content_type,"*) ;;
      *)
        rm -f "$body" "$headers"
        echo "❌ ${label}: ${request_path} MIME ${content_type:-missing} 不符合 ${expected_types}" >&2
        return 1 ;;
    esac
    if ! local_hash="$(git show "${HEAD_SHA}:${file}" | sha256_stdin)"; then
      rm -f "$body" "$headers"
      echo "❌ ${label}: 无法读取提交 ${HEAD_SHA} 中的 ${file}" >&2
      return 1
    fi
    if ! remote_hash="$(sha256_stdin < "$body")"; then
      rm -f "$body" "$headers"
      echo "❌ ${label}: 无法计算响应 ${request_path} 的 SHA-256" >&2
      return 1
    fi
    rm -f "$body" "$headers"
    if [ "$local_hash" != "$remote_hash" ]; then
      echo "❌ ${label}: ${base_url}${request_path} 与提交 ${HEAD_SHA:0:12} 逐字节不一致" >&2
      echo "   提交 ${local_hash:0:16}… / 线上 ${remote_hash:0:16}…" >&2
      return 1
    fi
    verified_count=$((verified_count + 1))
    echo "✅ ${label}: ${request_path} [HTTP 200 · ${content_type} · SHA-256 相符]"
  done <<< "$VERIFY_MANIFEST"
  echo "✅ ${label}: ${verified_count} 项站点资产与提交 ${HEAD_SHA} 逐字节一致"
  return 0
}
