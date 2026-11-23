#!/usr/bin/env bash
# ==============================================================================
# Shadow Snap 生产发布与原子验收（基于 shadow-devkit templates/release/deploy-production.sh）
#
# 发布门禁（硬性，没有任何 SKIP/FORCE 开关）：
#   联网部署前必须同时满足：
#     ① 工作区干净（含未跟踪文件）；
#     ② 当前分支等于 config/release-production.json 的 productionBranch（production）；
#     ③ HEAD 等于 fetch 后的 origin/<分支>，并与 ls-remote 读到的真实远端一致。
#   推送 production 受 .githooks/pre-push 的本地 CI 记录保护。之后复跑 admissionCommands；准入结束后、
#   上传前、上传后各复核一次门禁，且 HEAD 必须仍是第一次锁定的提交。上传的是从锁定提交写出的独立快照，
#   不是工作区，上传期间工作区的任何改动都不会进入部署。promote 前逐字节比对部署内容，不一致不 promote；
#   promote 后逐域名验收，任一失败退出 1。
#
# 与模板的差异：逐字节验收清单不在配置里手写（release-config.mjs 拒绝 verifyFiles），而是由
# scripts/seo/site-artifact-manifest.mjs 从静态校验与多语言页面生成器派生，并同时核对 MIME、禁止重定向；
# 比对函数在 scripts/release/site-content-functions.sh，只读复核脚本 verify-site-content.sh 共用同一份。
# 全部参数只来自 config/release-production.json（经 release-config.mjs 校验）。
# 兼容 macOS /bin/bash 3.2：不使用数组、mapfile 与关联数组。
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "❌ $*" >&2
  exit 1
}

# ------------------------------------------------------------------------------
# 1. Node 运行时：优先 mise 提供的 .nvmrc 版本，并断言主版本一致
# ------------------------------------------------------------------------------
echo "👉 [1/8] 检查 Node 运行时..."
if [ -f .nvmrc ]; then
  NODE_SPEC="$(tr -d '[:space:]' < .nvmrc)"
  NODE_SPEC="${NODE_SPEC#v}"
  if command -v mise >/dev/null 2>&1; then
    MISE_NODE="$(mise where "node@${NODE_SPEC}" 2>/dev/null || true)"
    if [ -n "$MISE_NODE" ] && [ -d "$MISE_NODE/bin" ]; then
      export PATH="$MISE_NODE/bin:$PATH"
    fi
  fi
  command -v node >/dev/null 2>&1 || fail "未找到 node"
  CURRENT_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$CURRENT_MAJOR" != "${NODE_SPEC%%.*}" ]; then
    fail "unsupported_node_runtime: 需要 Node ${NODE_SPEC}，当前为 $(node -v)"
  fi
fi
command -v node >/dev/null 2>&1 || fail "未找到 node"
echo "✅ Node 运行时: $(node -v)"

# ------------------------------------------------------------------------------
# 2. 读取并校验发布配置
# ------------------------------------------------------------------------------
echo "👉 [2/8] 读取生产发布参数..."
CONFIG="scripts/release/release-config.mjs"
node "$CONFIG" check
config_get() { node "$CONFIG" get "$1"; }

EXPECTED_BRANCH="$(config_get productionBranch)"
TEAM_ID="$(config_get vercel.teamId)"
PROJECT_ID="$(config_get vercel.projectId)"
PROJECT_NAME="$(config_get vercel.projectName)"
DOMAINS="$(config_get vercel.productionDomains)"
ACCEPT_PATH="$(config_get acceptance.path)"
BODY_INCLUDES="$(config_get acceptance.bodyIncludes)"
REQUIRED_HEADERS="$(config_get acceptance.requiredHeaders)"
MAX_SECONDS="$(config_get acceptance.maxSeconds)"
[ -n "$DOMAINS" ] || fail "release_config_domains_missing"

echo "========================================================"
echo "🚀 ${PROJECT_NAME} 生产发布流水线启动"
echo "   Vercel Team: ${TEAM_ID} · Project: ${PROJECT_ID}"
echo "========================================================"

