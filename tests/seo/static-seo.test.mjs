import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LOCALES, SEO, escapeHtml, hreflangEntries } from '../../seo-content.mjs';
import { checkLocalizedPages, renderPage } from '../../scripts/seo/generate-localized-pages.mjs';
import { expectedContentSecurityPolicy, validateStaticSite } from '../../scripts/validate-static-site.mjs';
import { copySite } from './site-copy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pagePath = (locale) => path.join(repoRoot, `${SEO[locale].path.slice(1)}index.html`);

test('静态站点提供可索引的 SEO 基座', async () => {
  const html = await readFile(path.join(repoRoot, 'index.html'), 'utf8');
  const robots = await readFile(path.join(repoRoot, 'robots.txt'), 'utf8');
  const sitemap = await readFile(path.join(repoRoot, 'sitemap.xml'), 'utf8');
  const vercel = JSON.parse(await readFile(path.join(repoRoot, 'vercel.json'), 'utf8'));

  assert.match(html, /<title data-i18n="page_title">影瞬 Shadow Snap \| 免费电影感字幕长图与台词拼图生成器<\/title>/);
  assert.ok(html.includes(`<meta name="description" content="${SEO.zh.description}">`));
  assert.match(html, /<meta name="robots" content="index,follow">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/snap\.shadow\.wang\/">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/snap\.shadow\.wang\/">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta name="twitter:image:alt" content="影瞬 Shadow Snap">/);
  assert.match(html, /<h1 data-i18n="header_title">.*影瞬 Shadow Snap<\/h1>/);
  assert.match(html, /<script defer src="\/_vercel\/insights\/script\.js"[^>]*><\/script>/);

  const structuredData = html.match(
    /<script id="shadow-snap-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  assert.ok(structuredData, '缺少 Shadow Snap JSON-LD');
  const pkgVersion = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;
  assert.deepEqual(JSON.parse(structuredData[1]), {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    '@id': 'https://snap.shadow.wang/#application',
    name: 'Shadow Snap',
    alternateName: '影瞬',
    url: 'https://snap.shadow.wang/',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web, iOS, Android, macOS, Windows',
    browserRequirements: 'Requires modern web browser with HTML5 Canvas support',
    softwareVersion: pkgVersion,
    isAccessibleForFree: true,
    description: SEO.zh.description,
    image: 'https://snap.shadow.wang/public/brand_assets/og_shadow_snap.png',
    featureList: SEO.zh.features,
    offers: {
      '@type': 'Offer',
      name: 'Free',
      price: '0',
      priceCurrency: 'USD',
      url: 'https://snap.shadow.wang/',
    },
    author: {
      '@id': 'https://wardlu.com/#ward',
    },
    publisher: {
      '@type': 'Organization',
      '@id': 'https://shadow.wang/#organization',
      name: 'Shadow Lab',
      url: 'https://shadow.wang',
    },
    inLanguage: 'zh-CN',
  });
  const geoGraph = JSON.parse(html.match(/id="shadow-snap-geo-data" type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal((geoGraph['@graph'] ?? []).filter((node) => node['@type'] === 'WebApplication').length, 0);

  const headers = Object.fromEntries(vercel.headers[0].headers.map(({ key, value }) => [key, value]));
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['Content-Security-Policy'], expectedContentSecurityPolicy(html));
  const badges = [...(html.match(/<nav class="featured-on"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '').matchAll(/<a\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(badges.length > 0);
  for (const anchor of badges) {
    assert.match(anchor, /rel="noopener noreferrer"/);
    assert.doesNotMatch(anchor, /nofollow/);
  }
  assert.doesNotMatch(headers['Content-Security-Policy'], /img-src[^;]*(\*|http:)/);

  assert.equal(robots, 'User-agent: *\nAllow: /\n\nUser-agent: Yandex\nAllow: /\nClean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term\n\nSitemap: https://snap.shadow.wang/sitemap.xml\n');
  const indexNowKey = await readFile(path.join(repoRoot, '48b940e4f0d740df98a9d1bb83060fc7.txt'), 'utf8');
  assert.equal(indexNowKey.trim(), '48b940e4f0d740df98a9d1bb83060fc7');
  const llms = await readFile(path.join(repoRoot, 'llms.txt'), 'utf8');
  assert.match(llms, /^# Shadow Snap\n/);
  for (const locale of LOCALES) {
    assert.ok(llms.includes(SEO[locale].url), `llms.txt should list ${SEO[locale].url}`);
  }
  const locations = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locations, LOCALES.map((locale) => SEO[locale].url));
});

test('badge CSP admits only https badge hosts and rejects remote images elsewhere', async () => {
  const nav = (body) => `<nav class="featured-on" aria-label="x">${body}</nav>`;
  const csp = expectedContentSecurityPolicy(nav('<a href="https://a.example/p"><img src="https://img.a.example/b.svg" alt="A"></a><a href="https://b.example"><img src="https://img.a.example/c.svg" alt="B"></a>'));
  assert.match(csp, /img-src 'self' data: blob: https:\/\/img\.a\.example; /);
  assert.match(expectedContentSecurityPolicy('<main><img src="/public/x.png" alt=""></main>'), /img-src 'self' data: blob:; /);
  assert.throws(() => expectedContentSecurityPolicy(nav('<img src="http://a.example/b.svg" alt="A">')), /static_badge_src_invalid/);
  assert.throws(() => expectedContentSecurityPolicy(nav('<img src=\'https://a.example/b.svg\' alt="A">')), /static_badge_src_invalid/);
  assert.throws(() => expectedContentSecurityPolicy(`${nav('')}<img src="https://cdn.example/x.png" alt="">`), /static_remote_image_outside_badges/);

  const zhNav = (await readFile(pagePath('zh'), 'utf8')).match(/<nav class="featured-on"[\s\S]*?<\/nav>/)[0];
  const enNav = (await readFile(pagePath('en'), 'utf8')).match(/<nav class="featured-on"[\s\S]*?<\/nav>/)[0];
  const hrefs = (block) => [...block.matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(hrefs(enNav), hrefs(zhNav));
});

test('every locale exposes complete HTML, self canonicals, the full hreflang set and matching FAQ facts without JavaScript', async () => {
  for (const locale of LOCALES) {
    const html = await readFile(pagePath(locale), 'utf8');
    const seo = SEO[locale];
    assert.ok(html.includes(`<html lang="${seo.lang}" dir="${seo.dir}">`), `${locale} lang and dir`);
    assert.ok(html.includes(`<link rel="canonical" href="${seo.url}">`), `${locale} canonical`);
    const alternates = [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((match) => [match[1], match[2]]);
    assert.deepEqual(alternates, hreflangEntries(), `${locale} hreflang set`);
    const guide = html.match(/<details id="product-guide"[^>]*>([\s\S]*?)<\/details>/)?.[1];
    assert.ok(guide && !guide.includes('sr-only'), 'FAQ must be user-readable, not hidden marketing');
    const graph = JSON.parse(html.match(/id="shadow-snap-geo-data" type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const faq = graph['@graph'].find((node) => node['@type'] === 'FAQPage');
    assert.equal(faq.inLanguage, seo.lang);
    assert.equal(faq['@id'], `${seo.url}#faq`);
    assert.equal(faq.mainEntity.length, seo.faq.length);
    for (const question of faq.mainEntity) {
      assert.ok(guide.includes(escapeHtml(question.name)));
      assert.ok(guide.includes(escapeHtml(question.acceptedAnswer.text)));
    }
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    assert.ok(html.includes('type="module" src="/script.js"'));
    assert.ok(html.includes(`data-product-link href="https://shadow.wang/${locale}/products/shadow-snap"`));
  }
});

test('sitemap is a reciprocal cluster of every locale and generated pages cannot drift', async () => {
  await checkLocalizedPages(repoRoot);
  const sitemap = await readFile(path.join(repoRoot, 'sitemap.xml'), 'utf8');
  const blocks = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)];
  assert.equal(blocks.length, LOCALES.length);
  for (const block of blocks) {
    const alternates = [...block[1].matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((match) => [match[1], match[2]]);
    assert.deepEqual(alternates, hreflangEntries());
  }
});

test('generated-output gate rejects a stale English FAQ, a missing English page and a missing 404 page', async () => {
  const root = await copySite(repoRoot, 'snap-locale-regression-');
  await checkLocalizedPages(root);
  const english = await readFile(path.join(root, 'en/index.html'), 'utf8');
  await writeFile(path.join(root, 'en/index.html'), english.replace('What is Shadow Snap?', 'Stale question'));
  await assert.rejects(checkLocalizedPages(root), /localized_output_stale:en\/index.html/);
  await writeFile(path.join(root, 'en/index.html'), english);
  await checkLocalizedPages(root);
  await rm(path.join(root, 'ja/index.html'));
  await assert.rejects(checkLocalizedPages(root), /localized_output_stale:ja\/index.html/);
  await writeFile(path.join(root, 'ja/index.html'), renderPage(await readFile(path.join(repoRoot, 'index.html'), 'utf8'), 'ja'));
  await rm(path.join(root, '404.html'));
  await assert.rejects(checkLocalizedPages(root), /localized_output_stale:404.html/);
});

test('generation and release admission fail closed when the guide or FAQ schema is deleted', async () => {
  const template = await readFile(path.join(repoRoot, 'index.html'), 'utf8');
  const noGuide = template.replace(/<details id="product-guide"[\s\S]*?<\/details>/, '');
  assert.throws(() => renderPage(noGuide, 'en'), /locale_template_required_node:product-guide/);
  const noSchema = template.replace(/<script id="shadow-snap-geo-data"[\s\S]*?<\/script>/, '');
  assert.throws(() => renderPage(noSchema, 'en'), /locale_template_required_node:faq-schema/);
  const noFaq = template.replace(/(<script id="shadow-snap-geo-data"[^>]*>)([\s\S]*?)(<\/script>)/, (_, open, json, close) => {
    const graph = JSON.parse(json);
    graph['@graph'] = graph['@graph'].filter((node) => node['@type'] !== 'FAQPage');
    return open + JSON.stringify(graph) + close;
  });
  assert.throws(() => renderPage(noFaq, 'en'), /locale_template_faq_missing/);
  const root = await copySite(repoRoot, 'snap-missing-guide-');
  await writeFile(path.join(root, 'index.html'), noGuide);
  await assert.rejects(validateStaticSite(root), /locale_template_required_node:product-guide/);
  await writeFile(path.join(root, 'index.html'), noFaq);
  await assert.rejects(validateStaticSite(root), /locale_template_faq_missing/);
});
