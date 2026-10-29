import { randomUUID } from 'node:crypto';
import type { BackendInput } from '../../contracts/backend.js';
import type { PersonalCore } from '../agent/runtime/core.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { BusinessConfirmationEvidence, BusinessGoalService } from '../../platform/jobs/business-goals.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { PermissionCapability } from '../../platform/security/permissions.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { JsonValue, TaskRecord, TaskResult } from '../../contracts/task-contracts.js';
import { acquireAuthority, fileCapability } from '../../platform/runtime/file-workspace.js';
import { deriveUserDailyDeclaration, runUserTablePipeline, userTableDigest, type UserTablePipelineResult, type UserTableProvenance } from './user-table-pipeline.js';
import type { createUserCyclePort } from './user-cycle-port.js';
import type { createUserPublicationPort } from './user-publication-port.js';
import { canonicalWfdJson, isWfdRecord, type createWfdTransport, type WfdEnvelope, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { WfdFinancialDeclaration, WfdFinancialReader } from '../../adapters/database/wfd-financial.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import { requireFinancialComputedResult } from '../financial/contracts.js';
import { FINANCIAL_CAPABILITIES, type FinancialCallArgs } from '../financial/types.js';
import { ConversationResultPublication } from '../financial/result-publication.js';
import type { ConversationMaterialBridge } from './conversation-materials.js';
import type { MaterialSemanticRecord } from './materials/semantic-contracts.js';

type ReadyPipeline = Extract<UserTablePipelineResult, { state: 'succeeded' }>;
type CycleRow = { id: string; goal_id: string; step_id: string; request_id: string; origin_json: string;
  material_id: string; semantic_task_id: string; file_ref_id: string; pipeline_json: string; envelope_json: string;
  receipt_json: string | null; readback_json: string | null; reference_json: string | null; state: string };
export interface ConversationUserCycleBinding {
  forTask?(taskId: string): ConversationUserCycleBinding;
  forEnvelope?(envelope: WfdEnvelope): ConversationUserCycleBinding;
  pinRequest?(envelope: WfdEnvelope, taskId: string): void;
  attachBusinessDatabase?(database: CoreDatabase): void;
  port: ReturnType<typeof createUserCyclePort>;
  reader: WfdFinancialReader;
  principalId: string; instanceId: string;
  capabilities: readonly PermissionCapability[];
  /** 此注册只由可信启动器建立，真实用户文件默认没有合成身份。 */
  provenanceForOriginal?: (sha256: string) => UserTableProvenance | undefined;
  bindFinancialTask(taskId: string, origin: ModelTaskOrigin): void;
  assertFinancialTaskReadable(context: TaskExecutionContext): void;
  attachConversationAuthority(check: (origin: ModelTaskOrigin) => void): void;
  publicationTargets: readonly { toolId: string; port: ReturnType<typeof createUserPublicationPort>;
    transport: ReturnType<typeof createWfdTransport>; descriptorSemantics: WfdRecord }[];
}

/** 仅把原会话任务接到固定用户测试数据库；没有模型、独立调度或隐式重试。 */
export class ConversationDataCycleBridge {
  readonly registrations: readonly SkillRegistration[];
  private readonly publications: ConversationResultPublication;
  constructor(private readonly options: { database: CoreDatabase; core: PersonalCore; files: FileReferenceService;
    companion: WorkspaceServices; binding: ConversationUserCycleBinding; goals: BusinessGoalService;
    materialBridge: ConversationMaterialBridge; origin(taskId: string): ModelTaskOrigin | null; assertPath(path: string): void }) {
    options.database.migrate('conversation_data_cycles', 1, `CREATE TABLE conversation_data_cycles (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, step_id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL UNIQUE,
      origin_json TEXT NOT NULL, material_id TEXT NOT NULL, semantic_task_id TEXT NOT NULL, file_ref_id TEXT NOT NULL,
      pipeline_json TEXT NOT NULL, envelope_json TEXT NOT NULL, receipt_json TEXT, readback_json TEXT, reference_json TEXT,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE conversation_cycle_confirmations (confirmation_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL,
        material_id TEXT NOT NULL, semantic_task_id TEXT NOT NULL, missing_json TEXT NOT NULL);`);
    const field = (key: string, label: string, maxLength = 200) => ({ key, label, type: 'text' as const, required: true, maxLength });
    this.registrations = [
      this.registration('data.prepare', '读取入库原件并建立有界业务目标', '用户明确要求将附件入库时先用本动作，复用原材料保管和原文读取，建立同一目标和累计预算。返回原文、真实消息和语义合同后仍用material.process核证。analysisPlanJson只列本次明确计算的capabilityId/parameters；空列表代表仅输入提交子目标。', [
        { key: 'fileRefId', label: '原件引用', type: 'file', required: true }, field('authorizationMessageId', '真实授权消息编号'),
        field('authorizationQuote', '用户要求入库的原句', 2000),
        { key: 'analysisPlanJson', label: '用户要求的计算及参数列表', type: 'text', required: true, maxLength: 2000 },
      ]),
      this.registration('data.submit', '兼容旧日线合同交接', '旧日线专用兼容入口；新材料优先data.candidates系列。先由同一会话 material.read/process 保存有原文依据的语义。只接当前分支附件中1至512行CSV/JSON，实际运行五步程序，向已绑定用户测试库提交并固定读回。authorizationQuote须逐字引用真实用户要求入库的原句；不是模型确认。缺语义返回问题；未知结果只能data.status核原身份。accepted（持久受理）、received（输入保管）与正式提交分别核实；只有数据库真实返回committed（已提交）、commit_id（提交身份）和snapshot_id（快照身份）并核对固定读回，才称正式提交；本地接收、加工候选及用户测试不能称生产入库。', [
        { key: 'fileRefId', label: '原件引用', type: 'file', required: true }, field('materialId', '已保管材料编号'),
        field('semanticTaskId', '已采用的语义服务任务'), field('authorizationMessageId', '真实授权消息编号'),
        field('authorizationQuote', '用户要求入库的原句', 2000),
        { key: 'analysisPlanJson', label: '用户要求的计算及参数', type: 'text', required: false, maxLength: 2000 },
      ]),
      this.registration('data.status', '核对原数据库交接', '用data.submit返回的cycleId核对同会话同分支原交接。只查询原连接、实例与请求身份及已提交的固定读回，不重发材料，不自行推进尚处受理或保管状态的业务。accepted（持久受理）和received（输入保管）均不等于正式提交；正式提交须有数据库真实committed（已提交）、commit_id（提交身份）和snapshot_id（快照身份），再核对固定读回。', [field('cycleId', '原循环编号')]),
      this.registration('results.publish', '明确保存一项金融结果', '普通计算不入库。只有真实用户请求或既有明确保存委托覆盖本次结果、目标和用途时使用；引用同会话同分支原serviceTaskId及真实用户保存原句，不重新计算、不扩大范围。computed（计算完成）与persisted（正式保存）分别举证，提交未知只沿原身份查询。独立发布派生结果并固定读回；不得用行情输入快照当发布目标父版本。', [
        field('serviceTaskId', '原金融服务任务'), field('authorizationMessageId', '真实保存消息编号'), field('authorizationQuote', '用户要求保存结果的原句', 2000),
        { key: 'serviceTaskIdsJson', label: '本次明确保存的原任务完整列表', type: 'text', required: false, maxLength: 1000 },
      ]),
    ];
    options.binding.attachBusinessDatabase?.(options.database);
    options.binding.attachConversationAuthority(origin => this.assertOrigin(origin));
    this.publications = new ConversationResultPublication({ database: options.database, companion: options.companion,
      binding: options.binding, goals: options.goals, input: origin => this.input(origin), assertOrigin: origin => this.assertOrigin(origin) });
  }
  handles(action: string): boolean { return ['data.prepare', 'data.submit', 'data.status', 'results.publish'].includes(action); }
  afterSemanticRecord(origin: ModelTaskOrigin, semantic: MaterialSemanticRecord): JsonValue | undefined {
    const input = this.input(origin), { goals, companion } = this.options;
    let goal = goals.forInput(input);
    if (!goal || !isWfdRecord(goal.contract) || goal.contract.version !== 'first-user-cycle/1'
      || goal.contract.materialId !== semantic.envelope.materialId || goal.state === 'completed') return undefined;
    this.assertOrigin(origin);
    const pending = this.db.prepare(`SELECT p.*,c.step_id FROM conversation_cycle_confirmations p JOIN business_goal_confirmations c
      ON c.id=p.confirmation_id WHERE p.goal_id=? AND p.material_id=? AND c.state='pending'`)
      .get(goal.id, semantic.envelope.materialId);
    if (pending) {
      const previous = companion.semantics!.getByTask(String(pending.semantic_task_id));
      if (!previous || (semantic.envelope.proposalId !== previous.envelope.proposalId && semantic.proposal.supersedesProposalId !== previous.envelope.proposalId)) {
        throw new TaskError('DATA_CYCLE_CONFIRMATION_CHAIN', '语义回答必须明确续接原待确认提案，不能替换材料或跳过回答来源。');
      }
    }
    let derived: ReturnType<typeof deriveUserDailyDeclaration> | undefined;
    if (semantic.result.status === 'processed' && semantic.result.applied) derived = deriveUserDailyDeclaration(companion.materials!.get(semantic.envelope.materialId), semantic);
    if (!pending && derived?.status === 'needs_confirmation' && hasUnsubmittedFieldJudgments(semantic, derived.missingDimensions)) {
      return json({ goalId: goal.id, state: 'needs_model_revision', missingDimensions: derived.missingDimensions, dispatched: false,
        instruction: '当前table.fields已经给出规范列名，但judgments遗漏了字段用途判断。依据同一已读原件，重新material.process提交完整提案：日期/开盘/收盘/available_at/bar_closed各需key=field、scope=column:N、value为规范角色及原件表头证据。列名不是角色判断；无需让用户重复确认已给出的时区、截止时刻或原件列。不要补造数据；实际未知或冲突仍须询问用户。沿原目标和累计预算修正。' });
    }
    const questions = derived?.status === 'needs_confirmation' ? derived.questions : derived?.status === 'ready' ? []
      : semantic.result.questions.map(question => question.prompt);
    if (derived?.status !== 'ready') {
      if (!questions.length) return json({ goalId: goal.id, state: semantic.result.status, dispatched: false });
      let confirmationId = pending ? String(pending.confirmation_id) : undefined;
      if (!confirmationId) {
        const reserved = goals.reserveStep(input, { goalId: goal.id, revision: goal.revision,
          key: `semantics:${semantic.envelope.materialId}`, action: 'material.process', args: { materialId: semantic.envelope.materialId } });
        confirmationId = goals.requestConfirmation(input, goal.id, goal.revision, reserved.step.id, questions.join('\n')).id;
      }
      this.db.prepare(`INSERT INTO conversation_cycle_confirmations VALUES(?,?,?,?,?) ON CONFLICT(confirmation_id)
        DO UPDATE SET semantic_task_id=excluded.semantic_task_id,missing_json=excluded.missing_json`)
        .run(confirmationId, goal.id, semantic.envelope.materialId, semantic.envelope.serviceTaskId,
          canonicalWfdJson(derived?.status === 'needs_confirmation' ? derived.missingDimensions : semantic.result.questions.map(question => question.id)));
      return json({ goalId: goal.id, state: 'needs_confirmation', confirmationId, questions, dispatched: false,
        supersedesProposalId: semantic.envelope.proposalId, instruction: '在本会话询问缺项；下一份语义提案须引用此supersedesProposalId及真实回复，同目标预算保持。' });
    }
    if (pending) {
      goal = goals.confirmSemanticAnswer(input, String(pending.confirmation_id), { messageId: input.messageId, quote: input.text, start: 0, end: input.text.length },
        { sourceRecordId: semantic.envelope.serviceTaskId, questionId: 'daily-required-semantics' });
      const previous = goals.getStep(String(pending.step_id));
      if (previous.action === 'material.process') {
        const next = goals.reserveStep(input, { goalId: goal.id, revision: goal.revision, key: previous.key, action: 'material.process', args: { materialId: semantic.envelope.materialId } });
        goals.finishStep(next.step.id, next.step.requestId, 'succeeded', { proposalId: semantic.envelope.proposalId, semanticTaskId: semantic.envelope.serviceTaskId, ready: true });
      }
    }
    return json({ goalId: goal.id, state: 'ready', semanticTaskId: semantic.envelope.serviceTaskId, dispatched: false });
  }
  resolveFinancialCall(origin: ModelTaskOrigin, call: FinancialCallArgs): TaskRecord | null {
    const input = this.input(origin), goal = this.options.goals.forInput(input);
    if (!goal || !isWfdRecord(goal.contract) || goal.contract.version !== 'first-user-cycle/1') return null;
    const key = computeStepKey(call.capabilityId, call.parameters);
    if (!goal.completionConditions.some(condition => condition.stepKey === key)) throw new TaskError('DATA_CYCLE_COMPUTATION_NOT_SELECTED', '计算不属于原业务目标明确选择的方法与参数。');
    const row = this.db.prepare('SELECT * FROM conversation_data_cycles WHERE goal_id=? AND state=?').get(goal.id, 'verified') as CycleRow | undefined;
    if (!row || call.input.kind !== 'snapshot' || call.input.snapshotId !== JSON.parse(row.reference_json!).snapshotId) {
      throw new TaskError('DATA_CYCLE_COMPUTATION_INPUT', '原业务目标须使用刚提交并核对的固定快照。');
    }
    const existing = this.db.prepare('SELECT id,args_digest FROM business_goal_steps WHERE goal_id=? AND step_key=?').get(goal.id, key);
    if (existing) {
      const step = this.options.goals.getStep(String(existing.id));
      if (step.external.serviceTaskId) return this.options.companion.harness!.getTask(step.external.serviceTaskId);
      throw new TaskError('DATA_CYCLE_COMPUTATION_PENDING', '原计算步骤已保留但任务身份尚未核实，不能换编号重派。');
    }
    if (goal.state !== 'active') throw new TaskError('GOAL_WRITES_FROZEN', '业务目标当前不能新增计算派发。');
    this.options.goals.reserveStep(input, { goalId: goal.id, revision: goal.revision, key, action: 'financial.call', args: json(call) });
    return null;
  }
  bindFinancialStep(origin: ModelTaskOrigin, task: TaskRecord): void {
    const input = this.input(origin), goal = this.options.goals.forInput(input);
    if (!goal || !isWfdRecord(goal.contract) || goal.contract.version !== 'first-user-cycle/1') return;
    const args = task.args as unknown as FinancialCallArgs;
    const row = this.db.prepare('SELECT id FROM business_goal_steps WHERE goal_id=? AND step_key=?').get(goal.id, computeStepKey(args.capabilityId, args.parameters));
    if (!row) throw new TaskError('DATA_CYCLE_COMPUTATION_PENDING', '计算尚未绑定当前业务目标的稳定步骤。');
    this.options.goals.assertCurrent(input, goal.id, goal.revision);
    const step = this.options.goals.getStep(String(row.id));
    this.options.goals.recordStepExternal(step.id, step.requestId, { serviceTaskId: task.id });
  }
  verifySemanticAnswer(receipt: { sourceRecordId: string; questionId: string }, confirmationId: string,
    input: Readonly<BackendInput>, evidence: BusinessConfirmationEvidence): boolean {
    try {
      const pending = this.db.prepare('SELECT * FROM conversation_cycle_confirmations WHERE confirmation_id=?').get(confirmationId);
      const semantic = this.options.companion.semantics?.getByTask(receipt.sourceRecordId);
      const previous = pending && this.options.companion.semantics?.getByTask(String(pending.semantic_task_id));
      if (!pending || !semantic || !previous || receipt.questionId !== 'daily-required-semantics'
        || semantic.envelope.materialId !== pending.material_id || semantic.proposal.supersedesProposalId !== previous.envelope.proposalId
        || semantic.origin.messageId !== input.messageId || semantic.origin.inputId !== input.inputId
        || semantic.origin.conversationId !== input.conversationId || semantic.origin.branchId !== input.branchId
        || evidence.messageId !== input.messageId || !semantic.origin.userMessages.some(message => message.id === input.messageId && message.text.includes(evidence.quote))) return false;
      return deriveUserDailyDeclaration(this.options.companion.materials!.get(semantic.envelope.materialId), semantic).status === 'ready';
    } catch { return false; }
  }
  observeFinancialResult(origin: ModelTaskOrigin, task: TaskRecord): void {
    const input = this.input(origin), goal = this.options.goals.forInput(input);
    if (!goal || goal.state !== 'active') return;
    const result = requireFinancialComputedResult(task);
    if (!isWfdRecord(result.inputReference) || result.inputReference.kind !== 'snapshot') return;
    const row = this.db.prepare('SELECT * FROM conversation_data_cycles WHERE goal_id=? AND state=?').get(goal.id, 'verified') as CycleRow | undefined;
    if (!row) return;
    const reference = JSON.parse(row.reference_json!) as { snapshotId: string };
    if (reference.snapshotId !== result.inputReference.snapshotId) return;
    const key = computeStepKey(result.capabilityId, result.parameters);
    if (!goal.completionConditions.some(condition => condition.stepKey === key)) return;
    const reserved = this.options.goals.reserveStep(input, { goalId: goal.id, revision: goal.revision, key,
      action: 'financial.call', args: task.args });
    this.options.goals.recordStepExternal(reserved.step.id, reserved.step.requestId, { serviceTaskId: task.id, resultRef: task.resultRef! });
    this.options.goals.finishStep(reserved.step.id, reserved.step.requestId, 'succeeded', { taskId: task.id, resultRef: task.resultRef!, computed: true });
    this.tryComplete(input, goal.id);
  }
  private get db() { return this.options.database.connection; }
  private registration(action: string, title: string, description: string, fields: SkillRegistration['fields']): SkillRegistration {
    return { action, title, description, fields, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      permissionSummary: ['当前会话真实授权与目标修订', '用户测试数据库独立核准与固定快照', '原结果未知时查询原身份'],
      available: () => action === 'results.publish' && !this.options.companion.financial
        ? { available: false, reason: '计算资产尚未绑定，金融结果发布当前不可用。' }
        : action !== 'results.publish' || this.options.binding.publicationTargets.length ? { available: true }
          : { available: false, reason: '独立结果发布尚未绑定。' } };
  }
  private input(origin: ModelTaskOrigin): BackendInput {
    return { inputId: origin.inputId, messageId: origin.messageId, conversationId: origin.conversationId,
      branchId: origin.branchId, runId: origin.parentRunId, generation: origin.parentGeneration,
      text: this.options.core.store.command(origin.inputId).text };
  }
  private assertOrigin(origin: ModelTaskOrigin): void {
    const input = this.input(origin), core = this.options.core;
    if (!core.isRunActive(input.runId, input.generation) || core.store.run(input.runId).branch_id !== input.branchId
      || core.store.run(input.runId).conversation_id !== input.conversationId
      || core.getState(input.conversationId).visibility !== 'active') throw new TaskError('DATA_CYCLE_STALE', '原会话、分支或运行已失效。');
    this.options.companion.harness!.assertDispatch();
    const goal = this.options.goals.forInput(input);
    if (goal && goal.state !== 'completed') this.options.goals.assertCurrent(input, goal.id, goal.revision);
  }
  private authorize(origin: ModelTaskOrigin, args: Record<string, JsonValue>, publish: boolean): void {
    const current = this.input(origin), goal = this.options.goals.forInput(current);
    const allowed = new Set([origin.messageId]);
    const selectedMaterial = !publish && typeof args.fileRefId === 'string'
      ? this.db.prepare('SELECT material_id FROM conversation_material_links WHERE file_ref_id=? ORDER BY created_at DESC LIMIT 1').get(args.fileRefId) : undefined;
    if (!publish && goal && goal.state !== 'completed' && isWfdRecord(goal.contract)
      && (goal.contract.materialId === args.materialId || goal.contract.materialId === selectedMaterial?.material_id)) {
      const root = this.options.core.store.command(goal.rootInputId);
      if (root.input_message_id) allowed.add(root.input_message_id);
    }
    if (typeof args.authorizationMessageId !== 'string' || !allowed.has(args.authorizationMessageId)) {
      throw new TaskError('DATA_CYCLE_AUTHORIZATION_REQUIRED', '授权须来自当前输入，或同一材料待确认目标的原请求。');
    }
    let id: string | null = origin.messageId, found = false;
    for (let count = 0; id && count < 200; count++) {
      const message = this.options.core.store.message(id);
      if (message.conversation_id !== origin.conversationId) break;
      if (message.id === args.authorizationMessageId) {
        const quote = args.authorizationQuote;
        if (message.role !== 'user' || typeof quote !== 'string' || !quote.trim() || quote.length > 2000 || !message.text.includes(quote)
          || !/(?:入库|存入|写入|提交|保存|publish|persist|save)/iu.test(quote)
          || deniedAuthorizationClause(message.text, quote)
          || (publish && !/(?:结果|均线|吞没|指标|计算|result|MA)/iu.test(quote))) {
          throw new TaskError('DATA_CYCLE_AUTHORIZATION_REQUIRED', '需要真实用户明确要求入库或保存结果的原句。');
        }
        found = true; break;
      }
      id = message.parent_id;
    }
    if (!found) throw new TaskError('DATA_CYCLE_AUTHORIZATION_REQUIRED', '授权原句不属于当前会话分支。');
  }
  async execute(context: TaskExecutionContext): Promise<TaskResult> {
    const origin = this.options.origin(context.task.id);
    if (!origin) throw new TaskError('DATA_CYCLE_CONVERSATION_REQUIRED', '数据循环只接当前会话受控任务。');
    this.assertOrigin(origin);
    const args = context.task.args as Record<string, JsonValue>;
    if (context.task.action === 'data.status') return this.status(context, origin, String(args.cycleId));
    this.authorize(origin, args, context.task.action === 'results.publish');
    if (context.task.action === 'data.prepare') {
      const read = await this.options.materialBridge.execute(context, 'material.read', { fileRefId: args.fileRefId! });
      if (!isWfdRecord(read.data) || !isWfdRecord(read.data.modelPreview) || typeof read.data.materialId !== 'string') throw new TaskError('DATA_CYCLE_MATERIAL_UNBOUND', '原材料入口没有返回可核的材料身份。');
      const goal = this.ensureGoal(this.input(origin), read.data.materialId, parseAnalysisPlan(args.analysisPlanJson));
      return { ...read, data: json({ ...read.data, modelPreview: { ...read.data.modelPreview, cycle: { goalId: goal.id,
        state: goal.state, analysisPlan: isWfdRecord(goal.contract) ? goal.contract.analysisPlan : [],
        instruction: '继续用material.process保存有依据的提案；缺项由同一会话确认。data.submit只能交接此目标原件，未知结果按data.status核原身份。' } } }) };
    }
    if (context.task.action === 'results.publish') {
      return this.publications.execute(context, origin, args);
    }
    if (context.task.action !== 'data.submit') throw new TaskError('UNKNOWN_ACTION', '未登记的数据循环动作。');
    const input = this.input(origin), { files, companion, goals } = this.options;
    const binding = this.options.binding.forTask?.(context.task.id) ?? this.options.binding;
    const selected = this.options.core.selectedAttachmentsForInput(input).find(ref => ref.fileRefId === args.fileRefId);
    if (!selected) throw new TaskError('DATA_CYCLE_NOT_SELECTED', '原件未附在当前消息或分支祖先。');
    const file = files.verify(selected.fileRefId);
    if (file.version !== selected.version || file.kind !== 'file') throw new TaskError('DATA_CYCLE_FILE_CHANGED', '原件引用已变化。');
    this.options.assertPath(file.invocationPath);
    const authority = await acquireAuthority(context, 'data.submit', args, [fileCapability('read', file.invocationPath), ...binding.capabilities]);
    const assert = () => { authority.assert(); this.assertOrigin(origin); files.verify(file.id); };
    assert();
    const link = this.db.prepare('SELECT * FROM conversation_material_links WHERE material_id=? AND file_ref_id=? AND file_ref_version=?')
      .get(String(args.materialId), file.id, file.version);
    const semantic = companion.semantics!.getByTask(String(args.semanticTaskId));
    if (!link || !semantic || semantic.envelope.materialId !== args.materialId || semantic.origin.conversationId !== origin.conversationId
      || semantic.origin.branchId !== origin.branchId || semantic.envelope.originalSha256 !== link.sha256) {
      throw new TaskError('DATA_CYCLE_SEMANTIC_UNBOUND', '材料、当前分支和语义服务记录没有相同来源。');
    }
    const material = companion.materials!.get(String(args.materialId)), original = companion.materials!.readOriginal(String(args.materialId));
    const localBytes = await files.readBytes(file.id, { operation: context.operationScope(authority.operation), approvalId: authority.approvalId, maxBytes: 1_048_576 });
    assert();
    if (Buffer.compare(Buffer.from(localBytes), Buffer.from(original.bytes)) !== 0) throw new TaskError('DATA_CYCLE_FILE_CHANGED', '当前附件原字节与材料库原件不同。');
    const analysisPlan = parseAnalysisPlan(args.analysisPlanJson);
    let goal = this.ensureGoal(input, String(args.materialId), analysisPlan);
    const stepArgs = json({ materialId: args.materialId, semanticTaskId: args.semanticTaskId, fileRefId: file.id,
      fileVersion: file.version, target: binding.port.target });
    const pipeline = runUserTablePipeline({ originalBytes: original.bytes, material, semanticRecord: semantic, target: binding.port.target,
      provenance: binding.provenanceForOriginal?.(material.envelope.sha256) });
    if (pipeline.state === 'failed') throw new TaskError(pipeline.failure.code, pipeline.failure.message);
    if (pipeline.state === 'needs_confirmation') {
      const pending = this.db.prepare(`SELECT p.confirmation_id FROM conversation_cycle_confirmations p JOIN business_goal_confirmations c ON c.id=p.confirmation_id
        WHERE p.goal_id=? AND p.material_id=? AND c.state='pending'`).get(goal.id, String(args.materialId));
      if (pending) return this.result('仍有语义缺项，未向数据库发送。', { state: 'needs_confirmation', goalId: goal.id,
        confirmationId: pending.confirmation_id, questions: pipeline.questions, missingDimensions: pipeline.missingDimensions });
      const reserved = goals.reserveStep(input, { goalId: goal.id, revision: goal.revision, key: `ingest:${args.materialId}`,
        action: 'data.submit', args: stepArgs });
      const confirmation = goals.requestConfirmation(input, goal.id, goal.revision, reserved.step.id, pipeline.questions.join('\n'));
      this.db.prepare('INSERT OR IGNORE INTO conversation_cycle_confirmations VALUES(?,?,?,?,?)').run(confirmation.id, goal.id, String(args.materialId), String(args.semanticTaskId), canonicalWfdJson(pipeline.missingDimensions));
      return this.result('语义尚有缺项，未向数据库发送。', { state: 'needs_confirmation', goalId: goal.id,
        confirmationId: confirmation.id, questions: pipeline.questions, missingDimensions: pipeline.missingDimensions });
    }
    if (goal.state === 'frozen') {
      const pending = this.db.prepare(`SELECT p.confirmation_id FROM conversation_cycle_confirmations p
        JOIN business_goal_confirmations c ON c.id=p.confirmation_id WHERE p.goal_id=? AND p.material_id=? AND c.state='pending'`)
        .get(goal.id, String(args.materialId));
      if (pending) goal = goals.confirmSemanticAnswer(input, String(pending.confirmation_id), { messageId: input.messageId, quote: input.text, start: 0, end: input.text.length },
        { sourceRecordId: String(args.semanticTaskId), questionId: 'daily-required-semantics' });
    }
    const maxObject = Math.max(pipeline.original.byteLength, ...pipeline.evidence.map(item => item.byteLength));
    const reserved = goals.reserveStep(input, { goalId: goal.id, revision: goal.revision, key: `ingest:${args.materialId}`,
      action: 'data.submit', args: stepArgs, effects: ['ingest'], rows: Number((pipeline.tablePackage as { descriptor: { row_count: number } }).descriptor.row_count),
      objectBytes: Math.max(maxObject, Buffer.byteLength(JSON.stringify(stepArgs))), totalBytes: Buffer.byteLength(canonicalWfdJson(pipeline)) });
    if (!reserved.shouldDispatch) {
      const existing = this.db.prepare('SELECT * FROM conversation_data_cycles WHERE step_id=?').get(reserved.step.id) as CycleRow | undefined;
      if (existing) return this.savedResult(existing);
      if (reserved.step.state !== 'reserved' || Object.keys(reserved.step.external).length) throw new TaskError('DATA_CYCLE_RESERVED', '原步骤的派发状态未核清，不能换编号重放。');
    }
    assert(); goals.assertCurrent(input, goal.id, goal.revision, ['ingest']);
    const head = await binding.port.getHead(context.signal);
    assert(); goals.assertCurrent(input, goal.id, goal.revision, ['ingest']);
    if (!Object.hasOwn(head, 'head_snapshot_id') || (head.head_snapshot_id !== null && typeof head.head_snapshot_id !== 'string')) {
      throw new TaskError('DATA_CYCLE_HEAD_UNVERIFIED', '数据库未提供目标的权威当前父快照，未提交。');
    }
    const cycleId = randomUUID(), envelope = binding.port.prepareIngest(pipeline, { requestId: reserved.step.requestId,
      handoffId: `user-cycle:${cycleId}`, collectionTaskId: String(link.service_task_id), processingTaskId: context.task.id,
      parentSnapshotId: head.head_snapshot_id as string | null, collectedAt: new Date().toISOString() });
    this.options.binding.pinRequest?.(envelope, context.task.id);
    this.db.prepare(`INSERT INTO conversation_data_cycles VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,'prepared',?,?)`)
      .run(cycleId, goal.id, reserved.step.id, reserved.step.requestId, canonicalWfdJson(origin), String(args.materialId), String(args.semanticTaskId), file.id,
        canonicalWfdJson(pipeline), canonicalWfdJson(envelope), Date.now(), Date.now());
    goals.recordStepExternal(reserved.step.id, reserved.step.requestId, { localTaskId: context.task.id, cycleId });
    const effectId = randomUUID(); let receipt: WfdRecord | undefined;
    try {
      assert(); goals.assertCurrent(input, goal.id, goal.revision, ['ingest']);
      await context.emit({ type: 'side_effect_started', effectId, description: '按固定目标向用户测试数据库提交原封闭材料', operation: { cycleId, requestId: envelope.request_id } });
      assert(); goals.assertCurrent(input, goal.id, goal.revision, ['ingest']);
      this.db.prepare("UPDATE conversation_data_cycles SET state='dispatched',updated_at=? WHERE id=?").run(Date.now(), cycleId);
      receipt = await binding.port.ingest(envelope, context.signal);
      this.storeReceipt(cycleId, receipt);
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '数据库返回已核对的原请求回执；正式状态以该回执为准。', data: json(receipt) });
      assert();
      if (receipt.state !== 'committed') return this.savedResult(this.row(cycleId));
      await this.readAndRegister(this.row(cycleId), context.signal, assert);
      this.tryComplete(input, goal.id);
      return this.savedResult(this.row(cycleId));
    } catch (error) {
      if (!receipt) {
        this.db.prepare("UPDATE conversation_data_cycles SET state='unknown',updated_at=? WHERE id=?").run(Date.now(), cycleId);
        goals.finishStep(reserved.step.id, reserved.step.requestId, 'unknown', { cycleId, requestId: envelope.request_id, outcome: 'unknown' });
      }
      throw error;
    }
  }
  private row(id: string): CycleRow {
    const row = this.db.prepare('SELECT * FROM conversation_data_cycles WHERE id=?').get(id) as CycleRow | undefined;
    if (!row) throw new TaskError('DATA_CYCLE_NOT_FOUND', '没有该原交接记录。');
    return row;
  }
  private storeReceipt(id: string, receipt: WfdRecord): void {
    const row = this.row(id), external: Record<string, string> = {};
    for (const [source, key] of [['job_id', 'databaseTaskId'], ['commit_id', 'commitId'], ['snapshot_id', 'snapshotId']]) if (typeof receipt[source!] === 'string') external[key!] = receipt[source!] as string;
    this.options.goals.recordStepExternal(row.step_id, row.request_id, external);
    this.db.prepare('UPDATE conversation_data_cycles SET receipt_json=?,state=?,updated_at=? WHERE id=?').run(canonicalWfdJson(receipt), String(receipt.state), Date.now(), id);
  }
  private async readAndRegister(row: CycleRow, signal: AbortSignal, assert: () => void): Promise<void> {
    const pipeline = JSON.parse(row.pipeline_json) as ReadyPipeline, receipt = JSON.parse(row.receipt_json!) as WfdRecord;
    assert();
    const envelope = JSON.parse(row.envelope_json) as WfdEnvelope;
    const binding = this.options.binding.forEnvelope?.(envelope) ?? this.options.binding;
    const readback = await binding.port.readCommitted(receipt, envelope, signal);
    assert();
    const declaration = declarationFromReadback(pipeline, receipt, readback, binding.principalId);
    const d = pipeline.declaration;
    binding.reader.registerCommittedSnapshot({ declaration, receipt, readback,
      semanticAdoption: { state: 'adopted', decisionId: d.proposalId, semanticRecordSha256: d.semanticRecordSha256,
        originalSha256: d.originalSha256, subjectId: binding.principalId, conversationId: d.origin.conversationId,
        branchId: d.origin.branchId, materialId: d.materialId, source: json({ evidence: d.semanticEvidence }) } });
    this.db.prepare("UPDATE conversation_data_cycles SET readback_json=?,reference_json=?,state='verified',updated_at=? WHERE id=?")
      .run(canonicalWfdJson(readback), canonicalWfdJson(declaration.reference), Date.now(), row.id);
    this.options.goals.finishStep(row.step_id, row.request_id, 'succeeded', { cycleId: row.id, commitId: String(receipt.commit_id), snapshotId: String(receipt.snapshot_id), readbackVerified: true });
  }
  private async status(context: TaskExecutionContext, origin: ModelTaskOrigin, id: string): Promise<TaskResult> {
    if (this.publications.has(id)) return this.publications.status(context, origin, id);
    const row = this.row(id), owner = JSON.parse(row.origin_json) as ModelTaskOrigin;
    if (owner.conversationId !== origin.conversationId || owner.branchId !== origin.branchId) throw new TaskError('DATA_CYCLE_SCOPE', '交接不属于当前会话分支。');
    const authority = await acquireAuthority(context, 'data.status', context.task.args, this.options.binding.capabilities);
    authority.assert(); this.assertOrigin(origin);
    const envelope = JSON.parse(row.envelope_json) as WfdEnvelope;
    const binding = this.options.binding.forEnvelope?.(envelope) ?? this.options.binding;
    const receipt = await binding.port.lookup(String(envelope.arguments.handoff_id), context.signal);
    this.storeReceipt(row.id, receipt); authority.assert(); this.assertOrigin(origin);
    if (receipt.state === 'committed') { await this.readAndRegister(this.row(id), context.signal, () => { authority.assert(); this.assertOrigin(origin); }); this.tryComplete(this.input(origin), row.goal_id); }
    return this.savedResult(this.row(id));
  }
  private savedResult(row: CycleRow): TaskResult {
    const receipt = row.receipt_json ? JSON.parse(row.receipt_json) as WfdRecord : null;
    return this.result(row.state === 'verified' ? '用户表格已正式提交，并核对固定快照读回。' : '原交接身份和实际状态已保存；未自动重发。', {
      cycleId: row.id, goalId: row.goal_id, state: row.state, receipt,
      fixedReference: row.reference_json ? JSON.parse(row.reference_json) : null,
      readbackVerified: row.state === 'verified', publicationState: 'input_only',
      financialContracts: (this.options.companion.financial?.list() ?? []).map(description => {
        const capabilityId = description.capabilityId;
        const contract = JSON.parse(canonicalWfdJson(description.publicContract)) as WfdRecord;
        const inputContract = contract.input_contract as WfdRecord;
        delete inputContract.directSchema; inputContract.inputKinds = ['snapshot'];
        const schema = contract.input_schema as any;
        schema.properties.inputs.properties.bars.oneOf = schema.properties.inputs.properties.bars.oneOf
          .filter((item: any) => item.properties.kind.const === 'dataset_ref');
        (contract.supported as WfdRecord).inputs = ['dataset_ref'];
        return { capabilityId, contractVersion: description.contractVersion, title: description.title,
          scope: 'this-fixed-snapshot', publicContract: contract };
      }),
      guidance: this.options.companion.financial
        ? '金融计算使用此固定参考及financialContracts中完整的固定快照调用合同选择字段；计算结果尚未保存。需要保存结果时必须有用户明确请求，再调用独立results.publish。'
        : '计算资产尚未绑定，两种金融方法当前不可用，等待用户审核后通过明确入口接入；本次仅保留数据交接状态和固定参考。',
    });
  }
  private result(summary: string, preview: unknown): TaskResult { return { summary, data: json({ kind: 'conversation-data-cycle', modelPreview: preview }) }; }
  private ensureGoal(input: BackendInput, materialId: string, analysisPlan: ReturnType<typeof parseAnalysisPlan>) {
    if (analysisPlan.length && !this.options.companion.financial) throw new TaskError('FINANCIAL_NOT_ENABLED', '计算资产尚未绑定，当前不能建立金融计算目标；等待用户审核接入。');
    const goal = this.options.goals.ensureGoal(input, { objective: analysisPlan.length
      ? '用户表格加工、用户测试库提交与固定读回，并完成明确选择的首批金融计算' : '完成用户表格输入提交子目标：五步加工、正式提交和固定读回',
      contract: json({ version: 'first-user-cycle/1', materialId, dataset: this.options.binding.port.target, schemaSha256: this.options.binding.port.contractDigest, analysisPlan }),
      completionConditions: [{ id: 'committed-readback', stepKey: `ingest:${materialId}`, description: '真实提交回执与固定快照读回核对通过' },
        ...analysisPlan.flatMap(item => [{ id: item.capabilityId, stepKey: computeStepKey(item.capabilityId, item.parameters), description: '原固定输入的实际金融计算成功并保留结果引用' },
          ...(item.persist ? [{ id: `save:${item.capabilityId}`, stepKey: computeStepKey(item.capabilityId, item.parameters).replace(/^compute:/u, 'save:'),
            description: '用户明确要求的原计算结果独立发布并固定读回' }] : [])])] });
    if (!isWfdRecord(goal.contract) || goal.contract.version !== 'first-user-cycle/1' || goal.contract.materialId !== materialId) {
      throw new TaskError('DATA_CYCLE_GOAL_CONFLICT', '当前目标已经绑定其他材料或操作，不能以旧授权替换。');
    }
    return goal;
  }
  private tryComplete(input: BackendInput, goalId: string): void {
    const goal = this.options.goals.get(goalId);
    if (goal.state !== 'active') return;
    if (goal.currentInputId !== input.inputId) return;
    const states = new Map(this.db.prepare('SELECT step_key,state FROM business_goal_steps WHERE goal_id=?').all(goalId).map(row => [String(row.step_key), String(row.state)]));
    if (goal.completionConditions.every(condition => states.get(condition.stepKey) === 'succeeded')) this.options.goals.complete(input, goal.id, goal.revision);
  }
}