# ------------------------------------------------------------------------------
# 3. 发布门禁（任何 Vercel 调用之前）
# ------------------------------------------------------------------------------
echo "👉 [3/8] 校验发布门禁..."
# assert_release_identity <阶段>：工作区干净、在发布分支、HEAD 等于远端。
# 第一次调用锁定 HEAD_SHA；之后每次都要求仍是同一提交，准入命令或上传期间切换分支、
# 提交、改动远端都会中止发布。
HEAD_SHA=""
assert_release_identity() {
  local stage="$1" status branch head tracking live
  status="$(git status --porcelain --untracked-files=all)"
  if [ -n "$status" ]; then
    echo "❌ 拒绝发布（${stage}）: 工作区存在未提交或未跟踪的改动，发布内容必须是已提交的版本。" >&2
    printf '%s\n' "$status" | sed 's/^/   /' >&2
    echo "   请先提交（或还原）这些改动，再重新发布。" >&2
    exit 1
  fi

  branch="$(git symbolic-ref --quiet --short HEAD || true)"
  if [ "$branch" != "$EXPECTED_BRANCH" ]; then
    echo "❌ 拒绝发布（${stage}）: 当前分支为 ${branch:-<detached>}，生产发布只允许从 ${EXPECTED_BRANCH} 执行。" >&2
    echo "   先把要发布的提交并入 ${EXPECTED_BRANCH} 并推送（推送需先通过 npm run ci 留下本地 CI 记录）；功能与试验分支不得直接上生产。" >&2
    exit 1
  fi

  head="$(git rev-parse HEAD)"
  if [ -n "$HEAD_SHA" ] && [ "$head" != "$HEAD_SHA" ]; then
    fail "拒绝发布（${stage}）: HEAD 已从 ${HEAD_SHA:0:12} 变为 ${head:0:12}，发布期间不得改动仓库"
  fi
  git fetch --quiet origin "+refs/heads/${EXPECTED_BRANCH}:refs/remotes/origin/${EXPECTED_BRANCH}" ||
    fail "拒绝发布（${stage}）: 无法 fetch origin/${EXPECTED_BRANCH}"
  tracking="$(git rev-parse --verify --quiet "refs/remotes/origin/${EXPECTED_BRANCH}" || true)"
  live="$(git ls-remote --exit-code origin "refs/heads/${EXPECTED_BRANCH}" | awk 'NR == 1 { print $1 }' || true)"
  if [ -z "$tracking" ] || [ -z "$live" ]; then
    fail "拒绝发布（${stage}）: 无法确认远端 origin/${EXPECTED_BRANCH} 的提交"
  fi
  if [ "$head" != "$tracking" ] || [ "$head" != "$live" ]; then
    echo "❌ 拒绝发布（${stage}）: HEAD (${head:0:12}) 与远端 ${EXPECTED_BRANCH} 不一致" >&2
    echo "   origin/${EXPECTED_BRANCH} = ${tracking:0:12} · ls-remote = ${live:0:12}" >&2
    echo "   先推送本地提交或拉取远端更新；线上不得出现仓库里没有的版本，也不得回退到旧版本。" >&2
    exit 1
  fi
  HEAD_SHA="$head"
}
assert_release_identity "发布前"
echo "✅ 门禁通过: 分支 ${EXPECTED_BRANCH} · 提交 ${HEAD_SHA:0:12} · 工作区干净"
echo "   本次发布内容: $(git log -1 --pretty=%s "$HEAD_SHA")"

# ------------------------------------------------------------------------------
# 4. 发布准入：在本次提交上复跑 admissionCommands（npm ci / 合约测试 / 静态校验，白名单环境，见
#    run-admission-commands.mjs）。npm run ci 与托管 CI 经 config/local-ci.json 的 include 引用同一份。
# ------------------------------------------------------------------------------
echo "👉 [4/8] 运行发布准入命令..."
node scripts/release/run-admission-commands.mjs
# Admission commands must not leave the worktree dirty: they were meant to check the committed tree.
[ -z "$(git status --porcelain --untracked-files=all)" ] || fail "拒绝发布: 准入命令改动了工作区"
assert_release_identity "准入后"

