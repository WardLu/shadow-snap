import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createReleaseController } from '../../../scripts/release/controller.mjs';
import {
  createStagedDeployment,
  promoteDeployment,
  rollbackDeployment,
  runProductionAcceptance,
  runStagedAcceptance,
  validateVercelProjectFacts,
  verifyVercelCliVersion,
} from '../../../scripts/release/vercel.mjs';
import { loadReleaseConfig } from '../../../scripts/release/config.mjs';

const TARGET_SHA = '2'.repeat(40);

async function configFixture() {
  return loadReleaseConfig(
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..'),
  );
}

test('project verification rejects identity, branch, settings, root, and domain drift', async () => {
  const config = await configFixture();
  const valid = {
    id: config.vercel.projectId,
    name: config.vercel.projectName,
    rootDirectory: null,
    link: { productionBranch: 'production' },
    autoAssignCustomDomains: false,
    domains: ['sie.shadow.wang', 'snap.shadow.wang', 'shadow-snap.vercel.app'],
    targets: { production: { id: 'dpl_old', url: 'old.vercel.app' } },
  };
  assert.equal(validateVercelProjectFacts({ project: valid, config }).current.id, 'dpl_old');
  for (const project of [
    { ...valid, id: 'prj_wrong' },
    { ...valid, name: 'wrong-project' },
    { ...valid, rootDirectory: 'merchant-admin' },
    { ...valid, link: { productionBranch: 'main' } },
    { ...valid, autoAssignCustomDomains: true },
    { ...valid, domains: ['snap.shadow.wang'] },
  ]) {
    assert.throws(
      () => validateVercelProjectFacts({ project, config }),
      /vercel_project_|vercel_production_|vercel_domain_|vercel_auto_assign/,
    );
  }
});

test('staged deployment uses an exact detached worktree and never promotes', async () => {
  const config = await configFixture();
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'shadow-vercel-repo-'));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'shadow-vercel-stage-'));
  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    if (command === 'vercel' && args[0] === '--version') {
      return { stdout: `Vercel CLI ${config.vercel.cliVersion}\n${config.vercel.cliVersion}\n`, exitCode: 0 };
    }
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
      await mkdir(args[3], { recursive: true });
      return { stdout: '', exitCode: 0 };
    }
    if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
      return { stdout: '', exitCode: 0 };
    }
    if (command === 'vercel' && args[0] === 'pull') return { stdout: '', exitCode: 0 };
    if (command === 'vercel' && args[0] === 'build') return { stdout: '', exitCode: 0 };
    if (command === 'vercel' && args[0] === 'deploy') {
      return {
        stdout: JSON.stringify({ id: 'dpl_new', url: 'shadow-snap-new.vercel.app' }),
        exitCode: 0,
      };
    }
    if (command === 'vercel' && args[0] === 'api') {
      return {
        stdout: JSON.stringify({
          id: 'dpl_new',
          url: 'shadow-snap-new.vercel.app',
          projectId: config.vercel.projectId,
          target: 'production',
          readyState: 'READY',
          meta: {
            releaseCommitSha: TARGET_SHA,
            releaseTag: 'v1.2.3',
            releaseConfigHash: 'a'.repeat(64),
          },
        }),
        exitCode: 0,
      };
    }
    throw new Error(`unexpected:${command}:${args.join(':')}`);
  };

  const deployment = await createStagedDeployment({
    runner,
    repoRoot,
    config,
    targetSha: TARGET_SHA,
    tag: 'v1.2.3',
    configHash: 'a'.repeat(64),
    tempRoot,
  });
  assert.equal(deployment.id, 'dpl_new');
  assert.equal(deployment.url, 'shadow-snap-new.vercel.app');

  const deployCall = calls.find(
    ({ command, args }) => command === 'vercel' && args[0] === 'deploy',
  );
  assert.ok(deployCall.args.includes('--prebuilt'));
  assert.ok(deployCall.args.includes('--prod'));
  assert.ok(deployCall.args.includes('--skip-domain'));
  assert.ok(deployCall.args.includes(`releaseCommitSha=${TARGET_SHA}`));
  assert.equal(
    calls.some(({ command, args }) => command === 'vercel' && args[0] === 'promote'),
    false,
  );
});

