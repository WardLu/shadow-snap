import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hashReleaseConfig,
  loadReleaseConfig,
  validateReleaseConfig,
} from '../../scripts/release/config.mjs';
import { validateStaticSite } from '../../scripts/validate-static-site.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('loads the exact Shadow Snap production allowlist', async () => {
  const config = await loadReleaseConfig(repoRoot);
  assert.equal(config.repository, 'WardLu/shadow-snap');
  assert.equal(config.productionBranch, 'production');
  assert.deepEqual(config.vercel, {
    cliVersion: '50.28.0',
    teamId: 'team_yq83S2zZ3jAfc1JBRuU31M1I',
    projectId: 'prj_xaFMwRtRpFr9K6tWtcnaDlZax8Ie',
    projectName: 'shadow-snap',
    projectRoot: '.',
    rootDirectory: null,
    vercelJsonPath: 'vercel.json',
    productionBranch: 'production',
    autoAssignCustomDomains: false,
    productionDomains: ['sie.shadow.wang', 'snap.shadow.wang'],
  });
  assert.equal(config.controller.instanceId, '595a8f4b-4bf1-4063-bb92-6b65c23f8e8e');
  assert.match(hashReleaseConfig(config), /^[0-9a-f]{64}$/);
});

test('rejects unknown keys and unsafe paths', async () => {
  const config = JSON.parse(
    await readFile(path.join(repoRoot, 'config/release-production.json'), 'utf8'),
  );
  assert.throws(
    () => validateReleaseConfig({ ...config, token: 'not-allowed' }),
    /release_config_key_unknown:token/,
  );
  assert.throws(
    () =>
      validateReleaseConfig({
        ...config,
        vercel: { ...config.vercel, vercelJsonPath: '../vercel.json' },
      }),
    /vercel_json_path_invalid/,
  );
  assert.throws(
    () =>
      validateReleaseConfig({
        ...config,
        admissionCommands: [['npm', 'ci']],
      }),
    /admission_commands_not_allowlisted/,
  );
});

test('accepts a fixed read-only admission command profile for another repository', async () => {
  const config = JSON.parse(
    await readFile(path.join(repoRoot, 'config/release-production.json'), 'utf8'),
  );
  assert.doesNotThrow(() =>
    validateReleaseConfig({
      ...config,
      repository: 'WardLu/shadow-portal',
      admissionCommands: [
        ['npm', 'ci', '--ignore-scripts'],
        ['npm', 'run', 'lint', '--', '--max-warnings=0'],
        ['npm', 'test', '--', '--runInBand'],
        ['npm', 'run', 'build'],
        ['npm', 'run', 'test:seo:http'],
        ['npm', 'run', 'security:audit'],
        ['npm', 'run', 'release:check'],
        ['npm', 'run', 'supabase:control-plane:check'],
        ['npm', 'run', 'test:release-controller'],
      ],
    }),
  );
});

test('rejects an invalid repository identity', async () => {
  const config = JSON.parse(
    await readFile(path.join(repoRoot, 'config/release-production.json'), 'utf8'),
  );
  assert.throws(
    () => validateReleaseConfig({ ...config, repository: 'WardLu' }),
    /repository_invalid/,
  );
});

test('package scripts expose every release phase without dependencies', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.match(pkg.scripts['test:release-controller'], /shasum -a 256 -c config\/controller-files\.sha256/);
  for (const script of [
    'release:admit',
    'release:adopt',
    'release:initialize',
    'release:stage',
    'release:promote',
    'release:rollback',
    'release:resume',
    'release:recover',
    'release:renew',
    'release:audit',
    'release:unlock',
    'release:fail',
    'release:anchor-admission',
    'release:install',
    'test:release-controller',
  ]) {
    assert.equal(typeof pkg.scripts[script], 'string', `${script} missing`);
  }
});

test('repository disables Git deployment and has one read-only admission workflow', async () => {
  const vercel = JSON.parse(await readFile(path.join(repoRoot, 'vercel.json'), 'utf8'));
  assert.equal(vercel.git.deploymentEnabled, false);
  const workflow = await readFile(
    path.join(repoRoot, '.github/workflows/release.yml'),
    'utf8',
  );
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /vercel\s+(?:deploy|promote|rollback)|gh\s+release\s+create/);
  await assert.rejects(
    readFile(path.join(repoRoot, '.github/workflows/release-check.yml'), 'utf8'),
    /ENOENT/,
  );
});

