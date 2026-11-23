# 影瞬 Shadow Snap 发布说明

[English](RELEASE_NOTES.md) · **简体中文**

这里记录影瞬（Shadow Snap）每个已发布版本的发布说明。影瞬是一个把电影剧照和几行台词拼成电影感字幕长图的工具。

---

## v1.5.4 - 2026-11-23

### 变更

- 中文页不再下载约 119 个 Noto Sans SC 分片，改为单个 161,876 B 的 CJK 子集（`public/fonts-subset/noto-sans-sc-cjk.woff2`），并让 `--font-ui` 优先使用系统中文字体。移除了页面没有用到的 Archivo Black 包。本地 `/zh-hant/` 实测：总传输 406,926 B / 19 个请求，其中字体 72,246 B（旧线上同页：2,979,497 B / 70 个请求，其中 54 个字体请求共 2,820,852 B）。
- 每个页面的 WebApplication JSON-LD 合并为一份。新增 IndexNow 密钥文件，`robots.txt` 新增 Yandex 规则（用 `Clean-param` 忽略 UTM 参数）。
- 中文分享图（`og_shadow_snap.png`）不再显示版本号，与英文图一致。
- 源码重新公开在 [github.com/WardLu/shadow-snap](https://github.com/WardLu/shadow-snap)。GitHub Actions 上的托管 CI 运行与本地门禁相同的检查。

### 移除

- 站点不再提供百度、搜狗、360 和 StartupRanking 的验证文件，以及两个没有用到的品牌 logo（`shadow_card_logo.svg`、`shadow_portal_logo.svg`）。

### 修复

- 生产验收不再把已存在的响应头误报为缺失。原来的响应头检查把输出通过管道交给 `grep -q`，开启 `pipefail` 时，`grep` 提前退出会让检查失败。

### 说明

- 上面的字体、结构化数据和发布脚本改动，在这个版本之前已经上线，只是没有升版本号。v1.5.4 把它们记录下来。

## v1.5.3 - 2026-11-07

### 变更

- 页面此前从 Google Fonts 请求的七个字体族（Archivo Black、IBM Plex Mono、Noto Sans SC、Roboto、Noto Sans Thai、Noto Sans Arabic，以及“Noto Sans Vietnamese”选项）改为由站点自己在 `/public/fonts/` 下提供。页面不再请求 `fonts.googleapis.com` 和 `fonts.gstatic.com`，`vercel.json` 里 Content-Security-Policy 的 `style-src` 和 `font-src` 只允许 `'self'`。
- 之前的 Google Fonts 请求写的是 `Noto Sans Vietnamese`，但 Google Fonts 没有这个字体族。这个选项的值保持不变，现在改由覆盖越南文的 Noto Sans 提供。
- 字体版本固定在 `config/fonts.json`。`public/fonts/fonts.lock.json` 记录每个 Fontsource 包的 npm integrity 和每个文件的 SHA-256，每个字体目录都保留 SIL Open Font License 1.1。`scripts/fonts/vendor-fontsource.mjs`（来自 shadow-devkit）负责重新生成这些文件。
- `.vercelignore` 现在只排除仓库根目录的 `LICENSE`。之前的 `LICENSE` 规则会匹配任意层级的文件，导致字体许可证文件不会随站点部署。

### 修复

- 字体按 `unicode-range` 拆分。画布现在只加载当前字幕文字需要的分片，分片到达后重绘一次。导出最多等待 2 秒，然后按当前画布导出，所以字体下载慢也不会让导出卡住。

### 新增

- `validate:static` 会跟踪页面引用的本地样式表里的 `url()`，并拒绝远程地址，因此 `fonts.css` 和每个 WOFF2 文件都进入了发布逐字节校验清单。
- `tests/release/contracts/fonts.test.mjs`（属于发布准入命令）在以下情况失败：页面请求 Google Fonts、CSP 允许远程字体域名、字体文件或生成的 CSS 与锁文件不一致，或 `.vercelignore` 排除了字体目录里的任何文件。

## v1.5.2 - 2026-11-04

### 变更

- 每个首页的“Featured on”栏新增三个目录徽章：Twelve Tools、Fazier 和新趣集（Xinquji）。这几个网站的免费收录都要求我们的网站长期保留链接，并且都达到徽章门槛（第三方 Domain Rating 不低于 50，月访问量至少 5K；AITDK 2026 年 9 月数据：Twelve Tools DR 84 / 60.5K，Fazier DR 84 / 76.06K，新趣集 DR 64 / 85.92K）。新趣集徽章在简体和繁体中文页显示“新趣集”，其他语言页显示“Xinquji.com”。
- `vercel.json` 的 `img-src` Content-Security-Policy 放行这三个徽章域名。

## v1.5.1 - 2026-11-04

### 变更

- 每个首页的“Featured on”栏移除八个目录徽章：Findly.tools、Turbo0、Maidensail、Starter Best、DanielLaunches、LaunchZone、ShinyLaunch 和 LaunchBuck。徽章门槛是第三方 Domain Rating 不低于 50，且月访问量至少 5K。AITDK 2026 年 9 月数据显示其中五个的月访问量在 883 到 3.07K 之间；LaunchZone、Starter Best 和 ShinyLaunch 没有流量数据，无法确认是否达标。
- Nick Launches（月访问量 15.87K）的收录还在审核，暂时保留。`vercel.json` 的 `img-src` Content-Security-Policy 现在只放行它的徽章域名。

## v1.5.0 - 2026-11-02

### 新增

- 根页面 `/` 在首次访问时跟随浏览器语言。匹配按顺序检查 `navigator.languages`：繁体中文（`zh-Hant`、`zh-TW`、`zh-HK`、`zh-MO`）跳到 `/zh-hant/`，其他中文留在 `/`，其他语言在站点支持时跳到对应语言的首页。没有匹配的语言使用英文（`/en/`）。跳转用 `location.replace`，保留查询参数和 hash，不增加浏览器历史记录。
- 从站内访问 `/`（同源 referrer，例如 404 页的语言链接）不会跳转，所以用户在站内选的语言在这次浏览中一直有效。直接访问、外部链接和书签按浏览器语言跳转。

### 说明

- 不存储任何内容：脚本不读写 `localStorage`、`sessionStorage` 或 cookie。站内选的语言靠当前历史记录条目 `history.state` 里的一个标记在刷新后保留，这不属于存储。爬虫的 user agent 不会被跳转。`/` 的 HTML 对每个请求都一样，canonical、hreflang 和 sitemap 条目保持不变。

## v1.4.1 - 2026-11-01

### 修复

- 对于没有语言前缀的不存在路径（例如 `/missing`），本地化 404 页现在显示中文，因为中文位于不带前缀的根路径。带已知前缀的路径仍使用对应语言（`/ja/missing` 显示日文）。静态 `404.html` 为没有 JavaScript 的读者保持英文。

## v1.4.0 - 2026-11-01

### 新增

- 十二种站点语言：简体中文在 `/`，English 在 `/en/`，繁體中文在 `/zh-hant/`，日本語、한국어、Español、Português、Français、Deutsch、Русский、Bahasa Indonesia 和 العربية 在 `/<locale>/`。每个页面设置自己的 `lang` 和 `dir`（阿拉伯语从右到左），带完整的 hreflang 集合且 `x-default` 指向英文，在 `og:locale:alternate` 里列出其他语言，并出现在包含全部十二个 URL 的 sitemap 中。
- 为无法匹配的路径提供本地化静态 404 页，返回状态 404 并带 `noindex`。它列出所有语言，并链接到产品页。语言由外部模块按路径前缀确定，所以 CSP 保持 `script-src 'self'`。

### 变更

- 语言切换器、指南里的语言链接和 FAQ 都由同一个语言源生成，与 Shadow Portal 的语言列表一致。FAQ 现在说明界面支持 12 种语言。
- 电影台词标签对所有语言只定义一次。

## v1.3.5 - 2026-10-18

### 修复

- 在夸克和 UC 里，长按保存浮层里的预览图不能保存图片。这些内核长按时会按地址重新下载图片，而它们读不了 `blob:` URL。预览图现在像微信里一样使用 data URL，下载按钮仍使用 blob。浮层提示现在先提下载按钮。

## v1.3.4 - 2026-10-18

### 修复

- 夸克和 UC 通过 `canShare({ files })` 报告支持文件分享，但 `share()` 既不弹出面板也不结束，导致导出在“正在导出”提示后卡住。这些内核现在跳过系统分享面板，直接打开长按保存浮层。
- CSP `img-src` 增加 `blob:`。保存浮层通过 object URL 预览 PNG，之前的策略拦截了它，图片显示破损，也无法长按。

## v1.3.3 - 2026-10-17

### 修复

- 生产发布入口在部署前用 `git ls-remote` 重新核对远端，拒绝过期或未推送的 `production` HEAD。
- 准入命令在环境变量白名单和临时 `HOME` 下运行，测试和安装读不到调用者的凭据。

### 变更

- 新增拒绝暂存凭据文件的 pre-commit 钩子、PR 模板和 `.nvmrc`。除 `softwareVersion` 外，页面内容不变。

## v1.3.2 - 2026-10-05

### 新增

- 完整的中文 `/` 与英文 `/en/` 静态页面，各自带指向自身的 canonical、互相指向的 hreflang，以及包含两种语言的 sitemap。
- 面向用户的产品指南和 FAQ，与 JSON-LD 共用同一套本地化事实；语言链接会保留图片、台词和水印状态。
- 只监听回环地址、按白名单提供文件且关闭统计的本地预览；另加生成内容漂移和 FAQ 缺失的门禁。

### 修复

- 候选部署和双域名资源检查改为从经过校验的站点资源图派生，覆盖本地化 HTML、导入模块、sitemap、robots 和品牌资源。
- promote 前拒绝缺失资源、重定向、错误的 MIME 类型和字节不一致；报告完整的生产提交 SHA。
- 通过静态生成让 softwareVersion 与 package.json 保持同步。生产部署仍然受控，并需要单独授权。

## v1.3.1 - 2026-09-21

### 修复

- 部署命令绑定到配置的 Vercel 项目和团队，拒绝冲突的本地链接或继承的环境变量。
- 生产 promote 前再次核对部署身份，防止从临时工作目录误建项目。
- 切换生产域名前，必须经过已认证的 Vercel 访问，对候选部署做逐字节校验。

## v1.3.0 - 2026-09-18

> **类型**：移动端可用性、导出链路修复与发布纪律收紧

### 核心变更

- **移动端适配**：改为文档流滚动＋画布预览吸顶，调整字体/切片时实时预览常驻；底部操作坞不再被挤压成竖排文字；页脚折行完整显示；触控控件放大（滑块拇指、开关、按钮）；输入框提到 16px 规避 iOS 聚焦放大；编辑台词时预览收起，为软键盘让位。
- **导出链路修复**：改用 Blob 编码与系统分享面板（移动端「存储图像」落盘）；不支持分享文件的内核（夸克、UC）与微信内置浏览器改用长按保存浮层，微信下预览改内联图片以支持长按存图；新增画布面积上限保护（触屏 12M 像素，超出等比缩小并提示实际导出尺寸）与 4 秒编码超时兜底。
- **界面一致性**：修复 i18n 覆盖导致导出/清空按钮图标消失的缺陷；补齐英文界面残留中文（含 title / aria-label / alt）。
- **安全加固**：`.vercelignore` 改为通配（`.env*`、`.release-state`、`.DS_Store`），上传增加 30MB 体积上限，清理两个冗余公开文件。
- **发布纪律**：`deploy-production.sh` 新增硬门禁（工作区干净 / 只允许 `production` 分支 / `HEAD` 与 `origin/production` 一致，无绕过开关）；`promote` 前后逐字节比对线上内容与本次提交；门禁脚本纳入 `config/controller-files.sha256` 完整性校验；控制器的 Stage 同步改为平台侧远程构建（原先的 `--prebuilt` 会让经控制器发布的部署丢失 `/_vercel/*` 分析路由），合约测试新增“不得出现 `--prebuilt`”断言防回退。发布当天还修复了 promote 未切换域名的静默失败：`Auto-assign Custom Production Domains` 关闭时，对 preview 部署 promote 只会另建一个不带域名的新 production 部署，线上内容原地不动（是逐字节比对把它拦下的），第 5 步因此改为 `vercel deploy --prod --skip-domain`。

## v1.2.0 - 2026-09-17

> **类型**：访问分析接入（Vercel Web Analytics）

### 核心变更

- **Web Analytics 接入**：采用 Vercel 官方推荐的自托管路由 `/_vercel/insights/script.js`，脚本与上报（`/_vercel/insights/view`）全部同源，**不引入任何第三方脚本域、无需放宽 CSP**（script-src / connect-src 保持 `'self'`）。
- **静态门禁同步**：校验器放行平台路由 `_vercel/*` 并新增 analytics 标签锁定；SEO 回归测试与仓库配置测试同步更新。
- **说明（2026-09-18 更新）**：生产发布已切换为 Vercel 侧**远程构建**（`--prebuilt` 流程不会获得平台注入路由），平台原生 `/_vercel/insights/*` 已验证可用；数据计数以后台面板为准（聚合有延迟，且自动化流量可能被过滤）。

## v1.1.9 - 2026-09-17

> **类型**：字幕描边伪影修复与站点发布面收敛

### 核心变更

- **字幕描边伪影修复**：描边改用环绕偏移填充实现，消除 `strokeText` 在中文字形尖锐收笔处甩出的细刺伪影（画布预览与导出长图同步生效）。
- **发布面收敛**：新增 `.vercelignore` 与 404 路由，仓库内部文件（发布脚本、测试、配置、文档、收款码素材）不再随站点对外公开。
- **安全响应头补强**：新增 `Content-Security-Policy`（放行 Google Fonts 与本地图片管线），并由静态校验器与回归测试锁定。

## v1.1.8 - 2026-09-17

> **类型**：工作台重构、无障碍与取景框体验治理、AITDK 零缺陷与品牌页脚对齐

### 核心变更

- **工作台布局**：采用 65% 胶片画布舞台 + 35% 检查器分段控制台（台词脚本、字体质感、画幅水印），使用 Obsidian Noir 暗色风格。
- **视觉去模板化**：移除所有 Emoji 符号，引入精细 SVG 图标与电影经典对白灵感（少年派、星际穿越、花样年华、楚门的世界）。
- **取景框体验修复**：重构未载入图片时的独立 16:9 胶片取景框，消除 Dummy Canvas 导致的高度截断与文案遮挡缺陷。
- **WCAG AA/AAA 无障碍升级**：提高全站所有文本、标签、选项卡与数值的对比度（最高达 18:1），杜绝暗灰低对比度文字。
- **AITDK 零缺陷与双 Schema**：通过无障碍 `.sr-only` CSS 将 SEO/GEO 长文与 FAQ 结构化收拢，同时兼容 Release Controller 严格锁定的 WebApplication 合约与全域 `@graph` 伴生数据。
- **品牌矩阵与页脚对齐**：统一接入 Shadow Lab 官方纸白/琥珀双环 Logo 与产品介绍页入口，精简移除多余赞赏与外链，修正邮件反馈主题错别字。

## v1.1.7 - 2026-09-05

- 对齐受保护的 `production` 分支提交历史，保留百度验证文件。
- 保持 v1.1.6 的产品行为，只推进发布元数据。

## v1.1.6 - 2026-09-05

> **类型**：品牌实体关系与安全响应头增强

### 核心变更

- **可见语义**：主标题完整显示“影瞬 Shadow Snap”。
- **实体关系**：WebApplication JSON-LD 通过稳定 `@id` 关联 Shadow Nexus Organization。
- **安全响应头**：增加 `nosniff`、同源嵌入与 referrer policy，并纳入正式静态校验器。

## v1.1.5 - 2026-09-03

> **类型**：SEO/GEO 可发现性基础设施与受控发布对齐

### 核心变更

- **索引基础设施**：补充中文/英文标题、描述、canonical、Open Graph、Twitter 与 WebApplication JSON-LD。
- **爬虫入口**：新增 canonical `robots.txt` 与单 URL `sitemap.xml`。
- **发布验收对齐**：更新 Release Controller 的生产验收标题，并以回归测试锁定 SEO 合约。

## v1.1.4 - 2026-08-30

> **类型**：发布治理与部署元数据加固

### 核心变更

- **元数据校验强化**：完善部署事实与受控 Promote 证据链比对，支持快照式验签。
- **发布状态收敛**：更新 `.release-state/v1.1.4` 生产状态，确保不可变归档。

## v1.1.3 - 2026-08-30

> **类型**：意图门禁基线复核

### 核心变更

- **Pre-intent 证据链验证**：在生成阶段重检前置证据哈希，杜绝未经验证的脏构建进入待发布队列。

## v1.1.2 - 2026-08-30

> **类型**：既有生产基线采纳（Adopt Intent）

### 核心变更

- **支持既有基线纳入**：使受控发布流对接历史已在生产环境稳定运行的静态 HTML/Canvas 部署。

## v1.1.1 - 2026-08-30

> **类型**：规范化 Manifest 摘要

### 核心变更

- **文件指纹标准化**：规范化发布产物清单（Manifest）SHA256 计算逻辑，统一跨环境签名。

## v1.1.0 - 2026-08-30

> **类型**：生产受控发布工作流与安全门禁

### 核心变更

- **接入 Release Controller**：引入受控发布流，拦截未登记 release 配置的直接 Tag 推送与旁路构建。
- **品牌矩阵与链接修正**：全站更新为「影瞬 Shadow Snap」，对齐单行极简 Footer 与 `snap.shadow.wang` 独立域名。
