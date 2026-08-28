import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function fail(reasonCode) {
  throw new Error(reasonCode);
}

function modeOf(stats) {
  return stats.mode & 0o777;
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, filePath);
}

export function defaultControllerRegistryPath({
  platform = process.platform,
  homeDirectory = os.homedir(),
  xdgStateHome = process.env.XDG_STATE_HOME,
} = {}) {
  if (platform === 'darwin') {
    return path.join(
      homeDirectory,
      'Library',
      'Application Support',
      'Shadow Release Controller',
      'registry.json',
    );
  }
  return path.join(
    xdgStateHome || path.join(homeDirectory, '.local', 'state'),
    'shadow-release-controller',
    'registry.json',
  );
}

async function readRegistry(registryPath) {
  try {
    const registryStats = await stat(registryPath);
    if (modeOf(registryStats) !== 0o600) fail('controller_registry_mode_invalid');
    const registry = parseJson(
      await readFile(registryPath, 'utf8'),
      'controller_registry_json_invalid',
    );
    if (registry.schemaVersion !== 1 || !registry.repositories) {
      fail('controller_registry_shape_invalid');
    }
    return registry;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, repositories: {} };
    throw error;
  }
}

async function claimHostRegistry({
  registryPath,
  repository,
  instanceId,
  commonDir,
  checkoutPath,
  now,
}) {
  const registryDirectory = path.dirname(registryPath);
  const registryLock = `${registryPath}.lock`;
  await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  await chmod(registryDirectory, 0o700);
  try {
    await mkdir(registryLock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('controller_registry_lock_active');
    throw error;
  }
  try {
    const registry = await readRegistry(registryPath);
    const existing = registry.repositories[repository];
    if (existing) {
      if (
        existing.instanceId !== instanceId ||
        existing.commonDir !== commonDir ||
        existing.checkoutPath !== checkoutPath ||
        !/^[0-9a-f]{64}$/.test(existing.bindingSecret ?? '')
      ) {
        fail('controller_registry_already_claimed');
      }
      return existing;
    }
    const entry = {
      instanceId,
      commonDir,
      checkoutPath,
      bindingSecret: randomBytes(32).toString('hex'),
      claimedAt: now.toISOString(),
    };
    registry.repositories[repository] = entry;
    await writeJsonAtomic(registryPath, registry);
    return entry;
  } finally {
    await rmdir(registryLock);
  }
}

function parseJson(text, reasonCode) {
  try {
    return JSON.parse(text);
  } catch {
    fail(reasonCode);
  }
}

export async function getControllerPaths({ runner, repoRoot }) {
  const result = await runner('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoRoot,
  });
  const raw = result.stdout.trim();
  if (!raw) fail('git_common_dir_missing');
  const commonDir = path.resolve(repoRoot, raw);
  const stateDir = path.join(commonDir, 'release-controller');
  return {
    commonDir,
    stateDir,
    bindingPath: path.join(stateDir, 'binding.json'),
    capabilityPath: path.join(stateDir, 'capability.json'),
    leaseDir: path.join(stateDir, 'lease'),
    leasePath: path.join(stateDir, 'lease', 'lease.json'),
  };
}

export async function readControllerBinding({ runner, repoRoot, config }) {
  const paths = await getControllerPaths({ runner, repoRoot });
  const checkoutPath = await realpath(repoRoot);
  let bindingStats;
  let binding;
  try {
    bindingStats = await stat(paths.bindingPath);
    binding = parseJson(
      await readFile(paths.bindingPath, 'utf8'),
      'controller_binding_json_invalid',
    );
  } catch (error) {
    if (error?.code === 'ENOENT') fail('controller_binding_missing');
    throw error;
  }
  if (modeOf(bindingStats) !== 0o600) fail('controller_binding_mode_invalid');
  if (
    binding.schemaVersion !== 1 ||
    binding.repository !== config.repository ||
    binding.instanceId !== config.controller.instanceId ||
    binding.checkoutPath !== checkoutPath ||
    typeof binding.registryPath !== 'string' ||
    !/^[0-9a-f]{64}$/.test(binding.registrySecret ?? '')
  ) {
    fail('controller_binding_mismatch');
  }
  const registry = await readRegistry(binding.registryPath);
  const registryEntry = registry.repositories[config.repository];
  if (
    !registryEntry ||
    registryEntry.instanceId !== binding.instanceId ||
    registryEntry.commonDir !== paths.commonDir ||
    registryEntry.checkoutPath !== checkoutPath ||
    registryEntry.bindingSecret !== binding.registrySecret
  ) {
    fail('controller_registry_binding_mismatch');
  }
  return { ...paths, binding };
}

