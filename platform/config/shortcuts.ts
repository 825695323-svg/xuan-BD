import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { ConfigError } from '../runtime/errors.js';
import { normalizePermissionPath, type PermissionCapability } from '../security/permissions.js';
import type { ShortcutDefinition } from '../../contracts/direct-runtime.js';

const MAX_BYTES = 64 * 1024;
const MAX_SHORTCUTS = 16;
const FILE_ACTIONS = new Set(['read', 'write', 'delete', 'execute']);

function invalid(message = '快捷指令配置格式无效，请核对固定名称、明确选择与精确影响。'): never { throw new ConfigError(message); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function exactPath(value: unknown): string {
  if (!text(value, 4096) || /[*?\[\]{}]/u.test(value)) invalid('快捷指令文件权限需要不含通配符的绝对路径。');
  try { return normalizePermissionPath(value); }
  catch { return invalid('快捷指令文件权限需要不含路径穿越的绝对路径。'); }
}
function capability(value: unknown): PermissionCapability {
  if (!record(value) || !keys(value, ['action', 'target']) || typeof value.action !== 'string' || !record(value.target)) invalid();
  const target = value.target;
  if (value.action === 'network') {
    if (!keys(target, ['kind', 'origin']) || target.kind !== 'network' || !text(target.origin, 2048)) invalid();
    let url: URL;
    try { url = new URL(target.origin); } catch { return invalid('快捷指令网络权限需要精确的HTTP或HTTPS来源。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || url.host.includes('*')) invalid('快捷指令网络权限需要不含凭据、路径或通配符的来源。');
    return { action: 'network', target: { kind: 'network', origin: url.origin } };
  }
  if (!FILE_ACTIONS.has(value.action)) invalid('快捷指令只接受明确文件或网络影响，不接受凭据权限。');
  const action = value.action as 'read' | 'write' | 'delete' | 'execute';
  if (target.kind === 'file' && keys(target, ['kind', 'path'])) return { action, target: { kind: 'file', path: exactPath(target.path) } };
  if (target.kind === 'directory' && keys(target, ['kind', 'path', 'recursive']) && typeof target.recursive === 'boolean') {
    return { action, target: { kind: 'directory', path: exactPath(target.path), recursive: target.recursive } };
  }
  return invalid();
}

function parseConfiguration(source: string): ShortcutDefinition[] {
  const value: unknown = JSON.parse(source);
  // JSON语法先由标准解析器确认，再复用已有YAML解析器拒绝重复键；不接受YAML配置。
  const document = parseDocument(source, { schema: 'json', strict: true, uniqueKeys: true });
  if (document.errors.length || document.warnings.length) invalid('快捷指令配置必须是没有重复字段的JSON。');
  if (!Array.isArray(value) || value.length > MAX_SHORTCUTS) invalid('快捷指令配置需要最多16条的JSON数组。');
  const ids = new Set<string>(), names = new Set<string>();
  return value.map((entry: unknown) => {
    if (!record(entry) || !keys(entry, ['id', 'name', 'userSelected', 'effectDescription', 'capabilities', 'verification'])
      || !text(entry.id, 256) || entry.id !== entry.id.trim() || ids.has(entry.id)
      || !text(entry.name, 256) || entry.name !== entry.name.trim() || entry.name.startsWith('-') || names.has(entry.name)
      || entry.userSelected !== true || !text(entry.effectDescription, 4000)
      || !Array.isArray(entry.capabilities) || entry.capabilities.length > 128) invalid();
    ids.add(entry.id); names.add(entry.name);
    const capabilities = entry.capabilities.map(capability);
    if (new Set(capabilities.map((item) => JSON.stringify(item))).size !== capabilities.length) invalid('快捷指令权限声明不能重复。');
    let verification: ShortcutDefinition['verification'];
    if (entry.verification !== undefined) {
      if (!record(entry.verification) || !keys(entry.verification, ['kind', 'path', 'nonempty']) || entry.verification.kind !== 'new-file'
        || (entry.verification.nonempty !== undefined && typeof entry.verification.nonempty !== 'boolean')) invalid();
      const path = exactPath(entry.verification.path);
      if (!capabilities.some((item) => item.action === 'write' && item.target.kind === 'file' && item.target.path === path)) {
        invalid('快捷指令新文件验证必须声明同一精确目标的写入权限。');
      }
      verification = { kind: 'new-file', path, ...(entry.verification.nonempty !== undefined ? { nonempty: entry.verification.nonempty } : {}) };
    }
    return { id: entry.id, name: entry.name, userSelected: true, effectDescription: entry.effectDescription, capabilities,
      ...(verification ? { verification } : {}) };
  });
}

/** 只读宿主显式传入的配置，不发现快捷指令，不读能力目标，不执行系统命令。 */
export async function loadShortcutConfiguration(path?: string): Promise<ShortcutDefinition[]> {
  if (path === undefined) return [];
  if (!text(path, 4096)) invalid('快捷指令配置路径无效，请指定一个JSON文件。');
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_BYTES)) invalid('快捷指令配置必须是最多64KiB的普通JSON文件。');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (length > MAX_BYTES || before.size !== after.size || before.mtimeNs !== after.mtimeNs || after.size !== BigInt(length)) {
        invalid('快捷指令配置过大或在读取时变化，请保存后重试。');
      }
      return parseConfiguration(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    // 不传播解析片段、文件内容或底层错误堆栈。
    throw new ConfigError('无法读取快捷指令JSON配置，请检查文件、格式及访问权限。');
  }
}
