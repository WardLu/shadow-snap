import { access, stat } from 'node:fs/promises';
import path from 'node:path';

import { loadReleaseConfig } from './release/config.mjs';
import { installControllerBinding } from './release/lock.mjs';
import { evaluatePrePush } from './release/pre-push.mjs';
import { createCommandRunner } from './release/process.mjs';

const repoRoot = process.cwd();
const runner = createCommandRunner();

async function main() {
  const config = await loadReleaseConfig(repoRoot);
  const trackedPaths = [
    'config/release-production.json',
    'scripts/release',
    'scripts/install-release-controller.mjs',
    '.githooks/pre-push',
  ];
  const dirty = await runner('git', ['status', '--porcelain=v1', '--', ...trackedPaths], {
    cwd: repoRoot,
  });
  if (dirty.stdout.trim()) throw new Error('controller_install_requires_clean_files');

  const hookPath = path.join(repoRoot, '.githooks', 'pre-push');
  await access(hookPath);
  if (((await stat(hookPath)).mode & 0o111) === 0) throw new Error('pre_push_hook_not_executable');

  const binding = await installControllerBinding({ runner, repoRoot, config });
  await runner('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
    cwd: repoRoot,
  });
  const configured = await runner('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd: repoRoot,
  });
  if (configured.stdout.trim() !== '.githooks') throw new Error('hooks_path_verification_failed');

  const normalRef = await evaluatePrePush({
    input: `refs/heads/main ${'1'.repeat(40)} refs/heads/main ${'0'.repeat(40)}\n`,
    repoRoot,
    config,
    runner,
  });
  if (!normalRef.allowed) throw new Error('pre_push_normal_ref_self_test_failed');
  const productionRef = await evaluatePrePush({
    input: `refs/heads/production ${'1'.repeat(40)} refs/heads/production ${'0'.repeat(40)}\n`,
    repoRoot,
    config,
    runner,
    controllerPaths: {
      ...binding,
      capabilityPath: path.join(binding.stateDir, 'self-test-capability-missing.json'),
    },
  });
  if (productionRef.allowed || productionRef.reasonCode !== 'capability_missing') {
    throw new Error('pre_push_production_deny_self_test_failed');
  }

  process.stdout.write(
    `${JSON.stringify({
      status: 'installed',
      repository: config.repository,
      instanceId: config.controller.instanceId,
      bindingPath: path.relative(repoRoot, binding.bindingPath),
      hooksPath: '.githooks',
      selfTest: {
        normalRef: normalRef.reasonCode,
        productionWithoutCapability: productionRef.reasonCode,
      },
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`release-controller: ${error.message}\n`);
  process.exitCode = 1;
});
