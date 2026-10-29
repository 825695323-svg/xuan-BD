import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CoreDatabase } from '../../platform/state/database.js';
import { digestOperationArgs, PermissionError, type PermissionCapability } from '../../platform/security/permissions.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { AlgorithmResultLineage, AlgorithmResultReader, AlgorithmResultReference, VerifiedAlgorithmResult } from '../../contracts/workspace-services.js';
import type { MaterialService } from './materials/service.js';
import type { DatabaseLineService } from '../../adapters/database/line-selection.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { GENERIC_CONTRACT, GenericDatabaseError, type GenericEnvelope, type GenericDatabaseBinding } from '../../adapters/database/generic-transport.js';
import { CANDIDATE_LIMITS, CANDIDATE_PIPELINE_VERSION, prepareCandidateTable, type CandidateTablePlan } from './candidate-pipeline.js';
import type { ProcessingPlanService } from './processing-plan.js';

export const CANDIDATE_RUNTIME = 'harness.candidates';
const PREPARE = 'data.candidates.prepare', SUBMIT = 'data.candidates.submit', RESUME = 'data.candidates.resume', CANCEL = 'data.candidates.cancel';
export interface ObjectRef { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }
interface CandidateOutput {
  outputId: string; namespace: string; materialIds: string[];
  productRef?: WfdRecord; declaration?: WfdRecord; expectedSnapshotId?: string | null;
  tables?: CandidateTablePlan[];
  processing?: { planId: string; outputId: string };
  source?: { source_id: string; source_uri: string | null; observed_at: string };
  inputs?: WfdRecord[]; coverage?: { complete: boolean; gaps: string[]; scope: string };
  /** 只接受 algorithm-service 受信读取器核对过的原任务持久结果；不能同时提供 rows、tables 或 processing。 */
  algorithmResult?: AlgorithmResultReference;
}
export interface CandidateInput { outputs: CandidateOutput[] }
/**
 * 受信宿主对“原件由哪个真实处理任务产生”的本次确认。entries 只来自宿主桥本轮读取的
 * conversation_material_links；resolve 必须在本次 prepare 时重新读取原任务、原结果及原产物
 * 文件引用，不能用 HTTP、模型或持久候选 JSON 自填的 taskId/摘要冒充。
 */
export interface HostProcessingConfirmation {
  readonly entries: readonly WfdRecord[];
  /** 返回规范化确认事实；原任务、结果、版本或原产物摘要不符时必须抛出 TaskError。 */
  readonly resolve: (entry: WfdRecord) => WfdRecord;
}
type Preparation = { task_id: string; input_json: string; result_json: string | null };
type Submission = { id: string; task_id: string; preparation_id: string; request_id: string; envelope_json: string;
  state: string; receipt_json: string | null; readback_json: string | null; error_json: string | null };
const json = (value: unknown): JsonValue => JSON.parse(canonicalWfdJson(value));
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const id = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : fail('CANDIDATE_ID', '候选任务需使用稳定编号，不接受文件路径。');

