import type { AlgorithmCallRequest, AlgorithmCatalogView, AlgorithmTaskView } from '../../../modules/financial/algorithm-types';
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

export async function submitAlgorithmCall(requestId: string, call: AlgorithmCallRequest): Promise<AlgorithmTaskView> {
  return asTask(await request('/api/ui/algorithms/calls', 'POST', { requestId, call }));
}

export async function readAlgorithmCall(taskId: string): Promise<AlgorithmTaskView> {
  return asTask(await request(`/api/ui/algorithms/calls/${encodeURIComponent(taskId)}`));
}

export async function resumeAlgorithmCall(taskId: string, expectedVersion: number): Promise<AlgorithmTaskView> {
  return asTask(await request(`/api/ui/algorithms/calls/${encodeURIComponent(taskId)}/resume`, 'POST', { expectedVersion }));
}

function asTask(value: unknown): AlgorithmTaskView {
  if (!isRecord(value) || typeof value.taskId !== 'string' || typeof value.requestId !== 'string'
    || typeof value.methodId !== 'string' || typeof value.status !== 'string' || !Number.isSafeInteger(value.taskVersion)
    || (value.result !== null && !isRecord(value.result)) || (value.error !== null && !isRecord(value.error))) {
    throw new RequestError('算法任务返回的数据与当前接口契约不一致。');
  }
  return value as unknown as AlgorithmTaskView;
}
