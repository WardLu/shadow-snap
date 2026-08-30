import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { hashReleaseConfig, loadReleaseConfig } from './config.mjs';
import { createReleaseController } from './controller.mjs';
import {
  canonicalJson,
  sha256,
  uploadUniqueReleaseAsset,
  writeLocalEvidence,
} from './evidence.mjs';
import {
  getReleaseByTag,
  readReleaseAssetDocument,
  readRemoteBranchSha,
  resolveGitHubRepository,
} from './github.mjs';
import {
  acquireReleaseLease,
  readControllerBinding,
  writeProductionCapability,
} from './lock.mjs';
import { scanWorkflowText, verifyTargetTree } from './policy.mjs';
import { createCommandRunner } from './process.mjs';
import { clearStaleReleaseLease } from './unlock.mjs';
import { deriveReleaseState, reconcileIntent } from './state.mjs';
import {
  createStagedDeployment,
  inspectDeployment,
  listMatchingStagedDeployments,
  promoteDeployment,
  readVercelProjectFacts,
  restoreAutoAssignSetting,
  rollbackDeployment,
  runProductionAcceptance,
  runStagedAcceptance,
  verifyVercelCliVersion,
} from './vercel.mjs';

const ZERO_SHA = '0'.repeat(40);
const ADMISSION_RECEIPT_ASSET = 'release-admission-receipt.json';
const ADMISSION_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'CI',
  'LANG',
  'LC_ALL',
  'TZ',
];

const ADMISSION_BUILD_ENV = Object.freeze({
  NEXT_PUBLIC_SUPABASE_URL: 'https://shadow-admission.invalid',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'shadow-admission-public-placeholder',
  SUPABASE_SERVICE_ROLE_KEY: 'shadow-admission-service-placeholder',
  DATABASE_URL: 'postgresql://127.0.0.1:5432/shadow_admission',
  DIRECT_URL: 'postgresql://127.0.0.1:5432/shadow_admission',
});

function admissionChildEnvironment(environment, homeDirectory, temporaryDirectory) {
  const child = {};
  for (const key of ADMISSION_ENV_KEYS) {
    if (typeof environment?.[key] === 'string') child[key] = environment[key];
  }
  child.PATH ??= '/usr/bin:/bin';
  child.HOME = homeDirectory;
  child.TMPDIR = temporaryDirectory;
  child.XDG_CONFIG_HOME = path.join(homeDirectory, 'config');
  child.XDG_DATA_HOME = path.join(homeDirectory, 'data');
  child.XDG_CACHE_HOME = path.join(homeDirectory, 'cache');
  child.GH_CONFIG_DIR = path.join(homeDirectory, 'gh');
  child.CI = 'true';
  Object.assign(child, ADMISSION_BUILD_ENV);
  return child;
}

function fail(reasonCode) {
  throw new Error(reasonCode);
}

const AUTO_ASSIGN_SETTING_WRITE = Object.freeze({
  field: 'autoAssignCustomDomains',
  value: false,
});
const RELEASE_INTENT_STATE = /^(?:adopt|initialize|stage|promote|rollback|renew|fail)_intent$/;

function hasAuthorizedSettingsWrite(settingsWrites) {
  return Array.isArray(settingsWrites) && settingsWrites.some(
    (entry) => entry?.field === AUTO_ASSIGN_SETTING_WRITE.field && entry?.value === false,
  );
}

function repositorySlug(repository) {
  const match = /^\s*[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+)\s*$/.exec(repository ?? '');
  if (!match) fail('repository_invalid');
  return match[1].toLowerCase();
}

function admissionArtifactName(repository, tag, digest) {
  return `${repositorySlug(repository)}-release-admission-${tag}-${digest}`;
}

function completionState(operation) {
  return {
    adopt: 'adopted',
    initialize: 'initialized',
    stage: 'staged_pending_promote',
    promote: 'current',
    rollback: 'rolled_back',
    recover: 'recovery_admitted',
  }[operation];
}

function assertArtifactManifest(manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.format !== 'git-ls-tree-z-v1' ||
    !Number.isInteger(manifest.entryCount) ||
    manifest.entryCount <= 0 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length !== manifest.entryCount ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256 ?? '')
  ) fail('release_artifact_manifest_invalid');
  for (const entry of manifest.entries) {
    if (
      !/^\d{6}$/.test(entry?.mode ?? '') ||
      !['blob', 'tree', 'commit'].includes(entry?.type) ||
      !/^[0-9a-f]{40,64}$/.test(entry?.object ?? '') ||
      typeof entry?.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.includes('\0')
    ) fail('release_artifact_manifest_invalid');
  }
  const digest = sha256(canonicalJson(manifest.entries));
  if (digest !== manifest.sha256) fail('release_artifact_manifest_digest_mismatch');
  return manifest;
}

function releaseContract(config) {
  return {
    teamId: config.vercel.teamId,
    projectId: config.vercel.projectId,
    rootDirectory: config.vercel.rootDirectory,
    productionDomains: config.vercel.productionDomains,
    vercelCliVersion: config.vercel.cliVersion,
    acceptancePath: config.acceptance.path,
    bodyMarkerSha256: sha256(config.acceptance.bodyIncludes),
    requiredHeaders: config.acceptance.requiredHeaders,
  };
}

function assertCompletionAcceptance(value, contract) {
  if (value.state === 'staged_pending_promote') {
    const acceptance = value.operationResult?.stagedAcceptance;
    if (
      acceptance?.kind !== 'staged' ||
      !/^[0-9a-f]{64}$/.test(acceptance.responseSha256 ?? '') ||
      acceptance.path !== contract.acceptancePath
    ) fail('staged_acceptance_evidence_invalid');
  }
  if (['current', 'rolled_back'].includes(value.state)) {
    const acceptance = value.operationResult?.productionAcceptance;
    if (
      acceptance?.kind !== 'production' ||
      !Array.isArray(acceptance.domains) ||
      canonicalJson(acceptance.domains.map(({ domain }) => domain)) !==
        canonicalJson(contract.productionDomains) ||
      acceptance.domains.some(
        (entry) =>
          entry.path !== contract.acceptancePath ||
          !/^[0-9a-f]{64}$/.test(entry.responseSha256 ?? ''),
      )
    ) fail('production_acceptance_evidence_invalid');
  }
}

export async function verifyReleaseAssetAnchor({
  runner,
  repoRoot,
  repository,
  tag,
  asset,
  allowIdentityCreate = false,
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(asset?.name ?? '')) {
    fail('release_asset_name_invalid');
  }
  if (!Number.isInteger(asset.id) || !Number.isInteger(asset.size)) {
    fail('release_asset_metadata_invalid');
  }
  const localPath = path.join(repoRoot, '.release-state', tag, asset.name);
  let localBytes;
  try {
    const localStats = await stat(localPath);
    if ((localStats.mode & 0o777) !== 0o600) fail('local_release_asset_mode_invalid');
    localBytes = await readFile(localPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') fail('local_release_asset_anchor_missing');
    throw error;
  }
  const document = await readReleaseAssetDocument({
    runner,
    repoRoot,
    repository,
    asset,
  });
  const remoteDigest = sha256(document.raw);
  if (
    sha256(localBytes) !== remoteDigest ||
    Buffer.byteLength(document.raw) !== asset.size
  ) {
    fail('release_asset_digest_or_size_mismatch');
  }
  const identity = {
    id: asset.id,
    name: asset.name,
    size: asset.size,
    createdAt: asset.created_at,
    sha256: remoteDigest,
  };
  if (typeof identity.createdAt !== 'string') fail('release_asset_created_at_missing');

  let allowCreate = allowIdentityCreate;
  let pendingSha256 = null;
  if (!allowCreate) {
    const pendingPath = path.join(
      repoRoot,
      '.release-state',
      tag,
      `upload-pending-${identity.name}`,
    );
    try {
      const pendingStats = await stat(pendingPath);
      if ((pendingStats.mode & 0o777) !== 0o600) fail('upload_pending_mode_invalid');
      const pendingRaw = await readFile(pendingPath, 'utf8');
      const pending = JSON.parse(pendingRaw);
      allowCreate =
        pending.schemaVersion === 1 &&
        pending.repository === repository &&
        pending.tag === tag &&
        pending.name === identity.name &&
        pending.size === identity.size &&
        pending.sha256 === identity.sha256;
      if (allowCreate) pendingSha256 = sha256(pendingRaw);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  await recordReleaseAssetIdentity({
    repoRoot,
    repository,
    tag,
    identity,
    allowCreate,
    pendingSha256,
  });
  return { value: document.value, digest: remoteDigest, identity };
}

async function recordReleaseAssetIdentity({
  repoRoot,
  repository,
  tag,
  identity,
  allowCreate,
  pendingSha256 = null,
}) {
  const ledgerPath = path.join(repoRoot, '.release-state', tag, 'asset-ledger.json');
  const claimPath = `${ledgerPath}.claim`;
  try {
    await mkdir(claimPath, { mode: 0o700 });
  } catch (error) {
    fail(error?.code === 'EEXIST' ? 'asset_ledger_claim_active' : 'asset_ledger_claim_failed');
  }
  try {
    let ledger = { schemaVersion: 1, repository, tag, assets: {}, consumedUploads: {} };
    let ledgerExists = true;
    try {
    const ledgerStats = await stat(ledgerPath);
    if ((ledgerStats.mode & 0o777) !== 0o600) fail('asset_ledger_mode_invalid');
    ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      ledgerExists = false;
    }
    if (
    ledger.schemaVersion !== 1 ||
    ledger.repository !== repository ||
    ledger.tag !== tag ||
      !ledger.assets
    ) fail('asset_ledger_shape_invalid');
    ledger.consumedUploads ??= {};
    const anchored = ledger.assets[identity.name];
    if (anchored) {
      if (canonicalJson(anchored) !== canonicalJson(identity)) {
        fail('release_asset_identity_changed');
      }
    } else {
      if (ledger.consumedUploads[identity.name]) {
        fail('upload_pending_already_consumed');
      }
      if (!allowCreate || (!ledgerExists && identity.name !== 'release-admission.json')) {
        fail('release_asset_identity_anchor_missing');
      }
      ledger.assets[identity.name] = identity;
      if (pendingSha256) ledger.consumedUploads[identity.name] = pendingSha256;
      const temporaryPath = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, canonicalJson(ledger), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, ledgerPath);
    }
  } finally {
    await rmdir(claimPath).catch(() => {});
  }
}

async function uploadAndAnchorReleaseAsset({ runner, repoRoot, config, tag, filePath }) {
  const name = path.basename(filePath);
  const bytes = await readFile(filePath);
  const pending = await writeLocalEvidence({
    repoRoot,
    tag,
    fileName: `upload-pending-${name}`,
    value: {
      schemaVersion: 1,
      repository: config.repository,
      tag,
      name,
      size: bytes.length,
      sha256: sha256(bytes),
    },
  });
  if (!pending) fail('upload_pending_journal_missing');
  let uploaded;
  try {
    uploaded = await uploadUniqueReleaseAsset({ runner, repoRoot, tag, filePath });
  } catch (error) {
    if (error.message !== 'release_asset_already_exists') throw error;
    const { repository, release } = await getReleaseByTag({ runner, repoRoot, tag });
    const matches = release.assets.filter((asset) => asset.name === name);
    if (repository !== config.repository || matches.length !== 1) {
      fail('upload_pending_remote_asset_ambiguous');
    }
    return verifyReleaseAssetAnchor({
      runner,
      repoRoot,
      repository,
      tag,
      asset: matches[0],
    }).then(({ identity }) => identity);
  }
  await recordReleaseAssetIdentity({
    repoRoot,
    repository: config.repository,
    tag,
    identity: uploaded,
    allowCreate: true,
    pendingSha256: pending.sha256,
  });
  return uploaded;
}

async function githubApiJson({ runner, repoRoot, endpoint, reasonCode }) {
  const result = await runner('gh', ['api', endpoint], { cwd: repoRoot });
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(reasonCode);
  }
}

function hostedEnvironmentProof({ environment, config, tag, targetSha }) {
  const required = {
    repository: environment?.GITHUB_REPOSITORY,
    runId: Number(environment?.GITHUB_RUN_ID),
    runAttempt: Number(environment?.GITHUB_RUN_ATTEMPT),
    workflow: environment?.GITHUB_WORKFLOW,
    workflowRef: environment?.GITHUB_WORKFLOW_REF,
    event: environment?.GITHUB_EVENT_NAME,
    ref: environment?.GITHUB_REF,
    refName: environment?.GITHUB_REF_NAME,
    sha: environment?.GITHUB_SHA,
  };
  if (
    environment?.GITHUB_ACTIONS !== 'true' ||
    required.repository !== config.repository ||
    !Number.isInteger(required.runId) ||
    !Number.isInteger(required.runAttempt) ||
    !required.workflow ||
    !required.workflowRef ||
    !['push', 'workflow_dispatch'].includes(required.event) ||
    required.ref !== `refs/tags/${tag}` ||
    required.refName !== tag ||
    required.sha !== targetSha ||
    required.workflowRef !==
      `${config.repository}/.github/workflows/release.yml@refs/tags/${tag}`
  ) {
    fail('hosted_admission_context_invalid');
  }
  return { tag, ...required };
}

async function verifyHostedRunProof({
  runner,
  repoRoot,
  config,
  targetSha,
  proof,
  requireCompleted,
  admissionDigest = null,
}) {
  if (
    proof?.repository !== config.repository ||
    !Number.isInteger(proof.runId) ||
    !Number.isInteger(proof.runAttempt) ||
    !['push', 'workflow_dispatch'].includes(proof.event) ||
    proof.ref !== `refs/tags/${proof.tag}` ||
    proof.refName !== proof.tag ||
    proof.sha !== targetSha ||
    typeof proof.workflowRef !== 'string' ||
    proof.workflowRef !==
      `${config.repository}/.github/workflows/release.yml@refs/tags/${proof.tag}`
  ) fail('hosted_admission_proof_invalid');
  const run = await githubApiJson({
    runner,
    repoRoot,
    endpoint: `/repos/${config.repository}/actions/runs/${proof.runId}`,
    reasonCode: 'hosted_admission_run_json_invalid',
  });
  if (
    run.id !== proof.runId ||
    run.run_attempt !== proof.runAttempt ||
    run.head_sha !== targetSha ||
    run.path?.split('@')[0] !== '.github/workflows/release.yml' ||
    run.event !== proof.event ||
    (run.repository?.full_name ?? run.head_repository?.full_name) !== config.repository ||
    (run.path?.includes('@') && !run.path.endsWith(`@${proof.ref}`) && !run.path.endsWith(`@${proof.refName}`))
  ) fail('hosted_admission_run_binding_mismatch');
  if (requireCompleted && (run.status !== 'completed' || run.conclusion !== 'success')) {
    fail('hosted_admission_run_not_successful');
  }
  let artifact = null;
  if (requireCompleted) {
    if (!/^[0-9a-f]{64}$/.test(admissionDigest ?? '')) {
      fail('hosted_admission_artifact_digest_missing');
    }
    const artifactsPayload = await githubApiJson({
      runner,
      repoRoot,
      endpoint: `/repos/${config.repository}/actions/runs/${proof.runId}/artifacts?per_page=100`,
      reasonCode: 'hosted_admission_artifacts_json_invalid',
    });
    if (!Array.isArray(artifactsPayload.artifacts)) {
      fail('hosted_admission_artifacts_shape_invalid');
    }
    artifact = artifactsPayload.artifacts.find(
      (candidate) =>
        candidate.name === admissionArtifactName(config.repository, proof.tag, admissionDigest) &&
        candidate.expired === false &&
        Number(candidate.size_in_bytes) > 0 &&
        /^sha256:[0-9a-f]{64}$/.test(candidate.digest ?? '') &&
        candidate.workflow_run?.id === proof.runId,
    );
    if (!artifact) fail('hosted_admission_artifact_binding_mismatch');
    if (!Number.isInteger(artifact.id) || typeof artifact.name !== 'string') {
      fail('hosted_admission_artifact_identity_invalid');
    }
  }
  return {
    repository: config.repository,
    tag: proof.tag,
    runId: proof.runId,
    runAttempt: proof.runAttempt,
    workflow: proof.workflow,
    event: proof.event,
    ref: proof.ref,
    refName: proof.refName,
    sha: targetSha,
    workflowRef: proof.workflowRef,
    status: run.status,
    conclusion: run.conclusion ?? null,
    artifact: artifact
      ? {
          id: artifact.id,
          name: artifact.name,
          sizeInBytes: Number(artifact.size_in_bytes),
          evidenceSha256: admissionDigest,
          archiveDigest: typeof artifact.digest === 'string' ? artifact.digest : null,
          expired: artifact.expired,
          workflowRunId: artifact.workflow_run?.id ?? null,
          createdAt: artifact.created_at ?? null,
          expiresAt: artifact.expires_at ?? null,
        }
      : null,
  };
}

async function githubApiPaginatedArray({ runner, repoRoot, endpoint, reasonCode }) {
  const result = await runner('gh', ['api', endpoint, '--paginate', '--slurp'], {
    cwd: repoRoot,
  });
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    fail(reasonCode);
  }
  if (!Array.isArray(value)) fail(reasonCode);
  return value.every(Array.isArray) ? value.flat() : value;
}

