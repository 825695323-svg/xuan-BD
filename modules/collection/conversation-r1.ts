import type { BackendInput } from '../../contracts/backend.js';
import type { JsonValue, TaskRecord, TaskResult } from '../../contracts/task-contracts.js';
import type { R1PrepareInput, R1RequestView, R1SourceDeclaration } from '../../contracts/r1-contracts.js';
import { validR1Authorization } from './r1-source.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { PersonalCore } from '../agent/runtime/core.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';

export const CONVERSATION_R1_VERSION = 'bd.conversation-r1/1';
const ACTIONS = ['data.r1.capabilities', 'data.r1.prepare', 'data.r1.get', 'data.r1.list', 'data.r1.recover', 'data.r1.check'] as const;
const SOURCE_FIELDS = ['source_id', 'provider', 'requested_url', 'requested_at_utc', 'acquired_at_utc', 'usage_scope'] as const;
const MAX_ANCESTORS = 1024;
interface Scope { origin: ModelTaskOrigin; input: BackendInput; messages: Set<string> }
interface Link { request_id: string; conversation_id: string; branch_id: string; message_id: string;
  plan_id: string; output_id: string; local_task_id: string; origin_json: string; created_at: number }
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const text = (key: string, label: string, required = true, maxLength = 160): SkillField => ({ key, label, type: 'text', required, maxLength });

/** Personal access projection only. The companion remains the sole R1 publication/recovery authority. */
export class ConversationR1Bridge {
  readonly registrations: readonly SkillRegistration[];
  constructor(private readonly options: { database: CoreDatabase; core: PersonalCore; files: FileReferenceService;
    companion: WorkspaceServices; origin(taskId: string): ModelTaskOrigin | null }) {
    options.database.migrate('conversation_r1_links', 1, `CREATE TABLE conversation_r1_links (
      request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL, message_id TEXT NOT NULL,
      plan_id TEXT NOT NULL, output_id TEXT NOT NULL, local_task_id TEXT NOT NULL REFERENCES tasks(id),
      origin_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX conversation_r1_scope ON conversation_r1_links(conversation_id,branch_id,created_at);`);
    const registration = (action: string, title: string, description: string, fields: SkillField[]): SkillRegistration => ({
      action, title, description, fields, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      permissionSummary: ['仅当前会话分支及输入祖先的明确选件和真实加工', '原R1请求/连接/任务恢复；不重提', '正式提交必须核冻结文档摘要且要求独立审批；来源与加工证据留在BD，模型不能自授权'],
      available: () => ({ available: !!options.companion.r1Workspace && !!options.companion.processing && !!options.companion.materials }),
    });
    this.registrations = [
      registration(ACTIONS[0], '发现本会话R1交接能力', '读取本输入祖先可用的计划/输出及data_only限制；不实时探测WFD、不提交。后续目标与映射只取原加工计划，来源事实须引用真实用户原话。', []),
      registration(ACTIONS[1], '准备本会话固定R1请求', '只从本分支已明确选件且真实加工的plan/output生成本地冻结文档。sourceJson含六项必需来源原文、可选旧许可文字与authorization的status/basis；sourceEvidenceJson逐字段给{messageId,quote}，授权证据quote须逐字引用本分支真实用户的authorization={"status":"authorized","basis":"具体依据"} JSON声明（可有空白）。必需来源或本次授权缺失、未知不得准备；旧许可文字不决定准入。mapping/target从原计划取得，不接任意行、摘要、权限或连接。相同plan/output复用原请求，改声明须修订计划。准备不是提交；由本机用户另行核摘要确认。', [
        text('planId', '本分支实际计划编号'), text('outputId', '固定输出编号'),
        text('sourceJson', '有真实用户依据的来源声明', true, 32768), text('sourceEvidenceJson', '逐字段用户原文证据', true, 65536),
      ]),
      registration(ACTIONS[2], '读取本会话原R1请求', '只读访问映射所指的原本地回执，不实时探测、不返回原始行/路径/完整谱系；旧请求不切换到新连接。', [text('requestId', '本会话原请求编号')]),
      registration(ACTIONS[3], '分页列出本会话R1请求', '先按会话/分支/输入祖先过滤访问映射，再分页读原本地回执；不读取全局最近请求。', [
        { key: 'offset', label: '本范围页偏移', type: 'number', minimum: 0, maximum: 10000 },
        { key: 'limit', label: '本页请求数', type: 'number', minimum: 1, maximum: 20 },
      ]),
      registration(ACTIONS[4], '按原身份核对R1提交与读回', '只恢复本会话已映射原请求/任务；未知结果不换编号重发；未提交请求返回R1_NOT_SUBMITTED，保持本地准备回执。个人停止仅停止等待/分享，不声称撤销服务事实。', [text('requestId', '本会话原请求编号')]),
      registration(ACTIONS[5], '明确只读核对R1 live profile', '操作者需要时才调用，只读核对当前已登记profile。不会由能力发现、准备或查询自动调用，不授权初始化/提交。', []),
    ];
  }
  handles(action: string): boolean { return (ACTIONS as readonly string[]).includes(action); }
  get versionBinding(): Record<string, unknown> {
    return { bridge: CONVERSATION_R1_VERSION, r1: this.options.companion.r1Workspace?.versionBinding ?? null,
      processing: this.options.companion.processing?.versionBinding ?? null };
  }
  private get db() { return this.options.database.connection; }

