import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

function fail(reasonCode) {
  throw new Error(reasonCode);
}

function parseJson(text, reasonCode) {
  try {
    return JSON.parse(text);
  } catch {
    fail(reasonCode);
  }
}

function vercelEnv(config) {
  return {
    VERCEL_ORG_ID: config.vercel.teamId,
    VERCEL_PROJECT_ID: config.vercel.projectId,
  };
}

export async function verifyVercelCliVersion({ runner, repoRoot, config }) {
  const result = await runner('vercel', ['--version'], { cwd: repoRoot });
  const versions = `${result.stdout}\n${result.stderr ?? ''}`.match(/[0-9]+\.[0-9]+\.[0-9]+/g) ?? [];
  const actual = versions.at(-1) ?? null;
  if (actual !== config.vercel.cliVersion) fail('vercel_cli_version_mismatch');
  return actual;
}

function normalizeRootDirectory(value) {
  return value === undefined || value === '' ? null : value;
}

function assertDeploymentUrl(value) {
  if (typeof value !== 'string') fail('vercel_deployment_url_invalid');
  let parsed;
  try {
    parsed = new URL(value.startsWith('https://') ? value : `https://${value}`);
  } catch {
    fail('vercel_deployment_url_invalid');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.vercel.app')) {
    fail('vercel_deployment_url_invalid');
  }
  return parsed.href;
}

function parseAcceptanceOutput(output, config, reasonPrefix, allowedHosts) {
  const marker = /\nSHADOW_ACCEPTANCE_META:(\d{3})\t([^\t\n]+)\t(\d+)\s*$/.exec(output);
  if (!marker || marker[1] !== '200') {
    fail(`${reasonPrefix}_http_status_invalid`);
  }
  let effectiveUrl;
  try {
    effectiveUrl = new URL(marker[2]);
  } catch {
    fail(`${reasonPrefix}_effective_url_invalid`);
  }
  if (
    effectiveUrl.protocol !== 'https:' ||
    marker[3] !== '0' ||
    !allowedHosts.includes(effectiveUrl.hostname)
  ) fail(`${reasonPrefix}_effective_url_invalid`);
  for (const header of config.acceptance.requiredHeaders) {
    if (!(new RegExp(`(?:^|\\r?\\n)${header}:`, 'i')).test(output)) {
      fail(`${reasonPrefix}_required_header_missing:${header}`);
    }
  }
  if (!output.includes(config.acceptance.bodyIncludes)) {
    fail(`${reasonPrefix}_body_marker_missing`);
  }
  return {
    path: config.acceptance.path,
    bodyMarkerSha256: createHash('sha256')
      .update(config.acceptance.bodyIncludes, 'utf8')
      .digest('hex'),
    responseSha256: createHash('sha256').update(output, 'utf8').digest('hex'),
    responseBytes: Buffer.byteLength(output),
    effectiveUrl: effectiveUrl.href,
  };
}

export async function runStagedAcceptance({
  runner,
  repoRoot,
  config,
  deploymentUrl,
}) {
  await verifyVercelCliVersion({ runner, repoRoot, config });
  const normalizedUrl = assertDeploymentUrl(deploymentUrl);
  const result = await runner(
    'vercel',
    [
      'curl',
      config.acceptance.path,
      '--deployment',
      normalizedUrl,
      '--yes',
      '--',
      '--fail-with-body',
      '--silent',
      '--show-error',
      '--dump-header',
      '-',
      '--max-time',
      String(config.acceptance.maxSeconds),
      '--write-out',
      '\nSHADOW_ACCEPTANCE_META:%{http_code}\t%{url_effective}\t%{ssl_verify_result}\n',
    ],
    { cwd: repoRoot, env: vercelEnv(config) },
  );
  return {
    kind: 'staged',
    deploymentUrl: normalizedUrl,
    ...parseAcceptanceOutput(
      result.stdout,
      config,
      'staged_acceptance',
      [new URL(normalizedUrl).hostname],
    ),
  };
}

export async function runProductionAcceptance({ runner, repoRoot, config }) {
  const results = [];
  for (const domain of config.vercel.productionDomains) {
    const url = `https://${domain}${config.acceptance.path}`;
    const result = await runner(
      'curl',
      [
        '--fail-with-body',
        '--silent',
        '--show-error',
        '--location',
        '--dump-header',
        '-',
        '--max-time',
        String(config.acceptance.maxSeconds),
        '--write-out',
        '\nSHADOW_ACCEPTANCE_META:%{http_code}\t%{url_effective}\t%{ssl_verify_result}\n',
        url,
      ],
      { cwd: repoRoot },
    );
    results.push({
      domain,
      url,
      ...parseAcceptanceOutput(
        result.stdout,
        config,
        'production_acceptance',
        config.vercel.productionDomains,
      ),
    });
  }
  return { kind: 'production', domains: results };
}

