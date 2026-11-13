import type { SourceOperationId, SourceSettingsView } from '../../../../contracts/source-settings';
import { request, RequestError, type RequestOptions } from '../api';

/** 服务端持久化的原提交回执；页面只显示，不据此改写保存事实。 */
export interface SourceSettingsOperation {
  requestId: string;
  status: 'saving' | 'saved' | 'conflict' | 'adopted' | 'adopt_failed';
  expectedRevision: number;
  savedRevision: number | null;
  adoptedRevision: number | null;
  actualMatches: boolean;
  currentRevision: number;
  error: string | null;
  updatedAt: string;
}

export class SourceSettingsRequestError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly code: string | null = null) {
    super(message);
    this.name = 'SourceSettingsRequestError';
  }
}

const base = '/api/ui/source-settings';

/** 来源设置只保留业务校验与回执身份；HTTP 安全边界复用统一请求函数。 */
async function sourceRequest(path: string, method: 'GET' | 'PUT' = 'GET', body?: unknown,
  options: RequestOptions = {}): Promise<unknown> {
  try {
    return await request(path, method, body, {
      requireLocalData: true,
      missingContextMessage: '本地资料资格尚未确认，请重新核对后再读取来源设置。',
      ...options,
    });
  } catch (failure) {
    if (failure instanceof RequestError) throw new SourceSettingsRequestError(failure.message, failure.status, failure.code);
    throw failure;
  }
}

/** 稳定请求编号只由一次明确保存意图生成；网络丢失后只查原号，不换号重发。 */
export function newSourceSettingsRequestId(scopeId: string, operationId: SourceOperationId): string {
  const scope = scopeId.replace(/[^A-Za-z0-9._:-]/gu, '-');
  return `ui-source-settings-${scope}-${operationId}-${crypto.randomUUID()}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operation(value: unknown): SourceSettingsOperation | null {
  if (!record(value) || typeof value.requestId !== 'string'
    || !['saving', 'saved', 'conflict', 'adopted', 'adopt_failed'].includes(String(value.status))
    || !Number.isSafeInteger(value.expectedRevision) || !Number.isSafeInteger(value.currentRevision)
    || !(value.savedRevision === null || Number.isSafeInteger(value.savedRevision))
    || !(value.adoptedRevision === null || Number.isSafeInteger(value.adoptedRevision))
    || typeof value.actualMatches !== 'boolean'
    || !(value.error === null || typeof value.error === 'string') || typeof value.updatedAt !== 'string') return null;
  return value as unknown as SourceSettingsOperation;
}

function view(value: unknown): SourceSettingsView {
  if (!record(value) || !Number.isSafeInteger(value.revision) || !Array.isArray(value.operationPolicies)
    || !Array.isArray(value.connections) || !Array.isArray(value.policies) || !Array.isArray(value.plugins)
    || !Array.isArray(value.capture)) throw new SourceSettingsRequestError('来源设置返回格式无效。', 200);
  return value as unknown as SourceSettingsView;
}

export async function loadSourceSettings(signal?: AbortSignal): Promise<SourceSettingsView> {
  const value = await sourceRequest(base, 'GET', undefined, {
    signal, networkErrorMessage: '未收到本机服务的确认，来源设置读取结果未确认。',
    timeoutMs: 30_000,
  });
  return view(value);
}

export async function saveSourceSettings(input: SourceSettingsView, requestId: string, signal?: AbortSignal): Promise<{ view: SourceSettingsView; operation: SourceSettingsOperation | null }> {
  const body = {
    revision: input.revision, updatedAt: input.updatedAt,
    plugins: input.plugins, connections: input.connections, policies: input.policies,
    operationPolicies: input.operationPolicies, capture: input.capture, execution: input.execution,
  };
  const value = await sourceRequest(base, 'PUT', body, {
    signal, keepalive: false, headers: { 'Idempotency-Key': requestId },
    networkErrorMessage: '保存请求未收到回执，结果尚未确认。',
  });
  const envelope = record(value) ? value : {};
  return { view: view(value), operation: operation(envelope.operation) };
}

export async function sourceSettingsOperation(requestId: string, signal?: AbortSignal): Promise<SourceSettingsOperation | null> {
  let value: unknown;
  try {
    value = await sourceRequest(`${base}/operations/${encodeURIComponent(requestId)}`, 'GET', undefined, {
      signal, networkErrorMessage: '原请求回执暂时无法核对。',
    });
  } catch (failure) {
    if (failure instanceof SourceSettingsRequestError && failure.status === 404) return null;
    throw failure;
  }
  const parsed = operation(value);
  if (!parsed || parsed.requestId !== requestId) throw new SourceSettingsRequestError('原请求回执格式无效。', 200);
  return parsed;
}
