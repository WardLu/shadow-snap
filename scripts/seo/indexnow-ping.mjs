#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_HOST = 'snap.shadow.wang';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const KEY_FILE_RE = /^([0-9a-f]{32})\.txt$/;

function parseArgs(argv) {
  const args = { dryRun: !argv.includes('--submit'), verify: argv.includes('--verify'), host: DEFAULT_HOST };
  const hostIdx = argv.indexOf('--host');
  if (hostIdx !== -1 && argv[hostIdx + 1]) args.host = argv[hostIdx + 1];
  return args;
}

async function resolvePublicIndexNowKey() {
  const entries = await readdir(REPO_ROOT);
  const matches = entries.filter((name) => KEY_FILE_RE.test(name));
  const filename = matches.find((name) => name.startsWith('48b940e4')) ?? (matches.length === 1 ? matches[0] : null);
  if (!filename) {
    throw new Error(`indexnow_key_file_ambiguous_or_missing:${matches.join(',')}`);
  }
  const expectedKey = filename.slice(0, -4);
  const content = (await readFile(path.join(REPO_ROOT, filename), 'utf8')).trim();
  if (content !== expectedKey) throw new Error('indexnow_local_key_mismatch');
  return expectedKey;
}

async function loadUrlsFromSitemap(host) {
  const xml = await readFile(path.join(REPO_ROOT, 'sitemap.xml'), 'utf8');
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  const owned = locs.filter((loc) => {
    const parsed = new URL(loc);
    return parsed.protocol === 'https:' && parsed.host === host;
  });
  if (owned.length === 0) throw new Error(`indexnow_no_owned_urls_for_host:${host}`);
  if (owned.length !== locs.length) {
    throw new Error(`indexnow_host_mismatch: expected all ${locs.length} sitemap URLs under ${host}, got ${owned.length}`);
  }
  return owned;
}

async function verifyRemoteKey(keyLocation, key) {
  const res = await fetch(keyLocation);
  const body = await res.text();
  if (!res.ok || body.trim() !== key) {
    throw new Error(`indexnow_remote_key_invalid: HTTP ${res.status} at ${keyLocation}`);
  }
  console.log(`[indexnow] verified remote key at ${keyLocation} (HTTP ${res.status})`);
}

async function main() {
  const { dryRun, verify, host } = parseArgs(process.argv.slice(2));
  const key = await resolvePublicIndexNowKey();
  const keyLocation = `https://${host}/${key}.txt`;
  const urlList = await loadUrlsFromSitemap(host);

  if (verify || !dryRun) {
    await verifyRemoteKey(keyLocation, key);
  }

  const payload = { host, key, keyLocation, urlList };
  if (dryRun) {
    console.log(JSON.stringify({ mode: 'dry-run', endpoint: ENDPOINT, payload }, null, 2));
    return;
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (res.status === 200 || res.status === 202) {
    console.log(JSON.stringify({ mode: 'submitted', status: res.status, note: 'Accepted by IndexNow (submission receipt only, not indexing confirmation)', count: urlList.length, body: text || null }, null, 2));
    return;
  }
  const hints = { 403: 'key validation failed', 422: 'URLs do not belong to host or invalid schema', 429: 'rate limited / spam throttle' };
  throw new Error(`indexnow_submit_failed: HTTP ${res.status} (${hints[res.status] || 'unexpected'}) ${text}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
