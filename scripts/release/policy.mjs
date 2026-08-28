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
const SAFE_NPM_SCRIPTS = new Set(['release:admit']);

// A workflow may only reach a local executable through an explicitly reviewed
// read-only entrypoint.  Merely allowlisting the npm script name is not enough:
// a package.json change such as `test: "npm run \"$SCRIPT\""` or
// `build: "node scripts/go.mjs"` would otherwise move the production write
// behind an unreviewed file.
const EXACT_READ_ONLY_SCRIPT_COMMANDS = new Map([
  ['release:admit', /^node\s+scripts\/release\/cli\.mjs\s+admit\s*$/],
]);

const NPM_OPTIONS_WITH_VALUE = new Set([
  '--prefix',
  '--workspace',
  '--cache',
  '--registry',
  '--loglevel',
  '--userconfig',
  '--location',
  '--audit-level',
  '--omit',
  '--include',
  '--install-strategy',
  '-w',
  '-C',
]);
const NPM_OPTIONS_WITHOUT_VALUE = new Set([
  '--silent',
  '--quiet',
  '--yes',
  '--global',
  '--if-present',
  '--dry-run',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--no-bin-links',
  '--package-lock-only',
  '--workspaces',
  '--include-workspace-root',
  '--parseable',
  '--progress',
  '--json',
  '-s',
  '-q',
  '-p',
]);
const LOCAL_SCRIPT_PATH = /(?:^|\s)(?:\.{1,2}\/|scripts\/|node_modules\/|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.(?:mjs|cjs|js|ts|tsx|py|sh|bash|zsh|rb|pl|go))(?=\s|$)/i;
function tokenizeShell(text) {
  const tokens = [];
  let value = '';
  let quote = null;
  let escaped = false;
  let started = false;
  const push = () => {
    if (!started) return;
    tokens.push({ value, dynamic: /\$|`/.test(value) });
    value = '';
    started = false;
  };

  for (const character of text) {
    if (escaped) {
      value += character;
      escaped = false;
      started = true;
      continue;
    }
    if (quote && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        value += character;
      }
      started = true;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      started = true;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    value += character;
    started = true;
  }
  if (escaped) value += '\\';
  push();
  return tokens;
}

function isNpmOption(token) {
  return token?.startsWith('--') || /^-[A-Za-z]/.test(token ?? '');
}

function isNpmExecutable(token) {
  const normalized = (token ?? '').replace(/[;,]$/, '');
  return normalized === 'npm' || /(?:^|\/)npm(?:-cli\.js)?$/.test(normalized);
}

function consumeNpmOptions(tokens, start) {
  let index = start;
  let invalid = false;
  let ignoreScripts = false;
  let invalidIgnoreScripts = false;
  while (index < tokens.length) {
    const token = tokens[index]?.value;
    if (!isNpmOption(token) || token === '--') break;
    const equals = token.indexOf('=');
    if (equals !== -1) {
      const option = token.slice(0, equals);
      if (option === '--ignore-scripts') {
        const value = token.slice(equals + 1);
        if (value === 'true') ignoreScripts = true;
        else invalidIgnoreScripts = true;
      }
      if (
        !NPM_OPTIONS_WITH_VALUE.has(option) &&
        !NPM_OPTIONS_WITHOUT_VALUE.has(option)
      ) {
        invalid = true;
      }
      index += 1;
      continue;
    }
    if (NPM_OPTIONS_WITH_VALUE.has(token)) {
      index += 2;
    } else if (NPM_OPTIONS_WITHOUT_VALUE.has(token)) {
      if (token === '--ignore-scripts') ignoreScripts = true;
      index += 1;
    } else if ((token.startsWith('-w') || token.startsWith('-C')) && token.length > 2) {
      // npm accepts attached short option values such as `-wfoo` and `-C.`.
      index += 1;
    } else if (token.startsWith('-p') && token.length > 2) {
      index += 1;
    } else {
      // Unknown option arity is intentionally fail-closed.  Do not let its
      // value be mistaken for the npm subcommand or script name.
      invalid = true;
      index += 1;
      if (index < tokens.length && !isNpmOption(tokens[index]?.value)) index += 1;
    }
  }
  return { index, invalid, ignoreScripts, invalidIgnoreScripts };
}

function parseNpmInvocations(text) {
  const tokens = tokenizeShell(text);
  const invocations = [];
  let invalidOption = false;
  let dynamicLauncher = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const dynamicOptions = tokens[index].dynamic
      ? consumeNpmOptions(tokens, index + 1)
      : null;
    if (
      tokens[index].dynamic &&
      ['run', 'run-script', 'exec', 'x'].includes(
        tokens[dynamicOptions?.index ?? -1]?.value,
      )
    ) {
      dynamicLauncher = true;
    }
    if (!isNpmExecutable(tokens[index].value)) continue;
    const globalOptions = consumeNpmOptions(tokens, index + 1);
    invalidOption ||= globalOptions.invalid;
    let cursor = globalOptions.index;
    if (tokens[cursor]?.value === '--') cursor += 1;
    const command = tokens[cursor]?.value;
    if (!['run', 'run-script', 'exec', 'x', 'ci', 'install', 'i'].includes(command)) continue;
    const commandIndex = cursor;
    cursor += 1;
    const commandOptions = consumeNpmOptions(tokens, cursor);
    invalidOption ||= commandOptions.invalid;
    cursor = commandOptions.index;
    const target = tokens[cursor] ?? null;
    const commandArgsStart = commandIndex + 1;
    const commandArgsOffset = tokens
      .slice(commandArgsStart)
      .findIndex((token) => ['&&', '||', ';'].includes(token.value));
    const commandArgsEnd =
      commandArgsOffset === -1
        ? tokens.length
        : commandArgsStart + commandArgsOffset;
    const commandArgs = tokens.slice(commandArgsStart, commandArgsEnd);
    const invalidIgnoreScriptsArgument = commandArgs.some(
      ({ value }) =>
        value.startsWith('--ignore-scripts=') && value !== '--ignore-scripts=true',
    );
    invocations.push({
      kind:
        command === 'run' || command === 'run-script'
          ? 'run'
          : command === 'exec' || command === 'x'
            ? 'exec'
            : 'install',
      target,
      ignoreScripts:
        globalOptions.ignoreScripts ||
        commandOptions.ignoreScripts ||
        commandArgs.some(
          ({ value }) =>
            value === '--ignore-scripts' || value.startsWith('--ignore-scripts='),
        ),
      invalidIgnoreScripts:
        globalOptions.invalidIgnoreScripts ||
        commandOptions.invalidIgnoreScripts ||
        invalidIgnoreScriptsArgument,
    });
  }
  return { invocations, invalidOption, dynamicLauncher };
}

function hasDynamicNpmInvocation(invocations) {
  return invocations.some(({ target }) => target?.dynamic);
}

function hasReadOnlyScriptEntrypoint(name, command) {
  return EXACT_READ_ONLY_SCRIPT_COMMANDS.get(name)?.test(command.trim()) ?? false;
}

function fail(reasonCode) {
  throw new Error(reasonCode);
}

function stripYamlStringsAndComments(line) {
  let result = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      result += ' ';
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === '\\') {
        escaped = true;
      } else if (quote === '"' && character === '"') {
        quote = null;
      } else if (quote === "'" && character === "'" && line[index + 1] === "'") {
        result += ' ';
        index += 1;
      } else if (quote === "'" && character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += ' ';
      continue;
    }
    if (character === '#') break;
    result += character;
  }
  return result;
}

function stripYamlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === '\\') {
        escaped = true;
      } else if (quote === '"' && character === '"') {
        quote = null;
      } else if (quote === "'" && character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (quote === "'" && character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') return line.slice(0, index);
  }
  return line;
}

function yamlStructuralLine(line) {
  let result = '';
  let escapedKey = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character !== '"' && character !== "'") {
      if (character === '#') break;
      result += character;
      continue;
    }

    const quote = character;
    const start = index;
    let content = '';
    let closed = false;
    for (index += 1; index < line.length; index += 1) {
      const current = line[index];
      if (quote === '"' && current === '\\' && index + 1 < line.length) {
        content += current + line[index + 1];
        index += 1;
        continue;
      }
      if (quote === "'" && current === "'" && line[index + 1] === "'") {
        content += "''";
        index += 1;
        continue;
      }
      if (current === quote) {
        closed = true;
        break;
      }
      content += current;
    }
    const afterQuote = closed ? line.slice(index + 1) : '';
    const isKey = closed && /^\s*:/.test(afterQuote);
    if (isKey) {
      result += content;
      if (content.includes('\\')) escapedKey = true;
    } else {
      result += ' '.repeat(Math.max(1, (closed ? index : line.length) - start + 1));
    }
  }
  return { text: result, escapedKey };
}

function yamlQuoteState(line, initialQuote = null) {
  let quote = initialQuote;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === '\\') {
        escaped = true;
      } else if (quote === '"' && character === '"') {
        quote = null;
      } else if (quote === "'" && character === "'" && line[index + 1] === "'") {
        index += 1;
      } else if (quote === "'" && character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') break;
  }
  return quote;
}

function extractPermissionBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let blockScalarIndent = null;
  for (let index = 0; index < lines.length; index += 1) {
    const sanitized = stripYamlStringsAndComments(lines[index]);
    const indent = sanitized.match(/^\s*/)?.[0].length ?? 0;
    if (blockScalarIndent !== null) {
      if (sanitized.trim() === '' || indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    if (/:\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*$/.test(sanitized)) {
      blockScalarIndent = indent;
      continue;
    }
    const uncommented = stripYamlComment(lines[index]);
    const match = /^(\s*)(?:(?:!{1,2}(?:[^\s]+)?|&[^\s]+)\s+)*(?:permissions|["']permissions["'])\s*:(.*)$/.exec(
      uncommented,
    );
    if (!match) continue;

    const parentIndent = match[1].length;
    const block = [lines[index].slice(lines[index].indexOf(':') + 1)];
    let next = index + 1;
    for (; next < lines.length; next += 1) {
      const nextSanitized = stripYamlStringsAndComments(lines[next]);
      if (nextSanitized.trim() === '') {
        block.push(lines[next]);
        continue;
      }
      const nextIndent = nextSanitized.match(/^\s*/)?.[0].length ?? 0;
      if (nextIndent <= parentIndent) break;
      block.push(lines[next]);
    }
    index = next - 1;
    blocks.push({
      indent: parentIndent,
      value: block.join('\n'),
      taggedKey: /^(?:\s*)(?:(?:!{1,2}(?:[^\s]+)?|&[^\s]+)\s+)+/.test(uncommented),
    });
  }
  return blocks;
}

function extractTopLevelPermissions(text) {
  const topLevel = extractPermissionBlocks(text).find(({ indent }) => indent === 0);
  if (topLevel) return topLevel.value;
  return null;
}

function hasPermissionValue(permissionsBlock, scope, value) {
  if (typeof permissionsBlock !== 'string') return false;
  const escapedScope = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|[\\n,{])\\s*["']?${escapedScope}["']?\\s*:\\s*["']?${escapedValue}["']?(?=\\s|[,}]|$)`,
    'i',
  ).test(permissionsBlock);
}

function hasYamlAnchorOrAlias(text) {
  let blockScalarIndent = null;
  for (const line of text.split(/\r?\n/)) {
    const sanitized = stripYamlStringsAndComments(line);
    const indent = sanitized.match(/^\s*/)?.[0].length ?? 0;
    if (blockScalarIndent !== null) {
      if (sanitized.trim() === '' || indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    if (/:\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*$/.test(sanitized)) {
      blockScalarIndent = indent;
      continue;
    }
    for (let index = 0; index < sanitized.length; index += 1) {
      if (sanitized[index] !== '&' && sanitized[index] !== '*') continue;
      const previous = sanitized.slice(0, index).match(/\S(?=\s*$)/)?.[0];
      if (previous && !':,[{?'.includes(previous)) {
        if (previous !== '-') continue;
        const dashIndex = sanitized.slice(0, index).lastIndexOf('-');
        if (!/^\s*$/.test(sanitized.slice(0, dashIndex))) continue;
      }
      const following = sanitized[index + 1];
      if (!following || /\s|[\[\]{},]/.test(following)) continue;
      return true;
    }
  }
  return false;
}

function hasUnsupportedPermissionStructure(text) {
  let blockScalarIndent = null;
  let jobsIndent = null;
  let jobIndent = null;
  let stepsIndent = null;
  let multilineQuote = null;
  for (const line of text.split(/\r?\n/)) {
    const sanitized = stripYamlStringsAndComments(line);
    const indent = sanitized.match(/^\s*/)?.[0].length ?? 0;
    if (blockScalarIndent !== null) {
      if (sanitized.trim() === '' || indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    if (/:\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*$/.test(sanitized)) {
      blockScalarIndent = indent;
      continue;
    }
    if (multilineQuote !== null) {
      multilineQuote = yamlQuoteState(line, multilineQuote);
      continue;
    }
    if (sanitized.trim() === '') continue;
    if (jobsIndent !== null && indent <= jobsIndent) {
      jobIndent = null;
      stepsIndent = null;
      jobsIndent = null;
    } else if (jobIndent !== null && indent <= jobIndent) {
      stepsIndent = null;
      jobIndent = null;
    } else if (stepsIndent !== null && indent <= stepsIndent) {
      stepsIndent = null;
    }
    if (stepsIndent !== null) {
      if (sanitized.trim() === '' || indent > stepsIndent) continue;
      stepsIndent = null;
    }
    const uncommented = stripYamlComment(line);
    if (
      /^\s*\?\s*(?:(?:!{1,2}\S*|&\S+)\s+)*(?:jobs|["']jobs["'])\s*:?\s*$/i.test(
        uncommented,
      )
    ) {
      return true;
    }
    const jobs = /^(\s*)(?:(?:!{1,2}(?:\S+)?|&\S+)\s+)*(?:jobs|["']jobs["'])\s*:(.*)$/i.exec(
      uncommented,
    );
    const taggedJobsKey = /^(?:\s*)(?:(?:!{1,2}(?:\S+)?|&\S+)\s+)+/.test(uncommented);
    if (jobs && jobs[1].length === 0 && taggedJobsKey) {
      return true;
    }
    if (jobs && jobs[1].length === 0 && jobs[2].trim() !== '' && /^!/.test(jobs[2].trim())) {
      return true;
    }
    if (jobs && jobs[1].length === 0 && jobs[2].trim() === '') {
      jobsIndent = jobs[1].length;
      jobIndent = null;
      stepsIndent = null;
      continue;
    }
    if (jobsIndent !== null && jobIndent === null && indent > jobsIndent) {
      jobIndent = indent;
    }
    const steps = /^(\s*)steps\s*:(.*)$/i.exec(sanitized);
    if (
      steps &&
      steps[2].trim() === '' &&
      (jobsIndent === null || (jobIndent !== null && indent > jobIndent))
    ) {
      stepsIndent = steps[1].length;
      continue;
    }
    const structural = yamlStructuralLine(line);
    if (structural.escapedKey) return true;
    if (/^\s*\?(?:\s+(?:!{1,2}(?:\S+)?|&\S+))?\s*$/.test(uncommented)) {
      return true;
    }
    if (
      /[{,]\s*\?(?:\s+(?:!{1,2}(?:\S+)?|&\S+))?\s*$/.test(structural.text)
    ) {
      return true;
    }
    if (
      /^\s*\?\s*(?:(?:!{1,2}(?:\S+)?|&\S+)\s+)*["'][^"']*\\\s*$/.test(
        uncommented,
      )
    ) {
      return true;
    }
    if (
      /[{,]\s*\?\s*(?:(?:!{1,2}(?:\S+)?|&\S+)\s+)*["'][^"']*\\\s*$/.test(
        structural.text,
      )
    ) {
      return true;
    }
    if (
      /^\s*\?\s*(?:(?:!{1,2}(?:\S+)?|&\S+)\s+)*"[^"\n]*\\[^"\n]*"\s*$/.test(
        uncommented,
      )
    ) {
      return true;
    }
    if (
      /^\s*\?\s*(?:(?:!{1,2}(?:\S+)?|&\S+)\s+)*(?:permissions|["']permissions["'])\s*:?\s*$/i.test(
        uncommented,
      )
    ) {
      return true;
    }
    if (
      /^\s*(?:(?:!{1,2}(?:\S+)?|&\S+)\s+)*"[^"\n]*\\[^"\n]*"\s*:/.test(
        uncommented,
      )
    ) {
      return true;
    }
    if (
      /[{,]\s*\??\s*(?:(?:!{1,2}(?:\S+)?|&\S+)\s+)*permissions\s*:/.test(
        structural.text,
      )
    ) {
      return true;
    }
    multilineQuote = yamlQuoteState(line);
  }
  return false;
}

export function assertReleaseTag(tag, pattern = DEFAULT_TAG_PATTERN) {
  if (typeof tag !== 'string' || !pattern.test(tag)) fail('release_tag_invalid');
  return tag;
}

export function scanWorkflowText(
  workflowPath,
  text,
  { scripts = null, requireExplicitPermissions = false } = {},
) {
  if (typeof workflowPath !== 'string' || typeof text !== 'string') {
    throw new TypeError('workflow_scan_input_invalid');
  }
  const findings = WORKFLOW_RULES.filter(({ pattern }) => pattern.test(text)).map(
    ({ reasonCode }) => reasonCode,
  );
  const normalized = text.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ');
  const npmParse = parseNpmInvocations(normalized);
  const npmInvocations = npmParse.invocations;
  if (npmParse.invalidOption) findings.push('workflow_npm_option_forbidden');
  if (hasYamlAnchorOrAlias(text)) {
    findings.push('workflow_yaml_alias_forbidden');
  }
  if (hasUnsupportedPermissionStructure(text)) {
    findings.push('workflow_permission_structure_forbidden');
  }
  const uses = [...text.matchAll(/\buses:\s*['"]?([^\s'"#]+)/gi)].map((match) => match[1]);
  if (uses.some((action) => !APPROVED_ACTION.test(action))) {
    findings.push('workflow_dynamic_action_forbidden');
  }
  const permissionValuePattern =
    /(?:^|[\n,{])\s*["']?(?:actions|attestations|checks|contents|deployments|discussions|id-token|issues|models|packages|pages|pull-requests|repository-projects|security-events|statuses|metadata)["']?\s*:\s*["']?([A-Za-z-]+)["']?/gi;
  const permissionBlocks = extractPermissionBlocks(text);
  const permissionText = permissionBlocks.map(({ value }) => value).join('\n');
  const writablePermission = [...permissionText.matchAll(permissionValuePattern)].some(
    (match) => !['read', 'none'].includes(match[1].toLowerCase()),
  );
  const permissionTag = permissionBlocks.some(
    ({ value, taggedKey }) =>
      taggedKey || /(?:^|[\s,{])!{1,2}(?:[^\s,{]+)?/.test(value),
  );
  if (
    permissionBlocks.some(({ value }) => /^\s*["']?(?:write-all|write)["']?(?:\s*#.*)?$/i.test(value)) ||
    writablePermission ||
    permissionTag
  ) {
    findings.push('workflow_permission_write_forbidden');
  }
  if (permissionBlocks.some(({ value }) => /\$\{\{/.test(value))) {
    findings.push('workflow_permission_dynamic_forbidden');
  }
  const topLevelPermissions = extractTopLevelPermissions(text);
  if (requireExplicitPermissions && topLevelPermissions === null) {
    findings.push('workflow_permissions_missing');
  }
  if (
    workflowPath === '.github/workflows/release.yml' &&
    (!hasPermissionValue(topLevelPermissions, 'contents', 'read') ||
      !hasPermissionValue(topLevelPermissions, 'actions', 'read'))
  ) {
    findings.push('workflow_permissions_missing_or_not_readonly');
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
  const unsafeLocalRunner = /\brun:\s*(?:\||>)?[\s\S]*?\b(?:node|python\d*|bash|sh|npx)\s+[^\r\n]*(?:deploy|production|promote|rollback|publish|release)[^\r\n]*/i;
  const safeAdmissionCommand = /^\s*(?:(?:-\s+)?run:\s+)?node\s+scripts\/release\/cli\.mjs\s+admit\s+--tag\s+(?:["']?\$[A-Za-z_][A-Za-z0-9_]*["']?|v[0-9A-Za-z.-]+)\s+--hosted\s*$/gim;
  if (unsafeLocalRunner.test(text.replace(safeAdmissionCommand, ''))) {
    findings.push('workflow_dynamic_local_write_forbidden');
  }
  if (npmParse.dynamicLauncher || hasDynamicNpmInvocation(npmInvocations)) {
    findings.push('workflow_dynamic_npm_write_forbidden');
  }
  for (const invocation of npmInvocations) {
    if (invocation.kind === 'install') {
      if (!invocation.ignoreScripts || invocation.invalidIgnoreScripts) {
        findings.push('workflow_npm_lifecycle_forbidden');
      }
      continue;
    }
    if (invocation.kind === 'exec') {
      // npm exec can install or execute an arbitrary package; a production
      // workflow must not use it as an indirect command launcher.
      findings.push('workflow_npm_write_forbidden');
      continue;
    }
    const name = invocation.target?.value;
    if (!name || invocation.target?.dynamic) continue;
    if (/(?:^|:)(?:release:(?!admit$)[A-Za-z0-9._-]+|ship|deploy|publish|promote|rollback)$/.test(name)) {
      findings.push('workflow_npm_write_forbidden');
    }
  }
  if (/\brun:\s*["'`]?\$[A-Za-z_{]/i.test(text) && /\b(?:run|exec)\b/i.test(normalized)) {
    findings.push('workflow_dynamic_npm_write_forbidden');
  }
  if (scripts && typeof scripts === 'object') {
    const visited = new Set();
    const scriptWrites = (name, depth = 0) => {
      if (depth > 12 || visited.has(name)) return false;
      visited.add(name);
      const command = scripts[name];
      if (typeof command !== 'string') return false;
      if (
        /(?:vercel\b|--prod\b|production|promote|rollback|git\s+push|gh\s+release|api\.github\.com|api\.vercel\.com)/i.test(command) ||
        DYNAMIC_HTTP_CLIENT.test(command) ||
        /\bgh\s+api\b/i.test(command)
      ) return true;
      if (
        /\$[A-Za-z_{(]/.test(command) ||
        /\b(?:node|npx|python\d*|bash|sh|zsh|fish|bun|deno|tsx|ts-node)\b/i.test(command) ||
        LOCAL_SCRIPT_PATH.test(command)
      ) {
        if (!hasReadOnlyScriptEntrypoint(name, command)) return true;
      }
      const nestedParse = parseNpmInvocations(command);
      if (
        nestedParse.invalidOption ||
        nestedParse.invalidIgnoreScripts ||
        nestedParse.dynamicLauncher ||
        hasDynamicNpmInvocation(nestedParse.invocations)
      ) return true;
      if (nestedParse.invocations.some(({ kind }) => kind === 'exec')) return true;
      return nestedParse.invocations
        .filter(({ kind }) => kind === 'run')
        .some(({ target }) => !target?.value || scriptWrites(target.value, depth + 1));
    };
    for (const invocation of npmInvocations.filter(({ kind }) => kind === 'run')) {
      const name = invocation.target?.value;
      if (!name || invocation.target?.dynamic) continue;
      if (scriptWrites(name)) {
        findings.push('workflow_npm_script_write_forbidden');
      } else if (
        !SAFE_NPM_SCRIPTS.has(name) ||
        !hasReadOnlyScriptEntrypoint(name, scripts[name])
      ) {
        findings.push('workflow_npm_script_not_allowlisted');
      }
    }
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

  let targetPackageScripts = null;
  try {
    const packageResult = await git(runner, repoRoot, ['show', `${targetSha}:package.json`]);
    targetPackageScripts = JSON.parse(packageResult.stdout).scripts ?? null;
  } catch {
    targetPackageScripts = null;
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
    for (const reasonCode of scanWorkflowText(workflowPath, workflow.stdout, {
      scripts: targetPackageScripts,
      requireExplicitPermissions: true,
    })) {
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
