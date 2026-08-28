import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { hashReleaseConfig, loadReleaseConfig } from '../../../scripts/release/config.mjs';
import {
  acquireReleaseLease,
  installControllerBinding,
  inspectReleaseLease,
} from '../../../scripts/release/lock.mjs';
import { evaluatePrePush } from '../../../scripts/release/pre-push.mjs';
import { clearStaleReleaseLease } from '../../../scripts/release/unlock.mjs';

const ZERO_SHA = '0'.repeat(40);
const OLD_SHA = '1'.repeat(40);
const NEW_SHA = '2'.repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shadow-release-lock-'));
  const commonDir = path.join(root, '.git');
  const registryPath = path.join(root, 'host-registry.json');
  await mkdir(commonDir, { recursive: true });
  const config = await loadReleaseConfig(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..'),
  );
  const runner = async (command, args) => {
    assert.equal(command, 'git');
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      return { stdout: `${commonDir}\n`, exitCode: 0, stderrDigest: '0'.repeat(64) };
    }
    if (args[0] === 'rev-parse' && args[1] === 'refs/tags/v1.2.3^{commit}') {
      return { stdout: `${NEW_SHA}\n`, exitCode: 0, stderrDigest: '0'.repeat(64) };
    }
    if (args[0] === 'merge-base') {
      return { stdout: '', exitCode: 0, stderrDigest: '0'.repeat(64) };
    }
    throw new Error(`unexpected_git:${args.join(' ')}`);
  };
  return { root, commonDir, registryPath, config, runner };
}

test('binding is mode 0600 and rejects a different controller instance', async () => {
  const { root, commonDir, registryPath, config, runner } = await fixture();
  const result = await installControllerBinding({
    runner,
    repoRoot: root,
    config,
    registryPath,
  });
  const mode = (await stat(result.bindingPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  const binding = JSON.parse(await readFile(result.bindingPath, 'utf8'));
  assert.equal(binding.instanceId, config.controller.instanceId);
  assert.equal(binding.checkoutPath, await realpath(root));

  const changed = structuredClone(config);
  changed.controller.instanceId = '11111111-1111-4111-8111-111111111111';
  await assert.rejects(
    installControllerBinding({
      runner,
      repoRoot: root,
      config: changed,
      registryPath,
    }),
    /controller_binding_mismatch/,
  );
  assert.ok(commonDir);
});

test('binding rejects another worktree even when it shares the Git common dir', async () => {
  const { root, registryPath, config, runner } = await fixture();
  await installControllerBinding({ runner, repoRoot: root, config, registryPath });
  const otherWorktree = path.join(root, 'other-worktree');
  await mkdir(otherWorktree);
  await assert.rejects(
    installControllerBinding({ runner, repoRoot: otherWorktree, config, registryPath }),
    /controller_binding_mismatch/,
  );
});

test('host registry rejects a second independently cloned Git common dir', async () => {
  const { root, registryPath, config, runner } = await fixture();
  await installControllerBinding({ runner, repoRoot: root, config, registryPath });

  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'shadow-release-second-clone-'));
  const secondCommonDir = path.join(secondRoot, '.git');
  await mkdir(secondCommonDir);
  const secondRunner = async (command, args) => {
    assert.equal(command, 'git');
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
      return { stdout: `${secondCommonDir}\n`, exitCode: 0, stderrDigest: '0'.repeat(64) };
    }
    throw new Error(`unexpected_git:${args.join(' ')}`);
  };
  await assert.rejects(
    installControllerBinding({
      runner: secondRunner,
      repoRoot: secondRoot,
      config,
      registryPath,
    }),
    /controller_registry_already_claimed/,
  );
});

test('lease is exclusive and stale leases require explicit cleanup', async () => {
  const { root, registryPath, config, runner } = await fixture();
  await installControllerBinding({ runner, repoRoot: root, config, registryPath });
  const now = new Date('2026-08-28T00:00:00.000Z');
  const lease = await acquireReleaseLease({
    runner,
    repoRoot: root,
    config,
    command: 'stage',
    tag: 'v1.2.3',
    now,
  });
  await assert.rejects(
    acquireReleaseLease({
      runner,
      repoRoot: root,
      config,
      command: 'stage',
      tag: 'v1.2.3',
      now,
    }),
    /release_lease_active/,
  );
  await lease.release();

  const second = await acquireReleaseLease({
    runner,
    repoRoot: root,
    config,
    command: 'stage',
    tag: 'v1.2.3',
    now,
  });
  const leaseFile = JSON.parse(await readFile(second.leasePath, 'utf8'));
  leaseFile.pid = 999999;
  leaseFile.expiresAt = '2026-08-27T00:00:00.000Z';
  await writeFile(second.leasePath, `${JSON.stringify(leaseFile)}\n`, { mode: 0o600 });
  const inspected = await inspectReleaseLease({
    runner,
    repoRoot: root,
    config,
    now,
    processExists: () => false,
  });
  assert.equal(inspected.status, 'stale_lock_requires_authorization');

  const preview = await clearStaleReleaseLease({
    runner,
    repoRoot: root,
    config,
    tag: 'v1.2.3',
    now,
  });
  assert.equal(preview.status, 'authorization_required');
  const completed = await clearStaleReleaseLease({
    runner,
    repoRoot: root,
    config,
    tag: 'v1.2.3',
    authorize: preview.authorizationDigest,
    now: new Date('2026-08-28T00:00:01.000Z'),
  });
  assert.equal(completed.status, 'completed');
  await assert.rejects(access(second.leasePath), /ENOENT/);
  await assert.doesNotReject(access(path.resolve(root, completed.archivedLeasePath)));
});

