import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createPreviewServer } from '../../scripts/preview-static-site.mjs';
import { LOCALES, SEO } from '../../seo-content.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function startPreview(t) {
  const server = await createPreviewServer(root);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('loopback preview serves both locales with production CSP and refuses internal files', async (t) => {
  const base = await startPreview(t);
  for (const route of ['/', '/en/', '/llms.txt', '/translations.mjs', '/seo-content.mjs']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
    if (route.endsWith('.mjs')) assert.equal(response.headers.get('content-type'), 'text/javascript');
    if (route === '/llms.txt') assert.equal(response.headers.get('content-type'), 'text/plain');
  }
  for (const route of ['/.env.seo.local', '/config/release-production.json', '/scripts/seo/generate-localized-pages.mjs', '/public/../config/release-production.json', '/public/%2e%2e/config/release-production.json']) {
    assert.equal((await fetch(base + route)).status, 404);
  }
  const redirect = await fetch(base + '/en', { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/en/');
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
});

test('loopback preview serves every locale page and redirects bare locale prefixes', async (t) => {
  const base = await startPreview(t);
  for (const locale of LOCALES) {
    const response = await fetch(base + SEO[locale].path);
    assert.equal(response.status, 200, `${locale} status`);
    assert.ok((await response.text()).includes(`<html lang="${SEO[locale].lang}" dir="${SEO[locale].dir}">`), `${locale} markup`);
  }
  const redirect = await fetch(base + '/ja', { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/ja/');
});

test('unmatched routes and internal paths answer 404 with the static 404 page, never the repository', async (t) => {
  const base = await startPreview(t);
  for (const route of ['/ja/not-a-page', '/not-a-page', '/404.html', '/scripts/', '/public/']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 404, `${route} status`);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const body = await response.text();
    assert.match(body, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(body, /release-production|generate-localized-pages/);
  }
});