export async function installControllerBinding({
  runner,
  repoRoot,
  config,
  now = new Date(),
  registryPath = defaultControllerRegistryPath(),
}) {
  const paths = await getControllerPaths({ runner, repoRoot });
  const checkoutPath = await realpath(repoRoot);
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700);

  try {
    const existing = await readControllerBinding({ runner, repoRoot, config });
    return existing;
  } catch (error) {
    if (error.message !== 'controller_binding_missing') throw error;
  }

  const registryEntry = await claimHostRegistry({
    registryPath,
    repository: config.repository,
    instanceId: config.controller.instanceId,
    commonDir: paths.commonDir,
    checkoutPath,
    now,
  });

  await writeJsonAtomic(paths.bindingPath, {
    schemaVersion: 1,
    repository: config.repository,
    instanceId: config.controller.instanceId,
    checkoutPath,
    registryPath,
    registrySecret: registryEntry.bindingSecret,
    installedAt: now.toISOString(),
  });
  return readControllerBinding({ runner, repoRoot, config });
}

export async function writeProductionCapability({
  runner,
  repoRoot,
  config,
  tag,
  oldSha,
  newSha,
  configHash,
  nonce,
  expiresAt,
}) {
  const paths = await readControllerBinding({ runner, repoRoot, config });
  if (!/^[0-9a-f]{40}$/.test(oldSha ?? '') || !/^[0-9a-f]{40}$/.test(newSha ?? '')) {
    fail('capability_sha_invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(configHash ?? '')) fail('capability_config_hash_invalid');
  if (typeof nonce !== 'string' || nonce.length < 16) fail('capability_nonce_invalid');
  if (!Number.isFinite(Date.parse(expiresAt))) fail('capability_expiry_invalid');

  try {
    const existing = parseJson(
      await readFile(paths.capabilityPath, 'utf8'),
      'capability_json_invalid',
    );
    if (existing.consumed !== true && Date.parse(existing.expiresAt) > Date.now()) {
      fail('capability_active');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await writeJsonAtomic(paths.capabilityPath, {
    schemaVersion: 1,
    repository: config.repository,
    tag,
    oldSha,
    newSha,
    configHash,
    nonce,
    expiresAt,
    consumed: false,
  });
  return paths.capabilityPath;
}

function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function inspectReleaseLease({
  runner,
  repoRoot,
  config,
  now = new Date(),
  processExists = defaultProcessExists,
}) {
  const paths = await readControllerBinding({ runner, repoRoot, config });
  let leaseStats;
  let lease;
  try {
    leaseStats = await stat(paths.leasePath);
    lease = parseJson(await readFile(paths.leasePath, 'utf8'), 'release_lease_json_invalid');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', ...paths };
    throw error;
  }
  if (modeOf(leaseStats) !== 0o600) return { status: 'release_lease_mode_invalid', lease, ...paths };
  if (
    lease.schemaVersion !== 1 ||
    lease.repository !== config.repository ||
    lease.instanceId !== config.controller.instanceId
  ) {
    return { status: 'release_lease_binding_mismatch', lease, ...paths };
  }
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresAt)) return { status: 'release_lease_expiry_invalid', lease, ...paths };
  const sameHost = lease.hostname === os.hostname();
  if (sameHost && Number.isInteger(lease.pid) && processExists(lease.pid)) {
    return { status: 'active', lease, ...paths };
  }
  if (expiresAt <= now.getTime() && sameHost) {
    return { status: 'stale_lock_requires_authorization', lease, ...paths };
  }
  if (!sameHost) return { status: 'release_lease_host_unverifiable', lease, ...paths };
  return { status: 'active_process_missing_before_expiry', lease, ...paths };
}

export async function acquireReleaseLease({
  runner,
  repoRoot,
  config,
  command,
  tag,
  now = new Date(),
}) {
  const paths = await readControllerBinding({ runner, repoRoot, config });
  if (typeof command !== 'string' || command.length === 0) fail('release_lease_command_invalid');
  if (typeof tag !== 'string' || tag.length === 0) fail('release_lease_tag_invalid');
  try {
    await mkdir(paths.leaseDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const inspection = await inspectReleaseLease({ runner, repoRoot, config, now });
      fail(inspection.status === 'active' ? 'release_lease_active' : inspection.status);
    }
    throw error;
  }

  const lease = {
    schemaVersion: 1,
    repository: config.repository,
    instanceId: config.controller.instanceId,
    command,
    tag,
    pid: process.pid,
    hostname: os.hostname(),
    nonce: randomUUID(),
    startedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + config.controller.authorizationTtlSeconds * 1000,
    ).toISOString(),
  };
  try {
    await writeFile(paths.leasePath, `${JSON.stringify(lease)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(paths.leasePath, 0o600);
  } catch (error) {
    await rmdir(paths.leaseDir).catch(() => {});
    throw error;
  }

  let released = false;
  return {
    ...paths,
    lease,
    async release() {
      if (released) return;
      const current = parseJson(
        await readFile(paths.leasePath, 'utf8'),
        'release_lease_json_invalid',
      );
      if (current.nonce !== lease.nonce) fail('release_lease_nonce_mismatch');
      await unlink(paths.leasePath);
      await rmdir(paths.leaseDir);
      released = true;
    },
  };
}