async function githubApiPaginatedObjects({
  runner,
  repoRoot,
  endpoint,
  key,
  reasonCode,
}) {
  const result = await runner('gh', ['api', endpoint, '--paginate', '--slurp'], {
    cwd: repoRoot,
  });
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    fail(reasonCode);
  }
  const pages = Array.isArray(value) ? value : [value];
  if (
    pages.length === 0 ||
    pages.some(
      (page) =>
        !page ||
        typeof page !== 'object' ||
        !Array.isArray(page[key]),
    )
  ) {
    fail(reasonCode);
  }
  return pages.flatMap((page) => page[key]);
}

export async function verifyBillingFallback({
  runner,
  repoRoot,
  repository,
  tag,
  targetSha,
  expectedProof = null,
}) {
  if (typeof tag !== 'string' || !/^v[0-9A-Za-z.-]+$/.test(tag)) {
    fail('billing_fallback_tag_invalid');
  }
  const matchingRuns = await githubApiPaginatedObjects({
    runner,
    repoRoot,
    endpoint: `/repos/${repository}/actions/workflows/release.yml/runs?head_sha=${targetSha}&per_page=100`,
    key: 'workflow_runs',
    reasonCode: 'billing_fallback_runs_json_invalid',
  });
  const relevantRuns = matchingRuns.filter(
    (run) =>
      run.head_sha === targetSha &&
      ['push', 'workflow_dispatch'].includes(run.event) &&
      run.head_branch === tag &&
      run.path?.split('@')[0] === '.github/workflows/release.yml' &&
      (run.path?.endsWith(`@refs/tags/${tag}`) || run.path?.endsWith(`@${tag}`)),
  );
  if (relevantRuns.length === 0) fail('billing_fallback_failed_run_missing');
  if (relevantRuns.some((run) => run.status !== 'completed')) {
    fail('billing_fallback_run_not_terminal');
  }
  if (relevantRuns.some((run) => run.conclusion === 'success')) {
    fail('billing_fallback_not_needed');
  }
  if (relevantRuns.some((run) => run.conclusion !== 'failure')) {
    fail('billing_fallback_run_conclusion_invalid');
  }
  const failedRuns = relevantRuns.filter(
    (run) => run.status === 'completed' && run.conclusion === 'failure',
  );
  if (failedRuns.length === 0) fail('billing_fallback_failed_run_missing');

  const failedRunJobs = [];
  for (const failedRun of failedRuns) {
    if (!Number.isInteger(failedRun.id)) fail('billing_fallback_failed_run_missing');
    if (!Number.isInteger(failedRun.run_attempt)) fail('billing_fallback_run_attempt_missing');
    const runJobsPayload = await githubApiPaginatedObjects({
      runner,
      repoRoot,
      endpoint: `/repos/${repository}/actions/runs/${failedRun.id}/jobs?filter=all&per_page=100`,
      key: 'jobs',
      reasonCode: 'billing_fallback_jobs_json_invalid',
    });
    const runJobs = runJobsPayload.filter(
      (job) => job.run_id === failedRun.id && job.head_sha === targetSha,
    );
    if (runJobs.length === 0) fail('billing_fallback_failed_job_missing');
    if (
      runJobs.some(
        (job) =>
          !Array.isArray(job.steps) ||
          job.steps.length > 0 ||
          job.status !== 'completed',
      )
    ) {
      // A different run for the same SHA may have started code or may not
      // expose a terminal, zero-step job. Neither state can be treated as a
      // Billing-only infrastructure failure.
      if (runJobs.some((job) => Array.isArray(job.steps) && job.steps.length > 0)) {
        fail('billing_fallback_code_steps_started');
      }
      fail('billing_fallback_job_not_terminal');
    }
    failedRunJobs.push({ failedRun, runJobs });
  }

  let billingCandidate = null;
  for (const { failedRun, runJobs } of failedRunJobs) {
    if (
      expectedProof &&
      (failedRun.id !== expectedProof.workflowRunId ||
        failedRun.run_attempt !== expectedProof.workflowRunAttempt)
    ) {
      continue;
    }
    const failedJob = runJobs.find(
      (job) => job.name === 'admission' && job.conclusion === 'failure',
    );
    if (!Number.isInteger(failedJob?.id)) continue;
    if (expectedProof && failedJob.id !== expectedProof.jobId) {
      continue;
    }
    const steps = Array.isArray(failedJob.steps) ? failedJob.steps : [];
    if (steps.length !== 0) fail('billing_fallback_code_steps_started');

    const checkRunId = Number(
      /\/check-runs\/(\d+)$/.exec(failedJob.check_run_url ?? '')?.[1],
    );
    if (!Number.isInteger(checkRunId)) continue;
    if (expectedProof && checkRunId !== expectedProof.checkRunId) continue;

    const checkRuns = await githubApiPaginatedObjects({
      runner,
      repoRoot,
      endpoint: `/repos/${repository}/commits/${targetSha}/check-runs`,
      key: 'check_runs',
      reasonCode: 'billing_fallback_check_runs_json_invalid',
    });
    const checkRun = checkRuns.find(
      (check) =>
        check.id === checkRunId &&
        check.name === 'admission' &&
        check.conclusion === 'failure' &&
        Number(check.output?.annotations_count) > 0,
    );
    if (!Number.isInteger(checkRun?.id)) continue;
    const annotations = await githubApiPaginatedArray({
      runner,
      repoRoot,
      endpoint: `/repos/${repository}/check-runs/${checkRun.id}/annotations`,
      reasonCode: 'billing_fallback_annotations_json_invalid',
    });
    const billingAnnotation = annotations.find(
      (annotation) =>
        typeof annotation.message === 'string' &&
        /billing|spending limit|payment failed|付款|计费/i.test(annotation.message),
    );
    if (!billingAnnotation) continue;
    const annotationSha256 = sha256(billingAnnotation.message);
    if (expectedProof && annotationSha256 !== expectedProof.annotationSha256) {
      fail('billing_fallback_annotation_binding_mismatch');
    }
    billingCandidate = {
      repository,
      tag,
      workflowPath: '.github/workflows/release.yml',
      workflowRef: `${repository}/.github/workflows/release.yml@refs/tags/${tag}`,
      event: failedRun.event,
      headSha: targetSha,
      workflowRunId: failedRun.id,
      workflowRunAttempt: failedRun.run_attempt,
      jobId: failedJob.id,
      checkRunId: checkRun.id,
      stepCount: 0,
      annotationSha256,
    };
    break;
  }

  if (!billingCandidate) {
    if (expectedProof) fail('billing_fallback_proof_binding_missing');
    fail('billing_fallback_annotation_missing');
  }
  return billingCandidate;
}

