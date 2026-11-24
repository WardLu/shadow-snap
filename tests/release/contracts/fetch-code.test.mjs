import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs fetch_code from the release functions against a fake fetch that prints the given status codes in turn. The
// decision comes from scripts/release/transport-policy.mjs (shadow-devkit template), so node must be on PATH.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/release/site-content-functions.sh');
const source = readFileSync(SCRIPT, 'utf8');
const start = source.indexOf('TRANSPORT_ATTEMPTS=3');
const helper = source.slice(start, source.indexOf('\n}\n', start) + 3);

// Each entry is "<status>" or "<status>:<curl exit>"; a bare 000 means curl could not connect (exit 7).
function fetchCode(codes) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fetch-code-'));
  try {
    const counter = path.join(dir, 'calls');
    const program = `ROOT_DIR='${ROOT}'
${helper}
echo 0 > '${counter}'
fake() { n=$(( $(cat '${counter}') + 1 )); echo "$n" > '${counter}'; set -- ${codes.join(' ')}; eval "c=\\\${$n:-200}"; code="\${c%%:*}"; exit_code=0; case "$c" in *:*) exit_code="\${c#*:}" ;; 000) exit_code=7 ;; esac; printf 'HTTP/1.1 %s\r\nRetry-After: 0\r\n\r\n' "$code" > '${dir}/headers'; printf '%s' "$code"; return "$exit_code"; }
out="$(fetch_code '${dir}/body' '${dir}/headers' curl fake)"; rc=$?; printf '%s %s' "$out" "$rc"`;
    const result = spawnSync('/bin/bash', ['-c', program], { encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.equal(result.status, 0, result.stderr);
    const [code, rc] = result.stdout.split(' ');
    return { code, ok: rc === '0', calls: Number(readFileSync(counter, 'utf8')), stderr: result.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('fetch_code retries a fetch with no HTTP response and recovers', () => {
  const { code, ok, calls } = fetchCode(['000', '000', '200']);
  assert.deepEqual({ code, ok, calls }, { code: '200', ok: true, calls: 3 });
});

test('fetch_code stops after three transport failures', () => {
  const { code, ok, calls } = fetchCode(['000', '000', '000', '200']);
  assert.deepEqual({ code, ok, calls }, { code: '000', ok: false, calls: 3 });
});

test('fetch_code retries a transient HTTP status and stops after three', () => {
  const recovered = fetchCode(['503', '502', '200']);
  assert.deepEqual({ code: recovered.code, ok: recovered.ok }, { code: '200', ok: true });
  const { code, ok, calls } = fetchCode(['503', '429', '503', '200']);
  assert.deepEqual({ code, ok, calls }, { code: '503', ok: false, calls: 3 });
});

test('fetch_code returns any other HTTP status at once, such as 404', () => {
  const { code, ok, calls, stderr } = fetchCode(['404', '200']);
  assert.deepEqual({ code, ok, calls }, { code: '404', ok: false, calls: 1 });
  assert.doesNotMatch(stderr, /重试/);
});

test('fetch_code retries an HTTP 200 whose transfer broke off, and stops after three', () => {
  const recovered = fetchCode(['200:18', '200']);
  assert.deepEqual({ code: recovered.code, ok: recovered.ok, calls: recovered.calls }, { code: '200', ok: true, calls: 2 });
  const { code, ok, calls } = fetchCode(['200:18', '200:56', '200:28', '200']);
  assert.deepEqual({ code, ok, calls }, { code: '200', ok: false, calls: 3 }, 'three broken transfers fail even though curl printed 200');
});

test('fetch_code does not retry a command that failed before sending a request', () => {
  const { code, ok, calls } = fetchCode(['oops:1', '200']);
  assert.deepEqual({ code, ok, calls }, { code: 'oops', ok: false, calls: 1 });
});

test('verify_against_commit enforces stall-based read limits and overall verify budget', () => {
  assert.match(source, /\$READ_LIMITS/);
  assert.match(source, /VERIFY_BUDGET_SECONDS=/);
  const { mkdtempSync: mkd, rmSync: rmD } = { mkdtempSync, rmSync };
  const dir = mkd(path.join(os.tmpdir(), 'snap-budget-'));
  try {
    const program = `ROOT_DIR=$1\nD=$2\nVERIFY_BUDGET_SECONDS=600\n${helper}\ndate() { echo 2000; }\nFETCH_DEADLINE=1500\nfake() { printf called >> "$D/called"; printf 200; }\nfetch_code "$D/body" "$D/headers" curl fake`;
    const result = spawnSync('/bin/bash', ['-c', program, 'test', ROOT, dir], { encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /总时长预算/);
  } finally { rmD(dir, { recursive: true, force: true }); }
});
