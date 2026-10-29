import { readFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from '../runtime/errors.js';
import { loadShortcutConfiguration } from './shortcuts.js';

/** 工具配置独立于模型和旧网页环境；明确路径只在首次建立核心设置时作为种子。 */
export async function loadToolConfiguration(workspaceRoot: string, configRoot = resolve(workspaceRoot, 'config')) {
  const path = resolve(configRoot, 'tools.json');
  let value: Record<string, unknown> = {};
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384) throw new ConfigError('工具配置需要普通 JSON 文件。');
    try { value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>; }
    catch { throw new ConfigError('工具配置格式无效。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !['whisperModelPath', 'shortcutConfigPath'].includes(key))) throw new ConfigError('工具配置包含未知字段。');
  }
  const explicitPath = (key: string): string | undefined => {
    if (value[key] === undefined || value[key] === null || value[key] === '') return undefined;
    if (typeof value[key] !== 'string' || value[key].includes('\0')) throw new ConfigError('工具配置路径无效。');
    return resolve(workspaceRoot, value[key]);
  };
  const whisperModelPath = explicitPath('whisperModelPath'), shortcutConfigPath = explicitPath('shortcutConfigPath');
  return { whisperModelPath, shortcutConfigPath, shortcuts: await loadShortcutConfiguration(shortcutConfigPath) };
}
