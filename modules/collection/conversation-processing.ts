import type { PersonalCore } from '../agent/runtime/core.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import { TaskError, type TaskExecutionContext, type TaskRecord } from '../../platform/jobs/tasks.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import { isWfdRecord } from '../../adapters/database/wfd-transport.js';
import type { OperatorContext, ProcessingPlanInput } from './processing-plan.js';

const ACTIONS = new Set(['data.processing.capabilities', 'data.processing.route', 'data.processing.plan',
  'data.processing.execute', 'data.processing.run', 'data.processing.status', 'data.processing.recover']);
const text = (key: string, label: string, required = false, maxLength = 160): SkillField =>
  ({ key, label, type: 'text', required, maxLength });
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const view = (value: unknown): Record<string, JsonValue> => ({ kind: 'conversation-processing', modelPreview: json(value) });

/**
 * 受信会话宿主到处理计划的桥：材料只来自本会话分支 material.read 的保管关系；
 * 用户目的只来自当前分支真实用户消息；模型可以判断路由和步骤，但不能自授用户目的、权限或发布目标。
 */
export class ConversationProcessingBridge {
  readonly registrations: readonly SkillRegistration[];
  constructor(private readonly options: { database: CoreDatabase; core: PersonalCore; companion: WorkspaceServices;
    origin(taskId: string): ModelTaskOrigin | null }) {
    options.database.migrate('conversation_processing_links', 1, `CREATE TABLE conversation_processing_links(
      ref_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, material_id TEXT,
      origin_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(ref_id,kind));
      CREATE INDEX conversation_processing_origin ON conversation_processing_links(kind,created_at);`);
    const registration = (action: string, title: string, description: string, fields: SkillField[]): SkillRegistration => ({
      action, title, description, fields, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      permissionSummary: ['仅当前会话分支已保管的原件', '用户目的只引用真实用户原话', '结构检查不等于来源真实性、业务语义或发布资格'],
      available: () => ({ available: !!options.companion.processing, ...(!options.companion.processing ? { reason: '处理计划服务未装配。' } : {}) }),
    });
    this.registrations = [
      registration('data.processing.capabilities', '发现处理计划与六维路由能力', '先查当前会话分支已保管材料、真实用户消息、六维合同、处理步骤与限制。材料编号只能从这里列出的保管关系取得；不要让用户手填内部编号、六维状态或JSON。未知语义保持unknown并记录缺口，不阻断不依赖它的解析、清洗或结构检查。', []),
      registration('data.processing.route', '按现有原文判断材料路由', '用于单个材料的路由判断（六维：角色、信息性质、业务对象、对象与时间、目的、结构粒度）。dimensionsJson只写当前模型能从原件原文和真实用户消息核对的维度：known必须有value和evidence；material证据给materialId+quote（可加start/end），用户目的必须是user-message证据给messageId+quote，程序核对当前分支真实用户原话。不猜未知，不把模型建议当证据，不让用户填ID或JSON。intendedAction只接受inspect或publish；publish缺目标会needs_target。', [
        text('materialId', '本分支已保管材料编号', true),
        text('dimensionsJson', '六维判断与可核证据', false, 32000),
        text('suggestionsJson', '未采用的模型建议（可选）', false, 8000),
        { key: 'intendedAction', label: '明确用途动作', type: 'select', required: false, options: ['inspect', 'publish'].map(value => ({ value, label: value })) },
      ]),
      registration('data.processing.plan', '准备或修订处理计划', '按材料关系与明确输出规则准备计划；previousPlanId存在时修订原计划。planJson只接受{routing:{materials:[{materialId,dimensions,suggestions,intendedAction}]},outputs:[{outputId,materialIds,tables,target,dimensions,intendedAction}]}。材料编号取自本桥列出的本分支保管关系。六维未知仍会生成解析/清洗/结构检查步骤并保留语义缺口；publish仍须目标、必要语义与真实权限，结构检查不替代。修改规则或声明会形成新计划并只复用实际相关旧证明；不让用户手填内部ID或JSON。', [
        text('planJson', '明确计划对象', true, 131072),
        text('previousPlanId', '需修订的原处理计划', false),
      ]),
      registration('data.processing.execute', '执行已计划的一个处理步骤', '只执行本会话分支已准备计划中的单个步骤；按原计划身份、依赖和预算执行，不越过未完成前置，不重算其他步骤。已完成步骤只查询，不重复执行。', [
        text('planId', '本分支处理计划', true), text('stepId', '计划内步骤编号', true),
      ]),
      registration('data.processing.run', '按顺序运行处理计划', '运行本会话分支已准备计划中仍待执行的步骤；每阶段持久后检查停止与预算。已成功步骤按原证明查询/复用，不重复计算；失败或阻塞保留原件与上游产物。', [
        text('planId', '本分支处理计划', true),
      ]),
      registration('data.processing.status', '查询原处理计划与产物', '只读取本会话分支已链接的计划、步骤和路由事实；查询不重算、不重发、不推进。可给planId、taskId或materialId之一。缺项回原计划；对象损坏另行明确恢复，不在查询中静默修复。', [
        text('planId', '原处理计划', false), text('taskId', '原处理任务', false), text('materialId', '原材料编号', false),
      ]),
      registration('data.processing.recover', '核对原处理计划产物', '按原计划身份核对已持久化步骤对象的存在、长度和摘要；不重跑完成步骤，不修改旧计划，不把损坏对象静默当成通过。真实恢复只推进未完成且可继续的步骤。', [
        text('planId', '原处理计划', true),
      ]),
    ];
  }
  handles(action: string): boolean { return ACTIONS.has(action); }

