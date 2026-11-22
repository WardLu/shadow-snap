#!/usr/bin/env bash
# ==============================================================================
# Shadow Snap 生产环境一键发布与原子验收脚本
# 作用：物理消除 Node 运行时漂移、Vercel 散装命令遗漏参数、等待未开启的 Webhook 等问题。
#
# 发布门禁（硬性，无绕过开关）：
#   发布上传的是「当前工作区快照」，若不设门禁，未提交或未推送的试验内容会直接
#   成为生产版本。因此本脚本在联网前强制要求：工作区干净、当前分支就是配置声明的
#   发布分支（production）、HEAD 与 origin/<发布分支> 完全一致。要发布就必须先让
#   内容进入 production 并推送（推送受 .githooks/pre-push 的本地 CI 凭据闸门保护），
#   从而保证线上内容始终等于仓库 production 分支上的某个提交。
#   门禁之后、联网之前还会本地复跑准入命令
#   （config/release-production.json 的 admissionCommands），确保发出的是验过的版本。
# ==============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

# The validation consumer derives routes/assets from the shared page graph below.

PROJECT_NAME="$(node -p "require('./package.json').name || 'project'" 2>/dev/null || basename "$ROOT_DIR")"
echo "========================================================"
echo "🚀 ${PROJECT_NAME} 生产发布流水线启动"
echo "========================================================"

# ------------------------------------------------------------------------------
# 1. 强制锁死 Node 22 运行时（自愈环境，绝不依赖全局 Node）
# ------------------------------------------------------------------------------
echo "👉 [1/8] 检查并自愈 Node 运行时..."
if command -v mise >/dev/null 2>&1; then
  MISE_NODE="$(mise where node@22 2>/dev/null || true)"
  if [ -n "$MISE_NODE" ] && [ -d "$MISE_NODE/bin" ]; then
    export PATH="$MISE_NODE/bin:$PATH"
  fi
fi

if [ -f scripts/ci/assert-runtime.mjs ]; then
  node scripts/ci/assert-runtime.mjs
fi
CURRENT_NODE="$(node -v)"
echo "✅ Node 运行时锁定: $CURRENT_NODE"

# ------------------------------------------------------------------------------
# 2. 读取发布配置与凭据参数
# ------------------------------------------------------------------------------
echo "👉 [2/8] 读取生产发布参数..."
# Values come only from config/release-production.json after release-config.mjs validated it fail-closed.
CONFIG="scripts/release/release-config.mjs"
node "$CONFIG" check
config_get() { node "$CONFIG" get "$1"; }

TEAM_ID="$(config_get vercel.teamId)"
PROJECT_ID="$(config_get vercel.projectId)"
DOMAINS="$(config_get vercel.productionDomains)"
EXPECTED_BRANCH="$(config_get productionBranch)"
ACCEPT_PATH="$(config_get acceptance.path)"
REQUIRED_HEADERS="$(config_get acceptance.requiredHeaders)"
MAX_SECONDS="$(config_get acceptance.maxSeconds)"
if [ -z "$TEAM_ID" ] || [ -z "$PROJECT_ID" ] || [ -z "$DOMAINS" ] || [ -z "$EXPECTED_BRANCH" ]; then
  echo "❌ 错误: 发布配置缺少 teamId、projectId、productionDomains 或 productionBranch" >&2
  exit 1
fi
echo "✅ 绑定 Vercel Team: $TEAM_ID, Project: $PROJECT_ID"

# ------------------------------------------------------------------------------
# 3. 发布门禁（联网前拦截）
# ------------------------------------------------------------------------------
echo "👉 [3/8] 校验发布门禁..."
CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"

if [ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]; then
  echo "❌ 拒绝发布: 当前分支为 ${CURRENT_BRANCH:-<detached>}，生产发布只允许从 ${EXPECTED_BRANCH} 分支执行。" >&2
  echo "   请先把要发布的提交并入 ${EXPECTED_BRANCH} 并推送（推送需先通过 npm run ci 留下本地 CI 凭据），" >&2
  echo "   再切到 ${EXPECTED_BRANCH} 执行发布；功能与试验分支的内容不得直接上生产。" >&2
  exit 1
fi

WORKTREE_STATUS="$(git status --porcelain --untracked-files=all)"
if [ -n "$WORKTREE_STATUS" ]; then
  echo "❌ 拒绝发布: 工作区存在未提交或未跟踪改动，发布内容必须是一个已提交的版本。" >&2
  echo "$WORKTREE_STATUS" | sed 's/^/   /' >&2
  echo "   请先提交（或还原）这些改动，再重新发布。" >&2
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
git fetch --quiet origin "+refs/heads/${CURRENT_BRANCH}:refs/remotes/origin/${CURRENT_BRANCH}" || {
  echo "❌ 拒绝发布: 无法 fetch origin/${CURRENT_BRANCH}。" >&2
  exit 1
}
REMOTE_SHA="$(git rev-parse --verify --quiet "refs/remotes/origin/${CURRENT_BRANCH}" || true)"
LIVE_SHA="$(git ls-remote --exit-code origin "refs/heads/${CURRENT_BRANCH}" | awk 'NR == 1 { print $1 }' || true)"
if [ -z "$REMOTE_SHA" ] || [ -z "$LIVE_SHA" ]; then
  echo "❌ 拒绝发布: 无法确认远端 origin/${CURRENT_BRANCH} 引用。" >&2
  exit 1
