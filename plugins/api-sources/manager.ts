import type { CredentialReference } from '../../platform/config/model.js';

export interface ApiSourceDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly apiBaseUrl: string;
  readonly applicationUrl: string;
  readonly documentationUrl?: string;
  readonly credentialInstructions: string;
}

/** 仅保留指定来源在当前应用身份下的凭据位置，不包含密钥。 */
export interface ApiSourceCredentialBinding {
  readonly sourceId: string;
  readonly runtimeIdentity: string;
  readonly reference: CredentialReference;
}

export interface ApiSourceReadiness {
  readonly sourceId: string;
  readonly displayName: string;
  readonly status: 'ready' | 'needs_credential' | 'credential_unavailable';
  readonly applicationUrl: string;
  readonly prompt: string;
}

export interface ApiSourceReadinessOptions {
  readonly runtimeIdentity: string;
  readonly binding?: ApiSourceCredentialBinding;
  /** 仅由受信宿主装配；精确核验所选引用，明文及底层异常不能返回给调用方。 */
  readonly verifyCredential?: (binding: ApiSourceCredentialBinding) => Promise<void>;
}

/** 本机凭据可读不代表供应商申请、权限、额度或接口连通性已经核验。 */
export async function checkApiSourceReadiness(source: ApiSourceDefinition, options: ApiSourceReadinessOptions): Promise<ApiSourceReadiness> {
  if (!validDefinition(source) || !identity(options.runtimeIdentity)) throw new Error('接口源定义或当前应用身份无效。');
  const result = (status: ApiSourceReadiness['status'], prompt: string): ApiSourceReadiness => Object.freeze({
    sourceId: source.id, displayName: source.displayName, status, applicationUrl: source.applicationUrl, prompt,
  });
  const request = '请提供已有API密钥；尚未申请可打开申请地址。';
  if (options.binding === undefined) return result('needs_credential', request);

  const binding = options.binding;
  // 先核来源与本机应用身份；不尝试其他来源、旧机器或其他引用。
  if (!binding || binding.sourceId !== source.id || binding.runtimeIdentity !== options.runtimeIdentity
    || !validReference(binding.reference)) {
    return result('credential_unavailable', `凭据配置与当前来源或应用身份不符。${request}`);
  }
  if (!options.verifyCredential) return result('credential_unavailable', `已有凭据配置，但尚未核对本机可读性。${request}`);

  const reference: CredentialReference = binding.reference.kind === 'dsh-ref'
    ? { kind: 'dsh-ref', path: binding.reference.path, ref: binding.reference.ref }
    : { kind: 'keychain', service: binding.reference.service, account: binding.reference.account };
  const selected = Object.freeze({ sourceId: source.id, runtimeIdentity: options.runtimeIdentity, reference: Object.freeze(reference) });
  try {
    await options.verifyCredential(selected);
    return result('ready', '当前来源的本机凭据已可读取；供应商申请状态、权限、额度和接口连通性尚未核验。');
  } catch {
    // 凭据读取异常可能含明文或源文本片段，禁止附加 message、cause 或诊断。
    return result('credential_unavailable', `本机暂时无法读取指定凭据。${request}`);
  }
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f]/u.test(value);
}
function text(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value);
}
function httpsAddress(value: unknown): value is string {
  if (!text(value, 2048)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; }
  catch { return false; }
}
function validDefinition(value: ApiSourceDefinition): boolean {
  return !!value && typeof value.id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value.id)
    && text(value.displayName, 128) && text(value.credentialInstructions, 2048)
    && httpsAddress(value.apiBaseUrl) && httpsAddress(value.applicationUrl)
    && (value.documentationUrl === undefined || httpsAddress(value.documentationUrl));
}
function validReference(value: unknown): value is CredentialReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  if (reference.kind === 'dsh-ref') return Object.keys(reference).every(key => ['kind', 'path', 'ref'].includes(key))
    && text(reference.path, 4096) && typeof reference.ref === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(reference.ref);
  return reference.kind === 'keychain' && Object.keys(reference).every(key => ['kind', 'service', 'account'].includes(key))
    && text(reference.service, 256) && text(reference.account, 256);
}
