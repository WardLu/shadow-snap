#!/usr/bin/env node
// Full-history secret scan for the local gate (shadow-devkit docs/standards/ci-local-gate.md section 2).
// Copy this file unchanged to scripts/ci/secrets-scan.mjs and list it in config/local-ci.json:
//   ["node", "scripts/ci/secrets-scan.mjs", "git", "--no-banner", "--redact",
//    "--log-opts=--all --full-history --diff-filter=tuxdb --diff-merges=remerge", "."]
// The arguments after the script are gitleaks arguments.
//
// Why a wrapper: gitleaks 8.30.1 keeps exit code 0 when git fails while producing the history. A line git prints
// to stderr (e.g. a partial clone that cannot fetch an object a remerge needs) is only logged as `ERR [git] ...`,
// and a git process that dies without output (killed) is only logged at debug level as "command aborted"; a killed
// `git log` reports "0 commits scanned, no leaks found". This wrapper runs gitleaks with debug logging, never shows
// a debug record (they can contain file content), shows only gitleaks' summary lines, warnings and errors, and marks the
// scan incomplete when either sign appears: exit 0 becomes 2, a non-zero exit (e.g. 1 for leaks) is kept.
// It accepts only gitleaks versions whose log format and behaviour were verified, so a new version cannot quietly
// turn the detection off.
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MERGE_LOG_OPTS = '--all --full-history --diff-filter=tuxdb --diff-merges=remerge';
export const SUPPORTED_GITLEAKS = ['8.30.1'];
export const INCOMPLETE_EXIT = 2;
// zerolog console records: "6:30PM DBG message ...". Lines without the prefix continue the record. Records logged
// before gitleaks applies --no-color (while it loads its config) still carry ANSI colour codes, so they are stripped
// before matching.
const RECORD = /^\d{1,2}:\d{2}[AP]M (TRC|DBG|INF|WRN|ERR|FTL) /;
// Built from the code point: a control character in a regex literal trips ESLint's no-control-regex in the repositories
// that copy this file.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

// The closed gitleaks grammar of the local gate, shared with `devkit check` (src/checks/secrets-scan.mjs). A full-history
// scan of the repository root with the root .gitleaks.toml and the default leak exit code; anything that could narrow
// the scan, change its target or exit code, or skip it (--staged, --enable-rule, --baseline-path, --exit-code, --help,
// another --source or --config, any other --log-opts) is not recognised. --max-target-megabytes is syntax only here:
// `devkit check` additionally requires the size guard when N > 0.
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const OUTPUT_FLAGS = new Set(['--no-banner', '--no-color', '--verbose', '-v']);
const OUTPUT_OPTIONS = new Set(['--log-level', '-l', '--report-format', '-f', '--report-path', '-r', '--report-template']);
const ROOT = new Set(['.', './']);
const PINNED = {
  '--config': new Set(['.gitleaks.toml', './.gitleaks.toml']), '-c': new Set(['.gitleaks.toml', './.gitleaks.toml']),
  '--gitleaks-ignore-path': new Set(['.', './', '.gitleaksignore', './.gitleaksignore']), '-i': new Set(['.', './', '.gitleaksignore', './.gitleaksignore']),
};

/** null when argv is not an accepted full-history scan; otherwise whether it also covers merge commits. */
export function scanCoverage(argv, { sizeGuard = false } = {}) {
  if (!Array.isArray(argv) || argv[0] !== 'gitleaks' || !['git', 'detect'].includes(argv[1])) return null;
  const detect = argv[1] === 'detect';
  const positional = [];
  let sizeFlags = 0;
  let logFlags = 0;
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (typeof arg !== 'string') return null;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => (inline !== undefined ? inline : argv[++index]);
    if (!flag.startsWith('-')) positional.push(arg);
    else if (OUTPUT_FLAGS.has(flag) && inline === undefined) continue;
    else if (flag === '--redact') { if (inline !== undefined && !/^\d+$/.test(inline)) return null; }
    else if (OUTPUT_OPTIONS.has(flag)) { if (typeof value() !== 'string') return null; }
    else if (PINNED[flag]) { if (!PINNED[flag].has(value())) return null; }
    else if (detect && (flag === '--source' || flag === '-s')) { if (!ROOT.has(value())) return null; }
    else if (flag === '--log-opts') { if (++logFlags > 1 || value() !== MERGE_LOG_OPTS) return null; }
    else if (flag === '--max-target-megabytes') {
      const limit = value();
      if (++sizeFlags > 1 || typeof limit !== 'string' || !DECIMAL.test(limit) || (Number(limit) > 0 && !sizeGuard)) return null;
    }
    else return null;
  }
  const rooted = detect ? positional.length === 0 : positional.length <= 1 && positional.every((item) => ROOT.has(item));
  return rooted ? { merges: logFlags === 1 } : null;
}

/** Returns why the arguments cannot be used, or null. */
export function argumentProblem(args) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return '参数必须都是字符串';
  if (args[0] !== 'git') return '第一个参数必须是 git（扫描 git 历史）';
  let logOpts = 0;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (flag === '--log-level' || flag === '-l') return '日志级别由本脚本控制，不能传 --log-level';
    if (flag === '--log-opts') {
      const value = inline ?? args[++index];
      if (value !== MERGE_LOG_OPTS || ++logOpts > 1) return `--log-opts 必须且只能写一次：--log-opts=${MERGE_LOG_OPTS}`;
    }
  }
  return logOpts === 1 ? null : `缺少 --log-opts=${MERGE_LOG_OPTS}`;
}