export function validateVercelProjectFacts({
  project,
  config,
  requireReleaseSettings = true,
}) {
  if (!project || typeof project !== 'object') fail('vercel_project_shape_invalid');
  if (project.id !== config.vercel.projectId) fail('vercel_project_id_mismatch');
  if (project.name !== config.vercel.projectName) fail('vercel_project_name_mismatch');
  if (normalizeRootDirectory(project.rootDirectory) !== config.vercel.rootDirectory) {
    fail('vercel_project_root_directory_mismatch');
  }
  if (requireReleaseSettings) {
    if (project.link?.productionBranch !== config.vercel.productionBranch) {
      fail('vercel_production_branch_mismatch');
    }
    if (project.autoAssignCustomDomains !== config.vercel.autoAssignCustomDomains) {
      fail('vercel_auto_assign_mismatch');
    }
  }
  if (!Array.isArray(project.domains)) fail('vercel_domain_shape_invalid');
  for (const domain of config.vercel.productionDomains) {
    if (!project.domains.includes(domain)) fail('vercel_domain_allowlist_mismatch');
  }
  return {
    id: project.id,
    name: project.name,
    rootDirectory: normalizeRootDirectory(project.rootDirectory),
    productionBranch: project.link?.productionBranch ?? null,
    autoAssignCustomDomains: project.autoAssignCustomDomains,
    domains: [...project.domains],
    current: project.targets?.production ?? null,
  };
}

export async function readVercelProjectFacts({
  runner,
  repoRoot,
  config,
  requireReleaseSettings = true,
}) {
  const projectResult = await runner(
    'vercel',
    [
      'api',
      `/v9/projects/${config.vercel.projectId}?teamId=${config.vercel.teamId}`,
      '--raw',
    ],
    { cwd: repoRoot, env: vercelEnv(config) },
  );
  const domainsResult = await runner(
    'vercel',
    [
      'api',
      `/v9/projects/${config.vercel.projectId}/domains?teamId=${config.vercel.teamId}`,
      '--raw',
    ],
    { cwd: repoRoot, env: vercelEnv(config) },
  );
  const project = parseJson(projectResult.stdout, 'vercel_project_json_invalid');
  const domainsPayload = parseJson(domainsResult.stdout, 'vercel_domains_json_invalid');
  const domainRows = Array.isArray(domainsPayload)
    ? domainsPayload
    : domainsPayload.domains;
  if (!Array.isArray(domainRows)) fail('vercel_domains_shape_invalid');
  project.domains = domainRows.map((row) => (typeof row === 'string' ? row : row.name));
  return validateVercelProjectFacts({ project, config, requireReleaseSettings });
}

export async function inspectDeployment({ runner, repoRoot, config, deploymentId }) {
  let identifier = deploymentId;
  const isId = /^dpl_[A-Za-z0-9]+$/.test(identifier ?? '');
  if (!isId) {
    const normalized = assertDeploymentUrl(identifier);
    identifier = new URL(normalized).hostname;
  }
  const result = await runner(
    'vercel',
    [
      'api',
      `/v13/deployments/${encodeURIComponent(identifier)}?teamId=${config.vercel.teamId}`,
      '--raw',
    ],
    { cwd: repoRoot, env: vercelEnv(config) },
  );
  const deployment = parseJson(result.stdout, 'vercel_deployment_json_invalid');
  if (isId && deployment.id !== deploymentId) fail('vercel_deployment_id_mismatch');
  if (deployment.projectId !== config.vercel.projectId) {
    fail('vercel_deployment_project_mismatch');
  }
  return deployment;
}

export async function listMatchingStagedDeployments({
  runner,
  repoRoot,
  config,
  targetSha,
  tag,
  configHash,
}) {
  const result = await runner(
    'vercel',
    [
      'api',
      `/v6/deployments?projectId=${config.vercel.projectId}&teamId=${config.vercel.teamId}&limit=100&target=production`,
      '--raw',
    ],
    { cwd: repoRoot, env: vercelEnv(config) },
  );
  const payload = parseJson(result.stdout, 'vercel_deployments_json_invalid');
  if (!Array.isArray(payload.deployments)) fail('vercel_deployments_shape_invalid');
  return payload.deployments
    .filter(
      (deployment) =>
        deployment.projectId === config.vercel.projectId &&
        deployment.meta?.releaseCommitSha === targetSha &&
        deployment.meta?.releaseTag === tag &&
        deployment.meta?.releaseConfigHash === configHash &&
        (deployment.readyState ?? deployment.state) === 'READY',
    )
    .map((deployment) => ({
      id: deployment.uid ?? deployment.id,
      url: deployment.url,
      readyState: deployment.readyState ?? deployment.state,
    }));
}

