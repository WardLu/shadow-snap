# Shadow Snap Release Notes

**English** · [简体中文](RELEASE_NOTES.zh-CN.md)

Release notes for each published version of Shadow Snap (影瞬), a tool that turns a movie still and lines of dialogue into a cinematic subtitle long image.

---

## v1.5.4 - 2026-11-23

### Changed

- Chinese pages no longer download about 119 Noto Sans SC slices. They use a single 161,876-byte CJK subset (`public/fonts-subset/noto-sans-sc-cjk.woff2`), and `--font-ui` prefers the system's Chinese fonts. The unused Archivo Black package was removed. Measured locally on `/zh-hant/`: 406,926 B in 19 requests, of which fonts are 72,246 B (the previous live page: 2,979,497 B in 70 requests, with 2,820,852 B in 54 font requests).
- The WebApplication JSON-LD is consolidated on every page. Added an IndexNow key file and `robots.txt` rules for Yandex (`Clean-param` for UTM parameters).
- The Chinese social image (`og_shadow_snap.png`) no longer shows a version number, the same as the English one.
- The source code is public again at [github.com/WardLu/shadow-snap](https://github.com/WardLu/shadow-snap). Hosted CI on GitHub Actions runs the same checks as the local gate.

### Removed

- The site no longer serves the Baidu, Sogou, 360 and StartupRanking verification files, or two unused brand logos (`shadow_card_logo.svg`, `shadow_portal_logo.svg`).

### Fixed

- Production acceptance no longer reports a response header that is present as missing. The header check piped into `grep -q`, and with `pipefail` the early exit of `grep` made the check fail.

### Notes

- The font, structured data and release script changes above were already live before this version without a version bump. v1.5.4 records them.

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

> **Type**: Mobile usability, export fixes and stricter release discipline

### Key changes

- **Mobile layout**: the page now scrolls as a normal document and the canvas preview sticks to the top, so the live preview stays in view while you adjust fonts or strips. The bottom action dock no longer collapses into vertical text, the footer wraps in full, touch controls are larger (slider thumbs, switches, buttons), inputs use 16px text to avoid iOS focus zoom, and the preview collapses while you edit dialogue to make room for the on-screen keyboard.
- **Export fixes**: export now encodes a Blob and opens the system share sheet ("Save Image" on mobile saves it to the device). Engines that cannot share files (Quark, UC) and the WeChat in-app browser use a long-press save overlay instead; in WeChat the preview is an inline image so that long-press can save it. Added a canvas area cap (12 megapixels on touch devices; larger images are scaled down evenly and the actual export size is shown) and a 4-second encoding timeout fallback.
- **Interface consistency**: fixed an i18n overwrite that removed the icons from the Export and Clear buttons, and translated the Chinese text left in the English interface (including title, aria-label and alt).
- **Security hardening**: `.vercelignore` now uses patterns (`.env*`, `.release-state`, `.DS_Store`), uploads are capped at 30 MB, and two redundant public files were removed.
- **Release discipline**: `deploy-production.sh` gained hard gates (clean worktree, `production` branch only, `HEAD` equal to `origin/production`, with no bypass switch). Live content is compared byte for byte with the commit before and after `promote`. The gate scripts joined the `config/controller-files.sha256` integrity check. The controller's Stage sync switched to a remote build on the platform (the previous `--prebuilt` made deployments released through the controller lose the `/_vercel/*` analytics routes), and a contract test now asserts that `--prebuilt` does not appear. On release day a silent promote failure was also fixed: with `Auto-assign Custom Production Domains` turned off, promoting a preview deployment only creates a new production deployment without the domains, and the live content does not change (the byte-for-byte comparison caught it). Step 5 therefore changed to `vercel deploy --prod --skip-domain`.

## v1.2.0 - 2026-09-17

> **Type**: Visit analytics (Vercel Web Analytics)

### Key changes

- **Web Analytics**: uses Vercel's recommended same-origin route `/_vercel/insights/script.js`. The script and its reports (`/_vercel/insights/view`) stay on the same origin, so **no third-party script domain is added and the CSP is not relaxed** (script-src and connect-src stay `'self'`).
- **Static gates**: the validator allows the platform route `_vercel/*` and locks the analytics tag; the SEO regression tests and repository configuration tests were updated to match.
- **Note (updated 2026-09-18)**: production releases now use a **remote build** on Vercel (the `--prebuilt` flow does not get the platform-injected routes), and the platform's native `/_vercel/insights/*` was verified to work. The dashboard is the source of truth for counts (aggregation is delayed, and automated traffic may be filtered out).

## v1.1.9 - 2026-09-17

> **Type**: Subtitle outline artifact fix and a smaller published surface

### Key changes

- **Outline artifact fix**: the outline is now drawn by filling offset copies of the text around it. This removes the thin spikes that `strokeText` left at the sharp stroke ends of Chinese glyphs, in both the canvas preview and the exported image.
- **Smaller published surface**: added `.vercelignore` and a 404 route, so internal repository files (release scripts, tests, configuration, docs and payment QR code images) are no longer published with the site.
- **Security headers**: added a `Content-Security-Policy` (allowing Google Fonts and the local image pipeline), locked by the static validator and regression tests.

## v1.1.8 - 2026-09-17

> **Type**: Studio redesign, accessibility and viewfinder fixes, AITDK zero-defect audit and brand footer alignment

### Key changes

- **Studio layout**: a 65% film canvas stage and a 35% inspector split into sections (Script, Type and texture, Frame and watermark), in a dark "Obsidian Noir" style.
- **Less template-like visuals**: removed all emoji and added detailed SVG icons and classic movie lines for inspiration (Life of Pi, Interstellar, In the Mood for Love, The Truman Show).
- **Viewfinder fix**: rebuilt the standalone 16:9 film viewfinder shown before an image is loaded, removing the height truncation and covered text caused by the dummy canvas.
- **WCAG AA/AAA accessibility**: raised the contrast of all text, labels, tabs and values across the site (up to 18:1) and removed low-contrast dark-gray text.
- **AITDK zero defects and dual schema**: moved the SEO/GEO long-form copy and the FAQ into accessible `.sr-only` CSS, while keeping the WebApplication contract locked by the Release Controller and the site-wide `@graph` companion data.
- **Brand line and footer**: added the official Shadow Lab paper-white and amber double-ring logo and a link to the product page, removed the extra tipping and external links, and fixed a typo in the feedback email subject.

## v1.1.7 - 2026-09-05

- Reconcile the protected production ancestry and preserve the Baidu verification assets.
- Keep v1.1.6 product behavior while advancing release metadata.

## v1.1.6 - 2026-09-05

> **Type**: Brand entity relationships and stronger security headers

### Key changes

- **Visible naming**: the main title shows the full name "影瞬 Shadow Snap".
- **Entity relationships**: the WebApplication JSON-LD links to the Shadow Nexus Organization through a stable `@id`.
- **Security headers**: added `nosniff`, same-origin framing and a referrer policy, and added them to the static validator.

## v1.1.5 - 2026-09-03

> **Type**: SEO/GEO discoverability basics and controlled release alignment

### Key changes

- **Indexing basics**: added Chinese and English titles, descriptions, canonical, Open Graph, Twitter and WebApplication JSON-LD.
- **Crawler entry points**: added a canonical `robots.txt` and a single-URL `sitemap.xml`.
- **Release acceptance**: updated the Release Controller's production acceptance title and locked the SEO contract with regression tests.

## v1.1.4 - 2026-08-30

> **Type**: Release governance and deployment metadata hardening

### Key changes

- **Metadata checks**: improved the comparison of deployment facts with the controlled Promote evidence chain, with snapshot-style signature verification.
- **Release state**: updated the `.release-state/v1.1.4` production state so that the archive cannot change.

## v1.1.3 - 2026-08-30

> **Type**: Intent gate baseline re-check

### Key changes

- **Pre-intent evidence check**: the hashes of earlier evidence are checked again at generation time, so an unverified dirty build cannot enter the release queue.

## v1.1.2 - 2026-08-30

> **Type**: Adopting the existing production baseline (Adopt Intent)

### Key changes

- **Existing baseline adoption**: the controlled release flow can take over the static HTML/Canvas deployment that was already running reliably in production.

## v1.1.1 - 2026-08-30

> **Type**: Normalized manifest digest

### Key changes

- **File fingerprints**: normalized how the SHA256 of the release artifact manifest is calculated, so signatures match across environments.

## v1.1.0 - 2026-08-30

> **Type**: Controlled production release workflow and security gates

### Key changes

- **Release Controller**: added a controlled release flow that blocks direct tag pushes without a registered release configuration, and builds that bypass it.
- **Brand and links**: renamed the site to "影瞬 Shadow Snap" everywhere, and aligned the single-line minimal footer and the standalone `snap.shadow.wang` domain.
