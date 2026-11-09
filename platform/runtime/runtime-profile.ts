import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ResourceBindings } from '../resources/bindings.js';
import { DatabaseSync } from 'node:sqlite';

export interface BdRuntimeProfile { version: 1; runtimeRoot: string; runtimeIdentity: string }
export interface RuntimeLauncher { version: 1; runtimeRoot: string; runtimeIdentity: string }
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
function readPinned(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 128_000n) fail('UNSAFE_RUNTIME_FILE', '运行配置必须是有界普通单链接文件。');
    const raw = readFileSync(fd, 'utf8'), after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('RUNTIME_CHANGED', '运行配置在读取期间变化。');
    return raw;
  } finally { closeSync(fd); }
}
function absolute(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) fail('INVALID_RUNTIME_PATH', '运行位置必须是规范绝对路径。');
  return path;
}
function realDirectory(path: string): void {
  absolute(path); const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) fail('UNSAFE_RUNTIME_ROOT', '运行根必须是真实普通目录。');
}
/** 仅显式指定原维护token且原进程已不存在时释放本模块维护锁；不处理Core所有者锁。 */
export function recoverRuntimeMaintenance(fileBase: string, expectedToken: string, expected?: { pid: number; device: string; inode: string; sha256: string }): void {
  absolute(fileBase);
  const path = fileBase + '.runtime-maintenance.lock', identity = lstatSync(path, { bigint: true }), raw = readPinned(path), owner = JSON.parse(raw);
  if (owner.version !== 1 || typeof expectedToken !== 'string' || !expectedToken || owner.token !== expectedToken || !Number.isSafeInteger(owner.pid) || owner.pid < 1) fail('RUNTIME_GUARD_CONFLICT', '原维护锁身份不匹配。');
  if (expected && (owner.pid !== expected.pid || String(identity.dev) !== expected.device || String(identity.ino) !== expected.inode
    || createHash('sha256').update(raw).digest('hex') !== expected.sha256)) fail('RUNTIME_GUARD_CHANGED', '维护锁不再是显式核同的原节点与原字节。');
  try { process.kill(owner.pid, 0); fail('RUNTIME_GUARD_ACTIVE', '原维护进程仍在，拒绝接管。'); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error; }
  const current = lstatSync(path, { bigint: true });
  if (current.dev !== identity.dev || current.ino !== identity.ino || readPinned(path) !== raw) fail('RUNTIME_GUARD_CHANGED', '维护锁已变化，保留现场。');
  unlinkSync(path);
}
/** 与运行维护共用短期围栏，必须保持至状态所有者锁建立并再次verify。 */
export function acquireRuntimeStartupFence(launcherFile: string, runtimeRoot: string, relocation?: { intent: string; connectionId: string }): { verify(): void; release(): void } {
  absolute(launcherFile); realDirectory(dirname(launcherFile));
  const path = launcherFile + '.runtime-maintenance.lock', token = randomUUID();
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600), identity = fstatSync(fd, { bigint: true });
  try { writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, token, runtimeRoot,
    ...(relocation ? { operation: 'relocate-client', intent: relocation.intent, connectionId: relocation.connectionId } : { operation: 'startup' }) })); fsyncSync(fd); }
  finally { closeSync(fd); }
  let released = false;
  const verify = () => {
    if (released) fail('RUNTIME_FENCE_RELEASED', '应用启动围栏已释放。');
    const actual = lstatSync(path, { bigint: true }), owner = JSON.parse(readPinned(path));
    if (actual.dev !== identity.dev || actual.ino !== identity.ino || owner.token !== token) fail('RUNTIME_GUARD_CHANGED', '应用启动围栏身份已变化。');
    const locator = readRuntimeLauncher(launcherFile), profile = readBdRuntime(runtimeRoot);
    if (locator.runtimeRoot !== profile.runtimeRoot || locator.runtimeIdentity !== profile.runtimeIdentity) fail('RUNTIME_LOCATOR_MISMATCH', '启动根与本应用固定身份不一致，请先核对启动定位记录。');
  };
  const release = () => {
    if (released) return;
    const actual = lstatSync(path, { bigint: true }), owner = JSON.parse(readPinned(path));
    if (actual.dev !== identity.dev || actual.ino !== identity.ino || owner.token !== token) fail('RUNTIME_GUARD_CHANGED', '应用启动围栏身份变化，保留现场。');
    unlinkSync(path); released = true;
  };
  try { verify(); return { verify, release }; }
  catch (error) { release(); throw error; }
}
/** 不按进程编号或锁龄自动接管状态所有者。 */
export function assertRuntimeStopped(runtimeRoot: string): void {
  const resources = new ResourceBindings(runtimeRoot), state = resources.path('state');
  const visit = (root: string, depth: number) => {
    if (['.bd-owner.lock', '.harness-owner.lock'].some(name => lstatSync(join(root, name), { throwIfNoEntry: false }))) fail('RUNTIME_IN_USE', '应用仍有状态所有者或未核遗留锁，拒绝维护或切换。');
    if (depth) for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('UNSAFE_RUNTIME_ROOT', '状态根的角色或所有者路径不能穿过符号链接。');
      if (entry.isDirectory()) visit(join(root, entry.name), depth - 1);
    }
  };
  visit(state, 2);
}
/** 只读原账；停进程/释放owner不代表原外部结果已核定。 */
export function assertRuntimeQuiescent(runtimeRoot: string): void {
  const resources = new ResourceBindings(runtimeRoot), state = resources.path('state');
  for (const entry of readdirSync(state, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('UNSAFE_RUNTIME_ROOT', '状态角色不能别名到另一应用。');
    if (!entry.isDirectory()) continue;
    const file = join(state, entry.name, 'core.sqlite'), stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('UNSAFE_RUNTIME_ROOT', '状态数据库不是独立普通单链接文件。');
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(file, { readOnly: true }); database.exec('BEGIN');
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
      const count = (sql: string) => Number(database!.prepare(sql).get()?.n ?? 0);
      const tasks = tables.has('tasks') ? count("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running','waiting','waiting_approval','pausing','cancelling','needs_review') OR requires_review=1 OR json_extract(error,'$.code')='RECOVERY_PENDING'") : 0;
      const effects = tables.has('task_effects') ? count("SELECT COUNT(*) AS n FROM task_effects WHERE status='started'") : 0;
      const workers = tables.has('task_workers') ? count("SELECT COUNT(*) AS n FROM task_workers WHERE kind='tool' AND status<>'exited'") : 0;
      const runs = tables.has('runs') ? count("SELECT COUNT(*) AS n FROM runs WHERE state IN ('running','waiting')") : 0;
      if (tasks || effects || workers || runs) fail('RUNTIME_UNRESOLVED', `原应用仍有未决事实：角色${entry.name}，任务${tasks}、动作${effects}、工具进程${workers}、模型运行${runs}；先沿原身份核对。`);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'RUNTIME_UNRESOLVED') throw error;
      fail('RUNTIME_PREFLIGHT_UNAVAILABLE', '原状态账本无法完整只读核对，拒绝运行维护。');
    } finally { if (database) { try { database.exec('ROLLBACK'); } finally { database.close(); } } }
  }
}
/** 应用身份只来自既有运行标记与本机绑定，不保存数据库用途或重复运行档案。 */
export function readBdRuntime(runtimeRoot: string): BdRuntimeProfile {
  realDirectory(runtimeRoot);
  const resources = new ResourceBindings(runtimeRoot), state = resources.path('state');
  for (const entry of readdirSync(state, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('UNSAFE_RUNTIME_ROOT', '状态角色目录不能别名到其他位置。');
    if (entry.isDirectory()) {
      const database = lstatSync(join(state, entry.name, 'core.sqlite'), { throwIfNoEntry: false });
      if (database && (!database.isFile() || database.isSymbolicLink() || database.nlink !== 1)) fail('UNSAFE_RUNTIME_ROOT', '状态数据库必须是独立普通单链接文件。');
    }
  }
  return { version: 1, runtimeRoot, runtimeIdentity: resources.document.runtimeIdentity };
}
export function readRuntimeLauncher(launcherFile: string): RuntimeLauncher {
  absolute(launcherFile);
  const value: unknown = JSON.parse(readPinned(launcherFile));
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'runtimeIdentity,runtimeRoot,version') fail('INVALID_RUNTIME_LAUNCHER', '启动定位仅登记本应用的固定运行根和身份。');
  const locator = value as RuntimeLauncher;
  if (locator.version !== 1 || typeof locator.runtimeRoot !== 'string' || typeof locator.runtimeIdentity !== 'string' || !locator.runtimeIdentity) fail('INVALID_RUNTIME_LAUNCHER', '启动定位记录缺少固定运行身份。');
  const profile = readBdRuntime(absolute(locator.runtimeRoot));
  if (profile.runtimeIdentity !== locator.runtimeIdentity) fail('RUNTIME_LOCATOR_MISMATCH', '启动定位与运行根身份不一致。');
  return locator;
}
