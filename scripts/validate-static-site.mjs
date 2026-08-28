import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(reasonCode) {
  throw new Error(reasonCode);
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
  const normalized = path.posix.normalize(decoded);
  if (normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    fail('static_asset_path_invalid');
  }
  return normalized;
}

export async function validateStaticSite(repoRoot) {
  const html = await readFile(path.join(repoRoot, 'index.html'), 'utf8');
  const assets = new Set();
  const pattern = /\b(?:src|href)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const asset = localAsset(match[1]);
    if (asset) assets.add(asset);
  }
  for (const asset of assets) {
    await access(path.join(repoRoot, asset)).catch(() => fail(`static_asset_missing:${asset}`));
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
