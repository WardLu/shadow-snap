import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = readFileSync(path.join(repoRoot, 'scripts/release/deploy-production.sh'), 'utf8');
const step = source.slice(source.lastIndexOf('# ------------------------------------------------------------------------------', source.indexOf('矩阵事实广播：只有配置')));

const gitEnv = { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
const git = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' });

// Release from .worktrees/<name>, as the release flow does, with the sibling Portal next to the main repository.
function runStep(t, portalScript, broadcast = 'true') {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'snap-matrix-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'shadow-snap');
  mkdirSync(main);
  git(main, ['init', '-q', '-b', 'main']);
  git(main, ['commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'init']);
  git(main, ['worktree', 'add', '-q', '-b', 'production', '.worktrees/release']);
  const marker = path.join(root, 'called');
  if (portalScript !== null) {
    mkdirSync(path.join(root, 'shadow-portal/scripts/matrix'), { recursive: true });
    writeFileSync(path.join(root, 'shadow-portal/scripts/matrix/check-or-sync-matrix.mjs'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, \`\${process.cwd()} \${process.argv.slice(2).join(' ')}\`);\n${portalScript};\n`);
  }
  const worktree = path.join(main, '.worktrees/release');
  const script = `set -euo pipefail\nROOT_DIR=${JSON.stringify(worktree)}\nconfig_get() { [ "$1" = matrixBroadcast ] && printf '%s' ${broadcast}; }\nW="$(mktemp -d)"\ntrap 'rm -rf "$W"' EXIT\n${step}`;
  const result = spawnSync('/bin/bash', ['-c', script], { cwd: worktree, env: gitEnv, encoding: 'utf8' });
  let called = null;
  try { called = readFileSync(marker, 'utf8'); } catch {}
  return { ...result, called, portal: path.join(root, 'shadow-portal') };
}

test('matrix broadcast reaches the sibling Portal from a release worktree and never fails a finished release', (t) => {
  for (const [label, body, message] of [
    ['ok', 'process.exit(0)', /正在同步最新发布版本/],
    ['fails', 'process.exit(1)', /同步失败，不影响本次已完成的生产发布/],
    ['missing', null, /未找到 .*check-or-sync-matrix\.mjs，已跳过/],
  ]) {
    const result = runStep(t, body);
    assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
    // macOS bash 3.2 keeps exit 0 after an unbound variable when an EXIT trap is set, so check stderr too.
    assert.doesNotMatch(result.stderr, /unbound variable/, label);
    assert.match(result.stdout + result.stderr, message, label);
    if (body) assert.equal(result.called, `${result.portal} --sync`, label);
  }
});

test('matrix broadcast runs only when the release config turns it on', (t) => {
  const result = runStep(t, 'process.exit(0)', 'false');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.called, null, 'matrixBroadcast false must not touch the Portal');
  assert.doesNotMatch(result.stdout + result.stderr, /矩阵事实广播/);
});

test('Shadow Snap is a matrix product: its release config turns the broadcast on', () => {
  const config = JSON.parse(readFileSync(path.join(repoRoot, 'config/release-production.json'), 'utf8'));
  assert.equal(config.matrixBroadcast, true);
});
