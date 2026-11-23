#!/usr/bin/env node
// Local equivalent gate. The checks that stand in for hosted CI are listed in
// config/local-ci.json; that committed file is the only source of the checklist:
//   { "include": ["admissionCommands"], "checks": [{ "name", "argv" }], "env": { "NAME": "value" }, "unverified": [] }
// `include: ["admissionCommands"]` takes config/release-production.json#admissionCommands from the same
// commit (named admission-1..n) so a repository keeps one admission list; `checks` are appended.
// Checks see only an allow-listed environment plus CI=1 and `env` (committed, non-secret
// placeholders, as on a hosted runner); tokens in the caller's shell never reach them.
//
// Two optional keys make `run` cheaper without weakening what a full record proves. Both name the
// checks that may be left out; every other check runs, so a new or wrapped check is never skipped
// by default. A check that runs gitleaks directly, or the gitleaks size guard
// (`node scripts/ci/gitleaks-size-guard.mjs`, which reads the whole history too), can be named in neither.
//   "treeReuse": { "reuse": ["typecheck", "test"], "maxAgeHours": 24, "toolchain": [["pnpm", "--version"]] }
//     An original full record (one that reused nothing) of another commit with the same tree and
//     checklist, completed at most `maxAgeHours` (default 24) before this run started, stands in for
//     the `reuse` checks; all others run again. A typical source is the checked PR head of a squash
//     merge. List only checks that depend on the tree alone and leave nothing a later check needs
//     (an install prepares the worktree, so it must run): the tree is the same, the Git history and
//     the worktree are not. `verify` checks the source again every time: once its record is deleted,
//     overwritten by a newer run or no longer valid, the records that reused it are invalid too.
//     The toolchain must match as well: every full run records Node's version, platform and arch plus
//     the trimmed output of each `toolchain` command (stdout, or stderr when stdout is empty; run
//     first, from the root, with the checks' environment; at most 10 commands, 200 characters each).
//     A source counts only with the same fingerprint; a failing, silent or longer version command
//     means no reuse.
//   "docsOnly": { "base": "origin/main", "paths": ["docs/", "README.md"], "skip": ["install", "build"],
//                 "fullBranches": ["production"] }
//     When every file changed since the merge base with `base` matches `paths` (a trailing `/` is a
//     directory prefix, anything else an exact file; submodules never match), the `skip` checks do
//     not run, mirroring a hosted CI route that skips the build for same-repository documentation
//     pull requests. Hence only on a feature branch of this repository: a detached HEAD, the base
//     branch itself, a branch named in `fullBranches` (other integration branches), a branch whose
//     plain `git push` lands on one of those under push.default, a branch whose push remote has explicit
//     push refspecs (remote.<name>.push), and a branch that tracks or pushes (by Git's precedence)
//     to another remote than the one `base` belongs to, or tracks refs/pull/* (a fork's PR checked out
//     locally) run in full.
//     The record says `route: "docs_only"`; `verify` rejects it unless asked with --allow-docs-only,
//     so releases always need a full record.
//
//   node scripts/ci/local-ci.mjs run [--full]  clean worktree only; runs the checks and records a pass
//                                              (--full: no tree reuse and no docs-only route)
//   node scripts/ci/local-ci.mjs check         runs every check, never records (dirty worktree allowed)
//   node scripts/ci/local-ci.mjs verify [sha] [--allow-docs-only]
//                                              exits 0 only for a valid pass record of sha (default HEAD)
//
// A pass is recorded at <git-common-dir>/local-ci/<sha>.json only when the worktree was clean before
// and after the run and HEAD did not move. The record is a statement by the trusted local account:
// it proves which checks that account ran, not that nobody with the same access edited the file.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_PATH = 'config/local-ci.json';
export const SCHEMA_VERSION = 2;
const SHA = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9][a-z0-9:._-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const INCLUDES = { admissionCommands: { file: 'config/release-production.json', key: 'admissionCommands', prefix: 'admission' } };
export const INHERITED_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'npm_config_cache'];
export const REUSE_MAX_AGE_HOURS = 24;
const REUSE_MAX_AGE_HOURS_LIMIT = 24 * 30;
const TOOLCHAIN_COMMANDS_LIMIT = 10;
const TOOLCHAIN_OUTPUT_LIMIT = 200;
export const RUNTIME = { node: process.version, platform: process.platform, arch: process.arch };