/** 本表仅保存候选内容和外部事实，停止、预算、审批及运行状态统一归 TaskService。 */
export class CandidateService {
  readonly versionBinding: Record<string, string>;
  constructor(private readonly options: { database: CoreDatabase; tasks(): TaskService; materials: MaterialService; lines?: DatabaseLineService;
    processing?: () => ProcessingPlanService | undefined;
    /** 惰性 getter 避免候选服务与算法服务构造循环；只在可信宿主装配。 */
    algorithmReader?: () => AlgorithmResultReader | undefined }) {
    const files = ['./candidate-service.ts', './candidate-pipeline.ts'].map(path => readFileSync(new URL(path, import.meta.url)));
    this.versionBinding = Object.freeze({ candidates: CANDIDATE_PIPELINE_VERSION, implementation: wfdSha256(Buffer.concat(files)) });
    options.database.migrate('generic_candidates', 1, `
      CREATE TABLE candidate_preparations(task_id TEXT PRIMARY KEY REFERENCES tasks(id),input_json TEXT NOT NULL,input_digest TEXT NOT NULL,result_json TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE candidate_objects(sha256 TEXT PRIMARY KEY,byte_length INTEGER NOT NULL,bytes BLOB NOT NULL);
      CREATE TABLE candidate_submissions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),preparation_id TEXT NOT NULL REFERENCES candidate_preparations(task_id),
        request_id TEXT NOT NULL UNIQUE,envelope_json TEXT NOT NULL,state TEXT NOT NULL,receipt_json TEXT,readback_json TEXT,error_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    `);
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }
  catalog() {
    return { contract: GENERIC_CONTRACT, versions: this.versionBinding, limits: CANDIDATE_LIMITS,
      stages: ['conversion', 'parse', 'clean', 'annotate', 'check', 'structure'],
      implemented: ['explicit_utf8_csv', 'explicit_json_scalar_rows', 'field_mapping', 'explicit_scalar_types', 'trim', 'empty_to_null', 'constant_annotations', 'multiple_sources', 'independent_outputs', 'original_custody', 'fixed_snapshot_readback', 'processing_plan_outputs'],
      inputPolicy: '先保管已选原件；文档、媒体或压缩成员先用已有独立转换/OCR/转录任务产物，未执行或不支持则只保管并返回缺口。',
      processingRef: { shape: { planId: 'processing plan id', outputId: 'completed output id' }, note: '只引用已持久化且已完成 check 的计划输出；不能同时提交 tables，也不能由客户端自带对象摘要。' },
      declarationGuidance: { rules_version: 'wfd.generic.table/v1', note: '字段含义、单位、时间、范围、主键必须显式声明；已有合同引用需完整冻结摘要。', planTypes: ['safe_integer', 'decimal_string', 'string', 'boolean', 'binary64_hex'], tableFormat: ['csv', 'json'], input: { outputs: [{ outputId: 'chosen-output', namespace: '从实际授权选择', materialIds: ['material-id'], tables: [{ materialId: 'material-id', format: 'csv', fieldMapping: {}, types: {}, trim: [], emptyToNull: [], annotations: {} }] }] } },
      database: this.options.lines?.genericStatus() ?? { available: false, reason: '没有已发现且获准的通用数据库能力。' } };
  }
  validate(input: unknown): CandidateInput {
    if (!isWfdRecord(input) || Object.keys(input).some(key => key !== 'outputs') || !Array.isArray(input.outputs)
      || input.outputs.length < 1 || input.outputs.length > CANDIDATE_LIMITS.maxOutputs) fail('CANDIDATE_INPUT', '需要 1 至 16 个独立输出。');
    if (Buffer.byteLength(canonicalWfdJson(input)) > 131_072) fail('CANDIDATE_INPUT_BUDGET', '候选规则和声明超过 128 KiB；数据行应来自保管材料。');
    const seen = new Set<string>();
    for (const item of (input as WfdRecord).outputs as unknown[]) {
      if (!isWfdRecord(item) || Object.keys(item).some(key => !['outputId', 'namespace', 'materialIds', 'productRef', 'declaration', 'expectedSnapshotId', 'tables', 'processing', 'source', 'inputs', 'coverage', 'algorithmResult'].includes(key))) fail('CANDIDATE_OUTPUT', '输出只接受原件引用、受信算法结果引用、明确规则、已有合同或新声明。');
      const output = item as unknown as CandidateOutput;
      id(output.outputId); if (seen.has(output.outputId)) fail('CANDIDATE_OUTPUT', '输出编号不能重复。'); seen.add(output.outputId);
      const algorithm = output.algorithmResult !== undefined;
      if (typeof output.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(output.namespace)
        || !Array.isArray(output.materialIds) || output.materialIds.length > CANDIDATE_LIMITS.maxOriginals
        || (algorithm ? output.materialIds.length !== 0 : !output.materialIds.length)
        || new Set(output.materialIds).size !== output.materialIds.length) fail('CANDIDATE_OUTPUT', algorithm
          ? '受信算法结果输出不能伪装成原件，materialIds 必须为空；普通输出仍需 1 至 32 个不重复原件。'
          : '每个输出需有明确命名空间及 1 至 32 个不重复原件。');
      if (algorithm) {
        if (output.tables !== undefined || output.processing !== undefined || output.inputs !== undefined
          || output.coverage !== undefined || output.source !== undefined) fail('CANDIDATE_ALGORITHM_INPUT',
            '算法结果输出的表规则、处理计划、派生输入、覆盖和来源必须来自受信结果谱系，不能由候选客户端提供。');
        this.verifiedAlgorithm(output.algorithmResult!);
      } else output.materialIds.forEach(value => this.options.materials.get(id(value)));
      if (output.productRef !== undefined && !isWfdRecord(output.productRef) || output.declaration !== undefined && !isWfdRecord(output.declaration)
        || output.productRef && output.declaration) fail('CANDIDATE_DECLARATION', '已有合同引用与新产品声明只能选择一项；缺少时会保管原件并返回缺口。');
      if (output.expectedSnapshotId !== undefined && output.expectedSnapshotId !== null) id(output.expectedSnapshotId);
      if (output.processing !== undefined) {
        if (!isWfdRecord(output.processing) || Object.keys(output.processing).some(key => key !== 'planId' && key !== 'outputId')) fail('CANDIDATE_PROCESSING', '处理产物引用只接受 planId 与 outputId。');
        id(output.processing.planId); id(output.processing.outputId);
        if (output.tables !== undefined) fail('CANDIDATE_PROCESSING', '已有处理产物与原表规则不能同时提交；避免重复或矛盾加工。');
      }
      if (output.tables !== undefined) {
        if (!Array.isArray(output.tables) || !output.tables.length || output.tables.length > 32) fail('CANDIDATE_TABLES', '表源必须为 1 至 32 个明确材料处理计划。');
        for (const plan of output.tables) {
          if (!isWfdRecord(plan) || Object.keys(plan).some(key => !['materialId', 'format', 'fieldMapping', 'types', 'trim', 'emptyToNull', 'annotations'].includes(key))
            || !output.materialIds.includes(plan.materialId) || !['csv', 'json'].includes(plan.format)
            || ['fieldMapping', 'types', 'annotations'].some(key => plan[key] !== undefined && !isWfdRecord(plan[key]))
            || ['trim', 'emptyToNull'].some(key => plan[key] !== undefined && (!Array.isArray(plan[key]) || (plan[key] as unknown[]).some(value => typeof value !== 'string')))) fail('CANDIDATE_TABLES', '处理规则必须引用本输出真实保管的表源；不接受任意数据行或路径。');
        }
      }
      if (output.source && (!isWfdRecord(output.source) || typeof output.source.source_id !== 'string' || !output.source.source_id
        || output.source.source_uri !== null && typeof output.source.source_uri !== 'string' || !Number.isFinite(Date.parse(output.source.observed_at)))) fail('CANDIDATE_SOURCE', '来源声明需明确来源编号、原地址或空值及有效观察时间。');
      if (output.inputs !== undefined && (!Array.isArray(output.inputs) || output.inputs.length > 32 || output.inputs.some(item => !isWfdRecord(item)))) fail('CANDIDATE_INPUTS', '派生输入需为明确快照引用。');
      if (output.coverage && (!isWfdRecord(output.coverage) || typeof output.coverage.complete !== 'boolean' || !Array.isArray(output.coverage.gaps)
        || output.coverage.gaps.some(value => typeof value !== 'string') || typeof output.coverage.scope !== 'string')) fail('CANDIDATE_COVERAGE', '覆盖声明须明确完整性、缺口和范围。');
      if (output.coverage?.complete === true && output.coverage.gaps.length) fail('CANDIDATE_COVERAGE', '完整覆盖不能同时声明缺口；有缺口时必须声明 complete=false。');
    }
    return JSON.parse(canonicalWfdJson(input)) as CandidateInput;
  }
  prepare(input: unknown, requestId: string, parentTaskId?: string, hostProcessing?: HostProcessingConfirmation): TaskRecord {
    const validated = this.validate(input), verifiedHost = this.verifyHostProcessing(hostProcessing, validated);
    const normalized = { ...validated, ...(verifiedHost.length ? { hostProcessing: verifiedHost } : {}) }, request = `candidates:prepare:${id(requestId)}`;
    const previous = this.requestTask(request);
    if (previous) { this.assertSame(previous, normalized, parentTaskId); return previous; }
    this.assertDispatch();
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      accepted = this.tasks.createInTransaction({ title: '构造通用材料候选（本地）', ownerRole: 'service', runtimeId: CANDIDATE_RUNTIME,
        action: PREPARE, args: json(normalized), requestId: request, parentTaskId, versions: this.versionBinding });
      this.db.prepare('INSERT INTO candidate_preparations VALUES(?,?,?,NULL,?)').run(accepted.task.id, canonicalWfdJson(normalized), digestOperationArgs(normalized), Date.now());
    });
    accepted.publish(); return this.tasks.start(accepted.task.id, accepted.task.version);
  }
  submit(preparedTaskId: string, completion: string, requestId: string): TaskRecord {
    id(preparedTaskId); id(requestId);
    if (!['accepted', 'received', 'committed'].includes(completion)) fail('CANDIDATE_COMPLETION', '须明确以受理、接收还是正式提交作为本次完成条件。');
    const args = { preparedTaskId, completion }, request = `candidates:submit:${requestId}`, previousTask = this.requestTask(request);
    if (previousTask) { this.assertSame(previousTask, args, preparedTaskId); return previousTask; }
    this.assertDispatch();
    const prepared = this.prepared(preparedTaskId);
    if (!prepared.result_json || this.tasks.get(preparedTaskId).status !== 'succeeded') fail('CANDIDATE_NOT_PREPARED', '本地候选尚未完成；没有替用户执行未确认的处理。');
    const result = JSON.parse(prepared.result_json!) as WfdRecord;
    const parentTask = this.tasks.get(preparedTaskId).parentTaskId;
    const previousRow = parentTask ? this.db.prepare('SELECT * FROM candidate_submissions WHERE task_id=?').get(parentTask) as Submission | undefined : undefined;
    const previous = previousRow ? this.baseSubmission(previousRow) : undefined;
    const previousEnvelope = previous ? JSON.parse(previous.envelope_json) as GenericEnvelope : undefined;
    const selectedBinding = previousEnvelope ? this.requireLines().genericForEnvelope(previousEnvelope) : this.requireLines().genericCurrent();
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      accepted = this.tasks.createInTransaction({ title: '按声明向数据库交接候选', ownerRole: 'service', runtimeId: CANDIDATE_RUNTIME,
        action: SUBMIT, args, requestId: request, parentTaskId: preparedTaskId, versions: { ...this.versionBinding, genericContract: selectedBinding.contractDigest } });
    if (previous) this.requireLines().bindDerivedTask(accepted.task.id, previous.task_id);
    const binding = this.requireLines().genericForTask(accepted.task.id);
    const envelope: GenericEnvelope = { protocol_version: 3, contract_version: GENERIC_CONTRACT, request_id: 'bd-candidate:' + wfdSha256(requestId),
      instance_id: binding.instanceId, operation: 'data.submit', arguments: { purpose: 'user_test', submission_id: 'bd-candidate:' + accepted.task.id,
        completion, outputs: result.outputs, ...(previousEnvelope ? { previous_submission_id: previousEnvelope.arguments.submission_id } : {}) } };
    this.requireLines().pinRequest(envelope, accepted.task.id);
    this.db.prepare('INSERT INTO candidate_submissions VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?)').run(accepted.task.id, accepted.task.id,
      preparedTaskId, envelope.request_id, canonicalWfdJson(envelope), 'prepared', Date.now(), Date.now());
    });
    accepted.publish(); return this.tasks.start(accepted.task.id, accepted.task.version);
  }
  control(submissionTaskId: string, action: 'resume' | 'cancel', detail: string, requestId: string): TaskRecord {
    id(submissionTaskId); id(requestId);
    if (action !== 'resume' && action !== 'cancel' || action === 'resume' && !['received', 'committed'].includes(detail)
      || action === 'cancel' && (!detail.trim() || detail.length > 2000)) return fail('CANDIDATE_CONTROL', '须明确原交接、续接完成条件或取消原因。');
    const args = { submissionTaskId, action, detail }, request = `candidates:${action}:${requestId}`, previous = this.requestTask(request);
    if (previous) { this.assertSame(previous, args, submissionTaskId); return previous; }
    this.assertDispatch();
    const original = this.baseSubmission(this.submission(submissionTaskId)), originalEnvelope = JSON.parse(original.envelope_json) as GenericEnvelope;
    const binding = this.requireLines().genericForEnvelope(originalEnvelope);
    if (this.tasks.get(original.task_id).versions.genericContract !== binding.contractDigest) return fail('CANDIDATE_CONTRACT_CHANGED', '续接保留原协议摘要；不能用新模式重放旧请求。');
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      accepted = this.tasks.createInTransaction({ title: action === 'resume' ? '明确续接原数据库交接' : '明确取消原数据库交接', ownerRole: 'service',
        runtimeId: CANDIDATE_RUNTIME, action: action === 'resume' ? RESUME : CANCEL, args, requestId: request, parentTaskId: submissionTaskId,
        versions: { ...this.versionBinding, genericContract: binding.contractDigest } });
      this.requireLines().bindDerivedTask(accepted.task.id, original.task_id);
      const envelope = this.envelope(binding, action === 'resume' ? 'data.jobs.resume' : 'data.jobs.cancel', 'bd-control:' + wfdSha256(requestId),
        { submission_id: originalEnvelope.arguments.submission_id, ...(action === 'resume' ? { completion: detail } : { reason: detail }) });
      this.requireLines().pinRequest(envelope, accepted.task.id);
      this.db.prepare('INSERT INTO candidate_submissions VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,?)').run(accepted.task.id, accepted.task.id, original.preparation_id,
        envelope.request_id, canonicalWfdJson(envelope), 'prepared', Date.now(), Date.now());
    });
    accepted.publish(); return this.tasks.start(accepted.task.id, accepted.task.version);
  }
  private baseSubmission(row: Submission): Submission {
    const envelope = JSON.parse(row.envelope_json) as GenericEnvelope;
    if (envelope.operation === 'data.submit') return row;
    const args = this.tasks.get(row.task_id).args as { submissionTaskId: string };
    const parent = this.submission(args.submissionTaskId);
    if (parent.id === row.id) return fail('CANDIDATE_ORIGIN', '续接引用出现循环。');
    return this.baseSubmission(parent);
  }
  private prepared(taskId: string) {
    const row = this.db.prepare('SELECT * FROM candidate_preparations WHERE task_id=?').get(taskId) as Preparation | undefined;
    return row ?? fail('CANDIDATE_NOT_FOUND', '没有该原本地候选。');
  }
  private submission(taskId: string) {
    const row = this.db.prepare('SELECT * FROM candidate_submissions WHERE task_id=?').get(taskId) as Submission | undefined;
    return row ?? fail('CANDIDATE_SUBMISSION_NOT_FOUND', '没有该原交接记录。');
  }
  get(taskId: string) {
    const task = this.tasks.get(id(taskId));
    if (task.runtimeId !== CANDIDATE_RUNTIME) fail('CANDIDATE_NOT_FOUND', '该任务不是通用材料候选。');
    const prepared = this.db.prepare('SELECT result_json FROM candidate_preparations WHERE task_id=?').get(taskId);
    const row = this.db.prepare('SELECT * FROM candidate_submissions WHERE task_id=?').get(taskId) as Submission | undefined;
    return { taskId, taskStatus: task.status, action: task.action, versions: task.versions,
      preparation: prepared?.result_json ? JSON.parse(String(prepared.result_json)) : null,
      database: row ? { state: row.receipt_json ? (JSON.parse(row.receipt_json) as WfdRecord).state : row.state, reconciliationState: row.state, requestId: row.request_id, instanceId: (JSON.parse(row.envelope_json) as GenericEnvelope).instance_id,
        receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, readback: row.readback_json ? JSON.parse(row.readback_json) : null,
        error: row.error_json ? JSON.parse(row.error_json) : null } : { state: 'not_sent' } };
  }
  async capabilities(signal?: AbortSignal): Promise<WfdRecord> {
    const lines = this.requireLines(), binding = lines.genericCurrent();
    const result = await binding.call(this.envelope(binding, 'capabilities.search', 'capabilities:' + randomUUID(), {}), signal);
    return { ...result, declarationContract: binding.declarationContract };
  }
  async reconcile(taskId: string, signal?: AbortSignal, recovering = false) {
    const row = this.submission(id(taskId)), original = this.baseSubmission(row), envelope = JSON.parse(row.envelope_json) as GenericEnvelope;
    const binding = this.requireLines().genericForEnvelope(envelope);
    if (this.tasks.get(row.task_id).versions.genericContract !== binding.contractDigest) fail('CANDIDATE_CONTRACT_CHANGED', '原请求协议摘要已变化，保持原身份待核。');
    const receipt = await binding.call(this.envelope(binding, 'data.jobs.get', 'query:' + randomUUID(), { request_id: (JSON.parse(original.envelope_json) as GenericEnvelope).request_id }), signal);
    if (receipt.state === 'not_found') return { ...this.get(taskId), query: receipt };
    this.storeReceipt(row.id, receipt);
    if (original.id !== row.id) this.storeReceipt(original.id, receipt);
    await this.fixedRead(row.id, receipt, binding, signal);
    if (!recovering && this.tasks.get(taskId).status === 'needs_review' && this.submission(taskId).state === 'verified') await this.tasks.recover(taskId);
    return this.get(taskId);
  }
  readonly runtime: TaskRuntime = { id: CANDIDATE_RUNTIME, execute: async context => {
    this.assertVersion(context.task); this.assertActive(context);
    if (context.task.action === PREPARE) return this.executePrepare(context);
    if (![SUBMIT, RESUME, CANCEL].includes(context.task.action)) return fail('CANDIDATE_OPERATION', '未登记的候选动作。');
    const row = this.submission(context.task.id); let envelope = JSON.parse(row.envelope_json) as GenericEnvelope;
    if (row.state !== 'prepared') return fail('CANDIDATE_QUERY_REQUIRED', '原请求已有外部状态；只允许核对原请求，不自动重新提交。');
    const binding = this.requireLines().genericForEnvelope(envelope);
    if (context.task.versions.genericContract !== binding.contractDigest) fail('CANDIDATE_CONTRACT_CHANGED', '原通用请求模式摘要已变化，保持原身份待核。');
    const capabilities: PermissionCapability[] = [{ action: 'network', target: { kind: 'network', origin: binding.origin } },
      { action: 'secret', target: { kind: 'secret', name: binding.credentialReference } }];
    const operation = { operationId: SUBMIT, operationVersion: 1, argsDigest: digestOperationArgs(context.task.args), targets: capabilities.map(item => item.target) };
    let approvalId: string | undefined;
    try { context.assertAuthorized(operation, capabilities); }
    catch (error) { if (!(error instanceof PermissionError) || error.code !== 'APPROVAL_REQUIRED') throw error; approvalId = (await context.requestApproval(operation, capabilities)).approvalId ?? undefined; }
    const assert = () => { this.assertActive(context); context.assertAuthorized(operation, capabilities, { approvalId }); };
    const effectId = 'candidate:' + envelope.request_id; let effectStarted = false;
    try {
      assert();
      if (envelope.operation === 'data.submit' && !envelope.arguments.expected_grant_id) {
        const actual = await binding.call(this.envelope(binding, 'capabilities.search', 'grant-query:' + randomUUID(), {}), context.signal);
        const permission = actual.permissions;
        if (!isWfdRecord(permission) || permission.enabled !== true || typeof permission.grant_id !== 'string') throw new GenericDatabaseError('WFD_GENERIC_UNGRANTED', '通用材料操作尚无已完成的真实数据库授权。');
        envelope = { ...envelope, arguments: { ...envelope.arguments, expected_grant_id: permission.grant_id } };
        this.db.prepare('UPDATE candidate_submissions SET envelope_json=?,updated_at=? WHERE id=?').run(canonicalWfdJson(envelope), Date.now(), row.id);
      }
      assert();
      await context.emit({ type: 'side_effect_started', effectId, description: '按冻结实例分块保管原件并交接逐输出候选', operation: { requestId: envelope.request_id, instanceId: envelope.instance_id } });
      effectStarted = true;
      this.db.prepare("UPDATE candidate_submissions SET state='uploading',updated_at=? WHERE id=?").run(Date.now(), row.id);
      const outputs = envelope.operation === 'data.submit' ? envelope.arguments.outputs as WfdRecord[] : [];
      for (const output of outputs) {
        try {
        const refs = [...(output.original_evidence as ObjectRef[]), ...(output.verification_evidence as ObjectRef[]), ...(output.structured_result ? [output.structured_result as ObjectRef] : [])];
        for (const ref of refs) {
          assert(); const bytes = this.objectBytes(ref), count = Math.ceil(bytes.byteLength / CANDIDATE_LIMITS.chunkBytes);
          for (let index = 0; index < count; index++) {
            assert(); const chunk = bytes.subarray(index * CANDIDATE_LIMITS.chunkBytes, (index + 1) * CANDIDATE_LIMITS.chunkBytes);
            const response = await binding.call(this.envelope(binding, 'objects.put', 'bd-object:' + wfdSha256(`${envelope.request_id}:${output.namespace}:${ref.sha256}:${index}`).slice(0, 64),
              { purpose: 'user_test', namespace: output.namespace, sha256: ref.sha256, byte_length: ref.byte_length, media_type: ref.media_type,
                chunk_index: index, chunk_sha256: wfdSha256(chunk), bytes_base64: chunk.toString('base64') }), context.signal);
            if (index === count - 1 && response.state !== 'stored') throw new GenericDatabaseError('WFD_OBJECT_NOT_STORED', '最后分块尚未形成完整对象保管回执。', 'received');
          }
        }
        } catch (error) {
          if (!(error instanceof GenericDatabaseError) || error.code !== 'FORBIDDEN' || error.sideEffects !== 'none') throw error;
          // 此输出的精确命名空间未获准；交由同一data.submit返回逐输出拒绝，不吞掉其他输出。
        }
      }
      assert(); this.db.prepare("UPDATE candidate_submissions SET state='dispatched',updated_at=? WHERE id=?").run(Date.now(), row.id);
      const receipt = await binding.call(envelope, context.signal); this.storeReceipt(row.id, receipt);
      const original = this.baseSubmission(row); if (original.id !== row.id) this.storeReceipt(original.id, receipt);
      await context.emit({ type: 'side_effect_result', effectId, outcome: 'succeeded', evidence: '原实例返回逐输出真实回执；保管与正式提交分开记录。', data: json(receipt) });
      assert(); await this.fixedRead(row.id, receipt, binding, context.signal, assert);
      return this.result(context.task.id);
    } catch (error) {
      const current = this.submission(row.id);
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'CANDIDATE_FAILED';
      const sideEffects = error instanceof GenericDatabaseError ? error.sideEffects : 'unknown';
      if (!current.receipt_json) this.db.prepare('UPDATE candidate_submissions SET state=?,error_json=?,updated_at=? WHERE id=?')
        .run(sideEffects === 'none' ? 'rejected' : 'unknown', canonicalWfdJson({ code, sideEffects, message: error instanceof Error ? error.message : '交接中断' }), Date.now(), row.id);
      if (sideEffects === 'none' && effectStarted) await context.emit({ type: 'side_effect_result', effectId, outcome: 'not_applied', evidence: '数据库明确返回无业务副作用；原件分块保管可能已独立完成。', data: { code } });
      throw error;
    }
  }, recover: async ({ task, signal, effects }) => {
    if (task.action === PREPARE) return { outcome: 'not_applied', evidence: '本地候选构造没有数据库提交副作用。', effects: [] };
    if (this.submission(task.id).state !== 'verified') await this.reconcile(task.id, signal, true);
    const row = this.submission(task.id);
    return ['verified', 'stored_not_committed', 'rejected', 'cancelled'].includes(row.state)
      ? { outcome: 'succeeded', evidence: '已按原请求核对数据库事实。', result: this.result(task.id), effects: effects.map(effect => ({ attemptId: effect.attemptId, effectId: effect.effectId, outcome: 'succeeded' as const, evidence: '原实例查询回执已核对。' })) }
      : { outcome: 'pending', evidence: '原交接仍待核；保留原请求和实例，没有重新派发。', effects: [] };
  } };
  private async executePrepare(context: TaskExecutionContext): Promise<TaskResult> {
    const row = this.prepared(context.task.id);
    if (row.result_json) return this.result(context.task.id);
    const input = JSON.parse(row.input_json) as CandidateInput & { hostProcessing?: WfdRecord[] }, outputs: WfdRecord[] = [], reports: WfdRecord[] = [];
    for (const output of input.outputs) {
      this.assertActive(context);
      const originals = output.materialIds.map(materialId => { const material = this.options.materials.readOriginal(materialId);
        return { ...this.reference(material.bytes, material.mediaType), materialId }; });
      const evidence: WfdRecord = { implementation: this.versionBinding, outputId: output.outputId, original_materials: originals,
        rules: output.tables ?? [], conversion: (input.hostProcessing ?? []).filter(item => output.materialIds.includes(String(item.materialId))) };
      let structured: ObjectRef | undefined, processing: WfdRecord[] = [], processedSteps: WfdRecord[] | undefined, issue: WfdRecord | undefined;
      let algorithm: VerifiedAlgorithmResult | undefined;
      try {
        if (output.algorithmResult) {
          // 只从受信读取器重建原任务持久结果；不接受客户端 rows、参数或来源。
          algorithm = this.verifiedAlgorithm(output.algorithmResult);
          if (algorithm.bytes.byteLength > CANDIDATE_LIMITS.maxStructuredBytes) fail('CANDIDATE_ALGORITHM_BUDGET', '算法结果对象超过候选结构预算；未截断采用。');
          structured = this.saveObject(algorithm.bytes, 'application/json');
          evidence.algorithmResult = { reference: algorithm.reference, lineage: algorithm.lineage };
        } else if (output.processing) {
          const reader = this.options.processing?.();
          if (!reader) return fail('CANDIDATE_PROCESSING_UNAVAILABLE', '处理计划服务尚未装配，不能引用未完成产物。');
          const plan = reader.candidateOutput(output.processing.planId, output.processing.outputId);
          if (canonicalWfdJson([...plan.materialIds].sort()) !== canonicalWfdJson([...output.materialIds].sort())) {
            fail('CANDIDATE_PROCESSING_MATERIALS', '处理计划的输出原件集合与本候选不一致；未借用其他输出产物。');
          }
          if (canonicalWfdJson(targetBinding(plan.target)) !== canonicalWfdJson(targetBinding(output))) {
            fail('CANDIDATE_TARGET_BINDING', '候选目标或语义绑定与处理计划冻结目标不一致；须先建立关联新计划或显式目标绑定并重新核对，不能静默替换。');
          }
          const bytes = this.objectBytes(plan.ref);
          let parsed: { rows: WfdRecord[] };
          try { parsed = JSON.parse(bytes.toString('utf8')) as { rows: WfdRecord[] }; }
          catch { return fail('CANDIDATE_PROCESSING_ARTIFACT', '处理计划结构产物不是有效 JSON。'); }
          if (!Array.isArray(parsed.rows) || parsed.rows.length > CANDIDATE_LIMITS.maxRows) fail('CANDIDATE_ROW_BUDGET', '处理计划结构产物的行数超出候选预算。');
          structured = plan.ref;
          evidence.processingPlan = { planId: plan.planId, planDigest: plan.planDigest, executionDigest: plan.executionDigest,
            policy: plan.policy, routingState: plan.routingState, gaps: plan.gaps, steps: plan.steps, materials: plan.materials };
          processedSteps = plan.steps.map(step => ({ stage: step.kind, version: step.implementation, step_id: step.stepId,
            state: step.state, applicability: step.applicability, spec_digest: step.specDigest, output_sha256: step.outputDigest,
            reused_from: step.reusedFrom }));
        } else if (output.tables?.length) {
          const parts = output.tables.map(plan => prepareCandidateTable(this.options.materials.readOriginal(plan.materialId).bytes, plan));
          const rows = parts.flatMap(part => part.rows);
          if (rows.length > CANDIDATE_LIMITS.maxRows) fail('CANDIDATE_ROW_BUDGET', '合并后的完整表超过行数预算。');
          const bytes = Buffer.from(canonicalWfdJson({ rows }));
          if (bytes.byteLength > CANDIDATE_LIMITS.maxStructuredBytes) fail('CANDIDATE_OUTPUT_BUDGET', '合并后的结构结果超过预算。');
          structured = this.saveObject(bytes, 'application/json');
          processing = parts.flatMap(part => part.steps); evidence.parts = parts.map(part => part.evidence);
        } else issue = { category: 'missing', code: 'PARSING_NOT_DECLARED', path: 'tables', message: '尚未指定可支持的完整表源与处理规则；原件将独立保管。' };
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'PARSING_FAILED';
        if (code === 'CANDIDATE_TARGET_BINDING' || code === 'CANDIDATE_PROCESSING_MATERIALS'
          || code.startsWith('ALGORITHM_') || code.startsWith('CANDIDATE_ALGORITHM_')) throw error;
        issue = { category: 'unsupported', code,
          path: output.processing ? 'processing' : 'tables', message: error instanceof Error ? error.message : '处理产物无法使用' };
      }
      evidence.issue = issue ?? null;
      const proof = this.saveObject(Buffer.from(canonicalWfdJson(evidence)), 'application/json');
      const rawRefs = originals.map(({ materialId: _material, ...ref }) => ref);
      const algorithmInputs = algorithm ? algorithmFixedInputs(algorithm.lineage.source) : [];
      // WFD 派生产品的 processing 链首项必须等于 input_snapshots 的规范摘要；不使用其他内部摘要冒充。
      const algorithmInputHash = algorithm ? wfdSha256(canonicalWfdJson({ input_snapshots: algorithmInputs })) : null;
      const inputHash = algorithm ? algorithmInputHash!
        : output.declaration?.kind === 'derived' || output.inputs?.length
          ? wfdSha256(canonicalWfdJson({ input_snapshots: output.inputs ?? [] }))
          : wfdSha256(canonicalWfdJson({ objects: rawRefs.map(({ kind: _kind, ...ref }) => ref) }));
      let steps: WfdRecord[];
      if (algorithm) {
        steps = [{ stage: 'algorithm', version: algorithmVersion(algorithm.lineage.methodVersion), input_sha256: algorithmInputHash!,
          output_sha256: structured!.sha256, evidence_sha256: [proof.sha256] }];
      } else {
        let prior = inputHash;
        const conversions = (input.hostProcessing ?? []).filter(item => output.materialIds.includes(String(item.materialId)));
        const conversionSteps: WfdRecord[] = [];
        if (conversions.length) { const next = wfdSha256(canonicalWfdJson({ conversion_tasks: conversions })); conversionSteps.push({ stage: 'conversion', version: 'bd-fixed-task-evidence/1', input_sha256: prior, output_sha256: next, evidence_sha256: [proof.sha256] }); prior = next; }
        const stages = processedSteps ?? ['parse', 'clean', 'structure', 'annotate', 'check'].map(stage => ({ stage, version: stage === 'parse' ? 'bd-source-parsers/1' : 'bd-explicit-' + stage + '/1' }));
        const normalSteps = stages.map(stage => {
          const next = stage.stage === 'check' ? structured?.sha256 ?? proof.sha256 : wfdSha256(canonicalWfdJson({ stage: stage.stage,
            parts: processing.filter(step => step.stage === stage.stage).map(step => step.output_sha256) }));
          // WFD provenance.processing 只允许 stage/version/input_sha256/output_sha256/evidence_sha256；
          // 计划步骤的 step_id/state/applicability/实现与产物摘要保留在 processingPlan 证明对象中。
          const step = { stage: stage.stage, version: stage.version, input_sha256: prior, output_sha256: next, evidence_sha256: [proof.sha256] };
          prior = next; return step;
        });
        steps = [...conversionSteps, ...normalSteps];
      }
      const source = algorithm ? algorithmSource(algorithm.lineage, this.options.materials)
        : output.source ?? { source_id: 'material-set:' + wfdSha256(canonicalWfdJson(output.materialIds)), source_uri: null,
          observed_at: new Date(this.options.materials.get(output.materialIds[0]!).envelope.createdAt).toISOString() };
      const provenance = algorithm
        ? algorithmProvenance(algorithm.lineage, algorithmInputs, steps, proof.sha256, this.options.materials)
        : { producer_id: 'xuan-bd', method_version: CANDIDATE_PIPELINE_VERSION, implementation_sha256: this.versionBinding.implementation,
          parameters: { tables: output.tables ?? [], ...(output.processing ? { processing: output.processing } : {}),
            processing_versions: steps.map(step => ({ stage: step.stage, version: step.version })) },
          source, inputs: output.inputs ?? [], processing: steps };
      const planGaps = output.processing
        ? (isWfdRecord(evidence.processingPlan) && Array.isArray(evidence.processingPlan.gaps)
          ? (evidence.processingPlan.gaps as unknown[]).filter((value): value is string => typeof value === 'string') : [])
        : [];
      const coverageGaps = issue ? [String(issue.message)] : planGaps;
      const coverage = algorithm ? algorithmCoverage(algorithm.lineage, issue)
        : output.coverage ?? { complete: !!structured && coverageGaps.length === 0, gaps: coverageGaps,
          scope: output.processing ? '已完成的独立处理计划结构产物；业务语义和产品覆盖仍以计划缺口为准' : '明确选定的原件及完整表源；不外推产品全历史覆盖' };
      outputs.push({ output_id: output.outputId, namespace: output.namespace, expected_snapshot_id: output.expectedSnapshotId ?? null,
        ...(output.productRef ? { product_ref: output.productRef } : {}), ...(output.declaration ? { declaration: output.declaration } : {}),
        ...(structured ? { structured_result: structured } : {}), original_evidence: rawRefs, verification_evidence: [proof],
        provenance, coverage });
      reports.push({ outputId: output.outputId, state: structured ? 'prepared' : 'custody_only', originalMaterials: originals,
        structuredResult: structured ?? null, issues: issue ? [issue] : [], processingVersions: steps.map(step => ({ stage: step.stage, version: step.version })),
        ...(output.processing ? { processingPlan: { planId: output.processing.planId, outputId: output.processing.outputId } } : {}),
        ...(algorithm ? { algorithmResult: { taskId: algorithm.reference.taskId, resultDigest: algorithm.reference.resultDigest,
          objectSha256: algorithm.reference.objectSha256, rows: algorithm.lineage.rows, representation: algorithm.lineage.representation } } : {}) });
    }
    const result = { outputs, reports, databaseState: 'not_sent', preparedTaskId: context.task.id };
    this.db.prepare('UPDATE candidate_preparations SET result_json=? WHERE task_id=?').run(canonicalWfdJson(result), context.task.id);
    return this.result(context.task.id);
  }
  /**
   * 只接受受信宿主桥在本次 prepare 提供的确认函数；它重新读取原任务与原件，而不是在本服务的
   * 工作台任务库按编号猜任务。保管副本的 fileRefId 与个人原产物不同，因此只核对原产物摘要/大小
   * 与保管原件是否一致，不再拿工作台副本 ID 去原任务 artifactIds 里查。
   */
  private verifyHostProcessing(confirmation: HostProcessingConfirmation | undefined, input: CandidateInput): WfdRecord[] {
    if (!confirmation) return [];
    if (!isWfdRecord(confirmation) || !Array.isArray(confirmation.entries) || typeof confirmation.resolve !== 'function') {
      fail('CANDIDATE_HOST_PROCESSING', '宿主处理证据必须由受信宿主在本次准备时重新确认，不能来自客户端字段或 HTTP。');
    }
    const referenced = new Set(input.outputs.flatMap(output => output.materialIds));
    return confirmation.entries.map(raw => {
      if (!isWfdRecord(raw)) fail('CANDIDATE_HOST_PROCESSING', '宿主处理证据必须是明确对象。');
      let resolved: unknown;
      try { resolved = confirmation.resolve(raw); }
      catch (error) {
        if (error instanceof TaskError) throw error;
        fail('CANDIDATE_HOST_PROCESSING', '受信宿主无法重新核对原处理任务；未采用该证据。');
      }
      if (!isWfdRecord(resolved)) fail('CANDIDATE_HOST_PROCESSING', '受信宿主确认结果必须是明确对象。');
      const confirmed = resolved as { materialId?: unknown; taskId?: unknown; action?: unknown; versions?: unknown;
        resultDigest?: unknown; conversationId?: unknown; store?: unknown; artifact?: unknown };
      if (Object.keys(confirmed).some(key =>
        !['materialId', 'taskId', 'action', 'versions', 'resultDigest', 'conversationId', 'store', 'artifact'].includes(key))) {
        fail('CANDIDATE_HOST_PROCESSING', '受信宿主确认结果包含未登记字段。');
      }
      const materialId = id(confirmed.materialId), taskId = id(confirmed.taskId);
      if (materialId !== id(raw.materialId) || taskId !== id(raw.taskId)) {
        fail('CANDIDATE_HOST_PROCESSING', '受信宿主确认的任务或材料身份与本次请求不一致。');
      }
      if (!referenced.has(materialId)) fail('CANDIDATE_HOST_PROCESSING', '宿主处理证据必须引用本候选的原件。');
      if (confirmed.store !== 'personal') fail('CANDIDATE_HOST_PROCESSING', '宿主处理证据只接受已核对的个人原任务存储。');
      const action = confirmed.action, versions = confirmed.versions, resultDigest = confirmed.resultDigest, artifactValue = confirmed.artifact;
      if (typeof action !== 'string' || !/^(conversion\.|pdf\.extract$|image\.ocr$|audio\.transcribe$|material\.transcribe$)/.test(action)
        || !isWfdRecord(versions) || typeof resultDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(resultDigest)) {
        fail('CANDIDATE_HOST_PROCESSING', '宿主处理动作、版本或结果摘要格式无效。');
      }
      const conversationId = confirmed.conversationId;
      if (conversationId !== undefined && (typeof conversationId !== 'string' || !conversationId)) {
        fail('CANDIDATE_HOST_PROCESSING', '宿主处理证据的会话引用无效。');
      }
      if (!isWfdRecord(artifactValue)) fail('CANDIDATE_HOST_PROCESSING', '宿主处理证据缺少原产物对象。');
      const artifact = artifactValue as { fileRefId?: unknown; fileRefVersion?: unknown; sha256?: unknown; bytes?: unknown };
      if (Object.keys(artifact).some(key => !['fileRefId', 'fileRefVersion', 'sha256', 'bytes'].includes(key))
        || typeof artifact.fileRefId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(artifact.fileRefId)
        || !Number.isSafeInteger(artifact.fileRefVersion) || Number(artifact.fileRefVersion) < 1
        || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.bytes) || Number(artifact.bytes) < 1) {
        fail('CANDIDATE_HOST_PROCESSING', '宿主处理证据缺少原产物的文件引用、版本、摘要或大小。');
      }
      const artifactFileRefId = artifact.fileRefId as string, artifactSha256 = artifact.sha256 as string;
      const artifactBytes = Number(artifact.bytes), artifactVersion = Number(artifact.fileRefVersion);
      const material = this.options.materials.get(materialId);
      if (material.envelope.sha256 !== artifactSha256 || material.envelope.byteLength !== artifactBytes) {
        fail('CANDIDATE_HOST_PROCESSING', '宿主处理原产物与本次保管原件的摘要或大小不符；不能把其他副本或分支产物当作本候选原件。');
      }
      return { materialId, taskId, action, versions: versions as WfdRecord, resultDigest,
        ...(typeof conversationId === 'string' ? { conversationId } : {}),
        store: 'personal', artifact: { fileRefId: artifactFileRefId, fileRefVersion: artifactVersion,
          sha256: artifactSha256, bytes: artifactBytes } };
    });
  }
  /** 候选服务不依赖算法模块类型之外的任何计算；只调用惰性装配的只读读取器并复核字节。 */
  private verifiedAlgorithm(reference: AlgorithmResultReference): VerifiedAlgorithmResult {
    if (!isWfdRecord(reference) || Object.keys(reference).some(key => !['kind', 'taskId', 'resultDigest', 'objectSha256', 'byteLength', 'mediaType'].includes(key))
      || reference.kind !== 'algorithm-result' || typeof reference.taskId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(reference.taskId)
      || typeof reference.resultDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.resultDigest)
      || typeof reference.objectSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.objectSha256)
      || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 1 || reference.byteLength > CANDIDATE_LIMITS.maxStructuredBytes
      || reference.mediaType !== 'application/json') {
      fail('CANDIDATE_ALGORITHM_REFERENCE', '算法结果只接受原任务编号、持久结果摘要、对象摘要、字节长度和 JSON 媒体类型。');
    }
    const reader = this.options.algorithmReader?.();
    if (!reader) throw new TaskError('CANDIDATE_ALGORITHM_UNAVAILABLE', '受信算法结果读取器尚未装配；不能把客户端行冒充算法结果。');
    const verified = reader.readCandidateResult(reference);
    if (!verified || !Buffer.isBuffer(verified.bytes) || verified.reference.taskId !== reference.taskId
      || verified.reference.resultDigest !== reference.resultDigest || verified.reference.objectSha256 !== reference.objectSha256
      || verified.reference.byteLength !== reference.byteLength || verified.bytes.byteLength !== reference.byteLength
      || wfdSha256(verified.bytes) !== reference.objectSha256) {
      fail('CANDIDATE_ALGORITHM_RESULT', '受信读取器返回的原任务、结果摘要或对象字节与引用不符。');
    }
    return verified;
  }

  private reference(bytes: Uint8Array, mediaType: string): ObjectRef { return { kind: 'stored-object', sha256: wfdSha256(bytes), byte_length: bytes.byteLength, media_type: mediaType }; }
  saveObject(bytes: Buffer, mediaType: string) {
    const ref = this.reference(bytes, mediaType);
    this.db.prepare('INSERT OR IGNORE INTO candidate_objects VALUES(?,?,?)').run(ref.sha256, ref.byte_length, bytes); return ref;
  }
  objectBytes(ref: ObjectRef): Buffer {
    const row = this.db.prepare('SELECT bytes FROM candidate_objects WHERE sha256=?').get(ref.sha256);
    let bytes: Buffer | undefined = row?.bytes instanceof Uint8Array ? Buffer.from(row.bytes) : undefined;
    if (!bytes) {
      const record = this.db.prepare("SELECT material_id FROM material_objects WHERE json_extract(envelope_json,'$.sha256')=? LIMIT 1").get(ref.sha256);
      if (record) bytes = this.options.materials.readOriginal(String(record.material_id)).bytes;
    }
    if (!bytes || bytes.byteLength !== ref.byte_length || wfdSha256(bytes) !== ref.sha256) return fail('CANDIDATE_OBJECT_CHANGED', '冻结对象字节、大小或摘要不符。');
    return bytes;
  }
  private storeReceipt(taskId: string, receipt: WfdRecord) {
    if (!Array.isArray(receipt.outputs)) fail('CANDIDATE_RECEIPT', '数据库没有逐输出回执。');
    this.db.prepare('UPDATE candidate_submissions SET state=?,receipt_json=?,error_json=NULL,updated_at=? WHERE id=?').run(String(receipt.state), canonicalWfdJson(receipt), Date.now(), taskId);
  }
  private async fixedRead(taskId: string, receipt: WfdRecord, binding: GenericDatabaseBinding, signal?: AbortSignal, assert: () => void = () => {}) {
    const summaries: WfdRecord[] = [];
    const originalSubmission = this.baseSubmission(this.submission(taskId));
    const envelope = JSON.parse(originalSubmission.envelope_json) as GenericEnvelope;
    for (const output of receipt.outputs as WfdRecord[]) {
      if (output.state !== 'committed') continue;
      if (typeof output.commit_id !== 'string' || typeof output.snapshot_id !== 'string' || /^(latest|current)$/i.test(output.snapshot_id) || typeof output.product_id !== 'string') fail('CANDIDATE_COMMIT_IDENTITY', '已提交回执缺少真实提交和固定快照身份。');
      const original = (envelope.arguments.outputs as WfdRecord[]).find(item => item.output_id === output.output_id)!;
      const ref = original.structured_result as ObjectRef | undefined;
      if (!ref) fail('CANDIDATE_COMMIT_UNEXPECTED', '未提供结构结果却声称提交，不能采用。');
      const expected = JSON.parse(this.objectBytes(ref!).toString('utf8')) as { rows: WfdRecord[] }, rows: unknown[] = [];
      let cursor: unknown = undefined, frozen: string | undefined;
      do {
        assert(); const page = await binding.call(this.envelope(binding, 'data.read', 'read:' + randomUUID(), { product_id: output.product_id,
          snapshot_id: output.snapshot_id, limit: 1000, ...(cursor ? { cursor } : {}) }), signal);
        if (page.snapshot_id !== output.snapshot_id || page.commit_id !== output.commit_id || !Array.isArray(page.rows)
          || typeof page.rows_sha256 !== 'string' || frozen && frozen !== page.rows_sha256 || page.rows.length === 0 && page.next_cursor) fail('CANDIDATE_READBACK', '固定读回页的提交、快照或摘要身份不一致。');
        frozen = page.rows_sha256 as string; rows.push(...page.rows as unknown[]);
        if (rows.length > expected.rows.length || rows.length > CANDIDATE_LIMITS.maxRows) fail('CANDIDATE_READBACK', '固定读回行数超过原封闭结果。');
        cursor = page.next_cursor;
      } while (cursor);
      if (canonicalWfdJson(rows) !== canonicalWfdJson(expected.rows) || frozen !== wfdSha256(canonicalWfdJson(rows))) fail('CANDIDATE_READBACK', '固定快照内容与原结构结果未逐值匹配。');
      summaries.push({ outputId: output.output_id, state: 'verified', commitId: output.commit_id, snapshotId: output.snapshot_id, rows: rows.length, rowsSha256: frozen });
    }
    const terminal = (receipt.outputs as WfdRecord[]).every(output => ['committed', 'stored_not_committed', 'rejected', 'cancelled'].includes(String(output.state)));
    this.db.prepare('UPDATE candidate_submissions SET state=?,readback_json=?,updated_at=? WHERE id IN (?,?)').run(terminal ? 'verified' : String(receipt.state), canonicalWfdJson(summaries), Date.now(), taskId, originalSubmission.id);
  }
  private envelope(binding: GenericDatabaseBinding, operation: string, requestId: string, args: WfdRecord): GenericEnvelope {
    return { protocol_version: 3, contract_version: GENERIC_CONTRACT, instance_id: binding.instanceId, request_id: requestId, operation, arguments: args };
  }
  verifyObject(ref: ObjectRef): boolean { const row = this.db.prepare('SELECT byte_length FROM candidate_objects WHERE sha256=?').get(ref.sha256); return !!row && Number(row.byte_length) === ref.byte_length; }
  private result(taskId: string): TaskResult { return { summary: this.tasks.get(taskId).action === PREPARE ? '原件与明确规则已构造本地候选；尚未向数据库交接。' : '逐输出数据库事实已记录；正式提交与固定读回分别查看。', data: json(this.get(taskId)) as Record<string, JsonValue> }; }
  private requestTask(request: string) { const row = this.db.prepare('SELECT id FROM tasks WHERE request_id=?').get(request); return row ? this.tasks.get(String(row.id)) : null; }
  private assertSame(task: TaskRecord, args: unknown, parent?: string) { if (digestOperationArgs(task.args) !== digestOperationArgs(args) || task.parentTaskId !== (parent ?? null)) fail('REQUEST_CONFLICT', '同一候选请求不能换内容、规则或原任务。'); }
  private requireLines() { return this.options.lines ?? fail('CANDIDATE_DATABASE_UNBOUND', '没有已装配的数据库线路；本地候选可保留。'); }
  private assertVersion(task: TaskRecord) { if (Object.entries(this.versionBinding).some(([key, value]) => task.versions[key] !== value)) fail('CANDIDATE_VERSION_CHANGED', '原候选实现版本已变化，不能冒充原版本重新执行。'); }
  private assertDispatch() { if (this.tasks.getControl().stopped) fail('SERVICE_STOPPED', '数据服务已停止，未受理新的加工或交接。'); }
  private assertActive(context: TaskExecutionContext) { context.signal.throwIfAborted(); if (!this.tasks.isRunActive(context.runId, context.generation)) fail('TASK_NOT_ACTIVE', '当前候选任务已停止，未继续发布迟到结果。'); }
}

