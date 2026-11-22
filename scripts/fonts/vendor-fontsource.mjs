#!/usr/bin/env node
// 把固定版本的 Fontsource 字体包转成项目同域提供的静态字体（CSS、WOFF2、许可证和锁文件）。
// 参见 docs/standards/web-fonts.md。只用 Node 内置模块；下载的包只作为数据读取，不执行其中任何代码。
//
// 用法（在项目根目录运行）：
//   node vendor-fontsource.mjs --config config/fonts.json            下载、校验并写入字体资源
//   node vendor-fontsource.mjs --config config/fonts.json --dry      只下载到临时目录并打印计划，不写项目文件
//   node vendor-fontsource.mjs --config config/fonts.json --verify   离线核对锁文件、CSS 与字体文件（适合 CI）
//   --source <dir>  从目录里的 npm pack 产物（<scope>-<name>-<version>.tgz）读取，不访问网络
//   --update        允许锁文件里同一版本的 integrity 变化（默认视为供应链异常并停止）
//
// 配置示例：
//   { "outDir": "public/fonts", "cssFile": "public/fonts/fonts.css", "urlBase": "/public/fonts",
//     "fonts": [{ "package": "@fontsource-variable/montserrat", "version": "5.3.0",
//                 "css": ["wght.css"], "family": "Montserrat" }] }
//
// --verify 只能发现产物与锁文件不一致（手改、漏提交、生成中断）；锁文件和产物在同一提交里，
// 它不能证明来源可信。来源核对发生在写入模式：同一版本的 integrity 必须与锁文件一致。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LOCK_NAME = 'fonts.lock.json';
const GENERATOR = 'shadow-devkit/templates/fonts/vendor-fontsource.mjs';
const PACKAGE = /^@fontsource(?:-variable)?\/[a-z0-9-]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const CSS_NAME = /^[a-z0-9-]+\.css$/;
const FONT_FILE = /^[A-Za-z0-9._-]+\.woff2$/;
const FAMILY = /^[A-Za-z0-9 ]+$/;
const URL_BASE = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?\/?$/;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const integrityOf = (data) => `sha512-${createHash('sha512').update(data).digest('base64')}`;
const slugOf = (name) => name.split('/')[1];
const tarballName = (name, version) => `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
const posixJoin = (...parts) => path.posix.join(...parts);
const toPosix = (rel) => rel.split(path.sep).join('/');
const fontUrl = (urlBase, slug, file) => `${urlBase}/${slug}/${file}`;

export function parseArgs(argv) {
  const options = { mode: 'write', update: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' || arg === '--source' || arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少参数值`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg === '--dry' || arg === '--verify') {
      if (options.mode !== 'write') throw new Error('--dry 与 --verify 不能同时使用');
      options.mode = arg.slice(2);
    } else if (arg === '--update') options.update = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  if (options.mode === 'verify' && (options.source || options.update)) {
    throw new Error('--verify 只离线核对磁盘产物，不接受 --source 或 --update');
  }
  if (!options.help && !options.config) throw new Error('缺少 --config <path>');
  return options;
}