test('ordinary refs pass while production needs one-use exact capability', async () => {
  const { root, registryPath, config, runner } = await fixture();
  const installed = await installControllerBinding({
    runner,
    repoRoot: root,
    config,
    registryPath,
  });
  const normal = await evaluatePrePush({
    input: `refs/heads/main ${NEW_SHA} refs/heads/main ${OLD_SHA}\n`,
    repoRoot: root,
    config,
    runner,
    now: new Date('2026-08-28T00:00:00.000Z'),
  });
  assert.equal(normal.allowed, true);

  const capability = {
    schemaVersion: 1,
    repository: config.repository,
    tag: 'v1.2.3',
    oldSha: ZERO_SHA,
    newSha: NEW_SHA,
    configHash: hashReleaseConfig(config),
    nonce: '6ab6c2f9-8947-46f1-9af4-2061310fdd78',
    expiresAt: '2026-08-28T00:05:00.000Z',
    consumed: false,
  };
  await writeFile(installed.capabilityPath, `${JSON.stringify(capability)}\n`, {
    mode: 0o600,
  });
  const productionInput = `refs/heads/production ${NEW_SHA} refs/heads/production ${ZERO_SHA}\n`;
  const firstAttempt = await evaluatePrePush({
    input: productionInput,
    repoRoot: root,
    config,
    runner,
    now: new Date('2026-08-28T00:00:00.000Z'),
  });
  assert.equal(firstAttempt.allowed, true);

  const secondAttempt = await evaluatePrePush({
    input: productionInput,
    repoRoot: root,
    config,
    runner,
    now: new Date('2026-08-28T00:00:01.000Z'),
  });
  assert.equal(secondAttempt.allowed, false);
  assert.equal(secondAttempt.reasonCode, 'capability_already_consumed');
});

test('production deletion, rewind, wrong SHA, and expired capability are rejected', async () => {
  const { root, registryPath, config, runner } = await fixture();
  const installed = await installControllerBinding({
    runner,
    repoRoot: root,
    config,
    registryPath,
  });
  const base = {
    schemaVersion: 1,
    repository: config.repository,
    tag: 'v1.2.3',
    oldSha: OLD_SHA,
    newSha: NEW_SHA,
    configHash: hashReleaseConfig(config),
    nonce: 'aecc38dc-3622-4811-851d-49387c289c47',
    expiresAt: '2026-08-28T00:05:00.000Z',
    consumed: false,
  };
  await writeFile(installed.capabilityPath, `${JSON.stringify(base)}\n`, { mode: 0o600 });

  const deletion = await evaluatePrePush({
    input: `refs/heads/production ${ZERO_SHA} refs/heads/production ${OLD_SHA}\n`,
    repoRoot: root,
    config,
    runner,
    now: new Date('2026-08-28T00:00:00.000Z'),
  });
  assert.equal(deletion.reasonCode, 'production_delete_forbidden');

  const wrongSha = await evaluatePrePush({
    input: `refs/heads/production ${'3'.repeat(40)} refs/heads/production ${OLD_SHA}\n`,
    repoRoot: root,
    config,
    runner,
    now: new Date('2026-08-28T00:00:00.000Z'),
  });
  assert.equal(wrongSha.reasonCode, 'capability_ref_mismatch');

  await writeFile(
    installed.capabilityPath,
    `${JSON.stringify({ ...base, expiresAt: '2026-08-27T23:59:59.000Z' })}\n`,
    { mode: 0o600 },
  );
  const expired = await evaluatePrePush({
    input: `refs/heads/production ${NEW_SHA} refs/heads/production ${OLD_SHA}\n`,
    repoRoot: root,
    config,
    runner,
    now: new Date('2026-08-28T00:00:00.000Z'),
  });
  assert.equal(expired.reasonCode, 'capability_expired');
});

test('capability consumption is an exclusive compare-and-set', async () => {
  const { root, registryPath, config, runner } = await fixture();
  const installed = await installControllerBinding({
    runner,
    repoRoot: root,
    config,
    registryPath,
  });
  await writeFile(
    installed.capabilityPath,
    `${JSON.stringify({
      schemaVersion: 1,
      repository: config.repository,
      tag: 'v1.2.3',
      oldSha: ZERO_SHA,
      newSha: NEW_SHA,
      configHash: hashReleaseConfig(config),
      nonce: 'exclusive-capability-nonce',
      expiresAt: '2026-08-28T00:10:00.000Z',
      consumed: false,
    })}\n`,
    { mode: 0o600 },
  );
  const request = {
    input: `refs/heads/production ${NEW_SHA} refs/heads/production ${ZERO_SHA}\n`,
    repoRoot: root,
    config,
    runner,
    now: new Date('2026-08-28T00:00:00.000Z'),
  };
  const results = await Promise.all([
    evaluatePrePush(request),
    evaluatePrePush(request),
  ]);
  assert.equal(results.filter((result) => result.allowed).length, 1);
  assert.equal(results.filter((result) => !result.allowed).length, 1);
});
