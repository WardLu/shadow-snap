import { createHash, randomUUID } from 'node:crypto';
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

import { listReleaseAssets, resolveGitHubRepository } from './github.mjs';

function fail(reasonCode) {
  throw new Error(reasonCode);
}

function normalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical_json_number_invalid');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          if (value[key] === undefined) fail('canonical_json_undefined');
          return [key, normalize(value[key])];
        }),
    );
  }
  fail('canonical_json_type_invalid');
}

export function canonicalJson(value) {
  return `${JSON.stringify(normalize(value))}\n`;
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function assertEvidencePath(tag, fileName) {
  if (!/^v[0-9A-Za-z.-]+$/.test(tag) || tag.includes('..')) fail('evidence_tag_invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(fileName) || fileName.includes('..')) {
    fail('evidence_file_name_invalid');
  }
}

export async function writeLocalEvidence({ repoRoot, tag, fileName, value }) {
  assertEvidencePath(tag, fileName);
  const directory = path.join(repoRoot, '.release-state', tag);
  const filePath = path.join(directory, fileName);
  const contents = canonicalJson(value);
  const digest = sha256(contents);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(path.join(repoRoot, '.release-state'), 0o700);
  await chmod(directory, 0o700);

  const claimPath = `${filePath}.claim`;
  try {
    await mkdir(claimPath, { mode: 0o700 });
  } catch (error) {
    fail(error?.code === 'EEXIST' ? 'local_evidence_claim_active' : 'local_evidence_claim_failed');
  }
  try {

  try {
    const existing = await readFile(filePath, 'utf8');
    if (sha256(existing) !== digest) fail('local_evidence_conflict');
    return { filePath, sha256: digest, size: Buffer.byteLength(existing) };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(temporaryPath, 0o600);
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    const existing = await readFile(filePath, 'utf8').catch(() => null);
    if (existing !== null && sha256(existing) === digest) {
      return { filePath, sha256: digest, size: Buffer.byteLength(existing) };
    }
    throw error;
  }
  return { filePath, sha256: digest, size: Buffer.byteLength(contents) };
  } finally {
    await rmdir(claimPath).catch(() => {});
  }
}

export async function uploadUniqueReleaseAsset({ runner, repoRoot, tag, filePath }) {
  const repository = await resolveGitHubRepository({ runner, repoRoot });
  const name = path.basename(filePath);
  const before = await listReleaseAssets({
    runner,
    repoRoot,
    tag,
    repository,
  });
  if (before.assets.some((asset) => asset.name === name)) {
    fail('release_asset_already_exists');
  }

  const fileStats = await stat(filePath);
  const localDigest = sha256(await readFile(filePath));
  await runner(
    'gh',
    ['release', 'upload', tag, filePath, '--repo', repository],
    { cwd: repoRoot },
  );
  const after = await listReleaseAssets({
    runner,
    repoRoot,
    tag,
    repository,
  });
  const matches = after.assets.filter((asset) => asset.name === name);
  if (matches.length !== 1) fail('release_asset_upload_not_unique');
  const asset = matches[0];
  if (
    !Number.isInteger(asset.id) ||
    asset.size !== fileStats.size ||
    typeof asset.created_at !== 'string'
  ) {
    fail('release_asset_identity_invalid');
  }
  return {
    id: asset.id,
    name: asset.name,
    createdAt: asset.created_at,
    size: asset.size,
    sha256: localDigest,
  };
}
