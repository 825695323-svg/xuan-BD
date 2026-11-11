import type { R1CapabilitiesView, R1ConnectionIdentity, R1PrepareInput, R1RequestSummary, R1RequestView, R1RowSummary, R1ScalarMapping } from '../../contracts/r1-contracts.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { assertKnownR1Source, buildStructuredIngestDocument, parseR1Utc, validateStructuredDocument, R1_SETTLED_STATES, type R1HandoffService, type R1LocalReferences, type R1SourceRef, type R1StructuredRequest } from './r1-structured-handoff.js';
import { PROCESSING_PLAN_VERSION, type ProcessingPlanService } from './processing-plan.js';
import type { MaterialService } from './materials/service.js';
import type { R1Runtime } from './r1-runtime.js';
import { checkR1TabularRows, compileR1TabularDeclaration } from './r1-tabular.js';
import { R1ProductReader } from './r1-product-reader.js';
import { publishRestrictionTarget, restrictionEvidenceFromUsageStatus, type PublishRestrictionTarget } from './wfd-publish-restriction.js';
import type { RestrictionEvidence } from './purpose-eligibility.js';

export const R1_WORKSPACE_RUNTIME = 'bd.r1-structured-ingest';
export const R1_WORKSPACE_VERSION = 'bd.r1-workspace/1';
export const R1_WEB_LIMITS = Object.freeze({ maxRows: 5000, maxDocumentBytes: 786432, maxMaterials: 1 as const, payload: 'scalar_rows' as const,
  supportedPayloads: ['scalar_rows', 'tabular_rows'] as const });
const UNKNOWN_STATES = new Set(['sending', 'pending_unknown', 'pending_receipt']);
interface RequestRow { request_id: string; binding_json: string; binding_sha256: string; recipe_sha256: string;
  plan_id: string; output_id: string; submit_task_id: string | null }

/** The host-only bridge never accepts caller rows, processing hashes, runtime roots or namespaces. */
export class R1WorkspaceService {
  private readonly reader: R1ProductReader;
  constructor(private readonly options: { database: CoreDatabase; tasks(): TaskService; handoff: R1HandoffService;
    processing: ProcessingPlanService; materials: MaterialService; runtime?: R1Runtime;
    configuration: { state: string; reason: string | null } }) {
    this.reader = new R1ProductReader({ runtime: () => this.requireRuntime(), control: () => this.tasks.getControl() });
    options.database.migrate('r1-workspace', 1, `CREATE TABLE r1_workspace_requests (
      request_id TEXT PRIMARY KEY REFERENCES r1_handoff_attempts(request_id),
      binding_json TEXT NOT NULL,binding_sha256 TEXT NOT NULL,recipe_sha256 TEXT NOT NULL,
      plan_id TEXT NOT NULL,output_id TEXT NOT NULL,submit_task_id TEXT,created_at INTEGER NOT NULL
    );`);
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }
  /** Implementation identity only; original connection identity stays on the original request. */
  get versionBinding(): Record<string, string | null> {
    return { r1Workspace: R1_WORKSPACE_VERSION, protocol: 'wfd.structured-ingest/1.0', profile: 'data_only' };
  }

