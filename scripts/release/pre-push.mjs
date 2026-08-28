import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { hashReleaseConfig, loadReleaseConfig } from './config.mjs';
import { getControllerPaths, readControllerBinding } from './lock.mjs';
import { createCommandRunner } from './process.mjs';

const ZERO_SHA = '0'.repeat(40);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function denied(reasonCode) {
  return { allowed: false, reasonCode };
}

function parseRows(input) {
  const rows = [];
  for (const rawLine of input.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length !== 4 || !SHA_PATTERN.test(fields[1]) || !SHA_PATTERN.test(fields[3])) {
      throw new Error('pre_push_input_invalid');
    }
    rows.push({
      localRef: fields[0],
      localSha: fields[1],
      remoteRef: fields[2],
      remoteSha: fields[3],
    });
  }
  return rows;
}

async function consumeCapability(capabilityPath, capability, now) {
  const temporaryPath = `${capabilityPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify({ ...capability, consumed: true, consumedAt: now.toISOString() })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, capabilityPath);
}

export async function evaluatePrePush({
  input,
  repoRoot,
  config,
  runner,
  now = new Date(),
  controllerPaths,
}) {
  const rows = parseRows(input);
  const productionRows = rows.filter(
    ({ remoteRef }) => remoteRef === `refs/heads/${config.productionBranch}`,
  );
  if (productionRows.length === 0) return { allowed: true, reasonCode: 'non_production_ref' };
  if (productionRows.length !== 1) return denied('multiple_production_updates_forbidden');

  const row = productionRows[0];
  if (row.localSha === ZERO_SHA) return denied('production_delete_forbidden');

  try {
    await readControllerBinding({ runner, repoRoot, config });
  } catch (error) {
    return denied(error.message);
  }
  const paths = controllerPaths ?? await getControllerPaths({ runner, repoRoot });
  const claimPath = `${paths.capabilityPath}.claim`;
  try {
    await mkdir(claimPath, { mode: 0o700 });
  } catch (error) {
    return denied(error?.code === 'EEXIST' ? 'capability_claim_active' : 'capability_claim_failed');
  }
  try {
  let capability;
  try {
    const stats = await stat(paths.capabilityPath);
    if ((stats.mode & 0o777) !== 0o600) return denied('capability_mode_invalid');
    capability = JSON.parse(await readFile(paths.capabilityPath, 'utf8'));
  } catch (error) {
    return denied(error?.code === 'ENOENT' ? 'capability_missing' : 'capability_invalid');
  }

  if (capability.consumed === true) return denied('capability_already_consumed');
  if (
    capability.schemaVersion !== 1 ||
    capability.repository !== config.repository ||
    capability.configHash !== hashReleaseConfig(config)
  ) {
    return denied('capability_binding_mismatch');
  }
  if (capability.oldSha !== row.remoteSha || capability.newSha !== row.localSha) {
    return denied('capability_ref_mismatch');
  }
  const expiresAt = Date.parse(capability.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return denied('capability_expired');
  if (
    typeof capability.tag !== 'string' ||
    !(new RegExp(config.tagPattern)).test(capability.tag) ||
    typeof capability.nonce !== 'string' ||
    capability.nonce.length < 16
  ) {
    return denied('capability_invalid');
  }

  let tagSha;
  try {
    const tagResult = await runner('git', ['rev-parse', `refs/tags/${capability.tag}^{commit}`], {
      cwd: repoRoot,
    });
    tagSha = tagResult.stdout.trim();
  } catch {
    return denied('capability_tag_missing');
  }
  if (tagSha !== row.localSha) return denied('capability_tag_sha_mismatch');

  if (row.remoteSha !== ZERO_SHA) {
    const ancestry = await runner(
      'git',
      ['merge-base', '--is-ancestor', row.remoteSha, row.localSha],
      { cwd: repoRoot, allowExitCodes: [0, 1] },
    );
    if (ancestry.exitCode !== 0) return denied('production_non_fast_forward_forbidden');
  }

  await consumeCapability(paths.capabilityPath, capability, now);
  return { allowed: true, reasonCode: 'capability_consumed' };
  } finally {
    await rmdir(claimPath).catch(() => {});
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main() {
  const repoRoot = process.cwd();
  const runner = createCommandRunner();
  const config = await loadReleaseConfig(repoRoot);
  const result = await evaluatePrePush({
    input: await readStdin(),
    repoRoot,
    config,
    runner,
  });
  if (!result.allowed) {
    process.stderr.write(`release-controller: ${result.reasonCode}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`release-controller: ${error.message}\n`);
    process.exitCode = 1;
  });
}
