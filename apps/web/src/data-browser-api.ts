import { request, RequestError } from './api';
import { readBdJob, type BdJob } from './bd-api';
import type { FileView } from './platform-api';
import type { MaterialEnvelope, MaterialPreview, MaterialRecord } from '../../../modules/collection/materials/contracts';
import type { ConversationProcessingItem, ConversationProcessingPage, DataBrowserPage, ProcessingOutputView, ProcessingPlanView, ProcessingStepView, ProcessingTaskView } from '../../server/data-browser-routes';
export type { ConversationProcessingItem, ConversationProcessingPage, DataBrowserPage, ProcessingOutputView, ProcessingPlanView, ProcessingStepView, ProcessingTaskView };

export interface MaterialProcessingOutput {
  planId: string; outputId: string; state: string; routingState: string; rejectReason: string | null;
}

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
      || !(item.rejectReason === null || typeof item.rejectReason === 'string')
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
function queryPath(path: string, query: string, cursor?: string | null, group?: string) {
  const values = new URLSearchParams({ q: query, limit: '50', ...(cursor ? { cursor } : {}), ...(group ? { group } : {}) });
  return `/api/ui/data-browser/${path}?${values}`;
}
async function job(value: unknown): Promise<BdJob> { return readBdJob(value); }
export const dataBrowserApi = {
  files: async (group: 'materials' | 'outputs', query: string, cursor?: string | null) => page(await request(queryPath('files', query, cursor, group)), file),
  materials: async (query: string, cursor?: string | null) => page(await request(queryPath('materials', query, cursor)), materialEnvelope),
  material: async (id: string) => material(await request(`/api/ui/data-browser/materials/${encodeURIComponent(id)}`)),
  materialProcessing: async (id: string): Promise<MaterialProcessingOutput[] | null> => {
    let routing: unknown;
    try { routing = await request(`/api/bd/processing/materials/${encodeURIComponent(id)}/routing`); }
    catch (error) {
      if (error instanceof RequestError && error.status === 404 && error.code === 'PROCESSING_ROUTING_NOT_FOUND') return null;
      throw error;
    }
    if (!record(routing) || routing.materialId !== id || !Array.isArray(routing.outputs) || routing.outputs.length > 50) {
      throw new RequestError('该材料的处理路由无法核对。');
    }
    const seen = new Set<string>(), outputs: MaterialProcessingOutput[] = [];
    for (const decision of routing.outputs) {
      if (!record(decision) || decision.scope !== 'output' || typeof decision.planId !== 'string'
        || typeof decision.outputId !== 'string' || !Array.isArray(decision.materialIds)
        || !decision.materialIds.every(value => typeof value === 'string') || !decision.materialIds.includes(id)) {
        throw new RequestError('该材料的处理计划关联无法核对。');
      }
      if (seen.has(decision.outputId)) continue;
      seen.add(decision.outputId);
      const plan = await request(`/api/bd/processing/plans/${encodeURIComponent(decision.planId)}`);
      if (!record(plan) || plan.planId !== decision.planId || !Array.isArray(plan.materials)
        || !plan.materials.some(value => record(value) && value.materialId === id) || !Array.isArray(plan.outputs)) {
        throw new RequestError('该材料的冻结处理计划无法核对。');
      }
      const output = plan.outputs.find(value => record(value) && value.outputId === decision.outputId);
      if (!record(output) || !Array.isArray(output.materialIds) || !output.materialIds.includes(id)
        || typeof output.state !== 'string' || typeof output.routingState !== 'string'
        || !(output.rejectReason === null || typeof output.rejectReason === 'string')) {
        throw new RequestError('该材料的处理输出无法核对。');
      }
      outputs.push({ planId: decision.planId, outputId: decision.outputId, state: output.state,
        routingState: output.routingState, rejectReason: output.rejectReason });
    }
    return outputs;
  },
  jobs: async (query: string, cursor?: string | null): Promise<DataBrowserPage<BdJob>> => page(await request(queryPath('jobs', query, cursor)), readBdJob),
  conversationProcessing: async (conversationId: string, branchId: string): Promise<ConversationProcessingPage> =>
    readConversationProcessingPage(await request(`/api/ui/data-browser/conversation-processing?${new URLSearchParams({ conversationId, branchId })}`), conversationId, branchId),
  processingTask: async (taskId: string): Promise<BdJob> =>
    job(await request(`/api/bd/jobs/${encodeURIComponent(taskId)}`)),
  cancelProcessingTask: async (taskId: string): Promise<BdJob> =>
    job(await request(`/api/bd/jobs/${encodeURIComponent(taskId)}/cancel`, 'POST', {})),
};