export async function createStagedDeployment({
  runner,
  repoRoot,
  config,
  targetSha,
  tag,
  configHash,
  tempRoot,
}) {
  await verifyVercelCliVersion({ runner, repoRoot, config });
  if (!/^[0-9a-f]{40}$/.test(targetSha ?? '')) fail('staged_target_sha_invalid');
  if (!(new RegExp(config.tagPattern)).test(tag ?? '')) fail('staged_tag_invalid');
  if (!/^[0-9a-f]{64}$/.test(configHash ?? '')) fail('staged_config_hash_invalid');

  const temporaryParent = await mkdtemp(path.join(tempRoot, 'shadow-release-stage-'));
  const checkout = path.join(temporaryParent, 'checkout');
  let worktreeRegistered = false;
  try {
    await runner(
      'git',
      ['worktree', 'add', '--detach', checkout, targetSha],
      { cwd: repoRoot },
    );
    worktreeRegistered = true;
    const projectCwd = path.resolve(checkout, config.vercel.projectRoot);
    const projectStats = await stat(projectCwd).catch(() => null);
    if (!projectStats?.isDirectory()) fail('vercel_project_root_missing');
    const linkDirectory = path.join(projectCwd, '.vercel');
    await mkdir(linkDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(linkDirectory, 'project.json'),
      `${JSON.stringify({
        orgId: config.vercel.teamId,
        projectId: config.vercel.projectId,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const env = vercelEnv(config);
    await runner(
      'vercel',
      ['pull', '--yes', '--environment=production'],
      { cwd: projectCwd, env },
    );
    await runner('vercel', ['build', '--prod'], { cwd: projectCwd, env });
    const deployResult = await runner(
      'vercel',
      [
        'deploy',
        '--prebuilt',
        '--prod',
        '--skip-domain',
        '--yes',
        '--format=json',
        '--meta',
        `releaseCommitSha=${targetSha}`,
        '--meta',
        `releaseTag=${tag}`,
        '--meta',
        `releaseConfigHash=${configHash}`,
      ],
      { cwd: projectCwd, env },
    );
    const created = parseJson(deployResult.stdout, 'vercel_deploy_output_invalid');
    const deployment = await inspectDeployment({
      runner,
      repoRoot: projectCwd,
      config,
      deploymentId: created.id,
    });
    if (
      deployment.target !== 'production' ||
      deployment.readyState !== 'READY' ||
      deployment.meta?.releaseCommitSha !== targetSha ||
      deployment.meta?.releaseTag !== tag ||
      deployment.meta?.releaseConfigHash !== configHash
    ) {
      fail('staged_deployment_identity_mismatch');
    }
    const createdUrl = created.url ?? deployment.url;
    assertDeploymentUrl(createdUrl);
    return {
      id: deployment.id,
      url: createdUrl,
      projectId: deployment.projectId,
      target: deployment.target,
      readyState: deployment.readyState,
      meta: deployment.meta,
    };
  } finally {
    if (worktreeRegistered) {
      await runner('git', ['worktree', 'remove', '--force', checkout], {
        cwd: repoRoot,
      });
    }
    await rm(temporaryParent, { recursive: true, force: true });
  }
}

export async function promoteDeployment({
  runner,
  repoRoot,
  config,
  deploymentUrl,
}) {
  await verifyVercelCliVersion({ runner, repoRoot, config });
  const normalizedUrl = assertDeploymentUrl(deploymentUrl);
  await runner('vercel', ['promote', normalizedUrl, '--yes'], {
    cwd: repoRoot,
    env: vercelEnv(config),
  });
}

export async function rollbackDeployment({
  runner,
  repoRoot,
  config,
  deploymentUrl,
}) {
  await verifyVercelCliVersion({ runner, repoRoot, config });
  const normalizedUrl = assertDeploymentUrl(deploymentUrl);
  await runner('vercel', ['rollback', normalizedUrl, '--yes'], {
    cwd: repoRoot,
    env: vercelEnv(config),
  });
}

export async function restoreAutoAssignSetting({ runner, repoRoot, config }) {
  await verifyVercelCliVersion({ runner, repoRoot, config });
  await runner(
    'vercel',
    [
      'api',
      `/v9/projects/${config.vercel.projectId}?teamId=${config.vercel.teamId}`,
      '--method',
      'PATCH',
      '--field',
      'autoAssignCustomDomains=false',
      '--raw',
    ],
    { cwd: repoRoot, env: vercelEnv(config) },
  );
}
