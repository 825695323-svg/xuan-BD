import type { R1AutoStartInput, R1AutoView } from '../../../modules/collection/r1-auto';
import type { R1BatchStartInput, R1BatchView } from '../../../modules/collection/r1-auto-batch';
import type { R1AlgorithmClassification, R1AlgorithmSettings } from '../../../modules/collection/r1-algorithm-routing';
import { request, RequestError } from './api';
import type { R1ChunkedCsvStart, R1ChunkedCsvView } from '../../../modules/collection/r1-chunked-csv';

export type { R1AutoStartInput, R1AutoView };
export type { R1BatchStartInput, R1BatchView };
export type { R1AlgorithmClassification, R1AlgorithmSettings };
export type { R1ChunkedCsvStart, R1ChunkedCsvView };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const states = ['inspecting', 'awaiting_answers', 'processing', 'submitting', 'recovering', 'associated', 'conflicts_pending', 'blocked', 'stopped'];

function view(value: unknown, requestId?: string): R1AutoView {
  if (!object(value) || typeof value.requestId !== 'string' || !value.requestId || requestId && value.requestId !== requestId
    || typeof value.materialId !== 'string' || typeof value.datasetId !== 'string' || !object(value.source)
    || !states.includes(String(value.state)) || !strings(value.planIds) || !strings(value.requestIds) || !strings(value.taskIds)
    || !Array.isArray(value.questions) || !value.questions.every(item => object(item) && typeof item.key === 'string'
      && typeof item.label === 'string' && (item.options === undefined || strings(item.options)))
    || !Array.isArray(value.evidence) || !value.evidence.every(item => object(item) && typeof item.key === 'string'
      && typeof item.value === 'string' && ['file', 'operator', 'contract'].includes(String(item.origin)))
    || !(value.currentRequest === null || object(value.currentRequest) && typeof value.currentRequest.requestId === 'string'
      && typeof value.currentRequest.state === 'string' && object(value.currentRequest.local))
    || !(value.definitionReview === null || object(value.definitionReview) && value.definitionReview.protocol === 'wfd.definition-review/1'
      && typeof value.definitionReview.machineRequestId === 'string' && typeof value.definitionReview.code === 'string'
      && ['return_to_bd', 'candidate_found'].includes(String(value.definitionReview.disposition)) && strings(value.definitionReview.missingFields))
    || !(value.localReturn === null || object(value.localReturn)) || !(value.error === null || object(value.error))
    || value.state === 'associated' && (!object(value.currentRequest) || value.currentRequest.state !== 'associated')) {
    throw new RequestError('自动交接记录无法核对，请保留原自动交接编号并仅读取原记录。');
  }
  return value as unknown as R1AutoView;
}

