# Shadow Snap Release Notes

本文档记录 Shadow Snap（影瞬 · 电影感多行字幕长图生成工具）历史版本发布说明。

---

## Unreleased

### Changed

- 中文页不再下载约 119 个 Noto Sans SC 分片：改为单个 161,876 B 的 CJK 子集（`public/fonts-subset/noto-sans-sc-cjk.woff2`），并让 `--font-ui` 优先使用系统中文字体。已移除未被页面使用的 Archivo Black 包；本地 `/zh-hant/` 实测总传输 406,926 B / 19 请求，字体 72,246 B（旧线上同页 2,979,497 B / 70 请求 / 54 个字体请求 2,820,852 B）。

---

## v1.5.3 - 2026-11-07

### Changed

- The seven font families that the page previously requested from Google Fonts (Archivo Black, IBM Plex Mono, Noto Sans SC, Roboto, Noto Sans Thai, Noto Sans Arabic and the "Noto Sans Vietnamese" option) are now served from the site under `/public/fonts/`. Pages no longer request `fonts.googleapis.com` or `fonts.gstatic.com`, and the Content-Security-Policy `style-src` and `font-src` in `vercel.json` now allow only `'self'`.
- The previous Google Fonts request named `Noto Sans Vietnamese`, which is not a Google Fonts family. The option keeps its value and is now served by Noto Sans, which covers Vietnamese.
- Font versions are pinned in `config/fonts.json`. `public/fonts/fonts.lock.json` records the npm integrity of each Fontsource package and the SHA-256 of every file, and each font folder keeps its SIL Open Font License 1.1. `scripts/fonts/vendor-fontsource.mjs` (from shadow-devkit) regenerates the files.
- `.vercelignore` now excludes only the repository-root `LICENSE`. The previous `LICENSE` rule matched files at any depth and would have left the font license files out of the deployment.

### Fixed

- Fonts are split by `unicode-range`. The canvas now loads the ranges that the current subtitle text needs and redraws once when they arrive. Export waits up to 2 seconds for them and then exports the current canvas, so a slow font download cannot leave the export stuck.

### Added

- `validate:static` follows `url()` references in linked local stylesheets and rejects remote ones, so `fonts.css` and every WOFF2 file join the release byte-verification list.
- `tests/release/contracts/fonts.test.mjs` (part of the release admission commands) fails when a page requests Google Fonts, the CSP allows a remote font host, a font file or the generated CSS differs from the lock file, or `.vercelignore` excludes any file in the font folder.

## v1.5.2 - 2026-11-04

### Changed

- Added three directory badges to the "Featured on" bar on every home page: Twelve Tools, Fazier and Xinquji (新趣集). Each site's free listing requires a lasting link from our site, and each meets the badge threshold (third-party Domain Rating 50 or higher and at least 5K monthly visits; AITDK, September 2026: Twelve Tools DR 84 / 60.5K, Fazier DR 84 / 76.06K, Xinquji DR 64 / 85.92K). The Xinquji badge shows "新趣集" on the Simplified and Traditional Chinese pages and "Xinquji.com" elsewhere.
- The `img-src` Content-Security-Policy in `vercel.json` now allows the three badge hosts.

## v1.5.1 - 2026-11-04

### Changed

- Removed eight directory badges from the "Featured on" bar on every home page: Findly.tools, Turbo0, Maidensail, Starter Best, DanielLaunches, LaunchZone, ShinyLaunch and LaunchBuck. Badges require a third-party Domain Rating of 50 or higher and at least 5K monthly visits. AITDK data for September 2026 puts five of them between 883 and 3.07K monthly visits; LaunchZone, Starter Best and ShinyLaunch have no traffic data, so they could not be confirmed to qualify.
- Nick Launches (15.87K monthly visits) stays while its listing is under review. The `img-src` Content-Security-Policy in `vercel.json` now allows only its badge host.

## v1.5.0 - 2026-11-02

### Added

