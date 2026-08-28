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
});

test('package scripts expose every release phase without dependencies', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  for (const script of [
    'release:admit',
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
    '<link rel="stylesheet" href="style.css"><script src="script.js"></script><img src="public/logo.svg">',
  );
  await writeFile(path.join(root, 'style.css'), 'body {}');
  await writeFile(path.join(root, 'script.js'), 'console.log("ok")');
  await writeFile(path.join(root, 'public/logo.svg'), '<svg/>');
  await writeFile(
    path.join(root, 'vercel.json'),
    JSON.stringify({ git: { deploymentEnabled: false } }),
  );
  assert.deepEqual(await validateStaticSite(root), {
    status: 'passed',
    checkedAssets: ['public/logo.svg', 'script.js', 'style.css'],
  });
  await writeFile(path.join(root, 'vercel.json'), JSON.stringify({}));
  await assert.rejects(validateStaticSite(root), /vercel_git_deployment_not_disabled/);
});
