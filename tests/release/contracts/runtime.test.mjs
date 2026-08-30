import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashReleaseConfig, validateReleaseConfig } from '../../../scripts/release/config.mjs';
import { canonicalJson, sha256 } from '../../../scripts/release/evidence.mjs';
import { installControllerBinding } from '../../../scripts/release/lock.mjs';
import {
  assertResumeIntentAuthority,
  createRuntime,
  readRepositoryChannel,
  validateReleaseChannel,
  verifyBillingFallback,
  verifyReleaseAssetAnchor,
} from '../../../scripts/release/runtime.mjs';

const TARGET_SHA = '2'.repeat(40);
const MAIN_SHA = '3'.repeat(40);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureConfig = JSON.parse(
  readFileSync(path.join(sourceRoot, 'config/release-production.json'), 'utf8'),
);
const TREE_ROWS = [
  `100644 blob ${'a'.repeat(40)}\t.github/workflows/release.yml`,
  `100644 blob ${'b'.repeat(40)}\t${fixtureConfig.vercel.vercelJsonPath}`,
  `100644 blob ${'c'.repeat(40)}\tconfig/release-production.json`,
];
const TREE_OUTPUT = `${TREE_ROWS.join('\0')}\0`;
const ARTIFACT_ENTRIES = TREE_ROWS.map((row) => {
  const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(row);
  return { mode: match[1], type: match[2], object: match[3], path: match[4] };
});
const ARTIFACT_MANIFEST = {
  schemaVersion: 1,
  format: 'git-ls-tree-z-v1',
  entryCount: ARTIFACT_ENTRIES.length,
  sha256: sha256(canonicalJson(ARTIFACT_ENTRIES)),
  entries: ARTIFACT_ENTRIES,
};
function repositorySlug(repository) {
  return repository.split('/').at(-1).toLowerCase();
}

function admissionArtifactName(config, tag, digest) {
  return `${repositorySlug(config.repository)}-release-admission-${tag}-${digest}`;
}

test('resume accepts only the current authoritative intent digest', () => {
  assert.throws(
    () =>
      assertResumeIntentAuthority({
        snapshot: {
          state: 'rolled_back',
          lastEvidenceDigest: 'b'.repeat(64),
        },
        found: {
          value: { state: 'promote_intent' },
          digest: 'a'.repeat(64),
        },
      }),
    /resume_intent_not_authoritative/,
  );
  assert.doesNotThrow(() =>
    assertResumeIntentAuthority({
      snapshot: {
        state: 'promote_intent',
        lastEvidenceDigest: 'a'.repeat(64),
      },
      found: {
        value: { state: 'promote_intent' },
        digest: 'a'.repeat(64),
      },
    }),
  );
});

function releaseContract(config) {
  return {
    teamId: config.vercel.teamId,
    projectId: config.vercel.projectId,
    rootDirectory: config.vercel.rootDirectory,
    productionDomains: config.vercel.productionDomains,
    vercelCliVersion: config.vercel.cliVersion,
    acceptancePath: config.acceptance.path,
    bodyMarkerSha256: createHash('sha256').update(config.acceptance.bodyIncludes).digest('hex'),
    requiredHeaders: config.acceptance.requiredHeaders,
  };
}

function hostedProof(config) {
  return {
    tag: 'v1.2.3',
    repository: config.repository,
    runId: 123,
    runAttempt: 1,
    workflow: 'Release admission',
    workflowRef: `${config.repository}/.github/workflows/release.yml@refs/tags/v1.2.3`,
    event: 'push',
    ref: 'refs/tags/v1.2.3',
    refName: 'v1.2.3',
    sha: TARGET_SHA,
    status: 'completed',
    conclusion: 'success',
  };
}

function hostedReceipt(config, admissionRaw) {
  const admissionDigest = createHash('sha256').update(admissionRaw).digest('hex');
  const admissionAsset = {
    id: 1,
    name: 'release-admission.json',
    size: Buffer.byteLength(admissionRaw),
    createdAt: '2026-08-27T23:00:00.000Z',
    sha256: admissionDigest,
  };
  return {
    schemaVersion: 1,
    kind: 'release-admission-receipt',
    repository: config.repository,
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
    admissionAsset,
    mode: 'hosted',
    hostedProof: hostedProof(config),
    billingProof: null,
    artifact: {
      id: 88,
      name: admissionArtifactName(config, 'v1.2.3', admissionDigest),
      sizeInBytes: 1,
      evidenceSha256: admissionDigest,
      archiveDigest: `sha256:${'d'.repeat(64)}`,
      expired: false,
      workflowRunId: 123,
      createdAt: '2026-08-27T23:00:00.000Z',
      expiresAt: '2026-09-26T23:00:00.000Z',
    },
    releasePublishedAt: '2026-08-27T23:30:00.000Z',
  };
}

async function tempRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shadow-runtime-'));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, '.github/workflows'), { recursive: true });
  const config = validateReleaseConfig(
    JSON.parse(await readFile(path.join(sourceRoot, 'config/release-production.json'), 'utf8')),
  );
  await writeFile(
    path.join(root, 'config/release-production.json'),
    `${JSON.stringify(config)}\n`,
  );
  await mkdir(path.join(root, path.dirname(config.vercel.vercelJsonPath)), { recursive: true });
  await writeFile(
    path.join(root, config.vercel.vercelJsonPath),
    `${JSON.stringify({ git: { deploymentEnabled: false } })}\n`,
  );
  await writeFile(
    path.join(root, '.github/workflows/release.yml'),
    'permissions:\n  contents: read\n  actions: read\nsteps:\n  - run: node scripts/release/cli.mjs admit --tag "$RELEASE_TAG" --hosted\n',
  );
  return { root, config };
}

