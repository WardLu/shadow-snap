#!/usr/bin/env node
// Local equivalent gate. The checks that stand in for hosted CI are listed in
// config/local-ci.json; that committed file is the only source of the checklist:
//   { "include": ["admissionCommands"], "checks": [{ "name", "argv" }], "env": { "NAME": "value" }, "unverified": [] }
// `include: ["admissionCommands"]` takes config/release-production.json#admissionCommands from the same
// commit (named admission-1..n) so a repository keeps one admission list; `checks` are appended.
// Checks see only an allow-listed environment plus CI=1 and `env` (committed, non-secret
// placeholders, as on a hosted runner); tokens in the caller's shell never reach them.
//
//   node scripts/ci/local-ci.mjs run           clean worktree only; runs every check and records a pass
//   node scripts/ci/local-ci.mjs check         runs the same checks, never records (dirty worktree allowed)
//   node scripts/ci/local-ci.mjs verify [sha]  exits 0 only for a valid pass record of sha (default HEAD)
//
// A pass is recorded at <git-common-dir>/local-ci/<sha>.json only when the worktree was clean before
// and after the run and HEAD did not move. The record is a statement by the trusted local account:
// it proves which checks that account ran, not that nobody with the same access edited the file.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_PATH = 'config/local-ci.json';
export const SCHEMA_VERSION = 2;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9][a-z0-9:._-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const INCLUDES = { admissionCommands: { file: 'config/release-production.json', key: 'admissionCommands', prefix: 'admission' } };
export const INHERITED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'npm_config_cache'];

const fail = (reason) => { throw new Error(reason); };
const isText = (value) => typeof value === 'string' && value.length > 0;