function insideRoot(root, rel, label) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) throw new Error(`${label} 必须是项目内相对路径`);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} 超出项目根目录: ${rel}`);
  return resolved;
}

// 写入或删除前，从项目根到目标的每一级已存在路径都不能是符号链接，防止经链接写到项目外。
function assertNoSymlink(root, target) {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`路径包含符号链接，拒绝写入: ${path.relative(root, current)}`);
  }
}

export function loadConfig(root, configPath) {
  const rootAbs = path.resolve(root);
  const config = JSON.parse(readFileSync(insideRoot(rootAbs, configPath, '--config'), 'utf8'));
  const outDir = insideRoot(rootAbs, config.outDir, 'outDir');
  const cssFile = insideRoot(rootAbs, config.cssFile, 'cssFile');
  if (!cssFile.startsWith(`${outDir}${path.sep}`)) throw new Error('cssFile 必须位于 outDir 内');
  if (typeof config.urlBase !== 'string' || !URL_BASE.test(config.urlBase)) {
    throw new Error('urlBase 必须是以 / 开头、不含 // 的同域路径');
  }
  if (!Array.isArray(config.fonts) || !config.fonts.length) throw new Error('fonts 不能为空');
  const slugs = new Set();
  for (const font of config.fonts) {
    if (!PACKAGE.test(font.package ?? '')) throw new Error(`只支持 @fontsource 或 @fontsource-variable 包: ${font.package}`);
    if (!VERSION.test(font.version ?? '')) throw new Error(`${font.package} 必须固定精确版本`);
    if (!FAMILY.test(font.family ?? '')) throw new Error(`${font.package} 的 family 无效`);
    if (!Array.isArray(font.css) || !font.css.length || font.css.some((name) => !CSS_NAME.test(name))) {
      throw new Error(`${font.package} 的 css 必须是包内 CSS 文件名列表`);
    }
    const slug = slugOf(font.package);
    if (slugs.has(slug)) throw new Error(`字体包重复: ${slug}`);
    slugs.add(slug);
  }
  return { ...config, urlBase: config.urlBase.replace(/\/+$/, ''), rootAbs, outDirAbs: outDir, cssFileAbs: cssFile };
}

function readLock(outDirAbs) {
  const file = path.join(outDirAbs, LOCK_NAME);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function fetchTarball(font, source, work) {
  const name = tarballName(font.package, font.version);
  if (source) {
    const file = path.join(source, name);
    if (!existsSync(file)) throw new Error(`--source 中缺少 ${name}`);
    return readFileSync(file);
  }
  execFileSync('npm', ['pack', `${font.package}@${font.version}`, '--ignore-scripts', '--silent', '--pack-destination', work],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  return readFileSync(path.join(work, name));
}

// 包内文件必须是普通文件，且真实路径在包目录内；拒绝符号链接，防止把包外内容复制进项目。
function packageFile(packageDir, rel, label) {
  const abs = path.join(packageDir, rel);
  const stat = lstatSync(abs, { throwIfNoEntry: false });
  if (!stat) throw new Error(`${label} 缺少 ${rel}`);
  if (!stat.isFile()) throw new Error(`${label} 的 ${rel} 不是普通文件（符号链接或目录），拒绝读取`);
  const real = realpathSync(abs);
  if (!real.startsWith(`${realpathSync(packageDir)}${path.sep}`)) throw new Error(`${label} 的 ${rel} 指向包外，拒绝读取`);
  return abs;
}

// 生成一个包的 CSS 与文件清单；只接受包内 files/ 下的 WOFF2，防止 url() 指向包外或任意路径。
export function transformPackage({ font, packageDir, urlBase }) {
  const stat = lstatSync(packageDir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`${font.package} 的 tarball 没有 package/ 目录（或它是符号链接）`);
  const meta = JSON.parse(readFileSync(packageFile(packageDir, 'package.json', font.package), 'utf8'));
  if (meta.name !== font.package || meta.version !== font.version) {
    throw new Error(`包身份不符: 期望 ${font.package}@${font.version}，实际 ${meta.name}@${meta.version}`);
  }
  const licenseFile = packageFile(packageDir, 'LICENSE', font.package);
  const slug = slugOf(font.package);
  const files = new Map();
  const blocks = font.css.map((cssName) => {
    const css = readFileSync(packageFile(packageDir, cssName, font.package), 'utf8')
      .replace(/font-family\s*:\s*(['"])[^'"]+\1/gi, `font-family: '${font.family}'`)
      // 可变 WOFF2 用标准的 format('woff2')，与 Google Fonts CSS 一致；旧的 woff2-variations 提示不是所有浏览器都认。
      .replace(/format\(\s*(['"])woff2-variations\1\s*\)/gi, "format('woff2')")
      // 静态字重包在 WOFF2 后附带 WOFF 回退；现行浏览器都支持 WOFF2，只保留 WOFF2，不复制 WOFF。
      .replace(/,\s*url\(\s*(['"]?)\.\/files\/[^'")]+\.woff\1\s*\)\s*format\(\s*(['"])woff\2\s*\)/gi, '')
      .replace(/url\(\s*(['"]?)\.\/files\/([^'")]+)\1\s*\)/gi, (match, quote, file) => {
        if (!FONT_FILE.test(file)) throw new Error(`${font.package}/${cssName} 引用了不受支持的文件: ${file}`);
        files.set(posixJoin(slug, file), packageFile(packageDir, path.join('files', file), font.package));
        return `url(${fontUrl(urlBase, slug, file)})`;
      });
    for (const [, url] of css.matchAll(/url\(\s*['"]?([^'")]+)/gi)) {
      if (!url.startsWith(`${urlBase}/`)) throw new Error(`${font.package}/${cssName} 含有未改写的 url(): ${url}`);
    }
    return `/* ${font.package}@${font.version} ${cssName} */\n${css.trim()}\n`;
  });
  if (!files.size) throw new Error(`${font.package} 的 CSS 没有引用任何字体文件`);
  files.set(posixJoin(slug, 'LICENSE'), licenseFile);
  return { slug, css: blocks.join('\n'), files, license: meta.license ?? 'UNKNOWN' };
}

export function buildPlan({ root, config, source, update = false, log = console.log }) {
  const lock = readLock(config.outDirAbs);
  const work = mkdtempSync(path.join(tmpdir(), 'vendor-fontsource-'));
  try {
    const packages = [];
    const files = new Map();
    const cssParts = [`/* Generated by ${GENERATOR}. Do not edit; change the config and rerun. */\n`];
    for (const font of config.fonts) {
      const tarball = fetchTarball(font, source, work);
      const integrity = integrityOf(tarball);
      const locked = lock?.packages?.find((item) => item.name === font.package && item.version === font.version);
      if (locked && locked.integrity !== integrity && !update) {
        throw new Error(`${font.package}@${font.version} 的 integrity 与锁文件不一致，停止（确认来源后用 --update）`);
      }
      const unpack = mkdtempSync(path.join(work, 'pkg-'));
      const tarPath = path.join(unpack, 'package.tgz');
      writeFileSync(tarPath, tarball);
      execFileSync('tar', ['-xzf', tarPath, '-C', unpack], { stdio: 'ignore' });
      const result = transformPackage({ font, packageDir: path.join(unpack, 'package'), urlBase: config.urlBase });
      const entry = { name: font.package, version: font.version, integrity, license: result.license, family: font.family, css: font.css, files: {} };
      for (const [rel, abs] of result.files) {
        const data = readFileSync(abs);
        files.set(rel, data);
        entry.files[rel] = sha256(data);
      }
      packages.push(entry);
      cssParts.push(result.css);
    }
    const css = cssParts.join('\n');
    const cssRel = toPosix(path.relative(config.outDirAbs, config.cssFileAbs));
    const nextLock = { generator: GENERATOR, css: { path: cssRel, sha256: sha256(css) }, packages };
    const removed = (lock?.packages ?? []).flatMap((item) => Object.keys(item.files ?? {})).filter((rel) => !files.has(rel));
    const bytes = [...files.values()].reduce((sum, data) => sum + data.length, 0);
    log(`[vendor-fontsource] ${packages.length} 个包，${files.size} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MiB → ${toPosix(path.relative(root, config.outDirAbs))}`);
    for (const item of packages) {
      const size = Object.keys(item.files).reduce((sum, rel) => sum + files.get(rel).length, 0);
      log(`  ${item.name}@${item.version} ${item.license} family='${item.family}' ${Object.keys(item.files).length} 个文件 ${(size / 1024).toFixed(0)} KiB`);
    }
    for (const rel of removed) log(`  将删除: ${posixJoin(config.outDir, rel)}`);
    return { css, files, lock: nextLock, removed };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function writePlan({ config, plan }) {
  const root = config.rootAbs;
  const write = (target, data) => {
    assertNoSymlink(root, target);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  };
  for (const rel of plan.removed) {
    const target = insideRoot(config.outDirAbs, rel, 'lock 文件路径');
    assertNoSymlink(root, target);
    rmSync(target, { force: true });
  }
  for (const [rel, data] of plan.files) write(insideRoot(config.outDirAbs, rel, '字体文件路径'), data);
  write(config.cssFileAbs, plan.css);
  write(path.join(config.outDirAbs, LOCK_NAME), `${JSON.stringify(plan.lock, null, 2)}\n`);
}

// 离线核对：配置与锁一致、每个锁定文件哈希一致、CSS 未被手改、只引用锁定文件、目录里没有未登记的文件或符号链接。
export function verify({ config }) {
  const problems = [];
  const lock = readLock(config.outDirAbs);
  if (!lock) return [`缺少 ${posixJoin(config.outDir, LOCK_NAME)}，先运行写入模式`];
  const locked = new Map((lock.packages ?? []).map((item) => [item.name, item]));
  const listed = new Set();
  for (const font of config.fonts) {
    const item = locked.get(font.package);
    if (!item) { problems.push(`锁文件缺少 ${font.package}`); continue; }
    if (item.version !== font.version || item.family !== font.family || JSON.stringify(item.css) !== JSON.stringify(font.css)) {
      problems.push(`${font.package} 的配置与锁文件不一致，重新运行写入模式`);
    }
    for (const [rel, hash] of Object.entries(item.files ?? {})) {
      listed.add(rel);
      const file = insideRoot(config.outDirAbs, rel, '锁文件路径');
      if (!existsSync(file)) problems.push(`缺少 ${posixJoin(config.outDir, rel)}`);
      else if (sha256(readFileSync(file)) !== hash) problems.push(`哈希不符: ${posixJoin(config.outDir, rel)}`);
    }
  }
  for (const name of locked.keys()) if (!config.fonts.some((font) => font.package === name)) problems.push(`锁文件含有配置外的包 ${name}`);
  const cssRel = toPosix(path.relative(config.outDirAbs, config.cssFileAbs));
  if (!existsSync(config.cssFileAbs)) problems.push(`缺少 ${config.cssFile}`);
  else {
    const css = readFileSync(config.cssFileAbs, 'utf8');
    if (lock.css?.path !== cssRel || sha256(css) !== lock.css?.sha256) problems.push(`${config.cssFile} 与锁文件不一致（被手改或未重新生成）`);
    const prefix = `${config.urlBase}/`;
    for (const [, url] of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
      if (!url.startsWith(prefix) || !listed.has(url.slice(prefix.length))) problems.push(`CSS 引用了未锁定的资源: ${url}`);
    }
  }
  const known = new Set([...listed, cssRel, LOCK_NAME]);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = path.join(dir, entry.name);
    const rel = toPosix(path.relative(config.outDirAbs, abs));
    if (entry.isSymbolicLink()) return [{ rel, problem: `outDir 内不允许符号链接: ${posixJoin(config.outDir, rel)}` }];
    return entry.isDirectory() ? walk(abs) : [{ rel }];
  });
  if (existsSync(config.outDirAbs)) {
    for (const { rel, problem } of walk(config.outDirAbs)) {
      if (problem) problems.push(problem);
      else if (!known.has(rel)) problems.push(`未登记的文件: ${posixJoin(config.outDir, rel)}`);
    }
  }
  return problems;
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const options = parseArgs(argv);
  if (options.help) {
    log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((line) => line.startsWith('//')).map((line) => line.slice(3)).join('\n'));
    return 0;
  }
  const root = path.resolve(options.root ?? process.cwd());
  const config = loadConfig(root, options.config);
  if (options.mode === 'verify') {
    const problems = verify({ config });
    if (problems.length) {
      for (const problem of problems) console.error(`✗ ${problem}`);
      return 1;
    }
    log(`[vendor-fontsource] 校验通过：${config.fonts.length} 个包与 ${config.cssFile} 均与锁文件一致`);
    return 0;
  }
  const source = options.source ? path.resolve(options.source) : undefined;
  const plan = buildPlan({ root, config, source, update: options.update, log });
  if (options.mode === 'dry') {
    log('[vendor-fontsource] --dry：未写入任何项目文件');
    return 0;
  }
  writePlan({ config, plan });
  log(`[vendor-fontsource] 已写入 ${config.cssFile} 与 ${posixJoin(config.outDir, LOCK_NAME)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[vendor-fontsource] 错误: ${error.message}`);
    process.exitCode = 1;
  }
}
