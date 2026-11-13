import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownStateRoot } from '../apps/server/boot.js';
import { ResourceBindings, launcherPath, locateRuntimeRoot } from '../platform/resources/bindings.js';
import { acquireRuntimeStartupFence, assertRuntimeStopped, readRuntimeLauncher } from '../platform/runtime/runtime-profile.js';
import { POLARS_DEPENDENCY_VERSION } from '../modules/collection/data-processing/polars-cleaning.js';

export interface PolarsPythonAdoptionRequest {
  pythonExecutable: string;
  runtimeIdentity: string;
  expectedRevision: number;
  recordRoot: string;
  runtimeRoot?: string;
  launcherFile?: string;
  expectedEnvironmentVersion?: string;
  expectedPlanSha256?: string;
}
interface Pinned { raw: Buffer; mode: number; uid: number; gid: number; dev: bigint; ino: bigint }
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const inside = (root: string, path: string) => { const part = relative(root, path); return !part || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)); };
function fail(message: string): never { throw new Error(message); }
function directory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) fail('维护目录需要规范绝对路径。');
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) fail('维护位置必须是真实普通目录。');
}
function pinned(path: string, maxBytes = 128_000): Pinned {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) fail('维护输入必须是有界普通单链接文件。');
    const raw = readFileSync(fd), after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('维护配置在读取期间变化。');
    return { raw, mode: Number(before.mode) & 0o777, uid: Number(before.uid), gid: Number(before.gid), dev: before.dev, ino: before.ino };
  } finally { closeSync(fd); }
}
function same(path: string, expected: Pinned): void {
  const actual = pinned(path, Math.max(128_000, expected.raw.length));
  if (!actual.raw.equals(expected.raw) || actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.mode !== expected.mode || actual.uid !== expected.uid || actual.gid !== expected.gid) fail('原文件字节或身份已经变化，拒绝维护。');
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function exclusive(path: string, raw: Buffer, owner?: Pinned): Pinned {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, owner?.mode ?? 0o600);
  try {
    const info = fstatSync(fd);
    if (owner && (info.uid !== owner.uid || info.gid !== owner.gid)) fail('候选文件无法保持原所有者与组。');
    fchmodSync(fd, owner?.mode ?? 0o600); writeFileSync(fd, raw); fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
  return pinned(path);
}
function replace(path: string, raw: Buffer, expected: Pinned): Pinned {
  const temporary = path + '.adopt-' + randomUUID();
  const written = exclusive(temporary, raw, expected);
  try { same(path, expected); renameSync(temporary, path); syncDirectory(dirname(path)); }
  finally {
    if (lstatSync(temporary, { throwIfNoEntry: false })) { same(temporary, written); unlinkSync(temporary); }
  }
  const actual = pinned(path); if (!actual.raw.equals(raw)) fail('维护落盘读回与候选字节不同。');
  return actual;
}
/** Executes only the explicitly selected virtual environment, with no inherited Python or user paths. */
export function capturePolarsEnvironment(pythonExecutable: string) {
  if (!isAbsolute(pythonExecutable) || resolve(pythonExecutable) !== pythonExecutable || /[\\\u0000-\u001f]/u.test(pythonExecutable)
    || !pythonExecutable.endsWith('/bin/python')) fail('需要明确虚拟环境中的规范绝对bin/python路径。');
  const venvRoot = dirname(dirname(pythonExecutable)); directory(venvRoot); directory(dirname(pythonExecutable));
  const configuration = pinned(join(venvRoot, 'pyvenv.cfg'));
  const programCanonical = realpathSync(pythonExecutable), program = pinned(programCanonical, 20 * 1024 * 1024), programSha256 = sha(program.raw);
  const result = spawnSync(pythonExecutable, ['-I', '-B', '-c', POLARS_PROBE], {
    cwd: '/', env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail('选定Polars虚拟环境核对失败：' + (result.error?.message ?? result.stderr.slice(0, 4096)));
  let receipt: any;
  try { receipt = JSON.parse(result.stdout); } catch { return fail('选定环境没有返回完整核对回执。'); }
  if (receipt.version !== 'bd.polars-environment/1' || receipt.venvRoot !== venvRoot || receipt.executable !== pythonExecutable
    || receipt.polarsVersion !== POLARS_DEPENDENCY_VERSION || receipt.runtimeVersion !== POLARS_DEPENDENCY_VERSION
    || !Array.isArray(receipt.files) || !receipt.files.length || !Array.isArray(receipt.nativeFiles) || !receipt.nativeFiles.length
    || receipt.nativeCalculation !== '3.75' || realpathSync(pythonExecutable) !== programCanonical) fail('实际环境、锁定两包、程序摘要或原生十进制计算不符。');
  same(programCanonical, program);
  same(join(venvRoot, 'pyvenv.cfg'), configuration);
  const { files, ...summary } = receipt;
  const environment = { ...summary, packageFileCount: files.length, packageFilesSha256: sha(json(files)), programSha256, programCanonical,
    programIdentity: { device: String(program.dev), inode: String(program.ino), mode: program.mode, uid: program.uid, gid: program.gid },
    configurationSha256: sha(configuration.raw) };
  return { environment, environmentVersion: 'sha256:' + sha(json(environment)) };
}
const POLARS_PROBE = String.raw`
import hashlib, importlib.metadata as md, json, os, pathlib, platform, sys
from decimal import Decimal
os.environ['POLARS_MAX_THREADS'] = '2'
import polars as pl
root = pathlib.Path(sys.prefix)
if sys.prefix == sys.base_prefix or tuple(sys.version_info[:2]) < (3, 10):
    raise ValueError('Explicit Python >=3.10 virtual environment required')
if pl.__version__ != '2.0.0' or md.version('polars-runtime-32') != '2.0.0' or md.version('polars') != '2.0.0':
    raise ValueError('Polars and polars-runtime-32 must both be exactly 2.0.0')
files = []
for package in ['polars', 'polars-runtime-32']:
    distribution = md.distribution(package)
    for part in sorted(distribution.files or [], key=str):
        if str(part).endswith('.pyc'):
            continue
        path = pathlib.Path(distribution.locate_file(part))
        relative = path.resolve().relative_to(root.resolve()).as_posix()
        if path.is_symlink():
            raise ValueError('Package file cannot be a symbolic link')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            before = os.fstat(fd)
            if before.st_nlink != 1:
                raise ValueError('Package file must have one link')
            content = bytearray()
            while True:
                block = os.read(fd, 1024 * 1024)
                if not block:
                    break
                content.extend(block)
            after = os.fstat(fd)
            identity = lambda x: (x.st_dev, x.st_ino, x.st_size, x.st_mtime_ns, x.st_ctime_ns)
            if identity(before) != identity(after):
                raise ValueError('Package file changed while hashing')
            files.append({'package': package, 'path': relative, 'bytes': before.st_size,
                          'sha256': hashlib.sha256(content).hexdigest(), 'device': str(before.st_dev), 'inode': str(before.st_ino)})
        finally:
            os.close(fd)
frame = pl.DataFrame({'value': [Decimal('1.25'), Decimal('2.50')]}, schema={'value': pl.Decimal(38, 18)})
actual = frame.lazy().select(pl.col('value').sum()).collect(engine='streaming').item()
print(json.dumps({'version':'bd.polars-environment/1', 'executable':sys.executable, 'venvRoot':sys.prefix,
                  'pythonVersion': platform.python_version(), 'platform':platform.platform(),
                  'polarsVersion':pl.__version__, 'runtimeVersion':md.version('polars-runtime-32'),
                  'nativeCalculation':format(actual.normalize(), 'f'), 'files':files,
                  'nativeFiles':[item for item in files if item['path'].endswith(('.so', '.dylib'))]}, sort_keys=True))
`;
function stateDatabases(state: string): string[] {
  const paths: string[] = [];
  const visit = (root: string, depth: number) => {
    const file = join(root, 'core.sqlite'), info = lstatSync(file, { throwIfNoEntry: false });
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('原状态必须是普通单链接文件。');
      paths.push(file);
    }
    if (depth) for (const item of readdirSync(root, { withFileTypes: true })) {
      if (item.isSymbolicLink()) fail('状态角色路径不能穿过符号链接。');
      if (item.isDirectory()) visit(join(root, item.name), depth - 1);
    }
  };
  visit(state, 2); return paths.sort();
}
function inspect(request: PolarsPythonAdoptionRequest) {
  if (!request.runtimeIdentity || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) fail('必须明确原运行身份与绑定修订。');
  const launcherFile = request.launcherFile ?? launcherPath();
  const runtimeRoot = locateRuntimeRoot(request.runtimeRoot, process.env, launcherFile), locator = readRuntimeLauncher(launcherFile);
  directory(runtimeRoot); directory(request.recordRoot);
  if (locator.runtimeRoot !== runtimeRoot || locator.runtimeIdentity !== request.runtimeIdentity) fail('维护对象与当前启动定位身份不一致。');
  const resources = new ResourceBindings(runtimeRoot), document = resources.document;
  if (document.runtimeIdentity !== request.runtimeIdentity || document.revision !== request.expectedRevision) fail('原运行身份或绑定修订不一致。');
  if (document.resources.polars_python && (document.resources.polars_python.kind !== 'program' || document.resources.polars_python.owned)) fail('不能将其他类型或受管理存储接管为Polars专用程序。');
  const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const protectedRoots = [codeRoot, runtimeRoot, dirname(dirname(request.pythonExecutable)), ...Object.entries(document.resources).filter(([, value]) => value.owned).map(([name]) => resources.path(name))];
  if (protectedRoots.some(root => inside(root, request.recordRoot))) fail('恢复记录必须位于源码、运行资源和目标虚拟环境之外。');
  const bindingPath = join(runtimeRoot, 'config/machine.bindings.json'), before = pinned(bindingPath);
  if (JSON.stringify(JSON.parse(before.raw.toString('utf8'))) !== JSON.stringify(document)) fail('绑定在解析与固定原文之间变化。');
  if (process.getuid && before.uid !== process.getuid()) fail('维护必须由原绑定文件所有者执行。');
  const bundle = capturePolarsEnvironment(request.pythonExecutable);
  if (request.expectedEnvironmentVersion !== undefined && request.expectedEnvironmentVersion !== bundle.environmentVersion) fail('环境摘要与审核版本不同。');
  const target = { path: request.pythonExecutable, kind: 'program' as const, sha256: bundle.environment.programSha256, identity: 'bd.polars-environment/1:' + bundle.environmentVersion };
  const after = json({ ...document, revision: document.revision + 1, resources: { ...document.resources, polars_python: target } });
  const plan = { version: 1, operation: 'adopt-polars-python', runtimeRoot, runtimeIdentity: request.runtimeIdentity,
      expectedRevision: request.expectedRevision, revision: document.revision + 1, launcherFile,
      recordRoot: request.recordRoot, pythonExecutable: request.pythonExecutable, expectedEnvironmentVersion: bundle.environmentVersion,
      environment: bundle.environment, bindingBeforeSha256: sha(before.raw), bindingAfterSha256: sha(after),
      polarsPython: target, requiresStoppedApplication: true, defaultExecutorChanged: false, verificationCalculationOnly: true };
  const planSha256 = 'sha256:' + sha(json(plan));
  if (request.expectedPlanSha256 !== undefined && request.expectedPlanSha256 !== planSha256) fail('采用计划已变化，须重新核对完整计划摘要。');
  return { runtimeRoot, launcherFile, resources, bindingPath, before, after, bundle,
    launcher: pinned(launcherFile), marker: pinned(join(runtimeRoot, '.xuan-runtime.json')), plan: { ...plan, planSha256 } };
}
export function planPolarsPythonAdoption(request: PolarsPythonAdoptionRequest) { return inspect(request).plan; }

/** Only adopts one explicitly verified optional program; does not install packages or change generic Python. */
export async function adoptPolarsPython(request: PolarsPythonAdoptionRequest) {
  if (process.platform !== 'darwin') fail('真实采用仅在macOS验证，其他平台拒绝写入。');
  if (!/^sha256:[a-f0-9]{64}$/u.test(request.expectedEnvironmentVersion ?? '') || !/^sha256:[a-f0-9]{64}$/u.test(request.expectedPlanSha256 ?? '')) fail('apply必须固定plan返回的环境摘要和完整计划摘要。');
  const current = inspect(request);
  assertRuntimeStopped(current.runtimeRoot);
  const startup = acquireRuntimeStartupFence(current.launcherFile, current.runtimeRoot);
  const releases: (() => Promise<void>)[] = [];
  const guardPath = join(current.runtimeRoot, 'config/.bindings-maintenance.lock');
  const id = randomUUID(), record = join(request.recordRoot, `polars-python-${id}`), journalPath = join(record, 'journal.json');
  let journal: Record<string, unknown> | undefined, journalFile: Pinned | undefined, guard: Pinned | undefined, maintenanceStarted = false;
  const save = () => { journalFile = journalFile ? replace(journalPath, json(journal), journalFile) : exclusive(journalPath, json(journal)); };
  const guardBytes = json({ version: 1, operation: 'adopt-polars-python', id, journal: journalPath, runtimeIdentity: request.runtimeIdentity });
  try {
    startup.verify(); assertRuntimeStopped(current.runtimeRoot);
    const startupPath = current.launcherFile + '.runtime-maintenance.lock', startupFile = pinned(startupPath);
    same(current.bindingPath, current.before); same(current.launcherFile, current.launcher);
    const paths = stateDatabases(current.resources.path('state'));
    for (const path of paths) releases.push(await ownStateRoot(path));
    if (JSON.stringify(paths) !== JSON.stringify(stateDatabases(current.resources.path('state')))) fail('取得所有权后状态角色集合变化。');
    startup.verify();
    mkdirSync(record, { mode: 0o700 }); syncDirectory(request.recordRoot);
    exclusive(join(record, 'bindings-before.json'), current.before.raw);
    exclusive(join(record, 'bindings-after.json'), current.after);
    journal = { ...current.plan, id, phase: 'prepared', record, stateOwners: paths,
      originalFile: { mode: current.before.mode, uid: current.before.uid, gid: current.before.gid, device: String(current.before.dev), inode: String(current.before.ino) } };
    save();
    guard = exclusive(guardPath, guardBytes); maintenanceStarted = true;
    same(startupPath, startupFile); same(current.launcherFile, current.launcher); same(join(current.runtimeRoot, '.xuan-runtime.json'), current.marker);
    if (capturePolarsEnvironment(request.pythonExecutable).environmentVersion !== current.bundle.environmentVersion) fail('提交前Polars环境发生变化。');
    same(guardPath, guard);
    replace(current.bindingPath, current.after, current.before);
    if (capturePolarsEnvironment(request.pythonExecutable).environmentVersion !== current.bundle.environmentVersion) fail('提交期间Polars环境发生变化，保留维护现场。');
    journal.phase = 'committed'; save();
    same(guardPath, guard); unlinkSync(guardPath); syncDirectory(dirname(guardPath)); guard = undefined;
    const adopted = new ResourceBindings(current.runtimeRoot);
    if (adopted.document.revision !== current.plan.revision || adopted.path('polars_python') !== request.pythonExecutable
      || adopted.document.resources.polars_python?.identity !== 'bd.polars-environment/1:' + current.bundle.environmentVersion) fail('采用后绑定读回不一致。');
    startup.verify();
    return { status: 'committed', ...current.plan, id, record, journal: journalPath };
  } catch (error) {
    if (maintenanceStarted && !lstatSync(guardPath, { throwIfNoEntry: false })) guard = exclusive(guardPath, guardBytes);
    if (journal) {
      journal.phase = 'failed'; journal.error = error instanceof Error ? error.message : String(error);
      try { journal.observedBindingSha256 = sha(pinned(current.bindingPath).raw); save(); } catch { /* 原文、候选和已有日志继续保留。 */ }
    }
    throw error;
  } finally {
    const settled = await Promise.allSettled(releases.reverse().map(release => release()));
    startup.release();
    if (settled.some(result => result.status === 'rejected')) fail('状态所有权释放未能确认，保留原锁并核对维护记录。');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2), options = new Map<string, string>();
  const allowed = ['python-executable', 'runtime-root', 'runtime-identity', 'launcher', 'expected-revision', 'expected-environment-version', 'expected-plan-sha256', 'record-root'];
  for (const arg of args) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(arg);
    if (!match || !allowed.includes(match[1]!) || options.has(match[1]!)) fail('维护参数无效或重复。');
    options.set(match[1]!, match[2]!);
  }
  const request: PolarsPythonAdoptionRequest = { pythonExecutable: options.get('python-executable') ?? '', runtimeIdentity: options.get('runtime-identity') ?? '',
    expectedRevision: Number(options.get('expected-revision')), recordRoot: options.get('record-root') ?? '',
    runtimeRoot: options.get('runtime-root'), launcherFile: options.get('launcher'), expectedEnvironmentVersion: options.get('expected-environment-version'),
    expectedPlanSha256: options.get('expected-plan-sha256') };
  if (!['plan', 'apply'].includes(mode ?? '')) fail('用法：adopt-polars-python.ts plan|apply --python-executable=明确venv/bin/python绝对路径 --runtime-identity=原身份 --expected-revision=原修订 --record-root=工程外已有目录 [--launcher=启动定位文件] [--runtime-root=运行根] [--expected-environment-version=plan返回环境摘要；apply必填] [--expected-plan-sha256=完整plan摘要；apply必填]');
  console.log(JSON.stringify(mode === 'plan' ? planPolarsPythonAdoption(request) : await adoptPolarsPython(request), null, 2));
}
