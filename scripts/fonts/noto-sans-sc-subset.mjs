#!/usr/bin/env node
// Generate the local Noto Sans SC CJK subset used by the static site.
//
// Usage:
//   node scripts/fonts/noto-sans-sc-subset.mjs --source /path/to/NotoSansSC-Regular.otf
//   node scripts/fonts/noto-sans-sc-subset.mjs --check
//
// The source file is not committed (it is an OFL-licensed build artifact); the generated
// WOFF2 and its CSS are committed so CI can verify the shipped bytes offline.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = path.join(ROOT, 'public/fonts-subset/noto-sans-sc-cjk.woff2');
const CSS = path.join(ROOT, 'public/fonts-subset/fonts-subset.css');
const MAX_BYTES = 200 * 1024;

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write('Usage: node scripts/fonts/noto-sans-sc-subset.mjs --source <NotoSansSC.otf> [--check]\n');
  process.exit(2);
}

function parseArgs(argv) {
  const options = { check: false, source: '' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check') options.check = true;
    else if (argv[index] === '--source') {
      options.source = argv[index + 1] ?? '';
      index += 1;
    } else usage(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function localizedHtmlFiles() {
  const files = ['index.html', '404.html'];
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'public' || entry.name === 'scripts') continue;
    const page = path.join(ROOT, entry.name, 'index.html');
    if (existsSync(page)) files.push(page);
  }
  return files;
}

function collectCharacters() {
  const characters = new Set();
  for (const file of [...localizedHtmlFiles(), 'translations.mjs', 'seo-content.mjs']) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    for (const character of text) {
      if (character.codePointAt(0) >= 32) characters.add(character);
    }
  }
  return [...characters].sort().join('');
}

function generate(source) {
  if (!existsSync(source)) usage(`Source font not found: ${source}`);
  const characters = collectCharacters();
  const work = mkdtempSync(path.join(tmpdir(), 'shadow-snap-font-'));
  try {
    const textFile = path.join(work, 'characters.txt');
    writeFileSync(textFile, characters);
    execFileSync('pyftsubset', [
      source,
      `--text-file=${textFile}`,
      '--layout-features=*',
      '--no-hinting',
      '--flavor=woff2',
      `--output-file=${OUTPUT}`,
    ], { stdio: 'inherit' });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const bytes = statSync(OUTPUT).size;
  if (bytes > MAX_BYTES) {
    throw new Error(`Subset is ${bytes} bytes, exceeds ${MAX_BYTES} bytes`);
  }
  process.stdout.write(`Wrote ${path.relative(ROOT, OUTPUT)} (${bytes} bytes, ${characters.length} characters)\n`);
}

function check() {
  if (!existsSync(OUTPUT)) throw new Error(`Missing ${path.relative(ROOT, OUTPUT)}; run the generator with --source`);
  const bytes = statSync(OUTPUT).size;
  if (bytes > MAX_BYTES) throw new Error(`Subset is ${bytes} bytes, exceeds ${MAX_BYTES} bytes`);
  const css = readFileSync(CSS, 'utf8');
  if (!css.includes('/public/fonts-subset/noto-sans-sc-cjk.woff2')) throw new Error('fonts-subset.css does not reference the subset file');
  process.stdout.write(`[noto-sans-sc-subset] OK: ${bytes} bytes, ${statSync(CSS).size} byte CSS\n`);
}

const options = parseArgs(process.argv.slice(2));
if (options.check) check();
else {
  if (!options.source) usage('Missing --source <NotoSansSC.otf>');
  generate(path.resolve(options.source));
}