const path = (id: string) => `/api/bd/r1/auto/${encodeURIComponent(id)}`;
const batchPath = (id: string) => `/api/bd/r1/batches/${encodeURIComponent(id)}`;
function algorithmSettings(value: unknown): R1AlgorithmSettings {
  if (!object(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || [value.dailyPeriod, value.minutePeriod].some(period => period !== null && (!Number.isSafeInteger(period) || Number(period) < 2 || Number(period) > 1000)))
    throw new RequestError('日K与分钟K的已保存周期无法核对，请重新读取设置。');
  return value as unknown as R1AlgorithmSettings;
}
function classification(value: unknown): R1AlgorithmClassification {
  if (!object(value) || value.version !== 'bd.r1-algorithm-routing/1' || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || !Number.isSafeInteger(value.byteLength) || typeof value.complete !== 'boolean' || !strings(value.columns)
    || !Number.isSafeInteger(value.rowCount) || !['daily_bar', 'minute_bar', 'sentiment', 'mixed', 'other', 'unknown'].includes(String(value.kind))
    || ![null, 'csv', 'json'].includes(value.format as string | null) || typeof value.code !== 'string' || typeof value.reason !== 'string'
    || ['dateColumn', 'minuteColumn', 'valueColumn'].some(key => value[key] !== null && typeof value[key] !== 'string'))
    throw new RequestError('原件内容分类证据无法核对，未选择算法。');
  return value as unknown as R1AlgorithmClassification;
}
function batchView(value: unknown): R1BatchView {
  if (!object(value) || typeof value.batchId !== 'string' || !value.batchId || !object(value.source) || typeof value.datasetId !== 'string'
    || !['awaiting_upload', 'running', 'awaiting_answers', 'recovering', 'completed', 'conflicts_pending', 'stopped', 'blocked'].includes(String(value.state))
    || typeof value.duplicateBatch !== 'boolean' || !(value.nextUploadItemId === null || typeof value.nextUploadItemId === 'string')
    || !(value.sourceValueColumns === null || strings(value.sourceValueColumns))
    || !(value.calculation == null || object(value.calculation) && object(value.calculation.selection)
      && value.calculation.selection.method === 'source_observation_ma' && typeof value.calculation.selection.valueColumn === 'string'
      && Number.isInteger(value.calculation.selection.period) && ['waiting_inputs','calculating','custody','processing','associated','blocked','recovering','stopped'].includes(String(value.calculation.state))
      && (value.calculation.auto === null || !!view(value.calculation.auto)))
    || !Array.isArray(value.items) || value.items.length > 100 || !value.items.every(item => object(item)
      && typeof item.itemId === 'string' && typeof item.name === 'string' && typeof item.relativePath === 'string'
      && typeof item.sha256 === 'string' && Number.isSafeInteger(item.byteLength) && typeof item.requestedUrl === 'string'
      && typeof item.autoRequestId === 'string' && [...states, 'awaiting_upload', 'custody'].includes(String(item.state))
      && (item.duplicateOf === null || object(item.duplicateOf) && typeof item.duplicateOf.batchId === 'string' && typeof item.duplicateOf.itemId === 'string')
      && (item.auto === null || !!view(item.auto, item.autoRequestId)))) throw new RequestError('批次清单或逐件状态无法核对，请保留原批编号。');
  return value as unknown as R1BatchView;
}
export const r1AutoApi = {
  chunkedCsv: async (id: string) => chunkedView(await request(`/api/bd/r1/batches/chunked/${encodeURIComponent(id)}`)),
  startChunkedCsv: async (input: R1ChunkedCsvStart) => chunkedView(await request('/api/bd/r1/batches/chunked/start', 'POST', input)),
  uploadCsvChunk: async (id: string, offset: number, bytes: Blob) => chunkedView(await request(`/api/bd/r1/batches/chunked/${encodeURIComponent(id)}/chunks/${offset}`, 'POST', bytes)),
  advanceChunkedCsv: async (id: string) => chunkedView(await request(`/api/bd/r1/batches/chunked/${encodeURIComponent(id)}/advance`, 'POST', {})),
  resumeChunkedCsv:async(id:string,confirmationDigest:string)=>chunkedView(await request(`/api/bd/r1/batches/chunked/${encodeURIComponent(id)}/resume-original`,'POST',{confirmationDigest})),
  algorithmSettings: async () => algorithmSettings(await request('/api/bd/r1/batches/algorithm-settings')),
  saveAlgorithmSettings: async (input: R1AlgorithmSettings) => algorithmSettings(await request('/api/bd/r1/batches/algorithm-settings', 'PUT', input)),
  classify: async (file: File) => classification(await request('/api/bd/r1/batches/classify', 'POST', file)),
  calculationEvidence: async (id: string, calculationId?: string) => {
    const result = await request(batchPath(id) + '/calculation-evidence' + (calculationId ? `?calculationId=${encodeURIComponent(calculationId)}` : ''));
    if (!object(result) || result.batchId !== id || !object(result.proof) || result.proof.method !== 'source_observation_ma'
      || !Array.isArray(result.proof.lineage) || !Array.isArray(result.proof.sources)) throw new RequestError('本批尚无可核对的均线输入及窗口明细。');
    return result.proof;
  },
  listBatches: async (): Promise<R1BatchView[]> => {
    const value = await request('/api/bd/r1/batches');
    if (!object(value) || !Array.isArray(value.items)) throw new RequestError('批次列表无法读取。');
    return value.items.map(batchView);
  },
  batch: async (id: string) => batchView(await request(batchPath(id))),
  startBatch: async (input: R1BatchStartInput) => batchView(await request('/api/bd/r1/batches/start', 'POST', input)),
  uploadBatchItem: async (batchId: string, itemId: string, file: File) => batchView(await request(`${batchPath(batchId)}/items/${encodeURIComponent(itemId)}/upload`, 'POST', file)),
  advanceBatch: async (id: string) => batchView(await request(`${batchPath(id)}/advance`, 'POST', {})),
  list: async (): Promise<R1AutoView[]> => {
    const value = await request('/api/bd/r1/auto');
    if (!object(value) || !Array.isArray(value.items)) throw new RequestError('自动交接列表无法读取。');
    return value.items.map(item => view(item));
  },
  get: async (id: string) => view(await request(path(id)), id),
  start: async (input: R1AutoStartInput) => view(await request('/api/bd/r1/auto/start', 'POST', input), input.requestId),
  answer: async (id: string, answers: Record<string, string>) => view(await request(`${path(id)}/answers`, 'POST', { answers }), id),
  advance: async (id: string) => view(await request(`${path(id)}/advance`, 'POST', {}), id),
};

function chunkedView(value: unknown): R1ChunkedCsvView {
  if (!object(value) || typeof value.intakeId !== 'string' || typeof value.name !== 'string' || typeof value.sha256 !== 'string'
    || !Number.isSafeInteger(value.byteLength) || !Number.isSafeInteger(value.receivedBytes) || !Number.isSafeInteger(value.chunkBytes)
    || typeof value.parsed !== 'boolean' || !['totalRows','totalPages','publishedRows','publishedPages'].every(key => Number.isSafeInteger(value[key]))
    || !['receiving','custody','parsing','publishing','awaiting_answers','recovering','completed','conflicts_pending','blocked','stopped'].includes(String(value.state))
    || !['processedRows','processedPages'].every(key => Number.isSafeInteger(value[key]))
    || !Array.isArray(value.conflictPages) || !value.conflictPages.every(page => object(page) && Number.isSafeInteger(page.ordinal)
      && Number.isSafeInteger(page.rowStart) && Number.isSafeInteger(page.rowEnd) && typeof page.autoRequestId === 'string' && Number.isSafeInteger(page.conflictCount))
    || !(value.rowSummary === null || object(value.rowSummary) && ['inserted','duplicate_skipped','conflict_pending'].every(key => Number.isSafeInteger(value.rowSummary && (value.rowSummary as Record<string, unknown>)[key])))
    || !(value.activePage === null || object(value.activePage) && Array.isArray(value.activePage.locations)
      && Number.isSafeInteger(value.activePage.rowStart) && Number.isSafeInteger(value.activePage.rowEnd)
      && (value.activePage.auto === null || !!view(value.activePage.auto)))) throw new RequestError('分块原件的接收、完整解析或分页覆盖无法核对，请保留原编号。');
  return value as unknown as R1ChunkedCsvView;
}
