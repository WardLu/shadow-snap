import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateStaticSite } from './validate-static-site.mjs';
import { LOCALES, SEO } from '../seo-content.mjs';

// Never serve the repository root as a directory, even on localhost. Locale pages come from the locale list, not a second allowlist.
const SITE_FILES = new Set([
  ...LOCALES.map((locale) => `${SEO[locale].path}index.html`),
  '/style.css', '/script.js', '/locale-redirect.js', '/not-found.mjs', '/translations.mjs', '/seo-content.mjs', '/robots.txt', '/sitemap.xml', '/llms.txt', '/48b940e4f0d740df98a9d1bb83060fc7.txt', '/favicon.ico',
]);
const LOCALE_REDIRECTS = new Map(LOCALES.filter((locale) => locale !== 'zh').map((locale) => [SEO[locale].path.slice(0, -1), SEO[locale].path]));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.xml': 'application/xml', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

export async function createPreviewServer(repoRoot) {
  const root = await realpath(repoRoot);
  const config = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'));
  const security = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
  // Same static 404 as production, served with status 404 for every unmatched route; read per request so regenerated output shows at once.
  const serveNotFound = async (response, method) => {
    const body = await readFile(path.join(root, '404.html'));
    response.writeHead(404, { ...security, 'Cache-Control': 'no-store', 'Content-Type': TYPES['.html'] });
    response.end(method === 'HEAD' ? undefined : body);
  };
  return createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (LOCALE_REDIRECTS.has(pathname)) { response.writeHead(308, { Location: LOCALE_REDIRECTS.get(pathname) }).end(); return; }
      // Preview must not transmit analytics or emulate production measurements.
      if (pathname === '/_vercel/insights/script.js') {
        response.writeHead(200, { ...security, 'Content-Type': 'text/javascript' }).end('// Analytics disabled in local preview.'); return;
      }
      const file = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
      if ((!SITE_FILES.has(file) && !/^\/public\/[\w./-]+$/.test(file)) || file.split('/').includes('..') || file.split('/').some((segment) => segment.startsWith('.'))) {
        await serveNotFound(response, request.method); return;
      }
      const resolved = await realpath(path.join(root, file));
      if (!resolved.startsWith(root + path.sep)) { await serveNotFound(response, request.method); return; }
      const body = await readFile(resolved);
      response.writeHead(200, { ...security, 'Cache-Control': 'no-store', 'Content-Type': TYPES[path.extname(resolved)] ?? 'application/octet-stream' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      await serveNotFound(response, request.method);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await validateStaticSite(process.cwd());
  const server = await createPreviewServer(process.cwd());
  server.listen(Number(process.env.PREVIEW_PORT ?? 3187), '127.0.0.1', () => console.log(`Local preview: http://127.0.0.1:${server.address().port} (site files only; analytics disabled)`));
}
