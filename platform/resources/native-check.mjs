import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export function fail(code, message) { throw Object.assign(new Error(message), { code }); }
export function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || /[\u0000-\u001f]/u.test(path)) {
    fail('LOCAL_WEB_PATH_INVALID', '需要目标机明确提供的规范绝对路径，不搜索 PATH 或用户定位记录。');
  }
  return path;
}
/** -B forbids writes, not reads: isolate the read cache as well as ambient imports. */
export function isolatedPythonArgs(cacheRoot, args) {
  return ['-I', '-B', '-X', `pycache_prefix=${absolute(cacheRoot)}`, ...args];
}
export function contains(parent, path) {
  const part = relative(parent, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
export function readJson(path, limit = 128_000) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) fail('LOCAL_WEB_FILE_UNSAFE', '配置必须是有界普通单链接文件。');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('LOCAL_WEB_CONFIG_INVALID', '配置必须是 JSON 对象。');
  return value;
}
export function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
export function readToolchain(codeRoot) {
  const path = join(codeRoot, 'config/local-web-toolchain.json'), value = readJson(path);
  if (value.version !== 1 || !['node', 'npm', 'python'].every(key => /^\d+\.\d+\.\d+$/u.test(value[key]))
    || value.pythonRequirements !== 'config/local-web-python-requirements.txt'
    || !Number.isSafeInteger(value.minimumFreeBytes) || value.minimumFreeBytes < 0) fail('LOCAL_WEB_TOOLCHAIN_INVALID', '本地 Web 工具链锁无效。');
  const requirementsPath = join(codeRoot, value.pythonRequirements), packages = {};
  for (const line of readFileSync(requirementsPath, 'utf8').split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)$/u.exec(line);
    if (!match || Object.hasOwn(packages, match[1])) fail('LOCAL_WEB_TOOLCHAIN_INVALID', 'Python 依赖须逐项固定唯一精确版本。');
    packages[match[1]] = match[2];
  }
  if (!packages.duckdb || !packages.pytest) fail('LOCAL_WEB_TOOLCHAIN_INVALID', 'Python 锁缺少 WFD 或测试依赖。');
  return { ...value, packages, sha256: sha256File(path), requirementsSha256: sha256File(requirementsPath) };
}
export function assertNodeVersion(codeRoot) {
  const toolchain = readToolchain(codeRoot);
  if (process.versions.node !== toolchain.node) fail('LOCAL_WEB_NODE_VERSION', `本地 Web 要求 Node ${toolchain.node}；当前 ${process.versions.node}。请显式选择正确程序，不会自动安装或替代。`);
  return toolchain;
}
export function inspectProgram(path) {
  absolute(path);
  const canonical = realpathSync(path), info = statSync(canonical, { bigint: true });
  if (!info.isFile()) fail('LOCAL_WEB_PROGRAM_INVALID', '明确选择的程序不是普通文件。');
  accessSync(path, constants.X_OK);
  return { path, canonical, sha256: sha256File(canonical), identity: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':') };
}
export function nativeEnvironment(systemRoot) {
  const env = { PATH: '', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };
  if (process.platform === 'win32') {
    absolute(systemRoot);
    if (realpathSync(systemRoot) !== systemRoot || !lstatSync(systemRoot).isDirectory()) fail('LOCAL_WEB_WINDOWS_SYSTEM_ROOT', 'Windows 需要显式选择真实系统根。');
    Object.assign(env, { SystemRoot: systemRoot, WINDIR: systemRoot });
  } else if (systemRoot !== undefined) fail('LOCAL_WEB_WINDOWS_SYSTEM_ROOT', '此平台不接受 Windows 系统根。');
  return env;
}
function run(executable, args, env) {
  const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576, windowsHide: true });
  // 不回显底层输出，避免错误中的环境/配置文本进入日志。
  if (result.error || result.status !== 0 || result.signal) fail('LOCAL_WEB_DEPENDENCY_CHECK_FAILED', '明确选择的程序未完成只读依赖检查；未尝试其他程序或安装。');
  return result.stdout.trim();
}
function assertUnchanged(before) {
  const after = inspectProgram(before.path);
  if (before.canonical !== after.canonical || before.identity !== after.identity || before.sha256 !== after.sha256) fail('LOCAL_WEB_PROGRAM_CHANGED', '检查期间程序对象已变化。');
}
export function checkPython(codeRoot, pythonPath, systemRoot) {
  const toolchain = assertNodeVersion(codeRoot), selected = inspectProgram(pythonPath);
  const script = 'import sys, json, importlib.metadata as m; names=json.loads(sys.argv[1]); versions={}; missing=[]\nfor name in names:\n try: versions[name]=m.version(name)\n except m.PackageNotFoundError: missing.append(name)\nprint(json.dumps({"version":sys.version.split()[0],"packages":versions,"missing":missing}))';
  const actual = JSON.parse(run(selected.path, ['-I', '-B', '-c', script, JSON.stringify(Object.keys(toolchain.packages))], nativeEnvironment(systemRoot)));
  assertUnchanged(selected);
  if (actual.version !== toolchain.python) fail('LOCAL_WEB_PYTHON_VERSION', `需要 Python ${toolchain.python}；当前 ${actual.version}。请显式选择目标虚拟环境。`);
  const gaps = Object.entries(toolchain.packages).filter(([name, version]) => actual.packages[name] !== version).map(([name, version]) => `${name}==${version}`);
  if (gaps.length) fail('LOCAL_WEB_PYTHON_PACKAGES', `Python 固定依赖缺失或版本不符：${gaps.join(', ')}。请人工在所选虚拟环境安装锁文件；不会在线安装。`);
  return { path: selected.path, sha256: selected.sha256, version: actual.version, packages: actual.packages };
}
export function checkNpm(codeRoot, npmCli, systemRoot) {
  const toolchain = assertNodeVersion(codeRoot);
  absolute(npmCli);
  const canonical = realpathSync(npmCli), before = statSync(canonical, { bigint: true });
  if (!before.isFile() || !/\.[cm]?js$/u.test(canonical)) fail('LOCAL_WEB_NPM_INVALID', '请明确选择 npm CLI JavaScript 入口，由已选 Node 执行，不执行 PATH 包装器。');
  const sha256 = sha256File(canonical), version = run(process.execPath, [npmCli, '--version'], nativeEnvironment(systemRoot));
  const after = statSync(realpathSync(npmCli), { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs || sha256File(npmCli) !== sha256) fail('LOCAL_WEB_PROGRAM_CHANGED', '检查期间 npm CLI 对象已变化。');
  if (version !== toolchain.npm) fail('LOCAL_WEB_NPM_VERSION', `需要 npm ${toolchain.npm}；当前 ${version}。不会选择其他安装。`);
  return { path: npmCli, sha256, version };
}
function platformMatches(values, current) {
  return !values || ((!values.some(value => !value.startsWith('!')) || values.includes(current)) && !values.includes('!' + current));
}
export function checkNodeDependencies(codeRoot) {
  assertNodeVersion(codeRoot);
  const pkg = readJson(join(codeRoot, 'package.json')), lockPath = join(codeRoot, 'package-lock.json');
  const lock = readJson(lockPath, 8 * 1024 * 1024), root = lock.packages?.[''];
  if (lock.lockfileVersion !== 3 || !root || root.name !== pkg.name || root.version !== pkg.version) fail('LOCAL_WEB_NPM_LOCK', 'npm 锁文件版本或项目身份不一致，请使用随源码的锁文件。');
  for (const kind of ['dependencies', 'devDependencies']) {
    const wanted = pkg[kind] ?? {}, locked = root[kind] ?? {};
    if (JSON.stringify(Object.keys(wanted).sort()) !== JSON.stringify(Object.keys(locked).sort())
      || Object.entries(wanted).some(([name, version]) => !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version) || locked[name] !== version)) fail('LOCAL_WEB_NPM_LOCK', 'package.json 直接依赖须固定精确版本并与 package-lock.json 一致。');
  }
  let checked = 0, optionalMissing = 0;
  for (const [part, entry] of Object.entries(lock.packages)) {
    if (!part) continue;
    if (!part.startsWith('node_modules/') || /[\\:\u0000-\u001f]/u.test(part) || part.split('/').some(value => !value || value === '.' || value === '..') || entry.link) fail('LOCAL_WEB_NPM_LOCK', '锁文件存在非受控依赖位置。');
    if (!platformMatches(entry.os, process.platform) || !platformMatches(entry.cpu, process.arch)) continue;
    const manifest = join(codeRoot, part, 'package.json');
    if (!lstatSync(manifest, { throwIfNoEntry: false })) {
      if (entry.optional) { optionalMissing++; continue; }
      fail('LOCAL_WEB_NODE_PACKAGES', `缺少锁定依赖 ${part}；请先用锁定 Node/npm 执行 npm ci。`);
    }
    if (!contains(realpathSync(codeRoot), realpathSync(manifest)) || readJson(manifest).version !== entry.version) fail('LOCAL_WEB_NODE_PACKAGES', `依赖版本或位置与锁文件不同：${part}。请重新执行 npm ci。`);
    checked++;
  }
  return { lockSha256: sha256File(lockPath), checked, optionalMissing };
}
