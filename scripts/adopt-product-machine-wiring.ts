import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { ResourceBindings, locateRuntimeRoot } from '../platform/resources/bindings.js';
import { parseProductMachineConnectionProfile } from '../modules/financial/product-machine-connection.js';

/**
 * 受控登记 WFD 产品机器连接；正式 R1 选择与新连接在同一登记写入。
 *
 * 本入口只改 connections_registry 的登记文件，不碰 SQLite、业务数据
 * 默认或任务固定连接。store/runtime/调用者/来源/单位仍由 config_path 的受控配置
 * 提供；ready/committed 只报告本次登记一致性，不证明完整运行时、schema 或 WFD 能力可用。
 * wx 日志只围栏同入口合作写者，不是对绕过本入口的外部编辑提供原子 CAS。
 */
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function writeAll(fd: number, value: string,
  write: (fd: number, bytes: Uint8Array, offset: number, length: number, position: number) => number = writeSync): void {
  const bytes = Buffer.from(value, 'utf8');
  for (let offset = 0; offset < bytes.length;) {
    const written = write(fd, bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
      fail('WIRING_SHORT_WRITE', '登记写入没有取得完整进度；保留原文件。');
    }
    offset += written;
  }
}
const readPinned = (path: string): string => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_048_576) return fail('WIRING_REGISTRY_UNSAFE', '连接登记必须是有界普通单链接文件。');
  const raw = readFileSync(path, 'utf8');
  if (sha(readFileSync(path)) !== sha(raw)) return fail('WIRING_CONFLICT', '连接登记读取期间发生变化。');
  return raw;
};
const atomic = (path: string, bytes: string, expected: string | null): void => {
  const temporary = path + '.product-machine-' + randomUUID();
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeAll(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    const staged = readPinned(temporary);
    if (Buffer.byteLength(staged) !== Buffer.byteLength(bytes) || sha(staged) !== sha(bytes)) {
      fail('WIRING_STAGED_CHANGED', '临时登记内容长度或摘要与固定目标不同。');
    }
    if (expected === null ? lstatSync(path, { throwIfNoEntry: false }) : sha(readPinned(path)) !== expected) fail('WIRING_CONFLICT', '连接登记或维护意图已变化。');
    renameSync(temporary, path);
    const parent = openSync(resolve(path, '..'), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary); }
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
interface WiringJournal {
  version: 2; kind: 'product-machine-wiring'; id: string; phase: 'prepared'; pid: number;
  contractSha256: string; maintenanceIntent: string; registryPath: string;
  runtimeRoot: string; runtimeIdentity: string; connectionId: string;
  before: string; after: string; at: string;
}
function syncParent(path: string): void {
  const parent = openSync(resolve(path, '..'), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
function createJournal(path: string, journal: WiringJournal): string {
  const bytes = JSON.stringify(journal, null, 2) + '\n';
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') fail('WIRING_PENDING', '已有连接采用维护日志；须按原合同显式恢复。');
    throw error;
  }
  try { writeAll(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  if (sha(readPinned(path)) !== sha(bytes)) fail('WIRING_STAGED_CHANGED', '维护日志写入后内容与原意图不同。');
  syncParent(path);
  return bytes;
}
function recoverJournal(path: string, expected: { contractSha256: string; maintenanceIntent: string;
  registryPath: string; runtimeRoot: string; runtimeIdentity: string; connectionId: string }, registryRaw: string) {
  let raw: string, value: unknown;
  try { raw = readPinned(path); value = JSON.parse(raw); }
  catch { return fail('WIRING_JOURNAL_INVALID', '原采用维护日志不可读取或解析；保留现场。'); }
  const journal = record(value) ? value : {};
  if (journal.version !== 2 || journal.kind !== 'product-machine-wiring' || journal.phase !== 'prepared'
    || typeof journal.id !== 'string' || !journal.id || typeof journal.at !== 'string'
    || !Number.isSafeInteger(journal.pid) || Number(journal.pid) < 1
    || journal.contractSha256 !== expected.contractSha256 || journal.maintenanceIntent !== expected.maintenanceIntent
    || journal.registryPath !== expected.registryPath || journal.runtimeRoot !== expected.runtimeRoot
    || journal.runtimeIdentity !== expected.runtimeIdentity || journal.connectionId !== expected.connectionId
    || typeof journal.before !== 'string' || !/^[a-f0-9]{64}$/u.test(journal.before)
    || typeof journal.after !== 'string' || !/^[a-f0-9]{64}$/u.test(journal.after)
    || journal.before === journal.after) fail('WIRING_JOURNAL_INVALID', '维护日志不是本合同、运行根和原意图的固定记录；保留现场。');
  let ownerActive = true;
  try { process.kill(Number(journal.pid), 0); }
  catch (error) {
    if ((error as { code?: string }).code === 'ESRCH') ownerActive = false;
    else if ((error as { code?: string }).code !== 'EPERM') throw error;
  }
  if (ownerActive) fail('WIRING_ACTIVE', '原采用进程仍可能持有维护围栏；保留日志。');
  const current = sha(registryRaw);
  if (current !== journal.before && current !== journal.after) fail('WIRING_RECOVERY_CONFLICT', '连接登记既不是原件也不是本次目标；保留维护日志。');
  if (readPinned(path) !== raw || sha(readPinned(expected.registryPath)) !== current) {
    fail('WIRING_RECOVERY_CONFLICT', '恢复核对期间维护日志或登记变化；保留现场。');
  }
  unlinkSync(path);
  return { status: current === journal.after ? 'recovered_committed' : 'recovered_not_applied',
    connectionId: expected.connectionId, registryPath: expected.registryPath, applied: false };
}
function recoveryContract(value: unknown, resources: ResourceBindings): { connectionId: string; maintenanceIntent: string } {
  const input = record(value) ? value : {};
  if (input.version !== 1 || input.kind !== 'wfd-product-machine'
    || typeof input.connection_id !== 'string' || !ID.test(input.connection_id)
    || input.id !== input.connection_id || !['user_test', 'production'].includes(String(input.environment))
    || input.mode !== input.environment || input.purpose !== input.environment
    || typeof input.maintenance_intent !== 'string' || !input.maintenance_intent
    || input.harness_root !== resources.runtimeRoot || input.harness_root_id !== resources.document.runtimeIdentity
    || !record(input.harness_binding) || input.harness_binding.root !== resources.runtimeRoot
    || input.harness_binding.root_id !== resources.document.runtimeIdentity) {
    fail('WIRING_JOURNAL_INVALID', '恢复合同的连接、维护意图或受信运行根身份不符；保留日志。');
  }
  return { connectionId: input.connection_id as string, maintenanceIntent: input.maintenance_intent as string };
}

export interface ProductMachineWiringContract {
  version: 1;
  kind: 'wfd-product-machine';
  connection_id: string;
  environment: 'user_test' | 'production';
  id: string;
  mode: 'user_test' | 'production';
  purpose: 'user_test' | 'production';
  protocol: 'wfd.product-machine/0.1';
  harness_binding: { root: string; root_id: string };
  profile?: 'data_only';
  manual_ingest_connection_id?: string;
  config_path: string;
  store: string;
  runtime: string;
  python_path: string;
  entry_path: string;
  harness_root: string;
  harness_root_id: string;
  maintenance_intent: string;
}

export function validateProductMachineWiring(contractValue: unknown, resources: ResourceBindings) {
  const value = record(contractValue) ? contractValue : {};
  const production = value.environment === 'production';
  if (value.version !== 1 || value.kind !== 'wfd-product-machine'
    || !['user_test', 'production'].includes(String(value.environment)) || typeof value.connection_id !== 'string'
    || !ID.test(value.connection_id)
    || typeof value.maintenance_intent !== 'string' || !value.maintenance_intent) {
    fail('WIRING_CONTRACT_INVALID', '需要明确的版本、连接身份、用途及维护意图。');
  }
  if (value.id !== value.connection_id || value.mode !== value.environment || value.purpose !== value.environment
    || !record(value.harness_binding) || value.harness_binding.root !== value.harness_root
    || value.harness_binding.root_id !== value.harness_root_id) {
    fail('WIRING_CONTRACT_MISMATCH', '合同两组连接 ID、用途或运行根身份不一致。');
  }
  if (production ? value.profile !== 'data_only'
    || value.manual_ingest_connection_id !== value.connection_id : value.manual_ingest_connection_id !== undefined) {
    fail('WIRING_CONTRACT_INVALID', '正式手动投喂须显式选择 production（正式生产）、data_only（仅数据）连接；用户测试合同不改变手动选择。');
  }
  if (value.harness_root !== resources.runtimeRoot
    || value.harness_root_id !== resources.document.runtimeIdentity) {
    fail('WIRING_ROOT_MISMATCH', '合同不属于当前运行根身份。');
  }
  const profile = parseProductMachineConnectionProfile(value, { allowProduction: production });
  if (profile.harness_binding.root !== resources.runtimeRoot
    || profile.harness_binding.root_id !== resources.document.runtimeIdentity) fail('WIRING_ROOT_MISMATCH', '连接登记缺少当前运行根绑定。');
  let config: unknown;
  try { config = JSON.parse(readPinned(profile.config_path)); }
  catch { fail('WIRING_CONFIG_MISMATCH', '受控配置不可读取或解析。'); }
  const checkedConfig = record(config) ? config : fail('WIRING_CONFIG_MISMATCH', '受控配置须为结构化对象。');
  if (checkedConfig.protocol_version !== 'wfd.product-machine-config/0.1'
    || checkedConfig.connection_id !== profile.id || checkedConfig.store !== profile.store || checkedConfig.runtime !== profile.runtime) {
    fail('WIRING_CONFIG_MISMATCH', '受控配置的 connection_id/store/runtime 与合同不同。');
  }
  if (production && checkedConfig.profile !== 'data_only') fail('WIRING_CONFIG_MISMATCH', '正式手动投喂连接的实际配置必须是 data_only。');
  return { profile, contract: contractValue as unknown as ProductMachineWiringContract };
}

export function adoptProductMachineWiring(options: { contractPath: string; runtimeRoot: string; apply: boolean; recover?: boolean }) {
  if (options.apply && options.recover) fail('WIRING_CONTRACT_INVALID', '--apply 与 --recover 不能同时使用。');
  if (!isAbsolute(options.contractPath)) fail('WIRING_CONTRACT_INVALID', '需要明确的合同文件。');
  const contractRaw = readPinned(options.contractPath);
  const contractValue: unknown = JSON.parse(contractRaw);
  const resources = new ResourceBindings(options.runtimeRoot);
  const registryPath = resources.document.resources.connections_registry ? resources.path('connections_registry')
    : fail('WIRING_REGISTRY_UNBOUND', 'connections_registry 尚未绑定。');
  const registryRaw = readPinned(registryPath);
  const journalPath = registryPath + '.product-machine-wiring.json';
  if (options.recover) {
    const original = recoveryContract(contractValue, resources);
    return recoverJournal(journalPath, { contractSha256: sha(contractRaw),
      maintenanceIntent: original.maintenanceIntent, registryPath, runtimeRoot: resources.runtimeRoot,
      runtimeIdentity: resources.document.runtimeIdentity, connectionId: original.connectionId }, registryRaw);
  }
  if (lstatSync(journalPath, { throwIfNoEntry: false })) fail('WIRING_PENDING', '已有连接采用维护日志；须按原合同显式恢复。');
  const { profile, contract } = validateProductMachineWiring(contractValue, resources);
  const registry = JSON.parse(registryRaw) as Record<string, unknown>;
  if (!Array.isArray(registry.connections)) fail('WIRING_REGISTRY_INVALID', '连接登记缺少 connections。');
  const connections = registry.connections as unknown[];
  const selected = registry.manual_ingest_connection_id;
  if (selected !== undefined && (typeof selected !== 'string' || !ID.test(selected)
    || connections.filter((item: unknown) => record(item) && item.id === selected).length !== 1)) {
    fail('WIRING_SELECTION_INVALID', '原手动投喂选择不对应唯一有效登记。');
  }
  if (contract.environment === 'production' && selected !== undefined && selected !== profile.id) {
    fail('WIRING_SELECTION_CHANGED', '已有手动投喂选择属于另一逻辑连接，不能覆盖。');
  }
  const matches = connections.filter((item: unknown) => record(item) && item.id === profile.id);
  if (matches.length > 1) fail('WIRING_ORIGINAL_IDENTITY_CHANGED', '同一连接 id 重复。');
  const existing = matches[0] as Record<string, unknown> | undefined;
  if (existing && (existing.kind !== profile.kind || existing.mode !== profile.mode || existing.purpose !== profile.purpose
    || existing.protocol !== profile.protocol || !record(existing.harness_binding)
    || existing.harness_binding.root !== profile.harness_binding.root
    || existing.harness_binding.root_id !== profile.harness_binding.root_id || existing.config_path !== profile.config_path
    || existing.store !== profile.store || existing.runtime !== profile.runtime
    || existing.python_path !== profile.python_path || existing.entry_path !== profile.entry_path)) {
    fail('WIRING_ORIGINAL_IDENTITY_CHANGED', '已有连接逻辑身份不同，不能覆盖。');
  }
  const profileRecord = {
    id: profile.id, kind: profile.kind, mode: profile.mode, purpose: profile.purpose,
    protocol: profile.protocol, config_path: profile.config_path, store: profile.store,
    runtime: profile.runtime, python_path: profile.python_path, entry_path: profile.entry_path,
    harness_binding: profile.harness_binding,
  };
  if (existing && (contract.environment !== 'production' || selected === profile.id)) {
    return { status: 'unchanged', connectionId: profile.id, registryPath, applied: false, entries: connections.length };
  }
  if (!options.apply) {
    return { status: 'ready', connectionId: profile.id, registryPath, applied: false,
      wouldAdd: !existing, wouldSelect: contract.environment === 'production' && selected !== profile.id,
      entries: connections.length + (existing ? 0 : 1) };
  }
  const next = { ...registry, connections: existing ? connections : [...connections, profileRecord],
    ...(contract.environment === 'production' ? { manual_ingest_connection_id: profile.id } : {}) };
  const bytes = JSON.stringify(next, null, 2) + '\n';
  const journal: WiringJournal = { version: 2, kind: 'product-machine-wiring', id: randomUUID(), phase: 'prepared', pid: process.pid,
    contractSha256: sha(contractRaw), maintenanceIntent: contract.maintenance_intent,
    registryPath, runtimeRoot: resources.runtimeRoot, runtimeIdentity: resources.document.runtimeIdentity,
    connectionId: profile.id, before: sha(registryRaw), after: sha(bytes), at: new Date().toISOString() };
  const journalRaw = createJournal(journalPath, journal);
  if (sha(readPinned(registryPath)) !== journal.before) fail('WIRING_CONFLICT', '取得维护围栏后连接登记已变化；保留日志待核。');
  atomic(registryPath, bytes, journal.before);
  if (readPinned(registryPath) !== bytes) fail('WIRING_CONFLICT', '登记写入后读回不是本次固定目标。');
  if (readPinned(journalPath) !== journalRaw) fail('WIRING_JOURNAL_INVALID', '维护日志在提交期间变化；保留现场。');
  unlinkSync(journalPath);
  return { status: 'committed', connectionId: profile.id, registryPath, applied: true, entries: next.connections.length };
}

const positional = process.argv.slice(2).filter(value => !value.startsWith('--'));
const runtimeArg = process.argv.find(value => value.startsWith('--runtime-root='))?.slice('--runtime-root='.length);
if (positional[0]) {
  try {
    const result = adoptProductMachineWiring({ contractPath: resolve(positional[0]),
      runtimeRoot: runtimeArg ?? locateRuntimeRoot(), apply: process.argv.includes('--apply'), recover: process.argv.includes('--recover') });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: (error as { code?: string }).code ?? 'WIRING_FAILED',
      message: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}