function assertHostedProofShape(proof, { config, tag, targetSha, completed = false }) {
  if (
    !proof ||
    proof.repository !== config.repository ||
    proof.tag !== tag ||
    !Number.isInteger(proof.runId) ||
    !Number.isInteger(proof.runAttempt) ||
    typeof proof.workflow !== 'string' ||
    proof.workflow.length === 0 ||
    !['push', 'workflow_dispatch'].includes(proof.event) ||
    proof.ref !== `refs/tags/${tag}` ||
    proof.refName !== tag ||
    proof.sha !== targetSha ||
    proof.workflowRef !==
      `${config.repository}/.github/workflows/release.yml@refs/tags/${tag}`
  ) {
    fail('hosted_admission_receipt_invalid');
  }
  if (completed && (proof.status !== 'completed' || proof.conclusion !== 'success')) {
    fail('hosted_admission_receipt_run_invalid');
  }
  return proof;
}

function assertBillingProofShape(proof, { repository, tag, targetSha } = {}) {
  if (
    !proof ||
    (repository && proof.repository !== repository) ||
    (tag && proof.tag !== tag) ||
    (targetSha && proof.headSha !== targetSha) ||
    proof.workflowPath !== '.github/workflows/release.yml' ||
    proof.workflowRef !==
      `${proof.repository}/.github/workflows/release.yml@refs/tags/${proof.tag}` ||
    !['push', 'workflow_dispatch'].includes(proof.event) ||
    !Number.isInteger(proof.workflowRunId) ||
    !Number.isInteger(proof.workflowRunAttempt) ||
    !Number.isInteger(proof.jobId) ||
    !Number.isInteger(proof.checkRunId) ||
    proof.stepCount !== 0 ||
    !/^[0-9a-f]{64}$/.test(proof.annotationSha256 ?? '')
  ) {
    fail('release_billing_proof_invalid');
  }
  return proof;
}

function assertAdmissionReceipt({
  receipt,
  config,
  tag,
  admission,
  admissionIdentity,
}) {
  if (
    receipt?.schemaVersion !== 1 ||
    receipt.kind !== 'release-admission-receipt' ||
    receipt.repository !== config.repository ||
    receipt.tag !== tag ||
    receipt.targetSha !== admission.targetSha ||
    typeof receipt.releasePublishedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.releasePublishedAt)) ||
    canonicalJson(receipt.admissionAsset) !== canonicalJson(admissionIdentity) ||
    receipt.mode !== admission.mode
  ) {
    fail('release_admission_receipt_invalid');
  }
  if (receipt.mode === 'hosted') {
    const proof = assertHostedProofShape(receipt.hostedProof, {
      config,
      tag,
      targetSha: admission.targetSha,
      completed: true,
    });
    const admissionProof = admission.hostedProof;
    if (
      !admissionProof ||
      admissionProof.repository !== proof.repository ||
      admissionProof.tag !== proof.tag ||
      admissionProof.runId !== proof.runId ||
      admissionProof.runAttempt !== proof.runAttempt ||
      admissionProof.workflowRef !== proof.workflowRef ||
      admissionProof.event !== proof.event ||
      admissionProof.ref !== proof.ref ||
      admissionProof.refName !== proof.refName ||
      admissionProof.sha !== proof.sha
    ) {
      fail('hosted_admission_receipt_binding_mismatch');
    }
    const artifact = receipt.artifact;
    if (
      !artifact ||
      !Number.isInteger(artifact.id) ||
      artifact.name !== admissionArtifactName(config.repository, tag, admissionIdentity.sha256) ||
      !Number.isInteger(artifact.sizeInBytes) ||
      artifact.sizeInBytes <= 0 ||
      artifact.evidenceSha256 !== admissionIdentity.sha256 ||
      artifact.workflowRunId !== proof.runId ||
      artifact.expired !== false ||
      receipt.billingProof !== null ||
      !/^sha256:[0-9a-f]{64}$/.test(artifact.archiveDigest ?? '')
    ) {
      fail('hosted_admission_receipt_artifact_invalid');
    }
    return receipt;
  }
  if (receipt.mode === 'billing-fallback') {
    if (receipt.hostedProof !== null || receipt.artifact !== null) {
      fail('billing_fallback_receipt_shape_invalid');
    }
    assertBillingProofShape(receipt.billingProof, {
      repository: config.repository,
      tag,
      targetSha: admission.targetSha,
    });
    if (canonicalJson(receipt.billingProof) !== canonicalJson(admission.billingProof)) {
      fail('billing_fallback_receipt_binding_mismatch');
    }
    return receipt;
  }
  fail('release_admission_receipt_mode_invalid');
}

function selectProvenanceFields(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, value?.[field] ?? null]));
}

async function verifyAnchoredReceiptProvenance({
  runner,
  repoRoot,
  config,
  admission,
  admissionDigest,
  receipt,
}) {
  if (receipt.mode === 'hosted') {
    const provenance = await verifyHostedRunProof({
      runner,
      repoRoot,
      config,
      targetSha: admission.targetSha,
      proof: receipt.hostedProof,
      requireCompleted: true,
      admissionDigest,
    });
    const proofFields = [
      'repository',
      'tag',
      'runId',
      'runAttempt',
      'workflowRef',
      'event',
      'ref',
      'refName',
      'sha',
    ];
    if (
      canonicalJson(selectProvenanceFields(receipt.hostedProof, proofFields)) !==
      canonicalJson(selectProvenanceFields(provenance, proofFields))
    ) {
      fail('hosted_admission_receipt_provenance_mismatch');
    }
    const artifactFields = [
      'id',
      'name',
      'sizeInBytes',
      'evidenceSha256',
      'archiveDigest',
      'expired',
      'workflowRunId',
    ];
    if (
      canonicalJson(selectProvenanceFields(receipt.artifact, artifactFields)) !==
      canonicalJson(selectProvenanceFields(provenance.artifact, artifactFields))
    ) {
      fail('hosted_admission_receipt_artifact_binding_mismatch');
    }
    return provenance;
  }
  const provenance = await verifyBillingFallback({
    runner,
    repoRoot,
    repository: config.repository,
    tag: admission.tag,
    targetSha: admission.targetSha,
    expectedProof: receipt.billingProof,
  });
  const proofFields = [
    'repository',
    'tag',
    'workflowRunId',
    'workflowRunAttempt',
    'jobId',
    'checkRunId',
    'annotationSha256',
  ];
  if (
    canonicalJson(selectProvenanceFields(receipt.billingProof, proofFields)) !==
    canonicalJson(selectProvenanceFields(provenance, proofFields))
  ) {
    fail('billing_fallback_receipt_provenance_mismatch');
  }
  return provenance;
}

const CHANNEL_BLOCKING_STATES = new Set([
  'adopt_intent',
  'adopted',
  'initialize_intent',
  'initialized',
  'initialized_expired',
  'stage_intent',
  'staged_pending_promote',
  'staged_expired',
  'promote_intent',
  'rollback_intent',
  'stage_failed',
  'rolled_back',
  'recovery_admitted',
  'renew_intent',
  'fail_intent',
]);

export function validateReleaseChannel({
  entries,
  targetTag,
  operation,
  recoverySource,
}) {
  if (!Array.isArray(entries)) fail('release_channel_shape_invalid');
  const blockers = entries.filter(
    (entry) =>
      entry.tag !== targetTag &&
      entry.superseded !== true &&
      CHANNEL_BLOCKING_STATES.has(entry.state),
  );
  if (operation === 'recover') {
    if (!recoverySource) fail('recovery_source_missing');
    if (
      blockers.length !== 1 ||
      blockers[0].tag !== recoverySource.tag ||
      blockers[0].state !== recoverySource.state ||
      blockers[0].stateDigest !== recoverySource.digest
    ) {
      fail('recovery_channel_source_not_unique');
    }
    return { status: 'recovery_source_valid', blocker: blockers[0] };
  }
  if (blockers.length > 0) {
    fail(`release_channel_occupied:${blockers[0].tag}:${blockers[0].state}`);
  }
  return { status: 'release_channel_available' };
}

export async function readRepositoryChannel({
  runner,
  repoRoot,
  config,
  clock,
}) {
  const releases = await githubApiPaginatedArray({
    runner,
    repoRoot,
    endpoint: `/repos/${config.repository}/releases?per_page=100`,
    reasonCode: 'release_channel_releases_json_invalid',
  });
  if (!Array.isArray(releases)) fail('release_channel_releases_shape_invalid');
  const entries = [];
  for (const release of releases) {
    if (
      release.draft !== false ||
      release.prerelease !== false ||
      typeof release.tag_name !== 'string' ||
      !(release.assets ?? []).some((asset) => asset.name === 'release-admission.json')
    ) {
      continue;
    }
    const snapshot = await readReleaseSnapshot({
      runner,
      repoRoot,
      config,
      tag: release.tag_name,
      clock,
      requireCurrentConfig: false,
    });
    const evidenceState = {
      initialized_expired: 'initialized',
      staged_expired: 'staged_pending_promote',
    }[snapshot.state] ?? snapshot.state;
    const stateEvidence = [...snapshot.decodedAssets]
      .reverse()
      .find(({ value }) => value.state === evidenceState);
    entries.push({
      tag: release.tag_name,
      state: snapshot.state,
      targetSha: snapshot.admission.targetSha,
      publishedAt: snapshot.release.published_at,
      snapshot,
      stateDigest: stateEvidence?.digest ?? null,
      superseded: false,
    });
  }
  const supersededDigests = new Set();
  for (const entry of entries) {
    for (const { value } of entry.snapshot.decodedAssets) {
      const supersedes = value.supersedes;
      if (typeof supersedes === 'string') supersededDigests.add(supersedes);
      if (supersedes && typeof supersedes.digest === 'string') {
        supersededDigests.add(supersedes.digest);
      }
    }
  }
  for (const entry of entries) {
    entry.superseded =
      typeof entry.stateDigest === 'string' && supersededDigests.has(entry.stateDigest);
  }
  entries.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  return entries;
}

function intentForOperation(snapshot, operation) {
  return [...snapshot.decodedAssets]
    .reverse()
    .find(({ value }) => value.state === `${operation}_intent`)?.value ?? null;
}

function snapshotLastEvidenceDigest({ evidence, decodedAssets }) {
  if (!evidence || !Array.isArray(decodedAssets)) return null;
  return decodedAssets.find(({ value }) => value === evidence)?.digest ?? null;
}

export function assertResumeIntentAuthority({ snapshot, found }) {
  if (
    !snapshot ||
    !found ||
    typeof snapshot.state !== 'string' ||
    typeof found.value?.state !== 'string' ||
    snapshot.state !== found.value.state ||
    !/^[0-9a-f]{64}$/.test(snapshot.lastEvidenceDigest ?? '') ||
    snapshot.lastEvidenceDigest !== found.digest
  ) {
    fail('resume_intent_not_authoritative');
  }
  return true;
}

function expectedStableCurrent(snapshot, state = snapshot.state) {
  if (['adopt_intent', 'adopted'].includes(state)) {
    return intentForOperation(snapshot, 'adopt')?.expectedCurrentDeploymentId ?? null;
  }
  if (['initialize_intent', 'initialized', 'initialized_expired'].includes(state)) {
    return intentForOperation(snapshot, 'initialize')?.expectedCurrentDeploymentId ?? null;
  }
  if (
    [
      'stage_intent',
      'staged_pending_promote',
      'staged_expired',
      'promote_intent',
      'fail_intent',
      'stage_failed',
    ].includes(state)
  ) {
    return intentForOperation(snapshot, 'stage')?.expectedCurrentDeploymentId ?? null;
  }
  if (state === 'renew_intent') {
    const renewal = intentForOperation(snapshot, 'renew');
    return renewal?.renewState === 'initialized'
      ? intentForOperation(snapshot, 'initialize')?.expectedCurrentDeploymentId ?? null
      : intentForOperation(snapshot, 'stage')?.expectedCurrentDeploymentId ?? null;
  }
  return null;
}

function latestAcceptedCurrent(channel) {
  const accepted = [];
  for (const entry of channel) {
    for (const asset of entry.snapshot.decodedAssets) {
      const deployment = ['current', 'rolled_back'].includes(asset.value.state)
        ? asset.value.operationResult?.deployment
        : asset.value.state === 'adopted'
          ? asset.value.operationResult?.deployment
        : asset.value.state === 'initialize_intent'
          ? { id: asset.value.currentDeploymentId, url: asset.value.currentDeploymentUrl }
          : null;
      if (deployment?.id) accepted.push({ id: deployment.id, createdAt: asset.identity.createdAt });
    }
  }
  accepted.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return accepted[0]?.id ?? null;
}

