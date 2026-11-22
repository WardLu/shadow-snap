import path from 'node:path';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateStaticSite } from '../validate-static-site.mjs';
import { localizedOutputs } from './generate-localized-pages.mjs';

const MEDIA_TYPES = {
  '.html': ['text/html'], '.css': ['text/css'],
  '.js': ['text/javascript', 'application/javascript'],
  '.mjs': ['text/javascript', 'application/javascript'],
  '.xml': ['application/xml', 'text/xml'], '.txt': ['text/plain'],
  '.svg': ['image/svg+xml'], '.png': ['image/png'],
  '.ico': ['image/x-icon', 'image/vnd.microsoft.icon'],
  '.woff2': ['font/woff2'],
};

// Consume the validated page/asset graph, never maintain a second locale allowlist.
export async function siteArtifactManifest(repoRoot) {
  const { checkedAssets } = await validateStaticSite(repoRoot);
  const files = new Set([...Object.keys(await localizedOutputs(repoRoot)), 'robots.txt', 'llms.txt', '48b940e4f0d740df98a9d1bb83060fc7.txt']);
  for (const asset of checkedAssets) {
    const info = await stat(path.join(repoRoot, asset));
    files.add(info.isDirectory() ? path.posix.join(asset, 'index.html') : asset);
  }
  return [...files].sort().map((file) => {
    if (!/^[\w./-]+$/.test(file) || file.startsWith('/') || file.split('/').includes('..')) throw new Error('site_manifest_path_invalid');
    const mediaTypes = MEDIA_TYPES[path.extname(file)];
    if (!mediaTypes) throw new Error(`site_manifest_media_type_unknown:${file}`);
    const route = file === 'index.html' ? '/' : file.endsWith('/index.html') ? `/${file.slice(0, -10)}` : `/${file}`;
    return { file, route, mediaTypes };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const { file, route, mediaTypes } of await siteArtifactManifest(process.cwd())) {
    console.log([file, route, mediaTypes.join(',')].join('\t'));
  }
}
