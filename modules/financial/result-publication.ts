import { randomUUID } from 'node:crypto';
import type { BackendInput } from '../../contracts/backend.js';
import type { BusinessGoalService } from '../../platform/jobs/business-goals.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import { requireFinancialComputedResult } from './contracts.js';
import { createWfdFinancialPublication } from '../../adapters/database/wfd-publication.js';
import type { FinancialSnapshotInput } from './types.js';
import { canonicalWfdJson, isWfdRecord, type WfdEnvelope, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { userTableDigest } from '../collection/user-table-pipeline.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { ConversationUserCycleBinding } from '../collection/conversation-data-cycle.js';

type PublicationRow = { id: string; goal_id: string; step_id: string; request_id: string; conversation_id: string; branch_id: string;
  service_task_id: string; result_id: string; dataset_id: string; envelope_json: string; receipt_json: string | null;
  readback_json: string | null; state: string };

/** 发布账只保存原结果与外部身份；不改变金融任务、不重算、不自动重放未知发布。 */
export class ConversationResultPublication {
  constructor(private readonly options: { database: CoreDatabase; companion: WorkspaceServices; binding: ConversationUserCycleBinding;
    goals: BusinessGoalService; input(origin: ModelTaskOrigin): BackendInput; assertOrigin(origin: ModelTaskOrigin): void }) {
    options.database.migrate('conversation_result_publications', 1, `CREATE TABLE conversation_result_publications (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, step_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL, service_task_id TEXT NOT NULL, result_id TEXT NOT NULL,
      dataset_id TEXT NOT NULL, envelope_json TEXT NOT NULL, receipt_json TEXT, readback_json TEXT, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX conversation_live_publication ON conversation_result_publications(conversation_id,branch_id,result_id,dataset_id)
        WHERE state IN ('prepared','dispatched','accepted','received','committed','verified','unknown','not_found');`);
  }
  private get db() { return this.options.database.connection; }
  has(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM conversation_result_publications WHERE id=?').get(id); }
  private target(datasetId: string, envelope: WfdEnvelope) {
    const binding = this.options.binding.forEnvelope?.(envelope) ?? this.options.binding;
    const target = binding.publicationTargets.find(item => item.port.target.datasetId === datasetId);
    if (!target) throw new TaskError('RESULT_PUBLICATION_UNBOUND', '原派生目标的受信合同不可用。');
    return target;
  }
  async execute(context: TaskExecutionContext, origin: ModelTaskOrigin, args: Record<string, JsonValue>): Promise<TaskResult> {
    if (!this.options.companion.financial) throw new TaskError('FINANCIAL_NOT_ENABLED', '计算资产尚未绑定，当前金融结果发布入口不可用；原发布状态仍可按原身份查询。');
    const binding = this.options.binding.forTask?.(context.task.id) ?? this.options.binding;
    const links = this.db.prepare('SELECT origin_json FROM conversation_financial_calls WHERE service_task_id=? AND operation=?').all(String(args.serviceTaskId), 'tools.call');
    if (!links.some(row => { const saved = JSON.parse(String(row.origin_json)) as ModelTaskOrigin;
      return saved.conversationId === origin.conversationId && saved.branchId === origin.branchId; })) throw new TaskError('RESULT_PUBLICATION_SCOPE', '原金融结果不属于当前会话分支。');
    const task = this.options.companion.harness!.getTask(String(args.serviceTaskId)), computed = requireFinancialComputedResult(task);
    if (!isWfdRecord(computed.inputReference) || computed.inputReference.kind !== 'snapshot') throw new TaskError('RESULT_PUBLICATION_INPUT', '首包发布要求有真实数据库固定输入及完整谱系。');
    const selected = binding.publicationTargets.find(item => item.toolId === computed.capabilityId);
    if (!selected) throw new TaskError('RESULT_PUBLICATION_UNBOUND', '该方法没有受信登记的派生发布目标。');
    const authority = await acquireAuthority(context, 'results.publish', args, binding.capabilities);
    const assert = () => { authority.assert(); this.options.assertOrigin(origin); };
    assert();
    const existing = this.db.prepare('SELECT * FROM conversation_result_publications WHERE conversation_id=? AND branch_id=? AND result_id=? AND dataset_id=? ORDER BY rowid DESC LIMIT 1')
      .get(origin.conversationId, origin.branchId, task.resultRef!, selected.port.target.datasetId) as PublicationRow | undefined;
    if (existing && !terminalUncommitted(existing.state)) return this.result(existing);
    const inputReference = computed.inputReference as unknown as FinancialSnapshotInput;
    const declaration = binding.reader.getDeclaration(inputReference);
    if (!declaration || declaration.origin?.conversationId !== origin.conversationId || declaration.origin.branchId !== origin.branchId) {
      throw new TaskError('RESULT_PUBLICATION_INPUT', '原金融输入没有同分支的受信固定声明。');
    }
    const cycle = this.db.prepare("SELECT receipt_json,readback_json FROM conversation_data_cycles WHERE state='verified' AND material_id=? AND origin_json IS NOT NULL")
      .all(declaration.origin.materialId).find(row => {
        const receipt = JSON.parse(String(row.receipt_json)) as WfdRecord; return receipt.snapshot_id === inputReference.snapshotId;
      });
    if (!cycle) throw new TaskError('RESULT_PUBLICATION_INPUT', '输入的真实提交回执及固定读回证据不可取回。');
    const sourceReceipt = JSON.parse(String(cycle.receipt_json)) as WfdRecord, sourceRead = JSON.parse(String(cycle.readback_json)) as WfdRecord;
    const input = this.options.input(origin), { goals } = this.options;
    const attached = goals.forInput(input), combined = attached && isWfdRecord(attached.contract) && attached.contract.version === 'first-user-cycle/1';
    const stepKey = combined ? `save:${computed.capabilityId}:${userTableDigest(computed.parameters).slice(0, 16)}` : `publish:${task.resultRef}:${selected.port.target.datasetId}`;
    const plan = combined ? [] : this.publicationPlan(origin, args, task.id);
    const computationKey = `compute:${computed.capabilityId}:${userTableDigest(computed.parameters).slice(0, 16)}`;
    const boundComputation = combined ? this.db.prepare('SELECT external FROM business_goal_steps WHERE goal_id=? AND step_key=?')
      .get(attached.id, computationKey) : undefined;
    const computationIdentity = boundComputation ? JSON.parse(String(boundComputation.external)) as Record<string, unknown> : undefined;
    let goal = combined ? attached : goals.ensureGoal(input, { objective: '按用户明确要求，独立保存所选原金融结果并核对派生固定快照',
      contract: json({ version: 'financial-result-publication/1', results: plan }),
      completionConditions: plan.map(item => ({ id: item.resultId, stepKey: `publish:${item.resultId}:${item.datasetId}`, description: '真实派生提交与固定读回逐项核对通过' })) });
    if (!goal.completionConditions.some(condition => condition.stepKey === stepKey)
      || (combined && (!isWfdRecord(goal.contract) || goal.contract.materialId !== declaration.origin.materialId
        || computationIdentity?.serviceTaskId !== task.id))) {
      throw new TaskError('RESULT_PUBLICATION_PLAN_CONFLICT', '此结果不属于当前输入冻结的保存计划；不能扩大原目标或预算。');
    }
    if (existing) {
      if (goal.id !== existing.goal_id) throw new TaskError('RESULT_PUBLICATION_RETRY_REQUIRED', '原失败发布须沿原目标和预算明确确认重试，不能新建目标绕过。');
      const confirmation = this.db.prepare("SELECT id FROM business_goal_confirmations WHERE goal_id=? AND step_id=? AND state='pending'").get(goal.id, existing.step_id);
      if (!confirmation) throw new TaskError('RESULT_PUBLICATION_RETRY_REQUIRED', '先用data.status核对原失败终态与待确认项，再明确确认重新保存结果。');
      goal = goals.confirmWithUserMessage(input, String(confirmation.id), { messageId: input.messageId, quote: input.text, start: 0, end: input.text.length });
    }
    const evidence = this.options.companion.financial!.publicationEvidence(task.id);
    const evidenceBytes = [Buffer.from(evidence.rawResultBytes), Buffer.from(canonicalWfdJson(evidence.sealedInput)),
      Buffer.from(canonicalWfdJson(evidence.environmentEvidence)), Buffer.from(canonicalWfdJson(evidence.methodEvidence))];
    const stepArgs = json({ serviceTaskId: task.id, resultId: task.resultRef, target: selected.port.target, input: inputReference });
    const reserved = goals.reserveStep(input, { goalId: goal.id, revision: goal.revision, key: stepKey, action: 'results.publish', args: stepArgs,
      effects: ['publish'], rows: computed.rows.length, objectBytes: Math.max(Buffer.byteLength(JSON.stringify(stepArgs)), ...evidenceBytes.map(bytes => bytes.length)),
      totalBytes: evidenceBytes.reduce((sum, bytes) => sum + bytes.length, 0) + Buffer.byteLength(JSON.stringify(stepArgs)) });
    if (!reserved.shouldDispatch && (reserved.step.state !== 'reserved' || Object.keys(reserved.step.external).length)) {
      throw new TaskError('RESULT_PUBLICATION_PENDING', '发布步骤已有未核完外部身份，不能换编号重派。');
    }
    assert(); goals.assertCurrent(input, goal.id, goal.revision, ['publish']);
    const head = await selected.port.getHead(context.signal);
    assert(); goals.assertCurrent(input, goal.id, goal.revision, ['publish']);
    if (!Object.hasOwn(head, 'head_snapshot_id') || (head.head_snapshot_id !== null && typeof head.head_snapshot_id !== 'string')) throw new TaskError('RESULT_PUBLICATION_HEAD', '派生目标缺少权威父快照。');
    const id = randomUUID(), target = selected.port.target;
    const envelope = createWfdFinancialPublication(task, { instanceId: binding.instanceId, requestId: reserved.step.requestId,
      publicationId: `financial-publication:${id}`, target: { datasetId: target.datasetId, datasetMappingVersion: target.mappingVersion,
        outputIdentity: { unitId: target.unitId, outputId: target.outputId, definitionRevision: target.definitionRevision, schemaRevision: target.schemaRevision },
        parentSnapshotId: head.head_snapshot_id as string | null, purpose: 'user_test' },
      inputLineage: { reference: inputReference, descriptorSha256: declaration.descriptorSha256,
        rowsResourceSha256: declaration.rowsResourceSha256, lineageSha256: declaration.lineageSha256 },
      inputSnapshot: { instance_id: binding.instanceId, dataset_id: inputReference.productId,
        dataset_mapping_version: String(sourceRead.dataset_mapping_version), snapshot_id: inputReference.snapshotId, commit_id: String(sourceReceipt.commit_id),
        target: sourceRead.target as { unit_id: string; output_id: string; definition_rev: string; schema_rev: string }, rows_sha256: declaration.rowsResourceSha256 },
      descriptorSemantics: selected.descriptorSemantics, evidence, check: selected.transport.check });
    // 最终完整封闭包还按传输8MiB上限校验，原金融结果始终独立保留。
    selected.transport.validateRequest(envelope);
    this.options.binding.pinRequest?.(envelope, context.task.id);
    this.db.prepare(`INSERT INTO conversation_result_publications VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,'prepared',?,?)`)
      .run(id, goal.id, reserved.step.id, reserved.step.requestId, origin.conversationId, origin.branchId, task.id, task.resultRef!, target.datasetId,
        canonicalWfdJson(envelope), Date.now(), Date.now());
    goals.recordStepExternal(reserved.step.id, reserved.step.requestId, { localTaskId: context.task.id, publicationCycleId: id, resultId: task.resultRef! });
    const effectId = randomUUID(); let receipt: WfdRecord | undefined;
    try {
      assert(); goals.assertCurrent(input, goal.id, goal.revision, ['publish']);
      await context.emit({ type: 'side_effect_started', effectId, description: '用户明确保存原金融结果，独立发布派生数据', operation: { publicationId: String(envelope.arguments.publication_id), resultId: task.resultRef! } });
      assert(); goals.assertCurrent(input, goal.id, goal.revision, ['publish']);
      this.db.prepare("UPDATE conversation_result_publications SET state='dispatched',updated_at=? WHERE id=?").run(Date.now(), id);
      receipt = await selected.port.publish(envelope, context.signal); this.storeReceipt(id, receipt);
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '已按原发布身份核对真实数据库回执。', data: json(receipt) });
      assert();
      if (receipt.state === 'committed') await this.read(this.row(id), context.signal, assert, input);
      else if (terminalUncommitted(String(receipt.state))) this.prepareRetry(this.row(id), input);
      return this.result(this.row(id));
    } catch (error) {
      if (!receipt) {
        this.db.prepare("UPDATE conversation_result_publications SET state='unknown',updated_at=? WHERE id=?").run(Date.now(), id);
        goals.finishStep(reserved.step.id, reserved.step.requestId, 'unknown', { cycleId: id, resultId: task.resultRef!, state: 'unknown' });
      }
      throw error;
    }
  }
  async status(context: TaskExecutionContext, origin: ModelTaskOrigin, id: string): Promise<TaskResult> {
    const row = this.row(id);
    if (row.conversation_id !== origin.conversationId || row.branch_id !== origin.branchId) throw new TaskError('RESULT_PUBLICATION_SCOPE', '发布不属于当前会话分支。');
    const authority = await acquireAuthority(context, 'data.status', context.task.args, this.options.binding.capabilities);
    const assert = () => { authority.assert(); this.options.assertOrigin(origin); };
    assert(); const envelope = JSON.parse(row.envelope_json) as WfdEnvelope;
    const receipt = await this.target(row.dataset_id, envelope).port.lookup(String(envelope.arguments.publication_id), context.signal);
    this.storeReceipt(id, receipt); assert();
    if (receipt.state === 'committed') await this.read(this.row(id), context.signal, assert, this.options.input(origin));
    else if (terminalUncommitted(String(receipt.state))) this.prepareRetry(this.row(id), this.options.input(origin));
    return this.result(this.row(id));
  }
  private async read(row: PublicationRow, signal: AbortSignal, assert: () => void, input: BackendInput): Promise<void> {
    const receipt = JSON.parse(row.receipt_json!) as WfdRecord, envelope = JSON.parse(row.envelope_json) as WfdEnvelope;
    assert(); const readback = await this.target(row.dataset_id, envelope).port.readCommitted(receipt, envelope, signal); assert();
    this.db.prepare("UPDATE conversation_result_publications SET readback_json=?,state='verified',updated_at=? WHERE id=?").run(canonicalWfdJson(readback), Date.now(), row.id);
    this.options.goals.finishStep(row.step_id, row.request_id, 'succeeded', { cycleId: row.id, resultId: row.result_id,
      commitId: String(receipt.commit_id), snapshotId: String(receipt.snapshot_id), readbackVerified: true });
    const goal = this.options.goals.get(row.goal_id);
    const states = new Map(this.db.prepare('SELECT step_key,state FROM business_goal_steps WHERE goal_id=?').all(goal.id).map(item => [String(item.step_key), String(item.state)]));
    if (goal.state === 'active' && goal.currentInputId === input.inputId && goal.completionConditions.every(condition => states.get(condition.stepKey) === 'succeeded')) {
      this.options.goals.complete(input, goal.id, goal.revision);
    }
  }
  private storeReceipt(id: string, receipt: WfdRecord): void {
    const row = this.row(id), external: Record<string, string> = {};
    for (const [source, key] of [['job_id', 'databaseTaskId'], ['commit_id', 'commitId'], ['snapshot_id', 'snapshotId']]) if (typeof receipt[source!] === 'string') external[key!] = receipt[source!] as string;
    if (this.options.goals.getStep(row.step_id).requestId === row.request_id) this.options.goals.recordStepExternal(row.step_id, row.request_id, external);
    this.db.prepare('UPDATE conversation_result_publications SET receipt_json=?,state=?,updated_at=? WHERE id=?').run(canonicalWfdJson(receipt), String(receipt.state), Date.now(), id);
  }
  private row(id: string): PublicationRow {
    const row = this.db.prepare('SELECT * FROM conversation_result_publications WHERE id=?').get(id) as PublicationRow | undefined;
    if (!row) throw new TaskError('RESULT_PUBLICATION_NOT_FOUND', '没有原发布记录。'); return row;
  }
  private publicationPlan(origin: ModelTaskOrigin, args: Record<string, JsonValue>, currentTaskId: string): Array<{ serviceTaskId: string; resultId: string; datasetId: string }> {
    let ids: unknown;
    try { ids = args.serviceTaskIdsJson === undefined ? [currentTaskId] : JSON.parse(String(args.serviceTaskIdsJson)); }
    catch { throw new TaskError('RESULT_PUBLICATION_PLAN_INVALID', '保存计划需要明确的原任务编号列表。'); }
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || !ids.includes(currentTaskId)
      || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new TaskError('RESULT_PUBLICATION_PLAN_INVALID', '首包每个保存目标需要明确的1至2项原金融结果。');
    return ids.map(id => {
      const linked = this.db.prepare('SELECT origin_json FROM conversation_financial_calls WHERE service_task_id=? AND operation=?').all(id, 'tools.call');
      if (!linked.some(row => { const previous = JSON.parse(String(row.origin_json)) as ModelTaskOrigin;
        return previous.conversationId === origin.conversationId && previous.branchId === origin.branchId; })) throw new TaskError('RESULT_PUBLICATION_SCOPE', '保存计划含其他会话分支的结果。');
      const task = this.options.companion.harness!.getTask(id), computed = requireFinancialComputedResult(task);
      const target = this.options.binding.publicationTargets.find(item => item.toolId === computed.capabilityId);
      if (!target) throw new TaskError('RESULT_PUBLICATION_UNBOUND', '保存计划包含未登记的派生方法。');
      return { serviceTaskId: id, resultId: task.resultRef!, datasetId: target.port.target.datasetId };
    });
  }
  private prepareRetry(row: PublicationRow, input: BackendInput): void {
    const goal = this.options.goals.get(row.goal_id), step = this.options.goals.getStep(row.step_id);
    if (goal.state === 'completed' || goal.currentInputId !== input.inputId || step.requestId !== row.request_id || step.state === 'needs_confirmation') return;
    this.options.goals.finishStep(row.step_id, row.request_id, 'failed', { cycleId: row.id, state: row.state, definitivelyUncommitted: true });
    this.options.goals.requestConfirmation(input, goal.id, goal.revision, row.step_id,
      '数据库已明确该发布未提交。原计算结果仍保留；如需纠正，请明确回复“确认重新保存该结果”，再沿原目标创建新的发布尝试。');
  }
  private result(row: PublicationRow): TaskResult {
    const receipt = row.receipt_json ? JSON.parse(row.receipt_json) as WfdRecord : null;
    return { summary: row.state === 'verified' ? '金融派生结果已独立提交，并核对固定读回；原计算结果保留。' : '原发布身份与实际状态已保存；原计算结果保留，未自动重发。',
      data: json({ kind: 'conversation-result-publication', modelPreview: { cycleId: row.id, kind: 'publication', state: row.state,
        serviceTaskId: row.service_task_id, resultId: row.result_id, datasetId: row.dataset_id, receipt, readbackVerified: row.state === 'verified',
        confirmationRequired: terminalUncommitted(row.state), guidance: terminalUncommitted(row.state)
          ? '此发布已明确未提交，原计算结果保留。需纠正时先data.status核对，再由用户明确确认重新保存该结果；沿原目标预算建立新发布身份。'
          : '只有verified表示真实提交且固定读回已核对。unknown按此cycleId调用data.status，不新建发布请求。' } }) };
  }
}
function json(value: unknown): JsonValue { return JSON.parse(canonicalWfdJson(value)) as JsonValue; }
function terminalUncommitted(state: string): boolean { return ['failed', 'rejected', 'cancelled'].includes(state); }