function latestAcceptedProduction(channel) {
  const accepted = [];
  for (const entry of channel) {
    for (const asset of entry.snapshot.decodedAssets) {
      if (['current', 'rolled_back', 'adopted'].includes(asset.value.state)) {
        accepted.push({
          sha: asset.value.state === 'adopted'
            ? asset.value.operationResult?.productionSha
            : entry.targetSha,
          createdAt: asset.identity.createdAt,
        });
      }
    }
  }
  accepted.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return accepted[0]?.sha ?? null;
}

async function readReleaseSnapshot({
  runner,
  repoRoot,
  config,
  tag,
  clock,
  requireCurrentConfig = true,
}) {
  const { repository, release } = await getReleaseByTag({ runner, repoRoot, tag });
  if (repository !== config.repository) fail('release_repository_mismatch');
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    !release.published_at ||
    !Number.isFinite(Date.parse(release.published_at))
  ) {
    fail('release_not_published_stable');
  }
  const admissionAssets = release.assets.filter(
    (asset) => asset.name === 'release-admission.json',
  );
  if (admissionAssets.length !== 1) fail('release_admission_asset_invalid');
  const admissionDocument = await verifyReleaseAssetAnchor({
    runner,
    repoRoot,
    repository,
    tag,
    asset: admissionAssets[0],
  });
  const admission = admissionDocument.value;
  assertArtifactManifest(admission.artifactManifest);
  if (!['hosted', 'billing-fallback'].includes(admission.mode)) {
    fail('release_admission_mode_invalid');
  }
  const receiptAssets = release.assets.filter(
    (asset) => asset.name === ADMISSION_RECEIPT_ASSET,
  );
  if (receiptAssets.length !== 1) fail('release_admission_receipt_missing');
  const receiptDocument = await verifyReleaseAssetAnchor({
    runner,
    repoRoot,
    repository,
    tag,
    asset: receiptAssets[0],
  });
  const admissionReceipt = assertAdmissionReceipt({
    receipt: receiptDocument.value,
    config,
    tag,
    admission,
    admissionIdentity: admissionDocument.identity,
  });
  const contract = admission.releaseContract;
  if (
    !contract ||
    !Array.isArray(contract.productionDomains) ||
    !/^[0-9a-f]{64}$/.test(contract.bodyMarkerSha256 ?? '') ||
    (requireCurrentConfig &&
      canonicalJson(contract) !== canonicalJson(releaseContract(config)))
  ) fail('release_contract_invalid');
  const configHash = hashReleaseConfig(config);
  if (
    admission.repository !== config.repository ||
    admission.tag !== tag ||
    !/^[0-9a-f]{40}$/.test(admission.targetSha ?? '') ||
    (requireCurrentConfig
      ? admission.configHash !== configHash
      : !/^[0-9a-f]{64}$/.test(admission.configHash ?? ''))
  ) {
    fail('release_admission_binding_mismatch');
  }

  const evidence = [
    {
      state: 'admitted',
      fromState: 'admission_ready',
      createdAt: release.published_at,
      admissionSha256: admissionDocument.digest,
      assetId: admissionAssets[0].id,
    },
  ];
  const evidenceAssets = release.assets
    .filter(
      (asset) =>
        asset.name !== 'release-admission.json' &&
        /^(?:release-intent-|release-failure-|production-|recovery-admitted-).+\.json$/.test(asset.name),
    )
    .sort((left, right) => left.id - right.id);
  const decodedAssets = [];
  for (const asset of evidenceAssets) {
    const document = await verifyReleaseAssetAnchor({
      runner,
      repoRoot,
      repository,
      tag,
      asset,
    });
    const value = document.value;
    if (
      value.schemaVersion !== 1 ||
      typeof value.state !== 'string' ||
      typeof value.createdAt !== 'string' ||
      value.repository !== config.repository ||
      value.tag !== tag ||
      value.targetSha !== admission.targetSha ||
      value.configHash !== admission.configHash
    ) {
      fail('release_evidence_shape_invalid');
    }
    const isIntent = RELEASE_INTENT_STATE.test(value.state);
    if (
      isIntent !== asset.name.startsWith('release-intent-') ||
      (isIntent && !asset.name.startsWith(`release-intent-${value.operation}-`))
    ) fail('release_evidence_asset_name_mismatch');
    assertCompletionAcceptance(value, contract);
    evidence.push(value);
    decodedAssets.push({
      asset,
      value,
      digest: document.digest,
      identity: document.identity,
    });
  }
  for (const decoded of decodedAssets) {
    if (!decoded.value.intentSha256) continue;
    const referencedIntent = decodedAssets.find(
      (candidate) => candidate.digest === decoded.value.intentSha256,
    );
    if (!referencedIntent) fail('completion_intent_digest_missing');
    if (
      !decoded.value.intentAsset ||
      canonicalJson(decoded.value.intentAsset) !== canonicalJson(referencedIntent.identity)
    ) {
      fail('completion_intent_asset_identity_mismatch');
    }
  }
  evidence.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const derived = deriveReleaseState(
    {
      releasePublished: true,
      pendingTtlSeconds: config.controller.pendingTtlSeconds,
      evidence,
    },
    clock(),
  );
  if (derived.state === 'drift_freeze') fail(derived.reasonCode);
  const lastEvidenceDigest = snapshotLastEvidenceDigest({
    evidence: derived.lastEvidence,
    decodedAssets,
  });
  return {
    repository,
    release,
    admission,
    admissionReceipt,
    evidence,
    decodedAssets,
    state: derived.state,
    configHash: admission.configHash,
    lastEvidenceCreatedAt: derived.lastEvidence?.createdAt ?? release.published_at,
    lastEvidenceDigest,
  };
}

async function runAdmission({
  runner,
  repoRoot,
  config,
  tag,
  hosted,
  billingFallback,
  clock,
  tempRoot,
  environment = process.env,
}) {
  const target = await verifyTargetTree({ runner, repoRoot, tag, config });
  if (!hosted && !billingFallback) fail('hosted_admission_required');
  if (
    hosted &&
    (environment?.GITHUB_ACTIONS !== 'true' ||
      !/^\d+$/.test(environment?.GITHUB_RUN_ID ?? '') ||
      typeof environment?.GITHUB_WORKFLOW !== 'string' ||
      environment.GITHUB_WORKFLOW.length === 0)
  ) {
    fail('hosted_admission_context_missing');
  }
  const hostedProof = hosted
    ? await verifyHostedRunProof({
        runner,
        repoRoot,
        config,
        targetSha: target.targetSha,
        proof: hostedEnvironmentProof({ environment, config, tag, targetSha: target.targetSha }),
        requireCompleted: false,
      })
    : null;
  if (hosted && billingFallback) fail('billing_fallback_hosted_conflict');
  const billingProof = billingFallback
    ? await verifyBillingFallback({
        runner,
        repoRoot,
        repository: config.repository,
        tag,
        targetSha: target.targetSha,
      })
    : null;
  const commandResults = [];
  const temporaryParent = await mkdtemp(path.join(tempRoot, 'shadow-release-admit-'));
  const checkout = path.join(temporaryParent, 'checkout');
  const admissionHome = path.join(temporaryParent, 'home');
  let worktreeRegistered = false;
  try {
    await mkdir(admissionHome, { mode: 0o700 });
    await runner('git', ['worktree', 'add', '--detach', checkout, target.targetSha], {
      cwd: repoRoot,
    });
    worktreeRegistered = true;
    for (const [command, ...args] of config.admissionCommands) {
      const result = await runner(command, args, {
        cwd: checkout,
        env: admissionChildEnvironment(environment, admissionHome, temporaryParent),
        inheritEnv: false,
      });
      commandResults.push({
        command,
        args,
        exitCode: result.exitCode,
        stdoutSha256: sha256(result.stdout),
        stderrSha256: result.stderrDigest,
      });
    }
  } finally {
    if (worktreeRegistered) {
      await runner('git', ['worktree', 'remove', '--force', checkout], { cwd: repoRoot });
    }
    await rm(temporaryParent, { recursive: true, force: true });
  }
  const evidence = {
    schemaVersion: 1,
    state: 'admission_ready',
    repository: config.repository,
    tag,
    targetSha: target.targetSha,
    mainSnapshot: target.mainSha,
    configHash: hashReleaseConfig(config),
    mode: billingFallback ? 'billing-fallback' : hosted ? 'hosted' : 'local',
    hostedProof,
    billingProof,
    commands: commandResults,
    workflowPaths: target.workflowPaths,
    artifactManifest: target.artifactManifest,
    releaseContract: releaseContract(config),
    createdAt: clock().toISOString(),
  };
  const local = await writeLocalEvidence({
    repoRoot,
    tag,
    fileName: 'release-admission.json',
    value: evidence,
  });
  return {
    status: 'admission_ready',
    repository: config.repository,
    tag,
    targetSha: target.targetSha,
    configHash: evidence.configHash,
    mode: evidence.mode,
    evidenceSha256: local.sha256,
    evidencePath: path.relative(repoRoot, local.filePath),
    commands: commandResults,
  };
}

async function localAudit({ runner, repoRoot, config }) {
  const findings = [];
  let vercelConfig;
  try {
    vercelConfig = JSON.parse(
      await readFile(path.join(repoRoot, config.vercel.vercelJsonPath), 'utf8'),
    );
  } catch {
    findings.push({ reasonCode: 'vercel_json_invalid' });
  }
  if (vercelConfig?.git?.deploymentEnabled !== false) {
    findings.push({ reasonCode: 'vercel_git_deployment_not_disabled' });
  }
  const workflowDirectory = path.join(repoRoot, '.github', 'workflows');
  const workflowNames = await readdir(workflowDirectory).catch(() => []);
  let packageScripts = null;
  try {
    packageScripts = JSON.parse(
      await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
    ).scripts ?? null;
  } catch {
    packageScripts = null;
  }
  for (const name of workflowNames.filter((entry) => /\.ya?ml$/.test(entry)).sort()) {
    const workflowPath = `.github/workflows/${name}`;
    const text = await readFile(path.join(repoRoot, workflowPath), 'utf8');
    for (const reasonCode of scanWorkflowText(workflowPath, text, {
      scripts: packageScripts,
      requireExplicitPermissions: true,
    })) {
      findings.push({ reasonCode, path: workflowPath });
    }
  }
  const repository = await resolveGitHubRepository({ runner, repoRoot });
  if (repository !== config.repository) findings.push({ reasonCode: 'repository_remote_mismatch' });

  let controllerInstalled = false;
  try {
    await readControllerBinding({ runner, repoRoot, config });
    controllerInstalled = true;
  } catch (error) {
    if (error.message !== 'controller_binding_missing') {
      findings.push({ reasonCode: error.message });
    }
  }
  if (findings.length > 0) {
    return {
      status: 'failed',
      state: 'drift_freeze',
      findings,
      controllerInstalled,
    };
  }
  return {
    status: 'passed',
    state: controllerInstalled ? 'local_ready' : 'not_initialized',
    repository: config.repository,
    configHash: hashReleaseConfig(config),
    controllerInstalled,
    workflowCount: workflowNames.filter((entry) => /\.ya?ml$/.test(entry)).length,
  };
}

