// config/release-production.json is the sole source of deployment identity.
import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import path from 'node:path';

const fail = (reason) => { throw new Error(reason); };
const VERCEL_HOST_RE = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.vercel\.app$/;
const ID_RE = /^[A-Za-z0-9_.-]+$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const isSafeVercelHost = (value) => typeof value === 'string' && VERCEL_HOST_RE.test(value);

try {
  const mode = process.argv[2];
  const maxArgCount = (mode === '--find-deployment' || mode === '--deployment-state' || mode === '--deployment') ? 5 : 3;
  if (process.argv.length > maxArgCount || (mode && !['--check', '--deployment', '--find-deployment', '--deployment-state'].includes(mode))) {
    fail('vercel_binding_arguments_invalid');
  }
  const config = JSON.parse(readFileSync('config/release-production.json', 'utf8')).vercel;
  if (!/^team_[A-Za-z0-9]+$/.test(config?.teamId ?? '') ||
      !/^prj_[A-Za-z0-9]+$/.test(config?.projectId ?? '') || !config?.projectName) fail('vercel_binding_config_invalid');
  for (const [key, expected] of [['VERCEL_ORG_ID', config.teamId], ['VERCEL_PROJECT_ID', config.projectId]]) {
    if (process.env[key] !== undefined && process.env[key] !== expected) fail('vercel_binding_environment_mismatch');
  }
  if (mode === '--deployment') {
    const deployment = JSON.parse(readFileSync(0, 'utf8'));
    const expectedSha = process.argv[3];
    const expectedNonce = process.argv[4];
    if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || deployment.meta?.releaseCommitSha !== expectedSha) fail('vercel_deployment_commit_mismatch');
    if (expectedNonce !== undefined && (!NONCE_RE.test(expectedNonce) || deployment.meta?.releaseUploadNonce !== expectedNonce)) fail('vercel_deployment_nonce_mismatch');
    if (deployment.projectId !== config.projectId || (deployment.ownerId ?? deployment.teamId) !== config.teamId ||
        deployment.readyState !== 'READY' || deployment.target !== 'production') fail('vercel_deployment_identity_mismatch');
    console.log(`Vercel identity verified: ${config.teamId}/${config.projectId}`);
  } else if (mode === '--deployment-state') {
    const deployment = JSON.parse(readFileSync(0, 'utf8'));
    const expectedSha = process.argv[3];
    const expectedNonce = process.argv[4];
    if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || deployment.meta?.releaseCommitSha !== expectedSha) fail('vercel_deployment_commit_mismatch');
    if (!NONCE_RE.test(expectedNonce ?? '') || deployment.meta?.releaseUploadNonce !== expectedNonce) fail('vercel_deployment_nonce_mismatch');
    if (deployment.projectId !== config.projectId || (deployment.ownerId ?? deployment.teamId) !== config.teamId ||
        deployment.target !== 'production') fail('vercel_deployment_identity_mismatch');
    if (deployment.readyState === 'READY') {
      if (!isSafeVercelHost(deployment.url)) fail('vercel_deployment_identity_mismatch');
      console.log(`READY https://${deployment.url}`);
    } else if (['BUILDING', 'INITIALIZING', 'QUEUED'].includes(deployment.readyState)) {
      if (deployment.url !== undefined && deployment.url !== null && !isSafeVercelHost(deployment.url)) fail('vercel_deployment_identity_mismatch');
      console.log('PENDING');
    } else fail('vercel_deployment_failed');
  } else if (mode === '--find-deployment') {
    const expectedSha = process.argv[3];
    const expectedNonce = process.argv[4];
    if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '') || !NONCE_RE.test(expectedNonce ?? '')) fail('vercel_binding_arguments_invalid');
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    if (!Array.isArray(payload?.deployments)) fail('vercel_deployments_shape_invalid');
    const matches = payload.deployments.filter((row) => {
      const id = row?.uid ?? row?.id;
      const owner = row?.ownerId ?? row?.teamId;
      return typeof id === 'string' && ID_RE.test(id) &&
        row?.projectId === config.projectId &&
        (owner === undefined || owner === config.teamId) &&
        row?.target === 'production' &&
        row?.meta?.releaseCommitSha === expectedSha &&
        row?.meta?.releaseUploadNonce === expectedNonce;
    }).sort((a, b) => (b.created ?? b.createdAt ?? 0) - (a.created ?? a.createdAt ?? 0));
    const ready = matches.find((row) => row.readyState === 'READY' && isSafeVercelHost(row?.url));
    const pending = matches.find((row) => ['BUILDING', 'INITIALIZING', 'QUEUED'].includes(row.readyState) && (row?.url === undefined || row?.url === null || isSafeVercelHost(row?.url)));
    if (ready) console.log(`READY ${ready.uid ?? ready.id}`);
    else if (pending) console.log(`PENDING ${pending.uid ?? pending.id}`);
    else console.log('NONE');
  } else {
    // The production entrypoint runs at the repository root, including monorepos.
    const directory = path.resolve('.vercel');
    const file = path.join(directory, 'project.json');
    for (const target of [directory, file]) {
      try { if (lstatSync(target).isSymbolicLink()) fail('vercel_binding_symlink_rejected'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    let link;
    try { link = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (mode === '--check') fail('vercel_binding_link_missing');
      mkdirSync(directory, { recursive: true });
      link = { projectId: config.projectId, orgId: config.teamId, projectName: config.projectName };
      writeFileSync(file, `${JSON.stringify(link, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    if (link.projectId !== config.projectId || link.orgId !== config.teamId) fail('vercel_binding_link_mismatch');
    console.log(`Vercel identity verified: ${config.teamId}/${config.projectId}`);
  }
} catch (error) {
  console.error(/^vercel_[a-z_]+$/.test(error.message) ? error.message : 'vercel_binding_invalid');
  process.exitCode = 1;
}
