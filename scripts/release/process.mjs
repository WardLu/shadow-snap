import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

function digest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function assertCommand(command, args) {
  if (typeof command !== 'string' || command.length === 0 || command.includes('\0')) {
    throw new TypeError('command_invalid');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new TypeError('command_args_invalid');
  }
}

export class CommandError extends Error {
  constructor({ command, exitCode, reasonCode, stderrDigest }) {
    super(`${reasonCode}:${command}:exit_${exitCode}`);
    this.name = 'CommandError';
    this.command = command;
    this.exitCode = exitCode;
    this.reasonCode = reasonCode;
    this.stderrDigest = stderrDigest;
  }
}

export function createCommandRunner({ spawnSyncImpl = spawnSync } = {}) {
  return async function run(
    command,
    args = [],
    {
      cwd = process.cwd(),
      env = {},
      inheritEnv = true,
      unsetEnv = [],
      input,
      allowExitCodes = [0],
      maxBuffer = DEFAULT_MAX_BUFFER,
    } = {},
  ) {
    assertCommand(command, args);
    if (!Array.isArray(allowExitCodes) || allowExitCodes.some((code) => !Number.isInteger(code))) {
      throw new TypeError('allow_exit_codes_invalid');
    }
    if (
      !Array.isArray(unsetEnv) ||
      unsetEnv.some((name) => typeof name !== 'string' || name.length === 0)
    ) {
      throw new TypeError('unset_env_invalid');
    }
    if (typeof inheritEnv !== 'boolean') throw new TypeError('inherit_env_invalid');

    const childEnv = { ...(inheritEnv ? process.env : {}), ...env };
    for (const name of unsetEnv) delete childEnv[name];

    const result = spawnSyncImpl(command, args, {
      cwd,
      env: childEnv,
      input,
      encoding: 'utf8',
      maxBuffer,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exitCode = Number.isInteger(result.status) ? result.status : 1;
    const stderrDigest = digest(result.stderr || result.error?.message || '');

    if (result.error || !allowExitCodes.includes(exitCode)) {
      throw new CommandError({
        command,
        exitCode,
        reasonCode: result.error ? 'command_spawn_failed' : 'command_exit_nonzero',
        stderrDigest,
      });
    }

    return {
      stdout: String(result.stdout ?? ''),
      exitCode,
      stderrDigest,
    };
  };
}