  capabilities(): R1CapabilitiesView {
    let connection: R1ConnectionIdentity | null = null, configuration = this.options.configuration;
    if (this.options.runtime) {
      try { connection = this.options.runtime.currentIdentity(); }
      catch (error) { configuration = { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) }; }
    }
    return { protocol: 'wfd.structured-ingest/1.0', profile: 'data_only', configuration, connection,
      limits: R1_WEB_LIMITS, automaticSubmit: false, legacyReplay: false };
  }
  async checkProfile() {
    this.assertDispatch();
    const runtime = this.requireRuntime();
    const identity = canonicalWfdJson(runtime.currentIdentity());
    const generation = this.tasks.getControl().generation;
    const result = await runtime.client.probeProfile(); // explicit read-only check; not called by page load or prepare.
    const control = this.tasks.getControl();
    if (control.stopped || control.generation !== generation) fail('BD_STOPPED', '探测等待期间服务停止代次已变化；本次结果未作为成功返回，请在明确恢复后重新检查。');
    if (canonicalWfdJson(runtime.currentIdentity()) !== identity) fail('R1_CONNECTION_BINDING_CHANGED', '探测等待期间连接身份已变化；未采用旧客户端结果，请核对后重新装配。');
    return result;
  }

  reviewDefinition(intent: import('../../contracts/r1-contracts.js').R1DefinitionIntent, signal?: AbortSignal) {
    return this.reader.reviewDefinition(intent, signal);
  }
  snapshotStatus(signal?: AbortSignal) { return this.reader.snapshotStatus(signal); }
  discoverProducts(value: unknown, signal?: AbortSignal) { return this.reader.discoverProducts(value, signal); }
  readProduct(value: unknown, signal?: AbortSignal) { return this.reader.readProduct(value, signal); }
  readContext(value: unknown, signal?: AbortSignal) { return this.reader.readContext(value, signal); }
  filterObjects(value: unknown, signal?: AbortSignal, contextDigest?: string) { return this.reader.filterObjects(value, signal, contextDigest); }

  prepare(value: unknown): R1RequestView {
    const input = readInput(value), runtime = this.requireRuntime(); this.assertDispatch();
    return this.prepareInternal(input, runtime, null);
  }

  /** 统一异步限制 verifier：prepare 与 auto/Polars 共用同一实际 WFD usage_status 检查。 */
  async prepareWithRestriction(value: unknown): Promise<R1RequestView> {
    const input = readInput(value), runtime = this.requireRuntime(); this.assertDispatch();
    const plan = this.options.processing.get(input.planId);
    const fixedOutput = plan.outputs.find(item => item.outputId === input.outputId);
    const restriction = await this.verifyPublishRestriction(input, fixedOutput, runtime);
    return this.prepareInternal(input, runtime, restriction);
  }

  private async verifyPublishRestriction(input: R1PrepareInput, fixedOutput: { usage?: unknown; target?: unknown } | undefined,
    runtime: ReturnType<R1WorkspaceService['requireRuntime']>): Promise<RestrictionEvidence | null> {
    const usage = fixedOutput && isWfdRecord(fixedOutput.usage) ? fixedOutput.usage : null;
    if (!usage || (usage.purpose !== 'current_publish' && usage.purpose !== 'historical_publish')) return null;
    const target = this.publishRestrictionTarget(input, fixedOutput!);
    let result: unknown;
    try {
      const reply = await runtime.client.usageStatus();
      result = reply.result;
    } catch (error) {
      fail('R1_USAGE_STATUS_UNAVAILABLE', '无法读取 WFD 权威 usage_status；发布准备不得降级为 no_known_issue。' + (error instanceof Error ? ` ${error.message.slice(0, 500)}` : ''));
    }
    return restrictionEvidenceFromUsageStatus(result, target, Date.now());
  }

  private publishRestrictionTarget(input: R1PrepareInput, fixedOutput: { usage?: unknown; target?: unknown }): PublishRestrictionTarget {
    const usage = isWfdRecord((fixedOutput as { usage?: unknown }).usage) ? (fixedOutput as { usage: WfdRecord }).usage : {};
    const target = isWfdRecord(fixedOutput.target) ? fixedOutput.target : {};
    const productRef = isWfdRecord(target.productRef) ? target.productRef : null;
    return publishRestrictionTarget({
      purpose: usage.purpose as 'current_publish' | 'historical_publish',
      expectedSnapshotId: input.target.expectedParentSnapshotId,
      productRef,
      logicalDomain: 'observations',
      subject: input.target.subject as WfdRecord,
      definition: input.target.definition as WfdRecord,
      definitionMode: productRef && typeof productRef.product_id === 'string' ? 'reuse' : 'create',
      recordVersions: [],
    });
  }

  private prepareInternal(input: R1PrepareInput, runtime: ReturnType<R1WorkspaceService['requireRuntime']>,
    restriction: RestrictionEvidence | null): R1RequestView {
    const identity = runtime.currentIdentity();
    const previous = this.row(input.requestId), recipeDigest = wfdSha256(canonicalWfdJson(input));
    if (previous) {
      this.assertBinding(previous);
      if (previous.recipe_sha256 !== recipeDigest) fail('R1_REQUEST_CONFLICT', '原请求的计划、来源或目标已冻结；不能覆盖。');
      return this.get(input.requestId);
    }
    // Pre-workspace/legacy requests are never silently adopted under today's data-only profile.
    if (this.db.prepare('SELECT request_id FROM r1_handoff_attempts WHERE request_id=?').get(input.requestId)) fail('R1_LEGACY_REQUEST', '该请求没有本流程的冻结连接记录；只保留原身份核对，不采用当前 profile 重放。');
    const plan = this.options.processing.get(input.planId), fixedOutput = plan.outputs.find(item => item.outputId === input.outputId);
    if (!fixedOutput || fixedOutput.publishEligible !== true || fixedOutput.routingState !== 'ready_candidate') fail('R1_PROCESS_NOT_READY', '原计划的六维、明确发布用途与目标尚未齐备；结构成功不能替代准入。');
    const tabular = 'kind' in input.mapping && input.mapping.kind === 'tabular_rows';
    const declaration = { protocol: 'wfd.structured-ingest/1.0', target: input.target, mapping: input.mapping,
      ...(tabular ? { source: input.source } : {}) };
    if (canonicalWfdJson(fixedOutput.target?.declaration ?? null) !== canonicalWfdJson(declaration)
      || (fixedOutput.target?.expectedSnapshotId ?? null) !== input.target.expectedParentSnapshotId) fail('R1_TARGET_CHANGED', '目标合同、映射或父快照与加工计划冻结声明不同；请修订计划，不改写旧计划。');
    const output = this.options.processing.candidateOutput(input.planId, input.outputId);
    if (output.materialIds.length !== 1) fail('R1_MULTI_SOURCE_UNSUPPORTED', '当前 Web 切片只支持单材料输出；不把多来源压成 first。');
    const materialId = output.materialIds[0]!, material = this.options.materials.get(materialId);
    const original = this.options.materials.readOriginal(materialId);
    const actual = this.options.processing.outputArtifact(input.planId, input.outputId);
    if (wfdSha256(actual.bytes) !== output.ref.sha256) fail('R1_PROCESS_OUTPUT_MISMATCH', '实际加工对象摘要变化，未准备交接。');
    let parsed: unknown;
    try { parsed = JSON.parse(actual.bytes.toString('utf8')); } catch { fail('R1_PROCESS_OUTPUT_FORMAT', '加工产物不是有效 JSON。'); }
    if (!isWfdRecord(parsed) || !Array.isArray(parsed.rows)) fail('R1_PROCESS_OUTPUT_FORMAT', '加工产物没有真实 rows。');
    const checked = tabular ? checkR1TabularRows(parsed.rows, declaration) : null;
    if (checked && checked.quality !== 'pass') fail('R1_TABULAR_SEMANTICS', checked.gaps.join('；'));
    const rows = checked ? checked.rows : scalarRows(parsed.rows, input.mapping as R1ScalarMapping, input.target.inputMode === 'partial_observation');
    const structured: R1StructuredRequest = { ...input.target, namespace: identity.namespace, producerNamespace: identity.namespace,
      requestId: input.requestId, ...(input.target.inputMode === 'partial_observation' ? { duplicatePolicy: 'skip_identical_append' as const } : {}), submissionDigest: 'sha256:' + '0'.repeat(64), payload: { kind: tabular ? 'tabular_rows' : 'scalar_rows', rows } };
    const unsigned = buildStructuredIngestDocument(structured);
    const digestInput = structuredClone(unsigned);
    delete (digestInput.request_identity as WfdRecord).submission_digest;
    structured.submissionDigest = 'sha256:' + wfdSha256(canonicalWfdJson(digestInput));
    const document = buildStructuredIngestDocument(structured), documentBytes = Buffer.byteLength(canonicalWfdJson(document));
    if (documentBytes > R1_WEB_LIMITS.maxDocumentBytes) fail('R1_WEB_BUDGET', '此 Web 小切片超过文档预算；未截断或放大机器响应预算。');
    if (!validateStructuredDocument(document, runtime.connection.schemaPath).valid) fail('R1_SCHEMA_INVALID', '目标合同或实际产物不符合公开 structured-ingest schema。');
    const source: R1SourceRef = { ...input.source, sha256: original.sha256, bytes: original.bytes.byteLength };
    const acquisition = this.options.handoff.registerOriginal({ bytes: original.bytes, originalName: material.envelope.filename,
      mediaType: material.envelope.mediaType, source });
    const localRefs: R1LocalReferences = { originalIds: [acquisition.originalId], materialIds: [], sourceRefs: [source], contractBindingRequired: true,
      processRefs: [{ process_id: `${input.planId}:${input.outputId}`, plan_id: input.planId, output_id: input.outputId,
        version: PROCESSING_PLAN_VERSION, input_sha256: original.sha256, output_sha256: output.ref.sha256,
        evidence_sha256: output.ref.sha256, document_sha256: wfdSha256(canonicalWfdJson(document)) }],
      evidenceRefs: [{ ref_id: `processing:${input.planId}:${input.outputId}`, content_sha256: output.ref.sha256, kind: 'processing-output' }] };
    const bindingJson = canonicalWfdJson(identity);
    this.options.database.transaction(() => {
      this.options.handoff.prepare({ structured, localRefs }, restriction);
      this.db.prepare('INSERT INTO r1_workspace_requests VALUES(?,?,?,?,?,?,NULL,?)').run(input.requestId, bindingJson,
        wfdSha256(bindingJson), recipeDigest, input.planId, input.outputId, Date.now());
    });
    return this.get(input.requestId);
  }

  list(): R1RequestSummary[] {
    return this.db.prepare(`WITH recent AS (
      SELECT request_id,created_at,rowid FROM r1_workspace_requests ORDER BY created_at DESC,rowid DESC LIMIT 20
    ) SELECT a.request_id AS requestId,a.state,json_array_length(a.document_json,'$.outputs[0].payload.rows') AS rowCount,
      json_extract(a.error_json,'$.code') AS errorCode
      FROM recent JOIN r1_handoff_attempts a ON a.request_id=recent.request_id
      ORDER BY recent.created_at DESC,recent.rowid DESC`).all() as unknown as R1RequestSummary[];
  }
  get(requestId: string): R1RequestView {
    const row = this.requireRow(requestId), binding = this.savedBinding(row);
    const { attempt, local } = this.options.handoff.attemptWithExplanation(requestId);
    const rowSummary = (local.receipt as { row_summary?: R1RowSummary } | undefined)?.row_summary;
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    const output = (document.outputs as WfdRecord[])[0]!, payload = output.payload as WfdRecord;
    const rows = Array.isArray(payload.rows) ? payload.rows as WfdRecord[] : [];
    return { requestId, state: String(attempt.state), datasetId: String(attempt.dataset_id), outputKey: String(output.output_key),
      documentSha256: String(attempt.document_sha256), connection: binding, planId: row.plan_id, outputId: row.output_id,
      ...(document.duplicate_policy === 'skip_identical_append' ? { duplicatePolicy: 'skip_identical_append' as const } : {}),
      ...(isWfdRecord(rowSummary) ? { rowSummary } : {}),
      rowCount: rows.length, previewRows: rows.slice(0, 5), submitTaskId: row.submit_task_id,
      requiresRecovery: UNKNOWN_STATES.has(String(attempt.state)), local,
      error: attempt.error_json ? JSON.parse(String(attempt.error_json)) as WfdRecord : null };
  }
  submit(requestId: string, confirmationDigest: string): TaskRecord {
    const row = this.requireRow(requestId); this.assertDispatch(); this.assertBinding(row);
    const attempt = this.options.handoff.attempt(requestId);
    if (confirmationDigest !== attempt.document_sha256) fail('R1_CONFIRMATION_CHANGED', '确认必须对应本次已展示文档的准确摘要。');
    // 已提交过的原请求默认返回原任务。只有「明确未发送」（send_failed）且原尝试已终结时，
    // 才允许以新的任务身份重发；其他状态一律不重发，避免把未知结果当成未发送。
    let retry = 0;
    if (row.submit_task_id) {
      const existing = this.tasks.get(row.submit_task_id);
      const failedSend = String(attempt.state) === 'send_failed'
        && ['failed', 'cancelled'].includes(String(existing.status));
      if (!failedSend) return existing;
      retry = Number((this.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE request_id LIKE ?')
        .get(`r1:submit:${requestId}%`) as unknown as { n: number }).n);
    }
    if (attempt.state === 'rejected') fail('R1_WFD_REJECTED', '原请求已由 WFD 明确拒绝；不重发原身份。');
    if (UNKNOWN_STATES.has(String(attempt.state))) fail('R1_RECOVERY_REQUIRED', '原提交结果未知；请核对原请求，不重新提交。');
    // 首次发送的实际限制证据在 data.r1.submit 执行边界读取；不能在这里用旧缓存或调用方声明代替。
    this.options.handoff.assertSourceAuthorized(requestId);
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      accepted = this.tasks.createInTransaction({ title: 'R1：按已确认的固定产物交接', ownerRole: 'service', runtimeId: R1_WORKSPACE_RUNTIME,
        action: 'data.r1.submit', args: { requestId, confirmationDigest },
        requestId: retry ? `r1:submit:${requestId}:retry:${retry}` : `r1:submit:${requestId}`,
        versions: { r1Workspace: R1_WORKSPACE_VERSION, protocol: 'wfd.structured-ingest/1.0', connection: row.binding_sha256,
          document: String(attempt.document_sha256) } });
      this.db.prepare('UPDATE r1_workspace_requests SET submit_task_id=? WHERE request_id=?').run(accepted.task.id, requestId);
    });
    accepted.publish(); return this.tasks.start(accepted.task.id, accepted.task.version);
  }
  async recover(requestId: string, lookupId: string): Promise<TaskRecord> {
    id(lookupId); const row = this.requireRow(requestId); this.assertDispatch(); this.assertBinding(row);
    // A local preparation has no external attempt to reconcile. Querying unknown external status
    // would poison it as pending_receipt and block the user's first confirmed submission.
    if (!row.submit_task_id) fail('R1_NOT_SUBMITTED', '原请求尚未提交；请读取本地准备回执，提交仍由用户单独确认。');
    const attempt = this.options.handoff.attempt(requestId);
    const input = { title: 'R1：按原 identity 核对提交与固定读回',
      action: 'data.r1.recover', args: { requestId }, requestId: `r1:recover:${lookupId}`,
      parentTaskId: row.submit_task_id,
      versions: { r1Workspace: R1_WORKSPACE_VERSION, protocol: 'wfd.structured-ingest/1.0', connection: row.binding_sha256,
        document: String(attempt.document_sha256) } };
    const previous = this.previousLookupTask(input);
    if (previous) return previous;
    if (row.submit_task_id) {
      const original = this.tasks.get(row.submit_task_id);
      if (attempt.state === 'rejected' && original.status === 'failed') return original;
      if (['needs_review', 'interrupted', 'failed', 'paused'].includes(original.status)) return this.tasks.recover(original.id);
      if (!['succeeded', 'cancelled'].includes(original.status)) fail('R1_TASK_ACTIVE', '原任务尚未收束，请先等待或停止原尝试，再查询原外部事实。');
    }
    const task = this.tasks.create({ ...input, ownerRole: 'service', runtimeId: R1_WORKSPACE_RUNTIME });
    // Repeated lookupId returns its original task; it never restarts it or changes the request.
    return task.status === 'ready' ? this.tasks.start(task.id, task.version) : task;
  }

  resumeAccepted(requestId:string,lookupId:string,confirmationDigest:string):TaskRecord {
    id(lookupId);const row=this.requireRow(requestId);this.assertDispatch();this.assertBinding(row);
    const attempt=this.options.handoff.attempt(requestId),original=row.submit_task_id?this.tasks.get(row.submit_task_id):null;
    if(!original||!isWfdRecord(original.args)||original.args.confirmationDigest!==confirmationDigest
      ||confirmationDigest!==attempt.document_sha256)fail('R1_ORIGINAL_CONFIRMATION','续办须再次核对原人工确认摘要，不能改文档或创建新提交身份。');
    this.options.handoff.assertSourceAuthorized(requestId);
    const input={title:'R1：明确续办已受理的原文档',
      action:'data.r1.resume',args:{requestId,confirmationDigest},requestId:`r1:resume:${lookupId}`,parentTaskId:original.id,
      versions:{r1Workspace:R1_WORKSPACE_VERSION,protocol:'wfd.structured-ingest/1.0',connection:row.binding_sha256,document:String(attempt.document_sha256)}};
    const previous=this.previousLookupTask(input);
    if(previous)return previous;
    if(['running','ready','pausing','cancelling'].includes(original.status))fail('R1_TASK_ACTIVE','原提交仍在收束，请先核对原任务。');
    const task=this.tasks.create({...input,ownerRole:'service',runtimeId:R1_WORKSPACE_RUNTIME});
    return task.status==='ready'?this.tasks.start(task.id,task.version):task;
  }

  /** 核对原业务意图后复用受理事实；命名迁移不重算旧 input_digest。 */
  private previousLookupTask(input: { title: string; action: string; args: JsonValue; requestId: string;
    parentTaskId?: string; versions: Record<string, string> }): TaskRecord | null {
    const row = this.db.prepare('SELECT id FROM tasks WHERE request_id=?').get(input.requestId);
    if (row) {
      const task = this.tasks.get(String(row.id));
      if (task.runtimeId !== R1_WORKSPACE_RUNTIME || task.ownerRole !== 'service' || task.conversationId !== null
        || task.title !== input.title || task.action !== input.action || task.parentTaskId !== (input.parentTaskId ?? null)
        || canonicalWfdJson(task.args) !== canonicalWfdJson(input.args) || canonicalWfdJson(task.versions) !== canonicalWfdJson(input.versions)) {
        fail('REQUEST_CONFLICT', '原 R1 核对或续办请求不能更换文档、关联任务或固定版本。');
      }
      return task;
    }
    return null;
  }

  private async verifyRestrictionForRequest(requestId: string, runtime: ReturnType<R1WorkspaceService['requireRuntime']>):
    Promise<RestrictionEvidence | null> {
    const row = this.requireRow(requestId), plan = this.options.processing.get(row.plan_id);
    const fixedOutput = plan.outputs.find(item => item.outputId === row.output_id);
    if (!fixedOutput) fail('R1_PREPARE', '实际加工计划没有本次输出；不能核对发布限制范围。');
    const usage = isWfdRecord(fixedOutput.usage) ? fixedOutput.usage : null;
    if (!usage || (usage.purpose !== 'current_publish' && usage.purpose !== 'historical_publish')) return null;
    const attempt = this.options.handoff.attempt(requestId);
    const document = JSON.parse(String(attempt.document_json)) as WfdRecord;
    const output = (Array.isArray(document.outputs) ? document.outputs.filter(isWfdRecord) : [])[0];
    if (!output) fail('R1_PREPARE', '原交接文档没有输出；不能核对发布限制范围。');
    const target = isWfdRecord(fixedOutput.target) ? fixedOutput.target : {};
    const productRef = isWfdRecord(target.productRef) ? target.productRef : null;
    const restrictionTarget = publishRestrictionTarget({
      purpose: usage.purpose as 'current_publish' | 'historical_publish',
      expectedSnapshotId: typeof output.expected_parent_snapshot_id === 'string' ? output.expected_parent_snapshot_id : null,
      productRef,
      logicalDomain: typeof output.logical_domain === 'string' ? output.logical_domain : 'observations',
      subject: isWfdRecord(output.subject) ? output.subject : {},
      definition: isWfdRecord(output.definition) ? output.definition : {},
      definitionMode: productRef && typeof productRef.product_id === 'string' ? 'reuse' : 'create',
      recordVersions: [],
    });
    let result: unknown;
    try { result = (await runtime.client.usageStatus()).result; }
    catch (error) {
      fail('R1_USAGE_STATUS_UNAVAILABLE', '首次发送无法读取 WFD 权威 usage_status；未提交。' + (error instanceof Error ? ` ${error.message.slice(0, 500)}` : ''));
    }
    return restrictionEvidenceFromUsageStatus(result, restrictionTarget, Date.now());
  }

  readonly runtime: TaskRuntime = { id: R1_WORKSPACE_RUNTIME, execute: async context => {
    const requestId = String((context.task.args as { requestId?: unknown }).requestId ?? '');
    const row = this.requireRow(requestId), runtime = this.assertBinding(row);
    const attempt = this.options.handoff.attempt(requestId);
    if (context.task.versions.r1Workspace !== R1_WORKSPACE_VERSION || context.task.versions.protocol !== 'wfd.structured-ingest/1.0'
      || context.task.versions.connection !== row.binding_sha256 || context.task.versions.document !== attempt.document_sha256) fail('R1_TASK_BINDING_CHANGED', '任务冻结的运行版本、协议、连接或文档摘要不一致。');
    this.assertActive(context);
    if (context.task.action === 'data.r1.recover') {
      const result = await this.options.handoff.recoverStatus(requestId, runtime.client, context.signal);
      this.assertActive(context);
      if (result.state === 'rejected') fail('R1_WFD_REJECTED', '原请求已由 WFD 明确拒绝，原回执保存在 BD。');
      if (!R1_SETTLED_STATES.has(String(result.state))) fail('R1_RECOVERY_PENDING', '原请求尚无完整处理回执和固定读回；没有重新提交。');
      return resultFor(this.get(requestId));
    }
    if(context.task.action==='data.r1.resume') {
      const effectId=`r1-resume:${context.task.id}`;
      await context.emit({type:'side_effect_started',effectId,description:'明确续办已持久受理的原request_identity与原文档',operation:{requestId,documentSha256:String(attempt.document_sha256)}});
      const result=await this.options.handoff.resumeAcceptedAndAssociate(requestId,runtime.client,context.signal);
      if(!R1_SETTLED_STATES.has(String(result.state)))fail('R1_ORIGINAL_RESUME_PENDING','原文档尚未完成处理回执和固定读回，保留原身份。');
      await context.emit({type:'side_effect_result',effectId,outcome:'succeeded',evidence:'原intent、确认摘要、连接与父快照均核对；同身份续办并实际固定读回。'});
      if(row.submit_task_id){const original=this.tasks.get(row.submit_task_id);if(['needs_review','interrupted','failed','paused'].includes(original.status))await this.tasks.recover(original.id);}
      return resultFor(this.get(requestId));
    }
    if (context.task.action !== 'data.r1.submit') fail('R1_ACTION', '未登记的 R1 动作。');
    const effectId = `r1:${requestId}`;
    await context.emit({ type: 'checkpoint', checkpoint: { requestId, bindingSha256: row.binding_sha256, documentSha256: String(attempt.document_sha256) } });
    // 首次发送的全部用途/限制证据必须在任何外部副作用标记前完成；失败不进入 unknown 提交恢复。
    const restriction = await this.verifyRestrictionForRequest(requestId, runtime);
    this.options.handoff.assertCalculationReadyToSend(requestId, restriction);
    // 在报告首次外部副作用前完成远端固定记录重新读取；失败时不得发 WFD submit。
    await this.options.handoff.assertRemoteCalculationReadyToSend(requestId, context.signal);
    await context.emit({ type: 'side_effect_started', effectId, description: '向冻结 data_only 连接提交原 request_identity',
      operation: { protocol: 'wfd.structured-ingest/1.0', requestId, bindingSha256: row.binding_sha256 } });
    const result = await this.options.handoff.submitAndAssociate(requestId, runtime.client, context.signal, restriction);
    if (R1_SETTLED_STATES.has(String(result.state))) {
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '实际逐行身份已与实际 fixed_read 核对并回链到 BD。' });
      this.assertActive(context); return resultFor(this.get(requestId));
    }
    if (result.state === 'send_failed' || result.state === 'pending_wfd_profile' || result.state === 'rejected') await context.emit({ type: 'side_effect_result', effectId,
      outcome: 'not_applied', evidence: result.registration_preserved === true
        ? 'WFD 已保留产品登记事实，但明确拒绝全部输出且未发布记录；原回执和错误保留。'
        : '薄入口明确未接受提交；BD保留原请求和失败信息。' });
    if (result.state === 'rejected') fail('R1_WFD_REJECTED', '原请求已由 WFD 明确拒绝，原回执保存在 BD。');
    fail('R1_HANDOFF_PENDING', '未获得完整处理回执与已接收行的固定读回；保留原请求待核对，不能声称全部已导入。');
  }, recover: async ({ task, effects, signal }) => {
    const requestId = String((task.args as { requestId?: unknown }).requestId ?? '');
    const row = this.requireRow(requestId), runtime = this.assertBinding(row), attempt = this.options.handoff.attempt(requestId);
    if (task.versions.r1Workspace !== R1_WORKSPACE_VERSION || task.versions.protocol !== 'wfd.structured-ingest/1.0'
      || task.versions.connection !== row.binding_sha256 || task.versions.document !== attempt.document_sha256) fail('R1_TASK_BINDING_CHANGED', '原任务冻结版本或文档不一致，未按当前 profile 接管。');
    const result = await this.options.handoff.recoverStatus(requestId, runtime.client, signal);
    const associated = R1_SETTLED_STATES.has(String(result.state));
    const rejected = result.state === 'rejected';
    const rejectionEvidence = result.registration_preserved === true
      ? '原 WFD 登记事实保留，全部输出明确拒绝且未发布记录；原请求不重发。'
      : '原 WFD 回执明确拒绝且没有正式发布；原请求不重发。';
    return { outcome: associated ? 'succeeded' : rejected ? 'failed' : 'pending', evidence: associated ? '按原连接和原请求取得逐行处理回执，已接收行已固定读回；冲突状态单独保留。' : rejected ? rejectionEvidence : '原请求尚未核清，没有重新提交。',
      ...(associated ? { result: resultFor(this.get(requestId)) } : {}), effects: associated ? effects.filter(effect => effect.status === 'started').map(effect => ({
        attemptId: effect.attemptId, effectId: effect.effectId, outcome: 'succeeded' as const, evidence: '原请求的逐行处理结果已核对，已接收行固定读回通过；冲突仍待确认。' }))
        : rejected ? effects.filter(effect => effect.status === 'started').map(effect => ({
          attemptId: effect.attemptId, effectId: effect.effectId, outcome: 'not_applied' as const, evidence: rejectionEvidence })) : [] };
  } };

  private requireRuntime(): R1Runtime { return this.options.runtime ?? fail('R1_NOT_CONFIGURED', this.options.configuration.reason ?? 'R1 data_only 连接尚未配置。'); }
  private row(requestId: string): RequestRow | undefined { id(requestId); return this.db.prepare('SELECT * FROM r1_workspace_requests WHERE request_id=?').get(requestId) as unknown as RequestRow | undefined; }
  private requireRow(requestId: string): RequestRow { return this.row(requestId) ?? fail('R1_WORKSPACE_REQUEST_NOT_FOUND', '没有该新流程的原请求；不能按当前配置接管旧任务。'); }
  private savedBinding(row: RequestRow): R1ConnectionIdentity {
    if (wfdSha256(row.binding_json) !== row.binding_sha256) fail('R1_CONNECTION_BINDING_CHANGED', '持久连接身份摘要已变化。');
    return JSON.parse(row.binding_json) as R1ConnectionIdentity;
  }
  private assertBinding(row: RequestRow): R1Runtime {
    const saved = this.savedBinding(row), runtime = this.requireRuntime(), actual = runtime.currentIdentity();
    if (canonicalWfdJson(saved) !== canonicalWfdJson(actual)) fail('R1_CONNECTION_BINDING_CHANGED', '当前连接、配置、入口或 schema 与原请求不同；未切换连接、未重放。');
    return runtime;
  }
  private assertDispatch(): void { if (this.tasks.getControl().stopped) fail('BD_STOPPED', '服务已停止，不受理新的 R1 动作。'); }
  private assertActive(context: TaskExecutionContext): void {
    context.signal.throwIfAborted();
    if (!this.tasks.isRunActive(context.runId, context.generation) || this.tasks.get(context.task.id).currentAttemptId !== context.attemptId) fail('TASK_NOT_ACTIVE', '原尝试已失效，未启动新的外部动作。');
  }
}

