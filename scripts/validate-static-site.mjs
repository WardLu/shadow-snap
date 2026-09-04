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
  const robots = await readFile(path.join(repoRoot, 'robots.txt'), 'utf8').catch(() => fail('static_robots_missing'));
  const sitemap = await readFile(path.join(repoRoot, 'sitemap.xml'), 'utf8').catch(() => fail('static_sitemap_missing'));
  const assets = new Set();
  const pattern = /\b(?:src|href)=["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const asset = localAsset(match[1]);
    if (asset) assets.add(asset);
  }
  for (const asset of assets) {
    await access(path.join(repoRoot, asset)).catch(() => fail(`static_asset_missing:${asset}`));
  }

  const requiredHtml = [
    '<meta name="description"',
    '<meta name="robots" content="index,follow">',
    '<link rel="canonical" href="https://snap.shadow.wang/">',
    '<meta property="og:url" content="https://snap.shadow.wang/">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:image:alt" content="影瞬 Shadow Snap">',
    '<script id="shadow-snap-structured-data" type="application/ld+json">',
  ];
  if (requiredHtml.some((snippet) => !html.includes(snippet))) {
    fail('static_seo_metadata_missing');
  }
  if (robots !== 'User-agent: *\nAllow: /\nSitemap: https://snap.shadow.wang/sitemap.xml\n') {
    fail('static_robots_invalid');
  }
  const sitemapLocations = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1]);
  if (sitemapLocations.length !== 1 || sitemapLocations[0] !== 'https://snap.shadow.wang/') {
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
  if (
    structuredData?.['@context'] !== 'https://schema.org' ||
    structuredData?.['@type'] !== 'WebApplication' ||
    structuredData?.name !== 'Shadow Snap' ||
    structuredData?.alternateName !== '影瞬' ||
    structuredData?.url !== 'https://snap.shadow.wang/' ||
    structuredData?.['@id'] !== 'https://snap.shadow.wang/#application' ||
    structuredData?.publisher?.['@id'] !== 'https://shadow.wang/#organization' ||
    structuredData?.publisher?.name !== 'Shadow Nexus' ||
    structuredData?.publisher?.url !== 'https://shadow.wang/'
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
