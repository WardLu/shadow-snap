import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkLocalizedPages } from './seo/generate-localized-pages.mjs';
import { LOCALES, SEO, assertLocaleCompleteness, escapeHtml, hreflangEntries, ogAlternateLocales } from '../seo-content.mjs';

function referencedAsset(value) {
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.origin !== new URL(SEO.zh.url).origin) return null;
    return localAsset(url.pathname);
  }
  return localAsset(value);
}

function fail(reasonCode) {
  throw new Error(reasonCode);
}

// img-src admits exactly the hosts of the directory badges rendered in the page template.
export function expectedContentSecurityPolicy(html) {
  const nav = html.match(/<nav class="featured-on"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
  const badgeSources = [...nav.matchAll(/<img\b[^>]*>/gi)].map((tag) => tag[0].match(/\bsrc="(https:\/\/[^"\s]+)"/)?.[1] ?? fail('static_badge_src_invalid'));
  // Remote images anywhere else would be blocked by CSP, so only badges may load off-site.
  const outside = html.replace(/<nav class="featured-on"[^>]*>[\s\S]*?<\/nav>/, '');
  for (const tag of outside.matchAll(/<img\b[^>]*>/gi)) {
    if (/\bsrc=["']?(?:https?:)?\/\//i.test(tag[0])) fail('static_remote_image_outside_badges');
  }
  const badgeOrigins = [...new Set(badgeSources.map((src) => new URL(src).origin))];
  const imgSrc = ["'self'", 'data:', 'blob:', ...badgeOrigins].join(' ');
  return `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src ${imgSrc}; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`;
}

function localAsset(value) {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return null;
  }
  const withoutSuffix = trimmed.split(/[?#]/, 1)[0];
  const decoded = decodeURIComponent(withoutSuffix).replace(/^\//, '');
  // 平台路由（如 Vercel Analytics 的 _vercel/insights/*）由托管平台在部署时生成，
  // 不是仓库内文件，不做存在性检查。
  if (decoded.startsWith('_vercel/')) return null;
  const normalized = path.posix.normalize(decoded);
  if (normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    fail('static_asset_path_invalid');
  }
  return normalized;
}

// Static 404 contract: noindex, English default, no inline script or handler (CSP script-src 'self'), and every locale linked.
export function assertNotFoundPage(notFound) {
  if (!notFound.includes('<meta name="robots" content="noindex">') || !notFound.includes(`<html lang="${SEO.en.lang}" dir="${SEO.en.dir}"`) || !notFound.includes('<script type="module" src="/not-found.mjs"></script>')) fail('static_404_invalid');
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(notFound) || /\son[a-z]+\s*=/i.test(notFound)) fail('static_404_inline_script');
  if ((notFound.match(/data-locale="/g) ?? []).length !== LOCALES.length) fail('static_404_locales_invalid');
}

export async function validateStaticSite(repoRoot) {
  assertLocaleCompleteness();
  await checkLocalizedPages(repoRoot);
  const pages = {};
  for (const locale of LOCALES) {
    pages[locale] = await readFile(path.join(repoRoot, `${SEO[locale].path.slice(1)}index.html`), 'utf8');
  }
  const html = pages.zh;
  const notFound = await readFile(path.join(repoRoot, '404.html'), 'utf8').catch(() => fail('static_404_missing'));
  const robots = await readFile(path.join(repoRoot, 'robots.txt'), 'utf8').catch(() => fail('static_robots_missing'));
  const sitemap = await readFile(path.join(repoRoot, 'sitemap.xml'), 'utf8').catch(() => fail('static_sitemap_missing'));
  const llms = await readFile(path.join(repoRoot, 'llms.txt'), 'utf8').catch(() => fail('static_llms_missing'));
  if (!llms.startsWith('# Shadow Snap') || LOCALES.some((locale) => !llms.includes(SEO[locale].url))) {
    fail('static_llms_invalid');
  }
  const everyPage = [...Object.values(pages), notFound].join('\n');
  const assets = new Set();
  const pattern = /\b(?:src|href)=["']([^"']+)["']/gi;
  for (const match of everyPage.matchAll(pattern)) {
    const asset = referencedAsset(match[1]);
    if (asset) assets.add(asset);
  }
  for (const tag of everyPage.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\b(?:property|name)=["'](?:og:image|twitter:image)["']/i.test(tag[0])) continue;
    const content = tag[0].match(/\bcontent=["']([^"']+)["']/i)?.[1];
    const asset = content && referencedAsset(content);
    if (asset) assets.add(asset);
  }
  // Follow local ES module imports from the script entrypoints (including cycles).
  const pending = [...assets].filter((asset) => /\.(?:mjs|js)$/.test(asset));
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(path.join(repoRoot, file), 'utf8').catch(() => fail(`static_asset_missing:${file}`));
    const imports = /(?:^|;)\s*(?:import\s*(?:[^;]*?\s+from\s*)?|export\s+[^;]*?\s+from\s*)["']([^"']+)["']/gm;
    for (const match of source.matchAll(imports)) {
      if (!match[1].startsWith('.')) continue;
      const asset = localAsset(path.posix.join(path.posix.dirname(file), match[1]));
      assets.add(asset);
      if (/\.(?:mjs|js)$/.test(asset)) pending.push(asset);
    }
  }
  // Follow url() references in linked local stylesheets (self-hosted fonts in public/fonts/fonts.css), so they are
  // existence-checked here and byte-verified by the release manifest. Remote url() is never allowed: CSP is 'self'.
  for (const sheet of [...assets].filter((asset) => asset.endsWith('.css'))) {
    const css = await readFile(path.join(repoRoot, sheet), 'utf8').catch(() => fail(`static_asset_missing:${sheet}`));
    for (const match of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
      if (/^data:/i.test(match[1])) continue;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(match[1])) fail(`static_css_remote_url:${sheet}`);
      const target = match[1].startsWith('/') ? match[1] : path.posix.join(path.posix.dirname(`/${sheet}`), match[1]);
      const asset = localAsset(target);
      if (asset) assets.add(asset);
    }
  }
  for (const asset of assets) {
    await access(path.join(repoRoot, asset)).catch(() => fail(`static_asset_missing:${asset}`));
  }

  // Every locale page: its own lang/dir and canonical, the complete hreflang set, reciprocal og alternates,
  // a switch that lists exactly the locales, and FAQ facts that match the JSON-LD.
  for (const locale of LOCALES) {
    const page = pages[locale];
    const expected = SEO[locale];
    // The redirect script must be a blocking classic script in head, before the stylesheet, so the first paint already knows the locale.
    const redirectAt = page.indexOf('<script src="/locale-redirect.js"></script>');
    if (redirectAt === -1 || redirectAt > page.indexOf('<link rel="stylesheet" href="/style.css">') || redirectAt > page.indexOf('</head>')) fail('static_locale_redirect_invalid');
    if (!page.includes(`<html lang="${expected.lang}" dir="${expected.dir}">`) || !page.includes(`<link rel="canonical" href="${expected.url}">`)) fail('static_locale_metadata_invalid');
    const alternates = [...page.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((match) => [match[1], match[2]]);
    if (JSON.stringify(alternates) !== JSON.stringify(hreflangEntries())) fail('static_hreflang_invalid');
    if (!page.includes(`<meta property="og:locale" content="${expected.ogLocale}">`)) fail('static_og_locale_invalid');
    const ogAlternates = [...page.matchAll(/<meta property="og:locale:alternate" content="([^"]+)">/g)].map((match) => match[1]);
    if (JSON.stringify(ogAlternates) !== JSON.stringify(ogAlternateLocales(locale))) fail('static_og_locale_invalid');
    const languageSwitch = page.match(/<select id="lang-select"[\s\S]*?<\/select>/)?.[0] ?? '';
    const switchValues = [...languageSwitch.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
    if (JSON.stringify(switchValues) !== JSON.stringify(LOCALES) || (languageSwitch.match(/ selected/g) ?? []).length !== 1 || !languageSwitch.includes(`<option value="${locale}" selected>`)) fail('static_language_switch_invalid');
    if (!page.includes(`data-product-link href="https://shadow.wang/${locale}/products/shadow-snap"`)) fail('static_product_link_invalid');
    const guide = page.match(/<details id="product-guide"[^>]*>([\s\S]*?)<\/details>/)?.[1];
    const graph = JSON.parse(page.match(/id="shadow-snap-geo-data" type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '{}');
    const geoApps = graph['@graph']?.filter((node) => node['@type'] === 'WebApplication') ?? [];
    if (geoApps.length !== 0) fail('static_duplicate_webapp_schema');
    const faqs = graph['@graph']?.filter((node) => node['@type'] === 'FAQPage') ?? [];
    if (!guide || guide.includes('sr-only') || faqs.length !== 1 || faqs[0].inLanguage !== expected.lang || faqs[0]['@id'] !== `${expected.url}#faq` || faqs[0].mainEntity?.length !== expected.faq.length) fail('static_faq_invalid');
    for (const question of faqs[0].mainEntity) {
      if (!guide.includes(escapeHtml(question.name)) || !guide.includes(escapeHtml(question.acceptedAnswer?.text))) fail('static_faq_content_mismatch');
    }
    // Organization is Shadow Lab; personal accounts belong only to the Person (founder), not to the organization.
    const personalAccounts = ['https://x.com/Gollumgulu', 'https://github.com/WardLu', 'https://xhslink.cn/m/4W1NWyRrxv5', 'https://v.douyin.com/1y06PMohfoE/', 'https://weibo.com/u/8344390431'];
    const organization = graph['@graph']?.find((node) => node['@id'] === 'https://shadow.wang/#organization');
    if ((organization?.sameAs ?? []).some((url) => personalAccounts.includes(url))) fail('static_organization_personal_sameas');
  }

  assertNotFoundPage(notFound);

  const requiredHtml = [
    '<meta name="description"',
    '<meta name="robots" content="index,follow">',
    '<link rel="canonical" href="https://snap.shadow.wang/">',
    '<meta property="og:url" content="https://snap.shadow.wang/">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:image:alt" content="影瞬 Shadow Snap">',
    '<script id="shadow-snap-structured-data" type="application/ld+json">',
    '<script defer src="/_vercel/insights/script.js"',
  ];
  if (requiredHtml.some((snippet) => !html.includes(snippet))) {
    fail('static_seo_metadata_missing');
  }
  const expectedRobots = 'User-agent: *\nAllow: /\n\nUser-agent: Yandex\nAllow: /\nClean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term\n\nSitemap: https://snap.shadow.wang/sitemap.xml\n';
  if (robots !== expectedRobots) {
    fail('static_robots_invalid');
  }
  const indexNowKey = await readFile(path.join(repoRoot, '48b940e4f0d740df98a9d1bb83060fc7.txt'), 'utf8').catch(() => fail('static_indexnow_missing'));
  if (indexNowKey.trim() !== '48b940e4f0d740df98a9d1bb83060fc7') {
    fail('static_indexnow_invalid');
  }
  const sitemapLocations = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1]);
  if (JSON.stringify(sitemapLocations) !== JSON.stringify(LOCALES.map((locale) => SEO[locale].url))) {
    fail('static_sitemap_invalid');
  }
  const structuredDataMatch = html.match(
    /<script id="shadow-snap-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  let structuredData;
  try {
    structuredData = JSON.parse(structuredDataMatch?.[1] ?? '');
  } catch {
    fail('static_jsonld_invalid');
  }
  const appData = Array.isArray(structuredData?.['@graph'])
    ? structuredData['@graph'].find((item) => item?.['@type'] === 'WebApplication')
    : structuredData;

  if (
    structuredData?.['@context'] !== 'https://schema.org' ||
    appData?.['@type'] !== 'WebApplication' ||
    appData?.name !== 'Shadow Snap' ||
    appData?.alternateName !== '影瞬' ||
    appData?.url !== 'https://snap.shadow.wang/' ||
    appData?.['@id'] !== 'https://snap.shadow.wang/#application' ||
    appData?.publisher?.['@id'] !== 'https://shadow.wang/#organization' ||
    appData?.publisher?.name !== 'Shadow Lab' ||
    appData?.publisher?.url !== 'https://shadow.wang'
  ) {
    fail('static_jsonld_invalid');
  }

  let vercelConfig;
  try {
    vercelConfig = JSON.parse(await readFile(path.join(repoRoot, 'vercel.json'), 'utf8'));
  } catch {
    fail('vercel_json_invalid');
  }
  if (vercelConfig?.git?.deploymentEnabled !== false) {
    fail('vercel_git_deployment_not_disabled');
  }
  const responseHeaders = Object.fromEntries(
    (vercelConfig?.headers?.[0]?.headers ?? []).map(({ key, value }) => [key, value]),
  );
  const expectedCsp = expectedContentSecurityPolicy(html);
  if (
    responseHeaders['X-Content-Type-Options'] !== 'nosniff' ||
    responseHeaders['X-Frame-Options'] !== 'SAMEORIGIN' ||
    responseHeaders['Referrer-Policy'] !== 'strict-origin-when-cross-origin' ||
    responseHeaders['Content-Security-Policy'] !== expectedCsp
  ) {
    fail('vercel_security_headers_invalid');
  }
  return { status: 'passed', checkedAssets: [...assets].sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateStaticSite(process.cwd())
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