test('promote and rollback are separate exact-target commands', async () => {
  const config = await configFixture();
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'vercel' && args[0] === '--version') {
      return { stdout: `Vercel CLI ${config.vercel.cliVersion}\n${config.vercel.cliVersion}\n`, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  };
  await promoteDeployment({
    runner,
    repoRoot: '/repo',
    config,
    deploymentUrl: 'https://shadow-snap-new.vercel.app',
  });
  await rollbackDeployment({
    runner,
    repoRoot: '/repo',
    config,
    deploymentUrl: 'https://shadow-snap-old.vercel.app',
  });
  assert.deepEqual(calls.filter(({ args }) => ['promote', 'rollback'].includes(args[0])).map(({ args }) => args.slice(0, 3)), [
    ['promote', 'https://shadow-snap-new.vercel.app/', '--yes'],
    ['rollback', 'https://shadow-snap-old.vercel.app/', '--yes'],
  ]);
});

test('pins the Vercel CLI and records staged and production HTTP acceptance', async () => {
  const config = await configFixture();
  const response = (url, body = config.acceptance.bodyIncludes) =>
    `HTTP/2 200\r\ncontent-type: text/html\r\nstrict-transport-security: max-age=63072000\r\n\r\n${body}\nSHADOW_ACCEPTANCE_META:200\t${url}\t0\n`;
  const runner = async (command, args) => {
    if (command === 'vercel' && args[0] === '--version') {
      return { stdout: `Vercel CLI ${config.vercel.cliVersion}\n${config.vercel.cliVersion}\n`, exitCode: 0 };
    }
    if (command === 'vercel' && args[0] === 'curl') {
      return { stdout: response('https://shadow-snap-new.vercel.app/'), exitCode: 0 };
    }
    if (command === 'curl') return { stdout: response(args.at(-1)), exitCode: 0 };
    throw new Error(`unexpected:${command}:${args.join(':')}`);
  };
  assert.equal(
    await verifyVercelCliVersion({ runner, repoRoot: '/repo', config }),
    config.vercel.cliVersion,
  );
  const staged = await runStagedAcceptance({
    runner,
    repoRoot: '/repo',
    config,
    deploymentUrl: 'shadow-snap-new.vercel.app',
  });
  assert.equal(staged.kind, 'staged');
  assert.match(staged.responseSha256, /^[0-9a-f]{64}$/);
  const production = await runProductionAcceptance({ runner, repoRoot: '/repo', config });
  assert.deepEqual(
    production.domains.map(({ domain }) => domain),
    config.vercel.productionDomains,
  );

  await assert.rejects(
    verifyVercelCliVersion({
      runner: async () => ({ stdout: 'Vercel CLI 1.0.0\n1.0.0\n' }),
      repoRoot: '/repo',
      config,
    }),
    /vercel_cli_version_mismatch/,
  );
  await assert.rejects(
    runStagedAcceptance({
      runner: async (command, args) =>
        command === 'vercel' && args[0] === '--version'
          ? { stdout: `Vercel CLI ${config.vercel.cliVersion}\n${config.vercel.cliVersion}\n` }
          : { stdout: response('https://shadow-snap-new.vercel.app/', 'wrong body') },
      repoRoot: '/repo',
      config,
      deploymentUrl: 'shadow-snap-new.vercel.app',
    }),
    /staged_acceptance_body_marker_missing/,
  );
});

test('controller uploads intent before the external write and requires fresh authorization', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'shadow-controller-'));
  const config = await configFixture();
  const events = [];
  const facts = {
    repository: config.repository,
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
    configHash: 'a'.repeat(64),
    productionSha: '1'.repeat(40),
    currentDeploymentId: 'dpl_old',
    teamId: config.vercel.teamId,
    projectId: config.vercel.projectId,
    rootDirectory: null,
    productionDomains: config.vercel.productionDomains,
  };
  const lease = { release: async () => events.push('lease_released') };
  const controller = createReleaseController({
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
    nonce: () => 'f5d115ac-4ffc-4a7d-bec7-b4b3f7564b98',
    operations: {
      readFacts: async () => structuredClone(facts),
      acquireLease: async () => {
        events.push('lease_acquired');
        return lease;
      },
      writeIntent: async () => events.push('intent_uploaded'),
      runOperation: async () => {
        events.push('external_write');
        return { deploymentId: 'dpl_new' };
      },
      writeCompletion: async () => events.push('completion_uploaded'),
      audit: async () => ({ state: 'current' }),
      admit: async () => ({ state: 'admission_ready' }),
    },
  });

  const preview = await controller.stage({ repoRoot, config, tag: 'v1.2.3' });
  assert.equal(preview.status, 'authorization_required');
  assert.match(preview.authorizationDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(events, []);

  const result = await controller.stage({
    repoRoot,
    config,
    tag: 'v1.2.3',
    authorize: preview.authorizationDigest,
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events, [
    'lease_acquired',
    'intent_uploaded',
    'external_write',
    'completion_uploaded',
    'lease_released',
  ]);

  await assert.rejects(
    controller.stage({
      repoRoot,
      config,
      tag: 'v1.2.3',
      authorize: preview.authorizationDigest,
    }),
    /authorization_already_consumed/,
  );
});

