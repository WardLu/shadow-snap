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

test('rejects writable workflow permissions and npm lifecycle hooks', () => {
  assert.ok(
    scanWorkflowText(
      '.github/workflows/unsafe.yml',
      'permissions:\n  contents: write\nsteps:\n  - run: npm ci\n',
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/unsafe-quoted-permission.yml',
      'permissions:\n  contents: "write"\n  statuses: write\nsteps:\n  - run: npm ci\n',
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/unsafe-install.yml',
      'steps:\n  - run: npm ci\n',
    ).includes('workflow_npm_lifecycle_forbidden'),
  );
  for (const command of ['npm ci --ignore-scripts=false', 'npm --ignore-scripts=false ci']) {
    assert.ok(
      scanWorkflowText('.github/workflows/unsafe-ignore-value.yml', `steps:\n  - run: ${command}\n`).includes(
        'workflow_npm_lifecycle_forbidden',
      ),
    );
  }
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/safe-install.yml',
      'permissions:\n  contents: read\nsteps:\n  - run: npm ci --ignore-scripts\n',
    ),
    [],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/safe-install-global-option.yml',
      'steps:\n  - run: npm --ignore-scripts ci\n',
    ),
    [],
  );
});

test('rejects YAML permission aliases and requires explicit permissions in enforced scans', () => {
  assert.ok(
    scanWorkflowText(
      '.github/workflows/alias-permission.yml',
      [
        'x-write: &write_mode write',
        'permissions:',
        '  contents: read',
        '  actions: read',
        'jobs:',
        '  admission:',
        '    permissions:',
        '      contents: *write_mode',
      ].join('\n'),
    ).includes('workflow_yaml_alias_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/no-permissions.yml',
      'steps:\n  - run: echo ok\n',
      { requireExplicitPermissions: true },
    ).includes('workflow_permissions_missing'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/mixed-permissions.yml',
      [
        'jobs:',
        '  safe:',
        '    permissions:',
        '      contents: read',
        '    steps:',
        '      - run: echo safe',
        '  inherited:',
        '    steps:',
        '      - run: echo default',
      ].join('\n'),
      { requireExplicitPermissions: true },
    ).includes('workflow_permissions_missing'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/non-ascii-alias.yml',
      ['permissions:', '  contents: *写'].join('\n'),
    ).includes('workflow_yaml_alias_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/quoted-permission-key.yml',
      ['permissions: {"contents": write}'].join('\n'),
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/tagged-permission.yml',
      ['permissions:', '  contents: !!str write'].join('\n'),
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/quoted-permissions-key.yml',
      [
        'permissions:',
        '  contents: read',
        'jobs:',
        '  deploy:',
        '    "permissions": {contents: write}',
      ].join('\n'),
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/tagged-permissions-key.yml',
      [
        'permissions:',
        '  contents: read',
        'jobs:',
        '  deploy:',
        '    !!str permissions:',
        '      contents: write',
      ].join('\n'),
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/escaped-permissions-key.yml',
      [
        'permissions:',
        '  contents: read',
        'jobs:',
        '  deploy:',
        '    "permis\\u0073ions":',
        '      contents: write',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/flow-permissions-key.yml',
      [
        'permissions: {contents: read, actions: read}',
        'jobs:',
        '  deploy: {permissions: {contents: write}, steps: []}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/inline-permissions.yml',
      'permissions: {contents: read, actions: read}\njobs:\n  test:\n    steps: []',
      { requireExplicitPermissions: true },
    ),
    [],
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/complex-permissions-key.yml',
      [
        'permissions:',
        '  contents: read',
        'jobs:',
        '  deploy:',
        '    ? permissions',
        '    : {contents: write}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/escaped-complex-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy:',
        '    ? "permis\\u0073ions"',
        '    : {contents: write}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/run-job-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  run: {permissions: {contents: write}, runs-on: ubuntu-latest, steps: []}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/steps-job-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  steps: {permissions: {contents: write}, runs-on: ubuntu-latest, steps: []}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/steps-job-complex-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  steps:',
        '    ? "permis\\u0073ions"',
        '    : {contents: write}',
        '    runs-on: ubuntu-latest',
        '    steps: []',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/steps-job-complex-permissions-key-blank.yml',
      [
        'permissions: {contents: read, actions: read}',
        'jobs:',
        '',
        '  steps:',
        '    ? permissions',
        '    : {contents: write}',
        '    runs-on: ubuntu-latest',
        '    steps: []',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/tagged-jobs-key.yml',
      [
        'permissions: {contents: read, actions: read}',
        '!!str jobs:',
        '  steps:',
        '    ? permissions',
        '    : {contents: write}',
        '    runs-on: ubuntu-latest',
        '    steps: []',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/tagged-jobs-value.yml',
      [
        'permissions: {contents: read}',
        'jobs: !!map',
        '  steps:',
        '    ? permissions',
        '    : {contents: write}',
        '    runs-on: ubuntu-latest',
        '    steps: []',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/bare-tag-jobs-key.yml',
      [
        'permissions: {contents: read}',
        '! jobs:',
        '  steps:',
        '    ? permissions',
        '    : {contents: write}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/complex-jobs-key.yml',
      [
        'permissions: {contents: read}',
        '? jobs',
        ':',
        '  steps:',
        '    ? permissions',
        '    : {contents: write}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/multiline-escaped-complex-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy:',
        '    ? "permis\\',
        '      sions"',
        '    : {contents: write}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/bare-tag-complex-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy:',
        '    ? ! permissions',
        '    : {contents: write}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/bare-tag-flow-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy: {! permissions: {contents: write}, steps: []}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/complex-flow-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy: {? permissions: {contents: write}, steps: []}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/tagged-complex-flow-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy: {? ! permissions: {contents: write}, steps: []}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/multiline-escaped-complex-flow-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy: {? "permis\\',
        '      sions": {contents: write}, steps: []}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/split-complex-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy:',
        '    ?',
        '      permissions',
        '    : {contents: write}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/split-tagged-complex-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy:',
        '    ? !!str',
        '      permissions',
        '    : {contents: write}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/split-flow-complex-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy: {?',
        '      permissions',
        '    : {contents: write}, steps: []}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/split-tagged-flow-complex-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy: {? !!str',
        '      permissions',
        '    : {contents: write}, steps: []}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/query-parameter.yml',
      [
        'permissions:',
        '  contents: read',
        'jobs:',
        '  test:',
        '    steps:',
        '      - run: curl "https://example.test/?a=1&b=2"',
      ].join('\n'),
      { requireExplicitPermissions: true },
    ),
    [],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/permission-text.yml',
      [
        'permissions:',
        '  contents: read',
        'jobs:',
        '  test:',
        '    steps:',
        '      - run: |',
        '          echo "contents: write"',
        '      - run: echo "permissions: write-all"',
        '      - run: |-2',
        '        *glob',
      ].join('\n'),
      { requireExplicitPermissions: true },
    ),
    [],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/permission-like-strings.yml',
      [
        'permissions: {contents: read}',
        'env:',
        '  MESSAGE: "{permissions: write}"',
        'with: {name: "{permissions: write}", path: out}',
      ].join('\n'),
      { requireExplicitPermissions: true },
    ),
    [],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/multiline-permission-like-strings.yml',
      [
        'permissions: {contents: read}',
        'env:',
        '  MESSAGE: "literal {? !!str',
        '    next"',
        'with:',
        "  VALUE: 'literal ,? !",
        "    next'",
      ].join('\n'),
      { requireExplicitPermissions: true },
    ),
    [],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/multiline-continuation-permission-like-strings.yml',
      [
        'permissions: {contents: read}',
        'env:',
        '  MESSAGE: "first',
        '    ?',
        '    next"',
        "  OTHER: 'first",
        '    ,? !',
        "    next'",
        '  PERMISSION_TEXT: "first',
        '    permissions: write',
        '    next"',
        '  ALIAS_TEXT: "first',
        '    *harmless &harmless',
        '    next"',
      ].join('\n'),
      { requireExplicitPermissions: true },
    ),
    [],
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/closing-quote-permissions-key.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  deploy: {env: {MESSAGE: "first',
        '    next"}, permissions: {contents: write}, steps: []}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/plain-apostrophe-permissions-key.yml',
      [
        'permissions: {contents: read, actions: read}',
        'env:',
        "  MESSAGE: don't stop",
        'jobs:',
        '  deploy:',
        '    permissions: {contents: write}',
        '    steps: []',
      ].join('\n'),
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/plain-comma-quote-permissions-key.yml',
      [
        'permissions: {contents: read, actions: read}',
        'env:',
        '  MESSAGE: hello, "world',
        'jobs:',
        '  deploy:',
        '    permissions: {contents: write}',
        '    steps: []',
      ].join('\n'),
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/plain-brace-comma-quote-permissions-key.yml',
      [
        'permissions: {contents: read, actions: read}',
        'env:',
        '  MESSAGE: hello {, "world',
        'jobs:',
        '  deploy:',
        '    permissions: {contents: write}',
        '    steps: []',
      ].join('\n'),
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/plain-question-quote-permissions-key.yml',
      [
        'permissions: {contents: read, actions: read}',
        'env:',
        '  MESSAGE: why? "world',
        'jobs:',
        '  deploy:',
        '    permissions: {contents: write}',
        '    steps: []',
      ].join('\n'),
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/plain-spaced-question-quote-permissions-key.yml',
      [
        'permissions: {contents: read, actions: read}',
        'env:',
        '  MESSAGE: why ? "world',
        'jobs:',
        '  deploy:',
        '    permissions: {contents: write}',
        '    steps: []',
      ].join('\n'),
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/plain-indicator-text-permissions-key.yml',
      [
        'permissions: {contents: read, actions: read}',
        'env:',
        '  HTTP: http:"world',
        '  QUESTION: foo:? "world',
        '  BRACKET: foo[? "world',
        '  BRACE: foo{ "world',
        'jobs:',
        '  deploy:',
        '    permissions: {contents: write}',
        '    steps: []',
      ].join('\n'),
    ).includes('workflow_permission_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/multiline-flow-permissions-key.yml',
      [
        'permissions: {contents: read, actions: read}',
        'jobs:',
        '  deploy: {',
        '    runs-on: ubuntu-latest, "permissions": {contents: write}, steps: []',
        '  }',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/quoted-block-marker-permissions-key.yml',
      [
        'permissions: {contents: read, actions: read}',
        'env:',
        '  MESSAGE: "first',
        '    key: |',
        '      next"',
        'jobs:',
        '  deploy:',
        '    ? permissions',
        '    : {contents: write}',
      ].join('\n'),
    ).includes('workflow_permission_structure_forbidden'),
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/named-step-permission-like-string.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  test:',
        '    steps:',
        '      - name: Demo',
        '        run: echo {permissions: write}',
      ].join('\n'),
      { requireExplicitPermissions: true },
    ),
    [],
  );
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/named-step-permission-like-string-blank.yml',
      [
        'permissions: {contents: read}',
        'jobs:',
        '  test:',
        '    steps:',
        '',
        '      - name: Demo',
        '        run: echo {permissions: write}',
      ].join('\n'),
      { requireExplicitPermissions: true },
    ),
    [],
  );
});

test('does not reject the read-only admission workflow', () => {
  const text = [
    'permissions:',
    '  contents: read',
    '  actions: read',
    'steps:',
    "  - run: node scripts/release/cli.mjs admit --tag '$GITHUB_REF_NAME' --hosted",
  ].join('\n');

  assert.deepEqual(
    scanWorkflowText('.github/workflows/release.yml', text),
    [],
  );
});

test('requires release permissions at workflow level', () => {
  const jobOnly = [
    'jobs:',
    '  admission:',
    '    permissions:',
    '      contents: read',
    '      actions: read',
    '    steps:',
    '      - run: echo safe',
  ].join('\n');

  assert.ok(
    scanWorkflowText('.github/workflows/release.yml', jobOnly).includes(
      'workflow_permissions_missing_or_not_readonly',
    ),
  );
});

test('rejects release creation and production ref updates', () => {
  assert.deepEqual(
    scanWorkflowText(
      '.github/workflows/release.yml',
      'permissions:\n  contents: read\n  actions: read\nsteps:\n  - run: gh release create v1.2.3',
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
    scanWorkflowText('.github/workflows/release.yml', 'permissions:\n  contents: read\n  actions: read\nsteps:\n  - run: node scripts/release/cli.mjs admit --tag v1.2.3 --hosted\n'),
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
  for (const command of [
    'npm --prefix . --silent run release:stage',
    'npm --workspace foo --silent run release:stage',
    'npm --workspaces run release:stage',
    'npm -w foo run release:stage',
    'npm --prefix=. run release:stage',
    'npm --loglevel silly run release:stage',
    'npm --cache /tmp/cache --prefix . run release:stage',
    'npm -p run release:stage',
    '/usr/bin/npm run release:stage',
    'npm run --if-present --silent release:stage',
  ]) {
    assert.deepEqual(
      scanWorkflowText('.github/workflows/options-combined.yml', `steps:\n  - run: ${command}\n`),
      ['workflow_npm_write_forbidden'],
    );
  }
  assert.ok(
    scanWorkflowText(
      '.github/workflows/unknown-option.yml',
      'steps:\n  - run: npm --unknown value run release:stage\n',
    ).includes('workflow_npm_option_forbidden'),
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/npm-alias.yml', 'steps:\n  - run: /usr/bin/npm run release:stage\n'),
    ['workflow_npm_write_forbidden'],
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/dynamic-npm.yml',
      'steps:\n  - run: NPM=$(command -v npm); "$NPM" run "$SCRIPT"\n',
    ).includes('workflow_dynamic_npm_write_forbidden'),
  );
  assert.ok(
    scanWorkflowText(
      '.github/workflows/dynamic-npm-options.yml',
      'steps:\n  - run: "$NPM" --silent run release:stage\n',
    ).includes('workflow_dynamic_npm_write_forbidden'),
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
  assert.deepEqual(
    scanWorkflowText('.github/workflows/indirect.yml', 'steps:\n  - run: npm run test\n', {
      scripts: { test: 'npm run "$SCRIPT"' },
    }),
    ['workflow_npm_script_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/local-file.yml', 'steps:\n  - run: npm run build\n', {
      scripts: { build: 'node scripts/go.mjs' },
    }),
    ['workflow_npm_script_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/local-file-go.yml', 'steps:\n  - run: npm run test\n', {
      scripts: { test: 'go run cmd/release.go' },
    }),
    ['workflow_npm_script_write_forbidden'],
  );
  assert.deepEqual(
    scanWorkflowText('.github/workflows/entrypoint-chain.yml', 'steps:\n  - run: npm run release:admit\n', {
      scripts: { 'release:admit': 'node scripts/release/cli.mjs admit && npm run release:stage' },
    }),
    ['workflow_npm_script_write_forbidden'],
  );
  for (const command of ['make deploy', 'firebase deploy', 'wrangler deploy']) {
    assert.deepEqual(
      scanWorkflowText('.github/workflows/runner.yml', 'steps:\n  - run: npm run release:admit\n', {
        scripts: { 'release:admit': command },
      }),
      ['workflow_npm_script_not_allowlisted'],
    );
  }
});