export function defaultGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** readFile(path) reads a committed file from the same source (commit or worktree) as the config. */
export function validateChecklist(config, readFile = () => fail('local_ci_include_unreadable')) {
  if (!isObject(config)) fail('local_ci_config_invalid');
  const { include = [], checks = [], env = {}, unverified = [] } = config;
  if (!Array.isArray(include) || new Set(include).size !== include.length || !include.every((name) => Object.hasOwn(INCLUDES, name))) {
    fail('local_ci_include_invalid');
  }
  if (!Array.isArray(checks)) fail('local_ci_checks_missing');
  const resolved = [];
  for (const name of include) {
    const { file, key, prefix } = INCLUDES[name];
    let source;
    try { source = JSON.parse(readFile(file)); } catch { fail('local_ci_include_unreadable'); }
    if (!Array.isArray(source?.[key]) || source[key].length === 0) fail('local_ci_include_empty');
    source[key].forEach((argv, index) => resolved.push({ name: `${prefix}-${index + 1}`, argv }));
  }
  resolved.push(...checks.map((check) => ({ name: check?.name, argv: check?.argv })));
  if (resolved.length === 0) fail('local_ci_checks_missing');
  const names = new Set();
  for (const check of resolved) {
    if (!isText(check.name) || !NAME.test(check.name) || names.has(check.name)) fail('local_ci_check_name_invalid');
    if (!Array.isArray(check.argv) || check.argv.length === 0 || !check.argv.every(isText)) fail('local_ci_check_argv_invalid');
    names.add(check.name);
  }
  if (!isObject(env) || !Object.entries(env).every(([name, value]) => ENV_NAME.test(name) && typeof value === 'string')) fail('local_ci_env_invalid');
  if (!Array.isArray(unverified) || !unverified.every(isText)) fail('local_ci_unverified_invalid');
  const sortedEnv = Object.fromEntries(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { checks: resolved, env: sortedEnv, unverified };
}

// Digest of what runs: reordering or editing a check, or changing `env`, changes it. Without env
// the digest is that of the check list alone (records written before `env` existed stay valid).
export function checklistDigest(checks, env = {}) {
  const list = checks.map(({ name, argv }) => [name, argv]);
  const payload = Object.keys(env).length ? { checks: list, env } : list;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** The environment a check sees: allow-listed caller variables, CI=1, then the committed `env`. */
export function checkEnvironment(source, env = {}) {
  const result = { CI: '1' };
  for (const name of INHERITED_ENV) if (source[name] !== undefined) result[name] = source[name];
  return { ...result, ...env };
}

function parseChecklist(read, readFile) {
  let text;
  try { text = read(); } catch { fail('local_ci_config_missing'); }
  let config;
  try { config = JSON.parse(text); } catch { fail('local_ci_config_json_invalid'); }
  return validateChecklist(config, readFile);
}

// Records are bound to the checklist the commit carries, so `run` and `verify` read it (and any
// included file) from the commit; `check` never records and reads the worktree copies.
export const loadChecklist = (sha, git = defaultGit) => parseChecklist(() => git(['show', `${sha}:${CONFIG_PATH}`]), (file) => git(['show', `${sha}:${file}`]));
const loadWorktreeChecklist = (root) => parseChecklist(() => readFileSync(path.join(root, CONFIG_PATH), 'utf8'), (file) => readFileSync(path.join(root, file), 'utf8'));

export function recordPath(sha, git = defaultGit) {
  return path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'local-ci', `${sha}.json`);
}

const worktreeStatus = (git) => git(['status', '--porcelain', '--untracked-files=all']);

// Checks always run from the repository root: the checklist and the recorded identity belong to
// the whole repository, whatever directory the runner was started from.
function runChecks(checks, { root, env, spawn, log }) {
  const results = [];
  for (const { name, argv } of checks) {
    log(`\n▶ ${name}: ${argv.join(' ')}`);
    const started = Date.now();
    const result = spawn(argv[0], argv.slice(1), { cwd: root, env, stdio: 'inherit', shell: false });
    const durationMs = Date.now() - started;
    if (result.error || result.status !== 0) return { failed: name, results };
    results.push({ name, status: 'passed', durationMs });
  }
  return { failed: null, results };
}

export function runLocalCi({ git = defaultGit, spawn = spawnSync, now = () => new Date(), log = console.log, environment = process.env } = {}) {
  if (worktreeStatus(git) !== '') fail('local_ci_worktree_dirty');
  const root = git(['rev-parse', '--show-toplevel']);
  const headSha = git(['rev-parse', 'HEAD']);
  const treeSha = git(['rev-parse', `${headSha}^{tree}`]);
  if (!SHA.test(headSha) || !SHA.test(treeSha)) fail('local_ci_identity_invalid');
  const { checks, env, unverified } = loadChecklist(headSha, git);
  const file = recordPath(headSha, git);
  const startedAt = now().toISOString();

  const { failed, results } = runChecks(checks, { root, env: checkEnvironment(environment, env), spawn, log });
  if (failed) {
    // The newest result for this commit is a failure; an older pass must not outlive it.
    rmSync(file, { force: true });
    fail(`local_ci_check_failed:${failed}`);
  }
  if (worktreeStatus(git) !== '' || git(['rev-parse', 'HEAD']) !== headSha) {
    rmSync(file, { force: true });
    fail('local_ci_worktree_changed');
  }

  const record = {
    schemaVersion: SCHEMA_VERSION,
    headSha,
    treeSha,
    status: 'passed',
    checklistSha256: checklistDigest(checks, env),
    checks: results.map((result, index) => ({ ...result, argv: checks[index].argv })),
    env,
    unverified,
    startedAt,
    completedAt: now().toISOString(),
  };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  log(`\n[local-ci] 本地等价门禁通过并记录：${headSha.slice(0, 7)}（${checks.length} 项检查）`);
  return { file, record };
}

export function checkLocalCi({ git = defaultGit, spawn = spawnSync, log = console.log, environment = process.env } = {}) {
  const root = git(['rev-parse', '--show-toplevel']);
  const { checks, env } = loadWorktreeChecklist(root);
  const { failed } = runChecks(checks, { root, env: checkEnvironment(environment, env), spawn, log });
  if (failed) fail(`local_ci_check_failed:${failed}`);
  log('\n[local-ci] 检查全部通过（check 模式不记录凭据）');
}

/** Returns { ok: true, record } or { ok: false, reason }. Never throws for a bad or missing record. */
export function verifyLocalCiRecord(sha, { git = defaultGit, read = (file) => readFileSync(file, 'utf8') } = {}) {
  if (!SHA.test(sha ?? '')) return { ok: false, reason: 'local_ci_sha_invalid' };
  let record;
  try { record = JSON.parse(read(recordPath(sha, git))); } catch { return { ok: false, reason: 'local_ci_record_missing' }; }
  if (record?.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: 'local_ci_record_schema_unsupported' };
  if (record.status !== 'passed' || record.headSha !== sha) return { ok: false, reason: 'local_ci_record_not_passed' };
  let treeSha;
  let checks;
  let env;
  try {
    treeSha = git(['rev-parse', `${sha}^{tree}`]);
    ({ checks, env } = loadChecklist(sha, git));
  } catch (error) {
    return { ok: false, reason: error.message.startsWith('local_ci_') ? error.message : 'local_ci_commit_unreadable' };
  }
  if (record.treeSha !== treeSha) return { ok: false, reason: 'local_ci_record_tree_mismatch' };
  if (record.checklistSha256 !== checklistDigest(checks, env)) return { ok: false, reason: 'local_ci_record_checklist_mismatch' };
  if (!Array.isArray(record.checks) || record.checks.length !== checks.length ||
      !record.checks.every((item, index) => item?.name === checks[index].name && item.status === 'passed')) {
    return { ok: false, reason: 'local_ci_record_checks_incomplete' };
  }
  return { ok: true, record };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, sha] = process.argv.slice(2);
  try {
    if (command === 'run') runLocalCi();
    else if (command === 'check') checkLocalCi();
    else if (command === 'verify') {
      const target = sha ?? defaultGit(['rev-parse', 'HEAD']);
      const result = verifyLocalCiRecord(target);
      if (!result.ok) fail(result.reason);
      console.log(`[local-ci] ${target.slice(0, 7)} 有有效的本地等价门禁记录`);
    } else fail('local_ci_usage: run | check | verify [sha]');
  } catch (error) {
    console.error(`[local-ci] ${error.message}`);
    process.exitCode = 1;
  }
}
