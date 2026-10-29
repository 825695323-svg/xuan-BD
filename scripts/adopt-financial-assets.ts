import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownStateRoot } from '../apps/server/boot.js';
import { ResourceBindings, launcherPath, locateRuntimeRoot } from '../platform/resources/bindings.js';
import { acquireRuntimeStartupFence, assertRuntimeStopped, readRuntimeLauncher } from '../platform/runtime/runtime-profile.js';
import { ASSET_FILES, captureAssets, verifyAssets } from '../plugins/financial/local-compute/assets.js';

export interface FinancialAssetsAdoptionRequest {
  assetsRoot: string;
  runtimeIdentity: string;
  expectedRevision: number;
  recordRoot: string;
  runtimeRoot?: string;
  launcherFile?: string;
  expectedAssetsVersion?: string;
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
function pinned(path: string): Pinned {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 128_000n) fail('维护配置必须是有界普通单链接文件。');
    const raw = readFileSync(fd), after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('维护配置在读取期间变化。');
    return { raw, mode: Number(before.mode) & 0o777, uid: Number(before.uid), gid: Number(before.gid), dev: before.dev, ino: before.ino };
  } finally { closeSync(fd); }
}
function same(path: string, expected: Pinned): void {
  const actual = pinned(path);
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
function capture(root: string) {
  directory(root);
  for (const name of ASSET_FILES) {
    const info = lstatSync(join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('计算资产五文件须为原目录内普通单链接文件。');
  }
  const bundle = captureAssets(root); verifyAssets(bundle); return bundle;
}
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
function inspect(request: FinancialAssetsAdoptionRequest) {
  if (!request.runtimeIdentity || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) fail('必须明确原运行身份与绑定修订。');
  const launcherFile = request.launcherFile ?? launcherPath();
  const runtimeRoot = locateRuntimeRoot(request.runtimeRoot, process.env, launcherFile), locator = readRuntimeLauncher(launcherFile);
  directory(runtimeRoot); directory(request.assetsRoot); directory(request.recordRoot);
  if (locator.runtimeRoot !== runtimeRoot || locator.runtimeIdentity !== request.runtimeIdentity) fail('维护对象与当前启动定位身份不一致。');
  const resources = new ResourceBindings(runtimeRoot), document = resources.document;
  if (document.runtimeIdentity !== request.runtimeIdentity || document.revision !== request.expectedRevision) fail('原运行身份或绑定修订不一致。');
  if (document.resources.compute_assets && (document.resources.compute_assets.kind !== 'directory' || document.resources.compute_assets.owned)) fail('不能将其他类型或受管理存储接管为外部计算资产。');
  const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const protectedRoots = [codeRoot, runtimeRoot, request.assetsRoot, ...Object.entries(document.resources).filter(([, value]) => value.owned).map(([name]) => resources.path(name))];
  if (protectedRoots.some(root => inside(root, request.recordRoot))) fail('恢复记录必须位于源码、运行资源和原资产之外。');
  const bindingPath = join(runtimeRoot, 'config/machine.bindings.json'), before = pinned(bindingPath);
  if (JSON.stringify(JSON.parse(before.raw.toString('utf8'))) !== JSON.stringify(document)) fail('绑定在解析与固定原文之间变化。');
  if (process.getuid && before.uid !== process.getuid()) fail('维护必须由原绑定文件所有者执行。');
  const bundle = capture(request.assetsRoot);
  if (request.expectedAssetsVersion !== undefined && request.expectedAssetsVersion !== bundle.version) fail('资产摘要与审核版本不同。');
  const target = { path: request.assetsRoot, kind: 'directory' as const, identity: bundle.version };
  const after = json({ ...document, revision: document.revision + 1, resources: { ...document.resources, compute_assets: target } });
  return { runtimeRoot, launcherFile, resources, bindingPath, before, after, bundle,
    launcher: pinned(launcherFile), marker: pinned(join(runtimeRoot, '.xuan-runtime.json')),
    plan: { version: 1, operation: 'adopt-financial-assets', runtimeRoot, runtimeIdentity: request.runtimeIdentity,
      expectedRevision: request.expectedRevision, revision: document.revision + 1, launcherFile,
      recordRoot: request.recordRoot, assetsRoot: request.assetsRoot, expectedAssetsVersion: bundle.version,
      assetHashes: bundle.hashes, bindingBeforeSha256: sha(before.raw), bindingAfterSha256: sha(after),
      computeAssets: target, requiresStoppedApplication: true, pluginEnabledByAdoption: false, calculationsExecuted: false } };
}
export function planFinancialAssetsAdoption(request: FinancialAssetsAdoptionRequest) { return inspect(request).plan; }

/** 只采用已审核五文件的外部引用；不启用插件、不执行计算、不打开业务数据库。 */
export async function adoptFinancialAssets(request: FinancialAssetsAdoptionRequest) {
  if (process.platform !== 'darwin') fail('真实采用仅在macOS验证，其他平台拒绝写入。');
  if (!/^sha256:[a-f0-9]{64}$/u.test(request.expectedAssetsVersion ?? '')) fail('apply必须固定plan返回的expectedAssetsVersion。');
  const current = inspect(request);
  assertRuntimeStopped(current.runtimeRoot);
  const startup = acquireRuntimeStartupFence(current.launcherFile, current.runtimeRoot);
  const releases: (() => Promise<void>)[] = [];
  const guardPath = join(current.runtimeRoot, 'config/.bindings-maintenance.lock');
  const id = randomUUID(), record = join(request.recordRoot, `financial-assets-${id}`), journalPath = join(record, 'journal.json');
  let journal: Record<string, unknown> | undefined, journalFile: Pinned | undefined, guard: Pinned | undefined, maintenanceStarted = false;
  const save = () => { journalFile = journalFile ? replace(journalPath, json(journal), journalFile) : exclusive(journalPath, json(journal)); };
  const guardBytes = json({ version: 1, operation: 'adopt-financial-assets', id, journal: journalPath, runtimeIdentity: request.runtimeIdentity });
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
    if (capture(request.assetsRoot).version !== current.bundle.version) fail('提交前计算资产发生变化。');
    same(guardPath, guard);
    replace(current.bindingPath, current.after, current.before);
    if (capture(request.assetsRoot).version !== current.bundle.version) fail('提交期间计算资产发生变化，保留维护现场。');
    journal.phase = 'committed'; save();
    same(guardPath, guard); unlinkSync(guardPath); syncDirectory(dirname(guardPath)); guard = undefined;
    const adopted = new ResourceBindings(current.runtimeRoot);
    if (adopted.document.revision !== current.plan.revision || adopted.path('compute_assets') !== request.assetsRoot
      || adopted.document.resources.compute_assets?.identity !== current.bundle.version) fail('采用后绑定读回不一致。');
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
  const allowed = ['assets-root', 'runtime-root', 'runtime-identity', 'launcher', 'expected-revision', 'expected-assets-version', 'record-root'];
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(arg);
    if (!match || !allowed.includes(match[1]!) || options.has(match[1]!)) fail('维护参数无效或重复。');
    options.set(match[1]!, match[2]!);
  }
  const request: FinancialAssetsAdoptionRequest = { assetsRoot: options.get('assets-root') ?? '', runtimeIdentity: options.get('runtime-identity') ?? '',
    expectedRevision: Number(options.get('expected-revision')), recordRoot: options.get('record-root') ?? '',
    runtimeRoot: options.get('runtime-root'), launcherFile: options.get('launcher'), expectedAssetsVersion: options.get('expected-assets-version') };
  if (!['plan', 'apply'].includes(mode ?? '')) fail('用法：adopt-financial-assets.ts plan|apply --assets-root=绝对目录 --runtime-identity=原身份 --expected-revision=原修订 --record-root=工程外已有目录 [--launcher=启动定位文件] [--runtime-root=运行根] [--expected-assets-version=plan返回的摘要；apply必填]');
  console.log(JSON.stringify(mode === 'plan' ? planFinancialAssetsAdoption(request) : await adoptFinancialAssets(request), null, 2));
}
