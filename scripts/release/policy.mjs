import { createHash } from 'node:crypto';

import { hashReleaseConfig, validateReleaseConfig } from './config.mjs';

const DEFAULT_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

const WORKFLOW_RULES = [
  {
    reasonCode: 'workflow_vercel_production_write',
    pattern:
      /\bvercel\s+(?:deploy|promote|rollback|alias)\b|\bvercel\s+(?:[^\n]*\s)?--prod\b|\bvercel\s+api\b[^\n]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b/i,
  },
  {
    reasonCode: 'workflow_release_write',
    pattern:
      /\bgh\s+release\s+(?:create|upload|edit|delete)\b|\bcreateRelease\b|\.repos\.createRelease\b/i,
  },
  {
    reasonCode: 'workflow_production_ref_write',
    pattern:
      /\bgit\s+push\b[^\n]*(?:refs\/heads\/production|HEAD:production|\sproduction(?:\s|$))|\bgit\s+update-ref\b[^\n]*refs\/heads\/production/i,
  },
  {
    reasonCode: 'workflow_other_production_write',
    pattern:
      /\bgh\s+api\b[^\n]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b[^\n]*(?:vercel|git\/refs)|\bapi\.vercel\.com\b[^\n]*(?:POST|PUT|PATCH|DELETE)/i,
  },
];

