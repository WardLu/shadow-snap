import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertReleaseTag,
  scanWorkflowText,
} from '../../../scripts/release/policy.mjs';

test('accepts only v-prefixed semantic release tags', () => {
  assert.doesNotThrow(() => assertReleaseTag('v1.2.3'));
  assert.doesNotThrow(() => assertReleaseTag('v1.2.3-rc.1'));
  assert.throws(() => assertReleaseTag('main'), /release_tag_invalid/);
  assert.throws(
    () => assertReleaseTag('0123456789abcdef0123456789abcdef01234567'),
    /release_tag_invalid/,
  );
});

test('rejects production writes regardless of workflow trigger', () => {
  const text = [
    'on: schedule',
    'jobs:',
    '  deploy:',
    '    steps:',
    '      - run: vercel deploy --prod',
  ].join('\n');

  assert.deepEqual(scanWorkflowText('.github/workflows/nightly.yml', text), [
    'workflow_vercel_production_write',
  ]);
});

test('does not reject the read-only admission workflow', () => {
  const text = [
    'permissions:',
    '  contents: read',
    'steps:',
    "  - run: npm run release:admit -- --tag '$GITHUB_REF_NAME' --hosted",
  ].join('\n');

  assert.deepEqual(
    scanWorkflowText('.github/workflows/release.yml', text),
    [],
  );
});

test('rejects release creation and production ref updates', () => {
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/release.yml',
      'steps:\n  - run: gh release create v1.2.3',
    ),
    ['workflow_release_write'],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/push.yml',
      'steps:\n  - run: git push origin HEAD:production',
    ),
    ['workflow_production_ref_write'],
  );
});

test('rejects dynamic HTTP, GitHub Script, and third-party deploy bypasses', () => {
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/curl.yml',
      [
        'env:',
        '  VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}',
        'steps:',
        '  - run: |',
        '      curl https://api.vercel.com/v13/deployments -H "Authorization: Bearer $VERCEL_TOKEN" --data-binary @payload.json',
      ].join('\n'),
    ),
    ['workflow_dynamic_http_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/script.yml',
      'steps:\n  - uses: actions/github-script@v7\n',
    ),
    ['workflow_dynamic_action_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/deploy.yml',
      'steps:\n  - uses: amondnet/vercel-action@v25\n',
    ),
    ['workflow_dynamic_action_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/gh.yml',
      'steps:\n  - run: gh api /repos/x/y/git/refs/heads/production --method PATCH -f sha=abc\n',
    ),
    ['workflow_dynamic_gh_api_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/local.yml',
      'steps:\n  - run: node scripts/deploy-production.mjs\n',
    ),
    ['workflow_dynamic_local_write_forbidden'],
  );
});

test('rejects npm scripts that can reach release or deployment writes', () => {
  assert.deepEqual(
    scanWorkflowText('.github/workflows/release-stage.yml', 'steps:\n  - run: npm run release:stage -- --tag v1.2.3\n'),
    ['workflow_npm_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/ship.yml', 'steps:\n  - run: npm run ship\n'),
    ['workflow_npm_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/release.yml', 'steps:\n  - run: npm run release:admit -- --tag v1.2.3 --hosted\n'),
    [],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/alias.yml', 'steps:\n  - run: npm run "$RELEASE_COMMAND"\n'),
    ['workflow_dynamic_npm_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/vercel.yml', 'steps:\n  - run: npm exec vercel deploy --prod\n'),
    ['workflow_vercel_production_write', 'workflow_npm_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/options.yml', 'steps:\n  - run: npm --prefix . run release:stage -- --tag v1.2.3\n'),
    ['workflow_npm_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/options2.yml', 'steps:\n  - run: npm run --silent release:stage -- --tag v1.2.3\n'),
    ['workflow_npm_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/options3.yml', 'steps:\n  - run: npm run-script release:stage -- --tag v1.2.3\n'),
    ['workflow_npm_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/alias2.yml', 'steps:\n  - run: "$TOOL" run "$SCRIPT"\n'),
    ['workflow_dynamic_npm_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/script-name.yml', 'steps:\n  - run: npm run go-live\n', {
      scripts: { 'go-live': 'vercel --prod' },
    }),
    ['workflow_npm_script_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/quoted.yml', 'steps:\n  - run: "npm" run release:stage -- --tag v1.2.3\n'),
    ['workflow_npm_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/unknown.yml', 'steps:\n  - run: npm run go-live\n', {
      scripts: { 'go-live': 'echo deploy later' },
    }),
    ['workflow_npm_script_not_allowlisted'],
  );
});