  async execute(context: TaskExecutionContext, action: string, args: Record<string, JsonValue>): Promise<TaskResult> {
    if (!this.handles(action)) throw new TaskError('PROCESSING_ACTION', '未登记的处理会话动作。');
    const origin = this.options.origin(context.task.id);
    if (!origin) throw new TaskError('PROCESSING_ORIGIN', '处理计划工具必须由本次真实会话代理调用。');
    const service = this.options.companion.processing;
    if (!service) throw new TaskError('PROCESSING_UNAVAILABLE', '处理计划服务未装配。');
    this.options.companion.harness!.assertDispatch();
    context.signal.throwIfAborted();
    // 处理计划桥不向模型发送完整行，但仍须由受控上下文确认本次结果可发送给当前模型。
    // 这一步只建立模型分享回执，不替处理步骤或数据库提交授权，也不扩大文件权限。
    const authority = await acquireAuthority(context, action, args, []);
    authority.assert();
    if (action === 'data.processing.capabilities') {
      return { summary: '已列出本分支材料关系、真实用户消息与处理计划合同；未知语义不预填。',
        data: view(this.capabilitiesView(origin)) };
    }
    const operator = this.operator(origin, context.task.id);
    if (action === 'data.processing.route') {
      const materialId = String(args.materialId ?? '');
      this.assertMaterial(materialId, origin);
      const dimensions = this.parseObject(args.dimensionsJson, '维度判断');
      const suggestions = this.parseArray(args.suggestionsJson);
      const intendedAction = args.intendedAction === 'publish' ? 'publish' : 'inspect';
      const task = service.decideMaterial({ materialId, ...(dimensions ? { dimensions } : {}), ...(suggestions.length ? { suggestions } : {}),
        intendedAction }, operator);
      const done = await this.wait(context, task.id);
      const route = service.getByTask(task.id);
      if (route?.decision) this.link(route.decision.decisionId, task.id, origin, 'decision', materialId);
      return this.taskResult('材料路由判断已保存；未知维度保持缺口。', done, route);
    }
    if (action === 'data.processing.plan') {
      let planInput: unknown;
      try { planInput = JSON.parse(String(args.planJson)); }
      catch { throw new TaskError('PROCESSING_JSON', '计划对象不是有效JSON。'); }
      if (!isWfdRecord(planInput)) throw new TaskError('PROCESSING_INPUT', '计划对象须为明确对象。');
      this.assertPlanMaterials(planInput, origin);
      const previousPlanId = typeof args.previousPlanId === 'string' && args.previousPlanId ? args.previousPlanId
        : typeof planInput.previousPlanId === 'string' && planInput.previousPlanId ? planInput.previousPlanId : undefined;
      if (previousPlanId) this.assertPlan(previousPlanId, origin);
      const task = previousPlanId ? service.revisePlan(previousPlanId, planInput, operator)
        : service.preparePlan(planInput as unknown as ProcessingPlanInput, operator);
      const planId = String((task.args as { planId?: unknown }).planId ?? '');
      if (planId) this.link(planId, task.id, origin, 'plan', null);
      const done = await this.wait(context, task.id);
      const found = planId ? this.safePlan(planId) : null;
      return this.taskResult(previousPlanId ? '已按原计划身份形成修订计划；旧证明只在相关绑定仍有效时复用。' : '已形成处理计划；未知语义保留缺口，未声称发布资格。', done, found);
    }
    const planId = typeof args.planId === 'string' ? args.planId : '';
    if (planId) this.assertPlan(planId, origin);
    if (action === 'data.processing.execute') {
      const task = service.executeStep(planId, String(args.stepId ?? ''), operator);
      // 只登记本分支刚创建的执行任务，status(taskId) 才能复核；不接受模型或 HTTP 自带的任务编号。
      this.link(task.id, task.id, origin, 'execution', planId);
      const done = await this.wait(context, task.id);
      return this.taskResult('已按原计划执行单个步骤；完成产物与缺口以查询事实为准。', done, this.safePlan(planId));
    }
    if (action === 'data.processing.run') {
      const task = service.runPlan(planId, operator);
      this.link(task.id, task.id, origin, 'execution', planId);
      const done = await this.wait(context, task.id);
      return this.taskResult('已运行原计划中可执行步骤；停止、失败和阻塞按原任务与步骤事实报告。', done, this.safePlan(planId));
    }
    if (action === 'data.processing.recover') {
      const task = service.recoverPlan(planId, operator);
      this.link(task.id, task.id, origin, 'execution', planId);
      const done = await this.wait(context, task.id);
      return this.taskResult('已核对原计划持久产物；没有重跑已完成步骤。', done, this.safePlan(planId));
    }
    // 查询：优先 planId；其次 taskId；再次该分支最近一次材料路由决定。
    const taskId = typeof args.taskId === 'string' && args.taskId ? args.taskId : null;
    const materialId = typeof args.materialId === 'string' && args.materialId ? args.materialId : null;
    if (taskId) this.assertTaskLink(taskId, origin);
    let found: unknown = planId ? this.safePlan(planId) : taskId ? service.getByTask(taskId) : null;
    if (!found && materialId) {
      const routedTask = this.latestDecisionTask(materialId, origin);
      if (routedTask) found = service.getByTask(routedTask);
    }
    if (!found) throw new TaskError('PROCESSING_PLAN_NOT_FOUND', '没有本会话分支可核的原处理计划、任务或材料路由。');
    return { summary: '已读取原处理计划与步骤事实；查询未触发重算。', data: view(this.planPreview(found, { query: true })) };
  }

