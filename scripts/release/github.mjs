function fail(reasonCode) {
  throw new Error(reasonCode);
}

export function parseGitHubRepository(remoteUrl) {
  if (typeof remoteUrl !== 'string') fail('github_remote_invalid');
  const trimmed = remoteUrl.trim();
  const scpMatch = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
    trimmed,
  );
  if (scpMatch) return scpMatch[1];
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail('github_remote_invalid');
  }
  if (parsed.hostname !== 'github.com') fail('github_remote_invalid');
  const repository = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail('github_remote_invalid');
  }
  return repository;
}

export async function resolveGitHubRepository({ runner, repoRoot }) {
  const result = await runner('git', ['remote', 'get-url', 'origin'], {
    cwd: repoRoot,
  });
  return parseGitHubRepository(result.stdout);
}

export async function getReleaseByTag({ runner, repoRoot, tag, repository }) {
  const resolvedRepository =
    repository ?? (await resolveGitHubRepository({ runner, repoRoot }));
  const result = await runner(
    'gh',
    ['api', `/repos/${resolvedRepository}/releases/tags/${encodeURIComponent(tag)}`],
    { cwd: repoRoot },
  );
  let release;
  try {
    release = JSON.parse(result.stdout);
  } catch {
    fail('github_release_json_invalid');
  }
  if (!release || typeof release !== 'object' || !Array.isArray(release.assets)) {
    fail('github_release_shape_invalid');
  }
  return { repository: resolvedRepository, release };
}

export async function listReleaseAssets(options) {
  const { repository, release } = await getReleaseByTag(options);
  return { repository, release, assets: release.assets };
}

export async function readReleaseAssetDocument({
  runner,
  repoRoot,
  repository,
  asset,
}) {
  if (!Number.isInteger(asset?.id) || typeof asset?.name !== 'string') {
    fail('github_release_asset_invalid');
  }
  const result = await runner(
    'gh',
    [
      'api',
      `/repos/${repository}/releases/assets/${asset.id}`,
      '--header',
      'Accept: application/octet-stream',
    ],
    { cwd: repoRoot },
  );
  const raw = result.stdout;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('github_release_asset_json_invalid');
  }
  return { value, raw };
}

export async function readReleaseAssetJson(options) {
  return (await readReleaseAssetDocument(options)).value;
}

export async function readRemoteBranchSha({
  runner,
  repoRoot,
  branch = 'production',
}) {
  const result = await runner(
    'git',
    ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`],
    { cwd: repoRoot },
  );
  const line = result.stdout.trim();
  if (!line) return null;
  const [sha, ref, ...extra] = line.split(/\s+/);
  if (extra.length > 0 || ref !== `refs/heads/${branch}` || !/^[0-9a-f]{40}$/.test(sha)) {
    fail('remote_branch_shape_invalid');
  }
  return sha;
}
