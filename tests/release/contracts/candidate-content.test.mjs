import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { siteArtifactManifest } from '../../../scripts/seo/site-artifact-manifest.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(path.join(repoRoot, 'scripts/release/deploy-production.sh'), 'utf8');
const functions = readFileSync(path.join(repoRoot, 'scripts/release/site-content-functions.sh'), 'utf8');
const precheck = source.slice(source.indexOf('echo "👉 部署预检:'), source.indexOf('# ------------------------------------------------------------------------------', source.indexOf('echo "👉 部署预检:')));
const check = 'fail() { echo "❌ $*" >&2; exit 1; }\n' + functions + '\n' + precheck;
const manifest = await siteArtifactManifest(repoRoot);
const manifestTsv = manifest.map(({ file, route, mediaTypes }) => [file, route, mediaTypes.join(',')].join('\t')).join('\n');

test('manifest consumes generated pages, imported modules, sitemap and branding', () => {
  assert.ok(source.includes('. "$ROOT_DIR/scripts/release/site-content-functions.sh"'));
  const files = manifest.map(({ file }) => file);
  for (const file of ['index.html', 'en/index.html', 'script.js', 'translations.mjs', 'seo-content.mjs', 'sitemap.xml', 'robots.txt', '48b940e4f0d740df98a9d1bb83060fc7.txt']) assert.ok(files.includes(file));
  assert.equal(manifest.find(({ file }) => file === 'en/index.html').route, '/en/');
  assert.equal(manifest.find(({ file }) => file === 'index.html').route, '/');
  assert.ok(files.includes('public/brand_assets/shadow_snap.svg'));
  assert.ok(files.includes('public/brand_assets/og_shadow_snap.png'));
});

const scenarios = [
  ['match', null, 200, 'expected', null, 'candidate'],
  ['original mismatch', '/script.js', 200, 'wrong', null, 'candidate'],
  ['English mismatch', '/en/', 200, 'wrong', null, 'candidate'],
  ['English missing', '/en/', 404, 'missing', null, 'candidate'],
  ['translation mismatch', '/translations.mjs', 200, 'wrong', null, 'candidate'],
  ['SEO module wrong MIME', '/seo-content.mjs', 200, 'expected', 'text/html', 'candidate'],
  ['sitemap mismatch', '/sitemap.xml', 200, 'wrong', null, 'candidate'],
  ['unexpected redirect', '/en/', 308, 'expected', null, 'candidate'],
  ['protected candidate denied', '/en/', 403, 'expected', null, 'candidate'],
  ['request failure', '/en/', 200, 'expected', null, 'candidate'],
  ['followed redirect chain', '/en/', 200, 'expected', null, 'candidate'],
  ['commit read failed', '/en/', 200, '', null, 'candidate'],
  ['production module mismatch', '/translations.mjs', 200, 'wrong', null, 'production'],
  ['production request failure', '/en/', 200, 'expected', null, 'production'],
  ['production followed redirect chain', '/en/', 200, 'expected', null, 'production'],
  ['social image missing', '/public/brand_assets/og_shadow_snap.png', 404, 'missing', null, 'candidate'],
];