test('controller refuses stale authorization when remote facts change', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'shadow-controller-stale-'));
  const config = await configFixture();
  let currentDeploymentId = 'dpl_old';
  const controller = createReleaseController({
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
    nonce: () => 'c3d6a564-1e3a-4a59-90b8-23abc5d3719a',
    operations: {
      readFacts: async () => ({
        repository: config.repository,
        tag: 'v1.2.3',
        targetSha: TARGET_SHA,
        configHash: 'a'.repeat(64),
        currentDeploymentId,
      }),
      acquireLease: async () => ({ release: async () => {} }),
      writeIntent: async () => {},
      runOperation: async () => {},
      writeCompletion: async () => {},
      audit: async () => ({}),
      admit: async () => ({}),
    },
  });
  const preview = await controller.promote({ repoRoot, config, tag: 'v1.2.3' });
  currentDeploymentId = 'dpl_unexpected';
  await assert.rejects(
    controller.promote({
      repoRoot,
      config,
      tag: 'v1.2.3',
      authorize: preview.authorizationDigest,
    }),
    /authorization_facts_changed/,
  );
});

test('controller acquires the lease before consuming authorization facts', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'shadow-controller-lease-race-'));
  const config = await configFixture();
  let currentDeploymentId = 'dpl_old';
  const events = [];
  const operations = {
    readFacts: async () => ({
      repository: config.repository,
      tag: 'v1.2.3',
      targetSha: TARGET_SHA,
      configHash: 'a'.repeat(64),
      currentDeploymentId,
    }),
    acquireLease: async () => {
      events.push('lease_acquired');
      currentDeploymentId = 'dpl_raced';
      return { release: async () => events.push('lease_released') };
    },
    writeIntent: async () => events.push('intent_uploaded'),
    runOperation: async () => events.push('external_write'),
    writeCompletion: async () => events.push('completion_uploaded'),
    audit: async () => ({}),
    admit: async () => ({}),
  };
  const controller = createReleaseController({
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
    nonce: () => '8b29f967-5ad0-4e3f-b0de-246242dc92a4',
    operations,
  });
  const preview = await controller.stage({ repoRoot, config, tag: 'v1.2.3' });
  await assert.rejects(
    controller.stage({
      repoRoot,
      config,
      tag: 'v1.2.3',
      authorize: preview.authorizationDigest,
    }),
    /authorization_facts_changed/,
  );
  assert.deepEqual(events, ['lease_acquired', 'lease_released']);
});

test('controller freezes after intent when the final remote recheck changes', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'shadow-controller-intent-race-'));
  const config = await configFixture();
  const facts = {
    repository: config.repository,
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
    configHash: 'a'.repeat(64),
    currentDeploymentId: 'dpl_old',
  };
  const events = [];
  const controller = createReleaseController({
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
    nonce: () => 'ee467ffa-37a1-4c0b-83a3-f1b409117512',
    operations: {
      readFacts: async () => structuredClone(facts),
      acquireLease: async () => ({ release: async () => events.push('lease_released') }),
      writeIntent: async () => {
        events.push('intent_uploaded');
        return { id: 1 };
      },
      recheckFacts: async () => {
        events.push('final_recheck');
        throw new Error('intent_facts_changed:currentDeploymentId');
      },
      runOperation: async () => events.push('external_write'),
      writeCompletion: async () => events.push('completion_uploaded'),
      audit: async () => ({}),
      admit: async () => ({}),
    },
  });
  const preview = await controller.promote({ repoRoot, config, tag: 'v1.2.3' });
  await assert.rejects(
    controller.promote({
      repoRoot,
      config,
      tag: 'v1.2.3',
      authorize: preview.authorizationDigest,
    }),
    /intent_facts_changed:currentDeploymentId/,
  );
  assert.deepEqual(events, ['intent_uploaded', 'final_recheck', 'lease_released']);
});
