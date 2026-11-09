import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResourceBindings, type MachineBindingDocument } from '../platform/resources/bindings.js';

interface Expected { runtimeRoot: string; runtimeIdentity: string; revision: number }
interface RootCheck { name: string; path: string; identity: string; inode: string; fromDevice: string; toDevice: string }
export interface DeviceRepairPlan extends Expected {
  version: 1;
  operation: 'repair-runtime-device';
  manifestSha256: string;
  manifestMode: number;
  manifestUid: number;
  manifestGid: number;
  roots: RootCheck[];
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
function fail(message: string): never { throw new Error(message); }
const pathExists = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });
const contains = (parent: string, path: string) => { const part = relative(parent, path); return !part || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)); };

function readPinned(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 128_000n) fail('维护输入必须是有界普通单链接文件。');
    const value = readFileSync(fd, 'utf8'), after = fstatSync(fd, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('维护输入在读取期间发生变化。');
    return value;
  } finally { closeSync(fd); }
}
function assertStopped(stateRoot: string): void {
  for (const root of [stateRoot, ...readdirSync(stateRoot, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => join(stateRoot, x.name))]) {
    if (['.bd-owner.lock', '.harness-owner.lock'].some(name => pathExists(join(root, name)))) fail('存在现行状态所有者锁；维护不会按进程编号或锁龄接管。');
  }
}
function inspect(expected: Expected, ignoreMaintenanceLock = false): { plan: DeviceRepairPlan; original: string; document: MachineBindingDocument } {
  const root = expected.runtimeRoot;
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root || !expected.runtimeIdentity || !Number.isSafeInteger(expected.revision)) fail('需要真实绝对工作根、原身份和原修订。');
  if (!ignoreMaintenanceLock && pathExists(join(root, 'config/.bindings-maintenance.lock'))) fail('另一份资源维护尚未完成。');
  const marker = JSON.parse(readPinned(join(root, '.xuan-runtime.json')));
  const original = readPinned(join(root, 'config/machine.bindings.json'));
  const manifestStat = lstatSync(join(root, 'config/machine.bindings.json'));
  if (manifestStat.uid !== process.getuid?.()) fail('维护必须由原绑定文件所有者执行。');
  const document = JSON.parse(original) as MachineBindingDocument;
  if (marker.application !== 'xuan-bd' || marker.version !== 1 || marker.identity !== expected.runtimeIdentity
    || document.version !== 1 || document.runtimeIdentity !== expected.runtimeIdentity || document.revision !== expected.revision
    || !document.resources || typeof document.resources !== 'object' || Array.isArray(document.resources)) fail('原实例身份或绑定修订不一致。');
  const roots: RootCheck[] = [], mappings = new Map<string, string>();
  for (const [name, binding] of Object.entries(document.resources)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(name) || !binding || typeof binding.path !== 'string' || !binding.path
      || binding.path.includes('\0') || !['directory', 'file', 'program'].includes(binding.kind)) fail('资源登记格式无效。');
    if (!isAbsolute(binding.path) && (/[\\:\u0000-\u001f]/u.test(binding.path) || binding.path.split('/').some(x => !x || x === '.' || x === '..'))) fail('资源相对位置无效。');
    if (!binding.owned) continue;
    if (binding.kind !== 'directory' || !binding.identity || !/^\d+$/u.test(binding.device ?? '') || !/^\d+$/u.test(binding.inode ?? '')) fail('受管理根缺少完整原身份。');
    const path = resolve(root, binding.path), stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || String(stat.ino) !== binding.inode) fail(`资源 ${name} 的位置或文件节点已变化，拒绝设备编号修复。`);
    if (roots.some(other => contains(other.path, path) || contains(path, other.path))) fail('受管理根发生重叠。');
    const fromDevice = binding.device!, toDevice = String(stat.dev);
    if (mappings.has(fromDevice) && mappings.get(fromDevice) !== toDevice) fail('同一旧设备对应多个当前设备，拒绝推断迁移。');
    mappings.set(fromDevice, toDevice);
    roots.push({ name, path, identity: binding.identity, inode: binding.inode!, fromDevice, toDevice });
  }
  if (!document.resources.state?.owned || !roots.some(x => x.name === 'config') || !roots.length) fail('缺少受管理配置或状态根。');
  assertStopped(resolve(root, document.resources.state.path));
  return { plan: { version: 1, operation: 'repair-runtime-device', ...expected, manifestSha256: sha256(original), manifestMode: manifestStat.mode & 0o777, manifestUid: manifestStat.uid, manifestGid: manifestStat.gid, roots }, original, document };
}

