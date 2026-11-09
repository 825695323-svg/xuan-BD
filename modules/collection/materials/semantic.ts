import { parseSemanticMaterialTable, applySemanticTableCleaning, locator } from '../data-processing/table-cleaner/index.js';
import { createHash, randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../../../platform/state/database.js';
import { digestOperationArgs } from '../../../platform/security/permissions.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../../platform/jobs/tasks.js';
import type { JsonValue } from '../../../contracts/task-contracts.js';
import type { MaterialCategory, MaterialCell, MaterialLimits, MaterialLocation, MaterialRecord, MaterialTable } from './contracts.js';
import { DEFAULT_MATERIAL_ADAPTERS, MaterialError, materialLimits } from '../data-processing/material-inspector/index.js';
import type { MaterialService } from './service.js';
import { MATERIAL_CLEANING_RULES_VERSION, MATERIAL_SEMANTIC_PROPOSAL_VERSION, SEMANTIC_PROPOSAL_SCHEMA,
  type AppliedMaterialChange, type MaterialDateFormat, type MaterialSemanticProposal, type MaterialSemanticRecord,
  type SemanticEvidence, type SemanticJudgment, type SemanticQuestion, type SemanticProcessedTable, type TrustedMaterialOrigin } from './semantic-contracts.js';

export const MATERIAL_SEMANTIC_RUNTIME = 'bd.material-semantics';
export const MATERIAL_SEMANTIC_OPERATION = 'materials.semantic-process';
export const MATERIAL_SEMANTIC_PROCESSOR_VERSION = 'material-semantic-processor/1.2';
export interface MaterialSemanticServiceOptions { database: CoreDatabase; materials: MaterialService; tasks(): TaskService; limits?: Partial<MaterialLimits> }
interface Binding { proposalId: string; proposal: MaterialSemanticProposal; origin: TrustedMaterialOrigin }
interface SemanticDimension { key: SemanticJudgment['key']; scope: string }
interface PendingRequirement { record: MaterialSemanticRecord; question: SemanticQuestion; dimension: SemanticDimension }
const SCHEMA = `
CREATE TABLE material_semantic_inputs (
 proposal_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), material_id TEXT NOT NULL,
 binding_json TEXT NOT NULL, binding_digest TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX material_semantic_material ON material_semantic_inputs(material_id,created_at);
CREATE TABLE material_semantic_records (
 proposal_id TEXT PRIMARY KEY REFERENCES material_semantic_inputs(proposal_id), record_json TEXT NOT NULL, record_digest TEXT NOT NULL
);
`;

/** 模型只提语义与有限规则；原件解析、引用核对和实际清洗由本地确定性程序完成。 */
export class MaterialSemanticService {
  private readonly limits: MaterialLimits;
  readonly versionBinding: Record<string, string>;
  constructor(private readonly options: MaterialSemanticServiceOptions) {
    this.limits = materialLimits(options.limits);
    this.versionBinding = Object.freeze({ materialSemantics: MATERIAL_SEMANTIC_PROCESSOR_VERSION,
      cleaningRules: MATERIAL_CLEANING_RULES_VERSION, semanticConfiguration: digestOperationArgs(this.limits) });
    options.database.migrate('material-semantics', 1, SCHEMA);
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }

  modelContract(): JsonValue {
    return asJson({ schema: SEMANTIC_PROPOSAL_SCHEMA, proposalVersion: MATERIAL_SEMANTIC_PROPOSAL_VERSION,
      rulesVersion: MATERIAL_CLEANING_RULES_VERSION, limits: this.limits, positionUnit: 'UTF-16',
      instructions: [
        '仅提交原件材料身份、语义证据及有限清洗规则；不要提供数据行、模型身份、运行身份或授权。',
        '原件与用户消息证据可仅给 quote；只接受唯一原句。重复原句须给准确 start/end；显式坐标有误即拒绝。BOM 保留。',
        'known 必须有原文或真实用户消息证据；推断来源不得写成用户声明。judgments 中的 unknown 示例：{id:"j-unknown",key:"period",status:"unknown",evidence:[]}，不要带 value；unknown/conflict 不会被采用为事实。',
        '接收类别 unclassified 表示用途待判断。先读原文与自然语言需求，再提交 classification 的 data/tool、理由与原文或真实消息证据；这是模型判断，不能冒充用户声明。缺少分类只保存候选，不加工。',
        '分类只属于本次提案，不改变原件 materialId、originalSha256 或接收类别；已明确接收为 data/tool 的旧原件不能改类，待确认语义继续按同一原件全部历史核对。',
        'CSV headerLine 是从 1 开始的物理原件行，headerEvidence 须覆盖该表头原文；字段 column 从 1 开始。',
        '字段映射 evidence 须覆盖完整原始表头单元格（含原有空白与引号），也可引用包含它的完整表头行。',
        '只规范空白、空值、明确格式日期和十进制字面量；不换单位、不猜时区、不填业务值。日期证据须包含明确格式名称。',
        '影响清洗的未知判断放入 cleaning.requiredJudgmentIds 或 questions；不相关的 unknown 可以保留。requiredJudgmentIds 不属于提案顶层。',
        '同一材料和会话分支的待确认语义不能靠省略旧提案或换判断 id 绕过；无关纯空白清理仍可独立执行。',
        '确认以 supersedesProposalId 或每项 confirmations.proposalId 引用旧提案及问题，并在对应 key/scope 的 known 或日期/小数规则证据中引用实际新回复；旧提案不可改写。',
      ] });
  }

  submitProposal(input: unknown, trustedOrigin: TrustedMaterialOrigin, requestId: string): TaskRecord {
    const proposal = cloneProposal(input), origin = validateOrigin(trustedOrigin);
    const material = this.options.materials.get(proposal.materialId);
    classificationFor(material.envelope.category, proposal);
    const original = this.options.materials.readOriginal(proposal.materialId);
    if (original.sha256 !== proposal.originalSha256) fail('MATERIAL_SEMANTIC_ORIGINAL_CHANGED', '提案原件摘要与冻结材料不同，未执行清洗。');
    if (original.bytes.byteLength > this.limits.maxBytes) fail('MATERIAL_BYTE_BUDGET', '原件超过语义加工字节预算。');
    const text = decodeForEvidence(original.bytes, this.limits, material.preview.support !== 'supported');
    resolveAllEvidence(proposal, origin, text);
    const previous = this.requestTask(requestId);
    if (previous) {
      const binding = this.binding(previous.id);
      if (digestOperationArgs({ proposal, origin }) !== digestOperationArgs({ proposal: binding.proposal, origin: binding.origin })) {
        throw new TaskError('REQUEST_CONFLICT', '同一语义请求不能用于不同提案、来源、用户回复或授权。');
      }
      return previous;
    }
    this.validateSupersession(proposal, origin);
    this.assertDispatch();
    const binding: Binding = { proposalId: randomUUID(), proposal, origin }, bindingDigest = digestOperationArgs(binding);
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      this.assertDispatch();
      accepted = this.tasks.createInTransaction({ title: `材料语义与清洗：${original.filename}`, ownerRole: 'service',
        runtimeId: MATERIAL_SEMANTIC_RUNTIME, action: MATERIAL_SEMANTIC_OPERATION, requestId: requestKey(requestId),
        args: asJson({ proposalId: binding.proposalId, materialId: proposal.materialId, originalSha256: proposal.originalSha256, bindingDigest }),
        versions: { ...this.versionBinding, originalSha256: proposal.originalSha256 } });
      this.db.prepare('INSERT INTO material_semantic_inputs VALUES(?,?,?,?,?,?)')
        .run(binding.proposalId, accepted.task.id, proposal.materialId, JSON.stringify(binding), bindingDigest, Date.now());
    });
    accepted.publish();
    return this.tasks.start(accepted.task.id, accepted.task.version);
  }

  requestTask(requestId: string): TaskRecord | null {
    const row = this.db.prepare('SELECT id FROM tasks WHERE runtime_id=? AND request_id=?').get(MATERIAL_SEMANTIC_RUNTIME, requestKey(requestId));
    return row ? this.tasks.get(String(row.id)) : null;
  }

  get(proposalId: string): MaterialSemanticRecord {
    validId(proposalId);
    const row = this.db.prepare('SELECT record_json,record_digest FROM material_semantic_records WHERE proposal_id=?').get(proposalId);
    if (!row) fail('MATERIAL_SEMANTIC_NOT_READY', '此语义提案尚未形成持久加工记录。');
    const recordJson = String(row!.record_json);
    if (sha(recordJson) !== row!.record_digest) fail('MATERIAL_SEMANTIC_RECORD_CHANGED', '语义加工记录摘要不一致。');
    const record = JSON.parse(recordJson) as MaterialSemanticRecord;
    const binding = this.binding(record.envelope.serviceTaskId);
    if (binding.proposalId !== proposalId || record.envelope.proposalId !== proposalId || record.envelope.materialId !== binding.proposal.materialId
      || record.envelope.originalSha256 !== binding.proposal.originalSha256 || digestOperationArgs(record.proposal) !== digestOperationArgs(binding.proposal)
      || digestOperationArgs(record.origin) !== digestOperationArgs(binding.origin)) fail('MATERIAL_SEMANTIC_RECORD_CHANGED', '语义记录与冻结输入身份不一致。');
    if (this.options.materials.readOriginal(record.envelope.materialId).sha256 !== record.envelope.originalSha256) fail('MATERIAL_SEMANTIC_ORIGINAL_CHANGED', '语义记录原件摘要已变化。');
    return structuredClone(record);
  }

  getByTask(taskId: string): MaterialSemanticRecord | null {
    this.getTask(taskId);
    const row = this.db.prepare('SELECT i.proposal_id FROM material_semantic_inputs i JOIN material_semantic_records r ON r.proposal_id=i.proposal_id WHERE i.task_id=?').get(taskId);
    return row ? this.get(String(row.proposal_id)) : null;
  }

  list(materialId?: string, limit = 50): MaterialSemanticRecord[] {
    if (materialId !== undefined) validId(materialId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('INVALID_MATERIAL_LIMIT', '语义列表上限须在 1 到 200 之间。');
    const rows = materialId === undefined
      ? this.db.prepare('SELECT i.proposal_id FROM material_semantic_inputs i JOIN material_semantic_records r ON r.proposal_id=i.proposal_id ORDER BY i.created_at DESC,i.proposal_id LIMIT ?').all(limit)
      : this.db.prepare('SELECT i.proposal_id FROM material_semantic_inputs i JOIN material_semantic_records r ON r.proposal_id=i.proposal_id WHERE i.material_id=? ORDER BY i.created_at DESC,i.proposal_id LIMIT ?').all(materialId, limit);
    return rows.map(row => this.get(String(row.proposal_id)));
  }

  modelPreview(proposalId: string): JsonValue {
    const record = this.get(proposalId), result = record.result;
    const small = (value: unknown) => typeof value === 'string' ? value.slice(0, 240) : value;
    const preview = asJson({ proposalId, materialId: record.envelope.materialId, serviceTaskId: record.envelope.serviceTaskId,
      status: result.status, applied: result.applied, knownValues: result.adoptedKnown.slice(0, 20).map(j => ({ key: j.key, scope: j.scope, value: small(j.value) })),
      classification: result.classification ? { ...result.classification, reason: small(result.classification.reason),
        ...result.classification.source === 'model-proposal' ? { evidenceValidation: 'quotes_checked' } : {} } : null,
      proposedValues: record.proposal.judgments.filter(j => j.status === 'known').slice(0, 20).map(j => ({ key: j.key, scope: j.scope, value: small(j.value),
        source: 'model-proposal', evidenceValidation: 'quotes_checked' })),
      unresolved: record.proposal.judgments.filter(j => j.status !== 'known').slice(0, 20).map(j => ({ id: j.id, key: j.key, scope: j.scope, status: j.status })),
      questions: result.questions.slice(0, 8).map(q => ({ id: q.id, prompt: q.prompt.slice(0, 300), judgmentIds: q.judgmentIds?.slice(0, 4) })),
      totalQuestions: result.questions.length,
      rowCount: result.table?.totalRows ?? 0, columns: result.table?.columns.slice(0, 16).map(c => small(c.applied)) ?? [],
      rows: result.table?.rows.slice(0, 8).map(row => row.slice(0, 16).map(c => small(c.applied))) ?? [],
      changes: result.changes.slice(0, 8).map(c => ({ operation: c.operation, original: small(c.original), applied: small(c.applied), location: c.location })),
      totalChanges: result.changes.length, limitations: result.limitations, persistence: 'not_requested', originalPreserved: true, previewTruncated: false }) as Record<string, JsonValue>;
    // 完整本地记录保留；同一模型仅得到有界摘要，避免大表耗尽会话上下文。
    for (const key of ['rows', 'changes', 'proposedValues', 'knownValues', 'columns', 'unresolved', 'questions']) {
      const items = preview[key] as JsonValue[];
      while (items.length && Buffer.byteLength(JSON.stringify(preview), 'utf8') > 12_000) { items.pop(); preview.previewTruncated = true; }
    }
    return preview;
  }

  resume(taskId: string, expectedVersion: number): TaskRecord {
    const task = this.getTask(taskId); this.assertBinding(task); this.assertDispatch();
    if (task.version !== expectedVersion) throw new TaskError('TASK_VERSION_CONFLICT', '任务已变化，请按当前版本明确继续。');
    if (task.status === 'succeeded') return task;
    if (task.status === 'needs_review' || task.requiresReview) throw new TaskError('UNKNOWN_RESULT', '语义加工结果待核对，不能自动重放。');
    if (task.status === 'ready') return this.tasks.start(task.id, task.version);
    if (task.status === 'paused' || task.status === 'interrupted') return this.tasks.resume(task.id, task.version);
    if (task.status === 'failed' || task.status === 'cancelled') return this.tasks.retry(task.id, task.version);
    throw new TaskError('TASK_BUSY', '语义加工任务尚未收束。');
  }

  readonly runtime: TaskRuntime = { id: MATERIAL_SEMANTIC_RUNTIME, execute: async context => {
    try {
      this.assertBinding(context.task); this.assertActive(context);
      const binding = this.binding(context.task.id), existing = this.getByTask(context.task.id);
      if (existing) return taskResult(existing);
      await context.emit({ type: 'progress', message: '正在核对语义证据并运行受控材料规则。' });
      this.assertActive(context);
      this.validateSupersession(binding.proposal, binding.origin);
      const material = this.options.materials.get(binding.proposal.materialId), original = this.options.materials.readOriginal(binding.proposal.materialId);
      if (original.sha256 !== binding.proposal.originalSha256) fail('MATERIAL_SEMANTIC_ORIGINAL_CHANGED', '执行前原件摘要核对失败。');
      const record: MaterialSemanticRecord = {
        envelope: { proposalId: binding.proposalId, serviceTaskId: context.task.id, materialId: binding.proposal.materialId,
          originalSha256: original.sha256, proposalVersion: binding.proposal.proposalVersion, rulesVersion: binding.proposal.rulesVersion,
          processorVersion: MATERIAL_SEMANTIC_PROCESSOR_VERSION, createdAt: Date.now(), localOnly: true },
        proposal: binding.proposal, origin: binding.origin, result: this.process(binding, material, original.bytes),
      };
      const recordJson = JSON.stringify(record);
      this.options.database.transaction(() => {
        this.assertActive(context);
        this.db.prepare('INSERT INTO material_semantic_records VALUES(?,?,?)').run(binding.proposalId, recordJson, sha(recordJson));
      });
      await context.emit({ type: 'checkpoint', checkpoint: { proposalId: binding.proposalId, materialId: binding.proposal.materialId, status: record.result.status, applied: record.result.applied } });
      return taskResult(record);
    } catch (error) {
      if (error instanceof MaterialError) throw new TaskError(error.code, error.message);
      throw error;
    }
  } };

  private process(binding: Binding, material: MaterialRecord, bytes: Buffer): MaterialSemanticRecord['result'] {
    const { proposal } = binding;
    const base: MaterialSemanticRecord['result'] = { status: 'needs_confirmation', applied: false, adoptedKnown: [], questions: [], table: null,
      classification: classificationFor(material.envelope.category, proposal),
      changes: [], originalPreserved: true, formalIngest: false, computationRegistered: false,
      limitations: ['仅完成本地受控加工；未正式入库、未注册或执行上传工具。', '语义依据由同一会话提出，本地只核引用与规则，未独立验证金融含义或方法有效性。'] };
    if (material.preview.support !== 'supported') return { ...base, status: material.preview.support, limitations: [...base.limitations, material.preview.reason] };
    if (base.classification.category === 'unclassified') return { ...base, status: 'candidates_saved', limitations: [...base.limitations, '原件用途仍待当前会话代理判断，未按数据或工具执行加工。'] };
    if (base.classification.category === 'tool') return { ...base, status: 'candidates_saved', limitations: [...base.limitations, '方法、参数、依赖和版本仅保存候选与来源。'] };
    if (!['csv', 'json-table'].includes(material.preview.format)) return { ...base, status: 'needs_adapter', limitations: [...base.limitations, '数据正文尚无明确表格适配器，原件已保留。'] };
    const questions = unresolvedQuestions(proposal);
    if (questions.length) return { ...base, questions };
    const text = decodeForEvidence(bytes, this.limits);
    if (text === null) fail('INVALID_UTF8', '表格原件不是有效 UTF-8 文本。');
    const table = parseSemanticMaterialTable(text!, material.preview.format, proposal, this.limits);
    for (const judgment of proposal.judgments) if (judgment.status === 'unknown') {
      const scope = semanticScope(judgment.scope);
      const required = (judgment.key === 'dateFormat' && proposal.cleaning.dates.some(rule => overlappingScope(scope, `column:${rule.column}`)))
        || (judgment.key === 'decimalFormat' && proposal.cleaning.decimals.some(rule => overlappingScope(scope, `column:${rule.column}`)))
        || (judgment.key === 'field' && proposal.table?.fields.some(field => overlappingScope(scope, `column:${field.column}`)
          && field.name !== (proposal.cleaning.trim ? table.columns[field.column - 1]!.name.trim() : table.columns[field.column - 1]!.name)));
      if (required) questions.push({ id: `required:${judgment.id}`, prompt: `实际转换依赖的 ${judgment.key} 尚未确定，请先明确其含义。`, judgmentIds: [judgment.id] });
    }
    const changedColumns = new Set<number>();
    if (proposal.cleaning.trim || proposal.cleaning.emptyToNull) for (let i = 1; i <= table.columns.length; i++) changedColumns.add(i);
    for (const item of [...proposal.cleaning.dates, ...proposal.cleaning.decimals, ...(proposal.table?.fields ?? [])]) changedColumns.add(item.column);
    for (const judgment of proposal.judgments) if (judgment.status === 'conflict' && affectsColumns(judgment.scope, changedColumns)) {
      questions.push({ id: `conflict:${judgment.id}`, prompt: `请明确 ${judgment.key}${judgment.scope ? `（${judgment.scope}）` : ''} 的冲突值，再继续相关清洗。`, judgmentIds: [judgment.id] });
    }
    const groups = new Map<string, { id: string; value: string }[]>();
    for (const j of proposal.judgments) if (j.status === 'known') {
      const key = `${j.key}:${j.scope ?? ''}`, group = groups.get(key) ?? []; group.push({ id: j.id, value: j.value! }); groups.set(key, group);
    }
    for (const group of groups.values()) if (new Set(group.map(j => j.value)).size > 1) questions.push({ id: `values:${group[0]!.id}`, prompt: '同一语义范围出现不同 known 值，请确认唯一含义。', judgmentIds: group.map(j => j.id) });
    for (const rule of proposal.cleaning.dates) if (!rule.evidence.some(e => e.quote.includes(rule.format))) {
      questions.push({ id: `date-format:${rule.column}`, prompt: `请明确第 ${rule.column} 列日期格式（${rule.format}），不能仅凭日期样例猜测。` });
    }
    if (questions.length) return { ...base, questions };
    const cleaned = applySemanticTableCleaning(table, proposal, this.limits);
    if (cleaned.questions.length) return { ...base, questions: cleaned.questions };
    return { ...base, status: 'processed', applied: true, adoptedKnown: proposal.judgments.filter(j => j.status === 'known'),
      table: cleaned.table, changes: cleaned.changes };
  }

  private validateSupersession(proposal: MaterialSemanticProposal, origin: TrustedMaterialOrigin): void {
    // 已保存的待确认语义是依据；模型自报的旧提案和判断编号不决定是否需要确认。
    const rows = this.db.prepare('SELECT i.proposal_id FROM material_semantic_inputs i JOIN material_semantic_records r ON r.proposal_id=i.proposal_id WHERE i.material_id=? ORDER BY i.rowid').all(proposal.materialId);
    const history = rows.map(row => this.get(String(row.proposal_id))).filter(record => record.origin.conversationId === origin.conversationId && record.origin.branchId === origin.branchId);
    const records = new Map(history.map(record => [record.envelope.proposalId, record]));
    const reference = (id: string) => {
      const record = records.get(id) ?? this.get(id);
      if (record.envelope.materialId !== proposal.materialId || record.envelope.originalSha256 !== proposal.originalSha256
        || record.origin.conversationId !== origin.conversationId || record.origin.branchId !== origin.branchId) fail('MATERIAL_CONFIRMATION_SOURCE', '确认只能承接同一会话分支、同一材料的旧提案。');
      return record;
    };
    if (proposal.supersedesProposalId) reference(proposal.supersedesProposalId);
    const confirmations = (proposal.confirmations ?? []).map(confirmation => {
      const id = confirmation.proposalId ?? proposal.supersedesProposalId;
      if (!id) fail('MATERIAL_CONFIRMATION_SOURCE', '确认必须引用已有待确认提案，不能自造确认问题。');
      const previous = reference(id!), question = previous.result.questions.find(q => q.id === confirmation.questionId);
      if (!question || previous.origin.userMessages.some(message => message.id === confirmation.evidence.messageId)) fail('MATERIAL_CONFIRMATION_SOURCE', '确认必须引用旧问题及该提案之后实际收到的新用户回复。');
      return { confirmation, dimensions: questionDimensions(previous, question!) };
    });
    let pending: PendingRequirement[] = [];
    for (const record of history) {
      if (record.result.applied) for (const confirmation of record.proposal.confirmations ?? []) {
        const previous = records.get(confirmation.proposalId ?? record.proposal.supersedesProposalId ?? ''), question = previous?.result.questions.find(q => q.id === confirmation.questionId);
        if (!previous || !question) continue;
        const dimensions = questionDimensions(previous, question);
        pending = pending.filter(requirement => !(dimensions.some(d => sameDimension(d, requirement.dimension))
          && !requirement.record.origin.userMessages.some(message => message.id === confirmation.evidence.messageId)
          && resolutionEvidence(record.proposal, requirement.dimension).some(e => usesReply(e, confirmation.evidence))));
      }
      if (record.result.status === 'needs_confirmation') for (const question of record.result.questions) {
        for (const dimension of questionDimensions(record, question)) pending.push({ record, question, dimension });
      }
    }
    for (const requirement of pending) if (dependsOnDimension(proposal, requirement.dimension)) {
      const confirmed = confirmations.some(({ confirmation, dimensions }) => dimensions.some(d => sameDimension(d, requirement.dimension))
        && !requirement.record.origin.userMessages.some(message => message.id === confirmation.evidence.messageId)
        && resolutionEvidence(proposal, requirement.dimension).some(e => usesReply(e, confirmation.evidence)));
      if (!confirmed) fail('MATERIAL_CONFIRMATION_REQUIRED', `此前 ${requirement.dimension.key}（${requirement.dimension.scope}）仍待确认；须引用提案 ${requirement.record.envelope.proposalId} 的问题 ${requirement.question.id} 及实际新用户回复，不能靠新请求或更换判断编号继续相关解释。`);
    }
  }
  private binding(taskId: string): Binding {
    const row = this.db.prepare('SELECT binding_json,binding_digest FROM material_semantic_inputs WHERE task_id=?').get(taskId);
    if (!row) fail('MATERIAL_SEMANTIC_TASK_NOT_FOUND', '没有此材料语义任务输入。');
    const binding = JSON.parse(String(row!.binding_json)) as Binding;
    if (digestOperationArgs(binding) !== row!.binding_digest) fail('MATERIAL_SEMANTIC_INPUT_CHANGED', '冻结语义输入摘要已变化。');
    return binding;
  }
  private getTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (task.runtimeId !== MATERIAL_SEMANTIC_RUNTIME || task.ownerRole !== 'service') fail('MATERIAL_SEMANTIC_TASK_NOT_FOUND', '此任务不属于材料语义服务。');
    return task;
  }
  private assertBinding(task: TaskRecord): void {
    if (task.action !== MATERIAL_SEMANTIC_OPERATION) fail('MATERIAL_SEMANTIC_OPERATION_DISABLED', '语义运行时仅支持有限材料加工。');
    for (const [key, value] of Object.entries(this.versionBinding)) if (task.versions[key] !== value) fail('MATERIAL_SEMANTIC_VERSION_CONFLICT', '语义任务规则或配置已变化，不能静默用新版继续。');
    const binding = this.binding(task.id);
    const expected = { proposalId: binding.proposalId, materialId: binding.proposal.materialId, originalSha256: binding.proposal.originalSha256, bindingDigest: digestOperationArgs(binding) };
    if (digestOperationArgs(task.args) !== digestOperationArgs(expected) || task.versions.originalSha256 !== binding.proposal.originalSha256) fail('MATERIAL_SEMANTIC_INPUT_CHANGED', '任务参数与冻结语义输入不一致。');
  }
  private assertDispatch(): void { if (this.tasks.getControl().stopped) throw new TaskError('BD_STOPPED', '服务已停止，不接受新的语义加工任务。'); }
  private assertActive(context: TaskExecutionContext): void {
    context.signal.throwIfAborted(); this.assertDispatch();
    const task = this.tasks.get(context.task.id);
    if (!this.tasks.isRunActive(context.runId, context.generation) || task.currentAttemptId !== context.attemptId || task.runtimeId !== MATERIAL_SEMANTIC_RUNTIME) throw new TaskError('TASK_NOT_ACTIVE', '当前运行已不再拥有语义任务，未写入迟到结果。');
  }
}