/** The local gate's form: argumentProblem plus the closed grammar `devkit check` uses (scanCoverage). */
export function gateArgumentProblem(args) {
  const basic = argumentProblem(args);
  if (basic) return basic;
  const coverage = scanCoverage(['gitleaks', ...args], { sizeGuard: true });
  return coverage?.merges ? null : '参数不在门禁的封闭语法内：只能用 .gitleaks.toml 扫描仓库根目录的全部历史，不能改变范围、配置或退出码（见 shadow-devkit docs/standards/ci-local-gate.md §2）';
}

/** git's trace output also reaches gitleaks' stderr; turn it off so only real git errors count. */
export function scanEnvironment(source = process.env) {
  return {
    ...Object.fromEntries(Object.entries(source).filter(([name]) => !/^GIT_TRACE/.test(name))),
    GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0',
  };
}

// What is shown: gitleaks' own summary lines, warnings and errors, each one line and capped. Anything else (debug and
// trace records, their continuation lines, unknown text) is dropped: a debug record can hold file content, and a value
// with a newline in it can produce a continuation line that looks like a record of its own.
const SUMMARY = /^(\d+ commits scanned\.|scanned ~\d+ bytes .*|no leaks found|leaks found: \d+)$/;
const SHOWN_MAX = 300;
// The abort is gitleaks' own message at a fixed place: a debug record whose message is exactly "command aborted".
const ABORTED = /^\d{1,2}:\d{2}[AP]M DBG command aborted(?: error="([^"]*)")?(?: |$)/;

/** Splits gitleaks' stderr into records: shows summary lines, warnings and errors, collects the incompleteness signs. */
export function createLogFilter(show) {
  const state = { gitErrors: [], aborted: [] };
  let pending = '';
  const line = (raw) => {
    const text = raw.replace(ANSI, '');
    const record = text.match(RECORD);
    if (!record) return; // a continuation line, or text that is not a gitleaks record
    const level = record[1];
    const message = text.slice(record[0].length);
    const aborted = text.match(ABORTED);
    if (aborted) state.aborted.push(aborted[1] ?? 'unknown');
    if (level === 'ERR' && message.startsWith('[git] ')) state.gitErrors.push(message.slice(0, SHOWN_MAX));
    const shown = level === 'ERR' || level === 'FTL' || level === 'WRN' || (level === 'INF' && SUMMARY.test(message));
    if (shown) show(`${text.slice(0, record[0].length + SHOWN_MAX)}\n`);
  };
  return {
    state,
    write(chunk) {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      lines.forEach(line);
    },
    end() {
      if (pending) line(pending);
      pending = '';
    },
  };
}

/**
 * Runs gitleaks with `args` (validated by gateArgumentProblem, or argumentProblem when strict is false). Resolves to
 * { status, incomplete, gitErrors, aborted, version }; status is gitleaks' own exit code unless the scan could not
 * start or was incomplete with exit 0, which become INCOMPLETE_EXIT.
 */
export function runSecretsScan(args, { cwd = process.cwd(), env = process.env, gitleaks = 'gitleaks', stdout = process.stdout, stderr = process.stderr, strict = true } = {}) {
  const fail = (message) => {
    stderr.write(`secrets-scan: ${message}\n`);
    return Promise.resolve({ status: INCOMPLETE_EXIT, incomplete: true, gitErrors: [], aborted: [], version: null });
  };
  // strict: the local gate's closed grammar. Triage passes strict: false for its own config, report and exit code.
  const problem = strict ? gateArgumentProblem(args) : argumentProblem(args);
  if (problem) return fail(problem);
  const probe = spawnSync(gitleaks, ['version'], { cwd, env, encoding: 'utf8' });
  const version = (probe.stdout ?? '').trim().replace(/^v/, '');
  if (probe.error || probe.status !== 0) return fail(`无法运行 ${gitleaks} version（${probe.error?.code ?? probe.status}）`);
  if (!SUPPORTED_GITLEAKS.includes(version)) {
    return fail(`gitleaks ${version || '未知版本'} 未经核实（支持 ${SUPPORTED_GITLEAKS.join('、')}）：它的日志格式和出错行为决定能否发现不完整的扫描。核实后更新 shadow-devkit 的 templates/ci/secrets-scan.mjs 再同步。`);
  }
  return new Promise((resolve) => {
    const child = spawn(gitleaks, [...args, '--no-color', '--log-level', 'debug'], { cwd, env: scanEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
    const filter = createLogFilter((text) => stderr.write(text));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout.write(chunk));
    child.stderr.on('data', (chunk) => filter.write(chunk));
    child.on('error', (error) => {
      stderr.write(`secrets-scan: 无法启动 ${gitleaks}（${error.code}）\n`);
      resolve({ status: INCOMPLETE_EXIT, incomplete: true, gitErrors: [], aborted: [], version });
    });
    child.on('close', (code, signal) => {
      filter.end();
      const { gitErrors, aborted } = filter.state;
      const incomplete = gitErrors.length > 0 || aborted.length > 0 || signal !== null;
      if (incomplete) {
        const reasons = [
          ...gitErrors.slice(0, 5).map((text) => `git 报错：${text}`),
          ...aborted.map((reason) => `git 异常退出：${reason}`),
          ...(signal ? [`gitleaks 被信号 ${signal} 终止`] : []),
        ];
        stderr.write(`secrets-scan: 扫描不完整，部分历史没有被扫描，不能判定为通过：\n${reasons.map((reason) => `  - ${reason}`).join('\n')}\n`);
      }
      const status = code === null ? INCOMPLETE_EXIT : code;
      resolve({ status: incomplete && status === 0 ? INCOMPLETE_EXIT : status, incomplete, gitErrors, aborted, version });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href) {
  const { status } = await runSecretsScan(process.argv.slice(2));
  process.exitCode = status;
}