function gitFactsRunner({
  root,
  config,
  release,
  productionSha = null,
  currentDeploymentSha = '1'.repeat(40),
} = {}) {
  const commandResults = [];
  const runner = async (command, args) => {
    commandResults.push([command, ...args]);
    if (command === 'git') {
      if (args[0] === 'status') return { stdout: '', exitCode: 0, stderrDigest: '0'.repeat(64) };
      if (args[0] === 'fetch') return { stdout: '', exitCode: 0, stderrDigest: '0'.repeat(64) };
      if (args[0] === 'rev-parse' && args[1].startsWith('refs/tags/')) {
        return { stdout: `${TARGET_SHA}\n`, exitCode: 0, stderrDigest: '0'.repeat(64) };
      }
      if (args[0] === 'rev-parse' && args[1] === 'origin/main^{commit}') {
        return { stdout: `${MAIN_SHA}\n`, exitCode: 0, stderrDigest: '0'.repeat(64) };
      }
      if (args[0] === 'merge-base') return { stdout: '', exitCode: 0, stderrDigest: '0'.repeat(64) };
      if (args[0] === 'show' && args[1].endsWith(`:${config.vercel.vercelJsonPath}`)) {
        return {
          stdout: JSON.stringify({ git: { deploymentEnabled: false } }),
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[0] === 'show' && args[1].endsWith(':config/release-production.json')) {
        return {
          stdout: JSON.stringify(config),
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[0] === 'ls-tree') {
        return {
          stdout: TREE_OUTPUT,
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[0] === 'show' && args[1].endsWith(':.github/workflows/release.yml')) {
        return {
          stdout: 'permissions:\n  contents: read\n  actions: read\nsteps:\n  - run: node scripts/release/cli.mjs admit --tag "$RELEASE_TAG" --hosted\n',
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        await mkdir(args[3], { recursive: true });
        return { stdout: '', exitCode: 0, stderrDigest: '0'.repeat(64) };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return { stdout: '', exitCode: 0, stderrDigest: '0'.repeat(64) };
      }
      if (args[0] === 'remote') {
        return {
          stdout: `https://github.com/${config.repository}.git\n`,
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[0] === 'ls-remote') {
        return {
          stdout: productionSha === null
            ? ''
            : `${productionSha}\trefs/heads/${config.productionBranch}\n`,
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        return { stdout: `${path.join(root, '.git')}\n`, exitCode: 0, stderrDigest: '0'.repeat(64) };
      }
    }
    if (command === 'vercel' && args[0] === '--version') {
      return { stdout: `Vercel CLI ${config.vercel.cliVersion}\n${config.vercel.cliVersion}\n`, exitCode: 0, stderrDigest: '0'.repeat(64) };
    }
    if (command === 'gh' && args[0] === 'api') {
      if (args[1] === `/repos/${config.repository}/actions/runs/123`) {
        return {
          stdout: JSON.stringify({
            id: 123,
            run_attempt: 1,
            head_sha: TARGET_SHA,
            path: '.github/workflows/release.yml@refs/tags/v1.2.3',
            event: 'push',
            ref: 'refs/tags/v1.2.3',
            status: 'completed',
            conclusion: 'success',
            repository: { full_name: config.repository },
          }),
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[1] === `/repos/${config.repository}/releases?per_page=100`) {
        return {
          stdout: JSON.stringify(release ? [release] : []),
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[1].includes('/releases/tags/')) {
        return { stdout: JSON.stringify(release), exitCode: 0, stderrDigest: '0'.repeat(64) };
      }
      if (args[1].includes('/actions/runs/123/artifacts')) {
        const localAdmission = await readFile(
          path.join(root, '.release-state/v1.2.3/release-admission.json'),
          'utf8',
        ).catch(() => null);
        const admissionDigest = localAdmission
          ? createHash('sha256').update(localAdmission).digest('hex')
          : '0'.repeat(64);
        return {
          stdout: JSON.stringify({
            artifacts: [{
              id: 88,
              name: admissionArtifactName(config, 'v1.2.3', admissionDigest),
              expired: false,
              size_in_bytes: 1,
              digest: `sha256:${'d'.repeat(64)}`,
              workflow_run: { id: 123 },
              created_at: '2026-08-27T23:00:00.000Z',
              expires_at: '2026-09-26T23:00:00.000Z',
            }],
          }),
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[1].includes('/releases/assets/1')) {
        const localAdmission = await readFile(
          path.join(root, '.release-state/v1.2.3/release-admission.json'),
          'utf8',
        ).catch(() => null);
        return {
          stdout: localAdmission ?? JSON.stringify({
            schemaVersion: 1,
            state: 'admission_ready',
            repository: config.repository,
            tag: 'v1.2.3',
            targetSha: TARGET_SHA,
            mainSnapshot: MAIN_SHA,
            configHash: hashReleaseConfig(config),
            mode: 'hosted',
            commands: [],
            workflowPaths: ['.github/workflows/release.yml'],
            artifactManifest: ARTIFACT_MANIFEST,
            releaseContract: releaseContract(config),
            hostedProof: hostedProof(config),
            createdAt: '2026-08-27T23:00:00.000Z',
          }),
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[1].includes('/releases/assets/2')) {
        const localReceipt = await readFile(
          path.join(root, '.release-state/v1.2.3/release-admission-receipt.json'),
          'utf8',
        ).catch(() => null);
        return {
          stdout: localReceipt ?? JSON.stringify({}),
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
    }
    if (command === 'vercel' && args[0] === 'api') {
      if (args[1].includes('/v13/deployments/dpl_old')) {
        return {
          stdout: JSON.stringify({
            id: 'dpl_old',
            url: 'old.vercel.app',
            projectId: config.vercel.projectId,
            target: 'production',
            readyState: 'READY',
            meta: { githubCommitSha: currentDeploymentSha },
          }),
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      if (args[1].includes('/domains')) {
        return {
          stdout: JSON.stringify({
            domains: config.vercel.productionDomains.map((name) => ({ name })),
          }),
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
      return {
        stdout: JSON.stringify({
          id: config.vercel.projectId,
          name: config.vercel.projectName,
          rootDirectory: config.vercel.rootDirectory,
          link: { productionBranch: 'main' },
          autoAssignCustomDomains: true,
          targets: { production: { id: 'dpl_old', url: 'old.vercel.app' } },
        }),
        exitCode: 0,
        stderrDigest: '0'.repeat(64),
      };
    }
    if (['npm', 'node', 'npx'].includes(command)) {
      return { stdout: 'ok\n', exitCode: 0, stderrDigest: '0'.repeat(64) };
    }
    throw new Error(`unexpected:${command}:${args.join(':')}`);
  };
  return { runner, commandResults };
}

test('default Admission runs only committed local gates and writes evidence', async () => {
  const { root, config } = await tempRepository();
  const base = gitFactsRunner({ root, config });
  const admissionChildOptions = [];
  const runner = async (command, args, options) => {
    if (command === 'npm' || command === 'node' || command === 'npx') admissionChildOptions.push(options);
    return base.runner(command, args, options);
  };
  const { commandResults } = base;
  const runtime = await createRuntime({
    repoRoot: root,
    runner,
    environment: {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: config.repository,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_WORKFLOW: 'Release admission',
      GITHUB_WORKFLOW_REF: `${config.repository}/.github/workflows/release.yml@refs/tags/v1.2.3`,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/tags/v1.2.3',
      GITHUB_REF_NAME: 'v1.2.3',
      GITHUB_SHA: TARGET_SHA,
    },
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
  });
  const result = await runtime.controller.admit({
    repoRoot: root,
    config,
    tag: 'v1.2.3',
    hosted: true,
    billingFallback: false,
  });
  assert.equal(result.status, 'admission_ready');
  assert.equal(result.targetSha, TARGET_SHA);
  assert.equal(result.mode, 'hosted');
  assert.equal(commandResults.some(([command]) => command === 'vercel'), false);
  assert.equal(commandResults.some(([command]) => command === 'gh'), true);
  const treeInvocation = commandResults.find(
    ([command, ...args]) => command === 'git' && args[0] === 'ls-tree',
  );
  assert.ok(treeInvocation?.includes('-r'), 'workflow tree scan must be recursive');
  assert.ok(admissionChildOptions.length >= 3);
  assert.equal(admissionChildOptions.every((options) => options.inheritEnv === false), true);
  assert.equal(admissionChildOptions.every((options) => options.env?.OPENAI_API_KEY === undefined), true);
  assert.equal(admissionChildOptions.every((options) => options.env?.GH_CONFIG_DIR), true);
  assert.equal(admissionChildOptions.every((options) => options.env?.VERCEL_TOKEN === undefined), true);
  assert.equal(
    admissionChildOptions.every(
      (options) => options.env?.NEXT_PUBLIC_SUPABASE_URL === 'https://shadow-admission.invalid',
    ),
    true,
  );
  assert.equal(
    admissionChildOptions.every(
      (options) => options.env?.SUPABASE_SERVICE_ROLE_KEY === 'shadow-admission-service-placeholder',
    ),
    true,
  );
  assert.doesNotReject(
    readFile(path.join(root, '.release-state/v1.2.3/release-admission.json')),
  );
});

test('Admission refuses an unverified local mode', async () => {
  const { root, config } = await tempRepository();
  const { runner } = gitFactsRunner({ root, config });
  const runtime = await createRuntime({
    repoRoot: root,
    runner,
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
  });
  await assert.rejects(
    runtime.controller.admit({
      repoRoot: root,
      config,
      tag: 'v1.2.3',
      hosted: false,
      billingFallback: false,
    }),
    /hosted_admission_required/,
  );
});

test('default Initialize preview binds Release, ref, Vercel identity, and Current without writes', async () => {
  const { root, config } = await tempRepository();
  const admission = {
    schemaVersion: 1,
    state: 'admission_ready',
    repository: config.repository,
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
    mainSnapshot: MAIN_SHA,
    configHash: hashReleaseConfig(config),
    mode: 'hosted',
    commands: [],
    workflowPaths: ['.github/workflows/release.yml'],
    artifactManifest: ARTIFACT_MANIFEST,
    releaseContract: releaseContract(config),
    hostedProof: hostedProof(config),
    createdAt: '2026-08-27T23:00:00.000Z',
  };
  const admissionRaw = JSON.stringify(admission);
  const receiptRaw = JSON.stringify(hostedReceipt(config, admissionRaw));
  await mkdir(path.join(root, '.release-state/v1.2.3'), { recursive: true });
  await writeFile(
    path.join(root, '.release-state/v1.2.3/release-admission.json'),
    admissionRaw,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(root, '.release-state/v1.2.3/release-admission-receipt.json'),
    receiptRaw,
    { mode: 0o600 },
  );
  const release = {
    tag_name: 'v1.2.3',
    draft: false,
    prerelease: false,
    published_at: '2026-08-27T23:30:00.000Z',
    assets: [
      {
        id: 1,
        name: 'release-admission.json',
        size: Buffer.byteLength(admissionRaw),
        created_at: '2026-08-27T23:00:00.000Z',
      },
      {
        id: 2,
        name: 'release-admission-receipt.json',
        size: Buffer.byteLength(receiptRaw),
        created_at: '2026-08-28T00:00:00.000Z',
      },
    ],
  };
  const { runner, commandResults } = gitFactsRunner({ root, config, release });
  await verifyReleaseAssetAnchor({
    runner,
    repoRoot: root,
    repository: config.repository,
    tag: 'v1.2.3',
    asset: release.assets[0],
    allowIdentityCreate: true,
  });
  await verifyReleaseAssetAnchor({
    runner,
    repoRoot: root,
    repository: config.repository,
    tag: 'v1.2.3',
    asset: release.assets[1],
    allowIdentityCreate: true,
  });
  const runtime = await createRuntime({
    repoRoot: root,
    runner,
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
    nonce: () => '5da4a280-cd59-43d7-b274-3c666af090c0',
  });
  const result = await runtime.controller.initialize({
    repoRoot: root,
    config,
    tag: 'v1.2.3',
  });
  assert.equal(result.status, 'authorization_required');
  assert.equal(result.authorization.facts.projectId, config.vercel.projectId);
  assert.equal(result.authorization.facts.currentDeploymentId, 'dpl_old');
  assert.equal(result.authorization.facts.productionSha, null);
  assert.equal(commandResults.some(([command, sub]) => command === 'git' && sub === 'push'), false);
  assert.equal(commandResults.some(([command, sub]) => command === 'vercel' && sub === 'deploy'), false);
});

test('Adopt preview binds an existing production baseline without remote writes', async () => {
  const { root, config } = await tempRepository();
  const productionSha = '1'.repeat(40);
  const admission = {
    schemaVersion: 1,
    state: 'admission_ready',
    repository: config.repository,
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
    mainSnapshot: MAIN_SHA,
    configHash: hashReleaseConfig(config),
    mode: 'hosted',
    commands: [],
    workflowPaths: ['.github/workflows/release.yml'],
    artifactManifest: ARTIFACT_MANIFEST,
    releaseContract: releaseContract(config),
    hostedProof: hostedProof(config),
    createdAt: '2026-08-27T23:00:00.000Z',
  };
  const admissionRaw = JSON.stringify(admission);
  const receiptRaw = JSON.stringify(hostedReceipt(config, admissionRaw));
  await mkdir(path.join(root, '.release-state/v1.2.3'), { recursive: true });
  await writeFile(
    path.join(root, '.release-state/v1.2.3/release-admission.json'),
    admissionRaw,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(root, '.release-state/v1.2.3/release-admission-receipt.json'),
    receiptRaw,
    { mode: 0o600 },
  );
  const release = {
    tag_name: 'v1.2.3',
    draft: false,
    prerelease: false,
    published_at: '2026-08-27T23:30:00.000Z',
    assets: [
      {
        id: 1,
        name: 'release-admission.json',
        size: Buffer.byteLength(admissionRaw),
        created_at: '2026-08-27T23:00:00.000Z',
      },
      {
        id: 2,
        name: 'release-admission-receipt.json',
        size: Buffer.byteLength(receiptRaw),
        created_at: '2026-08-28T00:00:00.000Z',
      },
    ],
  };
  const { runner, commandResults } = gitFactsRunner({
    root,
    config,
    release,
    productionSha,
    currentDeploymentSha: productionSha,
  });
  await verifyReleaseAssetAnchor({
    runner,
    repoRoot: root,
    repository: config.repository,
    tag: 'v1.2.3',
    asset: release.assets[0],
    allowIdentityCreate: true,
  });
  await verifyReleaseAssetAnchor({
    runner,
    repoRoot: root,
    repository: config.repository,
    tag: 'v1.2.3',
    asset: release.assets[1],
    allowIdentityCreate: true,
  });
  const runtime = await createRuntime({
    repoRoot: root,
    runner,
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
    nonce: () => '5da4a280-cd59-43d7-b274-3c666af090c0',
  });
  const result = await runtime.controller.adopt({
    repoRoot: root,
    config,
    tag: 'v1.2.3',
  });
  assert.equal(result.status, 'authorization_required');
  assert.equal(result.authorization.facts.productionSha, productionSha);
  assert.equal(result.authorization.facts.currentDeploymentSha, productionSha);
  assert.equal(result.authorization.facts.currentDeploymentId, 'dpl_old');
  assert.equal(commandResults.some(([command, sub]) => command === 'git' && sub === 'push'), false);
  assert.equal(commandResults.some(([command, sub]) => command === 'vercel' && sub === 'deploy'), false);

  const mismatch = gitFactsRunner({
    root,
    config,
    release,
    productionSha,
    currentDeploymentSha: '4'.repeat(40),
  });
  const mismatchRuntime = await createRuntime({ repoRoot: root, runner: mismatch.runner });
  await assert.rejects(
    mismatchRuntime.controller.adopt({ repoRoot: root, config, tag: 'v1.2.3' }),
    /adopt_current_production_mismatch/,
  );
  assert.equal(
    mismatch.commandResults.some(([command, sub]) => command === 'git' && sub === 'push'),
    false,
  );
});

test('authorized Adopt accepts its own newly uploaded intent as the latest evidence', async () => {
  const { root, config } = await tempRepository();
  const productionSha = '1'.repeat(40);
  const admission = {
    schemaVersion: 1,
    state: 'admission_ready',
    repository: config.repository,
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
    mainSnapshot: MAIN_SHA,
    configHash: hashReleaseConfig(config),
    mode: 'hosted',
    commands: [],
    workflowPaths: ['.github/workflows/release.yml'],
    artifactManifest: ARTIFACT_MANIFEST,
    releaseContract: releaseContract(config),
    hostedProof: hostedProof(config),
    createdAt: '2026-08-27T23:00:00.000Z',
  };
  const admissionRaw = canonicalJson(admission);
  const receiptRaw = canonicalJson(hostedReceipt(config, admissionRaw));
  await mkdir(path.join(root, '.release-state/v1.2.3'), { recursive: true });
  await writeFile(
    path.join(root, '.release-state/v1.2.3/release-admission.json'),
    admissionRaw,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(root, '.release-state/v1.2.3/release-admission-receipt.json'),
    receiptRaw,
    { mode: 0o600 },
  );
  const release = {
    tag_name: 'v1.2.3',
    draft: false,
    prerelease: false,
    published_at: '2026-08-27T23:30:00.000Z',
    assets: [
      {
        id: 1,
        name: 'release-admission.json',
        size: Buffer.byteLength(admissionRaw),
        created_at: '2026-08-27T23:00:00.000Z',
      },
      {
        id: 2,
        name: 'release-admission-receipt.json',
        size: Buffer.byteLength(receiptRaw),
        created_at: '2026-08-27T23:30:30.000Z',
      },
    ],
  };
  const remoteAssets = new Map([[1, admissionRaw], [2, receiptRaw]]);
  let nextAssetId = 3;
  const base = gitFactsRunner({
    root,
    config,
    release,
    productionSha,
    currentDeploymentSha: productionSha,
  });
  const runner = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') {
      const filePath = args[3];
      const raw = await readFile(filePath, 'utf8');
      const id = nextAssetId;
      nextAssetId += 1;
      remoteAssets.set(id, raw);
      release.assets.push({
        id,
        name: path.basename(filePath),
        size: Buffer.byteLength(raw),
        created_at: `2026-08-28T00:00:0${id}.000Z`,
      });
      return { stdout: '', exitCode: 0, stderrDigest: '0'.repeat(64) };
    }
    if (command === 'gh' && args[0] === 'api') {
      const match = new RegExp(`/repos/${config.repository}/releases/assets/(\\d+)$`).exec(args[1]);
      if (match && remoteAssets.has(Number(match[1]))) {
        return {
          stdout: remoteAssets.get(Number(match[1])),
          exitCode: 0,
          stderrDigest: '0'.repeat(64),
        };
      }
    }
    return base.runner(command, args, options);
  };
  for (const asset of release.assets) {
    await verifyReleaseAssetAnchor({
      runner,
      repoRoot: root,
      repository: config.repository,
      tag: 'v1.2.3',
      asset,
      allowIdentityCreate: true,
    });
  }
  await installControllerBinding({
    runner,
    repoRoot: root,
    config,
    registryPath: path.join(root, 'host-registry.json'),
  });
  let now = Date.parse('2026-08-28T00:00:00.000Z');
  const runtime = await createRuntime({
    repoRoot: root,
    runner,
    clock: () => new Date((now += 1000)),
    nonce: () => '4ca52220-91db-4dd8-a315-15ecfcd87ca5',
  });
  const preview = await runtime.controller.adopt({
    repoRoot: root,
    config,
    tag: 'v1.2.3',
  });
  const result = await runtime.controller.adopt({
    repoRoot: root,
    config,
    tag: 'v1.2.3',
    authorize: preview.authorizationDigest,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.operationResult.adopted, true);
  assert.equal(result.operationResult.productionSha, productionSha);
  assert.equal(
    release.assets.some((asset) => asset.name.startsWith('release-intent-adopt-')),
    true,
  );
  assert.equal(
    release.assets.some((asset) => asset.name.startsWith('production-adoption-')),
    true,
  );
});

test('repository channel accepts an immutable Adopt intent asset after upload', async () => {
  const { root, config } = await tempRepository();
  const admission = {
    schemaVersion: 1,
    state: 'admission_ready',
    repository: config.repository,
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
    mainSnapshot: MAIN_SHA,
    configHash: hashReleaseConfig(config),
    mode: 'hosted',
    commands: [],
    workflowPaths: ['.github/workflows/release.yml'],
    artifactManifest: ARTIFACT_MANIFEST,
    releaseContract: releaseContract(config),
    hostedProof: hostedProof(config),
    createdAt: '2026-08-27T23:00:00.000Z',
  };
  const admissionRaw = canonicalJson(admission);
  const receiptRaw = canonicalJson(hostedReceipt(config, admissionRaw));
  const intent = {
    schemaVersion: 1,
    state: 'adopt_intent',
    fromState: 'admitted',
    operation: 'adopt',
    repository: config.repository,
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
    configHash: hashReleaseConfig(config),
    createdAt: '2026-08-27T23:31:00.000Z',
  };
  const intentRaw = canonicalJson(intent);
  const intentName = 'release-intent-adopt-test-nonce.json';
  await mkdir(path.join(root, '.release-state/v1.2.3'), { recursive: true });
  await writeFile(path.join(root, '.release-state/v1.2.3/release-admission.json'), admissionRaw, {
    mode: 0o600,
  });
  await writeFile(
    path.join(root, '.release-state/v1.2.3/release-admission-receipt.json'),
    receiptRaw,
    { mode: 0o600 },
  );
  await writeFile(path.join(root, `.release-state/v1.2.3/${intentName}`), intentRaw, {
    mode: 0o600,
  });
  const release = {
    tag_name: 'v1.2.3',
    draft: false,
    prerelease: false,
    published_at: '2026-08-27T23:30:00.000Z',
    assets: [
      {
        id: 1,
        name: 'release-admission.json',
        size: Buffer.byteLength(admissionRaw),
        created_at: '2026-08-27T23:00:00.000Z',
      },
      {
        id: 2,
        name: 'release-admission-receipt.json',
        size: Buffer.byteLength(receiptRaw),
        created_at: '2026-08-27T23:30:30.000Z',
      },
      {
        id: 3,
        name: intentName,
        size: Buffer.byteLength(intentRaw),
        created_at: intent.createdAt,
      },
    ],
  };
  const base = gitFactsRunner({ root, config, release });
  const runner = async (command, args, options) => {
    if (
      command === 'gh' &&
      args[0] === 'api' &&
      args[1] === `/repos/${config.repository}/releases/assets/3`
    ) {
      return { stdout: intentRaw, exitCode: 0, stderrDigest: '0'.repeat(64) };
    }
    return base.runner(command, args, options);
  };
  for (const asset of release.assets) {
    await verifyReleaseAssetAnchor({
      runner,
      repoRoot: root,
      repository: config.repository,
      tag: 'v1.2.3',
      asset,
      allowIdentityCreate: true,
    });
  }
  const entries = await readRepositoryChannel({
    runner,
    repoRoot: root,
    config,
    clock: () => new Date('2026-08-27T23:32:00.000Z'),
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, 'adopt_intent');
  assert.match(entries[0].stateDigest, /^[0-9a-f]{64}$/);
});

test('remote Audit validates the full anchored release and freezes Vercel drift', async () => {
  const { root, config } = await tempRepository();
  await mkdir(path.join(root, '.git'), { recursive: true });
  const admission = {
    schemaVersion: 1,
    state: 'admission_ready',
    repository: config.repository,
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
    mainSnapshot: MAIN_SHA,
    configHash: hashReleaseConfig(config),
    mode: 'hosted',
    commands: [],
    workflowPaths: ['.github/workflows/release.yml'],
    artifactManifest: ARTIFACT_MANIFEST,
    releaseContract: releaseContract(config),
    hostedProof: hostedProof(config),
    createdAt: '2026-08-27T23:00:00.000Z',
  };
  const admissionRaw = JSON.stringify(admission);
  const receiptRaw = JSON.stringify(hostedReceipt(config, admissionRaw));
  await mkdir(path.join(root, '.release-state/v1.2.3'), { recursive: true });
  await writeFile(
    path.join(root, '.release-state/v1.2.3/release-admission.json'),
    admissionRaw,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(root, '.release-state/v1.2.3/release-admission-receipt.json'),
    receiptRaw,
    { mode: 0o600 },
  );
  const release = {
    tag_name: 'v1.2.3',
    draft: false,
    prerelease: false,
    published_at: '2026-08-27T23:30:00.000Z',
    assets: [
      {
        id: 1,
        name: 'release-admission.json',
        size: Buffer.byteLength(admissionRaw),
        created_at: '2026-08-27T23:00:00.000Z',
      },
      {
        id: 2,
        name: 'release-admission-receipt.json',
        size: Buffer.byteLength(receiptRaw),
        created_at: '2026-08-28T00:00:00.000Z',
      },
    ],
  };
  const fixture = gitFactsRunner({ root, config, release });
  await verifyReleaseAssetAnchor({
    runner: fixture.runner,
    repoRoot: root,
    repository: config.repository,
    tag: 'v1.2.3',
    asset: release.assets[0],
    allowIdentityCreate: true,
  });
  await verifyReleaseAssetAnchor({
    runner: fixture.runner,
    repoRoot: root,
    repository: config.repository,
    tag: 'v1.2.3',
    asset: release.assets[1],
    allowIdentityCreate: true,
  });
  await installControllerBinding({
    runner: fixture.runner,
    repoRoot: root,
    config,
    registryPath: path.join(root, 'host-registry.json'),
  });
  const runtime = await createRuntime({
    repoRoot: root,
    runner: fixture.runner,
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
  });
  const passed = await runtime.controller.audit({
    repoRoot: root,
    config,
    tag: 'v1.2.3',
  });
  assert.equal(passed.status, 'passed');
  assert.equal(passed.state, 'admitted');
  assert.equal(passed.artifactManifestSha256, ARTIFACT_MANIFEST.sha256);
  assert.equal(
    fixture.commandResults.some(
      ([command, endpoint]) =>
        command === 'gh' && typeof endpoint === 'string' && endpoint.includes('/actions/runs/'),
    ),
    false,
  );

  const driftRunner = async (command, args, options) => {
    if (
      command === 'vercel' &&
      args[0] === 'api' &&
      args[1].startsWith(`/v9/projects/${config.vercel.projectId}?`)
    ) {
      return {
        stdout: JSON.stringify({
          id: config.vercel.projectId,
          name: 'wrong-project',
          rootDirectory: config.vercel.rootDirectory,
          link: { productionBranch: 'main' },
          autoAssignCustomDomains: true,
          targets: { production: { id: 'dpl_old', url: 'old.vercel.app' } },
        }),
        exitCode: 0,
      };
    }
    return fixture.runner(command, args, options);
  };
  const driftRuntime = await createRuntime({
    repoRoot: root,
    runner: driftRunner,
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
  });
  const failed = await driftRuntime.controller.audit({
    repoRoot: root,
    config,
    tag: 'v1.2.3',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.state, 'drift_freeze');
  assert.equal(failed.findings[0].reasonCode, 'vercel_project_name_mismatch');
});

test('anchor-admission persists hosted run and artifact proof in a durable receipt', async () => {
  const { root, config } = await tempRepository();
  const admission = {
    schemaVersion: 1,
    state: 'admission_ready',
    repository: config.repository,
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
    mainSnapshot: MAIN_SHA,
    configHash: hashReleaseConfig(config),
    mode: 'hosted',
    commands: [],
    workflowPaths: ['.github/workflows/release.yml'],
    artifactManifest: ARTIFACT_MANIFEST,
    releaseContract: releaseContract(config),
    hostedProof: hostedProof(config),
    createdAt: '2026-08-27T23:00:00.000Z',
  };
  // Hosted admission evidence is canonicalized before it is uploaded. The
  // manifest digest must therefore survive recursive object-key sorting and a
  // subsequent parse instead of depending on JavaScript insertion order.
  const admissionRaw = canonicalJson(admission);
  await mkdir(path.join(root, '.release-state/v1.2.3'), { recursive: true });
  await writeFile(
    path.join(root, '.release-state/v1.2.3/release-admission.json'),
    admissionRaw,
    { mode: 0o600 },
  );
  const release = {
    tag_name: 'v1.2.3',
    draft: false,
    prerelease: false,
    published_at: '2026-08-27T23:30:00.000Z',
    assets: [{
      id: 1,
      name: 'release-admission.json',
      size: Buffer.byteLength(admissionRaw),
      created_at: '2026-08-27T23:00:00.000Z',
    }],
  };
  const base = gitFactsRunner({ root, config, release });
  let uploadAttempts = 0;
  const runner = async (command, args, options) => {
    if (command === 'gh' && args[0] === 'release' && args[1] === 'upload') {
      uploadAttempts += 1;
      const filePath = args[3];
      const receiptRaw = await readFile(filePath, 'utf8');
      if (uploadAttempts === 1) {
        throw new Error('simulated_upload_failure');
      }
      release.assets.push({
        id: 2,
        name: 'release-admission-receipt.json',
        size: Buffer.byteLength(receiptRaw),
        created_at: '2026-08-28T00:00:00.000Z',
      });
      return { stdout: '', exitCode: 0, stderrDigest: '0'.repeat(64) };
    }
    return base.runner(command, args, options);
  };
  const runtime = await createRuntime({
    repoRoot: root,
    runner,
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
  });
  const preview = await runtime.controller['anchor-admission']({
    repoRoot: root,
    config,
    tag: 'v1.2.3',
    assetId: 1,
  });
  assert.equal(preview.status, 'authorization_required');
  await installControllerBinding({
    runner,
    repoRoot: root,
    config,
    registryPath: path.join(root, 'host-registry.json'),
  });
  await assert.rejects(
    runtime.controller['anchor-admission']({
      repoRoot: root,
      config,
      tag: 'v1.2.3',
      assetId: 1,
      authorize: preview.authorizationDigest,
    }),
    /simulated_upload_failure/,
  );
  const retryPreview = await runtime.controller['anchor-admission']({
    repoRoot: root,
    config,
    tag: 'v1.2.3',
    assetId: 1,
  });
  const result = await runtime.controller['anchor-admission']({
    repoRoot: root,
    config,
    tag: 'v1.2.3',
    assetId: 1,
    authorize: retryPreview.authorizationDigest,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.operationResult.receiptIdentity.id, 2);
  const receipt = JSON.parse(
    await readFile(path.join(root, '.release-state/v1.2.3/release-admission-receipt.json'), 'utf8'),
  );
  assert.equal(receipt.kind, 'release-admission-receipt');
  assert.equal(receipt.releasePublishedAt, release.published_at);
  assert.equal(receipt.artifact.id, 88);
  assert.equal(receipt.artifact.evidenceSha256, preview.authorization.facts.admissionIdentity.sha256);

  const forgedRunner = async (command, args, options) => {
    if (
      command === 'gh' &&
      args[0] === 'api' &&
      args[1] === `/repos/${config.repository}/actions/runs/123`
    ) {
      const remote = JSON.parse((await base.runner(command, args, options)).stdout);
      remote.head_sha = '4'.repeat(40);
      return { stdout: JSON.stringify(remote), exitCode: 0 };
    }
    return runner(command, args, options);
  };
  const forgedRuntime = await createRuntime({
    repoRoot: root,
    runner: forgedRunner,
    clock: () => new Date('2026-08-28T00:00:00.000Z'),
  });
  await assert.rejects(
    forgedRuntime.controller['anchor-admission']({
      repoRoot: root,
      config,
      tag: 'v1.2.3',
      assetId: 1,
    }),
    /hosted_admission_run_binding_mismatch/,
  );
});

test('Billing fallback accepts only a failed zero-step run with a billing annotation', async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    const endpoint = args[1];
    if (endpoint.includes('/actions/workflows/release.yml/runs')) {
      return {
        stdout: JSON.stringify({
          workflow_runs: [
            {
              id: 44,
              head_sha: TARGET_SHA,
              head_branch: 'v1.2.3',
              event: 'push',
              path: '.github/workflows/release.yml@refs/tags/v1.2.3',
              run_attempt: 1,
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        }),
      };
    }
    if (endpoint.includes('/actions/runs/44/jobs')) {
      return {
        stdout: JSON.stringify({
          jobs: [{
            id: 55,
            run_id: 44,
            head_sha: TARGET_SHA,
            check_run_url: 'https://api.github.com/repos/WardLu/shadow-snap/check-runs/66',
            name: 'admission',
            conclusion: 'failure',
            status: 'completed',
            steps: [],
          }],
        }),
      };
    }
    if (endpoint.includes(`/commits/${TARGET_SHA}/check-runs`)) {
      return {
        stdout: JSON.stringify({
          check_runs: [
            {
              id: 66,
              name: 'admission',
              conclusion: 'failure',
              output: { annotations_count: 1 },
            },
          ],
        }),
      };
    }
    if (endpoint.includes('/check-runs/66/annotations')) {
      return {
        stdout: JSON.stringify([
          { message: 'The job was not started because of a billing or spending limit issue.' },
        ]),
      };
    }
    throw new Error(`unexpected:${endpoint}`);
  };
  const proof = await verifyBillingFallback({
    runner,
    repoRoot: '/repo',
    repository: 'WardLu/shadow-snap',
    tag: 'v1.2.3',
    targetSha: TARGET_SHA,
  });
  assert.deepEqual(proof, {
    repository: 'WardLu/shadow-snap',
    tag: 'v1.2.3',
    workflowPath: '.github/workflows/release.yml',
    workflowRef: 'WardLu/shadow-snap/.github/workflows/release.yml@refs/tags/v1.2.3',
    event: 'push',
    headSha: TARGET_SHA,
    workflowRunId: 44,
    workflowRunAttempt: 1,
    jobId: 55,
    checkRunId: 66,
    stepCount: 0,
    annotationSha256: proof.annotationSha256,
  });
  assert.match(proof.annotationSha256, /^[0-9a-f]{64}$/);
  assert.equal(calls.length, 4);
});

test('Billing fallback rejects code steps or non-billing failures', async () => {
  const baseRunner = async (command, args) => {
    const endpoint = args[1];
    if (endpoint.includes('/actions/workflows/release.yml/runs')) {
      return {
        stdout: JSON.stringify({
          workflow_runs: [
            { id: 44, head_sha: TARGET_SHA, head_branch: 'v1.2.3', event: 'push', path: '.github/workflows/release.yml@refs/tags/v1.2.3', run_attempt: 1, status: 'completed', conclusion: 'failure' },
          ],
        }),
      };
    }
    if (endpoint.includes('/actions/runs/44/jobs')) {
      return {
        stdout: JSON.stringify({
          jobs: [{ id: 55, run_id: 44, head_sha: TARGET_SHA, check_run_url: 'https://api.github.com/repos/WardLu/shadow-snap/check-runs/66', name: 'admission', conclusion: 'failure', status: 'completed', steps: [{ name: 'npm test' }] }],
        }),
      };
    }
    throw new Error('annotation_should_not_be_read');
  };
  await assert.rejects(
    verifyBillingFallback({
      runner: baseRunner,
      repoRoot: '/repo',
      repository: 'WardLu/shadow-snap',
      tag: 'v1.2.3',
      targetSha: TARGET_SHA,
    }),
    /billing_fallback_code_steps_started/,
  );
});

test('Billing fallback rejects a billing run when another run for the same SHA executed code', async () => {
  const runner = async (command, args) => {
    const endpoint = args[1];
    if (endpoint.includes('/actions/workflows/release.yml/runs')) {
      return {
        stdout: JSON.stringify({
          workflow_runs: [
            { id: 45, head_sha: TARGET_SHA, head_branch: 'v1.2.3', event: 'push', path: '.github/workflows/release.yml@refs/tags/v1.2.3', run_attempt: 1, status: 'completed', conclusion: 'failure' },
            { id: 44, head_sha: TARGET_SHA, head_branch: 'v1.2.3', event: 'push', path: '.github/workflows/release.yml@refs/tags/v1.2.3', run_attempt: 1, status: 'completed', conclusion: 'failure' },
          ],
        }),
      };
    }
    if (endpoint.includes('/actions/runs/45/jobs')) {
      return {
        stdout: JSON.stringify({
          jobs: [{ id: 55, run_id: 45, head_sha: TARGET_SHA, name: 'admission', conclusion: 'failure', status: 'completed', steps: [], check_run_url: 'https://api.github.com/repos/WardLu/shadow-snap/check-runs/66' }],
        }),
      };
    }
    if (endpoint.includes('/actions/runs/44/jobs')) {
      return {
        stdout: JSON.stringify({
          jobs: [{ id: 54, run_id: 44, head_sha: TARGET_SHA, name: 'admission', conclusion: 'failure', status: 'completed', steps: [{ name: 'npm test' }] }],
        }),
      };
    }
    throw new Error(`unexpected:${endpoint}`);
  };
  await assert.rejects(
    verifyBillingFallback({
      runner,
      repoRoot: '/repo',
      repository: 'WardLu/shadow-snap',
      tag: 'v1.2.3',
      targetSha: TARGET_SHA,
      expectedProof: {
        workflowRunId: 45,
        workflowRunAttempt: 1,
        jobId: 55,
        checkRunId: 66,
        annotationSha256: 'a'.repeat(64),
      },
    }),
    /billing_fallback_code_steps_started/,
  );
});

test('Billing fallback fails closed for non-terminal or non-failure workflow runs', async () => {
  for (const run of [
    { id: 70, head_sha: TARGET_SHA, head_branch: 'v1.2.3', event: 'push', path: '.github/workflows/release.yml@refs/tags/v1.2.3', run_attempt: 1, status: 'in_progress', conclusion: null },
    { id: 71, head_sha: TARGET_SHA, head_branch: 'v1.2.3', event: 'push', path: '.github/workflows/release.yml@refs/tags/v1.2.3', run_attempt: 1, status: 'completed', conclusion: 'cancelled' },
  ]) {
    const runner = async (command, args) => {
      const endpoint = args[1];
      if (endpoint.includes('/actions/workflows/release.yml/runs')) {
        return { stdout: JSON.stringify({ workflow_runs: [run] }) };
      }
      throw new Error(`unexpected:${endpoint}`);
    };
    await assert.rejects(
      verifyBillingFallback({
        runner,
        repoRoot: '/repo',
        repository: 'WardLu/shadow-snap',
        tag: 'v1.2.3',
        targetSha: TARGET_SHA,
      }),
      run.status === 'completed'
        ? /billing_fallback_run_conclusion_invalid/
        : /billing_fallback_run_not_terminal/,
    );
  }
});

test('Billing fallback scans all paginated runs before choosing a candidate', async () => {
  const runner = async (command, args) => {
    const endpoint = args[1];
    if (endpoint.includes('/actions/workflows/release.yml/runs')) {
      return {
        stdout: JSON.stringify([
          {
            workflow_runs: [
              { id: 80, head_sha: TARGET_SHA, head_branch: 'v1.2.3', event: 'push', path: '.github/workflows/release.yml@refs/tags/v1.2.3', run_attempt: 1, status: 'completed', conclusion: 'failure' },
            ],
          },
          {
            workflow_runs: [
              { id: 81, head_sha: TARGET_SHA, head_branch: 'v1.2.3', event: 'push', path: '.github/workflows/release.yml@refs/tags/v1.2.3', run_attempt: 1, status: 'completed', conclusion: 'failure' },
            ],
          },
        ]),
      };
    }
    if (endpoint.includes('/actions/runs/80/jobs')) {
      return { stdout: JSON.stringify([{ jobs: [{ id: 800, run_id: 80, head_sha: TARGET_SHA, status: 'completed', conclusion: 'failure', name: 'admission', steps: [] }] }]) };
    }
    if (endpoint.includes('/actions/runs/81/jobs')) {
      return { stdout: JSON.stringify([{ jobs: [{ id: 810, run_id: 81, head_sha: TARGET_SHA, status: 'completed', conclusion: 'failure', name: 'admission', steps: [{ name: 'npm test' }] }] }]) };
    }
    throw new Error(`unexpected:${endpoint}`);
  };
  await assert.rejects(
    verifyBillingFallback({
      runner,
      repoRoot: '/repo',
      repository: 'WardLu/shadow-snap',
      tag: 'v1.2.3',
      targetSha: TARGET_SHA,
      expectedProof: {
        workflowRunId: 80,
        workflowRunAttempt: 1,
        jobId: 800,
        checkRunId: 801,
        annotationSha256: 'a'.repeat(64),
      },
    }),
    /billing_fallback_code_steps_started/,
  );
});

test('Billing fallback isolates tags that share the same commit SHA', async () => {
  const runner = async (command, args) => {
    const endpoint = args[1];
    if (endpoint.includes('/actions/workflows/release.yml/runs')) {
      return {
        stdout: JSON.stringify({
          workflow_runs: [
            { id: 90, head_sha: TARGET_SHA, head_branch: 'v1.2.3', event: 'push', path: '.github/workflows/release.yml@refs/tags/v1.2.3', run_attempt: 1, status: 'completed', conclusion: 'success' },
            { id: 91, head_sha: TARGET_SHA, head_branch: 'v1.2.4', event: 'push', path: '.github/workflows/release.yml@refs/tags/v1.2.4', run_attempt: 1, status: 'completed', conclusion: 'failure' },
          ],
        }),
      };
    }
    if (endpoint.includes('/actions/runs/91/jobs')) {
      return {
        stdout: JSON.stringify({
          jobs: [{ id: 910, run_id: 91, head_sha: TARGET_SHA, status: 'completed', conclusion: 'failure', name: 'admission', steps: [], check_run_url: 'https://api.github.com/repos/WardLu/shadow-snap/check-runs/911' }],
        }),
      };
    }
    if (endpoint.includes(`/commits/${TARGET_SHA}/check-runs`)) {
      return {
        stdout: JSON.stringify({
          check_runs: [{ id: 911, name: 'admission', conclusion: 'failure', output: { annotations_count: 1 } }],
        }),
      };
    }
    if (endpoint.includes('/check-runs/911/annotations')) {
      return { stdout: JSON.stringify([{ message: 'billing spending limit prevented the job from starting' }]) };
    }
    throw new Error(`unexpected:${endpoint}`);
  };
  const proof = await verifyBillingFallback({
    runner,
    repoRoot: '/repo',
    repository: 'WardLu/shadow-snap',
    tag: 'v1.2.4',
    targetSha: TARGET_SHA,
  });
  assert.equal(proof.tag, 'v1.2.4');
  assert.equal(proof.workflowRunId, 91);
});

test('release asset anchor freezes on byte or identity replacement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shadow-asset-anchor-'));
  const directory = path.join(root, '.release-state/v1.2.3');
  await mkdir(directory, { recursive: true });
  const raw = '{"state":"admitted"}\n';
  await writeFile(path.join(directory, 'release-admission.json'), raw, { mode: 0o600 });
  let remoteRaw = raw;
  const runner = async () => ({ stdout: remoteRaw });
  const asset = {
    id: 1,
    name: 'release-admission.json',
    size: Buffer.byteLength(raw),
    created_at: '2026-08-28T00:00:00.000Z',
  };
  await verifyReleaseAssetAnchor({
    runner,
    repoRoot: root,
    repository: 'WardLu/shadow-snap',
    tag: 'v1.2.3',
    asset,
    allowIdentityCreate: true,
  });
  await assert.rejects(
    verifyReleaseAssetAnchor({
      runner,
      repoRoot: root,
      repository: 'WardLu/shadow-snap',
      tag: 'v1.2.3',
      asset: { ...asset, id: 2 },
    }),
    /release_asset_identity_changed/,
  );
  remoteRaw = '{"state":"current"}\n';
  await assert.rejects(
    verifyReleaseAssetAnchor({
      runner,
      repoRoot: root,
      repository: 'WardLu/shadow-snap',
      tag: 'v1.2.3',
      asset: { ...asset, size: Buffer.byteLength(remoteRaw) },
    }),
    /release_asset_digest_or_size_mismatch/,
  );
});

test('repository channel blocks another pending Release and allows only its exact Recovery', () => {
  const entries = [
    { tag: 'v1.3.0', state: 'admitted', superseded: false },
    {
      tag: 'v1.2.0',
      state: 'stage_intent',
      stateDigest: 'a'.repeat(64),
      superseded: false,
    },
  ];
  assert.throws(
    () =>
      validateReleaseChannel({
        entries,
        targetTag: 'v1.3.0',
        operation: 'stage',
      }),
    /release_channel_occupied:v1.2.0:stage_intent/,
  );
  assert.equal(
    validateReleaseChannel({
      entries,
      targetTag: 'v1.3.0',
      operation: 'recover',
      recoverySource: {
        tag: 'v1.2.0',
        state: 'stage_intent',
        digest: 'a'.repeat(64),
      },
    }).status,
    'recovery_source_valid',
  );
  assert.throws(
    () =>
      validateReleaseChannel({
        entries: [...entries, { tag: 'v1.1.0', state: 'rolled_back' }],
        targetTag: 'v1.3.0',
        operation: 'recover',
        recoverySource: { tag: 'v1.2.0', state: 'stage_intent' },
      }),
    /recovery_channel_source_not_unique/,
  );
});