VERIFY_MANIFEST="$(node scripts/seo/site-artifact-manifest.mjs)"
[ -n "$VERIFY_MANIFEST" ] || fail "站点资产验收清单为空，拒绝部署。"
SHADOW_CURL_BIN="$(command -v curl)"
case "$SHADOW_CURL_BIN" in
  /*) ;;
  *) fail "无法确定原生 curl 路径，拒绝部署。" ;;
esac
export SHADOW_CURL_BIN

# Explicit template: macOS mktemp ignores TMPDIR without one.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/release.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

# fetch_code、sha256_stdin、verify_against_commit（逐字节比对派生清单）
. "$ROOT_DIR/scripts/release/site-content-functions.sh"

# verify_endpoint <domain>：acceptance.path 必须直接返回 HTTP 200（不跟随重定向），带齐 acceptance.requiredHeaders，
# 正文包含 acceptance.bodyIncludes。
verify_endpoint() {
  local url="https://$1${ACCEPT_PATH}" headers="$WORK_DIR/endpoint-headers" body="$WORK_DIR/endpoint-body" code name
  code=""
  code="$(fetch_code "$body" "$headers" curl curl --disable --request GET --no-location --max-redirs 0 --silent --show-error --max-time "$MAX_SECONDS" -D "$headers" -o "$body" -w "%{http_code}" "$url")" ||
    { echo "❌ 生产验收: ${url} 读取失败（HTTP ${code:-无}）" >&2; return 1; }
  while IFS= read -r name <&3; do
    [ -n "$name" ] || continue
    # A here-string, not a pipe: `grep -q` exits at the first match, and under `set -o pipefail` the resulting
    # SIGPIPE on the writer turns a present header into "缺少响应头".
    if ! grep -iq "^${name}:" <<<"$(tr -d '\r' < "$headers")"; then
      echo "❌ 生产验收: ${url} 缺少响应头 ${name}" >&2
      return 1
    fi
  done 3<<<"$REQUIRED_HEADERS"
  if [ -n "$BODY_INCLUDES" ] && ! grep -Fq -- "$BODY_INCLUDES" "$body"; then
    echo "❌ 生产验收: ${url} 正文不包含预期片段" >&2
    return 1
  fi
  echo "✅ 端点验收: ${url} [HTTP 200 · $(printf '%s' "$REQUIRED_HEADERS" | tr '\n' ' ')· 正文片段]"
}

# ------------------------------------------------------------------------------
# 5. 绑定并同步 Vercel 生产环境
# ------------------------------------------------------------------------------
echo "👉 [5/8] 同步 Vercel 生产环境变量..."
# Fail closed on conflicting inherited identity or an existing wrong local link.
node scripts/release/vercel-project-binding.mjs
export VERCEL_ORG_ID="$TEAM_ID"
export VERCEL_PROJECT_ID="$PROJECT_ID"
export VERCEL_TELEMETRY_DISABLED=1
vercel pull --yes --environment=production --scope "$TEAM_ID"
node scripts/release/vercel-project-binding.mjs --check

# ------------------------------------------------------------------------------
# 6. 远程构建 production 类型部署，不切换域名；promote 前逐字节预检
#    远程构建（平台构建）是获得 /_vercel/* 平台注入路由的前提：Web Analytics 的 /_vercel/insights/* 只对
#    平台构建的部署提供，本地 `vercel build` + `--prebuilt` 产物不会获得这些路由。
#    必须带 --prod：项目的 Auto-assign Custom Production Domains 处于关闭状态，只有 production 类型的部署
#    被 promote 时才会真正切换生产目标；若发布 preview 部署，promote 只会另建一个不带域名的新 production
#    部署，线上内容原地不动（第 8 步的逐字节比对会因此判失败）。
#    --skip-domain：本步不动域名，切换统一交给第 7 步。
# ------------------------------------------------------------------------------
echo "👉 [6/8] 触发 Vercel 远程构建部署（production 类型，暂不切换域名）..."
node scripts/release/vercel-project-binding.mjs --check
assert_release_identity "上传前"
# 把锁定提交写成临时目录再上传：内容只来自提交，工作区里的未跟踪、被忽略文件以及上传期间的改动都不会
# 进入部署（快照里的 .vercelignore 照常生效）。直接写 blob 原始字节，不走 checkout，本机的 smudge 过滤器与
# 换行转换都不起作用。submodule 无法包含，直接拒绝。
SNAPSHOT_DIR="$WORK_DIR/snapshot"
mkdir -p "$SNAPSHOT_DIR/.vercel"
git ls-tree -r -z --full-tree "$HEAD_SHA" > "$WORK_DIR/snapshot.tree"
while IFS= read -r -d '' ENTRY; do
  read -r ENTRY_MODE _ ENTRY_OBJECT <<<"${ENTRY%%$'\t'*}"
  ENTRY_PATH="$SNAPSHOT_DIR/${ENTRY#*$'\t'}"
  mkdir -p "$(dirname "$ENTRY_PATH")"
  case "$ENTRY_MODE" in
    100644 | 100755)
      git cat-file blob "$ENTRY_OBJECT" > "$ENTRY_PATH"
      if [ "$ENTRY_MODE" = "100755" ]; then chmod +x "$ENTRY_PATH"; fi
      ;;
    120000) ln -s "$(git cat-file blob "$ENTRY_OBJECT")" "$ENTRY_PATH" ;;
    160000) fail "拒绝发布: 提交 ${HEAD_SHA:0:12} 含 submodule ${ENTRY#*$'\t'}，发布快照无法包含其内容" ;;
    *) fail "拒绝发布: 提交 ${HEAD_SHA:0:12} 含无法识别的条目 ${ENTRY_MODE} ${ENTRY#*$'\t'}" ;;
  esac
done < "$WORK_DIR/snapshot.tree"
cp .vercel/project.json "$SNAPSHOT_DIR/.vercel/project.json"
DEPLOY_OUTPUT="$(vercel deploy "$SNAPSHOT_DIR" --meta "releaseCommitSha=${HEAD_SHA}" --prod --skip-domain --yes --scope "$TEAM_ID")"
assert_release_identity "上传后"
DEPLOY_URL="$(printf '%s\n' "$DEPLOY_OUTPUT" | grep -Eo 'https://[a-zA-Z0-9.-]+\.vercel\.app' | head -n 1 || true)"
if [ -z "$DEPLOY_URL" ]; then
  echo "❌ 部署未能捕获 Deployment URL，原始输出:" >&2
  printf '%s\n' "$DEPLOY_OUTPUT" >&2
  exit 1
fi

# 切域名之前先比对部署内容（经 Vercel 受保护访问读取候选）：不一致就中止，生产域名保持不动。
echo "👉 部署预检: 比对 ${DEPLOY_URL} 与本次提交..."
verify_against_commit "$DEPLOY_URL" "部署预检" "deployment" ||
  fail "部署预检未通过，已中止发布，生产域名未做任何切换。"

# ------------------------------------------------------------------------------
# 7. 核对部署身份后 Promote
# ------------------------------------------------------------------------------
echo "👉 [7/8] 核对部署身份并 Promote 到生产域名..."
# A successful CLI response is not sufficient: verify the deployed resource identity.
node scripts/release/vercel-project-binding.mjs --check
vercel api "/v13/deployments/${DEPLOY_URL#https://}" --scope "$TEAM_ID" --raw |
  node scripts/release/vercel-project-binding.mjs --deployment "$HEAD_SHA"
vercel promote "$DEPLOY_URL" --yes --scope "$TEAM_ID"
echo "✅ Promote 完成"

# ------------------------------------------------------------------------------
# 8. 逐域名验收：逐字节比对派生清单，再验收端点（直接 200、响应头、正文片段）
# ------------------------------------------------------------------------------
echo "👉 [8/8] 生产域名验收..."
ROLLBACK_HINT="已 promote 到 ${DEPLOY_URL}。如需回滚：在 Vercel 中找到上一个生产部署，执行 vercel promote <上一个部署 URL> --scope ${TEAM_ID}，或用上一个已发布提交重新运行本脚本。"
while IFS= read -r DOMAIN <&4; do
  [ -n "$DOMAIN" ] || continue
  verify_against_commit "https://${DOMAIN}" "线上比对 ${DOMAIN}" ||
    fail "线上内容与已复核提交不符（${DOMAIN}），可能被其他部署覆盖，请立即排查。${ROLLBACK_HINT}"
  verify_endpoint "$DOMAIN" || fail "生产验收失败（${DOMAIN}），请立即排查。${ROLLBACK_HINT}"
done 4<<<"$DOMAINS"

echo "========================================================"
echo "🎉 ${PROJECT_NAME} 生产发布完成，所有生产域名验收通过"
echo "   线上版本 = 提交 ${HEAD_SHA}（${EXPECTED_BRANCH}，工作区干净）"
echo "========================================================"

# ------------------------------------------------------------------------------
# 9. 矩阵事实广播：只有配置 matrixBroadcast: true 的矩阵产品才同步到同级 shadow-portal。
#    发布已经完成，本步任何失败都只打印警告，不改变退出码。
# ------------------------------------------------------------------------------
if [ "$(config_get matrixBroadcast)" = "true" ]; then
  echo ""
  # 从 .worktrees/<name> 发布时 ROOT_DIR 是 worktree，按 git common dir 回到主仓库再找同级 shadow-portal
  COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  PORTAL_DIR="$(dirname "${COMMON_DIR:-$ROOT_DIR/.git}")/../shadow-portal"
  if [ -f "$PORTAL_DIR/scripts/matrix/check-or-sync-matrix.mjs" ]; then
    echo "📡 [矩阵事实广播] 正在同步最新发布版本到 Shadow Portal..."
    (cd "$PORTAL_DIR" && node scripts/matrix/check-or-sync-matrix.mjs --sync) ||
      echo "⚠️ [矩阵事实广播] 同步失败，不影响本次已完成的生产发布，请在 Portal 手动运行 npm run matrix:sync" >&2
  else
    echo "⚠️ [矩阵事实广播] 未找到 ${PORTAL_DIR}/scripts/matrix/check-or-sync-matrix.mjs，已跳过（不影响本次生产发布）" >&2
  fi
fi
