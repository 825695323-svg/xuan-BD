import type { R1CapabilitiesView, R1PrepareInput, R1ProductDiscovery, R1ProductRead, R1ProductReadInput, R1RequestSummary, R1RequestView, R1SnapshotStatus } from '../../../contracts/r1-contracts';
import type { MaterialCategory } from '../../../modules/collection/materials/contracts';
import { request, RequestError } from './api';
import { readBdJob } from './bd-api';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function connection(value: unknown): boolean {
  return object(value) && value.profile === 'data_only' && value.protocol === 'wfd.structured-ingest/1.0'
    && (value.mode === 'user_test' || value.mode === 'production') && value.purpose === value.mode
    && typeof value.connectionId === 'string' && !!value.connectionId
    && typeof value.store === 'string' && !!value.store && typeof value.runtime === 'string' && !!value.runtime;
}
export interface R1XlsxPreview {
  materialId: string; sha256: string;
  preview: { format: 'xlsx'; source: 'native-conversion'; conversionStatus: string; sheetCount: number; totalRows: number; totalCells: number;
    sheets: { name: string | null; nativeId: string | null; state: string | null; part: string | null; rowCount: number; cellCount: number }[];
    previewSheet: string | null; rows: { row: string | null; cells: { address: string | null; storageType: string | null;
      rawStorage: string | null; resolvedSharedString: string | null; inlineString: string | null;
      formula: { expression: string | null } | null; location: { part: string | null; sheet: string | null; cell: string | null } }[] }[];
    truncated: boolean; qualification: string; scopeGuidance: string };
}
function view(value: unknown): R1RequestView {
  if (!object(value) || typeof value.requestId !== 'string' || typeof value.state !== 'string' || typeof value.documentSha256 !== 'string'
    || !connection(value.connection)
    || typeof value.planId !== 'string' || typeof value.outputId !== 'string' || !Number.isSafeInteger(value.rowCount)
    || !Array.isArray(value.previewRows) || value.previewRows.length > 5 || !object(value.local)
    || typeof value.requiresRecovery !== 'boolean' || !(value.submitTaskId === null || typeof value.submitTaskId === 'string')) throw new RequestError('R1 原请求回执无法核对，请保留原请求编号。');
  return value as unknown as R1RequestView;
}
export const r1Api = {
  snapshotStatus: async (): Promise<R1SnapshotStatus> => {
    const value = await request('/api/bd/r1/products/snapshot', 'POST', {});
    if (!object(value) || value.authority !== 'active_head' || !(value.snapshotId === null || typeof value.snapshotId === 'string')
      || value.empty !== (value.snapshotId === null) || !object(value.connection) || value.connection.profile !== 'data_only'
      || !Array.isArray(value.connection.roles) || !object(value.units)) throw new RequestError('WFD 当前固定快照状态无法核对；不能当作空库。');
    return value as unknown as R1SnapshotStatus;
  },
  discoverProducts: async (snapshotId: string): Promise<R1ProductDiscovery> => {
    const value = await request('/api/bd/r1/products/discover', 'POST', { snapshotId });
    if (!object(value) || value.snapshotId !== snapshotId || value.historyMode !== 'snapshot_contents'
      || !object(value.connection) || value.connection.profile !== 'data_only' || !object(value.limits)
      || !Array.isArray(value.products) || !Array.isArray(value.selections)
      || value.selections.some(item => !object(item) || typeof item.productId !== 'string' || typeof item.datasetId !== 'string'
        || typeof item.payloadKind !== 'string' || !object(item.subject) || !Array.isArray(item.fields)
        || item.fields.some(field => typeof field !== 'string') || typeof item.readable !== 'boolean')) {
      throw new RequestError('固定快照产品与公开合同无法核对。');
    }
    return value as unknown as R1ProductDiscovery;
  },
  readProduct: async (input: R1ProductReadInput): Promise<R1ProductRead> => {
    const value = await request('/api/bd/r1/products/read', 'POST', input);
    if (!object(value) || value.snapshotId !== input.snapshotId || value.productId !== input.productId
      || value.historyMode !== 'snapshot_contents' || !object(value.connection) || value.connection.profile !== 'data_only'
      || !object(value.limits) || !object(value.result) || value.result.snapshot_id !== input.snapshotId
      || value.result.product_id !== input.productId || value.result.history_mode !== 'snapshot_contents'
      || !Array.isArray(value.result.rows) || !Array.isArray(value.result.fields) || !value.result.fields.every(field => typeof field === 'string')
      || input.fields !== undefined && JSON.stringify(value.result.fields) !== JSON.stringify([...input.fields].sort())
      || !Array.isArray(value.result.diagnostics)
      || !object(value.result.page) || typeof value.result.page.has_more !== 'boolean') throw new RequestError('持久数据页的固定身份、时间视角或分页无法核对。');
    return value as unknown as R1ProductRead;
  },
  capabilities: async (): Promise<R1CapabilitiesView> => {
    const value = await request('/api/bd/r1/capabilities');
    if (!object(value) || value.profile !== 'data_only' || value.protocol !== 'wfd.structured-ingest/1.0'
      || !object(value.configuration) || !object(value.limits) || !(value.connection === null || connection(value.connection))
      || value.automaticSubmit !== false || value.legacyReplay !== false) throw new RequestError('R1 能力状态无法核对。');
    return value as unknown as R1CapabilitiesView;
  },
  check: async () => {
    const value = await request('/api/bd/r1/check', 'POST', {});
    if (!object(value) || typeof value.supported !== 'boolean') throw new RequestError('data_only 能力核对失败。'); return value;
  },
  list: async (): Promise<R1RequestSummary[]> => {
    const value = await request('/api/bd/r1/requests');
    if (!object(value) || !Array.isArray(value.items) || value.items.length > 20
      || !value.items.every(item => object(item) && typeof item.requestId === 'string' && typeof item.state === 'string'
        && typeof item.rowCount === 'number' && Number.isSafeInteger(item.rowCount) && item.rowCount >= 0
        && (item.errorCode === null || typeof item.errorCode === 'string'))) throw new RequestError('R1 原请求列表无法核对。');
    return value.items;
  },
  get: async (id: string) => view(await request(`/api/bd/r1/requests/${encodeURIComponent(id)}`)),
  prepare: async (input: R1PrepareInput) => view(await request('/api/bd/r1/prepare', 'POST', input)),
  submit: async (input: R1RequestView) => readBdJob(await request(`/api/bd/r1/requests/${encodeURIComponent(input.requestId)}/submit`, 'POST', { confirmationDigest: input.documentSha256 })),
  recover: async (id: string, lookupId: string) => readBdJob(await request(`/api/bd/r1/requests/${encodeURIComponent(id)}/recover`, 'POST', { lookupId })),
  upload: async (file: File, requestId: string, category: MaterialCategory) => {
    if (!file.size || file.size > 25 * 1024 * 1024) throw new RequestError('请选择 25 MiB 以内的非空原件。');
    return readBdJob(await request(`/api/bd/materials/upload?${new URLSearchParams({ name: file.name, requestId, category })}`, 'POST', file));
  },
  xlsxPreview: async (materialId: string): Promise<R1XlsxPreview> => {
    const value = await request(`/api/bd/materials/${encodeURIComponent(materialId)}/xlsx-preview`);
    if (!object(value) || value.materialId !== materialId || typeof value.sha256 !== 'string' || !object(value.preview)
      || value.preview.format !== 'xlsx' || value.preview.source !== 'native-conversion'
      || !Array.isArray(value.preview.sheets) || !Array.isArray(value.preview.rows)
      || typeof value.preview.conversionStatus !== 'string' || typeof value.preview.truncated !== 'boolean') {
      throw new RequestError('XLSX 工作簿结构无法核对。');
    }
    return value as unknown as R1XlsxPreview;
  },
  createPlan: async (requestId: string, input: unknown) => readBdJob(await request('/api/bd/processing/plans', 'POST', { requestId, input })),
  plan: async (planId: string): Promise<Record<string, unknown>> => {
    const value = await request(`/api/bd/processing/plans/${encodeURIComponent(planId)}`);
    if (!object(value) || typeof value.planId !== 'string' || !Array.isArray(value.outputs)) throw new RequestError('真实加工计划无法核对。'); return value;
  },
  planByRequest: async (requestId: string): Promise<Record<string, unknown> | null> => {
    const value = await request(`/api/bd/processing/plans/by-request/${encodeURIComponent(requestId)}`);
    if (!object(value) || !(value.plan === null || object(value.plan))) throw new RequestError('处理请求无法核对。'); return value.plan as Record<string, unknown> | null;
  },
  run: async (planId: string, requestId: string) => readBdJob(await request(`/api/bd/processing/plans/${encodeURIComponent(planId)}/run`, 'POST', { requestId })),
};