async function remoteAudit({ runner, repoRoot, config, tag, clock }) {
  const local = await localAudit({ runner, repoRoot, config });
  if (local.status !== 'passed') return local;
  try {
    const target = await verifyTargetTree({ runner, repoRoot, tag, config });
    const snapshot = await readReleaseSnapshot({ runner, repoRoot, config, tag, clock });
    if (snapshot.admission.targetSha !== target.targetSha) fail('audit_target_sha_mismatch');
    if (
      canonicalJson(snapshot.admission.artifactManifest) !==
      canonicalJson(target.artifactManifest)
    ) fail('audit_artifact_manifest_mismatch');
    const vercelCliVersion = await verifyVercelCliVersion({ runner, repoRoot, config });
    const productionSha = await readRemoteBranchSha({ runner, repoRoot });
    const settingsMayBePending = new Set([
      'admitted',
      'adopt_intent',
      'adopted',
      'initialize_intent',
      'initialized',
      'initialized_expired',
    ]).has(snapshot.state);
    const project = await readVercelProjectFacts({
      runner,
      repoRoot,
      config,
      requireReleaseSettings: !settingsMayBePending,
    });
    const currentDeployment = project.current?.id
      ? await inspectDeployment({
          runner,
          repoRoot,
          config,
          deploymentId: project.current.id,
        })
      : null;
    const currentDeploymentSha =
      currentDeployment?.meta?.releaseCommitSha ??
      currentDeployment?.meta?.githubCommitSha ??
      currentDeployment?.meta?.gitCommitSha ??
      null;
    const channel = await readRepositoryChannel({ runner, repoRoot, config, clock });
    validateReleaseChannel({ entries: channel, targetTag: tag, operation: 'audit' });
    const channelCurrent = latestAcceptedCurrent(channel);
    const channelProduction = latestAcceptedProduction(channel);

    if (snapshot.state === 'adopt_intent') {
      const adoptIntent = intentForOperation(snapshot, 'adopt');
      if (
        productionSha !== adoptIntent?.oldSha ||
        currentDeploymentSha !== adoptIntent?.oldSha ||
        project.current?.id !== adoptIntent?.expectedCurrentDeploymentId
      ) fail('audit_adopt_baseline_mismatch');
    } else if (snapshot.state === 'initialize_intent') {
      if (productionSha !== null && productionSha !== target.targetSha) {
        fail('audit_initialize_ref_outside_intent');
      }
    } else if (snapshot.state === 'adopted') {
      const adopted = [...snapshot.decodedAssets]
        .reverse()
        .find(({ value }) => value.state === 'adopted')?.value;
      if (
        productionSha !== adopted?.operationResult?.productionSha ||
        currentDeploymentSha !== adopted?.operationResult?.currentDeploymentSha ||
        project.current?.id !== adopted?.operationResult?.currentDeploymentId
      ) fail('audit_adopted_baseline_mismatch');
    } else if (!['admitted', 'recovery_admitted'].includes(snapshot.state) && productionSha !== target.targetSha) {
      fail('audit_production_ref_mismatch');
    }
    if (
      snapshot.state === 'admitted' &&
      channelProduction &&
      (project.current?.id !== channelCurrent || productionSha !== channelProduction)
    ) {
      fail('audit_admitted_baseline_mismatch');
    }
    if (snapshot.state === 'recovery_admitted') {
      const recovery = [...snapshot.decodedAssets].reverse().find(({ value }) => value.state === 'recovery_admitted')?.value;
      if (
        productionSha !== recovery?.operationResult?.recoveryProductionSha ||
        project.current?.id !== recovery?.operationResult?.expectedCurrentDeploymentId
      ) fail('audit_recovery_baseline_mismatch');
    }

    const stagedEvidence = [...snapshot.decodedAssets]
      .reverse()
      .find(({ value }) => value.state === 'staged_pending_promote');
    const staged = stagedEvidence?.value?.operationResult?.deployment ?? null;
    const expectedCurrent = expectedStableCurrent(snapshot);
    if (
      [
        'initialize_intent',
        'adopt_intent',
        'adopted',
        'initialized',
        'initialized_expired',
        'stage_intent',
        'staged_pending_promote',
        'staged_expired',
        'renew_intent',
        'fail_intent',
        'stage_failed',
      ].includes(snapshot.state) &&
      project.current?.id !== expectedCurrent
    ) fail('audit_expected_current_mismatch');
    if (
      snapshot.state === 'promote_intent' &&
      ![expectedCurrent, staged?.id].includes(project.current?.id)
    ) fail('audit_promote_current_outside_intent');
    if (snapshot.state === 'rollback_intent') {
      const rollbackIntent = intentForOperation(snapshot, 'rollback');
      if (
        ![
          rollbackIntent?.currentDeploymentId,
          rollbackIntent?.targetDeploymentId,
        ].includes(project.current?.id)
      ) fail('audit_rollback_current_outside_intent');
    }
    if (
      new Set(['staged_pending_promote', 'staged_expired', 'promote_intent']).has(
        snapshot.state,
      )
    ) {
      if (!staged?.id || !staged?.url) fail('audit_staged_evidence_missing');
      const inspected = await inspectDeployment({
        runner,
        repoRoot,
        config,
        deploymentId: staged.id,
      });
      if (
        inspected.readyState !== 'READY' ||
        inspected.target !== 'production' ||
        inspected.meta?.releaseCommitSha !== target.targetSha ||
        inspected.meta?.releaseTag !== tag ||
        inspected.meta?.releaseConfigHash !== snapshot.configHash
      ) fail('audit_staged_deployment_drift');
      if (
        snapshot.state !== 'promote_intent' &&
        project.current?.id === staged.id
      ) fail('audit_staged_deployment_already_current');
    }

    if (snapshot.state === 'current') {
      const acceptance = [...snapshot.decodedAssets]
        .reverse()
        .find(({ value }) => value.state === 'current');
      const acceptedDeployment = acceptance?.value?.operationResult?.deployment;
      if (!acceptedDeployment?.id || project.current?.id !== acceptedDeployment.id) {
        fail('audit_current_deployment_mismatch');
      }
      const currentSha =
        currentDeployment?.meta?.releaseCommitSha ??
        currentDeployment?.meta?.githubCommitSha ??
        currentDeployment?.meta?.gitCommitSha ??
        null;
      if (currentSha !== target.targetSha) fail('audit_current_commit_mismatch');
    }

    if (snapshot.state === 'rolled_back') {
      const rollback = [...snapshot.decodedAssets]
        .reverse()
        .find(({ value }) => value.state === 'rolled_back');
      if (project.current?.id !== rollback?.value?.operationResult?.deployment?.id) {
        fail('audit_rollback_current_mismatch');
      }
    }

    return {
      status: 'passed',
      state: snapshot.state,
      repository: config.repository,
      tag,
      targetSha: target.targetSha,
      artifactManifestSha256: target.artifactManifest.sha256,
      productionSha,
      currentDeploymentId: project.current?.id ?? null,
      configHash: snapshot.configHash,
      vercelCliVersion,
      releaseAssetCount: snapshot.decodedAssets.length + 1,
      channelReleaseCount: channel.length,
    };
  } catch (error) {
    return {
      status: 'failed',
      state: 'drift_freeze',
      repository: config.repository,
      tag,
      findings: [{ reasonCode: error.message }],
    };
  }
}

async function readAdmissionAnchorFacts({
  runner,
  repoRoot,
  config,
  tag,
  assetId,
}) {
  const numericAssetId = Number(assetId);
  if (!Number.isInteger(numericAssetId)) fail('admission_asset_id_invalid');
  const { repository, release } = await getReleaseByTag({ runner, repoRoot, tag });
  if (repository !== config.repository) fail('release_repository_mismatch');
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    !release.published_at ||
    !Number.isFinite(Date.parse(release.published_at))
  ) {
    fail('release_not_published_stable');
  }
  const matches = release.assets.filter(
    (asset) => asset.id === numericAssetId && asset.name === 'release-admission.json',
  );
  if (matches.length !== 1) fail('admission_asset_identity_not_found');
  const anchored = await verifyReleaseAssetAnchor({
    runner,
    repoRoot,
    repository,
    tag,
    asset: matches[0],
    allowIdentityCreate: true,
  });
  const admission = anchored.value;
  assertArtifactManifest(admission.artifactManifest);
  if (!['hosted', 'billing-fallback'].includes(admission.mode)) {
    fail('release_admission_mode_invalid');
  }
  if (
    admission.repository !== config.repository ||
    admission.tag !== tag ||
    !/^[0-9a-f]{40}$/.test(admission.targetSha ?? '') ||
    admission.configHash !== hashReleaseConfig(config) ||
    canonicalJson(admission.releaseContract) !== canonicalJson(releaseContract(config))
  ) {
    fail('release_admission_binding_mismatch');
  }
  const receiptAssets = release.assets.filter(
    (asset) => asset.name === ADMISSION_RECEIPT_ASSET,
  );
  if (receiptAssets.length > 1) fail('release_admission_receipt_ambiguous');
  let receiptIdentity = null;
  let provenance = null;
  if (receiptAssets.length === 1) {
    const existingReceipt = await verifyReleaseAssetAnchor({
      runner,
      repoRoot,
      repository,
      tag,
      asset: receiptAssets[0],
    });
    assertAdmissionReceipt({
      receipt: existingReceipt.value,
      config,
      tag,
      admission,
      admissionIdentity: anchored.identity,
    });
    provenance = await verifyAnchoredReceiptProvenance({
      runner,
      repoRoot,
      config,
      admission,
      admissionDigest: anchored.digest,
      receipt: existingReceipt.value,
    });
    receiptIdentity = existingReceipt.identity;
  } else if (admission.mode === 'hosted') {
    provenance = await verifyHostedRunProof({
      runner,
      repoRoot,
      config,
      targetSha: admission.targetSha,
      proof: admission.hostedProof,
      requireCompleted: true,
      admissionDigest: anchored.digest,
    });
  } else {
    provenance = assertBillingProofShape(
      await verifyBillingFallback({
        runner,
        repoRoot,
        repository,
        tag,
        targetSha: admission.targetSha,
        expectedProof: admission.billingProof,
      }),
      { repository, tag, targetSha: admission.targetSha },
    );
  }
  return {
    operation: 'anchor-admission',
    repository,
    tag,
    assetId: numericAssetId,
    targetSha: admission.targetSha,
    mode: admission.mode,
    admission,
    admissionIdentity: anchored.identity,
    admissionDigest: anchored.digest,
    receiptIdentity,
    provenance,
    releasePublishedAt: release.published_at,
  };
}