/** 算法结果谱系只能以 WFD 有界标识进入 provenance；不把内部版本号改写成别的含义。 */
function algorithmVersion(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)) fail('CANDIDATE_ALGORITHM_LINEAGE', '算法方法版本不是 WFD 有界标识。');
  return value;
}

function algorithmSource(lineage: AlgorithmResultLineage, materials: MaterialService): WfdRecord {
  const source = isWfdRecord(lineage.source) ? lineage.source : {};
  const resolution = isWfdRecord(source.resolution) ? source.resolution : {};
  const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null;
  const productId = text(resolution.productId) ?? text(source.productId);
  const materialId = text(source.materialId);
  const observedAt = text(resolution.committedAt)
    ?? (materialId ? new Date(materials.get(materialId).envelope.createdAt).toISOString() : null);
  if (!observedAt) fail('CANDIDATE_ALGORITHM_LINEAGE', '算法结果缺少真实固定快照提交时刻或原材料的持久创建时刻；不能以虚构时间提交。');
  const sourceId = productId ? 'wfd-fixed-snapshot:' + productId : materialId ? 'material:' + materialId : null;
  if (!sourceId) throw new TaskError('CANDIDATE_ALGORITHM_LINEAGE', '算法结果缺少真实来源产品、快照或受管材料谱系。');
  const source_id = sourceId.length <= 128 ? sourceId : productId ? 'wfd-fixed-snapshot' : 'managed-material';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(source_id)) throw new TaskError('CANDIDATE_ALGORITHM_LINEAGE', '算法来源编号不是 WFD 有界标识。');
  return { source_id,
    source_uri: null, observed_at: observedAt };
}

