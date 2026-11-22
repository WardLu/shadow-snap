import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { LOCALES, SEO } from '../../../seo-content.mjs';
import { loadConfig, verify } from '../../../scripts/fonts/vendor-fontsource.mjs';
import { siteArtifactManifest } from '../../../scripts/seo/site-artifact-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const config = loadConfig(root, 'config/fonts.json');
const cssHref = `href="${config.urlBase}/${path.posix.relative(config.outDir, config.cssFile)}"`;
const pages = [...LOCALES.map((locale) => `${SEO[locale].path.slice(1)}index.html`), '404.html'];
const localSubsets = config.localSubsets ?? [];

test('自托管字体与 config/fonts.json、fonts.lock.json 一致', () => {
  assert.deepEqual(verify({ config }), []);
});

test('页面不请求 Google Fonts，每个语言页都引用本地 fonts.css', () => {
  assert.deepEqual(pages.filter((file) => /fonts\.(googleapis|gstatic)\.com/.test(read(file))), []);
  // 404 页只用 style.css，从未加载 Web 字体。
  assert.deepEqual(pages.filter((file) => file !== '404.html' && !read(file).includes(cssHref)), []);
});

test('CSP 只允许同域样式与字体', () => {
  const headers = JSON.parse(read('vercel.json')).headers[0].headers;
  const csp = headers.find(({ key }) => key === 'Content-Security-Policy').value;
  assert.match(csp, /(?:^|; )style-src 'self';/);
  assert.match(csp, /(?:^|; )font-src 'self';/);
  assert.doesNotMatch(csp, /fonts\.(googleapis|gstatic)\.com/);
});

test('字体目录随站点上传：根目录部署、urlBase 对应 outDir，且未被 .vercelignore 排除', () => {
  assert.equal(JSON.parse(read('vercel.json')).outputDirectory, '.');
  assert.equal(config.urlBase, `/${config.outDir}`);
  // 用 Git 的忽略规则判定（任意层级、通配、! 否定和规则顺序都按 gitignore 语义），列出被 .vercelignore 排除的字体文件；
  // --others 同时覆盖尚未提交的文件。
  const excluded = execFileSync('git', ['ls-files', '--cached', '--others', '--ignored', '--exclude-from=.vercelignore', '--', config.outDir],
    { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(excluded, []);
});

test('字体选项的首选家族都由本地字体提供', () => {
  const select = read('index.html').match(/<select[^>]*id="font-family"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';
  const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(values.length >= 6, `expected the font options, found ${values.length}`);
  const families = new Set([...config.fonts.map((font) => font.family), ...localSubsets.map((font) => font.family)]);
  const primary = values.map((value) => value.split(',')[0].trim().replace(/^['"]|['"]$/g, ''));
  assert.deepEqual(primary.filter((family) => !families.has(family)), []);
});

test('CJK 子集体积与引用受控', () => {
  assert.ok(localSubsets.length > 0);
  for (const subset of localSubsets) {
    const absolute = path.join(root, subset.file);
    assert.ok(statSync(absolute).size <= subset.maxBytes, `${subset.file} exceeds ${subset.maxBytes} bytes`);
    const css = read(subset.cssFile);
    assert.ok(css.includes(`/${subset.file}`), `${subset.cssFile} does not reference ${subset.file}`);
    assert.ok(read('index.html').includes(`href="/${subset.cssFile}"`), 'index.html does not load the local subset CSS');
  }
  assert.doesNotMatch(read(config.cssFile), /noto-sans-sc/);
});

test('发布逐字节清单包含 fonts.css 与锁定的每个 WOFF2', async () => {
  const files = new Set((await siteArtifactManifest(root)).map(({ file }) => file));
  assert.ok(files.has(config.cssFile));
  const lock = JSON.parse(read(path.posix.join(config.outDir, 'fonts.lock.json')));
  const fonts = lock.packages.flatMap((item) => Object.keys(item.files)).filter((rel) => rel.endsWith('.woff2'))
    .map((rel) => path.posix.join(config.outDir, rel));
  assert.ok(fonts.length > 0);
  assert.deepEqual(fonts.filter((file) => !files.has(file)), []);
});