for (const [name, badRoute, badStatus, badBody, badType, phase] of scenarios) {
  test(`${phase} ${name} ${name === 'match' ? 'passes' : 'fails closed'}`, (t) => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'snap-content-'));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const bin = path.join(fixture, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'git'), name === 'commit read failed' ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\nprintf expected\n', { mode: 0o755 });
    const mock = [
      '#!/usr/bin/env node',
      "const fs=require('node:fs'); const a=process.argv.slice(2);",
      `const manifest=${JSON.stringify(manifest)};`,
      "const candidate=a[0]==='curl'; const route=candidate?a[1]:new URL(a.at(-1)).pathname;",
      'const entry=manifest.find(x=>x.route===route); if(!entry) process.exit(9);',
      "if(!a.includes('--no-location') || a[a.indexOf('--max-redirs')+1]!=='0' || a[a.indexOf('--request')+1]!=='GET') process.exit(9);",
      `const bad=route===${JSON.stringify(badRoute)} && ${phase === 'candidate' ? 'candidate' : '!candidate'};`,
      `const type=bad && ${JSON.stringify(badType)} ? ${JSON.stringify(badType)} : entry.mediaTypes[0];`,
      `const redirect=bad && ${name.includes('redirect chain')} ? 'HTTP/2 308\\r\\nLocation: /other\\r\\n\\r\\n' : '';`,
      "fs.writeFileSync(a[a.indexOf('-D')+1], redirect+'HTTP/2 200\\r\\nContent-Type: '+type+'; charset=utf-8\\r\\n\\r\\n');",
      `fs.writeFileSync(a[a.indexOf('-o')+1],bad?${JSON.stringify(badBody)}:'expected');`,
      `process.stdout.write(String(bad?${badStatus}:200));`,
      `if(bad && ${name.includes('request failure')}) process.exitCode=18;`,
    ].join('\n');
    for (const command of ['vercel', 'curl']) writeFileSync(path.join(bin, command), mock, { mode: 0o755 });
    const quotedManifest = "'" + manifestTsv.replaceAll("'", "'\\''") + "'";
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail', `VERIFY_MANIFEST=${quotedManifest}`,
      `ROOT_DIR='${repoRoot}'`, `SHADOW_CURL_BIN='${path.join(bin, 'curl')}'`,
      'HEAD_SHA=fixture', 'TEAM_ID=team_fixture', 'DEPLOY_URL=https://fixture.vercel.app',
      check, "printf 'PROMOTE_REACHED\\n'",
      'verify_against_commit https://snap.shadow.wang production-fixture',
      'verify_against_commit https://sie.shadow.wang second-production-fixture',
      "printf 'PRODUCTION_ACCEPTED\\n'",
    ].join('\n')], { env: { PATH: bin + ':' + process.env.PATH, TMPDIR: os.tmpdir() }, encoding: 'utf8' });
    if (name === 'match') {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PRODUCTION_ACCEPTED/);
      assert.equal((result.stdout.match(new RegExp(`${manifest.length} 项站点资产`, 'g')) ?? []).length, 3);
    } else {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, phase === 'candidate' ? /PROMOTE_REACHED/ : /PRODUCTION_ACCEPTED/);
      assert.ok(result.stderr.includes(name === 'commit read failed' ? '无法读取提交' : badRoute), result.stderr);
    }
  });
}

test('Vercel native curl shim prepends disable before the CLI URL and protection header', (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'snap-curl-shim-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const native = path.join(fixture, 'curl');
  writeFileSync(native, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const result = spawnSync(path.join(repoRoot, 'scripts/release/http-bin/curl'), ['--url', 'https://fixture.invalid', '--header', 'synthetic: placeholder'], { env: { PATH: process.env.PATH, SHADOW_CURL_BIN: native }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['--disable', '--url', 'https://fixture.invalid', '--header', 'synthetic: placeholder']);
});

test('verify-site-content creates configured .vercel link before deployment curl and rejects wrong link', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'snap-verify-entry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['clone', '--quiet', '--no-local', repoRoot, dir]);
  writeFileSync(path.join(dir, 'scripts/release/verify-site-content.sh'), readFileSync(path.join(repoRoot, 'scripts/release/verify-site-content.sh')));
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-aqm', 'test'], { cwd: dir });
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const bin = mkdtempSync(path.join(os.tmpdir(), 'snap-verify-bin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const cfg = JSON.parse(readFileSync(path.join(dir, 'config/release-production.json'), 'utf8')).vercel;
  writeFileSync(path.join(bin, 'vercel'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const link = JSON.parse(fs.readFileSync('.vercel/project.json', 'utf8'));",
    `if (link.projectId !== ${JSON.stringify(cfg.projectId)} || link.orgId !== ${JSON.stringify(cfg.teamId)}) process.exit(42);`,
    'process.exit(17);',
  ].join('\n'), { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
  delete env.VERCEL_PROJECT_ID; delete env.VERCEL_ORG_ID;
  const r1 = spawnSync('bash', ['scripts/release/verify-site-content.sh', 'https://candidate.vercel.app', sha, 'deployment'], { cwd: dir, env, encoding: 'utf8' });
  const link = JSON.parse(readFileSync(path.join(dir, '.vercel/project.json'), 'utf8'));
  assert.equal(link.projectId, cfg.projectId, r1.stderr);
  assert.equal(link.orgId, cfg.teamId);

  writeFileSync(path.join(dir, '.vercel/project.json'), JSON.stringify({ projectId: 'prj_wrong', orgId: cfg.teamId }));
  writeFileSync(path.join(bin, 'vercel'), '#!/bin/sh\necho VERCEL_CALLED >&2; exit 0\n', { mode: 0o755 });
  const r2 = spawnSync('bash', ['scripts/release/verify-site-content.sh', 'https://candidate.vercel.app', sha, 'deployment'], { cwd: dir, env, encoding: 'utf8' });
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /vercel_binding_link_mismatch/);
  assert.doesNotMatch(r2.stderr, /VERCEL_CALLED/);
});