/** 只保留可进入 WFD 请求的字符串/安全整数身份；不把含 binary64 明细的 numeric 证据塞进 parameters。 */
function algorithmInputLineage(source: JsonValue): WfdRecord {
  if (!isWfdRecord(source)) throw new TaskError('CANDIDATE_ALGORITHM_LINEAGE', '算法结果缺少真实输入来源对象。');
  const resolution = isWfdRecord(source.resolution) ? source.resolution : {};
  const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null;
  const integer = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (source.kind === 'wfd_fixed_snapshot') {
    const instanceId = text(resolution.instanceId) ?? text(source.instanceId);
    const productId = text(resolution.productId) ?? text(source.productId);
    const snapshotId = text(resolution.snapshotId) ?? text(source.snapshotId);
    const commitId = text(resolution.commitId);
    const definitionRevision = text(resolution.definitionRevision) ?? text(source.definitionRevision);
    const definitionSha256 = text(resolution.definitionSha256);
    const rowsSha256 = text(resolution.rowsSha256);
    const rowCount = integer(resolution.rowCount);
    if (!instanceId || !productId || !snapshotId || !commitId || !definitionRevision || !definitionSha256
      || !rowsSha256 || rowCount === null) throw new TaskError('CANDIDATE_ALGORITHM_LINEAGE', '固定快照谱系缺少实例、产品、快照、定义、提交或行数；不能伪造输入。');
    return { kind: 'wfd_fixed_snapshot', instance_id: instanceId, product_id: productId, snapshot_id: snapshotId,
      commit_id: commitId, definition_revision: definitionRevision, definition_sha256: definitionSha256,
      rows_sha256: rowsSha256, row_count: rowCount, committed_at: text(resolution.committedAt),
      pages: integer(resolution.pages), verified_scope: text(resolution.verifiedScope) };
  }
  if (source.kind === 'managed_table') {
    const materialId = text(source.materialId), materialSha256 = text(source.materialSha256);
    const rowCount = integer(source.totalRows), selectedRows = integer(source.selectedRows);
    if (!materialId || !materialSha256 || rowCount === null || selectedRows === null) {
      throw new TaskError('CANDIDATE_ALGORITHM_LINEAGE', '受管表谱系缺少材料、摘要或行数；不能伪造输入。');
    }
    return { kind: 'managed_table', material_id: materialId, material_sha256: materialSha256,
      display_name: text(source.displayName), format: text(source.format), row_count: rowCount, selected_rows: selectedRows };
  }
  throw new TaskError('CANDIDATE_ALGORITHM_LINEAGE', '未登记的算法输入来源种类；不能伪造固定快照或 legacy input。');
}