const fail = (reason) => { throw new Error(reason); };
const isText = (value) => typeof value === 'string' && value.length > 0;

export function defaultGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** readFile(path) reads a committed file from the same source (commit or worktree) as the config. */
export function validateChecklist(config, readFile = () => fail('local_ci_include_unreadable')) {
  if (!isObject(config)) fail('local_ci_config_invalid');
  const { include = [], checks = [], env = {}, unverified = [], treeReuse, docsOnly } = config;
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
  const nameList = (list) => Array.isArray(list) && new Set(list).size === list.length && list.every((name) => names.has(name));
  // Checks that read Git history must never be skipped on the strength of an identical tree or a docs-only diff.
  const historyChecks = resolved.filter((check) => path.basename(check.argv[0]) === 'gitleaks' ||
    (path.basename(check.argv[0]) === 'node' && path.basename(String(check.argv[1] ?? '')) === 'gitleaks-size-guard.mjs')).map((check) => check.name);

  // Both options are allow-lists: a check runs unless it is named. A wrapped history scan
  // (`npm run secrets-scan`) is therefore rerun unless someone deliberately lists it.
  let reuse = null;
  if (treeReuse !== undefined) {
    const { maxAgeHours = REUSE_MAX_AGE_HOURS, toolchain = [] } = isObject(treeReuse) ? treeReuse : {};
    const validToolchain = Array.isArray(toolchain) && toolchain.length <= TOOLCHAIN_COMMANDS_LIMIT &&
      toolchain.every((argv) => Array.isArray(argv) && argv.length > 0 && argv.every(isText)) &&
      new Set(toolchain.map((argv) => JSON.stringify(argv))).size === toolchain.length;
    if (!isObject(treeReuse) || !nameList(treeReuse.reuse) || treeReuse.reuse.length === 0 || !validToolchain ||
        typeof maxAgeHours !== 'number' || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0 || maxAgeHours > REUSE_MAX_AGE_HOURS_LIMIT) fail('local_ci_tree_reuse_invalid');
    if (historyChecks.some((name) => treeReuse.reuse.includes(name))) fail('local_ci_tree_reuse_history_check');
    reuse = { reuse: resolved.filter((check) => treeReuse.reuse.includes(check.name)).map((check) => check.name), maxAgeMs: maxAgeHours * 3_600_000,
      toolchain: toolchain.map((argv) => [...argv]) };
  }
  let docs = null;
  if (docsOnly !== undefined) {
    const validPath = (entry) => isText(entry) && !entry.startsWith('/') && !entry.startsWith('-') && entry !== '/' && !entry.split('/').includes('..');
    const { fullBranches = [] } = isObject(docsOnly) ? docsOnly : {};
    if (!isObject(docsOnly) || !isText(docsOnly.base) || docsOnly.base.startsWith('-') ||
        !Array.isArray(docsOnly.paths) || docsOnly.paths.length === 0 || !docsOnly.paths.every(validPath) ||
        !Array.isArray(fullBranches) || !fullBranches.every((name) => isText(name) && !name.startsWith('-')) ||
        !nameList(docsOnly.skip) || docsOnly.skip.length === 0 || docsOnly.skip.length >= resolved.length) fail('local_ci_docs_only_invalid');
    if (historyChecks.some((name) => docsOnly.skip.includes(name))) fail('local_ci_docs_only_history_check');
    docs = { base: docsOnly.base, paths: [...docsOnly.paths], fullBranches: [...fullBranches],
      run: resolved.filter((check) => !docsOnly.skip.includes(check.name)).map((check) => check.name) };
  }
  return { checks: resolved, env: sortedEnv, unverified, treeReuse: reuse, docsOnly: docs };
}

/** True when `file` (a path from `git diff --name-only`) is covered by a docsOnly `paths` entry. */
export function isDocsPath(file, paths) {
  return paths.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) && file.length > entry.length : file === entry));
}

const gitOrEmpty = (git, args) => { try { return git(args); } catch { return ''; } };

/**
 * The local stand-in for "a pull request from a branch of this repository": the name of the
 * checked-out branch when it may take the docs-only route, otherwise null. Hosted CI runs pushes,
 * manual runs and fork PRs in full, so here a detached HEAD, the base branch, a `fullBranches` entry
 * and a branch that tracks or pushes to another remote than the one `base` belongs to run in full.
 */
