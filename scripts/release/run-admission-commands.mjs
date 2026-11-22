#!/usr/bin/env node
// Re-runs the admission commands from config/release-production.json before anything is uploaded.
// Commands get an allow-listed environment and a throwaway HOME: deployment credentials in the
// caller's environment or home directory (~/.npmrc, ~/.vercel, ...) never reach npm lifecycle
// scripts or test code. npm's cache and proxy settings live in the Node installation's npmrc.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadReleaseConfig } from './release-config.mjs';

const INHERITED = ['PATH', 'LANG', 'TZ', 'TMPDIR'];

export function admissionEnvironment(source = process.env, home) {
  const env = { CI: '1' };
  for (const name of INHERITED) if (source[name] !== undefined) env[name] = source[name];
  if (home !== undefined) env.HOME = home;
  return env;
}

function main() {
  const commands = loadReleaseConfig().admissionCommands ?? [];
  if (commands.length === 0) throw new Error('admission_commands_empty');
  const home = mkdtempSync(path.join(os.tmpdir(), 'release-admission-home-'));
  try {
    const env = admissionEnvironment(process.env, home);
    for (const [command, ...args] of commands) {
      process.stdout.write(`\n$ ${[command, ...args].join(' ')}\n`);
      const result = spawnSync(command, args, { stdio: 'inherit', env, shell: false });
      if (result.error || result.status !== 0) throw new Error(`admission_command_failed:${command}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  process.stdout.write('\n✅ 准入命令全部通过\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`release-admission: ${/^[a-z_]+(:[^\s]+)?$/.test(error.message) ? error.message : 'admission_failed'}`);
    process.exitCode = 1;
  }
}
