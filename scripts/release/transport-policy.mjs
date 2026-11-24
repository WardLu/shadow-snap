#!/usr/bin/env node
import { realpathSync } from 'node:fs';
// Pure read-only transport decision. It does not execute HTTP or retry writes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// curl limits for reading one file: connecting may take 30 s, the transfer stops once it averages under 1 KB/s for
// 30 s, and the whole read stops after 300 s. All three exit 28, which decideTransport retries. A slow but moving
// read can finish; a fixed --max-time 30 cut off complete 370 KB reads on a 45 KB/s link shared by 8 parallel reads.
export const CURL_READ_LIMITS = Object.freeze(['--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '30', '--max-time', '300']);
// Overall wall-clock budget for one verify_against_commit pass (deployment precheck or one production domain) so
// many files on a slow/degraded link fail closed in bounded time instead of stacking 300 s reads indefinitely.
export const VERIFY_BUDGET_SECONDS = 600;
export function retryAfterMs(headers, now = Date.now()) {
  const sections = String(headers).split(/(?=^HTTP\/\S+\s+\d{3})/im);
  const last = sections.at(-1) ?? '';
  const matches = [...last.matchAll(/^retry-after:\s*([^\r\n]+)\s*$/gim)];
  const value = matches.at(-1)?.[1]?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Math.min(30000, Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(30000, Math.max(0, at - now)) : null;
}
export function decideTransport({ exitCode, httpStatus, attempt, retryAfter = null, random = Math.random, transport = 'curl' }) {
  const status = Number(httpStatus);
  if (exitCode === 0 && status === 200) return { action: 'success', waitMs: 0 };
  const curlNetwork = ['curl', 'vercel'].includes(transport) && /^[0-9]{3}$/.test(String(httpStatus)) && [5, 6, 7, 18, 28, 35, 52, 55, 56].includes(exitCode);
  const transient = ((status === 0 && curlNetwork) ||
    (status >= 200 && status < 300 && curlNetwork && [18, 28, 56].includes(exitCode)) ||
    ([408, 429, 500, 502, 503, 504].includes(status) && (exitCode === 0 || curlNetwork)));
  if (!transient || attempt >= 3) return { action: 'fail', waitMs: 0 };
  return { action: 'retry', waitMs: retryAfter ?? Math.min(30000, Math.round(1000 * (2 ** (attempt - 1)) * (0.5 + random()))) };
}
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href;
if (invokedDirectly && process.argv[2] === '--curl-read-limits') {
  console.log(CURL_READ_LIMITS.join(' '));
} else if (invokedDirectly && process.argv[2] === '--verify-budget-seconds') {
  console.log(String(VERIFY_BUDGET_SECONDS));
} else if (invokedDirectly) {
  const [exit, status, attempt, headersPath, transport] = process.argv.slice(2);
  let headers = ''; try { headers = readFileSync(headersPath, 'utf8'); } catch { /* no response headers */ }
  const result = decideTransport({ exitCode: Number(exit), httpStatus: status, attempt: Number(attempt), retryAfter: retryAfterMs(headers), transport });
  console.log(`${result.action} ${result.waitMs}`);
}
