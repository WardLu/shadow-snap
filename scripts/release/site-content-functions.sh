#!/usr/bin/env bash
# Shared read-only verification functions. Caller supplies the validated manifest.
# fetch_code <command...>：执行一次 HTTP 请求命令，输出状态码并返回命令的退出码。
# 只在瞬时失败时重试，最多 TRANSPORT_ATTEMPTS 次：没有 HTTP 响应（curl 输出 000：TLS 握手断开、DNS、
# 连接超时等），或 HTTP 408/429/500/502/503/504（与 curl --retry 认定的瞬时状态一致，promote 后也可能短暂出现）。
# 其他 HTTP 状态（如 404）立即返回，由调用方判定。命令在启动 curl 前失败时输出为空，同样不重试。
TRANSPORT_ATTEMPTS=3
fetch_code() {
  local attempt=1 code status
  while :; do
    status=0
    code="$("$@")" || status=$?
    case "$code" in
      000|408|429|500|502|503|504) ;;
      *) printf '%s' "$code"; return "$status" ;;
    esac
    if [ "$attempt" -ge "$TRANSPORT_ATTEMPTS" ]; then
      printf '%s' "$code"
      return "$status"
    fi
    echo "⚠️  请求返回 HTTP ${code}（第 ${attempt}/${TRANSPORT_ATTEMPTS} 次），1 秒后重试" >&2
    attempt=$((attempt + 1))
    sleep 1
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
      if ! code="$(PATH="$ROOT_DIR/scripts/release/http-bin:$PATH" fetch_code vercel curl "$request_path" --deployment "$base_url" --scope "$TEAM_ID" --yes -- --request GET --no-location --max-redirs 0 --silent --show-error --max-time 30 -D "$headers" -o "$body" -w "%{http_code}")"; then
        rm -f "$body" "$headers"
        echo "❌ ${label}: ${request_path} 候选读取命令失败" >&2
        return 1
      fi
    else
      if ! code="$(fetch_code curl --disable --request GET --no-location --max-redirs 0 --silent --show-error --max-time 30 -D "$headers" -o "$body" -w "%{http_code}" "${base_url}${request_path}")"; then
        rm -f "$body" "$headers"
        echo "❌ ${label}: ${request_path} 生产读取命令失败" >&2
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