- The root page `/` follows the browser language on the first visit. The match checks `navigator.languages` in order: Traditional Chinese (`zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`) goes to `/zh-hant/`, other Chinese goes to `/`, and any other language goes to its own home page when the site supports it. Unmatched languages use English (`/en/`). The page moves with `location.replace`, keeping the query and hash, so the browser history is not extended.
- A visit to `/` from inside the site (a same-origin referrer, such as the 404 page's language links) is not redirected, so a language the user picked in the site stays in effect for that browsing. Direct visits, external links and bookmarks follow the browser language.

### Notes

- Nothing is stored: the script does not read or write `localStorage`, `sessionStorage` or cookies. A language chosen in the site survives a refresh through a marker in the current history entry's `history.state`, which is not storage. Crawler user agents are never redirected. The HTML of `/` is unchanged for every request, and canonical, hreflang and sitemap entries stay the same.

## v1.4.1 - 2026-11-01

### Fixed

- The localized 404 page now shows Chinese for missing paths without a locale prefix (for example `/missing`), because Chinese lives at the unprefixed root. Paths with a known prefix still use that language (`/ja/missing` is Japanese). The static `404.html` stays English for readers without JavaScript.

## v1.4.0 - 2026-11-01

### Added

- Twelve site languages: 简体中文 at `/`, English at `/en/`, 繁體中文 at `/zh-hant/`, and 日本語, 한국어, Español, Português, Français, Deutsch, Русский, Bahasa Indonesia and العربية at `/<locale>/`. Each page sets its own `lang` and `dir` (Arabic is right-to-left), carries the full hreflang set with `x-default` pointing at English, lists the other locales in `og:locale:alternate`, and appears in a sitemap of all twelve URLs.
- Localized static 404 page for unmatched paths, served with status 404 and `noindex`. It lists every language and links to the product page. The language follows the path prefix through an external module, so the CSP keeps `script-src 'self'`.

### Changed

- The language switcher, the guide's language links and the FAQ are generated from one locale source, aligned with Shadow Portal's locale list. The FAQ now states that the interface supports 12 languages.
- The movie-line chips are defined once for every locale.

## v1.3.5 - 2026-10-18

### Fixed

- Long-pressing the preview in the save overlay did not save the image in Quark and UC. These engines re-download the image by its address on long-press and cannot read a `blob:` URL. The preview now uses a data URL, as in WeChat, while the Download button keeps the blob. The overlay hint now leads with the Download button.

## v1.3.4 - 2026-10-18

### Fixed

- Quark and UC report file sharing through `canShare({ files })`, but `share()` never opens a sheet or settles, so export hung after the "exporting" toast. These engines now skip the system share sheet and open the long-press save overlay directly.
- Add `blob:` to the CSP `img-src`. The save overlay previews the PNG through an object URL, which the previous policy blocked, leaving a broken image that could not be long-pressed.

## v1.3.3 - 2026-10-17

### Fixed

- The production entry re-checks the live remote with `git ls-remote` before deployment and rejects a stale or unpushed `production` HEAD.
- Admission commands run with an allowlisted environment and a throwaway `HOME`, so tests and installs cannot read the caller's credentials.

### Changed

- Add a pre-commit hook that rejects staged credential files, a pull request template and `.nvmrc`. The page content is unchanged except `softwareVersion`.

## v1.3.2 - 2026-10-05

### Added

- Complete Chinese `/` and English `/en/` static pages with self canonicals, reciprocal hreflang and a two-locale sitemap.
- User-readable product guide and FAQ sharing localized facts with JSON-LD; language links retain image, dialogue and watermark state.
- Loopback-only allowlisted preview with analytics disabled, plus generated-content drift and missing-FAQ gates.

### Fixed

- Derive candidate and dual-domain asset checks from the validated site graph, covering localized HTML, imported modules, sitemap, robots and branding.
- Reject missing assets, redirects, incorrect MIME types and byte mismatches before promotion; report the full production commit SHA.
- Synchronize softwareVersion with package.json through static generation. Production deployment remains controlled and separately authorized.


## v1.3.1 - 2026-09-21

### Fixed

- Bind deployment commands to the configured Vercel project and team, and reject conflicting local links or inherited environment variables.
- Recheck deployment identity before production promotion to prevent accidental projects from temporary work directories.
- Require byte-for-byte candidate verification through authenticated Vercel access before switching production domains.

## v1.3.0 - 2026-09-18

> **类型**: 移动端可用性、导出链路修复与发布纪律收紧

### 核心变更
- **移动端适配**：改为文档流滚动＋画布预览吸顶，调整字体/切片时实时预览常驻；底部操作坞不再被挤压成竖排文字；页脚折行完整显示；触控控件放大（滑块拇指、开关、按钮）；输入框提到 16px 规避 iOS 聚焦放大；编辑台词时预览收起，为软键盘让位。
- **导出链路修复**：改用 Blob 编码与系统分享面板（移动端「存储图像」落盘）；不支持分享文件的内核（夸克、UC）与微信内置浏览器改用长按保存浮层，微信下预览改内联图片以支持长按存图；新增画布面积上限保护（触屏 12M 像素，超出等比缩小并提示实际导出尺寸）与 4 秒编码超时兜底。
- **界面一致性**：修复 i18n 覆盖导致导出/清空按钮图标消失的缺陷；补齐英文界面残留中文（含 title / aria-label / alt）。
- **安全加固**：`.vercelignore` 改为通配（`.env*`、`.release-state`、`.DS_Store`），上传增加 30MB 体积上限，清理两个冗余公开文件。
- **发布纪律**：`deploy-production.sh` 新增硬门禁（工作区干净 / 只允许 `production` 分支 / `HEAD` 与 `origin/production` 一致，无绕过开关）；`promote` 前后逐字节比对线上内容与本次提交；门禁脚本纳入 `config/controller-files.sha256` 完整性校验；控制器的 Stage 同步改为平台侧远程构建（原先的 `--prebuilt` 会让经控制器发布的部署丢失 `/_vercel/*` 分析路由），合约测试新增"不得出现 `--prebuilt`"断言防回退。发布当天还修复了 promote 未切换域名的静默失败——`Auto-assign Custom Production Domains` 关闭时，对 preview 部署 promote 只会另建一个不带域名的新 production 部署、线上内容原地不动（是逐字节比对把它拦下的），第 5 步因此改为 `vercel deploy --prod --skip-domain`。

---

## v1.2.0 - 2026-09-17

> **类型**: 访问分析接入（Vercel Web Analytics）

### 核心变更
- **Web Analytics 接入**：采用 Vercel 官方推荐的自托管路由 `/_vercel/insights/script.js`，脚本与上报（`/_vercel/insights/view`）全部同源，**不引入任何第三方脚本域、无需放宽 CSP**（script-src / connect-src 保持 `'self'`）。
- **静态门禁同步**：校验器放行平台路由 `_vercel/*` 并新增 analytics 标签锁定；SEO 回归测试与仓库配置测试同步更新。
- **说明（2026-09-18 更新）**：生产发布已切换为 Vercel 侧**远程构建**（`--prebuilt` 流程不会获得平台注入路由），平台原生 `/_vercel/insights/*` 已验证可用；数据计数以后台面板为准（聚合有延迟，且自动化流量可能被过滤）。

---

## v1.1.9 - 2026-09-17

> **类型**: 字幕描边伪影修复与站点发布面收敛

### 核心变更
- **字幕描边伪影修复**：描边改用环绕偏移填充实现，彻底消除 `strokeText` 在中文字形尖锐收笔处甩出的细刺伪影（画布预览与导出长图同步生效）。
- **发布面收敛**：新增 `.vercelignore` 与 404 路由，仓库内部文件（发布脚本、测试、配置、文档、收款码素材）不再随站点对外公开。
- **安全响应头补强**：新增 `Content-Security-Policy`（放行 Google Fonts 与本地图片管线），并由静态校验器与回归测试锁定。

---

## v1.1.8 - 2026-09-17

> **类型**: 院线级工作台重构、无障碍与取景框体验治理、AITDK 零缺陷与品牌页脚对齐

### 核心变更
- **工作台架构升级**：采用 65% 胶片画布舞台 + 35% 检查器分段控制台（台词脚本、字体质感、画幅水印），构建 Obsidian Noir 沉浸式暗黑美学。
- **视觉去模板化**：彻底移除所有 Emoji 符号，全面引入专业精细 SVG 图标与电影经典对白灵感（少年派、星际穿越、花样年华、楚门的世界）。
- **取景框体验修复**：重构未载入图片时的独立 16:9 胶片取景框，彻底消除 Dummy Canvas 导致的高度截断与文案遮挡缺陷。
- **WCAG AA/AAA 无障碍升级**：全面提高全站所有文本、标签、选项卡与数值的对比度（最高达 18:1），杜绝暗灰低对比度文字。
- **AITDK 零缺陷与双 Schema**：通过无障碍 `.sr-only` CSS 将 SEO/GEO 长文与 FAQ 结构化收拢，同时兼容 Release Controller 严格锁定的 WebApplication 合约与全域 `@graph` 伴生数据。
- **品牌矩阵与页脚对齐**：统一接入 Shadow Lab 官方纸白/琥珀双环 Logo 与产品介绍页入口，精简移除多余赞赏与外链，修正邮件反馈主题错别字。

---

## v1.1.7 - 2026-09-05

- Reconcile the protected production ancestry and preserve the Baidu verification assets.
- Keep v1.1.6 product behavior while advancing release metadata.

## v1.1.6 - 2026-09-05

> **类型**: 品牌实体关系与安全响应头增强

### 核心变更
- **可见语义**：主标题完整显示“影瞬 Shadow Snap”。
- **实体关系**：WebApplication JSON-LD 通过稳定 `@id` 关联 Shadow Nexus Organization。
- **安全响应头**：增加 `nosniff`、同源嵌入与 referrer policy，并纳入正式静态校验器。

---

## v1.1.5 - 2026-09-03

> **类型**: SEO/GEO 可发现性基础设施与受控发布对齐

### 核心变更
- **索引基础设施**：补充中文/英文标题、描述、canonical、Open Graph、Twitter 与 WebApplication JSON-LD。
- **爬虫入口**：新增 canonical `robots.txt` 与单 URL `sitemap.xml`。
- **发布验收对齐**：更新 Release Controller 的生产验收标题，并以回归测试锁定 SEO 合约。

---

## v1.1.4 - 2026-08-30

> **类型**: 发布治理与部署元数据加固

### 核心变更
- **元数据校验强化**：完善部署事实与受控 Promote 证据链比对，支持快照式验签。
- **发布状态收敛**：更新 `.release-state/v1.1.4` 生产状态，确保不可变归档。

---

## v1.1.3 - 2026-08-30

> **类型**: 意图门禁基线复核

### 核心变更
- **Pre-intent 证据链验证**：在生成阶段重检前置证据哈希，杜绝未经验证的脏构建进入待发布队列。

---

## v1.1.2 - 2026-08-30

> **类型**: 既有生产基线采纳 (Adopt Intent)

### 核心变更
- **支持既有基线纳入**：使受控发布流无缝对接历史已在生产环境稳定运行的静态 HTML/Canvas 部署。

---

## v1.1.1 - 2026-08-30

> **类型**: 规范化 Manifest 摘要

### 核心变更
- **文件指纹标准化**：规范化发布产物清单（Manifest）SHA256 计算逻辑，统一跨环境签名。

---

## v1.1.0 - 2026-08-30

> **类型**: 生产受控发布工作流与安全门禁

### 核心变更
- **接入 Release Controller**：引入受控发布流，拦截未登记 release 配置的直接 Tag 推送与旁路构建。
- **品牌矩阵与链接修正**：全站更新为「影瞬 Shadow Snap」，对齐单行极简 Footer 与 `snap.shadow.wang` 独立域名。