function readInput(value: unknown): R1PrepareInput {
  const input = object(value, ['requestId', 'planId', 'outputId', 'source', 'mapping', 'target']);
  id(input.requestId); id(input.planId); id(input.outputId);
  const sourceFields = ['source_id', 'provider', 'requested_url', 'requested_at_utc', 'acquired_at_utc', 'usage_scope'];
  const source = object(input.source, [...sourceFields, 'license', 'authorization']);
  const tabular = isWfdRecord(input.mapping) && input.mapping.kind === 'tabular_rows';
  const mapping = object(input.mapping, tabular
    ? ['kind', 'businessKey', 'earliestUtc', 'latestExclusiveUtc', 'precision', 'sourceTimezone', 'fields', 'bar', 'publicTime']
    : ['businessKey', 'value', 'earliestUtc', 'latestExclusiveUtc', 'precision', 'sourceTimezone']);
  const target = object(input.target, ['datasetId', 'outputKey', 'expectedParentSnapshotId', 'subject', 'definition', 'inputMode', 'coverage']);
  for (const field of sourceFields) boundedText(source[field], 4096);
  if (Object.hasOwn(source, 'license') && (typeof source.license !== 'string' || source.license.length > 4096
    || /[\u0000-\u001f]/u.test(source.license))) fail('R1_WEB_INPUT', '旧来源许可文字格式无效。');
  if (Object.keys(source).length !== sourceFields.length + Number(Object.hasOwn(source, 'license')) + Number(Object.hasOwn(source, 'authorization'))
    || !tabular && Object.keys(mapping).length !== 6 || Object.keys(target).length !== 7) fail('R1_WEB_INPUT', '来源、映射和目标必须逐项明确，不能补猜。');
  assertKnownR1Source(source as unknown as R1PrepareInput['source']);
  for (const field of ['businessKey', ...(!tabular ? ['value'] : []), 'earliestUtc', 'latestExclusiveUtc', 'sourceTimezone']) boundedText(mapping[field], 128);
  if (!['day', 'minute', 'second'].includes(String(mapping.precision))) fail('R1_WEB_TIME', '当前切片只支持显式 day/minute/second 时间精度。');
  id(target.datasetId); id(target.outputKey);
  if (target.expectedParentSnapshotId !== null) id(target.expectedParentSnapshotId);
  if (!['partial_observation', 'complete_snapshot'].includes(String(target.inputMode)) || !isWfdRecord(target.subject) || !isWfdRecord(target.definition) || !isWfdRecord(target.coverage)) fail('R1_WEB_TARGET', '目标身份、定义、覆盖或输入模式无效。');
  if (tabular) compileR1TabularDeclaration({ protocol: 'wfd.structured-ingest/1.0', mapping, target, source });
  return JSON.parse(canonicalWfdJson(input)) as R1PrepareInput;
}
function scalarRows(rows: unknown[], mapping: R1ScalarMapping, allowDuplicateKeys: boolean): WfdRecord[] {
  const keys = new Set<string>();
  if (!rows.length || rows.length > R1_WEB_LIMITS.maxRows) fail('R1_WEB_BUDGET', '当前 Web 小切片需要 1–5000 行；没有截断输入。');
  return rows.map((value, index) => {
    if (!isWfdRecord(value)) fail('R1_PROCESS_OUTPUT_FORMAT', '加工输出行不是对象。');
    const key = value[mapping.businessKey], decimal = value[mapping.value];
    boundedText(key, 128);
    if (!allowDuplicateKeys && keys.has(String(key))) fail('R1_BUSINESS_KEY_DUPLICATE', `第 ${index + 1} 行业务键重复。`);
    keys.add(String(key));
    if (typeof decimal !== 'string' || decimal.length > 128 || !/^-?(0|[1-9]\d*)(\.\d+)?$/u.test(decimal)) fail('R1_DECIMAL_REQUIRED', `第 ${index + 1} 行需要完整十进制字符串；不能转成浮点数。`);
    const earliest = utc(value[mapping.earliestUtc]), latest = utc(value[mapping.latestExclusiveUtc]);
    if (Date.parse(earliest) >= Date.parse(latest)) fail('R1_WEB_TIME', '时间区间终点必须晚于起点。');
    return { business_key: key, value_decimal: decimal, value_state: 'valid_value', observation_time: { status: 'known',
      precision: mapping.precision, earliest_utc: earliest, latest_exclusive_utc: latest, source_timezone: mapping.sourceTimezone } };
  });
}
function utc(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(parseR1Utc(value))) fail('R1_WEB_TIME', '映射时间必须是实际有效的明确 UTC（最多三位小数）；不猜测、不滚转或丢弃精度。');
  return value;
}
function object(value: unknown, keys: string[]): WfdRecord { if (!isWfdRecord(value) || Object.keys(value).some(key => !keys.includes(key))) fail('R1_WEB_INPUT', '不接受未声明的字段、任意行、路径、权限或连接覆盖。'); return value; }
function boundedText(value: unknown, max: number): void { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) fail('R1_WEB_INPUT', '文本缺失或超过预算。'); }
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)) fail('R1_WEB_ID', '需要稳定的有界身份，不接受路径。'); }
function resultFor(view: R1RequestView): TaskResult {
  return { summary: view.rowSummary ? `R1：新增 ${view.rowSummary.inserted} 行，相同跳过 ${view.rowSummary.duplicate_skipped} 行，冲突待确认 ${view.rowSummary.conflict_pending} 行。` : `R1 ${view.state}；${view.rowCount} 行已按真实 WFD 身份核对。`, data: {
    requestId: view.requestId, state: view.state, datasetId: view.datasetId, outputKey: view.outputKey,
    documentSha256: view.documentSha256, rowCount: view.rowCount, submitTaskId: view.submitTaskId,
    ...(view.rowSummary ? { rowSummary: view.rowSummary as unknown as JsonValue } : {}),
    requiresRecovery: view.requiresRecovery, error: view.error as JsonValue,
    detail: { kind: 'r1_request', requestId: view.requestId, rows: view.rowSummary?.conflict_pending ? 'accepted_fixed_record_associations_with_conflicts_pending' : 'complete_fixed_record_associations' },
  } };
}
function fail(code: string, message: string): never { throw new TaskError(code, message); }
