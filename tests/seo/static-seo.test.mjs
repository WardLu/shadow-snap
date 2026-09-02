import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('静态站点提供可索引的 SEO 基座', async () => {
  const html = await readFile(path.join(repoRoot, 'index.html'), 'utf8');
  const robots = await readFile(path.join(repoRoot, 'robots.txt'), 'utf8');
  const sitemap = await readFile(path.join(repoRoot, 'sitemap.xml'), 'utf8');

  assert.match(html, /<title data-i18n="page_title">影瞬 Shadow Snap \| 电影感字幕长图生成器<\/title>/);
  assert.match(html, /<meta name="description" content="影瞬 Shadow Snap：把图片和一句台词接成电影感长图。纯浏览器本地处理，不上传图片或文本。">/);
  assert.match(html, /<meta name="robots" content="index,follow">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/snap\.shadow\.wang\/">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/snap\.shadow\.wang\/">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta name="twitter:image:alt" content="影瞬 Shadow Snap">/);

  const structuredData = html.match(
    /<script id="shadow-snap-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  assert.ok(structuredData, '缺少 Shadow Snap JSON-LD');
  assert.deepEqual(JSON.parse(structuredData[1]), {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Shadow Snap',
    alternateName: '影瞬',
    url: 'https://snap.shadow.wang/',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web',
    isAccessibleForFree: true,
    description: 'Create cinematic long images with subtitles from a still image and a line of text.',
    provider: {
      '@type': 'Organization',
      name: 'Shadow.Nexus',
      url: 'https://shadow.wang/zh',
    },
  });

  assert.match(robots, /^User-agent: \*\nAllow: \/\nSitemap: https:\/\/snap\.shadow\.wang\/sitemap\.xml\n$/);
  const locations = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locations, ['https://snap.shadow.wang/']);
});
