import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalJson,
  sha256,
  uploadUniqueReleaseAsset,
  writeLocalEvidence,
} from '../../../scripts/release/evidence.mjs';
import {
  deriveReleaseState,
  reconcileIntent,
  validateTransition,
} from '../../../scripts/release/state.mjs';

test('canonical evidence is stable and local evidence cannot be overwritten', async () => {
  assert.equal(
    canonicalJson({ z: 1, nested: { b: 2, a: 1 }, a: ['x', { y: true }] }),
    '{"a":["x",{"y":true}],"nested":{"a":1,"b":2},"z":1}\n',
  );
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'shadow-evidence-'));
  const value = { state: 'admission_ready', tag: 'v1.2.3' };
  const first = await writeLocalEvidence({
    repoRoot,
    tag: 'v1.2.3',
    fileName: 'release-admission.json',
    value,
  });
  const second = await writeLocalEvidence({
    repoRoot,
    tag: 'v1.2.3',
    fileName: 'release-admission.json',
    value,
  });
  assert.equal(first.sha256, second.sha256);
  assert.equal(await readFile(first.filePath, 'utf8'), canonicalJson(value));
  await assert.rejects(
    writeLocalEvidence({
      repoRoot,
      tag: 'v1.2.3',
      fileName: 'release-admission.json',
      value: { ...value, targetSha: '1'.repeat(40) },
    }),
    /local_evidence_conflict/,
  );
});

test('release asset upload rejects duplicates and records immutable identity', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'shadow-asset-'));
  const local = await writeLocalEvidence({
    repoRoot,
    tag: 'v1.2.3',
    fileName: 'release-intent-stage-aabbccdd.json',
    value: { state: 'stage_intent', nonce: 'aabbccdd' },
  });
  const calls = [];
  let apiReads = 0;
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git') {
      return { stdout: 'git@github.com:WardLu/shadow-snap.git\n', exitCode: 0 };
    }
    if (command === 'gh' && args[0] === 'api') {
      apiReads += 1;
      return {
        stdout: JSON.stringify({
          assets:
            apiReads === 1
              ? []
              : [
                  {
                    id: 991,
                    name: path.basename(local.filePath),
                    created_at: '2026-08-28T00:00:00Z',
                    size: Buffer.byteLength(await readFile(local.filePath)),
                  },
                ],
        }),
        exitCode: 0,
      };
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') {
      return { stdout: '', exitCode: 0 };
    }
    throw new Error(`unexpected:${command}:${args.join(':')}`);
  };

  const uploaded = await uploadUniqueReleaseAsset({
    runner,
    repoRoot,
    tag: 'v1.2.3',
    filePath: local.filePath,
  });
  assert.deepEqual(uploaded, {
    id: 991,
    name: path.basename(local.filePath),
    createdAt: '2026-08-28T00:00:00Z',
    size: Buffer.byteLength(await readFile(local.filePath)),
    sha256: local.sha256,
  });
  assert.equal(calls.some((call) => call.includes('--clobber')), false);

  const duplicateRunner = async (command, args) => {
    if (command === 'git') return { stdout: 'https://github.com/WardLu/shadow-snap.git\n' };
    if (command === 'gh' && args[0] === 'api') {
      return {
        stdout: JSON.stringify({
          assets: [{ id: 991, name: path.basename(local.filePath), size: 1 }],
        }),
      };
    }
    throw new Error('upload_should_not_run');
  };
  await assert.rejects(
    uploadUniqueReleaseAsset({
      runner: duplicateRunner,
      repoRoot,
      tag: 'v1.2.3',
      filePath: local.filePath,
    }),
    /release_asset_already_exists/,
  );
});