  async execute(context: TaskExecutionContext, action: string, args: Record<string, JsonValue>): Promise<TaskResult> {
    if (!this.handles(action)) fail('R1_CONVERSATION_INPUT', '未登记的会话R1动作。');
    this.validateArgs(action, args);
    const origin = this.options.origin(context.task.id);
    if (!origin) fail('R1_CONVERSATION_SCOPE', 'R1工具只接受当前真实会话调用。');
    const port = this.options.companion.r1Workspace;
    if (!port || !this.options.companion.processing || !this.options.companion.materials) fail('R1_CONVERSATION_DISABLED', 'R1伴随服务尚未装配。');
    this.assertDispatch(context);
    const scope = this.scope(origin), authority = await acquireAuthority(context, action, args, [],
      {});
    const assert = () => { authority.assert(); this.assertDispatch(context); this.scope(origin); };
    assert();
    if (action === ACTIONS[0]) return this.result('已读取本会话R1能力；没有探测或提交。', this.capabilities(scope));
    if (action === ACTIONS[5]) {
      await interruptible(port.checkProfile(), context.signal); assert();
      return this.result('已明确只读核对当前R1 profile；没有提交。', { ...this.capabilities(scope), checked: true });
    }
    if (action === ACTIONS[1]) {
      const planId = String(args.planId), outputId = String(args.outputId), output = this.planOutput(scope, planId, outputId);
      const source = this.source(args.sourceJson, args.sourceEvidenceJson, scope);
      const declaration = output.target?.declaration;
      if (!isWfdRecord(declaration) || declaration.protocol !== 'wfd.structured-ingest/1.0'
        || !isWfdRecord(declaration.mapping) || !isWfdRecord(declaration.target)) fail('R1_TARGET_CHANGED', '原计划没有固定R1目标与映射声明。');
      const requestId = 'r1c_' + wfdSha256(canonicalWfdJson({ conversation: origin.conversationId, branch: origin.branchId, plan: planId, output: outputId })).slice(0, 48);
      assert();
      const found = port.prepare({ requestId, planId, outputId, source, mapping: declaration.mapping, target: declaration.target } as unknown as R1PrepareInput);
      this.assertView(found, { request_id: requestId, plan_id: planId, output_id: outputId });
      // Stable host ID permits replay if the companion committed before this separate access-map transaction.
      // This row contains no publication state, authoritative binding, receipt or submit-task copy.
      const prior = this.db.prepare('SELECT * FROM conversation_r1_links WHERE request_id=?').get(requestId) as unknown as Link | undefined;
      if (prior) this.assertLink(prior, scope);
      else this.db.prepare('INSERT INTO conversation_r1_links VALUES(?,?,?,?,?,?,?,?,?)').run(requestId, origin.conversationId,
        origin.branchId, origin.messageId, planId, outputId, context.task.id, JSON.stringify(origin), Date.now());
      assert(); return this.result('已按真实加工冻结原R1请求；未自动提交。', this.requestView(found));
    }
    if (action === ACTIONS[3]) {
      const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 10), links = this.listLinks(scope, offset, limit + 1);
      const requests = links.slice(0, limit).map(link => { this.assertLink(link, scope); const found = port.get(link.request_id); this.assertView(found, link); return this.requestView(found); });
      assert(); return this.result('已按本会话范围读取原请求页；没有实时探测。', { requests, offset,
        nextOffset: links.length > limit ? offset + limit : null, done: links.length <= limit });
    }
    const link = this.ownedLink(String(args.requestId), scope);
    // A local get intentionally reads the frozen receipt, not today's connection. Recovery below rechecks
    // the original binding in R1Workspace; neither path silently substitutes a new default profile.
    if (action === ACTIONS[2]) {
      const found = port.get(link.request_id); this.assertView(found, link); assert();
      return this.result('已读取本会话原本地R1回执；没有重提或实时探测。', this.requestView(found));
    }
    const lookupId = 'r1l_' + wfdSha256(canonicalWfdJson({ request: link.request_id, call: origin.callId })).slice(0, 48);
    assert();
    const task = await interruptible(port.recover(link.request_id, lookupId), context.signal); assert();
    const found = port.get(link.request_id); this.assertView(found, link);
    return this.result('已按原请求核对R1事实；未重新提交。', { ...this.requestView(found), recoveryTaskId: task.id, recoveryTaskStatus: task.status });
  }

  private result(summary: string, value: Record<string, unknown>): TaskResult {
    return { summary, data: { kind: 'conversation-r1', modelPreview: json({ contract: 'conversation-r1/1',
      protocol: 'wfd.structured-ingest/1.0', profile: 'data_only', submitByAgent: 'review_required_with_frozen_digest',
      sourceEvidenceScope: 'verified_user_statement_only', ...value }) } };
  }
  private requestView(found: R1RequestView): Record<string, unknown> {
    const code = found.error?.code;
    return { requestId: found.requestId, state: found.state, datasetId: found.datasetId, outputKey: found.outputKey,
      planId: found.planId, outputId: found.outputId, rowCount: found.rowCount, documentSha256: found.documentSha256,
      submitTaskId: found.submitTaskId, requiresRecovery: found.requiresRecovery,
      errorCode: typeof code === 'string' && /^[A-Z][A-Z0-9_:.-]{0,159}$/u.test(code) ? code : null,
      statusSource: 'local_workspace_receipt' };
  }
  private assertView(found: R1RequestView, link: Pick<Link, 'request_id' | 'plan_id' | 'output_id'>): void {
    if (found.requestId !== link.request_id || found.planId !== link.plan_id || found.outputId !== link.output_id) fail('R1_CONVERSATION_VIEW', '原请求视图与本会话访问映射不一致。');
  }
  private capabilities(scope: Scope): Record<string, unknown> {
    const caps = this.options.companion.r1Workspace!.capabilities();
    const plans: Record<string, unknown>[] = [];
    if (this.hasTable('conversation_processing_links')) {
      const messageIds = [...scope.messages], marks = messageIds.map(() => '?').join(',');
      const safe = "CASE WHEN json_valid(origin_json) THEN origin_json ELSE '{}' END";
      const rows = this.db.prepare(`SELECT ref_id,origin_json FROM conversation_processing_links WHERE kind='plan'
        AND json_extract(${safe},'$.conversationId')=? AND json_extract(${safe},'$.branchId')=?
        AND json_extract(${safe},'$.messageId') IN (${marks}) ORDER BY created_at DESC,rowid DESC LIMIT 10`)
        .all(scope.origin.conversationId, scope.origin.branchId, ...messageIds);
      for (const row of rows) {
        if (!this.savedInScope(String(row.origin_json), scope)) continue;
        const plan = this.options.companion.processing!.get(String(row.ref_id));
        plans.push({ planId: plan.planId, outputs: plan.outputs.map(output => ({ outputId: output.outputId,
          publishEligible: output.publishEligible === true, routingState: output.routingState })) });
      }
    }
    return { configuration: { state: caps.configuration.state }, limits: { ...caps.limits, explicitAttachmentOnly: true,
      maxAncestorMessages: MAX_ANCESTORS, maxListPage: 20 }, automaticSubmit: false, agentSubmit: 'review_required', legacyReplay: false, actions: [...ACTIONS], plans };
  }
  private scope(origin: ModelTaskOrigin): Scope {
    const core = this.options.core;
    if (!core.isRunActive(origin.parentRunId, origin.parentGeneration)) fail('R1_CONVERSATION_SCOPE', '原会话运行已失效。');
    const command = core.store.command(origin.inputId);
    const input: BackendInput = { inputId: origin.inputId, messageId: origin.messageId, conversationId: origin.conversationId,
      branchId: origin.branchId, runId: origin.parentRunId, generation: origin.parentGeneration, text: command.text };
    core.selectedAttachmentsForInput(input); // verifies exact active input, branch, selected refs and current versions.
    const messages = new Set<string>(); let head: string | null = origin.messageId;
    while (head) {
      if (messages.has(head) || messages.size >= MAX_ANCESTORS) fail('R1_CONVERSATION_SCOPE', '本输入祖先链不完整或超过本切片范围。');
      const message = core.store.message(head);
      if (message.conversation_id !== origin.conversationId) fail('R1_CONVERSATION_SCOPE', '原消息不属于本会话。');
      messages.add(head); head = message.parent_id;
    }
    return { origin, input, messages };
  }
  private savedInScope(value: string, scope: Scope): boolean {
    try { const saved: unknown = JSON.parse(value); return isWfdRecord(saved) && saved.conversationId === scope.origin.conversationId
      && saved.branchId === scope.origin.branchId && typeof saved.messageId === 'string' && scope.messages.has(saved.messageId); }
    catch { return false; }
  }
  private planOutput(scope: Scope, planId: string, outputId: string) {
    if (!this.hasTable('conversation_processing_links')) fail('R1_PLAN_ORIGIN', '没有本会话实际加工计划关系。');
    const row = this.db.prepare("SELECT origin_json FROM conversation_processing_links WHERE ref_id=? AND kind='plan'").get(planId);
    if (!row || !this.savedInScope(String(row.origin_json), scope)) fail('R1_PLAN_ORIGIN', '该计划不属于本输入祖先的会话分支。');
    const plan = this.options.companion.processing!.get(planId), output = plan.outputs.find(item => item.outputId === outputId);
    if (!output || output.publishEligible !== true || output.routingState !== 'ready_candidate') fail('R1_PROCESS_NOT_READY', '固定输出没有实际结构化及发布资格。');
    if (output.materialIds.length !== 1) fail('R1_MULTI_SOURCE_UNSUPPORTED', '本片只接单一明确附件的固定输出。');
    const materialId = output.materialIds[0]!;
    if (!this.hasTable('conversation_material_links')) fail('R1_MATERIAL_ORIGIN', '没有本会话附件保管关系。');
    const materialLink = this.db.prepare('SELECT * FROM conversation_material_links WHERE material_id=?').get(materialId);
    if (!materialLink || !this.savedInScope(String(materialLink.origin_json), scope)) fail('R1_MATERIAL_ORIGIN', '原件不属于本输入祖先的会话分支。');
    const selected = this.options.core.selectedAttachmentsForInput(scope.input);
    if (!selected.some(ref => ref.fileRefId === materialLink.file_ref_id && ref.version === materialLink.file_ref_version)) fail('R1_MATERIAL_ORIGIN', '原附件及版本未在本输入祖先明确选择；本片不采用生成件或旁支。');
    const file = this.options.files.verify(String(materialLink.file_ref_id));
    const material = this.options.companion.materials!.get(materialId);
    if (file.version !== materialLink.file_ref_version || material.envelope.sha256 !== materialLink.sha256) fail('R1_MATERIAL_ORIGIN', '原文件版本或保管摘要已变化。');
    return output;
  }
  private source(value: JsonValue | undefined, evidenceValue: JsonValue | undefined, scope: Scope): R1SourceDeclaration {
    const source = parseObject(value), evidence = parseObject(evidenceValue);
    const hasAuthorization = Object.hasOwn(source, 'authorization'), hasLicense = Object.hasOwn(source, 'license');
    const fields: readonly string[] = hasLicense ? [...SOURCE_FIELDS, 'license'] : SOURCE_FIELDS;
    if (Object.keys(source).length !== fields.length + Number(hasAuthorization)
      || Object.keys(evidence).length !== fields.length + Number(hasAuthorization)
      || Object.keys(source).some(key => key !== 'authorization' && !fields.includes(key))
      || Object.keys(evidence).some(key => key !== 'authorization' && !fields.includes(key))) fail('R1_SOURCE_EVIDENCE', '来源原文、授权声明与逐字段用户证据必须对应。');
    for (const field of fields) {
      const literal = source[field], proof = evidence[field];
      if (typeof literal !== 'string' || !literal.trim() || literal.length > 4096 || /[\u0000-\u001f]/u.test(literal)
        || !isWfdRecord(proof) || Object.keys(proof).some(key => !['messageId', 'quote'].includes(key))
        || typeof proof.messageId !== 'string' || typeof proof.quote !== 'string' || !proof.quote || proof.quote.length > 8192
        || !scope.messages.has(proof.messageId)) fail('R1_SOURCE_EVIDENCE', '来源字段缺少本输入祖先的真实用户依据。');
      const message = this.options.core.store.message(proof.messageId);
      if (message.role !== 'user' || message.conversation_id !== scope.origin.conversationId
        || !message.text.includes(proof.quote) || !proof.quote.includes(literal)) fail('R1_SOURCE_EVIDENCE', '来源证据不是包含该值的真实用户原话。');
    }
    if (hasAuthorization) {
      const authorization = source.authorization, proof = evidence.authorization;
      if (!validR1Authorization(authorization) || !isWfdRecord(proof)
        || Object.keys(proof).some(key => !['messageId', 'quote'].includes(key))
        || typeof proof.messageId !== 'string' || typeof proof.quote !== 'string' || !proof.quote || proof.quote.length > 8192
        || !scope.messages.has(proof.messageId)) fail('R1_SOURCE_EVIDENCE', '授权声明缺少当前用户原文依据。');
      const message = this.options.core.store.message(proof.messageId);
      const marker = /authorization\s*=\s*/u.exec(proof.quote);
      let declared: unknown;
      try { declared = marker ? JSON.parse(proof.quote.slice(marker.index + marker[0].length).trim()) : null; }
      catch { declared = null; }
      if (message.role !== 'user' || message.conversation_id !== scope.origin.conversationId
        || !message.text.includes(proof.quote) || !validR1Authorization(declared)
        || canonicalWfdJson(declared) !== canonicalWfdJson(authorization)) {
        fail('R1_SOURCE_EVIDENCE', '授权状态与依据不是同一真实用户原话。');
      }
    }
    return source as unknown as R1SourceDeclaration;
  }
  private ownedLink(requestId: string, scope: Scope): Link {
    const link = this.db.prepare('SELECT * FROM conversation_r1_links WHERE request_id=?').get(requestId) as unknown as Link | undefined;
    if (!link) fail('R1_CONVERSATION_SCOPE', '本会话没有该原R1请求的访问映射。');
    this.assertLink(link, scope); return link;
  }
  private assertLink(link: Link, scope: Scope): void {
    if (link.conversation_id !== scope.origin.conversationId || link.branch_id !== scope.origin.branchId
      || !scope.messages.has(link.message_id) || !this.savedInScope(link.origin_json, scope)) fail('R1_CONVERSATION_SCOPE', '原R1请求不属于本输入祖先的会话分支。');
  }
  private listLinks(scope: Scope, offset: number, limit: number): Link[] {
    const ids = [...scope.messages], marks = ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM conversation_r1_links WHERE conversation_id=? AND branch_id=?
      AND message_id IN (${marks}) ORDER BY created_at DESC,request_id DESC LIMIT ? OFFSET ?`)
      .all(scope.origin.conversationId, scope.origin.branchId, ...ids, limit, offset) as unknown as Link[];
  }
  private hasTable(name: string): boolean { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  private assertDispatch(context: TaskExecutionContext): void {
    context.signal.throwIfAborted();
    if (this.options.companion.tasks.getControl().stopped) fail('SERVICE_STOPPED', '伴随服务已停止新增派发；原事实仍保留。');
  }
  private validateArgs(action: string, args: Record<string, JsonValue>): void {
    const keys = action === ACTIONS[1] ? ['planId', 'outputId', 'sourceJson', 'sourceEvidenceJson']
      : action === ACTIONS[2] || action === ACTIONS[4] ? ['requestId'] : action === ACTIONS[3] ? ['offset', 'limit'] : [];
    if (!isWfdRecord(args) || Object.keys(args).some(key => !keys.includes(key))) fail('R1_CONVERSATION_INPUT', '不接受未声明字段、行、权限、摘要或连接覆盖。');
    if (action === ACTIONS[3]) for (const [key, min, max] of [['offset', 0, 10000], ['limit', 1, 20]] as const) {
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || Number(args[key]) < min || Number(args[key]) > max)) fail('R1_CONVERSATION_INPUT', '请求页范围须为有界整数。');
    }
    else for (const key of keys) if (typeof args[key] !== 'string' || !String(args[key]).trim()
      || String(args[key]).length > (key === 'sourceEvidenceJson' ? 65536 : key === 'sourceJson' ? 32768 : 160)) fail('R1_CONVERSATION_INPUT', '需要完整有界的原身份与来源声明。');
  }
}
function parseObject(value: JsonValue | undefined): WfdRecord {
  if (typeof value !== 'string') fail('R1_CONVERSATION_INPUT', '需要明确JSON对象文本。');
  try { const found: unknown = JSON.parse(value); if (isWfdRecord(found)) return found; } catch { /* fixed input error below */ }
  return fail('R1_CONVERSATION_INPUT', '需要有效且有界的JSON对象。');
}
function fail(code: string, message: string): never { throw new TaskError(code, message); }
async function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new TaskError('R1_CONVERSATION_WAIT_STOPPED', '会话停止等待；原服务任务与事实仍保留。')); signal.addEventListener('abort', abort, { once: true }); });
  try { signal.throwIfAborted(); return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}