async function readOperationFacts({
  runner,
  repoRoot,
  config,
  tag,
  operation,
  deployment,
  assetId,
  intent: requestedIntent,
  clock,
}) {
  if (operation === 'anchor-admission') {
    return readAdmissionAnchorFacts({
      runner,
      repoRoot,
      config,
      tag,
      assetId,
    });
  }
  const target = await verifyTargetTree({ runner, repoRoot, tag, config });
  const vercelCliVersion = await verifyVercelCliVersion({ runner, repoRoot, config });
  const snapshot = await readReleaseSnapshot({ runner, repoRoot, config, tag, clock });
  if (snapshot.admission.targetSha !== target.targetSha) fail('release_target_sha_mismatch');
  if (
    canonicalJson(snapshot.admission.artifactManifest) !==
    canonicalJson(target.artifactManifest)
  ) fail('release_artifact_manifest_mismatch');
  const productionSha = await readRemoteBranchSha({ runner, repoRoot });
  const project = await readVercelProjectFacts({
    runner,
    repoRoot,
    config,
    requireReleaseSettings: !['adopt', 'initialize', 'resume', 'rollback'].includes(operation),
  });
  if (operation === 'rollback' && project.productionBranch !== config.vercel.productionBranch) {
    fail('vercel_production_branch_mismatch');
  }
  const currentDeployment = project.current?.id
    ? await inspectDeployment({
        runner,
        repoRoot,
        config,
        deploymentId: project.current.id,
      })
    : null;
  const currentDeploymentSha =
    currentDeployment?.meta?.releaseCommitSha ??
    currentDeployment?.meta?.githubCommitSha ??
    currentDeployment?.meta?.gitCommitSha ??
    null;
  const base = {
    repository: config.repository,
    tag,
    targetSha: target.targetSha,
    mainSha: target.mainSha,
    configHash: snapshot.configHash,
    artifactManifest: target.artifactManifest,
    state: snapshot.state,
    lastEvidenceCreatedAt: snapshot.lastEvidenceCreatedAt,
    productionSha,
    currentDeploymentId: project.current?.id ?? null,
    currentDeploymentUrl: project.current?.url ?? null,
    currentDeploymentSha,
    teamId: config.vercel.teamId,
    projectId: config.vercel.projectId,
    rootDirectory: config.vercel.rootDirectory,
    productionDomains: config.vercel.productionDomains,
    vercelCliVersion,
  };
  const channel = await readRepositoryChannel({ runner, repoRoot, config, clock });
  let recoverySource = null;
  if (operation === 'recover') {
    if (!/^[0-9a-f]{64}$/.test(requestedIntent ?? '')) {
      fail('recovery_supersedes_invalid');
    }
    for (const entry of channel) {
      if (entry.tag === tag) continue;
      const sourceAsset = entry.snapshot.decodedAssets.find(
        ({ digest, value }) =>
          digest === requestedIntent &&
          digest === entry.stateDigest &&
          [
            'stage_intent',
            'stage_failed',
            'rolled_back',
          ].includes(value.state),
      );
      if (sourceAsset) {
        recoverySource = {
          tag: entry.tag,
          state: entry.state,
          digest: sourceAsset.digest,
          evidenceState: sourceAsset.value.state,
          targetSha: entry.targetSha,
        };
        break;
      }
    }
    if (!recoverySource) fail('recovery_source_evidence_not_found');
  }
  validateReleaseChannel({
    entries: channel,
    targetTag: tag,
    operation,
    recoverySource,
  });

  if (operation === 'renew') {
    if (!['initialized_expired', 'staged_expired'].includes(snapshot.state)) {
      fail('renew_state_invalid');
    }
    if (productionSha !== target.targetSha) fail('renew_production_ref_mismatch');
    if (project.current?.id !== expectedStableCurrent(snapshot)) {
      fail('renew_current_deployment_mismatch');
    }
    if (snapshot.state === 'initialized_expired') {
      return { ...base, renewState: 'initialized' };
    }
    const staged = [...snapshot.decodedAssets]
      .reverse()
      .find(({ value }) => value.state === 'staged_pending_promote')
      ?.value?.operationResult?.deployment;
    if (!staged?.id || project.current?.id === staged.id) fail('renew_staged_identity_invalid');
    const inspected = await inspectDeployment({
      runner,
      repoRoot,
      config,
      deploymentId: staged.id,
    });
    if (
      inspected.readyState !== 'READY' ||
      inspected.meta?.releaseCommitSha !== target.targetSha ||
      inspected.meta?.releaseTag !== tag ||
      inspected.meta?.releaseConfigHash !== snapshot.configHash
    ) fail('renew_staged_deployment_invalid');
    return {
      ...base,
      renewState: 'staged_pending_promote',
      stagedDeploymentId: staged.id,
      stagedDeploymentUrl: staged.url,
    };
  }

  if (operation === 'fail') {
    if (snapshot.state !== 'staged_expired') fail('fail_state_invalid');
    if (productionSha !== target.targetSha) fail('fail_production_ref_mismatch');
    if (project.current?.id !== expectedStableCurrent(snapshot)) {
      fail('fail_current_deployment_mismatch');
    }
    return { ...base, failureReason: 'staged_window_abandoned' };
  }

  if (operation === 'initialize') {
    if (snapshot.state !== 'admitted') fail('initialize_state_invalid');
    if (productionSha !== null) fail('initialize_production_already_exists');
    if (!/^[0-9a-f]{40}$/.test(currentDeploymentSha ?? '')) {
      fail('initialize_current_commit_missing');
    }
    const currentAncestry = await runner(
      'git',
      ['merge-base', '--is-ancestor', currentDeploymentSha, target.targetSha],
      { cwd: repoRoot, allowExitCodes: [0, 1] },
    );
    if (currentAncestry.exitCode !== 0) fail('initialize_current_not_target_ancestor');
    return base;
  }

  if (operation === 'adopt') {
    if (snapshot.state !== 'admitted') fail('adopt_state_invalid');
    if (!/^[0-9a-f]{40}$/.test(productionSha ?? '')) fail('adopt_production_missing');
    if (!/^[0-9a-f]{40}$/.test(currentDeploymentSha ?? '')) {
      fail('adopt_current_commit_missing');
    }
    if (currentDeploymentSha !== productionSha) fail('adopt_current_production_mismatch');
    const ancestry = await runner(
      'git',
      ['merge-base', '--is-ancestor', productionSha, target.targetSha],
      { cwd: repoRoot, allowExitCodes: [0, 1] },
    );
    if (ancestry.exitCode !== 0) fail('adopt_production_not_target_ancestor');
    return base;
  }

  if (operation === 'stage') {
    if (!['admitted', 'adopted', 'initialized', 'current', 'recovery_admitted'].includes(snapshot.state)) {
      fail('stage_state_invalid');
    }
    if (!productionSha) fail('stage_production_missing');
    const expectedCurrent = snapshot.state === 'initialized'
      ? expectedStableCurrent(snapshot)
      : snapshot.state === 'recovery_admitted'
        ? [...snapshot.decodedAssets].reverse().find(({ value }) => value.state === 'recovery_admitted')?.value?.operationResult?.expectedCurrentDeploymentId
        : latestAcceptedCurrent(channel);
    if (!expectedCurrent || project.current?.id !== expectedCurrent) {
      fail('stage_current_deployment_mismatch');
    }
    const expectedProduction = snapshot.state === 'adopted'
      ? intentForOperation(snapshot, 'adopt')?.oldSha
      : snapshot.state === 'initialized'
        ? target.targetSha
      : snapshot.state === 'recovery_admitted'
        ? [...snapshot.decodedAssets].reverse().find(({ value }) => value.state === 'recovery_admitted')?.value?.operationResult?.recoveryProductionSha
        : latestAcceptedProduction(channel);
    if (!expectedProduction || productionSha !== expectedProduction) {
      fail('stage_production_baseline_mismatch');
    }
    const ancestry = await runner(
      'git',
      ['merge-base', '--is-ancestor', productionSha, target.targetSha],
      { cwd: repoRoot, allowExitCodes: [0, 1] },
    );
    if (ancestry.exitCode !== 0) fail('stage_not_strict_fast_forward');
    return base;
  }

  if (operation === 'promote') {
    if (snapshot.state !== 'staged_pending_promote') {
      fail('promote_state_invalid');
    }
    if (productionSha !== target.targetSha) fail('promote_production_ref_mismatch');
    if (project.current?.id !== expectedStableCurrent(snapshot)) {
      fail('promote_current_deployment_mismatch');
    }
    const staged = [...snapshot.decodedAssets]
      .reverse()
      .find(({ value }) => value.state === 'staged_pending_promote');
    const stagedDeployment = staged?.value?.operationResult?.deployment;
    const stagedAcceptance = staged?.value?.operationResult?.stagedAcceptance;
    if (!stagedDeployment?.id || !stagedDeployment?.url) fail('staged_deployment_evidence_missing');
    if (
      stagedAcceptance?.kind !== 'staged' ||
      stagedAcceptance.deploymentUrl !==
        new URL(
          stagedDeployment.url.startsWith('https://')
            ? stagedDeployment.url
            : `https://${stagedDeployment.url}`,
        ).href
    ) fail('staged_acceptance_evidence_missing');
    if (deployment && ![stagedDeployment.id, stagedDeployment.url, `https://${stagedDeployment.url}`].includes(deployment)) {
      fail('promote_deployment_argument_mismatch');
    }
    const inspectedStaged = await inspectDeployment({
      runner,
      repoRoot,
      config,
      deploymentId: stagedDeployment.id,
    });
    if (
      inspectedStaged.readyState !== 'READY' ||
      inspectedStaged.target !== 'production' ||
      inspectedStaged.meta?.releaseCommitSha !== target.targetSha ||
      inspectedStaged.meta?.releaseTag !== tag ||
      inspectedStaged.meta?.releaseConfigHash !== snapshot.configHash
    ) {
      fail('promote_staged_deployment_invalid');
    }
    return {
      ...base,
      stagedDeploymentId: stagedDeployment.id,
      stagedDeploymentUrl: stagedDeployment.url,
      stagedDeploymentReadyState: inspectedStaged.readyState,
    };
  }

  if (operation === 'rollback') {
    if (snapshot.state !== 'current') fail('rollback_state_invalid');
    if (!deployment) fail('rollback_deployment_required');
    const rollbackTarget = await inspectDeployment({
      runner,
      repoRoot,
      config,
      deploymentId: deployment,
    });
    if (
      rollbackTarget.projectId !== config.vercel.projectId ||
      rollbackTarget.readyState !== 'READY' ||
      rollbackTarget.id === base.currentDeploymentId
    ) {
      fail('rollback_deployment_invalid');
    }
    const acceptedHistory = [];
    for (const entry of channel) {
      for (const { value, identity } of entry.snapshot.decodedAssets) {
        const candidate = value.state === 'current'
          ? value?.operationResult?.deployment
          : value.state === 'rolled_back'
            ? value?.operationResult?.deployment
          : value.state === 'adopted'
            ? value?.operationResult?.deployment
          : value.state === 'initialize_intent'
            ? { id: value.currentDeploymentId, url: value.currentDeploymentUrl }
            : null;
        if (candidate?.id && candidate?.url) {
          acceptedHistory.push({
            id: candidate.id,
            url: candidate.url,
            tag: entry.tag,
            createdAt: identity.createdAt,
          });
        }
      }
    }
    acceptedHistory.sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
    const distinctHistory = acceptedHistory.filter(
      (entry, index) =>
        index === 0 || entry.id !== acceptedHistory[index - 1].id,
    );
    if (
      distinctHistory[0]?.id !== base.currentDeploymentId ||
      distinctHistory[1]?.id !== rollbackTarget.id
    ) {
      fail('rollback_not_immediately_previous_accepted_deployment');
    }
    return {
      ...base,
      rollbackDeploymentId: rollbackTarget.id,
      rollbackDeploymentUrl: rollbackTarget.url,
      settingsWrites: [AUTO_ASSIGN_SETTING_WRITE],
      settingsMatch: project.autoAssignCustomDomains === config.vercel.autoAssignCustomDomains,
    };
  }

  if (operation === 'resume') {
    if (!/^[0-9a-f]{64}$/.test(requestedIntent ?? '')) fail('resume_intent_hash_invalid');
    const found = snapshot.decodedAssets.find(
      ({ value, digest }) =>
        RELEASE_INTENT_STATE.test(value.state) &&
        digest === requestedIntent,
    );
    if (!found) fail('resume_intent_not_found');
    assertResumeIntentAuthority({ snapshot, found });
    const underlying = found.value.operation;
    let matchingDeployments = [];
    let resumeDeployment = null;
    if (underlying === 'stage') {
      matchingDeployments = await listMatchingStagedDeployments({
        runner,
        repoRoot,
        config,
        targetSha: found.value.targetSha,
        tag,
        configHash: found.value.configHash,
      });
    }
    if (underlying === 'promote') {
      const inspectedResumeDeployment = await inspectDeployment({
        runner,
        repoRoot,
        config,
        deploymentId: found.value.deploymentId,
      });
      if (
        inspectedResumeDeployment.readyState !== 'READY' ||
        inspectedResumeDeployment.target !== 'production' ||
        inspectedResumeDeployment.meta?.releaseCommitSha !== found.value.targetSha ||
        inspectedResumeDeployment.meta?.releaseTag !== tag ||
        inspectedResumeDeployment.meta?.releaseConfigHash !== found.value.configHash
      ) fail('resume_promote_deployment_invalid');
      resumeDeployment = {
        id: inspectedResumeDeployment.id,
        url: inspectedResumeDeployment.url,
        projectId: inspectedResumeDeployment.projectId,
        target: inspectedResumeDeployment.target,
        readyState: inspectedResumeDeployment.readyState,
        releaseCommitSha: inspectedResumeDeployment.meta.releaseCommitSha,
        releaseTag: inspectedResumeDeployment.meta.releaseTag,
        releaseConfigHash: inspectedResumeDeployment.meta.releaseConfigHash,
      };
    }
    if (underlying === 'rollback') {
      const inspectedResumeDeployment = await inspectDeployment({
        runner,
        repoRoot,
        config,
        deploymentId: found.value.targetDeploymentId,
      });
      if (
        inspectedResumeDeployment.readyState !== 'READY' ||
        inspectedResumeDeployment.id !== found.value.targetDeploymentId ||
        inspectedResumeDeployment.projectId !== config.vercel.projectId
      ) fail('resume_rollback_deployment_invalid');
      resumeDeployment = {
        id: inspectedResumeDeployment.id,
        url: inspectedResumeDeployment.url,
        projectId: inspectedResumeDeployment.projectId,
        target: inspectedResumeDeployment.target,
        readyState: inspectedResumeDeployment.readyState,
      };
    }
    const resumeFacts = {
      ...base,
      targetSha: found.value.targetSha,
      configHash: found.value.configHash,
      matchingDeployments,
      resumeDeployment,
      settingsWrites: underlying === 'rollback' ? [AUTO_ASSIGN_SETTING_WRITE] : [],
      settingsMatch:
        project.productionBranch === 'production' &&
        project.autoAssignCustomDomains === false,
    };
    const action = reconcileIntent({ intent: found.value, facts: resumeFacts });
    if (action.action === 'freeze') fail(action.reasonCode);
    return {
      ...resumeFacts,
      intent: found.value,
      intentIdentity: found.identity,
      resumeAction: action,
    };
  }

  if (operation === 'recover') {
    if (snapshot.state !== 'admitted') fail('recovery_new_release_state_invalid');
    if (!productionSha) fail('recovery_production_missing');
    const ancestry = await runner(
      'git',
      ['merge-base', '--is-ancestor', productionSha, target.targetSha],
      { cwd: repoRoot, allowExitCodes: [0, 1] },
    );
    if (ancestry.exitCode !== 0) fail('recovery_target_not_descendant');
    return { ...base, supersedes: recoverySource };
  }

  fail('operation_facts_unknown');
}