/** 显式维护只接受路径、逻辑身份和 inode 未变的设备编号变化，不接入新资源。 */
export function planRuntimeDeviceRepair(expected: Expected): DeviceRepairPlan {
  const { plan } = inspect(expected);
  if (!plan.roots.some(x => x.fromDevice !== x.toDevice)) fail('设备编号没有变化，无需维护。');
  return plan;
}
export function applyRuntimeDeviceRepair(plan: DeviceRepairPlan, expected: Expected): void {
  if (plan.version !== 1 || plan.operation !== 'repair-runtime-device' || plan.runtimeRoot !== expected.runtimeRoot
    || plan.runtimeIdentity !== expected.runtimeIdentity || plan.revision !== expected.revision) fail('维护计划与明确指定的原实例不一致。');
  if (!plan.roots.some(x => x.fromDevice !== x.toDevice)) fail('设备编号没有变化，无需维护。');
  const first = inspect(expected);
  if (JSON.stringify(first.plan) !== JSON.stringify(plan)) fail('维护计划已失效，原绑定或现场对象发生变化。');
  const guard = join(expected.runtimeRoot, 'config/.bindings-maintenance.lock');
  const fd = openSync(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const guardIdentity = fstatSync(fd, { bigint: true });
  let temporary: string | undefined;
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid, operation: plan.operation }) + '\n');
    fsyncSync(fd);
    const current = inspect(expected, true);
    if (JSON.stringify(current.plan) !== JSON.stringify(plan)) fail('取得维护锁后现场发生变化。');
    for (const root of plan.roots) current.document.resources[root.name]!.device = root.toDevice;
    current.document.revision += 1;
    const manifest = join(expected.runtimeRoot, 'config/machine.bindings.json');
    temporary = manifest + '.repair-' + randomUUID();
    const output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, plan.manifestMode);
    try {
      const metadata = fstatSync(output);
      if (metadata.uid !== plan.manifestUid || metadata.gid !== plan.manifestGid) fail('新绑定文件无法保持原所有者和组。');
      fchmodSync(output, plan.manifestMode);
      writeFileSync(output, JSON.stringify(current.document, null, 2) + '\n'); fsyncSync(output);
    }
    finally { closeSync(output); }
    if (sha256(readPinned(manifest)) !== plan.manifestSha256) fail('提交前原绑定已经变化。');
    assertStopped(resolve(expected.runtimeRoot, current.document.resources.state!.path));
    renameSync(temporary, manifest);
    temporary = undefined;
    const directory = openSync(dirname(manifest), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (temporary) unlinkSync(temporary);
    closeSync(fd);
    const now = lstatSync(guard, { bigint: true });
    if (now.dev !== guardIdentity.dev || now.ino !== guardIdentity.ino) fail('维护锁身份变化，保留现场。');
    unlinkSync(guard);
  }
  new ResourceBindings(expected.runtimeRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = new Map<string, string>();
    for (const arg of process.argv.slice(2)) {
      const match = /^--([a-z-]+)=(.+)$/u.exec(arg);
      if (!match || options.has(match[1]!) || !['mode', 'runtime-root', 'runtime-identity', 'expected-revision', 'plan'].includes(match[1]!)) fail('维护参数无效或重复。');
      options.set(match[1]!, match[2]!);
    }
    const expected = { runtimeRoot: options.get('runtime-root') ?? '', runtimeIdentity: options.get('runtime-identity') ?? '', revision: Number(options.get('expected-revision')) };
    const path = options.get('plan') ?? '';
    if (!isAbsolute(path) || realpathSync(dirname(path)) !== dirname(path)) fail('计划必须位于明确的真实绝对目录。');
    const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    for (const protectedRoot of [expected.runtimeRoot, project]) {
      const rel = relative(protectedRoot, path);
      if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) fail('计划与改前原文必须保存在运行根及源码外。');
    }
    if (options.get('mode') === 'plan') {
      const plan = planRuntimeDeviceRepair(expected);
      const original = readPinned(join(expected.runtimeRoot, 'config/machine.bindings.json'));
      if (sha256(original) !== plan.manifestSha256) fail('保存计划前原文变化。');
      writeFileSync(path + '.bindings-before.json', original, { flag: 'wx', mode: 0o600 });
      writeFileSync(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ status: 'planned', plan: path, changedRoots: plan.roots.filter(x => x.fromDevice !== x.toDevice).map(x => x.name) }));
    } else if (options.get('mode') === 'apply') {
      const plan = JSON.parse(readPinned(path)) as DeviceRepairPlan;
      if (sha256(readPinned(path + '.bindings-before.json')) !== plan.manifestSha256) fail('改前原文与计划不一致。');
      applyRuntimeDeviceRepair(plan, expected);
      console.log(JSON.stringify({ status: 'committed', revision: expected.revision + 1, runtimeIdentity: expected.runtimeIdentity }));
    } else fail('mode 只接受 plan 或 apply。');
  } catch (error) {
    console.error(error instanceof Error ? error.message : '维护未完成。');
    process.exitCode = 1;
  }
}