export function docsOnlyBranch(docsOnly, git = defaultGit) {
  const branch = gitOrEmpty(git, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const baseRef = gitOrEmpty(git, ['rev-parse', '--symbolic-full-name', docsOnly.base]);
  if (!branch || !baseRef) return null;
  const config = (key) => gitOrEmpty(git, ['config', '--get', key]);
  // Remote names may contain `/`: match the longest configured remote first.
  const remotes = gitOrEmpty(git, ['remote']).split('\n').filter(Boolean).sort((a, b) => b.length - a.length);
  const splitRemoteRef = (ref) => {
    const rest = ref.slice('refs/remotes/'.length);
    const remote = remotes.find((name) => rest.startsWith(`${name}/`));
    return remote ? { remote, name: rest.slice(remote.length + 1) } : null;
  };
  let baseRemote = null;
  let baseBranch;
  if (baseRef.startsWith('refs/heads/')) {
    baseBranch = baseRef.slice('refs/heads/'.length);
    // A local base branch belongs to the remote it tracks, if any.
    const tracked = config(`branch.${baseBranch}.remote`);
    if (remotes.includes(tracked)) baseRemote = tracked;
  } else if (baseRef.startsWith('refs/remotes/')) {
    const split = splitRemoteRef(baseRef);
    if (!split) return null;
    ({ remote: baseRemote, name: baseBranch } = split);
  } else return null;
  const integration = new Set([baseBranch, ...docsOnly.fullBranches]);
  if (integration.has(branch)) return null;
  // Unset means a new local branch (it will be pushed here); `.` tracks a local branch.
  const allowed = new Set(['', '.', ...(baseRemote ? [baseRemote] : [])]);
  // Git's precedence for where the branch pushes: its pushRemote, then remote.pushDefault, then its remote.
  const fetchRemote = config(`branch.${branch}.remote`);
  const pushRemote = config(`branch.${branch}.pushRemote`) || config('remote.pushDefault') || fetchRemote;
  if (!allowed.has(fetchRemote) || !allowed.has(pushRemote)) return null;
  // `gh pr checkout` of a fork PR the maintainers cannot push to tracks refs/pull/<n>/head on origin.
  if (config(`branch.${branch}.merge`).startsWith('refs/pull/')) return null;
  // Explicit push refspecs (remote.<name>.push) can send one branch to several destinations, and
  // %(push) reports only the first: refspecs on the remote a plain `git push` uses run in full rather
  // than being resolved here. With none configured Git uses the only remote, or else origin. Refspecs
  // of other remotes are never used by that push.
  const pushTo = pushRemote || (remotes.length === 1 ? remotes[0] : 'origin');
  if (pushTo !== '.' && gitOrEmpty(git, ['config', '--get-all', `remote.${pushTo}.push`])) return null;
  // Where a plain `git push` would land under push.default, whether or not that remote ref was
  // fetched. Empty when unresolvable, e.g. `simple` with a differently named upstream, which refuses to push.
  const push = gitOrEmpty(git, ['for-each-ref', '--format=%(push)', `refs/heads/${branch}`]);
  if (push) {
    let target = null;
    if (push.startsWith('refs/heads/')) target = { remote: '.', name: push.slice('refs/heads/'.length) };
    else if (push.startsWith('refs/remotes/')) target = splitRemoteRef(push);
    if (!target || !allowed.has(target.remote) || integration.has(target.name)) return null;
  }
  return branch;
}

/** { base, files, branch } when docsOnlyBranch allows it and every change since the merge base with docsOnly.base is documentation; otherwise null. */
export function docsOnlyRoute(docsOnly, headSha, git = defaultGit) {
  if (!docsOnly) return null;
  const branch = docsOnlyBranch(docsOnly, git);
  if (!branch) return null;
  let base;
  let raw;
  try {
    base = git(['merge-base', docsOnly.base, headSha]);
    // --no-renames lists both sides of a rename, so moving code into docs/ is not a docs-only change.
    // --raw -z puts a metadata field before every path, so a trimmed stdout never alters a file name.
    raw = git(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-abbrev', base, headSha]);
  } catch {
    return null;
  }
  if (!SHA.test(base) || base === headSha) return null;
  const fields = raw.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length === 0 || fields.length % 2 !== 0) return null;
  for (let index = 0; index < fields.length; index += 2) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*$/.exec(fields[index]);
    // A submodule (gitlink, mode 160000) is code from elsewhere, whatever its path.
    if (!meta || meta[1] === '160000' || meta[2] === '160000' || !isDocsPath(fields[index + 1], docsOnly.paths)) return null;
  }
  return { base, files: fields.length / 2, branch };
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

const ageMs = (later, earlier) => Date.parse(later) - Date.parse(earlier);
const withinAge = (later, earlier, maxAgeMs) => { const age = ageMs(later, earlier); return age >= 0 && age <= maxAgeMs; };

/**
 * What a tree-only check also depends on: Node's version, platform and arch, and the trimmed output of
 * each configured version command, run like a check (stdout, or stderr when stdout is empty, as with
 * `java -version`). null, with the reason logged, when a command fails or prints nothing usable.
 */
export function toolchainFingerprint(commands, { root, env, spawn = spawnSync, runtime = RUNTIME, log = () => {} }) {
  const fingerprint = { node: runtime.node, platform: runtime.platform, arch: runtime.arch, commands: [] };
  for (const argv of commands) {
    const result = spawn(argv[0], argv.slice(1), { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const text = (stream) => (typeof stream === 'string' ? stream.trim() : '');
    const output = text(result.stdout) || text(result.stderr);
    const problem = result.error || result.status !== 0 ? `退出码 ${result.status ?? result.error?.code}`
      : !output ? '没有输出' : output.length > TOOLCHAIN_OUTPUT_LIMIT ? `输出超过 ${TOOLCHAIN_OUTPUT_LIMIT} 个字符` : null;
    if (problem) {
      log(`[local-ci] 工具链版本命令 ${argv.join(' ')}：${problem}`);
      return null;
    }
    fingerprint.commands.push({ argv: [...argv], output });
  }
  return fingerprint;
}

const sameToolchain = (a, b) => isObject(a) && isObject(b) && JSON.stringify(a) === JSON.stringify(b);

/**
 * The newest original full record (it reused nothing) of another commit with this tree, checklist
 * digest and toolchain fingerprint, completed within maxAgeMs before `at`, that still verifies; null
 * when there is none.
 */
export function findReusableRecord({ headSha, treeSha, digest, at, maxAgeMs, toolchain, git = defaultGit, read = (file) => readFileSync(file, 'utf8'), list = readdirSync }) {
  if (!isObject(toolchain)) return null;
  const directory = path.dirname(recordPath(headSha, git));
  let entries;
  try { entries = list(directory); } catch { return null; }
  const candidates = [];
  for (const entry of entries) {
    const match = /^([0-9a-f]{40})\.json$/.exec(entry);
    if (!match || match[1] === headSha) continue;
    let record;
    try { record = JSON.parse(read(path.join(directory, entry))); } catch { continue; }
    if (record?.treeSha !== treeSha || record.checklistSha256 !== digest || (record.route ?? 'full') !== 'full') continue;
    if (!withinAge(at, record.completedAt, maxAgeMs) || !sameToolchain(record.toolchain, toolchain)) continue;
    // Full verification as an original: the commit still exists, its tree and checklist match, every
    // check passed there and none was reused, so a source never cites another record (no chains, no A -> B -> A).
    const verdict = verifyLocalCiRecord(match[1], { git, read, allowReuse: false });
    if (verdict.ok) candidates.push(verdict.record);
  }
  candidates.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  return candidates[0] ?? null;
}

export function runLocalCi({ git = defaultGit, spawn = spawnSync, now = () => new Date(), log = console.log, environment = process.env, full = false, runtime = RUNTIME } = {}) {
  if (worktreeStatus(git) !== '') fail('local_ci_worktree_dirty');
  const root = git(['rev-parse', '--show-toplevel']);
  const headSha = git(['rev-parse', 'HEAD']);
  const treeSha = git(['rev-parse', `${headSha}^{tree}`]);
  if (!SHA.test(headSha) || !SHA.test(treeSha)) fail('local_ci_identity_invalid');
  const { checks, env, unverified, treeReuse, docsOnly } = loadChecklist(headSha, git);
  const digest = checklistDigest(checks, env);
  const file = recordPath(headSha, git);
  const startedAt = now().toISOString();

  // Route first (docs-only runs a subset, never reused), then tree reuse for a full run; --full skips both.
  const route = full ? null : docsOnlyRoute(docsOnly, headSha, git);
  const selected = route ? checks.filter((check) => docsOnly.run.includes(check.name)) : checks;
  const reused = new Set();
  let source = null;
  const checkEnv = checkEnvironment(environment, env);
  // Every full run of a checklist with treeReuse records the fingerprint, so it can serve as a source later.
  const toolchain = treeReuse && !route ? toolchainFingerprint(treeReuse.toolchain, { root, env: checkEnv, spawn, runtime, log }) : null;
  if (treeReuse && !route && !toolchain) log('[local-ci] 工具链版本命令失败或没有输出：本次不复用，记录也不能当复用来源');
  if (full) {
    log('[local-ci] --full：完整重跑，不复用其他提交的记录，也不走 docs_only 路线');
  } else if (route) {
    log(`[local-ci] 分支 ${route.branch} 相对 ${docsOnly.base} 只改了文档（${route.files} 个文件），按 docs_only 路线只跑：${selected.map((check) => check.name).join('、')}`);
  } else if (treeReuse) {
    source = findReusableRecord({ headSha, treeSha, digest, at: startedAt, maxAgeMs: treeReuse.maxAgeMs, toolchain, git });
    if (source) {
      for (const name of treeReuse.reuse) reused.add(name);
      const rerun = checks.filter((check) => !reused.has(check.name)).map((check) => check.name);
      log(`[local-ci] 文件树与 ${source.headSha.slice(0, 7)} 相同，检查清单与工具链一致（${source.completedAt} 通过），复用：${[...reused].join('、')}；重跑：${rerun.join('、')}（--full 可完整重跑）`);
    }
  }

  const { failed, results } = runChecks(selected.filter((check) => !reused.has(check.name)), { root, env: checkEnv, spawn, log });
  if (failed) {
    // The newest result for this commit is a failure; an older pass must not outlive it.
    rmSync(file, { force: true });
    fail(`local_ci_check_failed:${failed}`);
  }
  if (worktreeStatus(git) !== '' || git(['rev-parse', 'HEAD']) !== headSha) {
    rmSync(file, { force: true });
    fail('local_ci_worktree_changed');
  }

  const ran = new Map(results.map((result) => [result.name, result]));
  const record = {
    schemaVersion: SCHEMA_VERSION,
    headSha,
    treeSha,
    status: 'passed',
    route: route ? 'docs_only' : 'full',
    ...(route ? { routeBase: route.base, routeBranch: route.branch } : {}),
    ...(source ? { reusedFrom: source.headSha, reusedFromCompletedAt: source.completedAt } : {}),
    checklistSha256: digest,
    checks: selected.map((check) => (reused.has(check.name)
      ? { name: check.name, status: 'passed', durationMs: 0, reusedFrom: source.headSha, argv: check.argv }
      : { ...ran.get(check.name), argv: check.argv })),
    env,
    unverified,
    ...(toolchain ? { toolchain } : {}),
    startedAt,
    completedAt: now().toISOString(),
  };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  const detail = route ? `docs_only 路线，${selected.length} 项检查` : `${checks.length} 项检查${reused.size ? `，其中 ${reused.size} 项复用 ${source.headSha.slice(0, 7)}` : ''}`;
  log(`\n[local-ci] 本地等价门禁通过并记录：${headSha.slice(0, 7)}（${detail}）`);
  return { file, record };
}

export function checkLocalCi({ git = defaultGit, spawn = spawnSync, log = console.log, environment = process.env } = {}) {
  const root = git(['rev-parse', '--show-toplevel']);
  const { checks, env } = loadWorktreeChecklist(root);
  const { failed } = runChecks(checks, { root, env: checkEnvironment(environment, env), spawn, log });
  if (failed) fail(`local_ci_check_failed:${failed}`);
  log('\n[local-ci] 检查全部通过（check 模式不记录凭据）');
}

/**
 * Returns { ok: true, record } or { ok: false, reason }. Never throws for a bad or missing record.
 * Only full records pass unless allowDocsOnly: a docs_only record never stands in for a build.
 * A record with reused checks is valid only while its source still verifies as an original full
 * record of the same tree, checklist and toolchain fingerprint, unchanged since it was reused and
 * completed within the commit's treeReuse.maxAgeHours before this record's run started. allowReuse: false accepts
 * originals only (how a source is checked).
 */
export function verifyLocalCiRecord(sha, { git = defaultGit, read = (file) => readFileSync(file, 'utf8'), allowDocsOnly = false, allowReuse = true } = {}) {
  if (!SHA.test(sha ?? '')) return { ok: false, reason: 'local_ci_sha_invalid' };
  let record;
  try { record = JSON.parse(read(recordPath(sha, git))); } catch { return { ok: false, reason: 'local_ci_record_missing' }; }
  if (record?.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: 'local_ci_record_schema_unsupported' };
  if (record.status !== 'passed' || record.headSha !== sha) return { ok: false, reason: 'local_ci_record_not_passed' };
  let treeSha;
  let checks;
  let env;
  let treeReuse;
  let docsOnly;
  try {
    treeSha = git(['rev-parse', `${sha}^{tree}`]);
    ({ checks, env, treeReuse, docsOnly } = loadChecklist(sha, git));
  } catch (error) {
    return { ok: false, reason: error.message.startsWith('local_ci_') ? error.message : 'local_ci_commit_unreadable' };
  }
  if (record.treeSha !== treeSha) return { ok: false, reason: 'local_ci_record_tree_mismatch' };
  if (record.checklistSha256 !== checklistDigest(checks, env)) return { ok: false, reason: 'local_ci_record_checklist_mismatch' };
  // Records written before routes existed have no `route` and are full runs.
  const route = record.route ?? 'full';
  let expected;
  if (route === 'full') expected = checks.map((check) => check.name);
  else if (route === 'docs_only' && docsOnly) {
    if (!allowDocsOnly) return { ok: false, reason: 'local_ci_record_docs_only' };
    expected = docsOnly.run;
  } else return { ok: false, reason: 'local_ci_record_route_invalid' };
  if (!Array.isArray(record.checks) || record.checks.length !== expected.length ||
      !record.checks.every((item, index) => item?.name === expected[index] && item.status === 'passed')) {
    return { ok: false, reason: 'local_ci_record_checks_incomplete' };
  }
  const reused = record.checks.filter((item) => item.reusedFrom !== undefined);
  if (reused.length === 0 && record.reusedFrom === undefined && record.reusedFromCompletedAt === undefined) return { ok: true, record };
  if (!allowReuse) return { ok: false, reason: 'local_ci_record_not_original' };
  // Reused checks must be ones this commit's treeReuse allows, in a full run, all citing the one
  // source commit the record names, which is another commit.
  const from = record.reusedFrom;
  if (reused.length === 0 || route !== 'full' || !treeReuse || !SHA.test(from ?? '') || from === sha ||
      !reused.every((item) => item.reusedFrom === from && treeReuse.reuse.includes(item.name))) {
    return { ok: false, reason: 'local_ci_record_reuse_invalid' };
  }
  const source = verifyLocalCiRecord(from, { git, read, allowReuse: false });
  if (!source.ok) return { ok: false, reason: `local_ci_record_reuse_source:${source.reason}` };
  if (source.record.treeSha !== treeSha || source.record.checklistSha256 !== record.checklistSha256 ||
      source.record.completedAt !== record.reusedFromCompletedAt) {
    return { ok: false, reason: 'local_ci_record_reuse_source_changed' };
  }
  if (!withinAge(record.startedAt, source.record.completedAt, treeReuse.maxAgeMs)) return { ok: false, reason: 'local_ci_record_reuse_stale' };
  // The reusing run saw the same toolchain as the source (records without a fingerprint never match).
  if (!sameToolchain(record.toolchain, source.record.toolchain)) return { ok: false, reason: 'local_ci_record_reuse_toolchain_mismatch' };
  return { ok: true, record };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'run' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--full'))) runLocalCi({ full: rest[0] === '--full' });
    else if (command === 'check' && rest.length === 0) checkLocalCi();
    else if (command === 'verify' && rest.filter((arg) => !arg.startsWith('--')).length <= 1 &&
             rest.every((arg) => !arg.startsWith('--') || arg === '--allow-docs-only')) {
      const target = rest.find((arg) => !arg.startsWith('--')) ?? defaultGit(['rev-parse', 'HEAD']);
      const result = verifyLocalCiRecord(target, { allowDocsOnly: rest.includes('--allow-docs-only') });
      if (!result.ok) fail(result.reason);
      console.log(`[local-ci] ${target.slice(0, 7)} 有有效的本地等价门禁记录（${result.record.route ?? 'full'}）`);
    } else fail('local_ci_usage: run [--full] | check | verify [sha] [--allow-docs-only]');
  } catch (error) {
    console.error(`[local-ci] ${error.message}`);
    process.exitCode = 1;
  }
}