async function recheckIntentFacts({
  runner,
  repoRoot,
  config,
  tag,
  operation,
  deployment,
  assetId,
  requestedIntent,
  facts,
  intent,
  intentAsset,
  clock,
}) {
  if (operation === 'anchor-admission') {
    const rechecked = await readOperationFacts({
      runner,
      repoRoot,
      config,
      tag,
      operation,
      assetId,
      clock,
    });
    if (canonicalJson(rechecked) !== canonicalJson(facts)) {
      fail('anchor_admission_facts_changed');
    }
    return;
  }
  if (['resume', 'recover'].includes(operation)) {
    const rechecked = await readOperationFacts({
      runner,
      repoRoot,
      config,
      tag,
      operation,
      deployment,
      intent: requestedIntent,
      clock,
    });
    if (canonicalJson(rechecked) !== canonicalJson(facts)) {
      fail('intent_facts_changed');
    }
    return;
  }

  const target = await verifyTargetTree({ runner, repoRoot, tag, config });
  const vercelCliVersion = await verifyVercelCliVersion({ runner, repoRoot, config });
  const snapshot = await readReleaseSnapshot({ runner, repoRoot, config, tag, clock });
  if (snapshot.state !== intent.state) fail('intent_state_not_authoritative');
  const intentDigest = sha256(canonicalJson(intent));
  const decodedIntent = snapshot.decodedAssets.find(
    ({ digest }) => digest === intentDigest,
  );
  if (!decodedIntent) fail('intent_asset_not_found_after_upload');
  if (snapshot.lastEvidenceCreatedAt !== intent.createdAt) {
    fail('intent_not_latest_after_upload');
  }
  if (
    canonicalJson(decodedIntent.identity) !== canonicalJson(intentAsset)
  ) {
    fail('intent_asset_identity_mismatch');
  }
  const channel = await readRepositoryChannel({ runner, repoRoot, config, clock });
  validateReleaseChannel({
    entries: channel,
    targetTag: tag,
    operation,
  });
  const productionSha = await readRemoteBranchSha({ runner, repoRoot });
  const project = await readVercelProjectFacts({
    runner,
    repoRoot,
    config,
    requireReleaseSettings: !['adopt', 'initialize', 'rollback'].includes(operation),
  });
  if (operation === 'rollback' && project.productionBranch !== config.vercel.productionBranch) {
    fail('vercel_production_branch_mismatch');
  }
  const recheckedCurrentDeployment = project.current?.id
    ? await inspectDeployment({
        runner,
        repoRoot,
        config,
        deploymentId: project.current.id,
      })
    : null;
  const rechecked = {
    repository: config.repository,
    tag,
    targetSha: target.targetSha,
    mainSha: target.mainSha,
    configHash: snapshot.configHash,
    artifactManifest: target.artifactManifest,
    // The uploaded intent is now the latest evidence. Compare the baseline it
    // captured before upload, not the intent's own timestamp, with preview facts.
    lastEvidenceCreatedAt: intent.lastEvidenceCreatedAt,
    productionSha,
    currentDeploymentId: project.current?.id ?? null,
    currentDeploymentUrl: project.current?.url ?? null,
    currentDeploymentSha:
      recheckedCurrentDeployment?.meta?.releaseCommitSha ??
      recheckedCurrentDeployment?.meta?.githubCommitSha ??
      recheckedCurrentDeployment?.meta?.gitCommitSha ??
      null,
    teamId: config.vercel.teamId,
    projectId: config.vercel.projectId,
    rootDirectory: config.vercel.rootDirectory,
    productionDomains: config.vercel.productionDomains,
    vercelCliVersion,
  };
  if (operation === 'rollback') {
    rechecked.settingsMatch = project.autoAssignCustomDomains === config.vercel.autoAssignCustomDomains;
    rechecked.settingsWrites = facts.settingsWrites;
  }
  for (const key of Object.keys(rechecked)) {
    if (canonicalJson(rechecked[key]) !== canonicalJson(facts[key])) {
      fail(`intent_facts_changed:${key}`);
    }
  }
}

async function pushProduction({
  runner,
  repoRoot,
  config,
  tag,
  oldSha,
  newSha,
  configHash,
  nonce,
  clock,
}) {
  await writeProductionCapability({
    runner,
    repoRoot,
    config,
    tag,
    oldSha: oldSha ?? ZERO_SHA,
    newSha,
    configHash,
    nonce,
    expiresAt: new Date(
      clock().getTime() + config.controller.authorizationTtlSeconds * 1000,
    ).toISOString(),
  });
  await runner(
    'git',
    ['push', 'origin', `${newSha}:refs/heads/${config.productionBranch}`],
    { cwd: repoRoot },
  );
  const verified = await readRemoteBranchSha({ runner, repoRoot });
  if (verified !== newSha) fail('production_ref_verification_failed');
}

async function persistAdmissionReceipt({
  runner,
  repoRoot,
  config,
  tag,
  facts,
}) {
  if (facts.receiptIdentity) {
    return { receiptIdentity: facts.receiptIdentity, alreadyAnchored: true };
  }
  if (!facts.provenance) fail('anchor_admission_provenance_missing');
  let receipt;
  if (facts.mode === 'hosted') {
    const { artifact, ...proof } = facts.provenance;
    receipt = {
      schemaVersion: 1,
      kind: 'release-admission-receipt',
      repository: facts.repository,
      tag,
      targetSha: facts.targetSha,
      admissionAsset: facts.admissionIdentity,
      mode: 'hosted',
      hostedProof: proof,
      billingProof: null,
      artifact,
      releasePublishedAt: facts.releasePublishedAt,
    };
  } else if (facts.mode === 'billing-fallback') {
    receipt = {
      schemaVersion: 1,
      kind: 'release-admission-receipt',
      repository: facts.repository,
      tag,
      targetSha: facts.targetSha,
      admissionAsset: facts.admissionIdentity,
      mode: 'billing-fallback',
      hostedProof: null,
      billingProof: facts.provenance,
      artifact: null,
      releasePublishedAt: facts.releasePublishedAt,
    };
  } else {
    fail('release_admission_receipt_mode_invalid');
  }
  // Validate the complete receipt before creating any local or remote asset.
  assertAdmissionReceipt({
    receipt,
    config,
    tag,
    admission: facts.admission,
    admissionIdentity: facts.admissionIdentity,
  });
  const localReceipt = await writeLocalEvidence({
    repoRoot,
    tag,
    fileName: ADMISSION_RECEIPT_ASSET,
    value: receipt,
  });
  const receiptIdentity = await uploadAndAnchorReleaseAsset({
    runner,
    repoRoot,
    config,
    tag,
    filePath: localReceipt.filePath,
  });
  return { receiptIdentity };
}