  private operator(origin: ModelTaskOrigin, taskId: string): OperatorContext {
    return { operatorId: 'conversation:' + origin.conversationId, requestId: 'conversation:' + taskId,
      method: 'conversation', path: `/conversation/${origin.conversationId}/${origin.branchId}`,
      remoteAddress: null, observedAt: Date.now(), source: 'conversation',
      conversation: { conversationId: origin.conversationId, branchId: origin.branchId,
        verifyUserMessage: (messageId, quote) => this.verifyUserMessage(origin, messageId, quote) } };
  }
  private verifyUserMessage(origin: ModelTaskOrigin, messageId: string, quote: string): boolean {
    if (!quote.trim()) return false;
    let id: string | null = origin.messageId, seen = new Set<string>();
    while (id && seen.size < 24) {
      if (seen.has(id)) return false; seen.add(id);
      const message = this.options.core.store.message(id);
      if (message.conversation_id !== origin.conversationId) return false;
      if (id === messageId) return message.role === 'user' && message.text.includes(quote);
      id = message.parent_id;
    }
    return false;
  }
  private userMessages(origin: ModelTaskOrigin) {
    const result: { id: string; text: string }[] = [];
    let id: string | null = origin.messageId, remaining = 3000, seen = new Set<string>();
    while (id && result.length < 6 && remaining > 0 && seen.size < 24) {
      if (seen.has(id)) break; seen.add(id);
      const message = this.options.core.store.message(id);
      if (message.conversation_id !== origin.conversationId) break;
      if (message.role === 'user') {
        const text = message.text.slice(0, Math.min(1200, remaining)); remaining -= text.length;
        result.push({ id, text });
      }
      id = message.parent_id;
    }
    return result.reverse();
  }
  private capabilitiesView(origin: ModelTaskOrigin) {
    const service = this.options.companion.processing!;
    const rows = this.options.database.connection.prepare(`SELECT material_id FROM conversation_material_links
      WHERE origin_json LIKE ? ORDER BY created_at DESC,rowid DESC LIMIT 20`)
      .all(`%"conversationId":"${origin.conversationId}"%"branchId":"${origin.branchId}"%`) as { material_id: string }[];
    const materials = rows.flatMap(row => {
      try { const material = this.options.companion.materials!.get(row.material_id);
        const taskId = this.latestDecisionTask(row.material_id, origin);
        const routing = taskId ? (this.options.companion.processing!.getByTask(taskId)?.decision as { routingState?: string } | null)?.routingState : null;
        return [{ materialId: row.material_id, filename: material.envelope.filename, sha256: material.envelope.sha256.slice(0, 16),
          format: material.preview.format, support: material.preview.support, routing: routing ?? 'needs_classification' }];
      } catch { return []; }
    });
    return { contract: 'conversation-processing/1', conversation: { conversationId: origin.conversationId, branchId: origin.branchId,
      userMessages: this.userMessages(origin) }, materials,
      catalog: service.catalog(),
      guidance: '材料编号只从materials取；六维只写可核事实，未知保持unknown。用户目的必须引用conversation.userMessages中的真实原话。结构检查通过不等于来源真实性、业务语义或发布资格已验证；发布目标与用户授权不能由模型补造。' };
  }
  private taskResult(summary: string, task: TaskRecord, found: unknown): TaskResult {
    if (task.status !== 'succeeded') return { summary: `${summary} 原任务状态：${task.status}。`,
      data: view({ taskId: task.id, status: task.status, error: task.error ?? null, plan: found ?? null }) };
    return { summary, data: view(this.planPreview(found, { taskId: task.id })) };
  }
  /** 有界模型视图：保留可核事实与步骤状态，不分享完整表行或对象内容。 */
  private planPreview(found: unknown, extra: { taskId?: string; query?: boolean } = {}): JsonValue {
    const plan = found && isWfdRecord(found) && isWfdRecord(found.plan) ? found.plan as Record<string, unknown>
      : found && isWfdRecord(found) && typeof found.planId === 'string' ? found as Record<string, unknown> : null;
    const decision = found && isWfdRecord(found) && isWfdRecord(found.decision) ? found.decision : null;
    if (!plan) return json({ ...((found && isWfdRecord(found)) ? found : { found: null }), ...extra,
      guidance: '没有计划文档；只返回原任务或决定事实。' });
    const output = Array.isArray(plan.outputs) ? plan.outputs as Record<string, unknown>[] : [];
    const steps = Array.isArray(plan.steps) ? plan.steps as Record<string, unknown>[] : [];
    const materials = Array.isArray(plan.materials) ? plan.materials as Record<string, unknown>[] : [];
    const preview = { taskId: extra.taskId ?? null, planId: plan.planId, status: plan.status, parentPlanId: plan.parentPlanId,
      operator: plan.operator, policyDigest: plan.policyDigest, executionDigest: plan.executionDigest,
      materials: materials.map(material => ({ materialId: material.materialId, filename: material.filename, sha256: material.sha256,
        format: material.format, support: material.support, custodyState: material.custodyState, routingState: material.routingState, gaps: material.gaps,
        dimensions: this.dimensions(material.dimensions) })),
      outputs: output.map(item => ({ outputId: item.outputId, materialIds: item.materialIds, intendedAction: item.intendedAction,
        target: item.target, routingState: item.routingState, state: item.state, gaps: item.gaps, semanticGaps: item.semanticGaps,
        publishEligible: item.publishEligible, evidenceScope: item.evidenceScope, steps: item.steps })),
      steps: steps.map(step => this.step(step)), decision,
      query: extra.query === true, guidance: '结构产物只证明编码、形状、类型、行预算与摘要；来源真实性、业务语义、对象时间、发布权限仍以缺口和真实用户输入为准。' };
    let text = JSON.stringify(preview);
    if (text.length > 22000) {
      const compact = { ...preview, steps: preview.steps.map(step => ({ ...step, gaps: Array.isArray(step.gaps) ? step.gaps.slice(0, 4) : [] })),
        outputs: preview.outputs.map(item => ({ ...item, steps: Array.isArray(item.steps) ? item.steps.map(step => isWfdRecord(step) ? { stepId: step.stepId, kind: step.kind, state: step.state } : step) : item.steps })) };
      text = JSON.stringify(compact);
    }
    return JSON.parse(text) as JsonValue;
  }
  private dimensions(value: unknown) {
    return Array.isArray(value) ? value.slice(0, 6).map(item => isWfdRecord(item) ? { key: item.key, status: item.status,
      value: item.value, gap: item.gap, evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 3).map(evidence =>
        isWfdRecord(evidence) ? { source: evidence.source, quote: String(evidence.quote ?? '').slice(0, 160), messageId: evidence.messageId,
          materialId: evidence.materialId, start: evidence.start, end: evidence.end } : evidence) : [] } : item) : [];
  }
  private step(step: Record<string, unknown>) {
    return { stepId: step.stepId, outputId: step.outputId, kind: step.kind, required: step.required, applicability: step.applicability,
      state: step.state, dependsOn: step.dependsOn, implementation: step.implementation, gaps: step.gaps,
      outputDigest: step.outputDigest, reusedFrom: step.reusedFrom };
  }
  private parseObject(value: unknown, label: string): Record<string, unknown> | null {
    if (value === undefined || value === '') return null;
    let parsed: unknown;
    try { parsed = JSON.parse(String(value)); } catch { throw new TaskError('PROCESSING_JSON', `${label}不是有效JSON。`); }
    if (!isWfdRecord(parsed)) throw new TaskError('PROCESSING_INPUT', `${label}须为明确对象。`);
    return parsed;
  }
  private parseArray(value: unknown): unknown[] {
    if (value === undefined || value === '') return [];
    let parsed: unknown;
    try { parsed = JSON.parse(String(value)); } catch { throw new TaskError('PROCESSING_JSON', '模型建议不是有效JSON。'); }
    if (!Array.isArray(parsed)) throw new TaskError('PROCESSING_SUGGESTIONS', '模型建议须为数组。');
    return parsed;
  }
  private assertPlanMaterials(input: Record<string, unknown>, origin: ModelTaskOrigin): void {
    const routing = isWfdRecord(input.routing) ? input.routing : null;
    const materials = routing && Array.isArray(routing.materials) ? routing.materials : [];
    const ids = new Set<string>();
    for (const item of materials) {
      if (!isWfdRecord(item) || typeof item.materialId !== 'string') throw new TaskError('PROCESSING_MATERIAL_ID', '路由材料须有明确材料编号。');
      this.assertMaterial(item.materialId, origin); ids.add(item.materialId);
    }
    const outputs = Array.isArray(input.outputs) ? input.outputs : [];
    for (const output of outputs) {
      if (!isWfdRecord(output) || !Array.isArray(output.materialIds)) continue;
      for (const materialId of output.materialIds) if (typeof materialId !== 'string' || !this.assertMaterialSafe(materialId, origin)) {
        throw new TaskError('PROCESSING_MATERIAL_ORIGIN', '输出引用的材料不属于当前会话分支的保管关系。');
      }
    }
  }
  private assertMaterialSafe(materialId: string, origin: ModelTaskOrigin): boolean {
    try { this.assertMaterial(materialId, origin); return true; } catch { return false; }
  }
  private assertMaterial(materialId: string, origin: ModelTaskOrigin): void {
    const exists = this.options.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_material_links'").get();
    const row = exists && materialId ? this.options.database.connection.prepare('SELECT origin_json FROM conversation_material_links WHERE material_id=?').get(materialId) : undefined;
    const saved: unknown = row ? JSON.parse(String(row.origin_json)) : null;
    if (!isWfdRecord(saved) || saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId) {
      throw new TaskError('PROCESSING_MATERIAL_ORIGIN', '处理计划只接受本会话分支通过material.read保管的原件。');
    }
  }
  private assertPlan(planId: string, origin: ModelTaskOrigin): void {
    const row = this.options.database.connection.prepare("SELECT origin_json FROM conversation_processing_links WHERE ref_id=? AND kind='plan'").get(planId);
    const saved: unknown = row ? JSON.parse(String(row.origin_json)) : null;
    if (!isWfdRecord(saved) || saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId) {
      throw new TaskError('PROCESSING_PLAN_ORIGIN', '该处理计划不属于当前会话分支。');
    }
  }
  private assertTaskLink(taskId: string, origin: ModelTaskOrigin): void {
    const row = this.options.database.connection.prepare('SELECT origin_json FROM conversation_processing_links WHERE task_id=?').get(taskId);
    const saved: unknown = row ? JSON.parse(String(row.origin_json)) : null;
    if (!isWfdRecord(saved) || saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId) {
      throw new TaskError('PROCESSING_TASK_ORIGIN', '该处理任务不属于当前会话分支。');
    }
  }
  private latestDecisionTask(materialId: string, origin: ModelTaskOrigin): string | null {
    const rows = this.options.database.connection.prepare(`SELECT task_id,origin_json FROM conversation_processing_links
      WHERE kind='decision' AND material_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20`).all(materialId) as { task_id: string; origin_json: string }[];
    for (const row of rows) {
      try { const saved: unknown = JSON.parse(row.origin_json);
        if (isWfdRecord(saved) && saved.conversationId === origin.conversationId && saved.branchId === origin.branchId) return row.task_id;
      } catch { /* 旧链接不可核时跳过，不在查询中重建事实。 */ }
    }
    return null;
  }
  private safePlan(planId: string): unknown {
    try { return this.options.companion.processing!.get(planId); } catch { return null; }
  }
  private link(refId: string, taskId: string, origin: ModelTaskOrigin, kind: string, materialId: string | null): void {
    this.options.database.connection.prepare('INSERT OR IGNORE INTO conversation_processing_links VALUES(?,?,?,?,?,?)')
      .run(refId, taskId, kind, materialId, JSON.stringify(origin), Date.now());
  }
  private async wait(context: TaskExecutionContext, taskId: string): Promise<TaskRecord> {
    const tasks = this.options.companion.tasks;
    context.signal.throwIfAborted();
    let abort!: () => void, unsubscribe = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new TaskError('PROCESSING_WAIT_STOPPED', '会话已停止等待，原处理任务保持原身份。')); context.signal.addEventListener('abort', abort, { once: true }); });
    const ready = new Promise<void>((resolve, reject) => {
      const check = () => { const task = tasks.get(taskId); if (['succeeded', 'failed', 'cancelled', 'interrupted', 'paused', 'needs_review', 'waiting_approval'].includes(task.status)) resolve(); };
      unsubscribe = tasks.subscribe(event => { if (event.task.id === taskId) check(); });
      check(); void tasks.wait(taskId).then(() => resolve(), reject);
    });
    try { context.signal.throwIfAborted(); await Promise.race([ready, stopped]); }
    finally { unsubscribe(); context.signal.removeEventListener('abort', abort); }
    return tasks.get(taskId);
  }
}
