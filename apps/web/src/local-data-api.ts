import { RequestError, request } from './api';

export interface LocalDataOperation {
  operationId: string;
  dataId: string;
  kind: 'deactivate' | 'unbind';
  state: 'pending' | 'settling' | 'unresolved' | 'settled' | 'completed' | 'stopped';
  expectedGeneration: number;
  generation: number;
  reason: string;
  evidence: string | null;
  pendingTaskIds: string[];
  stopRequested: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LocalDataReload {
  operationId: string;
  dataId: string;
  state: 'pending' | 'loaded';
  expectedGeneration: number;
  generation: number;
  reason: string;
  requestedAt: number;
  loadedAt: number | null;
}

export interface LocalDataQuiescence {
  operationId: string;
  dataId: string;
  evidence: string;
  pendingTaskIds: string[];
  quiescedAt: number;
}

export interface LocalDataRecord {
  dataId: string;
  status: 'active' | 'deactivating' | 'inactive' | 'unbound';
  generation: number;
  adopted: boolean;
  revision: number;
  updatedAt: number;
  lastOperation: LocalDataOperation | null;
  reloadPending: LocalDataReload | null;
  quiescence: LocalDataQuiescence | null;
}

export interface LocalDataCurrent { dataId: string; record: LocalDataRecord | null; available: boolean; detail: string | null }

export async function currentLocalData(): Promise<LocalDataCurrent> {
  const value = await request('/api/harness/local-data/current');
  if (!isRecord(value) || typeof value.dataId !== 'string' || !(value.record === null || isRecord(value.record))) throw new RequestError('本地资料资格返回格式无效。');
  return { dataId: value.dataId, record: value.record === null ? null : record(value.record), available: value.available === true,
    detail: typeof value.detail === 'string' ? value.detail : null };
}

export async function deactivateLocalData(input: { dataId: string; expectedGeneration: number; reason: string }): Promise<LocalDataRecord> {
  const operation = operationFor('deactivate', input.dataId, input.reason);
  try {
    const value = await request('/api/harness/local-data/deactivate', 'POST', {
      dataId: input.dataId, operationId: operation.id, expectedGeneration: input.expectedGeneration, reason: operation.reason,
    });
    clearOperation('deactivate', input.dataId);
    return recordOf(value);
  } catch (error) {
    // 明确 4xx 表示原操作未被接受；网络/5xx 保留原编号，下一次按原 operation 查询或重试。
    if (error instanceof RequestError && error.status !== null && error.status < 500) clearOperation('deactivate', input.dataId);
    throw error;
  }
}

export async function unbindLocalData(input: { dataId: string; expectedGeneration: number; reason: string }): Promise<LocalDataRecord> {
  const operation = operationFor('unbind', input.dataId, input.reason);
  try {
    const value = await request('/api/harness/local-data/unbind', 'POST', {
      dataId: input.dataId, operationId: operation.id, expectedGeneration: input.expectedGeneration, reason: operation.reason,
    });
    clearOperation('unbind', input.dataId);
    return recordOf(value);
  } catch (error) {
    if (error instanceof RequestError && error.status !== null && error.status < 500) clearOperation('unbind', input.dataId);
    throw error;
  }
}

export async function stopLocalData(input: { dataId: string; operationId: string }): Promise<LocalDataRecord> {
  const value = await request('/api/harness/local-data/stop', 'POST', { dataId: input.dataId, operationId: input.operationId });
  return recordOf(value);
}

/** 客户端只请求宿主重新核对；不提交 outcome、证据或待核任务。 */
/** 只保存待重启重新加载；不会在本进程打开个人资料。 */
export async function reloadLocalData(input: { dataId: string; expectedGeneration: number; reason: string }): Promise<LocalDataRecord> {
  const operation = operationFor('reload', input.dataId, input.reason);
  try {
    const value = await request('/api/harness/local-data/reload', 'POST', {
      dataId: input.dataId, operationId: operation.id, expectedGeneration: input.expectedGeneration, reason: operation.reason,
    });
    clearOperation('reload', input.dataId);
    return recordOf(value);
  } catch (error) {
    if (error instanceof RequestError && error.status !== null && error.status < 500) clearOperation('reload', input.dataId);
    throw error;
  }
}

export async function verifyLocalData(input: { dataId: string; operationId: string }): Promise<LocalDataRecord> {
  const value = await request('/api/harness/local-data/reconcile', 'POST', { dataId: input.dataId, operationId: input.operationId });
  return recordOf(value);
}

function recordOf(value: unknown): LocalDataRecord {
  if (!isRecord(value) || !isRecord(value.record)) throw new RequestError('本地资料控制返回格式无效。');
  return record(value.record);
}

function record(value: Record<string, unknown>): LocalDataRecord {
  if (typeof value.dataId !== 'string' || !['active', 'deactivating', 'inactive', 'unbound'].includes(String(value.status))
    || !Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.revision)
    || typeof value.adopted !== 'boolean' || typeof value.updatedAt !== 'number'
    || !(value.lastOperation === null || isRecord(value.lastOperation))
    || !(value.reloadPending === undefined || value.reloadPending === null || isRecord(value.reloadPending))
    || !(value.quiescence === undefined || value.quiescence === null || isRecord(value.quiescence))) throw new RequestError('本地资料控制记录无效。');
  return value as unknown as LocalDataRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type OperationKind = 'deactivate' | 'unbind' | 'reload';
interface PendingOperation { id: string; reason: string }
const operationPrefix = (kind: OperationKind, dataId: string) => `mashiro.local-data-operation.${kind}.${dataId}`;

/** 同一资料同一动作沿用原操作编号；丢回执后不生成新编号重复动作。 */
function operationFor(kind: OperationKind, dataId: string, reason: string): PendingOperation {
  const key = operationPrefix(kind, dataId);
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && typeof value === 'object' && typeof (value as PendingOperation).id === 'string'
      && /^local-data-[0-9a-f-]{36}$/u.test((value as PendingOperation).id) && typeof (value as PendingOperation).reason === 'string') {
      return value as PendingOperation;
    }
  } catch { /* 损坏记录按新操作处理，不沿用不可信编号。 */ }
  const created = { id: `local-data-${crypto.randomUUID()}`, reason };
  try { localStorage.setItem(key, JSON.stringify(created)); } catch { /* 无持久存储时仍使用本次编号。 */ }
  return created;
}

function clearOperation(kind: OperationKind, dataId: string): void {
  try { localStorage.removeItem(operationPrefix(kind, dataId)); } catch { /* 无持久存储时无需清理。 */ }
}
