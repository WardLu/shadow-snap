# Shadow Snap 项目约定

## 项目边界

- Shadow Snap（影瞬）是电影感台词长图生成器，运行在纯前端 Canvas 上，无后端服务，零上传依赖。
- 代码为纯原生前端（`index.html`、`style.css`、`script.js`），构建与部署配置以 `package.json` 与 `vercel.json` 为准。
- 部署域名为 `snap.shadow.wang` 与 `sie.shadow.wang`。

## 架构与性能约束

- **纯前端本地处理**：所有图片拼接与字体渲染均在浏览器 Canvas 完成，严禁引入服务端上传或第三方图床依赖。
- **静态资源安全**：遵守 `vercel.json` 中配置的 Content-Security-Policy、X-Frame-Options、X-Content-Type-Options 标头限制。

## 版本与发布规范

- **生产发布刚性执行机制**：
  - **Vercel 自动部署已完全关闭**：`vercel.json` 显式配置了 `"git": { "deploymentEnabled": false }`，且生产域名不自动分配。严禁在合并 PR 到 `main` 或 `production` 后盲目等待 Webhook 自动部署或空转轮询 404。
  - **唯一合法发布入口**：工作区或本地执行生产发布，**唯一且强制**执行 `bash scripts/release/deploy-production.sh`（或 `npm run release:production`）。
  - **自愈式环境与原子闭环**：该脚本内置自愈逻辑：自动检查并挂载 `mise` Node 22 运行时、自动解析 `config/release-production.json` 绑定 Team Scope、顺序执行 `pull` -> `build` -> `deploy --prebuilt` -> `promote` -> 双域名（`snap.shadow.wang` / `sie.shadow.wang`）生产验收。严禁脱离该脚本在默认 Shell 下手工散装拼凑执行 Vercel CLI 命令。

## 权威入口

- 产品主页与源码：`index.html`、`script.js`
- 静态验证：`scripts/validate-static-site.mjs`
- 生产一键发布入口：`scripts/release/deploy-production.sh`
- 部署配置：`config/release-production.json`
