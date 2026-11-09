import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { readConnectionRegistry, registeredConnection } from '../../platform/config/connections.js';
import { ConfigError } from '../../platform/runtime/errors.js';
import type { ResourceBindings } from '../../platform/resources/bindings.js';
import { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import { createWfdProductMachineSnapshotPort } from './product-machine-snapshot.js';
import type { AlgorithmSnapshotPort } from './algorithm-types.js';

/**
 * 已登记的 WFD 产品机器连接。
 *
 * 连接登记只保存逻辑身份、受控配置路径与公开入口位置；store/runtime、调用者
 * namespace、角色、来源策略和单位仍只由 config_path 指向的受控配置提供。BD 侧
 * 不接受请求或调用方覆盖这些根。
 */
interface ProductMachineConnectionProfileBase {
  id: string;
  kind: 'wfd-product-machine';
  protocol: 'wfd.product-machine/0.1';
  config_path: string;
  store: string;
  runtime: string;
  python_path: string;
  entry_path: string;
  harness_binding: { root: string; root_id: string };
}
export type ProductMachineConnectionProfile = ProductMachineConnectionProfileBase &
  ({ mode: 'user_test'; purpose: 'user_test' } | { mode: 'production'; purpose: 'production' });

export interface ResolvedProductMachineConnection {
  connectionId: string;
  configPath: string;
  store: string;
  runtime: string;
  callerId: string;
  trustedActorNamespace: string;
  schemaPath: string;
  client: WfdProductMachineClient;
  snapshotPort: AlgorithmSnapshotPort;
  profile: ProductMachineConnectionProfile;
}

const fail = (message: string): never => { throw new ConfigError(message); };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const absoluteFile = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) return fail(`${label}需要明确的绝对路径。`);
  let stat;
  try { stat = lstatSync(value); } catch { return fail(`${label}当前不可达。`); }
  if (!stat.isFile() || stat.isSymbolicLink()) return fail(`${label}必须是无符号链接的普通文件。`);
  if (realpathSync(value) !== resolve(value)) return fail(`${label}包含非规范路径。`);
  return value;
};
const absoluteProgram = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) return fail(`${label}需要明确的绝对路径。`);
  let stat;
  try { stat = statSync(value); } catch { return fail(`${label}当前不可达。`); }
  if (!stat.isFile()) return fail(`${label}必须指向普通文件。`);
  return value;
};

const absoluteDir = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) return fail(`${label}需要明确的绝对路径。`);
  let stat;
  try { stat = lstatSync(value); } catch { return fail(`${label}当前不可达。`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return fail(`${label}必须是无符号链接的目录。`);
  if (realpathSync(value) !== resolve(value)) return fail(`${label}包含非规范路径。`);
  return value;
};

export function parseProductMachineConnectionProfile(value: unknown,
  options: { allowProduction?: boolean } = {}): ProductMachineConnectionProfile {
  if (!record(value) || value.kind !== 'wfd-product-machine'
    || !((value.mode === 'user_test' && value.purpose === 'user_test')
      || (options.allowProduction === true && value.mode === 'production' && value.purpose === 'production'))
    || value.protocol !== 'wfd.product-machine/0.1'
    || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.id)) {
    return fail('连接不是当前入口允许的受控 WFD 产品机器连接。');
  }
  const bd = record(value.harness_binding) ? value.harness_binding : {};
  const usage = value.mode === 'production'
    ? { mode: 'production' as const, purpose: 'production' as const }
    : { mode: 'user_test' as const, purpose: 'user_test' as const };
  return {
    id: value.id,
    kind: 'wfd-product-machine',
    ...usage,
    protocol: 'wfd.product-machine/0.1',
    config_path: absoluteFile(value.config_path, 'config_path'),
    store: absoluteDir(value.store, 'store'),
    runtime: absoluteDir(value.runtime, 'runtime'),
    python_path: absoluteProgram(value.python_path, 'python_path'),
    entry_path: absoluteFile(value.entry_path, 'entry_path'),
    harness_binding: {
      root: typeof bd.root === 'string' ? bd.root : '',
      root_id: typeof bd.root_id === 'string' ? bd.root_id : '',
    },
  };
}

export function resolveProductMachineConnection(resources: ResourceBindings,
  connectionId: string,
  options: { allowProduction?: boolean } = {}): ResolvedProductMachineConnection {
  const registryPath = resources.document.resources.connections_registry
    ? resources.path('connections_registry') : fail('connections_registry 尚未绑定。');
  const registry = readConnectionRegistry(registryPath);
  const raw = registeredConnection(registry, connectionId);
  if (!raw) return fail(`连接 ${connectionId} 尚未在受控登记中。`);
  const profile = parseProductMachineConnectionProfile(raw, options);
  if (profile.id !== connectionId) return fail('连接登记 id 与选择不一致。');
  if (profile.harness_binding.root !== resources.runtimeRoot
    || profile.harness_binding.root_id !== resources.document.runtimeIdentity) {
    return fail('连接登记不属于当前运行根身份。');
  }
  const configStat = lstatSync(profile.config_path);
  if ((configStat.mode & 0o022) !== 0) return fail('产品机器配置不得组/其他可写。');
  let config: Record<string, unknown>;
  try { config = JSON.parse(readFileSync(profile.config_path, 'utf8')) as Record<string, unknown>; }
  catch { return fail('产品机器配置无法解析。'); }
  if (!record(config) || config.protocol_version !== 'wfd.product-machine-config/0.1'
    || config.connection_id !== profile.id || config.store !== profile.store
    || config.runtime !== profile.runtime) {
    return fail('产品机器配置与连接登记身份、store 或 runtime 不一致。');
  }
  const caller = record(config.caller) ? config.caller : {};
  if (typeof caller.caller_id !== 'string' || typeof caller.trusted_actor_namespace !== 'string') {
    return fail('产品机器配置缺少实际调用者身份。');
  }
  const protocolRoot = typeof config.protocol_root === 'string' ? config.protocol_root : null;
  if (!protocolRoot) return fail('产品机器配置缺少 protocol_root。');
  const schemaPath = resolve(protocolRoot, 'schemas/wfd-structured-ingest.schema.json');
  const client = new WfdProductMachineClient({
    pythonPath: profile.python_path,
    entryPath: profile.entry_path,
    configPath: profile.config_path,
    projectRoot: absoluteDir(config.project_root, 'project_root'),
  });
  return {
    connectionId: profile.id,
    configPath: profile.config_path,
    store: profile.store,
    runtime: profile.runtime,
    callerId: caller.caller_id,
    trustedActorNamespace: caller.trusted_actor_namespace,
    schemaPath,
    client,
    snapshotPort: createWfdProductMachineSnapshotPort({ client, instanceId: profile.id }),
    profile,
  };
}