test('state derivation validates the immutable chain and expiration', () => {
  const now = new Date('2026-08-28T12:00:00.000Z');
  assert.equal(
    deriveReleaseState(
      {
        releasePublished: true,
        pendingTtlSeconds: 86400,
        evidence: [
          {
            state: 'admitted',
            fromState: 'admission_ready',
            createdAt: '2026-08-28T00:00:00.000Z',
          },
          {
            state: 'initialize_intent',
            fromState: 'admitted',
            createdAt: '2026-08-28T00:30:00.000Z',
          },
          {
            state: 'initialized',
            fromState: 'initialize_intent',
            createdAt: '2026-08-28T01:00:00.000Z',
          },
        ],
      },
      now,
    ).state,
    'initialized',
  );
  assert.equal(
    deriveReleaseState(
      {
        releasePublished: true,
        pendingTtlSeconds: 60,
        evidence: [
          {
            state: 'admitted',
            fromState: 'admission_ready',
            createdAt: '2026-08-28T00:00:00.000Z',
          },
          {
            state: 'initialize_intent',
            fromState: 'admitted',
            createdAt: '2026-08-28T00:10:00.000Z',
          },
          {
            state: 'initialized',
            fromState: 'initialize_intent',
            createdAt: '2026-08-28T00:20:00.000Z',
          },
          {
            state: 'stage_intent',
            fromState: 'initialized',
            createdAt: '2026-08-28T00:30:00.000Z',
          },
          {
            state: 'staged_pending_promote',
            fromState: 'stage_intent',
            createdAt: '2026-08-28T00:40:00.000Z',
          },
        ],
      },
      now,
    ).state,
    'staged_expired',
  );
  assert.equal(
    deriveReleaseState(
      {
        releasePublished: true,
        pendingTtlSeconds: 3600,
        evidence: [
          { state: 'admitted', fromState: 'admission_ready', createdAt: '2026-08-28T00:00:00.000Z' },
          { state: 'initialize_intent', fromState: 'admitted', createdAt: '2026-08-28T00:10:00.000Z' },
          { state: 'initialized', fromState: 'initialize_intent', createdAt: '2026-08-28T00:20:00.000Z' },
          { state: 'stage_intent', fromState: 'initialized', createdAt: '2026-08-28T00:30:00.000Z' },
          { state: 'staged_pending_promote', fromState: 'stage_intent', createdAt: '2026-08-28T00:40:00.000Z' },
          { state: 'renew_intent', fromState: 'staged_pending_promote', createdAt: '2026-08-28T11:50:00.000Z' },
          { state: 'staged_pending_promote', fromState: 'renew_intent', createdAt: '2026-08-28T11:51:00.000Z' },
        ],
      },
      now,
    ).state,
    'staged_pending_promote',
  );
  assert.equal(
    deriveReleaseState(
      {
        releasePublished: true,
        pendingTtlSeconds: 86400,
        evidence: [
          {
            state: 'current',
            fromState: 'promote_intent',
            createdAt: 'not-a-date',
          },
        ],
      },
      now,
    ).state,
    'drift_freeze',
  );
});

test('transition table rejects bypassing separate release phases', () => {
  assert.equal(
    validateTransition({ from: 'admitted', operation: 'initialize', facts: {} }).allowed,
    true,
  );
  assert.equal(
    validateTransition({ from: 'admitted', operation: 'promote', facts: {} }).reasonCode,
    'transition_forbidden',
  );
  assert.equal(
    validateTransition({ from: 'stage_failed', operation: 'stage', facts: {} }).reasonCode,
    'transition_forbidden',
  );
  assert.equal(
    validateTransition({ from: 'stage_failed', operation: 'recover', facts: {} }).allowed,
    true,
  );
  assert.equal(
    validateTransition({ from: 'initialized_expired', operation: 'renew', facts: {} }).allowed,
    true,
  );
  assert.equal(
    validateTransition({ from: 'staged_expired', operation: 'promote', facts: {} }).reasonCode,
    'transition_forbidden',
  );
});

test('initialize resume either continues the same write or finalizes it', () => {
  const intent = {
    operation: 'initialize',
    repository: 'WardLu/shadow-snap',
    tag: 'v1.2.3',
    targetSha: '2'.repeat(40),
    configHash: 'a'.repeat(64),
    nonce: 'nonce-initialize',
  };
  assert.deepEqual(
    reconcileIntent({
      intent,
      facts: {
        repository: intent.repository,
        tag: intent.tag,
        targetSha: intent.targetSha,
        configHash: intent.configHash,
        productionSha: null,
      },
    }),
    { action: 'continue_external_write', nextStep: 'create_production_ref' },
  );
  assert.deepEqual(
    reconcileIntent({
      intent,
      facts: {
        repository: intent.repository,
        tag: intent.tag,
        targetSha: intent.targetSha,
        configHash: intent.configHash,
        productionSha: intent.targetSha,
      },
    }),
    { action: 'finalize_completion', evidenceType: 'initialized' },
  );
});

