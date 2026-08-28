import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const COMMANDS = new Set([
  'admit',
  'initialize',
  'stage',
  'promote',
  'rollback',
  'resume',
  'recover',
  'renew',
  'audit',
  'unlock',
  'fail',
  'anchor-admission',
]);
const VALUE_FLAGS = new Map([
  ['--tag', 'tag'],
  ['--authorize', 'authorize'],
  ['--deployment', 'deployment'],
  ['--intent', 'intent'],
  ['--asset-id', 'assetId'],
]);
const BOOLEAN_FLAGS = new Map([
  ['--hosted', 'hosted'],
  ['--local-only', 'localOnly'],
  ['--billing-fallback', 'billingFallback'],
]);

function fail(reasonCode) {
  throw new Error(reasonCode);
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !COMMANDS.has(argv[0])) {
    fail('cli_command_unknown');
  }
  const result = {
    command: argv[0],
    tag: undefined,
    authorize: undefined,
    deployment: undefined,
    hosted: false,
    localOnly: false,
    billingFallback: false,
    intent: undefined,
    assetId: undefined,
  };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) fail('cli_argument_duplicate');
    seen.add(flag);
    if (VALUE_FLAGS.has(flag)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('cli_argument_value_missing');
      result[VALUE_FLAGS.get(flag)] = value;
      index += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      result[BOOLEAN_FLAGS.get(flag)] = true;
      continue;
    }
    fail('cli_argument_unknown');
  }
  return result;
}

export function safeReasonCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^[a-z0-9_:-]+$/.test(message)) return message;
  return 'unexpected_error';
}

async function resolveDependencies(dependencies) {
  if (dependencies.repoRoot && dependencies.config && dependencies.controller) {
    return dependencies;
  }
  const { createRuntime } = await import('./runtime.mjs');
  return createRuntime({ repoRoot: process.cwd() });
}

export async function main(argv, dependencies = {}) {
  const parsed = parseCliArgs(argv);
  const runtime = await resolveDependencies(dependencies);
  const method = runtime.controller[parsed.command];
  if (typeof method !== 'function') fail('cli_command_not_implemented');
  if (parsed.command !== 'audit' && !parsed.tag) fail('cli_tag_required');
  if (parsed.billingFallback && parsed.command !== 'admit') {
    fail('billing_fallback_command_invalid');
  }
  return method({
    repoRoot: runtime.repoRoot,
    config: runtime.config,
    tag: parsed.tag,
    authorize: parsed.authorize,
    deployment: parsed.deployment,
    intent: parsed.intent,
    assetId: parsed.assetId,
    hosted: parsed.hosted,
    localOnly: parsed.localOnly,
    billingFallback: parsed.billingFallback,
  });
}

async function runFromShell() {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const reasonCode = safeReasonCode(error);
    const errorDigest = createHash('sha256')
      .update(error instanceof Error ? error.message : String(error), 'utf8')
      .digest('hex');
    process.stderr.write(`${JSON.stringify({ status: 'failed', reasonCode, errorDigest })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromShell();
}
