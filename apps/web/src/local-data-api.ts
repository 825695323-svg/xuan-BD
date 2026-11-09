import { RequestError, request } from './api';

/** /current 只读记录：只保留启动身份与代次判断所需字段。 */
export interface LocalDataRecord {
  dataId: string;
  status: 'active' | 'deactivating' | 'inactive' | 'unbound';
  generation: number;
  adopted: boolean;
  revision: number;
  updatedAt: number;
}

export interface LocalDataCurrent { dataId: string; record: LocalDataRecord | null; available: boolean; detail: string | null }

/** 只读取当前身份与代次；不再提供停用、解绑、重载等人工操作入口。 */
export async function currentLocalData(): Promise<LocalDataCurrent> {
  const value = await request('/api/bd/local-data/current');
  if (!isRecord(value) || typeof value.dataId !== 'string' || !(value.record === null || isRecord(value.record))) throw new RequestError('本地资料资格返回格式无效。');
  return { dataId: value.dataId, record: value.record === null ? null : record(value.record), available: value.available === true,
    detail: typeof value.detail === 'string' ? value.detail : null };
}

function record(value: Record<string, unknown>): LocalDataRecord {
  if (typeof value.dataId !== 'string' || !['active', 'deactivating', 'inactive', 'unbound'].includes(String(value.status))
    || !Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.revision)
    || typeof value.adopted !== 'boolean' || typeof value.updatedAt !== 'number') throw new RequestError('本地资料控制记录无效。');
  return value as unknown as LocalDataRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
