// Test helper (not a test file): copies the generated site into a temp root so falsification tests can mutate it.
// Every temp root created here is removed when the test process exits, including after a failed assertion.
import { cp, mkdtemp } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCALES, SEO } from '../../seo-content.mjs';

export const SITE_ENTRIES = [
  'index.html', '404.html', 'sitemap.xml', 'robots.txt', 'llms.txt', '48b940e4f0d740df98a9d1bb83060fc7.txt', 'style.css', 'script.js', 'locale-redirect.js', 'translations.mjs',
  'seo-content.mjs', 'not-found.mjs', 'favicon.ico', 'vercel.json', 'public',
  ...LOCALES.filter((locale) => locale !== 'zh').map((locale) => SEO[locale].path.slice(1, -1)),
];

const createdRoots = [];
process.once('exit', () => {
  for (const dir of createdRoots) rmSync(dir, { recursive: true, force: true });
});

export async function tempRoot(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdRoots.push(dir);
  return dir;
}

export async function copySite(repoRoot, prefix = 'snap-site-') {
  const root = await tempRoot(prefix);
  for (const entry of SITE_ENTRIES) {
    await cp(path.join(repoRoot, entry), path.join(root, entry), { recursive: true });
  }
  return root;
}