interface JsonSchema { type?: string; const?: unknown; enum?: unknown[]; oneOf?: JsonSchema[]; required?: string[]; additionalProperties?: boolean; properties?: Record<string, JsonSchema>; items?: JsonSchema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; pattern?: string }
const MAX_VALIDATION_ISSUES = 4;
export interface MaterialSemanticValidationIssue { path: string; reason: string }
export class MaterialSemanticError extends MaterialError {
  readonly validationIssues: readonly MaterialSemanticValidationIssue[];
  constructor(code: string, issues: readonly MaterialSemanticValidationIssue[]) {
    super(code, '提案字段不符合材料提案契约。');
    const bounded = issues.slice(0, MAX_VALIDATION_ISSUES);
    this.validationIssues = Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 1_000 ? bounded : [];
  }
}
function addIssue(issues: MaterialSemanticValidationIssue[], path: string, reason: string): void {
  const shape = path.replace(/\[\d+\]/gu, '[]');
  if (issues.length < MAX_VALIDATION_ISSUES && !issues.some(issue => issue.path.replace(/\[\d+\]/gu, '[]') === shape && issue.reason === reason)) {
    issues.push({ path, reason });
  }
}
function collectSchemaIssues(value: unknown, schema: JsonSchema, path: string, issues: MaterialSemanticValidationIssue[]): void {
  if (issues.length >= MAX_VALIDATION_ISSUES) return;
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(choice => {
      const candidate: MaterialSemanticValidationIssue[] = [];
      collectSchemaIssues(value, choice, path, candidate);
      return candidate.length === 0;
    }).length;
    if (matches !== 1) addIssue(issues, path, '证据类型不符合合同；请核对 source 和必需字段。');
    return;
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) { addIssue(issues, path, '固定版本值不符合合同。'); return; }
  if (schema.enum && !schema.enum.includes(value)) { addIssue(issues, path, '取值不在合同允许范围内。'); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { addIssue(issues, path, '须为对象。'); return; }
    const object = value as Record<string, unknown>;
    if (schema.additionalProperties === false) for (const key of Object.keys(object)) if (!Object.hasOwn(schema.properties ?? {}, key)) {
      // 只把受信合同中已有的字段名放入路径；其他模型自造键绝不回显。
      if (path === 'proposal' && key === 'requiredJudgmentIds') addIssue(issues, 'proposal.requiredJudgmentIds', '此字段只允许放在 cleaning.requiredJudgmentIds。');
      else addIssue(issues, path, '存在合同未允许的额外字段；请删除。');
    }
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) addIssue(issues, `${path}.${key}`, '缺少必需字段。');
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(object, key)) {
      collectSchemaIssues(object[key], child, `${path}.${key}`, issues);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) { addIssue(issues, path, '须为数组。'); return; }
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) {
      addIssue(issues, path, '数组项目数量不符合合同。'); return;
    }
    for (const [index, item] of value.entries()) collectSchemaIssues(item, schema.items ?? {}, `${path}[${index}]`, issues);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)
      || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))) addIssue(issues, path, '须为符合合同长度和格式的字符串。');
  } else if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) addIssue(issues, path, '须为合同范围内的整数。');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') addIssue(issues, path, '须为布尔值。');
}
function checkSchema(value: unknown, schema: JsonSchema, path = 'proposal'): void {
  const issues: MaterialSemanticValidationIssue[] = [];
  collectSchemaIssues(value, schema, path, issues);
  if (issues.length) throw new MaterialSemanticError('INVALID_MATERIAL_SEMANTIC_PROPOSAL', issues);
}
function cloneProposal(input: unknown): MaterialSemanticProposal {
  const issues: MaterialSemanticValidationIssue[] = [];
  collectSchemaIssues(input, SEMANTIC_PROPOSAL_SCHEMA as JsonSchema, 'proposal', issues);
  const schemaInvalid = issues.length > 0;
  let unknownValue = false;
  if (input && typeof input === 'object' && !Array.isArray(input) && Array.isArray((input as {judgments?:unknown}).judgments)) {
    for (const [index, judgment] of (input as {judgments:unknown[]}).judgments.entries()) {
      if (!judgment || typeof judgment !== 'object' || Array.isArray(judgment)) continue;
      const item = judgment as Record<string, unknown>, path = `proposal.judgments[${index}]`;
      if (item.status === 'known') {
        if (typeof item.value !== 'string' || !item.value.trim()) addIssue(issues, `${path}.value`, 'known 须有非空 value。');
        if (Array.isArray(item.evidence) && !item.evidence.length) addIssue(issues, `${path}.evidence`, 'known 须有原件或真实用户消息证据。');
      } else if ((item.status === 'unknown' || item.status === 'conflict') && item.value !== undefined) {
        addIssue(issues, `${path}.value`, 'unknown/conflict 不能携带已确定 value；保留 status 并给 evidence 数组。'); unknownValue = true;
      }
    }
  }
  if (issues.length) throw new MaterialSemanticError(schemaInvalid || unknownValue
    ? 'INVALID_MATERIAL_SEMANTIC_PROPOSAL' : 'MATERIAL_KNOWN_WITHOUT_EVIDENCE', issues);
  if (JSON.stringify(input).length > 100_000) fail('MATERIAL_PROPOSAL_BUDGET', '语义提案超过字符预算。');
  const proposal = structuredClone(input) as MaterialSemanticProposal, ids = new Set<string>();
  validId(proposal.materialId);
  if (proposal.supersedesProposalId) validId(proposal.supersedesProposalId);
  if (proposal.classification && !proposal.classification.reason.trim()) fail('INVALID_MATERIAL_SEMANTIC_PROPOSAL', '材料用途判断须提供非空理由。');
  for (const j of proposal.judgments) {
    validId(j.id);
    if (ids.has(j.id)) fail('INVALID_MATERIAL_SEMANTIC_PROPOSAL', '语义判断编号重复。'); ids.add(j.id);
  }
  for (const id of proposal.cleaning.requiredJudgmentIds ?? []) if (!ids.has(id)) fail('INVALID_MATERIAL_SEMANTIC_PROPOSAL', '清洗规则引用不存在的语义判断。');
  for (const items of [proposal.table?.fields ?? [], proposal.cleaning.dates, proposal.cleaning.decimals]) {
    if (new Set(items.map(item => item.column)).size !== items.length) fail('INVALID_MATERIAL_SEMANTIC_PROPOSAL', '同一字段不能重复提交同类规则。');
  }
  if (proposal.cleaning.dates.some(date => proposal.cleaning.decimals.some(decimal => decimal.column === date.column))) fail('INVALID_MATERIAL_SEMANTIC_PROPOSAL', '同一字段不能同时按日期和十进制解释。');
  const questionIds = new Set<string>();
  for (const question of proposal.questions ?? []) {
    validId(question.id);
    if (questionIds.has(question.id) || question.judgmentIds?.some(id => !ids.has(id))) fail('INVALID_MATERIAL_SEMANTIC_PROPOSAL', '问题编号重复或引用不存在的判断。'); questionIds.add(question.id);
  }
  return proposal;
}
function classificationFor(category: MaterialCategory, proposal: MaterialSemanticProposal): MaterialSemanticRecord['result']['classification'] {
  if (category !== 'unclassified' && proposal.classification && proposal.classification.category !== category) {
    fail('MATERIAL_CATEGORY_CHANGED', '提案不能改变已固定的材料接收类别；原件身份保持不变。');
  }
  if (proposal.classification) return { category: proposal.classification.category, source: 'model-proposal', reason: proposal.classification.reason };
  return { category, source: category === 'unclassified' ? 'pending' : 'intake-category',
    reason: category === 'unclassified' ? '统一入口只接收原件，用途尚未判断。' : '沿用原件受理时固定的类别；此类别不构成语义声明。' };
}
function validateOrigin(input: TrustedMaterialOrigin): TrustedMaterialOrigin {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_MATERIAL_TRUSTED_ORIGIN', '语义来源必须由受信宿主注入。');
  const origin = structuredClone(input);
  for (const key of ['provider', 'model'] as const) if (typeof origin[key] !== 'string' || !origin[key].trim() || origin[key].length > 200 || /[\u0000-\u001f\u007f]/u.test(origin[key])) fail('INVALID_MATERIAL_TRUSTED_ORIGIN', '受信供应方或模型名称无效。');
  for (const key of ['conversationId', 'branchId', 'parentRunId', 'inputId', 'messageId', 'toolCallId', 'callId', 'localBridgeTaskId'] as const) validId(origin[key]);
  if (!/^[a-f0-9]{64}$/u.test(origin.modelDigest) || !/^[a-f0-9]{64}$/u.test(origin.endpointDigest)
    || !Number.isSafeInteger(origin.parentGeneration) || origin.parentGeneration < 0) fail('INVALID_MATERIAL_TRUSTED_ORIGIN', '受信模型摘要或运行代次无效。');
  if (!Array.isArray(origin.userMessages) || origin.userMessages.length > 200 || JSON.stringify(origin.userMessages).length > 300_000) fail('MATERIAL_USER_MESSAGE_BUDGET', '真实用户消息证据超过预算。');
  const ids = new Set<string>();
  for (const message of origin.userMessages) {
    validId(message.id);
    if (typeof message.text !== 'string' || ids.has(message.id)) fail('INVALID_MATERIAL_TRUSTED_ORIGIN', '真实用户消息编号重复或正文无效。'); ids.add(message.id);
  }
  if (origin.adoption?.kind === 'authorized-rule') {
    const adoption = origin.adoption; validId(adoption.requestMessageId); validId(adoption.operationId);
    if (!ids.has(adoption.requestMessageId) || !/^[a-f0-9]{64}$/u.test(adoption.argsDigest)) fail('INVALID_MATERIAL_ADOPTION', '规则采用须绑定真实请求消息和已授权动作摘要。');
    if (adoption.approvalId) validId(adoption.approvalId);
    if (adoption.grantIds !== undefined && (!Array.isArray(adoption.grantIds) || adoption.grantIds.length > 100)) fail('INVALID_MATERIAL_ADOPTION', '规则授权编号无效。');
    for (const grantId of adoption.grantIds ?? []) validId(grantId);
    const automatic = adoption.authorization;
    if (automatic) {
      if (!Number.isSafeInteger(automatic.policyVersion) || automatic.policyVersion < 1 || automatic.approvalId !== null
        || !Array.isArray(automatic.grantIds) || automatic.grantIds.length || automatic.operation?.approvalMode !== 'automatic'
        || automatic.operation.operationId !== adoption.operationId || automatic.operation.argsDigest !== adoption.argsDigest
        || !Number.isSafeInteger(automatic.operation.generation) || automatic.operation.generation < 1) fail('INVALID_MATERIAL_ADOPTION', '自动采用须保留与本次动作一致的真实权限回执。');
      validId(automatic.operation.runId); validId(automatic.operation.attemptId);
    }
    if (!adoption.approvalId && !adoption.grantIds?.length && !automatic) fail('INVALID_MATERIAL_ADOPTION', '缺少实际权限回执，不能伪造已授权采用。');
  } else if (origin.adoption?.kind !== 'user-confirmation') fail('INVALID_MATERIAL_ADOPTION', '语义规则采用来源无效。');
  return origin;
}
function decodeForEvidence(bytes: Uint8Array, limits: MaterialLimits, allowOpaque = false): string | null {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
  if (text.length > limits.maxCharacters) { if (allowOpaque) return null; fail('MATERIAL_CHARACTER_BUDGET', '原件解码文本超过语义加工预算。'); }
  return text;
}
function resolveAllEvidence(proposal: MaterialSemanticProposal, origin: TrustedMaterialOrigin, text: string | null): void {
  const locators = new Map<string, ReturnType<typeof locator>>();
  const resolve = (evidence: SemanticEvidence) => {
    checkSchema(evidence, { oneOf: [SEMANTIC_PROPOSAL_SCHEMA.properties.table.properties.headerEvidence,
      SEMANTIC_PROPOSAL_SCHEMA.properties.confirmations.items.properties.evidence] } as JsonSchema);
    const source = evidence.source === 'original' ? text : origin.userMessages.find(m => m.id === evidence.messageId)?.text;
    if (source === undefined || source === null) fail('MATERIAL_EVIDENCE_SOURCE', '引用来源不是已冻结原件或宿主实际收到的用户消息。');
    let start = evidence.start, end = evidence.end;
    if (start === undefined && end === undefined) {
      start = source!.indexOf(evidence.quote);
      if (start < 0) fail('MATERIAL_EVIDENCE_MISMATCH', '证据原句与指定原文不符。');
      if (source!.indexOf(evidence.quote, start + 1) >= 0) fail('MATERIAL_EVIDENCE_AMBIGUOUS', '证据原句重复，须提供准确 start/end。');
      end = start + evidence.quote.length;
    } else if (start === undefined || end === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || end > source!.length || source!.slice(start, end) !== evidence.quote) fail('MATERIAL_EVIDENCE_MISMATCH', '证据精确偏移或原句不符，未自动修正。');
    const locate = locators.get(source!) ?? locator(source!); locators.set(source!, locate);
    const location = locate(start!, end!);
    if ((evidence.line !== undefined && evidence.line !== location.line) || (evidence.column !== undefined && evidence.column !== location.column)) fail('MATERIAL_EVIDENCE_MISMATCH', '证据行列与原文偏移不符。');
    Object.assign(evidence, location);
  };
  for (const j of proposal.judgments) j.evidence.forEach(resolve);
  proposal.classification?.evidence.forEach(resolve);
  if (proposal.table) { resolve(proposal.table.headerEvidence); proposal.table.fields.forEach(field => field.evidence.forEach(resolve)); }
  for (const rule of [...proposal.cleaning.dates, ...proposal.cleaning.decimals]) rule.evidence.forEach(resolve);
  for (const confirmation of proposal.confirmations ?? []) resolve(confirmation.evidence);
  if (origin.adoption.kind === 'user-confirmation') resolve(origin.adoption.evidence);
}
function unresolvedQuestions(proposal: MaterialSemanticProposal): SemanticQuestion[] {
  const questions = structuredClone(proposal.questions ?? []);
  for (const id of proposal.cleaning.requiredJudgmentIds ?? []) {
    const judgment = proposal.judgments.find(j => j.id === id)!;
    if (judgment.status !== 'known') questions.push({ id: `required:${id}`, prompt: `清洗依赖的 ${judgment.key} 尚未确定，请提供明确声明。`, judgmentIds: [id] });
  }
  return questions;
}
function semanticScope(scope: string | undefined): string {
  const column = /^column:(\d+)$/u.exec(scope ?? '');
  return column && Number(column[1]) >= 1 && Number(column[1]) <= 64 ? `column:${Number(column[1])}` : 'material';
}
function sameDimension(a: SemanticDimension, b: SemanticDimension): boolean { return a.key === b.key && a.scope === b.scope; }
function overlappingScope(a: string, b: string): boolean { return a === 'material' || b === 'material' || a === b; }
function questionDimensions(record: MaterialSemanticRecord, question: SemanticQuestion): SemanticDimension[] {
  let dimensions: SemanticDimension[] = (question.judgmentIds ?? []).flatMap(id => {
    const judgment = record.proposal.judgments.find(item => item.id === id);
    return judgment ? [{ key: judgment.key, scope: semanticScope(judgment.scope) }] : [];
  });
  const date = /^date-(?:format|value):(\d+)$/u.exec(question.id), decimal = /^decimal-value:(\d+)$/u.exec(question.id);
  if (!dimensions.length && date && record.proposal.cleaning.dates.some(rule => rule.column === Number(date[1]))) dimensions.push({ key: 'dateFormat', scope: `column:${Number(date[1])}` });
  if (!dimensions.length && decimal && record.proposal.cleaning.decimals.some(rule => rule.column === Number(decimal[1]))) dimensions.push({ key: 'decimalFormat', scope: `column:${Number(decimal[1])}` });
  if (!dimensions.length && record.proposal.questions?.some(item => item.id === question.id)) {
    dimensions = record.proposal.judgments.filter(judgment => judgment.status !== 'known').map(judgment => ({ key: judgment.key, scope: semanticScope(judgment.scope) }));
    if (!dimensions.length) dimensions = [...record.proposal.cleaning.dates.map(rule => ({ key: 'dateFormat' as const, scope: `column:${rule.column}` })),
      ...record.proposal.cleaning.decimals.map(rule => ({ key: 'decimalFormat' as const, scope: `column:${rule.column}` }))];
  }
  return [...new Map(dimensions.map(dimension => [`${dimension.key}:${dimension.scope}`, dimension])).values()];
}
function dependsOnDimension(proposal: MaterialSemanticProposal, dimension: SemanticDimension): boolean {
  if (proposal.judgments.some(judgment => judgment.status === 'known' && judgment.key === dimension.key && overlappingScope(semanticScope(judgment.scope), dimension.scope))) return true;
  if ((proposal.cleaning.requiredJudgmentIds ?? []).some(id => proposal.judgments.some(judgment => judgment.id === id && judgment.key === dimension.key && overlappingScope(semanticScope(judgment.scope), dimension.scope)))) return true;
  if (!['field', 'unit', 'currency', 'period', 'adjustment', 'timeAvailability', 'dateFormat', 'decimalFormat'].includes(dimension.key)) return false;
  return [...proposal.cleaning.dates, ...proposal.cleaning.decimals, ...(proposal.table?.fields ?? [])]
    .some(rule => overlappingScope(`column:${rule.column}`, dimension.scope));
}
function resolutionEvidence(proposal: MaterialSemanticProposal, dimension: SemanticDimension): SemanticEvidence[] {
  const evidence = proposal.judgments.filter(judgment => judgment.status === 'known' && sameDimension({ key: judgment.key, scope: semanticScope(judgment.scope) }, dimension)).flatMap(judgment => judgment.evidence);
  if (dimension.key === 'dateFormat') for (const rule of proposal.cleaning.dates) if (dimension.scope === `column:${rule.column}`) evidence.push(...rule.evidence);
  if (dimension.key === 'decimalFormat') for (const rule of proposal.cleaning.decimals) if (dimension.scope === `column:${rule.column}`) evidence.push(...rule.evidence);
  if (dimension.key === 'field') for (const field of proposal.table?.fields ?? []) if (dimension.scope === `column:${field.column}`) evidence.push(...field.evidence);
  return evidence;
}
function usesReply(evidence: SemanticEvidence, reply: SemanticEvidence): boolean {
  return evidence.source === 'user-message' && reply.source === 'user-message' && evidence.messageId === reply.messageId
    && evidence.start !== undefined && evidence.end !== undefined && reply.start !== undefined && reply.end !== undefined
    && evidence.start < reply.end && reply.start < evidence.end;
}
/** 复用材料原解析器与原坐标；调用方仍须先核对原件、提案和已解决的语义依据。 */
function affectsColumns(scope: string | undefined, columns: Set<number>): boolean {
  if (!columns.size) return false;
  if (!scope || scope === 'material') return true;
  const match = /^column:(\d+)$/u.exec(scope);
  return match ? columns.has(Number(match[1])) : true;
}
function taskResult(record: MaterialSemanticRecord): TaskResult {
  return { summary: `材料语义已核对并本地保存（${record.result.status}；实际清洗：${record.result.applied ? '已执行' : '未执行'}）。`, artifactIds: [record.envelope.proposalId],
    data: { proposalId: record.envelope.proposalId, materialId: record.envelope.materialId, originalSha256: record.envelope.originalSha256,
      status: record.result.status, applied: record.result.applied, changeCount: record.result.changes.length, localOnly: true, formalIngest: false, computationRegistered: false } };
}
function validId(value: string): void { if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/u.test(value)) fail('INVALID_MATERIAL_SEMANTIC_ID', '语义入口只接受受控身份，不接受路径或正文。'); }
function requestKey(requestId: string): string { validId(requestId); if (requestId.length > 120) fail('INVALID_MATERIAL_SEMANTIC_ID', '语义请求身份过长。'); return `${MATERIAL_SEMANTIC_OPERATION}:${requestId}`; }
function asJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function sha(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function fail(code: string, message: string): never { throw new MaterialError(code, message); }
