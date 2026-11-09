import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ConfigError } from '../runtime/errors.js';
import type { BaiduDriveConfiguration } from '../../plugins/capture-sources/baidu-drive/index.js';

export interface LocalConnectionRegistry {
  path: string;
  credentialRegistryPath?: string;
  manualIngestConnectionId?: string;
  connections: Record<string, unknown>[];
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** 只读取已绑定登记的元数据和安全引用，不打开所引用的凭据文件。 */
export function readConnectionRegistry(path?: string): LocalConnectionRegistry | undefined {
  if (path === undefined) return undefined;
  if (!isAbsolute(path) || path.includes('\0')) throw new ConfigError('连接登记需要明确的绝对路径。');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_048_576) throw new ConfigError('连接登记必须是有界普通文件。');
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new ConfigError('连接登记当前无法解析。'); }
  if (!object(value) || !Array.isArray(value.connections)
    || value.credential_registry !== undefined && (typeof value.credential_registry !== 'string' || !isAbsolute(value.credential_registry) || value.credential_registry.includes('\0'))) {
    throw new ConfigError('连接登记缺少明确清单或有效凭据登记引用。');
  }
  const connections = value.connections.filter(object);
  const selected = value.manual_ingest_connection_id;
  if (selected !== undefined && (typeof selected !== 'string' || !CONNECTION_ID.test(selected))) {
    throw new ConfigError('手动投喂连接编号格式无效。');
  }
  if (selected !== undefined && connections.filter(connection => connection.id === selected).length !== 1) {
    throw new ConfigError('手动投喂连接须唯一且已经登记。');
  }
  return { path, connections,
    ...(selected !== undefined ? { manualIngestConnectionId: selected } : {}),
    ...(typeof value.credential_registry === 'string' ? { credentialRegistryPath: value.credential_registry } : {}) };
}

export function registeredConnection(registry: LocalConnectionRegistry | undefined, id: string): Record<string, unknown> | undefined {
  const matches = registry?.connections.filter(connection => connection.id === id) ?? [];
  if (matches.length > 1) throw new ConfigError('所选连接的登记身份重复。');
  return matches[0];
}

/** 账号位置仅沿原生客户端的已有登记；不猜默认用户目录，也不读取账号正文。 */
export function registeredBaiduDriveConfiguration(registry: LocalConnectionRegistry | undefined, binaryPath: string): BaiduDriveConfiguration | undefined {
  const connection = registeredConnection(registry, 'bdpan-native'), credential = connection?.credential_ref;
  if (connection?.kind !== 'native-cli' || connection.executable !== binaryPath || !object(credential)
    || credential.kind !== 'native-client-managed' || typeof credential.config_path !== 'string'
    || !isAbsolute(credential.config_path) || !existsSync(credential.config_path)) return undefined;
  const tokenKeyPath = typeof credential.key_path === 'string' && isAbsolute(credential.key_path) ? credential.key_path : undefined;
  if (credential.key_path !== undefined && (!tokenKeyPath || !existsSync(tokenKeyPath))) return undefined;
  return { binaryPath, configPath: credential.config_path, ...(tokenKeyPath && existsSync(tokenKeyPath) ? { tokenKeyPath } : {}) };
}