/** 只把真实 data.read resolution 的五个身份字段作为 WFD input_snapshots；没有就返回空，不造假 legacy input。 */
function algorithmFixedInputs(source: JsonValue): WfdRecord[] {
  if (!isWfdRecord(source) || source.kind !== 'wfd_fixed_snapshot') return [];
  const resolution = isWfdRecord(source.resolution) ? source.resolution : {};
  const pick = (first: unknown, second: unknown): string | null => typeof first === 'string' && first ? first : typeof second === 'string' && second ? second : null;
  const instanceId = pick(resolution.instanceId, source.instanceId), productId = pick(resolution.productId, source.productId);
  const snapshotId = pick(resolution.snapshotId, source.snapshotId), commitId = pick(resolution.commitId, source.commitId);
  const rowsSha256 = pick(resolution.rowsSha256, source.rowsSha256);
  const identifier = (value: string | null) => !!value && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value) && !/^(latest|current)$/iu.test(value);
  if (!identifier(instanceId) || !identifier(productId) || !identifier(snapshotId) || !identifier(commitId)
    || !rowsSha256 || !/^[a-f0-9]{64}$/u.test(rowsSha256)) {
    fail('CANDIDATE_ALGORITHM_LINEAGE', '固定快照算法结果缺少真实实例、产品、快照、提交或 rows_sha256；不能伪造输入谱系。');
  }
  return [{ instance_id: instanceId, product_id: productId, snapshot_id: snapshotId, commit_id: commitId, rows_sha256: rowsSha256 }];
}

