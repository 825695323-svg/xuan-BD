import { readFile } from 'node:fs/promises';
import { runDirectProcess } from '../runtime/process.js';
import type { ProcessRuntime } from '../runtime/programs.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isScalar, parseDocument } from 'yaml';
import { piThinkingConfiguration } from '../../adapters/llm/pi.js';
import { type PiBackendConfig } from '../../contracts/llm.js';
import { ConfigError } from '../runtime/errors.js';
import type { HealthResponse, ThinkingLevel } from '../../contracts/contracts.js';

export type CredentialReference = { kind: 'dsh-ref'; path: string; ref: string }
  | { kind: 'keychain'; service: string; account: string };

export interface ModelConfiguration {
  provider: string;
  model: string;
  defaultThinkingLevel: ThinkingLevel;
  customModel: {
    api: 'openai-completions';
    baseUrl: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    input: ['text'] | ['text', 'image'];
    reasoning: boolean;
  };
  credential: CredentialReference;
}

export interface AppConfiguration {
  mode: 'pi' | 'demo';
  pi: PiBackendConfig;
  health: HealthResponse;
  credentialReference?: { name: string; path?: string };
}

/** 只解析指定引用，不执行 YAML 标签，也不回退到其他服务的凭据。 */
export async function readDshCredential(file: string, reference: string): Promise<string> {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(reference)) throw new ConfigError('凭据引用名无效。');
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch { throw new ConfigError('无法读取指定的 DSH 凭据文件，请检查文件位置和访问权限。'); }
  if (Buffer.byteLength(raw, 'utf8') > 1_048_576) throw new ConfigError('DSH 凭据文件过大，已停止解析。');
  try {
    const document = parseDocument(raw, { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) throw new Error('invalid document');
    const entry = document.getIn(['refs', reference], true);
    if (!isScalar(entry) || typeof entry.value !== 'string' || !entry.value.trim()) throw new Error('missing credential');
    const key = entry.value.trim();
    if (/[\r\n\u0000]/.test(key)) throw new Error('invalid credential');
    return key;
  } catch {
    // YAML 错误通常附带源文本片段，禁止把底层异常向界面或日志传播。
    throw new ConfigError('无法解析指定的 DSH 凭据引用，请检查文件格式及引用是否存在。');
  }
}

/** 固定系统入口按 service/account 精确读取；底层错误和输出不进入异常链。 */
export async function readKeychainCredential(service: string, account: string, runtime?: ProcessRuntime): Promise<string> {
  if (!keychainAttribute(service) || !keychainAttribute(account)) throw new ConfigError('钥匙串引用需要明确的服务名称和账户名称。');
  if (process.platform !== 'darwin') throw new ConfigError('系统钥匙串凭据引用仅支持 macOS。');
  try {
    if (!runtime) throw new Error('unbound runtime');
    const response = await runDirectProcess({ runtime, binary: 'security', args: ['find-generic-password', '-s', service, '-a', account, '-w'],
      cwd: '/', signal: new AbortController().signal, timeoutMs: 15_000, maxOutputBytes: 8192,
      assertAuthorized: () => { runtime.path('security'); } });
    const key = response.stdout.trim();
    if (!key || key.length > 4096 || /[\u0000-\u001f\u007f\ufffd]/u.test(key)) throw new Error('invalid key');
    return key;
  } catch { throw new ConfigError('无法读取指定的钥匙串凭据，请检查登记程序、所选项目和访问权限。'); }

}

