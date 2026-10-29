import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { DirectError, acquireAuthority, fileCapability } from '../../platform/runtime/file-workspace.js';
import { CAPTURE_SOURCE_IDS } from './contracts.js';

export interface CustomSource {
  id: string; label: string; domain: string; loginUrl?: string;
  cookieNames: string[]; operations: string[];
}
interface Document { version: 1; revision: number; sources: CustomSource[] }

const LIMIT = 128 * 1024;
const ID = /^[a-z][a-z0-9-]{0,31}$/u, LABEL = /^[^\u0000-\u001f]{1,40}$/u;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/u;
const COOKIE = /^[A-Za-z0-9_.-]{1,64}$/u, OP = /^[a-z0-9][a-z0-9-]{1,31}$/u;

const invalid = (message: string): never => { throw new DirectError('CUSTOM_SOURCE_INVALID', message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function normalize(input: Record<string, unknown>): CustomSource {
  const id = String(input.id ?? '').trim(), label = String(input.label ?? '').trim();
  const domain = String(input.domain ?? '').trim().toLowerCase();
  if (!ID.test(id)) invalid('来源编号需为 1–32 位小写字母、数字或连字符，且以字母开头。');
  if ((CAPTURE_SOURCE_IDS as readonly string[]).includes(id)) invalid(`来源编号 ${id} 已是内置采集源，请直接用内置卡片，不要重复登记。`);
  if (!LABEL.test(label)) invalid('显示名称需为 1–40 个可见字符。');
  if (!HOST.test(domain)) invalid('站点域名需为合法主机名（不含协议与路径）。');
  const loginUrl = input.loginUrl === undefined || input.loginUrl === '' ? undefined : String(input.loginUrl).trim();
  if (loginUrl !== undefined && !/^https:\/\/[^\s"']{1,2000}$/u.test(loginUrl)) invalid('登录页地址必须是 https 链接。');
  const cookies = String(input.cookieNames ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (cookies.length > 5 || cookies.some((name) => !COOKIE.test(name))) invalid('登录 Cookie 名最多 5 个，允许字母、数字、下划线、点与连字符。');
  const operations = String(input.operations ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (operations.length > 12 || operations.some((name) => !OP.test(name))) invalid('固定操作最多 12 个，需为 2–32 位小写字母、数字或连字符。');
  return { id, label, domain, ...(loginUrl ? { loginUrl } : {}), cookieNames: cookies, operations };
}

/** 自定义来源只登记卡片信息；不接采集脚本、不写凭据、不访问网络。 */
export class CustomSourceRegistry {
  constructor(readonly path: string) {}

  async list(): Promise<CustomSource[]> {
    const document = await this.#read();
    return document.sources.map((source) => ({ ...source }));
  }

  async register(input: Record<string, JsonValue>): Promise<CustomSource> {
    const source = normalize(input as Record<string, unknown>);
    const document = await this.#read();
    if (document.sources.some((item) => item.id === source.id)) invalid(`来源编号 ${source.id} 已登记。`);
    document.sources.push(source); document.revision += 1;
    const body = JSON.stringify(document, null, 2) + '\n';
    if (Buffer.byteLength(body) > LIMIT) invalid('自定义来源配置超出 128 KiB 上限。');
    const temporary = join(dirname(this.path), `.custom-sources-${Date.now()}.tmp`);
    await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
    await rename(temporary, this.path);
    return { ...source };
  }

  async #read(): Promise<Document> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT) invalid('自定义来源配置不是有界普通文件。');
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!object(parsed)) invalid('自定义来源配置格式无效。');
      const value = parsed as Record<string, unknown>;
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || !Array.isArray(value.sources)) invalid('自定义来源配置格式无效。');
      const sources: CustomSource[] = [];
      for (const item of value.sources as unknown[]) { if (!object(item)) invalid('自定义来源条目无效。'); sources.push(normalize(item as Record<string, unknown>)); }
      return { version: 1, revision: Number(value.revision), sources };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { version: 1, revision: 0, sources: [] };
      throw error;
    }
  }
}

const FIELDS: SkillField[] = [
  { key: 'id', label: '来源编号（小写字母开头，可含数字与连字符）', type: 'text', required: true, maxLength: 32 },
  { key: 'label', label: '显示名称（1–40 字）', type: 'text', required: true, maxLength: 40 },
  { key: 'domain', label: '站点域名', type: 'text', required: true, maxLength: 253 },
  { key: 'loginUrl', label: '登录页地址（可选，https）', type: 'text', maxLength: 2000 },
  { key: 'cookieNames', label: '登录 Cookie 名（逗号分隔，可选）', type: 'text', maxLength: 300 },
  { key: 'operations', label: '固定操作名（逗号分隔，可选）', type: 'text', maxLength: 400 },
];

/** 代理可调用的受控动作：只写宿主已绑定配置资源中的来源配置，不执行脚本。 */
export function createCustomSourceActions(registry: CustomSourceRegistry) {
  const registration: SkillRegistration = {
    action: 'source.register', runtimeId: 'direct', kind: 'direct', modelCalls: 0,
    title: '登记自定义来源',
    description: '登记自定义来源元数据（编号、名称、域名、可选登录页与固定操作名）。不写凭据、不访问网络、不执行站点脚本；登记不恢复数据前端或登录控制，采集接入需另行开发。',
    fields: FIELDS,
    permissionSummary: ['只写已绑定配置资源中的自定义来源配置', '不读取或保存任何凭据值', '不发起网络请求，不执行脚本或安装组件'],
    available: () => ({ available: true }),
  };
  return {
    registrations: [registration as SkillRegistration],
    handles: (action: string) => action === registration.action,
    async execute(context: TaskExecutionContext, _action: string, input: Record<string, JsonValue>): Promise<TaskResult> {
      if (!isAbsolute(registry.path)) throw new DirectError('CUSTOM_SOURCE_INVALID', '自定义来源配置位置未登记。');
      for (const key of Object.keys(input)) if (!FIELDS.some((field) => field.key === key)) throw new DirectError('CUSTOM_SOURCE_INVALID', '包含未知参数。');
      const authority = await acquireAuthority(context, 'source.register.write', input, [fileCapability('write', registry.path)]);
      authority.assert();
      const source = await registry.register(input);
      return { summary: `已登记来源 ${source.label}（${source.id}）；仅保存元数据，采集接入与登录控制仍沿当前能力边界。`, data: { source: { ...source } as unknown as JsonValue } };
    },
  };
}