test('Shadow Snap static validator requires local assets and disabled Git deployment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shadow-static-'));
  await mkdir(path.join(root, 'public'));
  await writeFile(
    path.join(root, 'index.html'),
    '<title>影瞬 Shadow Snap</title>' +
      '<meta name="description" content="A local browser image tool">' +
      '<meta name="robots" content="index,follow">' +
      '<link rel="canonical" href="https://snap.shadow.wang/">' +
      '<meta property="og:url" content="https://snap.shadow.wang/">' +
      '<meta name="twitter:card" content="summary_large_image">' +
      '<meta name="twitter:image:alt" content="影瞬 Shadow Snap">' +
      '<script id="shadow-snap-structured-data" type="application/ld+json">' +
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        '@id': 'https://snap.shadow.wang/#application',
        name: 'Shadow Snap',
        alternateName: '影瞬',
        url: 'https://snap.shadow.wang/',
        publisher: {
          '@type': 'Organization',
          '@id': 'https://shadow.wang/#organization',
          name: 'Shadow Nexus',
          url: 'https://shadow.wang/',
        },
      }) +
      '</script>' +
      '<link rel="stylesheet" href="style.css"><script src="script.js"></script><img src="public/logo.svg">',
  );
  await writeFile(path.join(root, 'style.css'), 'body {}');
  await writeFile(path.join(root, 'script.js'), 'console.log("ok")');
  await writeFile(path.join(root, 'public/logo.svg'), '<svg/>');
  await writeFile(
    path.join(root, 'robots.txt'),
    'User-agent: *\nAllow: /\nSitemap: https://snap.shadow.wang/sitemap.xml\n',
  );
  await writeFile(
    path.join(root, 'sitemap.xml'),
    '<urlset><url><loc>https://snap.shadow.wang/</loc></url></urlset>',
  );
  await writeFile(
    path.join(root, 'vercel.json'),
    JSON.stringify({
      git: { deploymentEnabled: false },
      headers: [{
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      }],
    }),
  );
  assert.deepEqual(await validateStaticSite(root), {
    status: 'passed',
    checkedAssets: ['public/logo.svg', 'script.js', 'style.css'],
  });
  await writeFile(path.join(root, 'vercel.json'), JSON.stringify({}));
  await assert.rejects(validateStaticSite(root), /vercel_git_deployment_not_disabled/);
});

test('Shadow Snap release admission covers the canonical SEO contract', async () => {
  const html = await readFile(path.join(repoRoot, 'index.html'), 'utf8');
  const sitemap = await readFile(path.join(repoRoot, 'sitemap.xml'), 'utf8');
  const acceptance = JSON.parse(
    await readFile(path.join(repoRoot, 'config/release-production.json'), 'utf8'),
  ).acceptance;
  const structuredDataMatch = html.match(
    /<script id="shadow-snap-structured-data" type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );

  assert.equal(
    acceptance.bodyIncludes,
    '<title data-i18n="page_title">影瞬 Shadow Snap | 电影感字幕长图生成器</title>',
  );
  assert.match(html, new RegExp(acceptance.bodyIncludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /<meta name="twitter:image:alt" content="影瞬 Shadow Snap">/);
  assert.deepEqual(
    [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1]),
    ['https://snap.shadow.wang/'],
  );
  assert.deepEqual(JSON.parse(structuredDataMatch?.[1] ?? ''), {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    '@id': 'https://snap.shadow.wang/#application',
    name: 'Shadow Snap',
    alternateName: '影瞬',
    url: 'https://snap.shadow.wang/',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web',
    isAccessibleForFree: true,
    description: 'Create cinematic long images with subtitles from a still image and a line of text.',
    publisher: {
      '@type': 'Organization',
      '@id': 'https://shadow.wang/#organization',
      name: 'Shadow Nexus',
      url: 'https://shadow.wang/',
    },
  });
});
