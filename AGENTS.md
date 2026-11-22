# Shadow Snap 项目约定

## 项目边界

- Shadow Snap（影瞬）是电影感台词长图生成器，运行在纯前端 Canvas 上，无后端服务，零上传依赖。
- 代码为纯原生前端（`index.html`、`style.css`、`script.js`），构建与部署配置以 `package.json` 与 `vercel.json` 为准。
- 部署域名为 `snap.shadow.wang` 与 `sie.shadow.wang`。
- **公开仓库**：本仓库以 MIT 许可公开（以单一根提交重新开源，此前的历史与 PR #1–#78 保存在私有存档仓库）。不得提交个人联系方式、收款码、本机路径、部署 ID、发布回执或任何凭据；提交身份使用 GitHub noreply 邮箱。

## 架构与性能约束

- **纯前端本地处理**：所有图片拼接与字体渲染均在浏览器 Canvas 完成，严禁引入服务端上传或第三方图床依赖。
- **移动端保存路径**：导出必须保持纯客户端。微信内置浏览器不认 `blob:` 图片（长按会报「保存图片到手机失败」）且拦截程序化下载，所以微信下预览改用内联 `data:` 图片并提示长按保存；夸克 / UC 的 `canShare({ files })` 返回 true，但 `share()` 不弹面板也不结束，因此按 UA 跳过系统分享，与其他不支持分享的内核一样走「长按保存浮层」。浮层预览用 `blob:` 图片，CSP 的 `img-src` 必须保留 `blob:`。**不得**为了"微信内一键保存"引入服务端中转、图床或微信 JS-SDK 签名服务。
- **本地预览只暴露站点文件**：站点以 `outputDirectory: "."` 发布，仓库根含 `.env.local`、`config/`、`scripts/` 等内部内容。任何对外可达的本地服务（手机联调、验收预览）必须只服务站点文件白名单目录（`index.html`、`style.css`、`script.js`、`robots.txt`、`sitemap.xml`、`public/`），严禁直接 serve 仓库根或把仓库根绑定到 `0.0.0.0`。
- **静态资源安全**：遵守 `vercel.json` 中配置的 Content-Security-Policy、X-Frame-Options、X-Content-Type-Options 标头限制。

## 版本与发布规范

- **项目状态**：线上保持可用，按明确授权的需求迭代（以 SEO、性能和兼容性修复为主）；每次发布都按下述门禁执行，不能把旧发布口径当作新版本验收证据。
- **生产发布刚性执行机制**：
  - **Vercel 自动部署已完全关闭**：`vercel.json` 显式配置了 `"git": { "deploymentEnabled": false }`，且生产域名不自动分配。严禁在合并 PR 到 `main` 或 `production` 后盲目等待 Webhook 自动部署或空转轮询 404。
  - **唯一合法发布入口**：工作区或本地执行生产发布，**唯一且强制**执行 `bash scripts/release/deploy-production.sh`（或 `npm run release:production`）。
  - **自愈式环境与原子闭环**：该脚本内置自愈逻辑：自动检查并挂载 `mise` Node 22 运行时、自动解析 `config/release-production.json` 绑定 Team Scope、**联网前先本地复跑 `admissionCommands`**（`npm ci --ignore-scripts` / release 门禁测试 / `validate-static-site.mjs`，与 `npm run ci` 同一份清单）、再顺序执行 `pull` -> `deploy`（Vercel 侧远程构建，`--prod --skip-domain`）-> `promote` -> 双域名（`snap.shadow.wang` / `sie.shadow.wang`）生产验收。发布必须走远程构建：平台的 `/_vercel/*` 注入路由（如 Web Analytics）只对平台构建的部署提供，本地 `--prebuilt` 产物拿不到；因此不得改回本地 prebuilt 流程。严禁脱离该脚本在默认 Shell 下手工散装拼凑执行 Vercel CLI 命令。
  - **发布门禁（硬性，无绕过开关）**：脚本在联网前强制校验三项——工作区必须干净（含未跟踪文件在内的任何未提交改动都会被拦截并逐条列出）、当前分支必须就是配置声明的发布分支 `production`（`config/release-production.json` 的 `productionBranch`）、`HEAD` 必须与 `origin/production` 严格一致。任一条不满足即拒绝发布并退出。
    - **生产只从 `production` 发布**：`main` 与其他任何分支都不得直接发布（v1.2.0 从 main 头部发布的做法已作废）。要上线就必须先把改动并入 `production` 并推送，再切到 `production` 执行发布；推送到 `production` 受 devkit 标准 `.githooks/pre-push` 保护：该提交必须先在干净工作区经 `npm run ci` 留下通过的 v2 本地 CI 记录（`<git-common-dir>/local-ci/<sha>.json`，由 `node scripts/ci/local-ci.mjs verify <sha>` 校验，标准见 shadow-devkit `docs/standards/ci-local-gate.md`），tag 必须是 `vX.Y.Z`。启用方式 `git config core.hooksPath .githooks`。
    - 发布上传的是「当前工作区快照」，故绕过门禁等于把未复核内容直接推上线。**不得**用 `git stash`、临时提交、另起分支、直接调用 Vercel CLI 等方式规避。
    - 此门禁专为「Agent 误发试验内容」而设：Agent 只允许在 `production` 上、且与远端完全同步时执行发布；任何一条不满足就停下并向用户说明，不要试图变通。
    - 2026-10-18 起已移除本地 Release Controller（`release:admit` 等子命令、能力令牌、授权摘要、`config/controller-files.sha256`、`release.yml` workflow）。不要恢复这些机制；发布规范以 `shadow-devkit` 为准，用 `devkit check` / `devkit probe` 验证。
  - **发布后逐字节校验**：验收清单由 `scripts/seo/site-artifact-manifest.mjs` 消费静态页面/资产事实源派生，覆盖各语言页 HTML、CSS、JS、导入模块、sitemap、robots、引用的本地品牌资源，以及本地样式表 `url()` 引用的字体（`public/fonts/fonts.css` 与其中的 WOFF2）。`deploy` 之后、`promote` 之前必须通过 HTTP 200、无重定向、MIME 及提交字节比对（失败则中止且保持生产域名不动）；`promote` 后两个生产域名重复同一清单。任何不一致均判失败，不以 HTTP 200 代替提交身份。

## 权威入口

- 产品主页与源码：`index.html`、`script.js`
- 静态验证：`scripts/validate-static-site.mjs`
- 生产一键发布入口：`scripts/release/deploy-production.sh`
- 部署配置：`config/release-production.json`
- 发布流程与历史：`docs/release-process.md`
