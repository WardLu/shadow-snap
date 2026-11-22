import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TRANS } from '../../translations.mjs';
import { DEFAULT_LOCALE, LOCALES, SEO, assertLocaleCompleteness, escapeHtml, guideHtml, hreflangEntries, localeLinksHtml, localizeSchema, ogAlternateLocales } from '../../seo-content.mjs';
const packageVersion = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;

const ALTERNATE_LINKS = /(?:[ \t]*<link rel="alternate" hreflang="[^"]*" href="[^"]*">\n)+/;
const OG_ALTERNATES = /(?:[ \t]*<meta property="og:locale:alternate" content="[^"]*">\n)+/;
const LANG_SELECT = /(<select id="lang-select"[^>]*>)[\s\S]*?(<\/select>)/;
const indentLines = (lines, indent) => lines.map((line) => `${indent}${line}\n`).join('');

// index.html owns the shared layout; translations and SEO content own locale facts.
export function renderPage(template, locale) {
  assertLocaleCompleteness();
  if (!SEO[locale]) throw new Error(`unsupported_locale:${locale}`);
  for (const [name, pattern] of [
    ['html', /<html\b/g], ['canonical', /<link rel="canonical"(?=\s|>)/g],
    ['application-schema', /<script id="shadow-snap-structured-data" type="application\/ld\+json">/g],
    ['faq-schema', /<script id="shadow-snap-geo-data" type="application\/ld\+json">/g],
    ['product-guide', /<details id="product-guide"(?=\s|>)/g],
  ]) {
    if ([...template.matchAll(pattern)].length !== 1) throw new Error(`locale_template_required_node:${name}`);
  }
  const guide = template.match(/<details id="product-guide"[^>]*>([\s\S]*?)<\/details>/)?.[1] ?? '';
  if ((guide.match(/<summary\b/g) ?? []).length !== 1 || (guide.match(/<article\b/g) ?? []).length !== 1) throw new Error('locale_template_guide_invalid');
  const graph = JSON.parse(template.match(/id="shadow-snap-geo-data" type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  if (graph['@graph']?.filter((node) => node['@type'] === 'FAQPage').length !== 1) throw new Error('locale_template_faq_missing');
  const s = SEO[locale];
  const t = TRANS[locale];
  let html = template.replace(/<html lang="[^"]*"(?: dir="[^"]*")?>/, () => `<html lang="${s.lang}" dir="${s.dir}">`);
  html = html.replace(/<([a-z][\w-]*)\b([^>]*\bdata-i18n="([^"]+)"[^>]*)>[\s\S]*?<\/\1>/gi, (match, tag, attrs, key) => {
    if (!(key in t)) throw new Error(`missing_translation:${locale}:${key}`);
    const content = key === 'header_title' ? t[key] : escapeHtml(t[key]);
    return `<${tag}${attrs}>${content}</${tag}>`;
  });
  html = html.replace(/<[^>]+\bdata-i18n-(title|aria|alt)="[^"]+"[^>]*>/g, (tag) => {
    for (const [suffix, attribute] of [['title', 'title'], ['aria', 'aria-label'], ['alt', 'alt']]) {
      const key = tag.match(new RegExp(`data-i18n-${suffix}="([^"]+)"`))?.[1];
      if (!key) continue;
      if (!(key in t)) throw new Error(`missing_translation:${locale}:${key}`);
      tag = tag.replace(new RegExp(`(?<![\\w-])${attribute}="[^"]*"`), `${attribute}="${escapeHtml(t[key])}"`);
    }
    return tag;
  });
  const isZh = locale === 'zh' || locale === 'zh-hant';
  const shareImage = isZh
    ? 'https://snap.shadow.wang/public/brand_assets/og_shadow_snap.png'
    : 'https://snap.shadow.wang/public/brand_assets/og_shadow_snap_en.png';
  const values = {
    description: s.description, 'og:title': t.page_title, 'twitter:title': t.page_title,
    'og:description': s.description, 'twitter:description': s.description, 'og:url': s.url, 'og:locale': s.ogLocale,
    'og:image': shareImage, 'twitter:image': shareImage,
    'og:image:alt': t.share_image_alt, 'twitter:image:alt': t.share_image_alt,
  };
  html = html.replace(/<meta (name|property)="([^"]+)" content="[^"]*">/g, (match, attribute, key) => (key in values ? `<meta ${attribute}="${key}" content="${escapeHtml(values[key])}">` : match));
  html = html.replace(ALTERNATE_LINKS, () => indentLines(hreflangEntries().map(([lang, href]) => `<link rel="alternate" hreflang="${lang}" href="${href}">`), '    '));
  html = html.replace(OG_ALTERNATES, () => indentLines(ogAlternateLocales(locale).map((ogLocale) => `<meta property="og:locale:alternate" content="${ogLocale}">`), '    '));
  html = html.replace(/<link rel="canonical" href="[^"]+">/, () => `<link rel="canonical" href="${s.url}">`);
  html = html.replace(/<script id="(shadow-snap-structured-data|shadow-snap-geo-data)" type="application\/ld\+json">([\s\S]*?)<\/script>/g, (_, id, json) => {
    const data = localizeSchema(JSON.parse(json), locale);
    for (const node of data['@graph'] ?? [data]) if (node['@type'] === 'WebApplication' && node.softwareVersion) node.softwareVersion = packageVersion;
    return `<script id="${id}" type="application/ld+json">\n${JSON.stringify(data, null, 2)}\n    </script>`;
  });
  html = html.replace(/(<details id="product-guide"[^>]*>)[\s\S]*?<\/details>/, (_, open) => `${open}\n            <summary>${escapeHtml(s.guideTitle)}</summary>\n            <article aria-label="${escapeHtml(s.guideTitle)}">${guideHtml(locale)}</article>\n        </details>`);
  const options = LOCALES.map((item) => `                        <option value="${item}"${item === locale ? ' selected' : ''}>${escapeHtml(SEO[item].nativeName)}</option>`).join('\n');
  html = html.replace(LANG_SELECT, (_, open, close) => `${open}\n${options}\n                    ${close}`);
  html = html.replace(/(data-product-link href=")[^"]+/, (_, open) => `${open}https://shadow.wang/${locale}/products/shadow-snap`)
    .replace(/(data-portal-link href=")[^"]+/, (_, open) => `${open}https://shadow.wang/${locale}`)
    // Xinquji serves a Chinese or English badge; Chinese pages show 新趣集, every other locale Xinquji.com.
    .replace(/(data-xinquji-badge src="[^"]*?lang=)[a-z]+/, (_, open) => `${open}${s.lang.startsWith('zh') ? 'zh' : 'en'}`)
    .replace(/(<textarea id="subtitle-text" placeholder=")[^"]+/, (_, open) => `${open}${escapeHtml(t.placeholder_text)}`)
    .replace(/(<input type="text" id="wm-text" value=")[^"]+/, (_, open) => `${open}${escapeHtml(t.default_wm)}`);
  return html.replace(/[\t ]+$/gm, '');
}