function algorithmProvenance(lineage: AlgorithmResultLineage, inputs: WfdRecord[], steps: WfdRecord[], proofSha256: string,
  materials: MaterialService): WfdRecord {
  const implementation = typeof lineage.implementationVersion === 'string' && lineage.implementationVersion.startsWith('sha256:')
    ? lineage.implementationVersion.slice(7) : '';
  if (!/^[a-f0-9]{64}$/u.test(implementation)) fail('CANDIDATE_ALGORITHM_LINEAGE', '算法结果缺少真实实现字节摘要。');
  return { producer_id: 'xuan-bd', method_version: algorithmVersion(lineage.methodVersion), implementation_sha256: implementation,
    parameters: { task_id: lineage.taskId, result_sha256: lineage.resultDigest, object_sha256: lineage.objectSha256,
      input_sha256: lineage.inputDigest, contract_version: lineage.contractVersion, environment: lineage.environment,
      method_id: lineage.methodId, method_version: lineage.methodVersion, implementation_version: lineage.implementationVersion,
      valid_interval: lineage.validInterval, invalid_intervals: lineage.invalidIntervals, coverage: lineage.coverage,
      gaps: lineage.gaps, representation: lineage.representation, verification_evidence_sha256: proofSha256,
      parameters: lineage.parameters, input_lineage: algorithmInputLineage(lineage.source) },
    source: algorithmSource(lineage, materials), inputs, processing: steps };
}

function algorithmCoverage(lineage: AlgorithmResultLineage, issue: WfdRecord | undefined): WfdRecord {
  const gaps = Array.isArray(lineage.gaps) ? lineage.gaps.map(item => isWfdRecord(item)
    ? String(item.message ?? item.code ?? '') : String(item)).filter(value => value.length > 0) : [];
  if (issue) gaps.push(String(issue.message));
  return { complete: lineage.validInterval !== null && lineage.validInterval !== undefined && !issue,
    gaps: gaps.slice(0, 256).map(value => value.slice(0, 4096)),
    scope: '原算法任务持久结果与其真实输入谱系；未重新计算、未扩大输入范围；空值表示预热或不可用，不表示零' };
}

/** 目标绑定必须逐字段一致；缺省与显式 null 归一，其他语义替换一律拒绝。 */
function targetBinding(target: { productRef?: WfdRecord; declaration?: WfdRecord; expectedSnapshotId?: string | null } | null) {
  return { productRef: target?.productRef ?? null, declaration: target?.declaration ?? null, expectedSnapshotId: target?.expectedSnapshotId ?? null };
}