fi
if [ "$HEAD_SHA" != "$REMOTE_SHA" ] || [ "$HEAD_SHA" != "$LIVE_SHA" ]; then
  echo "❌ 拒绝发布: HEAD (${HEAD_SHA:0:12}) 与远端 ${CURRENT_BRANCH} (tracking=${REMOTE_SHA:0:12}, live=${LIVE_SHA:0:12}) 不一致。" >&2
  echo "   请先同步或推送 ${CURRENT_BRANCH} 到远端再发布，否则线上会出现仓库里没有的版本或回退到旧版本。" >&2
  exit 1
fi

HEAD_SUBJECT="$(git log -1 --pretty=%s "$HEAD_SHA")"
echo "✅ 门禁通过: 分支 ${CURRENT_BRANCH} · 提交 ${HEAD_SHA:0:12} · 工作区干净"
echo "   本次发布内容: ${HEAD_SUBJECT}"
# ------------------------------------------------------------------------------
# 4. 发布准入：在本次提交上复跑 admissionCommands（npm ci / 合约测试 / 静态校验）；npm run ci 经
#    config/local-ci.json 的 include 引用同一份。事实源是 config/release-production.json，不在脚本里另立清单。
#    仓库没有托管 CI，这一步是"发出的是验过的版本"的最终保证。
# ------------------------------------------------------------------------------
echo "👉 [4/8] 运行发布准入命令..."
node scripts/release/run-admission-commands.mjs
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "❌ 拒绝发布: 准入命令改动了工作区。" >&2
  exit 1
fi
VERIFY_MANIFEST="$(node scripts/seo/site-artifact-manifest.mjs)"
if [ -z "$VERIFY_MANIFEST" ]; then
  echo "❌ 站点资产验收清单为空，拒绝部署。" >&2
  exit 1
