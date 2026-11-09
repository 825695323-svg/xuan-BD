import { Router } from 'express';
import { CoreError } from '../../platform/runtime/errors.js';
import type { TaskRecord } from '../../contracts/task-contracts.js';
import type { MaterialRecord } from '../../modules/collection/materials/contracts.js';
import type { ApplicationServices } from './services.js';

export interface DataBrowserPage<T> {
  items: T[];
  nextCursor: string | null;
  limit: number;
  query: string;
  availability: 'available' | 'unavailable';
  scope: string;
}
export interface ProcessingStepView {
  stepId: string; outputId: string; kind: string; state: string;
  required: boolean; applicability: string | null; dependsOn: string[]; gaps: string[];
  outputDigest: string | null; output: { sha256: string; byteLength: number | null } | null;
  error: { code: string; message: string } | null;
  reusedFrom: { planId: string; stepId: string } | null;
}
export interface ProcessingOutputView {
  outputId: string; materialIds: string[]; intendedAction: string;
  target: { kind: 'product' | 'declaration' | 'none'; productId: string | null; expectedSnapshotId: string | null } | null;
  routingState: string; state: string; rejectReason: string | null; gaps: string[]; semanticGaps: string[];
  publishEligible?: boolean; publishAuthorization?: string; publishScope?: string;
  evidenceScope: string | null; steps: ProcessingStepView[];
}
export interface ProcessingMaterialView {
  materialId: string; filename: string; sha256: string; format: string; support: string;
  custodyState: string; routingState: string; gaps: string[];
}
export interface ProcessingPlanView {
  planId: string; requestId: string; parentPlanId: string | null; status: string;
  createdAt: number; updatedAt: number;
  materials: ProcessingMaterialView[]; outputs: ProcessingOutputView[]; steps: ProcessingStepView[];
}
export interface ProcessingTaskView {
  taskId: string; action: string; status: string; version: number; generation: number;
  currentRunId: string | null; requestId: string; updatedAt: number;
  error: { code: string; message: string } | null;
}
export interface ConversationProcessingItem {
  plan: ProcessingPlanView; task: ProcessingTaskView | null; executions: ProcessingTaskView[];
}
export interface ConversationProcessingPage {
  conversationId: string; branchId: string;
  items: ConversationProcessingItem[]; availability: 'available' | 'unavailable';
  reason: string | null; scope: string;
}
type Position = { createdAt: number; id: string };
/** 对既有本机/同宿主服务记录的只读分页投影；不会装配正式数据库或新的目录服务。 */
export function createDataBrowserRouter(services: ApplicationServices) {
  const router = Router(), companion = services.options.workspaceServices;
  router.get('/files', (req, res) => {
    if (req.query.group !== 'materials' && req.query.group !== 'outputs') invalid('请选择材料或产物列表。');
    const collection = `files:${req.query.group}`, input = pageInput(req.query, collection, ['group']);
    const page = services.files.listPage({ group: req.query.group, query: input.query, after: input.after, limit: input.limit });
    res.json(presentPage(page, input, collection, 'personal.file_references:displayName,id'));
  });
  router.get('/materials', (req, res) => {
    const input = pageInput(req.query, 'materials');
    const page = companion?.materials?.listPage({ query: input.query, after: input.after, limit: input.limit });
    res.json(presentPage(page ?? { items: [], next: null }, input, 'materials',
      'workspace.materials:filename,materialId,category; completed custody only', page ? 'available' : 'unavailable'));
  });
  router.get('/materials/:id', (req, res) => {
    if (Object.keys(req.query).length) invalid('材料预览不接受检索或路径参数。');
    if (!companion?.materials) throw new CoreError('MATERIAL_PREVIEW_UNAVAILABLE', '材料服务尚未装配，不能读取预览。', 503);
    const record: MaterialRecord = companion.materials.get(req.params.id);
    res.json(record);
  });
  router.get('/jobs', (req, res) => {
    const input = pageInput(req.query, 'jobs');
    if (!companion?.bd) {
      res.json(presentPage({ items: [], next: null }, input, 'jobs', 'workspace.tasks: active, approval, result or failure', 'unavailable')); return;
    }
    const parameters: (number | string)[] = [input.query, input.query, input.query, input.query, input.query, input.query];
    let where = "owner_role='service' AND (instr(lower(action),lower(?))>0 OR instr(lower(id),lower(?))>0 OR instr(lower(title),lower(?))>0 OR instr(lower(status),lower(?))>0 OR instr(lower(coalesce(json_extract(result,'$.summary'),'')),lower(?))>0 OR instr(lower(coalesce(blocked_reason,'')),lower(?))>0)";
    if (input.after) { where += ' AND (created_at<? OR (created_at=? AND id>?))'; parameters.push(input.after.createdAt, input.after.createdAt, input.after.id); }
    const rows = companion.database.connection.prepare(`SELECT id,created_at FROM tasks WHERE ${where} ORDER BY created_at DESC,id LIMIT ?`).all(...parameters, input.limit + 1);
    const visible = rows.slice(0, input.limit), last = visible.at(-1);
    const page = { items: visible.map(row => {
      const task = companion.tasks.get(String(row.id));
      return { ...companion.bd!.taskView(task.id), title: task.title, progress: task.progress ?? null,
        blockedReason: task.blockedReason, createdAt: task.createdAt, updatedAt: task.updatedAt };
    }),
      next: rows.length > input.limit && last ? { createdAt: Number(last.created_at), id: String(last.id) } : null };
    res.json(presentPage(page, input, 'jobs', 'workspace.tasks:operation,status,progress,approval,error,result; includes active and waiting approval'));
  });
  router.get('/conversation-processing', (req, res) => {
    const input = conversationInput(req.query);
    const state = services.core.getState(input.conversationId);
    if (!state.branches.some(branch => branch.id === input.branchId)) throw new CoreError('STALE_BRANCH', '会话分支已变化，请重新读取。', 409);
    const scope = 'conversation_processing_links: exact conversation and branch only';
    const companion = services.options.workspaceServices;
    const processing = services.processing ?? companion?.processing;
    const processingTasks = companion?.tasks ?? services.tasks;
    if (!processing) {
      res.json({ conversationId: input.conversationId, branchId: input.branchId, items: [], availability: 'unavailable',
        reason: '处理计划服务未装配，不能读取本分支计划。', scope } satisfies ConversationProcessingPage); return;
    }
    if (!services.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_processing_links'").get()) {
      res.json({ conversationId: input.conversationId, branchId: input.branchId, items: [], availability: 'unavailable',
        reason: '本会话尚未装配处理计划关联记录。', scope } satisfies ConversationProcessingPage); return;
    }
    const rows = services.database.connection.prepare(`SELECT ref_id,task_id,kind,material_id,origin_json,created_at
      FROM conversation_processing_links WHERE kind IN ('plan','execution') ORDER BY created_at DESC,rowid DESC LIMIT 500`).all();
    const plans = new Map<string, { taskId: string }>(), executions = new Map<string, string[]>();
    for (const row of rows) {
      let origin: unknown;
      try { origin = JSON.parse(String(row.origin_json)); } catch { continue; }
      if (!record(origin) || origin.conversationId !== input.conversationId || origin.branchId !== input.branchId) continue;
      const planId = String(row.material_id ?? '');
      if (row.kind === 'plan') {
        if (typeof row.ref_id === 'string' && !plans.has(row.ref_id)) plans.set(row.ref_id, { taskId: String(row.task_id) });
      } else if (planId && typeof row.task_id === 'string') {
        const list = executions.get(planId) ?? [];
        if (!list.includes(row.task_id)) list.push(row.task_id);
        executions.set(planId, list);
      }
    }
    // 同一计划的执行任务可能由会话代理或本机界面的既有 run/单步/recover 入口创建；
    // 计划本身已按精确分支链接核对，执行任务只从该计划的事实反查，不接受任意 taskId。
    for (const task of processingTasks.list({ ownerRole: 'service', limit: 1000 })) {
      const args = record(task.args) ? task.args as Record<string, unknown> : null;
      const planId = args && typeof args.planId === 'string' ? args.planId : '';
      if (!planId || !plans.has(planId) || !['data.processing.execute', 'data.processing.run', 'data.processing.recover'].includes(task.action)) continue;
      const list = executions.get(planId) ?? [];
      if (!list.includes(task.id)) list.push(task.id);
      executions.set(planId, list);
    }
    const items: ConversationProcessingItem[] = [];
    for (const [planId, link] of plans) {
      try {
        const plan = processingPlanForUi(processing.get(planId));
        items.push({ plan, task: processingTaskView(processingTasks, link.taskId),
          executions: (executions.get(planId) ?? []).slice(0, 10).flatMap(taskId => {
            const task = processingTaskView(processingTasks, taskId); return task ? [task] : [];
          }) });
      } catch { /* 已不存在或不可读的计划不向任何会话泄露。 */ }
    }
    res.json({ conversationId: input.conversationId, branchId: input.branchId,
      items: items.sort((left, right) => right.plan.createdAt - left.plan.createdAt || left.plan.planId.localeCompare(right.plan.planId)).slice(0, 10),
      availability: 'available', reason: null, scope } satisfies ConversationProcessingPage);
  });
  return router;
}

