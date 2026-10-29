import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { ResourceBindings, locateRuntimeRoot } from '../platform/resources/bindings.js';
import { parseProductMachineConnectionProfile } from '../modules/financial/product-machine-connection.js';

/**
 * 受控登记 WFD 产品机器测试连接。
 *
 * 本入口只改 connections_registry 的登记文件，不碰 SQLite、line-selection、旧 prod
 * 默认或任务固定连接。store/runtime/调用者/来源/单位仍由 config_path 的受控配置
 * 提供；合同只核对登记身份，不复制配置内容冒充已生效。
 */
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
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
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (expected === null ? lstatSync(path, { throwIfNoEntry: false }) : sha(readPinned(path)) !== expected) fail('WIRING_CONFLICT', '连接登记或维护意图已变化。');
    renameSync(temporary, path);
    const parent = openSync(resolve(path, '..'), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { if (lstatSync(temporary, { throwIfNoEntry: false })) unlinkSync(temporary); }
};
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export interface ProductMachineWiringContract {
  version: 1;
  kind: 'wfd-product-machine';
  connection_id: string;
  environment: 'user_test';
  config_path: string;
  store: string;
  runtime: string;
  python_path: string;
  entry_path: string;
  harness_root: string;
  harness_root_id: string;
  maintenance_intent: string;
}

export function validateProductMachineWiring(contractValue: unknown, resources: ResourceBindings,
  config?: Record<string, unknown>) {
  const value = record(contractValue) ? contractValue : {};
  if (value.version !== 1 || value.kind !== 'wfd-product-machine'
    || value.environment !== 'user_test' || typeof value.connection_id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.connection_id)
    || typeof value.maintenance_intent !== 'string' || !value.maintenance_intent) {
    fail('WIRING_CONTRACT_INVALID', '需要 version=1、kind=wfd-product-machine、user_test 连接及维护意图。');
  }
  if (value.harness_root !== resources.runtimeRoot
    || value.harness_root_id !== resources.document.runtimeIdentity) {
    fail('WIRING_ROOT_MISMATCH', '合同不属于当前运行根身份。');
  }
  const profile = parseProductMachineConnectionProfile(value);
  if (profile.harness_binding.root !== resources.runtimeRoot
    || profile.harness_binding.root_id !== resources.document.runtimeIdentity) fail('WIRING_ROOT_MISMATCH', '连接登记缺少当前运行根绑定。');
  if (config) {
    if (config.protocol_version !== 'wfd.product-machine-config/0.1'
      || config.connection_id !== profile.id || config.store !== profile.store || config.runtime !== profile.runtime) {
      fail('WIRING_CONFIG_MISMATCH', '受控配置的 connection_id/store/runtime 与合同不同。');
    }
  }
  return { profile, contract: contractValue as unknown as ProductMachineWiringContract };
}

export function adoptProductMachineWiring(options: { contractPath: string; runtimeRoot: string; apply: boolean }) {
  if (!isAbsolute(options.contractPath) || !lstatSync(options.contractPath).isFile()) fail('WIRING_CONTRACT_INVALID', '需要明确的合同文件。');
  const contractRaw = readFileSync(options.contractPath, 'utf8');
  const contractValue: unknown = JSON.parse(contractRaw);
  const resources = new ResourceBindings(options.runtimeRoot);
  let config: Record<string, unknown> | undefined;
  if (record(contractValue) && typeof contractValue.config_path === 'string') {
    config = JSON.parse(readFileSync(contractValue.config_path, 'utf8')) as Record<string, unknown>;
  }
  const contract = contractValue as ProductMachineWiringContract;
  const { profile } = validateProductMachineWiring(contractValue, resources, config);
  const registryPath = resources.document.resources.connections_registry ? resources.path('connections_registry')
    : fail('WIRING_REGISTRY_UNBOUND', 'connections_registry 尚未绑定。');
  const registryRaw = readPinned(registryPath);
  const registry = JSON.parse(registryRaw) as Record<string, unknown>;
  if (!Array.isArray(registry.connections)) fail('WIRING_REGISTRY_INVALID', '连接登记缺少 connections。');
  const connections = registry.connections as unknown[];
  const matches = connections.filter((item: unknown) => record(item) && item.id === profile.id);
  if (matches.length > 1) fail('WIRING_ORIGINAL_IDENTITY_CHANGED', '同一连接 id 重复。');
  const existing = matches[0] as Record<string, unknown> | undefined;
  if (existing && (existing.kind !== profile.kind || existing.config_path !== profile.config_path
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
  if (existing && JSON.stringify(existing) === JSON.stringify(profileRecord)) {
    return { status: 'unchanged', connectionId: profile.id, registryPath, applied: false, entries: connections.length };
  }
  if (!options.apply) {
    return { status: 'ready', connectionId: profile.id, registryPath, applied: false,
      wouldAdd: !existing, entries: connections.length + (existing ? 0 : 1) };
  }
  const next = { ...registry, connections: [...connections.filter((item: unknown) => !record(item) || item.id !== profile.id), profileRecord] };
  const bytes = JSON.stringify(next, null, 2) + '\n';
  const journalPath = registryPath + '.product-machine-wiring.json';
  const journal = { version: 1, id: randomUUID(), phase: 'prepared', contractSha256: sha(contractRaw),
    maintenanceIntent: profile.id, before: sha(registryRaw), after: sha(bytes), at: new Date().toISOString() };
  atomic(journalPath, JSON.stringify(journal, null, 2) + '\n', null);
  let committed = false;
  try {
    atomic(registryPath, bytes, journal.before);
    atomic(journalPath, JSON.stringify({ ...journal, phase: 'committed' }, null, 2) + '\n', sha(JSON.stringify(journal, null, 2) + '\n'));
    committed = true;
  } finally {
    if (committed && lstatSync(journalPath, { throwIfNoEntry: false })) unlinkSync(journalPath);
  }
  return { status: 'committed', connectionId: profile.id, registryPath, applied: true, entries: next.connections.length };
}

const positional = process.argv.slice(2).filter(value => !value.startsWith('--'));
const runtimeArg = process.argv.find(value => value.startsWith('--runtime-root='))?.slice('--runtime-root='.length);
if (positional[0]) {
  try {
    const result = adoptProductMachineWiring({ contractPath: resolve(positional[0]),
      runtimeRoot: runtimeArg ?? locateRuntimeRoot(), apply: process.argv.includes('--apply') });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: (error as { code?: string }).code ?? 'WIRING_FAILED',
      message: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}
