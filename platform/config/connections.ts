import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ConfigError } from '../runtime/errors.js';
import type { BaiduDriveConfiguration } from '../../plugins/capture-sources/baidu-drive/index.js';
import { isBaiduPasscodeRefName } from '../../plugins/capture-sources/baidu-drive/contract.js';
import { parseCredentialReference } from './model.js';

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

/** 保护路径只取登记中的定位信息，即使客户端或密钥文件离线也生效。 */
export function registeredBaiduSharePasscodePaths(registry: LocalConnectionRegistry | undefined): string[] {
  const paths = new Set<string>();
  for (const connection of registry?.connections ?? []) {
    if (!object(connection.share_passcode_refs)) continue;
    for (const locator of Object.values(connection.share_passcode_refs)) {
      if (object(locator) && locator.kind === 'dsh-ref' && typeof locator.path === 'string'
        && isAbsolute(locator.path) && !locator.path.includes('\0')) paths.add(locator.path);
    }
  }
  return [...paths];
}

/** 账号位置仅沿原生客户端的已有登记；不猜默认用户目录，也不读取账号正文。 */
export function registeredBaiduDriveConfiguration(registry: LocalConnectionRegistry | undefined, binaryPath: string): BaiduDriveConfiguration | undefined {
  const connection = registeredConnection(registry, 'bdpan-native'), credential = connection?.credential_ref;
  if (connection?.kind !== 'native-cli' || connection.executable !== binaryPath || !object(credential)
    || credential.kind !== 'native-client-managed' || typeof credential.config_path !== 'string'
    || !isAbsolute(credential.config_path) || !existsSync(credential.config_path)) return undefined;
  const tokenKeyPath = typeof credential.key_path === 'string' && isAbsolute(credential.key_path) ? credential.key_path : undefined;
  if (credential.key_path !== undefined && (!tokenKeyPath || !existsSync(tokenKeyPath))) return undefined;
  const configuration: BaiduDriveConfiguration = { binaryPath, configPath: credential.config_path, ...(tokenKeyPath ? { tokenKeyPath } : {}) };
  const refs = connection.share_passcode_refs;
  if (refs === undefined) return configuration;
  if (!object(refs)) throw new ConfigError('网盘分享凭据登记须为引用名与安全定位的映射。');
  const sharePasscodeRefs = Object.fromEntries(Object.entries(refs).map(([name, value]) => {
    if (!isBaiduPasscodeRefName(name)) throw new ConfigError('网盘分享凭据引用名无效。');
    const locator = parseCredentialReference(value);
    if (locator.kind === 'dsh-ref' && (!isAbsolute(locator.path) || /[\u0000-\u001f\u007f]/u.test(locator.path))) {
      throw new ConfigError('网盘分享凭据须登记有效的绝对路径。');
    }
    return [name, locator] as const;
  }));
  return { ...configuration, sharePasscodeRefs };
}
