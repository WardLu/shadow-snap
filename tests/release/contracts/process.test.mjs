import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommandRunner } from '../../../scripts/release/process.mjs';

test('command runner can remove release credentials from admission children', async () => {
  let childEnvironment;
  const runner = createCommandRunner({
    spawnSyncImpl: (_command, _args, options) => {
      childEnvironment = options.env;
      return { status: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  await runner('node', ['--version'], {
    env: { GH_TOKEN: 'test-token', KEEP_FOR_TEST: 'yes' },
    unsetEnv: ['GH_TOKEN'],
  });
  assert.equal(childEnvironment.GH_TOKEN, undefined);
  assert.equal(childEnvironment.KEEP_FOR_TEST, 'yes');
});
