# Shadow Snap Release Process

## 当前发布流程（2026-10-18 起）

Shadow Snap 按 `shadow-devkit/templates/` 的矩阵标准发布：本地 CI 把关推送，唯一脚本把关部署。Vercel Git 自动部署对所有分支关闭（`vercel.json` 的 `git.deploymentEnabled=false`），Git push 不会创建任何部署。

```bash
# 1. 本地等价 CI（矩阵标准 v2）：在干净工作区按 config/local-ci.json 运行检查（包含全部 admissionCommands，另加全历史 gitleaks 扫描与 SEO、门禁测试），
#    通过后写入 <git-common-dir>/local-ci/<HEAD>.json；npm run ci:check 只运行检查、不写凭据
npm run ci

# 2. 推送 production（.githooks/pre-push 要求该提交已有通过的本地 CI 记录；tag 必须是 vX.Y.Z）
git push origin production

# 3. 在 production 上发布
npm run release:production   # = bash scripts/release/deploy-production.sh
```

启用钩子：`git config core.hooksPath .githooks`（`pre-commit` 拦截凭据文件，`pre-push` 校验本地 CI 记录与 tag 格式）。

本地等价门禁遵循矩阵标准（shadow-devkit `docs/standards/ci-local-gate.md`）：`scripts/ci/local-ci.mjs` 与 `.githooks/pre-push` 原样取自 devkit 模板。凭据为 v2，绑定提交、tree、检查清单哈希和每项检查结果；运行前后工作区都必须干净，检查只继承白名单环境变量。清单只来自已提交的 `config/local-ci.json`，用 `include: ["admissionCommands"]` 引用 `config/release-production.json`，不另抄一份；`tests/ci/local-ci-config.test.mjs` 防止清单漏掉准入命令或测试套件。`pre-push` 调用 `node scripts/ci/local-ci.mjs verify <sha>` 校验，不再自行解析记录；旧 v1 记录（`record-local-ci.mjs` 写入）不再被接受，需要重新运行 `npm run ci`。清单另含全历史 gitleaks 扫描（`secrets-scan`，默认规则，需先 `brew install gitleaks`）；目前历史没有命中，所以没有 `.gitleaks.toml` 和 `.gitleaksignore`。以后确需放行时，按矩阵标准第 2 节同时限定路径和完整值，并复制 devkit 的 `templates/ci/gitleaks-allowlist.test.mjs` 核对边界。

`deploy-production.sh` 的 8 步，任一步失败即退出 1，无绕过开关：

1. 挂载 `mise` 的 Node 22；如果存在 `scripts/ci/assert-runtime.mjs` 就执行它（当前仓库没有这个文件）。
2. `release-config.mjs check` 校验 `config/release-production.json`（fail-closed）；脚本只通过 `release-config.mjs get <key>` 读取参数。
3. 发布门禁：工作区干净（含未跟踪文件）、当前分支是 `productionBranch`（`production`）、`HEAD` 等于 fetch 后的 `origin/production` 且等于 `git ls-remote` 读到的远端值。
4. 准入：`run-admission-commands.mjs` 以环境变量白名单和临时 `HOME` 复跑 `admissionCommands`（`npm ci --ignore-scripts`、release 门禁测试、`validate-static-site.mjs`），跑完工作区必须仍然干净。
5. `vercel-project-binding.mjs` 核对 Team/Project 身份后 `vercel pull`。
6. `vercel deploy --prod --skip-domain` 触发 Vercel 侧远程构建，然后用 `vercel curl --deployment` 对候选部署做逐字节预检；不一致即中止，生产域名不动。
7. 回读部署身份（项目、团队、`READY`、`production`、`releaseCommitSha`）后 `vercel promote`。
8. 两个生产域名（`snap.shadow.wang`、`sie.shadow.wang`）重复逐字节比对，并验收 `acceptance.path` 返回 200 且带齐 `acceptance.requiredHeaders`。成功输出 `线上版本 = 提交 <SHA>`。

发布成功后，如果主仓库的同级目录里有 `shadow-portal/scripts/matrix/check-or-sync-matrix.mjs`，脚本会运行它的 `--sync`，改写 Portal 的本地文件；这一步失败只告警，不影响已经完成的发布。

约束：