fi
SHADOW_CURL_BIN="$(command -v curl)"
case "$SHADOW_CURL_BIN" in
  /*) ;;
  *) echo "❌ 无法确定原生 curl 路径，拒绝部署。" >&2; exit 1 ;;
esac
export SHADOW_CURL_BIN

# ------------------------------------------------------------------------------
# 5. 拉取最新的生产环境变量与配置
# ------------------------------------------------------------------------------
echo "👉 [5/8] 同步 Vercel 生产环境变量..."
# Fail closed on conflicting inherited identity or an existing wrong local link.
node scripts/release/vercel-project-binding.mjs
export VERCEL_ORG_ID="$TEAM_ID"
export VERCEL_PROJECT_ID="$PROJECT_ID"
vercel pull --yes --environment=production --scope "$TEAM_ID"
node scripts/release/vercel-project-binding.mjs --check

# ------------------------------------------------------------------------------
# 5. 触发 Vercel 侧远程构建并部署（不切换域名）
#    远程构建（平台构建）是获得 /_vercel/* 平台注入路由的前提：
#    Web Analytics 的 /_vercel/insights/* 只对平台构建的部署提供，
#    本地 `vercel build` + `--prebuilt` 产物不会获得这些路由。
#    必须带 --prod：项目的 Auto-assign Custom Production Domains 处于关闭状态，
#    此时只有「production 类型的部署」被 promote 时才会真正切换生产目标；
#    若发布 preview 部署，promote 只会另建一个不带域名的新 production 部署，
#    线上内容原地不动（脚本第 8 步的逐字节比对会因此判失败）。
#    --skip-domain 保证本步不动域名，切换统一交给第 7 步的 promote。
# ------------------------------------------------------------------------------
echo "👉 [6/8] 触发 Vercel 远程构建部署（production 类型，暂不切换域名）..."
node scripts/release/vercel-project-binding.mjs --check
DEPLOY_OUTPUT=$(vercel deploy --meta "releaseCommitSha=${HEAD_SHA}" --prod --skip-domain --yes --scope "$TEAM_ID")
DEPLOY_URL=$(echo "$DEPLOY_OUTPUT" | grep -Eo 'https://[a-zA-Z0-9.-]+\.vercel\.app' | head -n 1 || true)

if [ -z "$DEPLOY_URL" ]; then
  echo "❌ 部署未能捕获 Deployment URL，原始输出:" >&2
  echo "$DEPLOY_OUTPUT" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 6.1 切域名之前先比对部署内容：不一致就直接中止，生产域名保持不动
#     通过 Vercel 受保护访问读取候选；任何读取或内容差异均在 Promote 前中止。
# ------------------------------------------------------------------------------
. "$ROOT_DIR/scripts/release/site-content-functions.sh"

echo "👉 部署预检: 比对 ${DEPLOY_URL} 与本次提交..."
if ! verify_against_commit "$DEPLOY_URL" "部署预检" "deployment"; then
  echo "❌ 部署预检未通过，已中止发布，生产域名未做任何切换。" >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# 6. 提升（Promote）到正式域名
# ------------------------------------------------------------------------------
echo "👉 [7/8] 部署完成: ${DEPLOY_URL}，正在提升（Promote）到生产正式域名..."
# A successful CLI response is not sufficient: verify the deployed resource identity.
node scripts/release/vercel-project-binding.mjs --check
vercel api "/v13/deployments/${DEPLOY_URL#https://}" --scope "$TEAM_ID" --raw | node scripts/release/vercel-project-binding.mjs --deployment "$HEAD_SHA"
vercel promote "$DEPLOY_URL" --yes --scope "$TEAM_ID"
echo "✅ Promote 成功！"

# ------------------------------------------------------------------------------
# 7. 自动化端点验收 + 线上内容与本次提交逐字节比对
# ------------------------------------------------------------------------------
echo "👉 [8/8] 自动化生产端点验收..."
# verify_required_headers <domain>：acceptance.path 必须直接返回 200 且带齐 acceptance.requiredHeaders。
verify_required_headers() {
  local url="https://$1${ACCEPT_PATH}" headers code name
  headers="$(mktemp)"
  if ! code="$(fetch_code curl --disable --request GET --no-location --max-redirs 0 --silent --show-error --max-time "$MAX_SECONDS" -D "$headers" -o /dev/null -w "%{http_code}" "$url")" || [ "$code" != "200" ]; then
    rm -f "$headers"
    echo "❌ 响应头验收: ${url} 返回 HTTP ${code:-000}" >&2
    return 1
  fi
  # Normalise CRLF once, in place: piping into `grep -q` lets the reader exit early and `set -o pipefail` then
  # reports a present header as missing.
  tr -d '\r' < "$headers" > "$headers.lf" && mv "$headers.lf" "$headers"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if ! grep -iq "^${name}:" "$headers"; then
      rm -f "$headers"
      echo "❌ 响应头验收: ${url} 缺少响应头 ${name}" >&2
      return 1
    fi
  done <<< "$REQUIRED_HEADERS"
  rm -f "$headers"
  echo "✅ 响应头验收: ${url} [$(printf '%s' "$REQUIRED_HEADERS" | tr '\n' ' ')]"
}
for DOMAIN in $DOMAINS; do
  if ! verify_against_commit "https://${DOMAIN}" "线上比对 ${DOMAIN}"; then
    echo "❌ 线上内容与已复核提交不符（${DOMAIN}），请立即排查（可能被其他部署覆盖）。" >&2
    exit 1
  fi
  if ! verify_required_headers "$DOMAIN"; then
    echo "❌ 生产响应头验收失败（${DOMAIN}），请立即排查。" >&2
    exit 1
  fi
done

echo "========================================================"
echo "🎉 ${PROJECT_NAME} 生产发布全流程闭环成功！线上已完全生效！"
echo "   线上版本 = 提交 ${HEAD_SHA}（${CURRENT_BRANCH}，工作区干净）"
echo "========================================================"

# ------------------------------------------------------------------------------
# 8. 矩阵联动自动广播 (Auto-sync Matrix Facts to Portal & Obsidian)
# ------------------------------------------------------------------------------
# 原来引用了未定义的 $REPO_ROOT：macOS bash 3.2 带 EXIT trap 时退出码仍为 0，广播从未执行；
# bash 5 下成功的发布会以 1 退出。从 .worktrees/<name> 发布时 ROOT_DIR 是 worktree，
# 按 git common dir 回到主仓库再找同级 shadow-portal。发布已经完成，本步任何失败都只告警。
COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
PORTAL_DIR="$(dirname "${COMMON_DIR:-$ROOT_DIR/.git}")/../shadow-portal"
if [ -f "$PORTAL_DIR/scripts/matrix/check-or-sync-matrix.mjs" ]; then
  echo ""
  echo "📡 [矩阵事实广播] 正在自动同步最新发布版本到 Shadow Portal 与 Obsidian 知识库..."
  (cd "$PORTAL_DIR" && node scripts/matrix/check-or-sync-matrix.mjs --sync) ||
    echo "⚠️ [矩阵事实广播] 同步失败，不影响本次已完成的生产部署，请在 Portal 手动运行 npm run matrix:sync" >&2
else
  echo "⚠️ [矩阵事实广播] 未找到 ${PORTAL_DIR}/scripts/matrix/check-or-sync-matrix.mjs，已跳过（不影响本次生产部署）" >&2
fi
