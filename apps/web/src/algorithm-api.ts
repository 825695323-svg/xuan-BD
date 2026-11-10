import type { AlgorithmCatalogView, AlgorithmTaskView } from '../../../modules/financial/algorithm-types';
import { RequestError, request } from './api';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function loadAlgorithmCatalog(): Promise<AlgorithmCatalogView> {
  const value = await request('/api/ui/algorithms');
  if (!isRecord(value) || typeof value.contractVersion !== 'string' || !['available', 'unavailable'].includes(String(value.status))
    || typeof value.enabled !== 'boolean' || !Array.isArray(value.methods) || !isRecord(value.inputs)
    || !isRecord(value.inputs.managedTables) || !Array.isArray(value.inputs.managedTables.items)) {
    throw new RequestError('算法能力返回的数据与当前接口契约不一致。');
  }
  return value as unknown as AlgorithmCatalogView;
}

export async function listAlgorithmCalls(): Promise<AlgorithmTaskView[]> {
  const value = await request('/api/ui/algorithms/calls');
  if (!isRecord(value) || !Array.isArray(value.items)) throw new RequestError('算法任务列表没有可信摘要。');
  return value.items.map(asTask);
}

export async function readAlgorithmCall(taskId: string): Promise<AlgorithmTaskView> {
  return asTask(await request(`/api/ui/algorithms/calls/${encodeURIComponent(taskId)}`));
}

function asTask(value: unknown): AlgorithmTaskView {
  if (!isRecord(value) || typeof value.taskId !== 'string' || typeof value.requestId !== 'string'
    || typeof value.methodId !== 'string' || typeof value.status !== 'string' || !Number.isSafeInteger(value.taskVersion)
    || (value.result !== null && !isRecord(value.result)) || (value.error !== null && !isRecord(value.error))) {
    throw new RequestError('算法任务返回的数据与当前接口契约不一致。');
  }
  return value as unknown as AlgorithmTaskView;
}