export function renderSitemap() {
  assertLocaleCompleteness();
  const alternates = hreflangEntries().map(([lang, href]) => `    <xhtml:link rel="alternate" hreflang="${lang}" href="${href}"/>`).join('\n');
  const urls = LOCALES.map((locale) => `  <url>\n    <loc>${SEO[locale].url}</loc>\n${alternates}\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
}

// Static 404 for every unmatched path (Vercel serves the root 404.html with status 404). Default English; not-found.mjs switches text by path.
// It is excluded from the 200 artifact manifest, so it is verified here and by validate-static-site.mjs rather than by byte comparison.
export function renderNotFound() {
  assertLocaleCompleteness();
  const s = SEO[DEFAULT_LOCALE];
  const t = TRANS[DEFAULT_LOCALE];
  return `<!DOCTYPE html>
<html lang="${s.lang}" dir="${s.dir}" class="not-found-page">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="theme-color" content="#090a0f">
    <meta name="color-scheme" content="dark">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(t.not_found_title_tag)}</title>
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link rel="stylesheet" href="/style.css">
    <script type="module" src="/not-found.mjs"></script>
</head>
<body>
    <main class="not-found">
        <a class="not-found-brand" data-not-found-home href="${s.path}"><img src="/public/brand_assets/shadow_snap.svg" alt="" width="40" height="40"><span>Shadow Snap</span></a>
        <h1 data-i18n="not_found_title">${escapeHtml(t.not_found_title)}</h1>
        <p class="not-found-desc" data-i18n="not_found_desc">${escapeHtml(t.not_found_desc)}</p>
        <p class="not-found-actions">
            <a class="not-found-home" data-not-found-home href="${s.path}" data-i18n="not_found_home">${escapeHtml(t.not_found_home)}</a>
            <a class="not-found-product" data-not-found-product href="https://shadow.wang/${DEFAULT_LOCALE}/products/shadow-snap" target="_blank" rel="noopener noreferrer" data-i18n="not_found_product">${escapeHtml(t.not_found_product)}</a>
        </p>
        <nav class="not-found-locales" aria-label="${escapeHtml(t.not_found_languages)}" data-i18n-aria="not_found_languages">${localeLinksHtml('')}</nav>
    </main>
</body>
</html>
`;
}

export async function localizedOutputs(repoRoot) {
  assertLocaleCompleteness();
  const template = await readFile(path.join(repoRoot, 'index.html'), 'utf8');
  const outputs = {};
  for (const locale of LOCALES) outputs[`${SEO[locale].path.slice(1)}index.html`] = renderPage(template, locale);
  outputs['sitemap.xml'] = renderSitemap();
  return outputs;
}

export async function checkLocalizedPages(repoRoot) {
  const outputs = { ...(await localizedOutputs(repoRoot)), '404.html': renderNotFound() };
  for (const [file, content] of Object.entries(outputs)) {
    const actual = await readFile(path.join(repoRoot, file), 'utf8').catch(() => null);
    if (actual !== content) throw new Error(`localized_output_stale:${file}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    await checkLocalizedPages(process.cwd());
    console.log('Localized pages, sitemap and 404.html are current.');
  } else {
    const outputs = { ...(await localizedOutputs(process.cwd())), '404.html': renderNotFound() };
    for (const [file, content] of Object.entries(outputs)) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    console.log(`Generated ${LOCALES.length} localized pages (${LOCALES.join(', ')}), the reciprocal sitemap and 404.html.`);
  }
}
