import assert from 'node:assert/strict';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { TRANS } from '../../translations.mjs';
import { DEFAULT_LOCALE, LOCALES, SEO, hreflangEntries, notFoundLocaleFromPath, ogAlternateLocales } from '../../seo-content.mjs';
import { renderNotFound } from '../../scripts/seo/generate-localized-pages.mjs';
import { assertNotFoundPage, validateStaticSite } from '../../scripts/validate-static-site.mjs';
import { siteArtifactManifest } from '../../scripts/seo/site-artifact-manifest.mjs';
import { copySite, tempRoot } from './site-copy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pagePath = (locale) => path.join(repoRoot, `${SEO[locale].path.slice(1)}index.html`);
// Han ideographs, Kana excluded: the check targets Chinese script leaking into non-Chinese pages.
const HAN = /\p{Script=Han}/u;

test('the twelve locales are the Portal set with the routes and direction the brief fixes', () => {
  assert.deepEqual(LOCALES, ['zh', 'en', 'zh-hant', 'ja', 'ko', 'es', 'pt', 'fr', 'de', 'ru', 'id', 'ar']);
  assert.equal(SEO.zh.path, '/');
  assert.equal(SEO.en.path, '/en/');
  assert.equal(SEO['zh-hant'].path, '/zh-hant/');
  assert.equal(SEO.ar.dir, 'rtl');
  assert.equal(SEO.zh.dir, 'ltr');
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.deepEqual(SEO['zh-hant'].hreflang, ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO']);
  assert.equal(SEO.pt.lang, 'pt-BR');
  assert.equal(hreflangEntries().at(-1)[0], 'x-default');
  assert.equal(hreflangEntries().at(-1)[1], SEO.en.url);
  assert.equal(ogAlternateLocales('ja').length, LOCALES.length - 1);
});

test('a locale that drops a UI key fails the completeness gate', async () => {
  const dir = await tempRoot('snap-locale-keys-');
  await copyFile(path.join(repoRoot, 'translations.mjs'), path.join(dir, 'translations.mjs'));
  await copyFile(path.join(repoRoot, 'seo-content.mjs'), path.join(dir, 'seo-content.mjs'));
  const text = await readFile(path.join(dir, 'translations.mjs'), 'utf8');
  const ja = text.indexOf('\n  ja: {');
  const keyStart = text.indexOf('\n      footer_heading: ', ja);
  assert.ok(ja > 0 && keyStart > ja, 'ja footer_heading line located');
  const keyEnd = text.indexOf('\n', keyStart + 1);
  await writeFile(path.join(dir, 'translations.mjs'), text.slice(0, keyStart) + text.slice(keyEnd));
  const mutated = await import(pathToFileURL(path.join(dir, 'seo-content.mjs')).href);
  assert.throws(() => mutated.assertLocaleCompleteness(), /locale_key_missing:ja:footer_heading/);
  await rm(dir, { recursive: true });
});

test('every locale page carries its own lang and dir, the full hreflang set, reciprocal og alternates and a complete switch', async () => {
  for (const locale of LOCALES) {
    const html = await readFile(pagePath(locale), 'utf8');
    const s = SEO[locale];
    assert.ok(html.includes(`<html lang="${s.lang}" dir="${s.dir}">`), `${locale} html lang and dir`);
    const alternates = [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((match) => [match[1], match[2]]);
    assert.deepEqual(alternates, hreflangEntries(), `${locale} hreflang set`);
    assert.ok(html.includes(`<meta property="og:locale" content="${s.ogLocale}">`), `${locale} og:locale`);
    const og = [...html.matchAll(/<meta property="og:locale:alternate" content="([^"]+)">/g)].map((match) => match[1]);
    assert.deepEqual(og, ogAlternateLocales(locale), `${locale} og:locale:alternate set`);
    const select = html.match(/<select id="lang-select"[\s\S]*?<\/select>/)[0];
    assert.deepEqual([...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]), LOCALES, `${locale} switch lists all locales`);
    assert.ok(select.includes(`<option value="${locale}" selected>`), `${locale} switch preselects itself`);
    const guideLinks = [...html.matchAll(/<a href="([^"]+)" hreflang="[^"]+" lang="[^"]+" data-locale="([^"]+)">/g)].map((match) => match[2]);
    assert.deepEqual(guideLinks, LOCALES, `${locale} guide language links`);
  }
});

const visibleBody = (html) => html.split('<body>')[1]
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<select id="lang-select"[\s\S]*?<\/select>/, '')
  .replace(/<p class="locale-links">[\s\S]*?<\/p>/, '');