test('stage resume preserves build/deploy and completion crash windows', () => {
  const intent = {
    operation: 'stage',
    repository: 'WardLu/shadow-snap',
    tag: 'v1.2.3',
    oldSha: '1'.repeat(40),
    targetSha: '2'.repeat(40),
    expectedCurrentDeploymentId: 'dpl_old',
    configHash: 'a'.repeat(64),
    nonce: 'nonce-stage',
  };
  const baseFacts = {
    repository: intent.repository,
    tag: intent.tag,
    targetSha: intent.targetSha,
    configHash: intent.configHash,
    currentDeploymentId: 'dpl_old',
  };
  assert.deepEqual(
    reconcileIntent({
      intent,
      facts: { ...baseFacts, productionSha: intent.targetSha, matchingDeployments: [] },
    }),
    { action: 'continue_external_write', nextStep: 'build_and_stage_deployment' },
  );
  assert.deepEqual(
    reconcileIntent({
      intent,
      facts: {
        ...baseFacts,
        productionSha: intent.targetSha,
        matchingDeployments: [{ id: 'dpl_new' }],
      },
    }),
    { action: 'finalize_completion', evidenceType: 'staged_pending_promote' },
  );
  assert.equal(
    reconcileIntent({
      intent,
      facts: {
        ...baseFacts,
        productionSha: intent.targetSha,
        matchingDeployments: [{ id: 'dpl_a' }, { id: 'dpl_b' }],
      },
    }).reasonCode,
    'multiple_matching_deployments',
  );
});

test('promote and rollback resume never change deployment targets', () => {
  const promote = {
    operation: 'promote',
    repository: 'WardLu/shadow-snap',
    tag: 'v1.2.3',
    targetSha: '2'.repeat(40),
    deploymentId: 'dpl_new',
    expectedCurrentDeploymentId: 'dpl_old',
    configHash: 'a'.repeat(64),
    nonce: 'nonce-promote',
  };
  const base = {
    repository: promote.repository,
    tag: promote.tag,
    targetSha: promote.targetSha,
    configHash: promote.configHash,
  };
  assert.equal(
    reconcileIntent({
      intent: promote,
      facts: { ...base, currentDeploymentId: 'dpl_old' },
    }).nextStep,
    'promote_deployment',
  );
  assert.equal(
    reconcileIntent({
      intent: promote,
      facts: { ...base, currentDeploymentId: 'dpl_new' },
    }).evidenceType,
    'production_acceptance',
  );

  const rollback = {
    ...promote,
    operation: 'rollback',
    currentDeploymentId: 'dpl_new',
    targetDeploymentId: 'dpl_old',
    nonce: 'nonce-rollback',
  };
  assert.equal(
    reconcileIntent({
      intent: rollback,
      facts: { ...base, currentDeploymentId: 'dpl_old', settingsMatch: false },
    }).nextStep,
    'restore_vercel_settings',
  );
  assert.equal(
    reconcileIntent({
      intent: rollback,
      facts: { ...base, currentDeploymentId: 'dpl_old', settingsMatch: true },
    }).evidenceType,
    'rolled_back',
  );
});

test('renew and fail intents only append evidence for the same expired release', () => {
  const facts = {
    repository: 'WardLu/shadow-snap',
    tag: 'v1.2.3',
    targetSha: '2'.repeat(40),
    configHash: 'a'.repeat(64),
  };
  assert.deepEqual(
    reconcileIntent({
      intent: { ...facts, operation: 'renew', renewState: 'staged_pending_promote' },
      facts,
    }),
    { action: 'continue_external_write', nextStep: 'renew_evidence' },
  );
  assert.deepEqual(
    reconcileIntent({ intent: { ...facts, operation: 'fail' }, facts }),
    { action: 'continue_external_write', nextStep: 'record_stage_failed' },
  );
});
