import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateChecklist } from '../../scripts/ci/local-ci.mjs';

// Hosted CI (.github/workflows/ci.yml) runs this same list with `npm run ci:check`. The release script re-runs config/release-production.json
// admissionCommands before deploying, and `npm run ci` must cover at least the same commands, in the
// same order, by including them rather than copying them.
const read = file => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const raw = JSON.parse(read('config/local-ci.json'));
const { checks } = validateChecklist(raw, read);
const admission = JSON.parse(read('config/release-production.json')).admissionCommands;

test('local checklist includes every admission command instead of a copy', () => {
  assert.deepEqual(raw.include, ['admissionCommands']);
  assert.ok(admission.length > 0);
  assert.deepEqual(checks.slice(0, admission.length).map(check => check.argv), admission);
  for (const check of raw.checks) assert.ok(!admission.some(argv => argv.join(' ') === check.argv.join(' ')), check.name);
});

test('every node test suite in the repository is in the local checklist', () => {
  const globs = checks.filter(check => check.argv[0] === 'node' && check.argv[1] === '--test').flatMap(check => check.argv.slice(2));
  for (const glob of ['tests/release/contracts/*.test.mjs', 'tests/release/repository-config.test.mjs', 'tests/seo/*.test.mjs', 'tests/ci/*.test.mjs']) {
    assert.ok(globs.includes(glob), glob);
  }
});
