import { randomUUID } from 'node:crypto';
import {
  chmod,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256, writeLocalEvidence } from './evidence.mjs';

function fail(reasonCode) {
  throw new Error(reasonCode);
}

function strictlyAfter(now, previousTimestamp) {
  const previous = Date.parse(previousTimestamp ?? '');
  if (!Number.isFinite(previous) || now.getTime() > previous) return now.toISOString();
  return new Date(previous + 1).toISOString();
}

function assertOperationSet(operations) {
  for (const name of [
    'readFacts',
    'acquireLease',
    'writeIntent',
    'runOperation',
    'writeCompletion',
    'audit',
    'admit',
  ]) {
    if (typeof operations?.[name] !== 'function') fail(`controller_operation_missing:${name}`);
  }
}

function authorizationFile(repoRoot, tag, operation, digest) {
  return path.join(
    repoRoot,
    '.release-state',
    tag,
    `authorization-${operation}-${digest}.json`,
  );
}

async function createAuthorization({
  repoRoot,
  config,
  operation,
  tag,
  facts,
  now,
  nonce,
}) {
  const factsHash = sha256(canonicalJson(facts));
  const payload = {
    schemaVersion: 1,
    repository: config.repository,
    operation,
    tag,
    targetSha: facts.targetSha ?? null,
    factsHash,
    facts,
    nonce,
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + config.controller.authorizationTtlSeconds * 1000,
    ).toISOString(),
  };
  const authorizationDigest = sha256(canonicalJson(payload));
  await writeLocalEvidence({
    repoRoot,
    tag,
    fileName: `authorization-${operation}-${authorizationDigest}.json`,
    value: { ...payload, authorizationDigest, consumed: false },
  });
  return {
    status: 'authorization_required',
    authorizationDigest,
    authorization: payload,
  };
}

async function consumeAuthorization({
  repoRoot,
  config,
  operation,
  tag,
  facts,
  digest,
  now,
}) {
  if (!/^[0-9a-f]{64}$/.test(digest ?? '')) fail('authorization_digest_invalid');
  const filePath = authorizationFile(repoRoot, tag, operation, digest);
  const fileStats = await stat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') fail('authorization_missing');
    throw error;
  });
  if ((fileStats.mode & 0o777) !== 0o600) fail('authorization_mode_invalid');
  let record;
  try {
    record = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    fail('authorization_json_invalid');
  }
  if (record.consumed === true) fail('authorization_already_consumed');
  if (
    record.schemaVersion !== 1 ||
    record.repository !== config.repository ||
    record.operation !== operation ||
    record.tag !== tag ||
    record.authorizationDigest !== digest
  ) {
    fail('authorization_binding_mismatch');
  }
  const payload = {
    schemaVersion: record.schemaVersion,
    repository: record.repository,
    operation: record.operation,
    tag: record.tag,
    targetSha: record.targetSha,
    factsHash: record.factsHash,
    facts: record.facts,
    nonce: record.nonce,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
  if (sha256(canonicalJson(payload)) !== digest) fail('authorization_digest_mismatch');
  if (Date.parse(record.expiresAt) <= now.getTime()) fail('authorization_expired');
  if (record.factsHash !== sha256(canonicalJson(facts))) {
    fail('authorization_facts_changed');
  }
  if (canonicalJson(record.facts) !== canonicalJson(facts)) {
    fail('authorization_facts_changed');
  }

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    canonicalJson({ ...record, consumed: true, consumedAt: now.toISOString() }),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
  return record;
}

export function createReleaseController({
  clock = () => new Date(),
  nonce = randomUUID,
  operations,
} = {}) {
  assertOperationSet(operations);

  async function execute(operation, request, { writeNewIntent = true } = {}) {
    const { repoRoot, config, tag, authorize } = request;
    if (typeof repoRoot !== 'string' || typeof tag !== 'string') fail('controller_request_invalid');
    if (!authorize) {
      const facts = await operations.readFacts({ operation, ...request });
      const now = clock();
      return createAuthorization({
        repoRoot,
        config,
        operation,
        tag,
        facts,
        now,
        nonce: nonce(),
      });
    }
    const lease = await operations.acquireLease({ operation, ...request });
    try {
      const facts = await operations.readFacts({ operation, ...request });
      const now = clock();
      const authorization = await consumeAuthorization({
        repoRoot,
        config,
        operation,
        tag,
        facts,
        digest: authorize,
        now,
      });
      const evidenceFromState = facts.state ?? null;
      const intentFromState = {
        initialized_expired: 'initialized',
        staged_expired: 'staged_pending_promote',
      }[facts.state] ?? evidenceFromState;
      const intent = {
        ...facts,
        schemaVersion: 1,
        state: `${operation}_intent`,
        fromState: intentFromState,
        operation,
        repository: config.repository,
        tag,
        targetSha: facts.targetSha ?? null,
        configHash: facts.configHash,
        factsHash: authorization.factsHash,
        nonce: authorization.nonce,
        createdAt: strictlyAfter(now, facts.lastEvidenceCreatedAt),
        oldSha: facts.productionSha ?? null,
        expectedCurrentDeploymentId: facts.currentDeploymentId ?? null,
        deploymentId: facts.stagedDeploymentId ?? null,
        deploymentUrl: facts.stagedDeploymentUrl ?? null,
        currentDeploymentId: facts.currentDeploymentId ?? null,
        currentDeploymentUrl: facts.currentDeploymentUrl ?? null,
        targetDeploymentId: facts.rollbackDeploymentId ?? null,
        targetDeploymentUrl: facts.rollbackDeploymentUrl ?? null,
        renewState: facts.renewState ?? null,
      };
      const intentAsset = writeNewIntent
        ? await operations.writeIntent({ operation, ...request, facts, intent })
        : null;
      if (typeof operations.recheckFacts === 'function') {
        await operations.recheckFacts({
          operation,
          ...request,
          requestedIntent: request.intent,
          facts,
          intent,
          intentAsset,
        });
      } else {
        const rechecked = await operations.readFacts({ operation, ...request });
        if (canonicalJson(rechecked) !== canonicalJson(facts)) {
          fail('intent_facts_changed');
        }
      }
      const operationResult = await operations.runOperation({
        operation,
        ...request,
        facts,
        intent,
        intentAsset,
      });
      await operations.writeCompletion({
        operation,
        ...request,
        facts,
        intent,
        intentAsset,
        operationResult,
      });
      return {
        status: 'completed',
        operation,
        tag,
        targetSha: facts.targetSha ?? null,
        operationResult,
      };
    } finally {
      await lease.release();
    }
  }

  return {
    admit: (request) => operations.admit(request),
    audit: (request) => operations.audit(request),
    adopt: (request) => execute('adopt', request),
    initialize: (request) => execute('initialize', request),
    stage: (request) => execute('stage', request),
    promote: (request) => execute('promote', request),
    rollback: (request) => execute('rollback', request),
    resume: (request) => execute('resume', request, { writeNewIntent: false }),
    recover: (request) => execute('recover', request, { writeNewIntent: false }),
    renew: (request) => execute('renew', request),
    fail: (request) => execute('fail', request),
    anchorAdmission: (request) => execute('anchor-admission', request, { writeNewIntent: false }),
  };
}
