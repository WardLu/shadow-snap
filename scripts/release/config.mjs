import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT_KEYS = new Set([
  'schemaVersion',
  'repository',
  'productionBranch',
  'tagPattern',
  'controller',
  'vercel',
  'acceptance',
  'admissionCommands',
]);
const CONTROLLER_KEYS = new Set([
  'mode',
  'instanceId',
  'authorizationTtlSeconds',
  'pendingTtlSeconds',
]);
const VERCEL_KEYS = new Set([
  'cliVersion',
  'teamId',
  'projectId',
  'projectName',
  'projectRoot',
  'rootDirectory',
  'vercelJsonPath',
  'productionBranch',
  'autoAssignCustomDomains',
  'productionDomains',
]);
const ACCEPTANCE_KEYS = new Set([
  'path',
  'bodyIncludes',
  'maxSeconds',
  'requiredHeaders',
]);

function fail(reasonCode) {
  throw new Error(reasonCode);
}

function assertObject(value, reasonCode) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(reasonCode);
}

function assertExactKeys(value, allowed, reasonCode) {
  assertObject(value, reasonCode);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${reasonCode}:${key}`);
  }
}

function assertRelativePath(value, reasonCode, { allowDot = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail(reasonCode);
  if (allowDot && value === '.') return;
  if (path.isAbsolute(value)) fail(reasonCode);
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized !== value) fail(reasonCode);
}

function assertDomain(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.toLowerCase()) {
    fail('production_domain_invalid');
  }
  if (value.includes('/') || value.includes(':') || value.startsWith('.') || value.endsWith('.')) {
    fail('production_domain_invalid');
  }
  let parsed;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    fail('production_domain_invalid');
  }
  if (parsed.hostname !== value || !value.includes('.')) fail('production_domain_invalid');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

const EXPECTED_ADMISSION_COMMANDS_BY_REPOSITORY = new Map([
  [
    'WardLu/shadow-snap',
    [
      ['npm', 'ci', '--ignore-scripts'],
      [
        'node',
        '--test',
        'tests/release/contracts/*.test.mjs',
        'tests/release/repository-config.test.mjs',
      ],
      ['node', 'scripts/validate-static-site.mjs'],
    ],
  ],
  [
    'WardLu/shadow-portal',
    [
      ['npm', 'ci', '--ignore-scripts'],
      ['npm', 'run', 'lint', '--', '--max-warnings=0'],
      ['npm', 'test', '--', '--runInBand'],
      ['npm', 'run', 'build'],
      ['npm', 'run', 'test:seo:http'],
      ['npm', 'run', 'security:audit'],
      ['npm', 'run', 'release:check'],
      ['npm', 'run', 'supabase:control-plane:check'],
      ['npm', 'run', 'test:release-controller'],
    ],
  ],
  [
    'WardLu/shadow-card',
    [
      ['npm', 'ci', '--ignore-scripts'],
      ['npm', 'run', 'release:check'],
      ['npm', 'run', 'test:release'],
      ['npm', 'run', 'lint'],
      ['npx', 'tsc', '--noEmit'],
      ['npm', 'run', 'build'],
      ['npm', 'run', 'test:release-controller'],
    ],
  ],
  [
    'WardLu/shadow-size',
    [
      ['npm', '--prefix', 'merchant-admin', 'ci', '--ignore-scripts'],
      ['npm', '--prefix', 'merchant-admin/widget', 'ci', '--ignore-scripts'],
      ['npm', '--prefix', 'merchant-admin', 'run', 'release:check'],
      ['npm', '--prefix', 'merchant-admin', 'run', 'test:release'],
      ['npm', '--prefix', 'merchant-admin', 'run', 'ci'],
      ['npm', 'run', 'test:release-controller'],
    ],
  ],
]);

export function validateReleaseConfig(value) {
  assertExactKeys(value, ROOT_KEYS, 'release_config_key_unknown');
  if (value.schemaVersion !== 1) fail('release_config_schema_unsupported');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository ?? '')) {
    fail('repository_invalid');
  }
  if (value.productionBranch !== 'production') fail('production_branch_invalid');
  if (typeof value.tagPattern !== 'string') fail('tag_pattern_invalid');
  try {
    const pattern = new RegExp(value.tagPattern);
    if (!pattern.test('v1.2.3') || pattern.test('main')) fail('tag_pattern_invalid');
  } catch {
    fail('tag_pattern_invalid');
  }

  assertExactKeys(value.controller, CONTROLLER_KEYS, 'controller_key_unknown');
  if (value.controller.mode !== 'single-instance') fail('controller_mode_invalid');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.controller.instanceId ?? '')) {
    fail('controller_instance_id_invalid');
  }
  for (const key of ['authorizationTtlSeconds', 'pendingTtlSeconds']) {
    const ttl = value.controller[key];
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) fail(`${key}_invalid`);
  }

  assertExactKeys(value.vercel, VERCEL_KEYS, 'vercel_key_unknown');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.vercel.cliVersion ?? '')) {
    fail('vercel_cli_version_invalid');
  }
  if (!/^team_[A-Za-z0-9]+$/.test(value.vercel.teamId ?? '')) fail('vercel_team_id_invalid');
  if (!/^prj_[A-Za-z0-9]+$/.test(value.vercel.projectId ?? '')) fail('vercel_project_id_invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.vercel.projectName ?? '')) fail('vercel_project_name_invalid');
  assertRelativePath(value.vercel.projectRoot, 'vercel_project_root_invalid', { allowDot: true });
  if (value.vercel.rootDirectory !== null) {
    assertRelativePath(value.vercel.rootDirectory, 'vercel_root_directory_invalid');
  }
  assertRelativePath(value.vercel.vercelJsonPath, 'vercel_json_path_invalid');
  if (value.vercel.productionBranch !== 'production') fail('vercel_production_branch_invalid');
  if (value.vercel.autoAssignCustomDomains !== false) fail('vercel_auto_assign_invalid');
  if (!Array.isArray(value.vercel.productionDomains) || value.vercel.productionDomains.length === 0) {
    fail('production_domains_invalid');
  }
  const uniqueDomains = new Set(value.vercel.productionDomains);
  if (uniqueDomains.size !== value.vercel.productionDomains.length) fail('production_domains_duplicate');
  value.vercel.productionDomains.forEach(assertDomain);

  assertExactKeys(value.acceptance, ACCEPTANCE_KEYS, 'acceptance_key_unknown');
  if (
    typeof value.acceptance.path !== 'string' ||
    !value.acceptance.path.startsWith('/') ||
    value.acceptance.path.includes('\0') ||
    value.acceptance.path.includes('://')
  ) fail('acceptance_path_invalid');
  if (
    typeof value.acceptance.bodyIncludes !== 'string' ||
    value.acceptance.bodyIncludes.length < 3 ||
    value.acceptance.bodyIncludes.length > 256
  ) fail('acceptance_body_marker_invalid');
  if (
    !Number.isInteger(value.acceptance.maxSeconds) ||
    value.acceptance.maxSeconds < 5 ||
    value.acceptance.maxSeconds > 60
  ) fail('acceptance_timeout_invalid');
  if (
    !Array.isArray(value.acceptance.requiredHeaders) ||
    value.acceptance.requiredHeaders.some(
      (header) => typeof header !== 'string' || !/^[a-z0-9-]+$/.test(header),
    )
  ) fail('acceptance_required_headers_invalid');

  if (!Array.isArray(value.admissionCommands) || value.admissionCommands.length === 0) {
    fail('admission_commands_invalid');
  }
  for (const command of value.admissionCommands) {
    if (!Array.isArray(command) || command.length === 0) fail('admission_command_invalid');
    if (command.some((part) => typeof part !== 'string' || part.length === 0 || part.includes('\0'))) {
      fail('admission_command_invalid');
    }
  }
  const expectedAdmissionCommands = EXPECTED_ADMISSION_COMMANDS_BY_REPOSITORY.get(value.repository);
  if (
    !expectedAdmissionCommands ||
    JSON.stringify(stableValue(value.admissionCommands)) !==
      JSON.stringify(stableValue(expectedAdmissionCommands))
  ) {
    fail('admission_commands_not_allowlisted');
  }
  return value;
}

export async function loadReleaseConfig(repoRoot) {
  const configPath = path.join(repoRoot, 'config', 'release-production.json');
  const raw = await readFile(configPath, 'utf8');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('release_config_json_invalid');
  }
  return validateReleaseConfig(value);
}

export function hashReleaseConfig(value) {
  validateReleaseConfig(value);
  const bytes = `${JSON.stringify(stableValue(value))}\n`;
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}