const DYNAMIC_WRITE_METHOD = /(?:^|\s)(?:-X|--request|--method)\s*(?:POST|PUT|PATCH|DELETE)(?:\s|$)|(?:^|\s)(?:-d|--data|--data-raw|--data-binary|--form|--upload-file)(?:\s|$)/i;
const SENSITIVE_WORKFLOW_TOKEN = /(?:secrets\.[A-Za-z0-9_]+|GITHUB_TOKEN|GH_TOKEN|VERCEL_TOKEN)/i;
const PRODUCTION_API_HOST = /(?:api\.github\.com|api\.vercel\.com|\/repos\/[^\s]+\/(?:git\/refs|releases|deployments)|\/v\d+\/(?:projects|deployments))/i;
const DYNAMIC_HTTP_CLIENT = /\b(?:curl|wget)\b|\b(?:fetch|axios\.(?:post|put|patch|delete)|https?\.request)\s*\(/i;
const APPROVED_ACTION = /^(?:actions\/(?:checkout|setup-node|cache|upload-artifact|download-artifact)|github\/codeql-action\/(?:init|analyze|autobuild))@(?:v?[0-9]+|[0-9a-f]{40})$/i;

function fail(reasonCode) {
  throw new Error(reasonCode);
}

export function assertReleaseTag(tag, pattern = DEFAULT_TAG_PATTERN) {
  if (typeof tag !== 'string' || !pattern.test(tag)) fail('release_tag_invalid');
  return tag;
}

export function scanWorkflowText(workflowPath, text) {
  if (typeof workflowPath !== 'string' || typeof text !== 'string') {
    throw new TypeError('workflow_scan_input_invalid');
  }
  const findings = WORKFLOW_RULES.filter(({ pattern }) => pattern.test(text)).map(
    ({ reasonCode }) => reasonCode,
  );
  const normalized = text.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ');
  const uses = [...text.matchAll(/\buses:\s*['"]?([^\s'"#]+)/gi)].map((match) => match[1]);
  if (uses.some((action) => !APPROVED_ACTION.test(action))) {
    findings.push('workflow_dynamic_action_forbidden');
  }
  if (
    DYNAMIC_HTTP_CLIENT.test(normalized) &&
    SENSITIVE_WORKFLOW_TOKEN.test(normalized) &&
    (PRODUCTION_API_HOST.test(normalized) || DYNAMIC_WRITE_METHOD.test(normalized))
  ) {
    findings.push('workflow_dynamic_http_write_forbidden');
  }
  if (
    /\bgh\s+api\b/i.test(normalized) &&
    DYNAMIC_WRITE_METHOD.test(normalized) &&
    PRODUCTION_API_HOST.test(normalized)
  ) {
    findings.push('workflow_dynamic_gh_api_write_forbidden');
  }
  const unsafeLocalRunner = /\brun:\s*(?:\||>)?[\s\S]*?\b(?:node|python\d*|bash|sh|npx)\s+[^\r\n]*(?:deploy|production|promote|rollback)[^\r\n]*/i;
  if (unsafeLocalRunner.test(text)) {
    findings.push('workflow_dynamic_local_write_forbidden');
  }
  return [...new Set(findings)];
}

async function git(runner, repoRoot, args, options = {}) {
  return runner('git', args, { cwd: repoRoot, ...options });
}

function buildArtifactManifest(lsTreeOutput) {
  const entries = lsTreeOutput
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(row);
      if (!match || match[4].includes('\0')) fail('target_tree_manifest_invalid');
      return {
        mode: match[1],
        type: match[2],
        object: match[3],
        path: match[4],
      };
    });
  if (entries.length === 0) fail('target_tree_manifest_empty');
  const bytes = `${JSON.stringify(entries)}\n`;
  return {
    schemaVersion: 1,
    format: 'git-ls-tree-z-v1',
    entryCount: entries.length,
    sha256: createHash('sha256').update(bytes, 'utf8').digest('hex'),
    entries,
  };
}

export async function verifyTargetTree({ runner, repoRoot, tag, config }) {
  assertReleaseTag(tag, new RegExp(config.tagPattern));

  const dirty = await git(runner, repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty.stdout.trim()) fail('worktree_dirty');

  await git(runner, repoRoot, ['fetch', '--prune', 'origin', 'main', '--tags']);
  const targetResult = await git(runner, repoRoot, ['rev-parse', `refs/tags/${tag}^{commit}`]);
  const mainResult = await git(runner, repoRoot, ['rev-parse', 'origin/main^{commit}']);
  const targetSha = targetResult.stdout.trim();
  const mainSha = mainResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(targetSha) || !/^[0-9a-f]{40}$/.test(mainSha)) {
    fail('git_sha_invalid');
  }

  const ancestry = await git(
    runner,
    repoRoot,
    ['merge-base', '--is-ancestor', targetSha, mainSha],
    { allowExitCodes: [0, 1] },
  );
  if (ancestry.exitCode !== 0) fail('tag_not_reachable_from_main');

  const vercelConfigResult = await git(runner, repoRoot, [
    'show',
    `${targetSha}:${config.vercel.vercelJsonPath}`,
  ]);
  let vercelConfig;
  try {
    vercelConfig = JSON.parse(vercelConfigResult.stdout);
  } catch {
    fail('vercel_json_invalid');
  }
  if (vercelConfig?.git?.deploymentEnabled !== false) {
    fail('vercel_git_deployment_not_disabled');
  }
  const releaseConfigResult = await git(runner, repoRoot, [
    'show',
    `${targetSha}:config/release-production.json`,
  ]);
  let targetReleaseConfig;
  try {
    targetReleaseConfig = validateReleaseConfig(JSON.parse(releaseConfigResult.stdout));
  } catch (error) {
    if (/^[a-z0-9_:-]+$/.test(error?.message ?? '')) throw error;
    fail('target_release_config_invalid');
  }
  if (hashReleaseConfig(targetReleaseConfig) !== hashReleaseConfig(config)) {
    fail('target_release_config_mismatch');
  }

  const tree = await git(runner, repoRoot, ['ls-tree', '-rz', '--full-tree', targetSha]);
  const artifactManifest = buildArtifactManifest(tree.stdout);
  const workflowPaths = artifactManifest.entries
    .map((entry) => entry.path)
    .filter((entry) => /^\.github\/workflows\/.*\.ya?ml$/.test(entry))
    .sort();
  const workflowFindings = [];
  for (const workflowPath of workflowPaths) {
    const workflow = await git(runner, repoRoot, ['show', `${targetSha}:${workflowPath}`]);
    for (const reasonCode of scanWorkflowText(workflowPath, workflow.stdout)) {
      workflowFindings.push({ path: workflowPath, reasonCode });
    }
  }
  if (workflowFindings.length > 0) {
    const error = new Error('workflow_production_write_forbidden');
    error.findings = workflowFindings;
    throw error;
  }

  return {
    tag,
    targetSha,
    mainSha,
    vercelJsonPath: config.vercel.vercelJsonPath,
    workflowPaths,
    artifactManifest,
  };
}