function processingPlanForUi(value: unknown): ProcessingPlanView {
  if (!record(value) || typeof value.planId !== 'string' || typeof value.status !== 'string'
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)
    || !Array.isArray(value.materials) || !Array.isArray(value.outputs) || !Array.isArray(value.steps)) {
    throw new CoreError('PROCESSING_PLAN_CHANGED', '处理计划事实暂时无法核对。', 409);
  }
  return {
    planId: value.planId, requestId: typeof value.requestId === 'string' ? value.requestId : '',
    parentPlanId: typeof value.parentPlanId === 'string' ? value.parentPlanId : null, status: value.status,
    createdAt: Number(value.createdAt), updatedAt: Number(value.updatedAt),
    materials: value.materials.slice(0, 50).map(processingMaterialForUi),
    outputs: value.outputs.slice(0, 50).map(processingOutputForUi),
    steps: value.steps.slice(0, 500).map(processingStepForUi),
  };
}
function processingMaterialForUi(value: unknown): ProcessingMaterialView {
  if (!record(value) || typeof value.materialId !== 'string' || typeof value.filename !== 'string') {
    throw new CoreError('PROCESSING_PLAN_CHANGED', '处理计划材料事实暂时无法核对。', 409);
  }
  return { materialId: value.materialId, filename: value.filename,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : '', format: typeof value.format === 'string' ? value.format : '',
    support: typeof value.support === 'string' ? value.support : '',
    custodyState: typeof value.custodyState === 'string' ? value.custodyState : '',
    routingState: typeof value.routingState === 'string' ? value.routingState : '',
    gaps: stringList(value.gaps) };
}
function processingOutputForUi(value: unknown): ProcessingOutputView {
  if (!record(value) || typeof value.outputId !== 'string' || typeof value.state !== 'string') {
    throw new CoreError('PROCESSING_PLAN_CHANGED', '处理计划输出事实暂时无法核对。', 409);
  }
  return {
    outputId: value.outputId, materialIds: stringList(value.materialIds),
    intendedAction: typeof value.intendedAction === 'string' ? value.intendedAction : 'inspect',
    target: processingTargetView(value.target),
    routingState: typeof value.routingState === 'string' ? value.routingState : '', state: value.state,
    rejectReason: typeof value.rejectReason === 'string' ? value.rejectReason : null,
    gaps: stringList(value.gaps), semanticGaps: stringList(value.semanticGaps),
    ...(typeof value.publishEligible === 'boolean' ? { publishEligible: value.publishEligible } : {}),
    ...(typeof value.publishAuthorization === 'string' ? { publishAuthorization: value.publishAuthorization } : {}),
    ...(typeof value.publishScope === 'string' ? { publishScope: value.publishScope } : {}),
    evidenceScope: typeof value.evidenceScope === 'string' ? value.evidenceScope : null,
    steps: Array.isArray(value.steps) ? value.steps.slice(0, 200).map(processingStepForUi) : [],
  };
}
function processingTargetView(value: unknown): ProcessingOutputView['target'] {
  if (!record(value)) return null;
  const productRef = record(value.productRef) ? value.productRef : null;
  const declaration = record(value.declaration) ? value.declaration : null;
  return {
    kind: productRef ? 'product' : declaration ? 'declaration' : 'none',
    productId: typeof productRef?.product_id === 'string' ? productRef.product_id
      : typeof declaration?.product_id === 'string' ? declaration.product_id : null,
    expectedSnapshotId: typeof value.expectedSnapshotId === 'string' ? value.expectedSnapshotId : null,
  };
}
function processingStepForUi(value: unknown): ProcessingStepView {
  if (!record(value) || typeof value.stepId !== 'string' || typeof value.outputId !== 'string'
    || typeof value.kind !== 'string' || typeof value.state !== 'string' || typeof value.required !== 'boolean') {
    throw new CoreError('PROCESSING_PLAN_CHANGED', '处理步骤事实暂时无法核对。', 409);
  }
  const output = record(value.output) ? {
    sha256: typeof value.output.sha256 === 'string' ? value.output.sha256 : '',
    byteLength: Number.isSafeInteger(value.output.byte_length) ? Number(value.output.byte_length) : null,
  } : null;
  const reused = record(value.reusedFrom) && typeof value.reusedFrom.planId === 'string' && typeof value.reusedFrom.stepId === 'string'
    ? { planId: value.reusedFrom.planId, stepId: value.reusedFrom.stepId } : null;
  return { stepId: value.stepId, outputId: value.outputId, kind: value.kind, state: value.state, required: value.required,
    applicability: typeof value.applicability === 'string' ? value.applicability : null,
    dependsOn: stringList(value.dependsOn), gaps: stringList(value.gaps), outputDigest: typeof value.outputDigest === 'string' ? value.outputDigest : null,
    output, error: processingError(value.error), reusedFrom: reused };
}
function processingError(value: unknown): { code: string; message: string } | null {
  if (!record(value) || typeof value.code !== 'string') return null;
  return { code: value.code, message: typeof value.message === 'string' ? value.message : '未提供错误说明。' };
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function processingTaskView(tasks: { get(id: string): TaskRecord }, taskId: string): ProcessingTaskView | null {
  if (!taskId) return null;
  try {
    const task = tasks.get(taskId);
    return { taskId: task.id, action: task.action, status: task.status, version: task.version, generation: task.generation,
      currentRunId: task.currentRunId, requestId: task.requestId, updatedAt: task.updatedAt,
      error: task.error ? { code: task.error.code, message: task.error.message } : null };
  } catch { return null; }
}
function conversationInput(values: Record<string, unknown>) {
  if (Object.keys(values).some(key => key !== 'conversationId' && key !== 'branchId')
    || typeof values.conversationId !== 'string' || !values.conversationId || values.conversationId.length > 160
    || typeof values.branchId !== 'string' || !values.branchId || values.branchId.length > 160) {
    invalid('会话候选读取需要明确会话和分支。');
  }
  return { conversationId: values.conversationId, branchId: values.branchId };
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_DATA_BROWSER_QUERY', '请求正文必须是对象。', 400);
  return value as Record<string, unknown>;
}
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function invalid(message: string): never { throw new CoreError('INVALID_DATA_BROWSER_QUERY', message, 400); }
function pageInput(values: Record<string, unknown>, collection: string, additional: string[] = []) {
  if (Object.keys(values).some(key => !['q', 'cursor', 'limit', ...additional].includes(key))) invalid('列表请求包含不支持的字段。');
  if (values.q !== undefined && typeof values.q !== 'string') invalid('搜索内容无效。');
  const query = String(values.q ?? '').trim();
  if (query.length > 256) invalid('搜索内容最多 256 个字符。');
  if (values.limit !== undefined && (typeof values.limit !== 'string' || !/^[1-9][0-9]*$/u.test(values.limit))) invalid('分页条数无效。');
  const limit = values.limit === undefined ? 50 : Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) invalid('每页须在 1 到 50 条之间。');
  let after: Position | undefined;
  if (values.cursor !== undefined) {
    if (typeof values.cursor !== 'string' || !values.cursor || values.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(values.cursor)) invalid('列表游标无效，请刷新列表。');
    let value: unknown;
    try { value = JSON.parse(Buffer.from(values.cursor, 'base64url').toString('utf8')); } catch { invalid('列表游标无效，请刷新列表。'); }
    if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1 || value[1] !== collection || value[2] !== query
      || !Number.isSafeInteger(value[3]) || typeof value[4] !== 'string' || !value[4] || value[4].length > 160) invalid('搜索范围已变化，请从第一页重新读取。');
    after = { createdAt: value[3], id: value[4] };
  }
  return { query, limit, after };
}
function presentPage<T>(page: { items: T[]; next: Position | null }, input: ReturnType<typeof pageInput>, collection: string,
  scope: string, availability: DataBrowserPage<T>['availability'] = 'available'): DataBrowserPage<T> {
  return { items: page.items, nextCursor: page.next ? Buffer.from(JSON.stringify([1, collection, input.query, page.next.createdAt, page.next.id])).toString('base64url') : null,
    limit: input.limit, query: input.query, availability, scope };
}
