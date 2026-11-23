#!/usr/bin/env node
// Release parameters live only in config/release-production.json. This module validates them
// fail-closed and is the single reader for deploy-production.sh (`get <key>`) and Node scripts.
//
//   node scripts/release/release-config.mjs check
//   node scripts/release/release-config.mjs get <key>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_PATH = 'config/release-production.json';

const fail = (reason) => { throw new Error(reason); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.length > 0;
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const HEADER = /^[a-z0-9-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

export function validateReleaseConfig(config) {
  if (!isObject(config)) fail('release_config_invalid');
  if (!isText(config.productionBranch) || !BRANCH.test(config.productionBranch)) fail('release_config_branch_invalid');

  const vercel = config.vercel;
  if (!isObject(vercel)) fail('release_config_vercel_missing');
  if (!/^team_[A-Za-z0-9]+$/.test(vercel.teamId ?? '')) fail('release_config_team_invalid');
  if (!/^prj_[A-Za-z0-9]+$/.test(vercel.projectId ?? '')) fail('release_config_project_invalid');
  if (!isText(vercel.projectName)) fail('release_config_project_name_invalid');
  // No domains means nothing can be verified after promote, so the release must not start.
  if (!Array.isArray(vercel.productionDomains) || vercel.productionDomains.length === 0) fail('release_config_domains_missing');
  if (!vercel.productionDomains.every((domain) => typeof domain === 'string' && HOSTNAME.test(domain))) fail('release_config_domain_invalid');

  const acceptance = config.acceptance;
  if (!isObject(acceptance)) fail('release_config_acceptance_missing');
  // Shadow Snap derives its byte-for-byte manifest from the page graph
  // (scripts/seo/site-artifact-manifest.mjs), so verifyFiles is not configured here.
  if (acceptance.verifyFiles !== undefined) fail('release_config_verify_files_unsupported');
  if (acceptance.path !== undefined && (!isText(acceptance.path) || !acceptance.path.startsWith('/') || /\s/.test(acceptance.path))) {
    fail('release_config_acceptance_path_invalid');
  }
  if (acceptance.bodyIncludes !== undefined && !isText(acceptance.bodyIncludes)) fail('release_config_body_includes_invalid');
  if (acceptance.requiredHeaders !== undefined &&
      (!Array.isArray(acceptance.requiredHeaders) || !acceptance.requiredHeaders.every((name) => typeof name === 'string' && HEADER.test(name)))) {
    fail('release_config_headers_invalid');
  }
  if (acceptance.maxSeconds !== undefined && (!Number.isInteger(acceptance.maxSeconds) || acceptance.maxSeconds <= 0)) fail('release_config_max_seconds_invalid');

  const commands = config.admissionCommands ?? [];
  if (!Array.isArray(commands) || !commands.every((argv) => Array.isArray(argv) && argv.length > 0 && argv.every(isText))) {
    fail('release_config_admission_invalid');
  }
  if (config.matrixBroadcast !== undefined && typeof config.matrixBroadcast !== 'boolean') fail('release_config_matrix_broadcast_invalid');
  return config;
}

export function loadReleaseConfig(root = process.cwd()) {
  let text;
  try { text = readFileSync(path.join(root, CONFIG_PATH), 'utf8'); } catch { fail('release_config_missing'); }
  let config;
  try { config = JSON.parse(text); } catch { fail('release_config_json_invalid'); }
  return validateReleaseConfig(config);
}

// Values printed for the shell: lists are one item per line.
const GETTERS = {
  productionBranch: (config) => config.productionBranch,
  'vercel.teamId': (config) => config.vercel.teamId,
  'vercel.projectId': (config) => config.vercel.projectId,
  'vercel.projectName': (config) => config.vercel.projectName,
  'vercel.productionDomains': (config) => config.vercel.productionDomains.join('\n'),
  'acceptance.path': (config) => config.acceptance.path ?? '/',
  'acceptance.bodyIncludes': (config) => config.acceptance.bodyIncludes ?? '',
  'acceptance.requiredHeaders': (config) => (config.acceptance.requiredHeaders ?? []).join('\n'),
  'acceptance.maxSeconds': (config) => String(config.acceptance.maxSeconds ?? 30),
  matrixBroadcast: (config) => String(config.matrixBroadcast === true),
};

export function readValue(config, key) {
  const getter = GETTERS[key];
  if (!getter) fail('release_config_key_unknown');
  return getter(config);
}

function main([command, key, ...rest]) {
  const config = loadReleaseConfig();
  if (command === 'check' && key === undefined) return;
  if (command === 'get' && key !== undefined && rest.length === 0) {
    process.stdout.write(`${readValue(config, key)}\n`);
    return;
  }
  fail('release_config_arguments_invalid');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(/^release_config_[a-z_]+$/.test(error.message) ? error.message : 'release_config_invalid');
    process.exitCode = 1;
  }
}
