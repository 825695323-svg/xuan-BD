import type { SourceOperationId, SourceSettingsView } from '../../../../contracts/source-settings';
import { localDataGeneration, localDataRevision, notifyLocalDataRevoked } from '../local-data-context';

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

interface PrivateContext { generation: number; revision: number }

/** 私有请求只带本页已核实代次；缺失时拒绝发送，不猜资格。 */
function privateContext(): PrivateContext {
  const generation = localDataGeneration();
  if (generation === null) throw new SourceSettingsRequestError('本地资料资格尚未确认，请重新核对后再读取来源设置。', 409, 'LOCAL_DATA_CONTEXT_MISSING');
  return { generation, revision: localDataRevision() };
}

function assertCurrent(context: PrivateContext): void {
  if (localDataRevision() !== context.revision || localDataGeneration() !== context.generation)
    throw new SourceSettingsRequestError('来源设置回执属于旧代次，未用于当前界面。', 409, 'STALE_LOCAL_DATA_GENERATION');
}

function revocationCode(value: unknown): string | null {
  const code = record(value) && typeof value.code === 'string' ? value.code : null;
  return code && (code.startsWith('LOCAL_DATA_') || code === 'STALE_LOCAL_DATA_GENERATION') ? code : null;
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

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new SourceSettingsRequestError('本机服务返回了无法读取的响应。', response.status); }
}

export async function loadSourceSettings(signal?: AbortSignal): Promise<SourceSettingsView> {
  const context = privateContext();
  let response: Response;
  try { response = await fetch(base, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'x-local-data-generation': String(context.generation) } }); }
  catch { throw new SourceSettingsRequestError('未收到本机服务的确认，来源设置读取结果未确认。'); }
  const value = await json(response), body = record(value) ? value : {};
  if (!response.ok) {
    const code = revocationCode(body);
    if (code) notifyLocalDataRevoked(code);
    throw new SourceSettingsRequestError(typeof body.error === 'string' ? body.error : '来源设置暂时无法读取。', response.status, typeof body.code === 'string' ? body.code : null);
  }
  assertCurrent(context);
  return view(value);
}

export async function saveSourceSettings(input: SourceSettingsView, requestId: string, signal?: AbortSignal): Promise<{ view: SourceSettingsView; operation: SourceSettingsOperation | null }> {
  const context = privateContext();
  const body = {
    revision: input.revision, updatedAt: input.updatedAt,
    plugins: input.plugins, connections: input.connections, policies: input.policies,
    operationPolicies: input.operationPolicies, capture: input.capture, execution: input.execution,
  };
  let response: Response;
  try {
    response = await fetch(base, {
      method: 'PUT', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web', 'Idempotency-Key': requestId, 'x-local-data-generation': String(context.generation) },
      body: JSON.stringify(body),
    });
  } catch { throw new SourceSettingsRequestError('保存请求未收到回执，结果尚未确认。'); }
  const value = await json(response), envelope = record(value) ? value : {};
  if (!response.ok) {
    const code = revocationCode(envelope);
    if (code) notifyLocalDataRevoked(code);
    throw new SourceSettingsRequestError(typeof envelope.error === 'string' ? envelope.error : '来源设置保存失败。',
      response.status, typeof envelope.code === 'string' ? envelope.code : null);
  }
  assertCurrent(context);
  return { view: view(value), operation: operation(envelope.operation) };
}

export async function sourceSettingsOperation(requestId: string, signal?: AbortSignal): Promise<SourceSettingsOperation | null> {
  const context = privateContext();
  let response: Response;
  try { response = await fetch(`${base}/operations/${encodeURIComponent(requestId)}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'x-local-data-generation': String(context.generation) } }); }
  catch { throw new SourceSettingsRequestError('原请求回执暂时无法核对。'); }
  const value = await json(response), body = record(value) ? value : {};
  if (response.status === 404) return null;
  if (!response.ok) {
    const code = revocationCode(body);
    if (code) notifyLocalDataRevoked(code);
    throw new SourceSettingsRequestError(typeof body.error === 'string' ? body.error : '原请求回执暂时无法核对。', response.status, typeof body.code === 'string' ? body.code : null);
  }
  assertCurrent(context);
  const parsed = operation(value);
  if (!parsed || parsed.requestId !== requestId) throw new SourceSettingsRequestError('原请求回执格式无效。', response.status);
  return parsed;
}
