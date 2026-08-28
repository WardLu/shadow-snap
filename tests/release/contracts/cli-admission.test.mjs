import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseCliArgs, safeReasonCode } from '../../../scripts/release/cli.mjs';

test('CLI parses only explicit release arguments', () => {
  assert.deepEqual(
    parseCliArgs([
      'stage',
      '--tag',
      'v1.2.3',
      '--authorize',
      'a'.repeat(64),
      '--deployment',
      'https://example.vercel.app',
    ]),
    {
      command: 'stage',
      tag: 'v1.2.3',
      authorize: 'a'.repeat(64),
      deployment: 'https://example.vercel.app',
      hosted: false,
      localOnly: false,
      billingFallback: false,
      intent: undefined,
      assetId: undefined,
    },
  );
  assert.throws(() => parseCliArgs(['stage', '--yes']), /cli_argument_unknown/);
  assert.throws(() => parseCliArgs(['unknown']), /cli_command_unknown/);
  assert.throws(
    () => parseCliArgs(['stage', '--tag', 'v1.2.3', '--tag', 'v1.2.4']),
    /cli_argument_duplicate/,
  );
});

test('CLI routes without adding implicit authorization', async () => {
  const calls = [];
  const controller = {
    stage: async (request) => {
      calls.push(request);
      return { status: 'authorization_required', authorizationDigest: 'b'.repeat(64) };
    },
  };
  const result = await main(['stage', '--tag', 'v1.2.3'], {
    repoRoot: '/repo',
    config: { repository: 'WardLu/shadow-snap' },
    controller,
  });
  assert.equal(result.authorizationDigest, 'b'.repeat(64));
  assert.equal(calls[0].authorize, undefined);
  assert.equal(calls[0].tag, 'v1.2.3');
});

test('CLI never exposes arbitrary exception text as a reason code', () => {
  assert.equal(safeReasonCode(new Error('authorization_expired')), 'authorization_expired');
  assert.equal(
    safeReasonCode(new Error('request failed with sensitive credential material')),
    'unexpected_error',
  );
});