test('non-Chinese pages carry no Han characters outside the language names', async () => {
  // Japanese uses kanji (Han script), so ja is covered by the verbatim-string check below instead.
  for (const locale of LOCALES.filter((item) => !['zh', 'zh-hant', 'ja'].includes(item))) {
    assert.doesNotMatch(visibleBody(await readFile(pagePath(locale), 'utf8')), HAN, `${locale} body contains Han text`);
  }
});

test('no Chinese source string survives verbatim on a non-Chinese page, including Japanese', async () => {
  for (const locale of LOCALES.filter((item) => !['zh', 'zh-hant'].includes(item))) {
    const body = visibleBody(await readFile(pagePath(locale), 'utf8'));
    for (const [key, chinese] of Object.entries(TRANS.zh)) {
      if (!HAN.test(chinese) || TRANS[locale][key] === chinese) continue;
      assert.ok(!body.includes(chinese), `${locale} still shows Chinese for ${key}`);
    }
  }
});

test('the Arabic page is right-to-left in markup', async () => {
  const html = await readFile(pagePath('ar'), 'utf8');
  assert.ok(html.startsWith('<!DOCTYPE html>\n<html lang="ar" dir="rtl">'));
});

test('sitemap lists every locale once with the same full alternate set', async () => {
  const sitemap = await readFile(path.join(repoRoot, 'sitemap.xml'), 'utf8');
  const urls = [...sitemap.matchAll(/<url>\s*<loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g)];
  assert.deepEqual(urls.map((match) => match[1]), LOCALES.map((locale) => SEO[locale].url));
  for (const match of urls) {
    const alternates = [...match[2].matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)].map((item) => [item[1], item[2]]);
    assert.deepEqual(alternates, hreflangEntries());
  }
});

test('the 404 language follows the path prefix and unprefixed paths are Chinese like the root page', () => {
  assert.equal(notFoundLocaleFromPath('/missing'), 'zh');
  assert.equal(notFoundLocaleFromPath('/a/b/c'), 'zh');
  assert.equal(notFoundLocaleFromPath('/zh/missing'), 'zh');
  assert.equal(notFoundLocaleFromPath('/ja/missing'), 'ja');
  assert.equal(notFoundLocaleFromPath('/zh-hant/x'), 'zh-hant');
  assert.equal(notFoundLocaleFromPath('/ar/x/y'), 'ar');
  assert.equal(notFoundLocaleFromPath('/en'), 'en');
});

test('the static 404 is noindex, English by default, free of inline script and links every locale', async () => {
  const html = await readFile(path.join(repoRoot, '404.html'), 'utf8');
  assert.equal(html, renderNotFound());
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<html lang="en" dir="ltr"/);
  assert.match(html, /<script type="module" src="\/not-found\.mjs"><\/script>/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  for (const locale of LOCALES) assert.ok(html.includes(`data-locale="${locale}"`), `404 links ${locale}`);
});

test('the static 404 gate refuses an inline script, an inline handler and a missing locale link', async () => {
  const html = await readFile(path.join(repoRoot, '404.html'), 'utf8');
  assert.doesNotThrow(() => assertNotFoundPage(html));
  assert.throws(() => assertNotFoundPage(html.replace('</body>', '<script>window.x = 1</script></body>')), /static_404_inline_script/);
  assert.throws(() => assertNotFoundPage(html.replace('<h1', '<h1 onclick="window.x = 1"')), /static_404_inline_script/);
  assert.throws(() => assertNotFoundPage(html.replace(/<a [^>]*data-locale="ja">[^<]*<\/a>/, '')), /static_404_locales_invalid/);
});

test('404.html stays out of the 200 artifact manifest while its module ships', async () => {
  const files = (await siteArtifactManifest(repoRoot)).map((entry) => entry.file);
  assert.ok(!files.includes('404.html'));
  assert.ok(files.includes('not-found.mjs'));
  assert.ok(files.includes('ja/index.html'));
  assert.ok(files.includes('zh-hant/index.html'));
});

test('an inline script added to the 404 page is rejected', async () => {
  const root = await copySite(repoRoot, 'snap-404-inline-');
  const html = await readFile(path.join(root, '404.html'), 'utf8');
  await writeFile(path.join(root, '404.html'), html.replace('</body>', '<script>window.x = 1</script></body>'));
  // The generator guard runs first; both messages mean the tampered 404 is refused.
  await assert.rejects(validateStaticSite(root), /localized_output_stale:404\.html|static_404_inline_script/);
  await rm(root, { recursive: true });
});

test('a 404 whose external module is missing fails the asset check', async () => {
  const root = await copySite(repoRoot, 'snap-404-module-');
  await rm(path.join(root, 'not-found.mjs'));
  await assert.rejects(validateStaticSite(root), /static_asset_missing:not-found\.mjs/);
  await rm(root, { recursive: true });
});
