import { request, RequestError } from './api';
import { readHarnessJob, type HarnessJob } from './harness-api';
import type { FileView } from './platform-api';
import type { MaterialEnvelope, MaterialPreview, MaterialRecord } from '../../../modules/collection/materials/contracts';
import type { CandidateView, ConversationCandidatePage, ConversationProcessingItem, ConversationProcessingPage, DataBrowserPage, OfficialCatalogItem, OfficialDataView, OfficialDatasetView, OfficialGenericView, OfficialSnapshotView, ProcessingOutputView, ProcessingPlanView, ProcessingStepView, ProcessingTaskView } from '../../server/data-browser-routes';
export type { CandidateView, ConversationCandidatePage, ConversationProcessingItem, ConversationProcessingPage, DataBrowserPage, OfficialCatalogItem, OfficialDataView, OfficialDatasetView, OfficialGenericView, OfficialSnapshotView, ProcessingOutputView, ProcessingPlanView, ProcessingStepView, ProcessingTaskView };

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function nullableString(value: unknown): boolean { return value === null || typeof value === 'string'; }
function page<T>(value: unknown, read: (item: unknown) => T): DataBrowserPage<T> {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 50 || !Number.isSafeInteger(value.limit)
    || Number(value.limit) < 1 || Number(value.limit) > 50 || value.items.length > Number(value.limit)
    || !(value.nextCursor === null || typeof value.nextCursor === 'string' && !!value.nextCursor)
    || typeof value.query !== 'string' || typeof value.scope !== 'string' || !['available', 'unavailable'].includes(String(value.availability))) {
    throw new RequestError('列表分页结果暂时无法核对。');
  }
  return { ...value, items: value.items.map(read) } as unknown as DataBrowserPage<T>;
}
function file(value: unknown): FileView {
  if (!record(value) || typeof value.id !== 'string' || typeof value.displayName !== 'string' || !Number.isSafeInteger(value.version)
    || !['user-attached', 'user-selected', 'generated'].includes(String(value.source)) || typeof value.size !== 'number'
    || typeof value.invocationPath !== 'string' || !Array.isArray(value.relations)) throw new RequestError('文件记录暂时无法核对。');
  return value as unknown as FileView;
}
function materialEnvelope(value: unknown): MaterialEnvelope {
  if (!record(value) || typeof value.materialId !== 'string' || typeof value.filename !== 'string' || value.version !== 1
    || typeof value.sha256 !== 'string' || typeof value.byteLength !== 'number' || typeof value.category !== 'string') throw new RequestError('材料记录暂时无法核对。');
  return value as unknown as MaterialEnvelope;
}
function preview(value: unknown): MaterialPreview {
  if (!record(value) || typeof value.category !== 'string' || typeof value.format !== 'string' || typeof value.support !== 'string'
    || !record(value.checks) || !['preview_only', 'needs_confirmation', 'blocked'].includes(String(value.checks.status))
    || !Array.isArray(value.checks.issues) || !Array.isArray(value.pending) || !Array.isArray(value.limitations)) {
    throw new RequestError('材料预览暂时无法核对。');
  }
  return value as unknown as MaterialPreview;
}
function material(value: unknown): MaterialRecord {
  if (!record(value)) throw new RequestError('材料预览暂时无法核对。');
  return { envelope: materialEnvelope(value.envelope), preview: preview(value.preview) };
}
function coverage(value: unknown): CandidateView['outputs'][number]['coverage'] {
  if (!record(value) || typeof value.complete !== 'boolean' || !Array.isArray(value.gaps)
    || !(value.scope === null || typeof value.scope === 'string')) return null;
  return value as unknown as CandidateView['outputs'][number]['coverage'];
}
function readback(value: unknown): CandidateView['outputs'][number]['readback'] {
  if (!record(value) || typeof value.state !== 'string' || !Number.isSafeInteger(value.rows) || typeof value.rowsSha256 !== 'string') return null;
  return value as unknown as CandidateView['outputs'][number]['readback'];
}
function issues(value: unknown): CandidateView['outputs'][number]['issues'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => record(item) && typeof item.code === 'string' && typeof item.message === 'string'
    ? [{ code: item.code, message: item.message }] : []);
}
function candidateOutput(value: unknown): CandidateView['outputs'][number] {
  if (!record(value) || typeof value.outputId !== 'string' || typeof value.namespace !== 'string' || typeof value.state !== 'string'
    || !(value.productId === null || typeof value.productId === 'string')
    || !(value.expectedSnapshotId === null || typeof value.expectedSnapshotId === 'string')
    || !(value.preparedState === null || typeof value.preparedState === 'string')
    || !(value.commitId === null || typeof value.commitId === 'string')
    || !(value.snapshotId === null || typeof value.snapshotId === 'string') || typeof value.registered !== 'boolean') {
    throw new RequestError('候选输出暂时无法核对。');
  }
  return {
    outputId: value.outputId, namespace: value.namespace, productId: value.productId, expectedSnapshotId: value.expectedSnapshotId,
    preparedState: value.preparedState, state: value.state, commitId: value.commitId, snapshotId: value.snapshotId, registered: value.registered,
    coverage: coverage(value.coverage), custody: record(value.custody) && typeof value.custody.state === 'string'
      && Number.isSafeInteger(value.custody.byteLength) && typeof value.custody.manifestSha256 === 'string'
      ? value.custody as unknown as CandidateView['outputs'][number]['custody'] : null,
    readback: readback(value.readback), issues: issues(value.issues),
  };
}
function candidate(value: unknown): CandidateView {
  if (!record(value) || typeof value.taskId !== 'string' || typeof value.title !== 'string' || typeof value.action !== 'string'
    || typeof value.status !== 'string' || typeof value.requestId !== 'string' || !Number.isSafeInteger(value.createdAt)
    || !Number.isSafeInteger(value.updatedAt) || !(value.parentTaskId === null || typeof value.parentTaskId === 'string')
    || typeof value.requiresReview !== 'boolean' || !(value.approvalId === null || typeof value.approvalId === 'string')
    || !(value.blockedReason === null || typeof value.blockedReason === 'string') || !Array.isArray(value.outputs)
    || !record(value.database) || typeof value.database.state !== 'string' || !record(value.actionability)
    || typeof value.actionability.canSubmit !== 'boolean' || typeof value.actionability.canResume !== 'boolean'
    || typeof value.actionability.canCancel !== 'boolean' || typeof value.actionability.canReconcile !== 'boolean') {
    throw new RequestError('候选任务暂时无法核对。');
  }
  return { ...value, outputs: value.outputs.map(candidateOutput) } as unknown as CandidateView;
}
function dataset(value: unknown): OfficialDatasetView {
  if (!record(value) || typeof value.datasetId !== 'string' || typeof value.registered !== 'boolean' || typeof value.readable !== 'boolean'
    || !Array.isArray(value.allowedPurposes) || !Array.isArray(value.snapshotIds)
    || !(value.headSnapshotId === null || typeof value.headSnapshotId === 'string')) throw new RequestError('数据库能力暂时无法核对。');
  return value as unknown as OfficialDatasetView;
}
function snapshot(value: unknown): OfficialSnapshotView {
  if (!record(value) || typeof value.productId !== 'string' || typeof value.snapshotId !== 'string' || typeof value.commitId !== 'string'
    || typeof value.outputId !== 'string' || typeof value.taskId !== 'string' || typeof value.requestId !== 'string'
    || typeof value.state !== 'string' || typeof value.registered !== 'boolean') throw new RequestError('已登记产品/快照暂时无法核对。');
  return { ...value, coverage: coverage(value.coverage), readback: readback(value.readback), issues: issues(value.issues) } as unknown as OfficialSnapshotView;
}
function catalogItem(value: unknown): OfficialCatalogItem {
  if (!record(value) || typeof value.productId !== 'string' || !Array.isArray(value.snapshots)) throw new RequestError('已登记产品暂时无法核对。');
  return { ...value, snapshots: value.snapshots.map(snapshot) } as unknown as OfficialCatalogItem;
}
function processingStep(value: unknown): ProcessingStepView {
  if (!record(value) || typeof value.stepId !== 'string' || typeof value.outputId !== 'string' || typeof value.kind !== 'string'
    || typeof value.state !== 'string' || typeof value.required !== 'boolean'
    || !(value.applicability === null || typeof value.applicability === 'string')
    || !Array.isArray(value.dependsOn) || !value.dependsOn.every(item => typeof item === 'string')
    || !Array.isArray(value.gaps) || !value.gaps.every(item => typeof item === 'string')
    || !(value.outputDigest === null || typeof value.outputDigest === 'string')
    || !(value.output === null || record(value.output) && typeof value.output.sha256 === 'string'
      && (value.output.byteLength === null || Number.isSafeInteger(value.output.byteLength)))
    || !(value.error === null || record(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string')
    || !(value.reusedFrom === null || record(value.reusedFrom) && typeof value.reusedFrom.planId === 'string' && typeof value.reusedFrom.stepId === 'string')) {
    throw new RequestError('处理步骤事实暂时无法核对。');
  }
  return value as unknown as ProcessingStepView;
}
function processingTask(value: unknown): ProcessingTaskView {
  if (!record(value) || typeof value.taskId !== 'string' || typeof value.action !== 'string' || typeof value.status !== 'string'
    || !Number.isSafeInteger(value.version) || !Number.isSafeInteger(value.generation)
    || !(value.currentRunId === null || typeof value.currentRunId === 'string') || typeof value.requestId !== 'string'
    || !Number.isSafeInteger(value.updatedAt)
    || !(value.error === null || record(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string')) {
    throw new RequestError('处理任务事实暂时无法核对。');
  }
  return value as unknown as ProcessingTaskView;
}
function processingPlan(value: unknown): ProcessingPlanView {
  if (!record(value) || typeof value.planId !== 'string' || typeof value.requestId !== 'string'
    || !(value.parentPlanId === null || typeof value.parentPlanId === 'string') || typeof value.status !== 'string'
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)
    || !Array.isArray(value.materials) || value.materials.length > 50 || !value.materials.every(item => record(item)
      && typeof item.materialId === 'string' && typeof item.filename === 'string' && typeof item.sha256 === 'string'
      && typeof item.format === 'string' && typeof item.support === 'string' && typeof item.custodyState === 'string'
      && typeof item.routingState === 'string' && Array.isArray(item.gaps) && item.gaps.every(gap => typeof gap === 'string'))
    || !Array.isArray(value.outputs) || value.outputs.length > 50 || !Array.isArray(value.steps) || value.steps.length > 500) {
    throw new RequestError('处理计划事实暂时无法核对。');
  }
  const outputs = value.outputs.map(item => {
    if (!record(item) || typeof item.outputId !== 'string' || typeof item.state !== 'string'
      || !Array.isArray(item.materialIds) || !item.materialIds.every(id => typeof id === 'string')
      || !Array.isArray(item.gaps) || !item.gaps.every(gap => typeof gap === 'string')
      || !Array.isArray(item.semanticGaps) || !item.semanticGaps.every(gap => typeof gap === 'string')
      || !(item.target === null || record(item.target) && ['product', 'declaration', 'none'].includes(String(item.target.kind)))
      || !(item.evidenceScope === null || typeof item.evidenceScope === 'string')
      || !Array.isArray(item.steps)) throw new RequestError('处理输出事实暂时无法核对。');
    return { ...item, steps: item.steps.map(processingStep) } as unknown as ProcessingOutputView;
  });
  return { ...value, outputs, steps: (value.steps as unknown[]).map(processingStep) } as unknown as ProcessingPlanView;
}
function processingItem(value: unknown): ConversationProcessingItem {
  if (!record(value) || !(value.task === null || record(value.task))
    || !Array.isArray(value.executions)) throw new RequestError('处理计划关联暂时无法核对。');
  return { plan: processingPlan(value.plan), task: value.task ? processingTask(value.task) : null,
    executions: value.executions.map(processingTask) };
}
export function readConversationProcessingPage(value: unknown, conversationId: string, branchId: string): ConversationProcessingPage {
  if (!record(value) || value.conversationId !== conversationId || value.branchId !== branchId
    || !['available', 'unavailable'].includes(String(value.availability))
    || !(value.reason === null || typeof value.reason === 'string') || typeof value.scope !== 'string'
    || !Array.isArray(value.items) || value.items.length > 10) throw new RequestError('会话处理计划关联暂时无法核对。');
  return { ...value, items: value.items.map(processingItem) } as unknown as ConversationProcessingPage;
}
export function readOfficialDataView(value: unknown): OfficialDataView {
  if (!record(value) || !['unbound', 'registered', 'unreachable', 'denied', 'unavailable'].includes(String(value.connection))
    || !(value.code === null || typeof value.code === 'string') || !(value.reason === null || typeof value.reason === 'string')
    || typeof value.source !== 'string' || value.productionBinding !== 'unbound' || !nullableString(value.checkedAt) || typeof value.observedAt !== 'string'
    || !record(value.check) || !['never', 'passed', 'failed'].includes(String(value.check.state))
    || !nullableString(value.check.checkedAt) || !Array.isArray(value.datasets) || !record(value.catalog)
    || !record(value.generic) || !['never', 'passed', 'failed'].includes(String(value.generic.status))
    || !nullableString(value.generic.checkedAt) || !Array.isArray(value.generic.products) || !Array.isArray(value.generic.operations)
    || !(value.generic.error === null || record(value.generic.error) && typeof value.generic.error.code === 'string' && typeof value.generic.error.message === 'string')
    || value.catalog.status !== 'not_provided' || !Array.isArray(value.catalog.items) || typeof value.catalog.reason !== 'string'
    || !(value.line === null || record(value.line) && Array.isArray(value.line.registered))) throw new RequestError('数据库线路状态暂时无法核对。');
  return { ...value, datasets: value.datasets.map(dataset), catalog: { ...value.catalog, items: value.catalog.items.map(catalogItem) } } as unknown as OfficialDataView;
}
function queryPath(path: string, query: string, cursor?: string | null, group?: string) {
  const values = new URLSearchParams({ q: query, limit: '50', ...(cursor ? { cursor } : {}), ...(group ? { group } : {}) });
  return `/api/ui/data-browser/${path}?${values}`;
}
async function job(value: unknown): Promise<HarnessJob> { return readHarnessJob(value); }
export const dataBrowserApi = {
  files: async (group: 'materials' | 'outputs', query: string, cursor?: string | null) => page(await request(queryPath('files', query, cursor, group)), file),
  materials: async (query: string, cursor?: string | null) => page(await request(queryPath('materials', query, cursor)), materialEnvelope),
  material: async (id: string) => material(await request(`/api/ui/data-browser/materials/${encodeURIComponent(id)}`)),
  jobs: async (query: string, cursor?: string | null): Promise<DataBrowserPage<HarnessJob>> => page(await request(queryPath('jobs', query, cursor)), readHarnessJob),
  candidates: async (query: string, cursor?: string | null): Promise<DataBrowserPage<CandidateView>> => page(await request(queryPath('candidates', query, cursor)), candidate),
  conversationCandidates: async (conversationId: string, branchId: string): Promise<ConversationCandidatePage> => {
    const value = await request(`/api/ui/data-browser/conversation-candidates?${new URLSearchParams({ conversationId, branchId })}`);
    if (!record(value) || value.conversationId !== conversationId || value.branchId !== branchId || !Array.isArray(value.items)
      || !['available', 'unavailable'].includes(String(value.availability)) || !(value.reason === null || typeof value.reason === 'string')
      || typeof value.scope !== 'string') throw new RequestError('会话候选关联暂时无法核对。');
    return { ...value, items: value.items.map(candidate) } as unknown as ConversationCandidatePage;
  },
  conversationProcessing: async (conversationId: string, branchId: string): Promise<ConversationProcessingPage> =>
    readConversationProcessingPage(await request(`/api/ui/data-browser/conversation-processing?${new URLSearchParams({ conversationId, branchId })}`), conversationId, branchId),
  processingTask: async (taskId: string): Promise<HarnessJob> =>
    job(await request(`/api/harness/jobs/${encodeURIComponent(taskId)}`)),
  cancelProcessingTask: async (taskId: string): Promise<HarnessJob> =>
    job(await request(`/api/harness/jobs/${encodeURIComponent(taskId)}/cancel`, 'POST', {})),
  official: async () => readOfficialDataView(await request('/api/ui/data-browser/official')),
  checkOfficial: async (expectedRevision: number) => readOfficialDataView(await request('/api/ui/data-browser/official/check', 'POST', { expectedRevision })),
  submitCandidate: async (preparedTaskId: string, completion: 'accepted' | 'received' | 'committed', requestId: string): Promise<HarnessJob> =>
    job(await request('/api/harness/candidates/submit', 'POST', { preparedTaskId, completion, requestId })),
  controlCandidate: async (taskId: string, action: 'resume' | 'cancel', detail: string, requestId: string): Promise<HarnessJob> =>
    job(await request(`/api/harness/candidates/${encodeURIComponent(taskId)}/control`, 'POST', { action, detail, requestId })),
  reconcileCandidate: async (taskId: string) => await request(`/api/harness/candidates/${encodeURIComponent(taskId)}/reconcile`, 'POST', {}),
};