export function parseModelConfiguration(value: unknown): ModelConfiguration {
  if (!record(value) || !onlyKeys(value, ['provider', 'model', 'customModel', 'credential', 'defaultThinkingLevel'])
    || typeof value.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.provider)
    || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 256
    || !record(value.customModel) || !record(value.credential)) throw new ConfigError('模型配置格式无效。');
  const model = value.customModel;
  if (!onlyKeys(model, ['api', 'baseUrl', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning'])
    || model.api !== 'openai-completions' || typeof model.baseUrl !== 'string'
    || typeof model.name !== 'string' || !model.name.trim()
    || !positiveInteger(model.contextWindow) || !positiveInteger(model.maxTokens)
    || model.maxTokens > model.contextWindow
    || !Array.isArray(model.input) || ![1, 2].includes(model.input.length) || model.input[0] !== 'text'
    || (model.input.length === 2 && model.input[1] !== 'image')
    || typeof model.reasoning !== 'boolean') throw new ConfigError('自定义模型参数无效，输入须明确声明文本或文本与图像。');
  let endpoint: URL;
  try { endpoint = new URL(model.baseUrl); }
  catch { throw new ConfigError('模型服务地址无效。'); }
  const loopbackHttp = endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'
    && Boolean(endpoint.port) && model.baseUrl.startsWith('http://127.0.0.1:');
  if ((endpoint.protocol !== 'https:' && !loopbackHttp)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ConfigError('模型服务地址须使用 HTTPS，或明确的 127.0.0.1 HTTP 端口，且不能包含凭据、查询参数或片段。');
  }
  const reference = value.credential;
  let credential: CredentialReference;
  if (reference.kind === 'dsh-ref' && onlyKeys(reference, ['kind', 'path', 'ref'])
    && typeof reference.path === 'string' && reference.path.trim()
    && typeof reference.ref === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(reference.ref)) {
    credential = { kind: 'dsh-ref', path: reference.path, ref: reference.ref };
  } else if (reference.kind === 'keychain' && onlyKeys(reference, ['kind', 'service', 'account'])
    && keychainAttribute(reference.service) && keychainAttribute(reference.account)) {
    credential = { kind: 'keychain', service: reference.service, account: reference.account };
  } else throw new ConfigError('凭据配置须为指定 DSH 引用或明确的系统钥匙串服务与账户，不接受明文密钥。');
  const defaultThinkingLevel = value.defaultThinkingLevel ?? 'off';
  if (!['off', 'low', 'high', 'max'].includes(String(defaultThinkingLevel))) throw new ConfigError('默认思考档位无效，请选择关闭、低、高或最高。');
  const parsed: ModelConfiguration = {
    provider: value.provider, model: value.model,
    defaultThinkingLevel: defaultThinkingLevel as ThinkingLevel,
    customModel: { api: model.api, baseUrl: endpoint.href.replace(/\/$/, ''), name: model.name,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: [...model.input] as ['text'] | ['text', 'image'], reasoning: model.reasoning },
    credential,
  };
  piThinkingConfiguration(parsed);
  return parsed;
}

export async function loadAppConfiguration(projectRoot: string, env: NodeJS.ProcessEnv = process.env, runtime?: ProcessRuntime): Promise<AppConfiguration> {
  const mode = env.MASHIRO_BACKEND ?? 'pi';
  if (mode !== 'pi' && mode !== 'demo') throw new ConfigError('MASHIRO_BACKEND 只能为 pi 或 demo。');
  const health: HealthResponse = { name: 'xuan BD', backend: mode, configured: mode === 'demo',
    model: null, provider: null, notice: mode === 'demo' ? '本地演示 · 无模型调用 · 演示记录单独保存' : '会话、任务与记忆保存在本机' };
  if (mode === 'demo') return { mode, pi: {}, health };
  const fileSetting = env.MASHIRO_CONFIG?.trim();
  if (fileSetting) {
    if (env.MASHIRO_API_KEY?.trim() || env.MASHIRO_PROVIDER?.trim() || env.MASHIRO_MODEL?.trim()) {
      throw new ConfigError('配置文件模式不能同时设置 MASHIRO_PROVIDER、MASHIRO_MODEL 或 MASHIRO_API_KEY。');
    }
    const file = expandPath(fileSetting, projectRoot);
    let value: unknown;
    try { value = JSON.parse(await readFile(file, 'utf8')); }
    catch { throw new ConfigError('无法读取或解析模型配置文件。'); }
    const parsed = parseModelConfiguration(value);
    const credential = parsed.credential;
    let resolveApiKey: () => Promise<string>;
    let credentialReference: NonNullable<AppConfiguration['credentialReference']>;
    if (credential.kind === 'dsh-ref') {
      const credentialFile = expandPath(credential.path, dirname(file));
      resolveApiKey = () => readDshCredential(credentialFile, credential.ref);
      credentialReference = { name: credential.ref, path: credentialFile };
    } else {
      // 每次启动只解析一次指定项目；失败不在会话创建或后台反复触发钥匙串授权。
      const selectedKey = readKeychainCredential(credential.service, credential.account, runtime);
      resolveApiKey = () => selectedKey;
      const name = createHash('sha256').update(JSON.stringify([credential.service, credential.account])).digest('hex');
      credentialReference = { name: `keychain:${name}` };
    }
    let configured = true;
    try { await resolveApiKey(); }
    catch { configured = false; health.notice = '模型参数已加载，但指定凭据引用暂时不可用。'; }
    return {
      mode,
      pi: { provider: parsed.provider, model: parsed.model, customModel: parsed.customModel, defaultThinkingLevel: parsed.defaultThinkingLevel, resolveApiKey },
      health: { ...health, provider: parsed.provider, model: parsed.model, configured },
      credentialReference,
    };
  }
  const provider = env.MASHIRO_PROVIDER?.trim();
  const model = env.MASHIRO_MODEL?.trim();
  const apiKey = env.MASHIRO_API_KEY?.trim();
  return { mode, pi: { provider, model, apiKey },
    ...(apiKey ? { credentialReference: { name: 'MASHIRO_API_KEY' } } : {}),
    health: { ...health, provider: provider ?? null, model: model ?? null, configured: Boolean(provider && model && apiKey) } };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function keychainAttribute(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function expandPath(path: string, base: string): string {
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}