export async function createRuntime({
  repoRoot,
  runner = createCommandRunner(),
  clock = () => new Date(),
  nonce,
  tempRoot = os.tmpdir(),
  environment = process.env,
} = {}) {
  const config = await loadReleaseConfig(repoRoot);
  const operations = {
    admit: (request) => runAdmission({ runner, clock, tempRoot, environment, ...request }),
    audit: async (request) => {
      if (request.localOnly) return localAudit({ runner, repoRoot, config });
      if (!request.tag) fail('audit_tag_required');
      return remoteAudit({
        runner,
        repoRoot,
        config,
        tag: request.tag,
        clock,
      });
    },
    readFacts: (request) =>
      readOperationFacts({ runner, clock, ...request }),
    recheckFacts: (request) =>
      recheckIntentFacts({ runner, clock, ...request }),
    acquireLease: (request) =>
      acquireReleaseLease({
        runner,
        repoRoot,
        config,
        command: request.operation,
        tag: request.tag,
        now: clock(),
      }),
    writeIntent: async ({ operation, tag, intent }) => {
      const local = await writeLocalEvidence({
        repoRoot,
        tag,
        fileName: `release-intent-${operation}-${intent.nonce}.json`,
        value: intent,
      });
      return uploadAndAnchorReleaseAsset({ runner, repoRoot, config, tag, filePath: local.filePath });
    },
    runOperation: async ({ operation, tag, facts, intent }) => {
      if (operation === 'anchor-admission') {
        return persistAdmissionReceipt({
          runner,
          repoRoot,
          config,
          tag,
          facts,
        });
      }
      if (operation === 'initialize') {
        await pushProduction({
          runner,
          repoRoot,
          config,
          tag,
          oldSha: null,
          newSha: facts.targetSha,
          configHash: facts.configHash,
          nonce: intent.nonce,
          clock,
        });
        const postInitializeProject = await readVercelProjectFacts({
          runner,
          repoRoot,
          config,
          requireReleaseSettings: false,
        });
        if (postInitializeProject.current?.id !== facts.currentDeploymentId) {
          fail('initialize_changed_current_deployment');
        }
        return { productionSha: facts.targetSha };
      }
      if (operation === 'stage') {
        if (facts.productionSha !== facts.targetSha) {
          await pushProduction({
            runner,
            repoRoot,
            config,
            tag,
            oldSha: facts.productionSha,
            newSha: facts.targetSha,
            configHash: facts.configHash,
            nonce: intent.nonce,
            clock,
          });
        }
        const deployment = await createStagedDeployment({
          runner,
          repoRoot,
          config,
          targetSha: facts.targetSha,
          tag,
          configHash: facts.configHash,
          tempRoot,
        });
        const postStageProject = await readVercelProjectFacts({
          runner,
          repoRoot,
          config,
        });
        if (postStageProject.current?.id !== facts.currentDeploymentId) {
          fail('stage_changed_current_deployment');
        }
        const postStageProduction = await readRemoteBranchSha({ runner, repoRoot });
        if (postStageProduction !== facts.targetSha) {
          fail('stage_production_ref_verification_failed');
        }
        const stagedAcceptance = await runStagedAcceptance({
          runner,
          repoRoot,
          config,
          deploymentUrl: deployment.url,
        });
        return { productionSha: facts.targetSha, deployment, stagedAcceptance };
      }
      if (operation === 'promote') {
        const inspected = await inspectDeployment({
          runner,
          repoRoot,
          config,
          deploymentId: facts.stagedDeploymentId,
        });
        if (
          inspected.readyState !== 'READY' ||
          inspected.target !== 'production' ||
          inspected.meta?.releaseCommitSha !== facts.targetSha ||
          inspected.meta?.releaseTag !== tag ||
          inspected.meta?.releaseConfigHash !== facts.configHash
        ) {
          fail('promote_deployment_sha_mismatch');
        }
        await promoteDeployment({
          runner,
          repoRoot,
          config,
          deploymentUrl: facts.stagedDeploymentUrl,
        });
        const project = await readVercelProjectFacts({ runner, repoRoot, config });
        if (project.current?.id !== facts.stagedDeploymentId) {
          fail('promote_current_verification_failed');
        }
        const promotedProduction = await readRemoteBranchSha({ runner, repoRoot });
        if (promotedProduction !== facts.targetSha) {
          fail('promote_production_ref_changed');
        }
        const productionAcceptance = await runProductionAcceptance({
          runner,
          repoRoot,
          config,
        });
        return {
          deployment: { id: inspected.id, url: inspected.url },
          productionAcceptance,
        };
      }
      if (operation === 'adopt') {
        return {
          completionState: 'adopted',
          productionSha: facts.productionSha,
          currentDeploymentId: facts.currentDeploymentId,
          currentDeploymentSha: facts.currentDeploymentSha,
          deployment: {
            id: facts.currentDeploymentId,
            url: facts.currentDeploymentUrl,
          },
          adopted: true,
        };
      }
      if (operation === 'rollback') {
        await rollbackDeployment({
          runner,
          repoRoot,
          config,
          deploymentUrl: facts.rollbackDeploymentUrl,
        });
        let project = await readVercelProjectFacts({
          runner,
          repoRoot,
          config,
          requireReleaseSettings: false,
        });
        if (project.autoAssignCustomDomains !== false) {
          await restoreAutoAssignSetting({
            runner,
            repoRoot,
            config,
            authorized: hasAuthorizedSettingsWrite(facts.settingsWrites),
          });
        }
        project = await readVercelProjectFacts({ runner, repoRoot, config });
        if (project.current?.id !== facts.rollbackDeploymentId) {
          fail('rollback_current_verification_failed');
        }
        const rollbackProduction = await readRemoteBranchSha({ runner, repoRoot });
        if (rollbackProduction !== facts.targetSha) {
          fail('rollback_production_ref_changed');
        }
        const productionAcceptance = await runProductionAcceptance({
          runner,
          repoRoot,
          config,
        });
        return { deployment: project.current, productionAcceptance };
      }
      if (operation === 'resume') {
        const action = facts.resumeAction;
        if (action.action === 'finalize_completion') {
          const operationResult = {
            completionState:
              action.evidenceType === 'production_acceptance'
                ? 'current'
                : action.evidenceType,
            resumed: true,
          };
          if (action.evidenceType === 'staged_pending_promote') {
            operationResult.deployment = facts.matchingDeployments[0];
            operationResult.stagedAcceptance = await runStagedAcceptance({
              runner,
              repoRoot,
              config,
              deploymentUrl: facts.matchingDeployments[0].url,
            });
          }
          if (action.evidenceType === 'production_acceptance') {
            operationResult.deployment = {
              id: facts.intent.deploymentId,
              url: facts.intent.deploymentUrl,
            };
            operationResult.productionAcceptance = await runProductionAcceptance({
              runner,
              repoRoot,
              config,
            });
          }
          if (action.evidenceType === 'rolled_back') {
            operationResult.deployment = {
              id: facts.intent.targetDeploymentId,
              url: facts.intent.targetDeploymentUrl,
            };
            operationResult.productionAcceptance = await runProductionAcceptance({
              runner,
              repoRoot,
              config,
            });
          }
          if (action.evidenceType === 'initialized') {
            operationResult.productionSha =
              facts.intent.targetSha;
          }
          if (action.evidenceType === 'adopted') {
            operationResult.productionSha = facts.intent.oldSha;
            operationResult.currentDeploymentId = facts.intent.expectedCurrentDeploymentId;
            operationResult.currentDeploymentSha = facts.intent.oldSha;
            operationResult.deployment = {
              id: facts.intent.expectedCurrentDeploymentId,
              url: facts.intent.currentDeploymentUrl,
            };
            operationResult.adopted = true;
          }
          return operationResult;
        }
        const original = facts.intent;
        if (action.nextStep === 'create_production_ref') {
          await pushProduction({
            runner,
            repoRoot,
            config,
            tag,
            oldSha: null,
            newSha: original.targetSha,
            configHash: original.configHash,
            nonce: original.nonce,
            clock,
          });
          const initializedProject = await readVercelProjectFacts({
            runner,
            repoRoot,
            config,
            requireReleaseSettings: false,
          });
          if (initializedProject.current?.id !== original.currentDeploymentId) {
            fail('resume_initialize_changed_current_deployment');
          }
          return { completionState: 'initialized', productionSha: original.targetSha, resumed: true };
        }
        if (action.nextStep === 'push_production_ref') {
          await pushProduction({
            runner,
            repoRoot,
            config,
            tag,
            oldSha: original.oldSha,
            newSha: original.targetSha,
            configHash: original.configHash,
            nonce: original.nonce,
            clock,
          });
          const staged = await createStagedDeployment({
            runner,
            repoRoot,
            config,
            targetSha: original.targetSha,
            tag,
            configHash: original.configHash,
            tempRoot,
          });
          const stagedAcceptance = await runStagedAcceptance({
            runner,
            repoRoot,
            config,
            deploymentUrl: staged.url,
          });
          const stageProject = await readVercelProjectFacts({ runner, repoRoot, config });
          if (stageProject.current?.id !== original.expectedCurrentDeploymentId) {
            fail('resume_stage_changed_current_deployment');
          }
          if (await readRemoteBranchSha({ runner, repoRoot }) !== original.targetSha) {
            fail('resume_stage_production_ref_changed');
          }
          return { completionState: 'staged_pending_promote', deployment: staged, stagedAcceptance, resumed: true };
        }
        if (action.nextStep === 'build_and_stage_deployment') {
          const staged = await createStagedDeployment({
            runner,
            repoRoot,
            config,
            targetSha: original.targetSha,
            tag,
            configHash: original.configHash,
            tempRoot,
          });
          const stagedAcceptance = await runStagedAcceptance({
            runner,
            repoRoot,
            config,
            deploymentUrl: staged.url,
          });
          const stageProject = await readVercelProjectFacts({ runner, repoRoot, config });
          if (stageProject.current?.id !== original.expectedCurrentDeploymentId) {
            fail('resume_stage_changed_current_deployment');
          }
          if (await readRemoteBranchSha({ runner, repoRoot }) !== original.targetSha) {
            fail('resume_stage_production_ref_changed');
          }
          return { completionState: 'staged_pending_promote', deployment: staged, stagedAcceptance, resumed: true };
        }
        if (action.nextStep === 'promote_deployment') {
          await promoteDeployment({
            runner,
            repoRoot,
            config,
            deploymentUrl: original.deploymentUrl,
          });
          const promoted = await readVercelProjectFacts({ runner, repoRoot, config });
          if (promoted.current?.id !== original.deploymentId) {
            fail('resume_promote_verification_failed');
          }
          const promotedProduction = await readRemoteBranchSha({ runner, repoRoot });
          if (promotedProduction !== original.targetSha) {
            fail('resume_promote_production_ref_changed');
          }
          const productionAcceptance = await runProductionAcceptance({
            runner,
            repoRoot,
            config,
          });
          return {
            completionState: 'current',
            deployment: promoted.current,
            productionAcceptance,
            resumed: true,
          };
        }
        if (action.nextStep === 'rollback_deployment') {
          await rollbackDeployment({
            runner,
            repoRoot,
            config,
            deploymentUrl: original.targetDeploymentUrl,
          });
        }
        if (
          action.nextStep === 'rollback_deployment' ||
          action.nextStep === 'restore_vercel_settings'
        ) {
          let restored = await readVercelProjectFacts({
            runner,
            repoRoot,
            config,
            requireReleaseSettings: false,
          });
          if (restored.autoAssignCustomDomains !== false) {
            await restoreAutoAssignSetting({
              runner,
              repoRoot,
              config,
              authorized: hasAuthorizedSettingsWrite(
                original.settingsWrites ?? facts.settingsWrites,
              ),
            });
          }
          restored = await readVercelProjectFacts({ runner, repoRoot, config });
          if (restored.current?.id !== original.targetDeploymentId) {
            fail('resume_rollback_verification_failed');
          }
          const rollbackProduction = await readRemoteBranchSha({ runner, repoRoot });
          if (rollbackProduction !== original.targetSha) {
            fail('resume_rollback_production_ref_changed');
          }
          const productionAcceptance = await runProductionAcceptance({
            runner,
            repoRoot,
            config,
          });
          return {
            completionState: 'rolled_back',
            deployment: restored.current,
            productionAcceptance,
            resumed: true,
          };
        }
        if (action.nextStep === 'renew_evidence') {
          const result = {
            completionState: original.renewState,
            renewed: true,
            resumed: true,
          };
          if (original.renewState === 'staged_pending_promote') {
            result.deployment = {
              id: original.stagedDeploymentId,
              url: original.stagedDeploymentUrl,
            };
            result.stagedAcceptance = await runStagedAcceptance({
              runner,
              repoRoot,
              config,
              deploymentUrl: original.stagedDeploymentUrl,
            });
          }
          return result;
        }
        if (action.nextStep === 'record_stage_failed') {
          return {
            completionState: 'stage_failed',
            failureReason: 'staged_window_abandoned',
            resumed: true,
          };
        }
        fail(`resume_step_unknown:${action.nextStep}`);
      }
      if (operation === 'recover') {
        return {
          supersedes: facts.supersedes,
          recoveryProductionSha: facts.productionSha,
          expectedCurrentDeploymentId: facts.currentDeploymentId,
        };
      }
      if (operation === 'renew') {
        const result = { completionState: facts.renewState, renewed: true };
        if (facts.renewState === 'staged_pending_promote') {
          result.deployment = {
            id: facts.stagedDeploymentId,
            url: facts.stagedDeploymentUrl,
          };
          result.stagedAcceptance = await runStagedAcceptance({
            runner,
            repoRoot,
            config,
            deploymentUrl: facts.stagedDeploymentUrl,
          });
        }
        return result;
      }
      if (operation === 'fail') {
        return {
          completionState: 'stage_failed',
          failureReason: facts.failureReason,
        };
      }
      fail('operation_execution_unknown');
    },
    writeCompletion: async ({ operation, tag, facts, intent, intentAsset, operationResult }) => {
      if (operation === 'anchor-admission') return operationResult;
      const underlying = operation === 'resume' ? facts.intent.operation : operation;
      const state =
        operationResult.completionState ?? completionState(underlying);
      if (!state) fail('completion_state_unknown');
      const completion = {
        schemaVersion: 1,
        state,
        fromState: operation === 'recover' ? 'admitted' : `${underlying}_intent`,
        operation: underlying,
        repository: config.repository,
        tag,
        targetSha: facts.targetSha,
        configHash: facts.configHash,
        intentAsset: operation === 'resume' ? facts.intentIdentity : intentAsset,
        operationResult,
        createdAt: (() => {
          const observed = clock();
          const previous = Date.parse(
            operation === 'resume'
              ? facts.intent.createdAt
              : intent?.createdAt ?? facts.lastEvidenceCreatedAt,
          );
          return Number.isFinite(previous) && observed.getTime() <= previous
            ? new Date(previous + 1).toISOString()
            : observed.toISOString();
        })(),
      };
      if (operation !== 'recover') {
        completion.intentSha256 = sha256(
          canonicalJson(operation === 'resume' ? facts.intent : intent),
        );
      }
      if (operation === 'recover') completion.supersedes = facts.supersedes;
      const prefix = {
        adopted: 'production-adoption',
        current: 'production-acceptance',
        rolled_back: 'production-rollback',
        recovery_admitted: 'recovery-admitted',
        stage_failed: 'release-failure',
        initialized: underlying === 'renew' ? 'production-renewal' : 'production-promotion',
        staged_pending_promote: underlying === 'renew' ? 'production-renewal' : 'production-promotion',
      }[state];
      const local = await writeLocalEvidence({
        repoRoot,
        tag,
        fileName: `${prefix}-${operation === 'resume' ? facts.intent.nonce : intent.nonce}.json`,
        value: completion,
      });
      return uploadAndAnchorReleaseAsset({ runner, repoRoot, config, tag, filePath: local.filePath });
    },
  };
  const releaseController = createReleaseController({ clock, nonce, operations });
  const controller = {
    ...releaseController,
    unlock: (request) =>
      clearStaleReleaseLease({
        runner,
        repoRoot,
        config,
        tag: request.tag,
        authorize: request.authorize,
        now: clock(),
      }),
    'anchor-admission': (request) => releaseController.anchorAdmission(request),
  };
  return { repoRoot, config, controller };
}
