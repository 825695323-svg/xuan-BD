import { FIXED_CALCULATION_VERSION, type FixedCalculationCapabilities, type FixedCalculationInput,
  type FixedCalculationInputs, type FixedCalculationRecordPage, type FixedCalculationRecordsInput,
  type FixedCalculationTaskView } from '../../../contracts/fixed-calculation-contracts';
import type { R1PrepareInput, R1RequestView } from '../../../contracts/r1-contracts';
import { request, RequestError } from './api';

const base = '/api/bd/computation';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
function task(value: unknown): FixedCalculationTaskView {
  if (!object(value) || value.version !== FIXED_CALCULATION_VERSION || value.implementation !== 'polars'
    || !['observation_ma20', 'financial_linear', 'macro_yoy'].includes(String(value.methodId)) || !object(value.task)
    || typeof value.task.id !== 'string' || typeof value.task.requestId !== 'string' || typeof value.task.status !== 'string'
    || !Number.isSafeInteger(value.task.version) || typeof value.task.requiresReview !== 'boolean'
    || !(value.result === null || object(value.result) && Array.isArray(value.result.rows)
      && value.result.rows.length === value.result.rowCount && typeof value.result.sha256 === 'string' && object(value.result.algorithmDefinition))
    || !(value.candidate === null || object(value.candidate)
      && (value.candidate.custodyTaskId === null || typeof value.candidate.custodyTaskId === 'string')
      && (value.candidate.materialId === null || typeof value.candidate.materialId === 'string'))) {
    throw new RequestError('计算任务及候选身份无法核对，请保留原请求编号。');
  }
  return value as unknown as FixedCalculationTaskView;
}
export const fixedCalculationApi = {
  capabilities: async (): Promise<FixedCalculationCapabilities> => {
    const value = await request(base + '/capabilities');
    if (!object(value) || value.version !== FIXED_CALCULATION_VERSION || value.routing !== 'fixed_by_method'
      || typeof value.configured !== 'boolean' || !Array.isArray(value.methods) || value.methods.some(method => !object(method)
        || typeof method.id !== 'string' || typeof method.title !== 'string' || method.defaultImplementation !== 'polars')) {
      throw new RequestError('固定方法目录无法读取。');
    }
    return value as unknown as FixedCalculationCapabilities;
  },
  inputs: async (): Promise<FixedCalculationInputs> => {
    const value = await request(base + '/inputs');
    if (!object(value) || !(value.snapshotId === null || typeof value.snapshotId === 'string')
      || !Array.isArray(value.sources) || value.sources.some(source => !object(source) || typeof source.autoRequestId !== 'string'
        || typeof source.materialId !== 'string' || typeof source.filename !== 'string' || !strings(source.valueColumns))
      || !Array.isArray(value.products) || value.products.some(product => !object(product) || typeof product.productId !== 'string'
        || typeof product.semanticCode !== 'string' || !object(product.subject) || !strings(product.methods)) || !strings(value.gaps)) {
      throw new RequestError('真实计算输入清单无法核对。');
    }
    return value as unknown as FixedCalculationInputs;
  },
  records: async (input: FixedCalculationRecordsInput): Promise<FixedCalculationRecordPage> => {
    const value = await request(base + '/records', 'POST', input);
    if (!object(value) || value.snapshotId !== input.snapshotId || value.productId !== input.productId || !Array.isArray(value.rows)
      || value.rows.some(row => !object(row) || typeof row.businessKey !== 'string' || typeof row.recordVersion !== 'string' || !object(row.values))
      || !object(value.page) || typeof value.page.hasMore !== 'boolean'
      || !(value.page.nextCursor === null || typeof value.page.nextCursor === 'string')) throw new RequestError('固定记录版本或分页无法核对。');
    return value as unknown as FixedCalculationRecordPage;
  },
  list: async () => {
    const value = await request(base + '/tasks');
    if (!object(value) || !Array.isArray(value.items)) throw new RequestError('原计算任务列表无法读取。');
    return value.items.map(task);
  },
  create: async (input: FixedCalculationInput) => task(await request(base + '/tasks', 'POST', input)),
  get: async (id: string) => task(await request(`${base}/tasks/${encodeURIComponent(id)}`)),
  stage: async (id: string) => task(await request(`${base}/tasks/${encodeURIComponent(id)}/stage`, 'POST', {})),
  prepare: async (id: string, input: R1PrepareInput): Promise<R1RequestView> => {
    const value = await request(`${base}/tasks/${encodeURIComponent(id)}/prepare`, 'POST', input);
    if (!object(value) || value.requestId !== input.requestId || value.planId !== input.planId || typeof value.documentSha256 !== 'string') {
      throw new RequestError('原计算候选的准备回执无法核对。');
    }
    return value as unknown as R1RequestView;
  },
};
