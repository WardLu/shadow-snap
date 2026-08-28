import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256, writeLocalEvidence } from './evidence.mjs';
import { inspectReleaseLease } from './lock.mjs';

function fail(reasonCode) {
  throw new Error(reasonCode);
}

function authorizationPath(repoRoot, tag, digest) {
  return path.join(
    repoRoot,
    '.release-state',
    tag,
    `authorization-unlock-${digest}.json`,
  );
}

function authorizationPayload({ config, tag, inspection, now }) {
  return {
    schemaVersion: 1,
    repository: config.repository,
    operation: 'unlock',
    tag,
    leaseSha256: sha256(canonicalJson(inspection.lease)),
    lease: inspection.lease,
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + config.controller.authorizationTtlSeconds * 1000,
    ).toISOString(),
  };
}

export async function clearStaleReleaseLease({
  runner,
  repoRoot,
  config,
  tag,
  authorize,
  now = new Date(),
}) {
  const inspection = await inspectReleaseLease({
    runner,
    repoRoot,
    config,
    now,
  });
  if (inspection.status !== 'stale_lock_requires_authorization') {
    fail(`unlock_lease_not_stale:${inspection.status}`);
  }
  if (inspection.lease.tag !== tag) fail('unlock_tag_mismatch');
  if (!authorize) {
    const payload = authorizationPayload({ config, tag, inspection, now });
    const digest = sha256(canonicalJson(payload));
    await writeLocalEvidence({
      repoRoot,
      tag,
      fileName: `authorization-unlock-${digest}.json`,
      value: { ...payload, authorizationDigest: digest },
    });
    return {
      status: 'authorization_required',
      authorizationDigest: digest,
      authorization: payload,
    };
  }
  const claimPath = path.join(inspection.stateDir, 'unlock-claim');
  try {
    await mkdir(claimPath, { mode: 0o700 });
  } catch (error) {
    fail(error?.code === 'EEXIST' ? 'unlock_claim_active' : 'unlock_claim_failed');
  }
  try {
    const recordPath = authorizationPath(repoRoot, tag, authorize);
    const recordStats = await stat(recordPath).catch((error) => {
      if (error?.code === 'ENOENT') fail('unlock_authorization_missing');
      throw error;
    });
    if ((recordStats.mode & 0o777) !== 0o600) fail('unlock_authorization_mode_invalid');
    let record;
    try {
      record = JSON.parse(await readFile(recordPath, 'utf8'));
    } catch {
      fail('unlock_authorization_json_invalid');
    }
    const storedPayload = {
      schemaVersion: record.schemaVersion,
      repository: record.repository,
      operation: record.operation,
      tag: record.tag,
      leaseSha256: record.leaseSha256,
      lease: record.lease,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
    if (
      record.authorizationDigest !== authorize ||
      sha256(canonicalJson(storedPayload)) !== authorize
    ) fail('unlock_authorization_binding_mismatch');
    if (Date.parse(record.expiresAt) <= now.getTime()) fail('unlock_authorization_expired');

    const rechecked = await inspectReleaseLease({
      runner,
      repoRoot,
      config,
      now,
    });
    if (
      rechecked.status !== 'stale_lock_requires_authorization' ||
      sha256(canonicalJson(rechecked.lease)) !== storedPayload.leaseSha256
    ) fail('unlock_lease_changed');

    const archiveRoot = path.join(inspection.stateDir, 'stale-leases');
    await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    await chmod(archiveRoot, 0o700);
    const archivePath = path.join(
      archiveRoot,
      `${now.toISOString().replaceAll(/[^0-9A-Za-z]/g, '')}-${randomUUID()}`,
    );
    await rename(inspection.leaseDir, archivePath);
    const receiptPath = path.join(archivePath, 'unlock-receipt.json');
    await writeFile(
      receiptPath,
      canonicalJson({
        schemaVersion: 1,
        repository: config.repository,
        tag,
        authorizationDigest: authorize,
        leaseSha256: storedPayload.leaseSha256,
        archivedAt: now.toISOString(),
      }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    await chmod(receiptPath, 0o600);
    return {
      status: 'completed',
      operation: 'unlock',
      tag,
      archivedLeasePath: path.relative(repoRoot, archivePath),
    };
  } finally {
    await rmdir(claimPath).catch(() => {});
  }
}
