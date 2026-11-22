import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReleaseConfig, readValue, validateReleaseConfig } from '../../scripts/release/release-config.mjs';
import { admissionEnvironment } from '../../scripts/release/run-admission-commands.mjs';
import { validateStaticSite } from '../../scripts/validate-static-site.mjs';
import { LOCALES, SEO } from '../../seo-content.mjs';
 import { copySite } from '../seo/site-copy.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readConfig = async () =>
  JSON.parse(await readFile(path.join(repoRoot, 'config/release-production.json'), 'utf8'));

test('loads the Shadow Snap production identity', () => {
  const config = loadReleaseConfig(repoRoot);
  assert.equal(config.productionBranch, 'production');
  assert.equal(readValue(config, 'vercel.teamId'), 'team_yq83S2zZ3jAfc1JBRuU31M1I');
  assert.equal(readValue(config, 'vercel.projectId'), 'prj_xaFMwRtRpFr9K6tWtcnaDlZax8Ie');
  assert.equal(readValue(config, 'vercel.productionDomains'), 'sie.shadow.wang\nsnap.shadow.wang');
  assert.equal(readValue(config, 'acceptance.requiredHeaders'), 'content-type\nstrict-transport-security');
});

test('release config fails closed on missing or malformed values', async () => {
  const config = await readConfig();
  assert.throws(() => validateReleaseConfig({ ...config, productionBranch: '' }), /release_config_branch_invalid/);
  assert.throws(
    () => validateReleaseConfig({ ...config, vercel: { ...config.vercel, productionDomains: [] } }),
    /release_config_domains_missing/,
  );
  assert.throws(
    () => validateReleaseConfig({ ...config, acceptance: { ...config.acceptance, requiredHeaders: ['Bad Header'] } }),
    /release_config_headers_invalid/,
  );
  assert.throws(
    () => validateReleaseConfig({ ...config, acceptance: { ...config.acceptance, verifyFiles: [] } }),
    /release_config_verify_files_unsupported/,
  );
  assert.throws(() => validateReleaseConfig({ ...config, admissionCommands: [[]] }), /release_config_admission_invalid/);
  assert.throws(() => readValue(config, 'controller.instanceId'), /release_config_key_unknown/);
});

test('admission commands run without caller credentials', () => {
  const env = admissionEnvironment(
    { PATH: '/bin', LANG: 'C', VERCEL_TOKEN: 'secret', NPM_TOKEN: 'secret', HOME: '/Users/me' },
    '/tmp/empty-home',
  );
  assert.deepEqual(env, { CI: '1', PATH: '/bin', LANG: 'C', HOME: '/tmp/empty-home' });
});

test('release flow is the single deploy script plus the local CI gate', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.deepEqual(
    Object.keys(pkg.scripts).filter((name) => name.startsWith('release:')),
    ['release:production'],
  );
  assert.equal(pkg.scripts.ci, 'node scripts/ci/local-ci.mjs run');
  assert.equal(pkg.scripts['ci:check'], 'node scripts/ci/local-ci.mjs check');
  const config = await readConfig();
  assert.equal(config.controller, undefined);
  assert.ok(!JSON.stringify(config.admissionCommands).includes('controller'));
  for (const removed of ['scripts/release/cli.mjs', 'config/controller-files.sha256', '.github/workflows/release.yml', 'scripts/ci/record-local-ci.mjs']) {
    await assert.rejects(access(path.join(repoRoot, removed)), /ENOENT/, `${removed} should stay removed`);
  }
});

test('repository disables Vercel Git deployment', async () => {
  const vercel = JSON.parse(await readFile(path.join(repoRoot, 'vercel.json'), 'utf8'));
  assert.equal(vercel.git.deploymentEnabled, false);
});

test('Shadow Snap static validator requires local assets and disabled Git deployment', async () => {
  const root = await copySite(repoRoot, 'shadow-static-');
  assert.equal((await validateStaticSite(root)).status, 'passed');
  const checked = (await validateStaticSite(root)).checkedAssets;
  for (const asset of ['.', 'not-found.mjs', 'script.js', 'style.css', 'translations.mjs', 'seo-content.mjs', 'ja/', 'ar/', 'zh-hant/', 'public/brand_assets/shadow_snap.svg']) {
    assert.ok(checked.includes(asset), `validator tracks ${asset}`);
  }
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
    '<title data-i18n="page_title">影瞬 Shadow Snap | 免费电影感字幕长图与台词拼图生成器</title>',
  );
  assert.match(html, new RegExp(acceptance.bodyIncludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /<meta name="twitter:image:alt" content="影瞬 Shadow Snap">/);
  assert.deepEqual(
    [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((match) => match[1]),
    LOCALES.map((locale) => SEO[locale].url),
  );
  assert.deepEqual(JSON.parse(structuredDataMatch?.[1] ?? ''), {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    '@id': 'https://snap.shadow.wang/#application',
    name: 'Shadow Snap',
    alternateName: '影瞬',
    url: 'https://snap.shadow.wang/',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Web, iOS, Android, macOS, Windows',
    browserRequirements: 'Requires modern web browser with HTML5 Canvas support',
    softwareVersion: JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version,
    isAccessibleForFree: true,
    description: SEO.zh.description,
    image: 'https://snap.shadow.wang/public/brand_assets/og_shadow_snap.png',
    featureList: SEO.zh.features,
    offers: {
      '@type': 'Offer',
      name: 'Free',
      price: '0',
      priceCurrency: 'USD',
      url: 'https://snap.shadow.wang/',
    },
    author: {
      '@id': 'https://wardlu.com/#ward',
    },
    publisher: {
      '@type': 'Organization',
      '@id': 'https://shadow.wang/#organization',
      name: 'Shadow Lab',
      url: 'https://shadow.wang',
    },
    inLanguage: 'zh-CN',
  });
});