- **必须远程构建**：只有平台构建的部署才有 `/_vercel/*` 注入路由（Web Analytics 依赖它），不得改回 `vercel build` + `--prebuilt`。
- **必须 `--prod` 部署**：项目关闭了 Auto-assign Custom Production Domains，对 preview 部署 promote 只会新建一个没有域名的 production 部署，线上原地不动（2026-09-18 事故，见历史记录）。
- **验收清单由事实源派生**：`scripts/seo/site-artifact-manifest.mjs` 从静态校验与多语言页面生成器派生清单（各语言页 HTML、JS/CSS、导入模块、sitemap、robots、引用的本地品牌资源，以及本地样式表 `url()` 引用的字体），比对 HTTP 200、无重定向、MIME 与提交字节，不另维护白名单。
- **网络读取只重试瞬时失败**：第 6、8 步的逐字节比对和域名验收都经过 `fetch_code`（`scripts/release/site-content-functions.sh`）。没有 HTTP 响应（`000`，如 TLS 握手断开）或 HTTP 408/429/500/502/503/504 时最多尝试 3 次，间隔 1 秒；其他状态（如 404）和重试用完后的失败立即中止。
- **只读复核**：`bash scripts/release/verify-site-content.sh <URL> <SHA> [public|deployment]` 对候选部署或生产域名重复同一比对，不部署、不改别名。
- **回滚**：在 Vercel 找到上一个生产部署，执行 `vercel promote <上一个部署 URL> --scope <teamId>`；或在 `production` 上提交 `git revert`、跑 `npm run ci` 并推送后重新运行发布脚本（不得强推改写 `production`）。

### 限制

仓库公开。GitHub ruleset 禁止删除和强推 `main`、`production`，`main` 必须经 PR 合并，并且必须通过托管 CI；只有管理员能新建分支和 tag。但 GitHub 服务端不校验本地 CI 记录，有写权限的人仍可以快进更新 `production`。

托管 CI（`.github/workflows/ci.yml` 的 `gate` 任务）在目标为 `main` 的 PR，以及 `main`、`production` 的推送上运行 `npm run ci:check`，与本地 `npm run ci` 是同一份清单，gitleaks 锁定为 8.30.1。它只是额外的一道检查，不替代本地门禁：
- `production` 不设必需检查。workflow 只在 `production` 更新**之后**才运行，没法在推送前给出结果；推送 `production` 仍然要有本地 CI 记录，发布脚本也照常复跑准入命令。
- 外部 PR 的检查结果可信度有限：PR 可以同时改掉检查本身，所以“检查通过”只说明这个 PR 自己定义的检查通过了。批准外部贡献者的 workflow 运行之前，以及合并之前，先读该 head SHA 的完整 diff。下面这些路径决定了检查实际执行什么，有改动就逐行审过：`.github/workflows/`、`package.json`、`package-lock.json`、`.nvmrc`、`scripts/`、`config/`、`tests/`、`.githooks/`、`.gitleaks.toml`、`.gitleaksignore`，以及检查会执行或导入的任何代码（如 `seo-content.mjs`、`translations.mjs`）。合并时锁定已审过的 head SHA。
- workflow 只用 `pull_request` 触发（不用 `pull_request_target`），令牌只读，仓库不配置任何 secret，第三方 action 钉到完整的提交 SHA。`pre-push` 只是本地钩子，`--no-verify`、其他主机和 GitHub UI 可绕过它；不可绕过的是部署侧：发布脚本只部署已推送到 `production` 的干净提交，并在部署前复跑准入命令。Tag、Release、合并 PR、推进 `production` 与部署仍各自需要明确授权。

### Vercel 项目身份校验

发布入口以 `config/release-production.json` 为项目与团队身份的唯一事实源。缺少本地 `.vercel/project.json` 时按配置创建；已有链接或 `VERCEL_PROJECT_ID` / `VERCEL_ORG_ID` 与配置冲突时立即中止，不覆盖错误链接、不创建替代项目。先核对冲突来源和正式项目 ID，再修复本地环境。

`pull` 后及上传前再次核对链接，Promote 前回读部署所属项目、团队和 Ready/Production 状态。校验失败不得手工 Promote 或直接调用部署 CLI 绕过；本地测试使用合成数据和 CLI mock，不触发实际部署。

## 历史记录

仓库以单一根提交重新开源。此前的发布回执（部署 ID、逐项验收明细）和 PR #1–#78 保存在私有存档仓库；下面只保留仍然影响当前流程的结论。

- **2026-10-18**：移除本地 Release Controller（`release:*` 子命令、一次性能力令牌、`config/controller-files.sha256`、`release.yml` workflow），改用 devkit 标准流程：本地 CI 把关推送，唯一脚本把关部署。
- **2026-09-18**：
  - 生产只从 `production` 发布，不再从 `main` 头部发布；脚本在联网前强制执行三项门禁，并复跑 `admissionCommands`。
  - promote 静默失败：此前先发 preview 部署再 promote，域名没有切换，脚本却报告成功，被逐字节比对拦下。第 6 步因此改为 `vercel deploy --prod --skip-domain`。
  - Web Analytics：生产发布改为 Vercel 侧远程构建；`--prebuilt` 部署拿不到平台注入的 `/_vercel/*` 路由。insights 脚本标签需要带 `data-sdkn`/`data-sdkv`。
- **发布面收敛（v1.1.9）**：`.vercelignore` 排除 `scripts/`、`tests/`、`config/`、`docs/`、`.github/`、`AGENTS.md` 等内部内容，线上对应路径返回 404。运维须知：`vercel.json` 一旦手写 `routes`，`headers` 自动注入会停用（安全响应头全部消失），需要路由阻断时必须把响应头一并写入 `routes`；`rewrites` 与 `headers` 可以安全共存。
