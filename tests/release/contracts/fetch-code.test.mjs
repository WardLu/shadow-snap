import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs fetch_code from the release script against a fake fetch that prints the given status codes in turn.
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/release/site-content-functions.sh');
const source = readFileSync(SCRIPT, 'utf8');
const start = source.indexOf('TRANSPORT_ATTEMPTS=3');
const helper = source.slice(start, source.indexOf('\n}\n', start) + 3);

function fetchCode(codes) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fetch-code-'));
  try {
    const counter = path.join(dir, 'calls');
    const program = `${helper}
echo 0 > '${counter}'
fake() { n=$(( $(cat '${counter}') + 1 )); echo "$n" > '${counter}'; set -- ${codes.join(' ')}; eval "c=\\\${$n:-200}"; printf '%s' "$c"; [ "$c" != 000 ]; }
printf '%s' "$(fetch_code fake)"`;
    const result = spawnSync('/bin/bash', ['-c', program], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.equal(result.status, 0, result.stderr);
    return { code: result.stdout, calls: Number(readFileSync(counter, 'utf8')), stderr: result.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('fetch_code retries a fetch with no HTTP response and recovers', () => {
  const { code, calls } = fetchCode(['000', '000', '200']);
  assert.deepEqual({ code, calls }, { code: '200', calls: 3 });
});

test('fetch_code stops after three transport failures', () => {
  const { code, calls } = fetchCode(['000', '000', '000', '200']);
  assert.deepEqual({ code, calls }, { code: '000', calls: 3 });
});

test('fetch_code retries a transient HTTP status and stops after three', () => {
  assert.deepEqual(fetchCode(['503', '502', '200']).code, '200');
  const { code, calls } = fetchCode(['503', '429', '503', '200']);
  assert.deepEqual({ code, calls }, { code: '503', calls: 3 });
});

test('fetch_code returns any other HTTP status at once, such as 404', () => {
  const { code, calls, stderr } = fetchCode(['404', '200']);
  assert.deepEqual({ code, calls }, { code: '404', calls: 1 });
  assert.doesNotMatch(stderr, /重试/);
});