function declarationFromReadback(pipeline: ReadyPipeline, receipt: WfdRecord, readback: WfdRecord, subjectId: string): WfdFinancialDeclaration {
  const d = pipeline.declaration, descriptor = readback.descriptor as WfdRecord, rows = readback.rows as WfdRecord[];
  const bars = rows.map(row => ({ timestamp: String(row.timestamp), available_at: String(row.available_at), bar_closed: true as const }));
  const target = pipeline.plan.target;
  return { id: `user-daily-${d.materialId}`, version: '1', reference: { kind: 'snapshot', productId: target.datasetId,
    snapshotId: String(receipt.snapshot_id), outputIdentity: { unitId: target.unitId, outputId: target.outputId,
      definitionRevision: target.definitionRevision, schemaRevision: target.schemaRevision }, referenceDependencies: [],
    range: { start: bars[0]!.timestamp, end: bars.at(-1)!.timestamp }, useMode: 'analysis' },
    descriptorSha256: userTableDigest(descriptor), rowsResourceSha256: userTableDigest(rows), lineageSha256: userTableDigest(readback.lineage),
    rowCount: rows.length, sourceFields: (descriptor.fields as WfdRecord[]).map(field => String(field.name)),
    metadata: { series_id: d.seriesId, frequency: '1d', timezone: d.timezone, price_unit: 'currency_per_share', currency: d.currency,
      adjustment: 'unadjusted', adjustment_basis: 'explicit-user-declaration', window_start: bars[0]!.timestamp, window_end: bars.at(-1)!.timestamp,
      observations_are_consecutive: true, as_of: d.asOf, availability_basis: 'explicit_per_bar', synthetic: d.synthetic },
    fieldMapping: { timestamp: { field: 'timestamp', encoding: 'YYYY-MM-DD', unit: 'YYYY-MM-DD' },
      instrument: { field: 'series_id', storedValue: d.seriesId, symbol: d.instrument.symbol, dtype: 'string', unit: 'opaque_series_id' },
      availability: { availableAt: 'available_at', barClosed: 'bar_closed' },
      prices: { open: 'open', close: 'close' }, priceUnit: d.currency }, bars,
    provenance: json({ declaration: d, receiptRequestId: receipt.request_id, observationSequence: d.observationSequence }),
    origin: { subjectId, conversationId: d.origin.conversationId, branchId: d.origin.branchId, materialId: d.materialId, semanticDecisionId: d.proposalId } };
}
function json(value: unknown): JsonValue { return JSON.parse(canonicalWfdJson(value)) as JsonValue; }
function computeStepKey(capabilityId: string, parameters: unknown): string { return `compute:${capabilityId}:${userTableDigest(parameters).slice(0, 16)}`; }
function deniedAuthorizationClause(text: string, quote: string): boolean {
  const start = text.indexOf(quote), end = start + quote.length;
  if (start < 0 || text.indexOf(quote, start + 1) !== -1) return true;
  const separators = /[，,。！？!?\n；;]/u;
  let left = start, right = end;
  while (left > 0 && !separators.test(text[left - 1]!)) left--;
  while (right < text.length && !separators.test(text[right]!)) right++;
  return /(?:不要|不得|暂不|先不|别|不允许|do not|don't|not yet)/iu.test(text.slice(left, right));
}
function parseAnalysisPlan(value: JsonValue | undefined): Array<{ capabilityId: string; parameters: Record<string, JsonValue>; persist: boolean }> {
  let parsed: unknown;
  try { parsed = value === undefined ? [] : JSON.parse(String(value)); } catch { throw new TaskError('DATA_CYCLE_PLAN_INVALID', '计算完成条件必须是明确的结构化列表。'); }
  if (!Array.isArray(parsed) || parsed.length > 2 || parsed.some(item => !item || typeof item !== 'object' || Array.isArray(item)
    || Object.keys(item).some(key => !['capabilityId', 'parameters', 'persist'].includes(key)) || !FINANCIAL_CAPABILITIES.slice(0, 2).includes(item.capabilityId)
    || (item.persist !== undefined && typeof item.persist !== 'boolean')
    || !item.parameters || typeof item.parameters !== 'object' || Array.isArray(item.parameters)
    || (item.capabilityId === FINANCIAL_CAPABILITIES[0] ? Object.keys(item.parameters).join(',') !== 'period'
      || !Number.isSafeInteger(item.parameters.period) || item.parameters.period < 1 || item.parameters.period > 512 : Object.keys(item.parameters).length > 0))
    || new Set(parsed.map(item => item.capabilityId)).size !== parsed.length) throw new TaskError('DATA_CYCLE_PLAN_INVALID', '只支持首批两方法及明确参数，不增加其他工具或预算。');
  return parsed.map(item => ({ ...item, persist: item.persist === true }));
}

/** 识别模型已给列名却遗漏角色的提案格式，不自动采用角色或改写语义。 */
function hasUnsubmittedFieldJudgments(record: MaterialSemanticRecord, missing: string[]): boolean {
  if (record.proposal.judgments.some(judgment => judgment.key === 'field')
    || missing.some(dimension => !dimension.startsWith('field:') && !['available_at', 'bar_closed'].includes(dimension))) return false;
  const fields = record.proposal.table?.fields ?? [];
  return ['trade_date', 'open', 'close', 'available_at', 'bar_closed'].every(role => fields.filter(field => field.name === role).length === 1);
}
