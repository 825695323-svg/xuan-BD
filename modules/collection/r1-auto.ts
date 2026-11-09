import type { R1ConnectionIdentity, R1DefinitionReview, R1RequestView, R1SnapshotStatus, R1SourceDeclaration } from '../../contracts/r1-contracts.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError, type TaskService } from '../../platform/jobs/tasks.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { MaterialService } from './materials/service.js';
import { readXlsxTableSelection, type XlsxTableSelection } from './data-processing/xlsx-table.js';
import { DIMENSION_KEYS } from './processing-routing.js';
import type { OperatorContext, ProcessingDimensionInput, ProcessingPlanInput, ProcessingPlanService } from './processing-plan.js';
import { declaredSourceSeries, resolveR1Evidence, type R1EvidenceFact, type R1EvidenceProposal, type R1EvidenceQuestion } from './r1-evidence.js';
import { profileFingerprint, sourceFieldProfileDigest, type FrozenSourceFieldProfile, type SourceFieldProfileStore,
  type SemanticProductRegistryStore } from './source-field-profile.js';
import { assertKnownR1Source, parseR1Utc } from './r1-structured-handoff.js';
import type { R1WorkspaceService } from './r1-workspace.js';
import { readSourceProjection } from './source-reported-table.js';
import { parseTableSource } from './candidate-pipeline.js';
import { decodeAdapterSource, readAdapterBindingRef, type AdapterBindingRef, type FrozenAdapterBinding } from './endpoint-adapter.js';
import type { EndpointAdapterRegistry } from './endpoint-adapter-registry.js';
import { sourceObservationMAAlgorithmDefinition, sourceObservationMACodeDigest, sourceObservationMAMethodVersion,
  type CalculatedMAProof, type SourceObservationMAContext, type SourceObservationMAInput, type SourceObservationMASelection } from './source-observation-ma.js';

export const R1_AUTO_VERSION = 'bd.r1-auto/2';
export interface R1AutoStartInput {
  requestId: string; materialId: string; source: R1SourceDeclaration; datasetId: string;
  priorRequestId?: string; xlsxSelection?: XlsxTableSelection; sourceValueColumns?: string[];
  /** 已采用端点适配引用；由宿主解析为冻结配置，请求正文不能携带配置内容。 */
  sourceAdapter?: AdapterBindingRef;
  /** 本材料实际取得回执摘要（url/材料摘要/请求参数）；发布用途必须核过匹配。 */
  sourceContext?: unknown;
  /** 已有来源任务编号；宿主按该任务结果核回执与文件关联。 */
  sourceReceiptTaskId?: string;
}
export type R1AutoState = 'inspecting' | 'awaiting_answers' | 'processing' | 'submitting' | 'recovering' | 'associated' | 'conflicts_pending' | 'blocked' | 'stopped';
export interface R1AutoReturn { code: string; message: string; scope: 'catalog' | 'processing'; snapshotId: string | null; productIds?: string[]; machineRequestId?: string }
export interface R1AutoView {
  requestId: string; materialId: string; source: R1SourceDeclaration; datasetId: string; state: R1AutoState;
  questions: R1EvidenceQuestion[]; evidence: R1EvidenceFact[]; planIds: string[]; requestIds: string[]; taskIds: string[];
  currentRequest: R1RequestView | null; localReturn: R1AutoReturn | null; wfdRejection: WfdRecord | null;
  error: { code: string; message: string } | null; parentSnapshotId: string | null; definitionAction: string | null;
  definitionReview: R1DefinitionReview | null;
  waitingForRequestId: string | null; waitingReason: string | null;
  createdAt: number; updatedAt: number;
}
interface Revision {
  proposal: R1EvidenceProposal; evidenceSha256: string; planTaskId: string | null; planId: string | null;
  runTaskId: string | null; handoffRequestId: string | null;
}
interface AutoRecord {
  selectedKeyReplacement?: true;
  /** 冻结的来源字段档案：原表头 → 标准字段/类型/单位；请求摘要已含其 digest。 */
  fieldProfile?: FrozenSourceFieldProfile;
  /** 本请求冻结的已采用适配；后续阶段按同一配置摘要核对，不换版本重放。 */
  adapter?: FrozenAdapterBinding;
  calculation?: { materialSha256: string; semanticCode: string; unit: string; subject: WfdRecord; timezone: string;
    proofSha256: string; codeDigest: string; definition: WfdRecord };
  version: typeof R1_AUTO_VERSION; input: R1AutoStartInput; inputSha256: string; materialSha256: string;
  connection: R1ConnectionIdentity; controlGeneration: number; operator: OperatorContext;
  state: R1AutoState; answers: Record<string, string>; questions: R1EvidenceQuestion[]; evidence: R1EvidenceFact[];
  snapshot: R1SnapshotStatus | null; catalog: { latest: WfdRecord | null; productIds: string[] } | null; revisions: Revision[];
  definitionReview: R1DefinitionReview | null;
  localReturn: R1AutoReturn | null; wfdRejection: WfdRecord | null; error: R1AutoView['error']; definitionAction: string | null;
  createdAt: number; updatedAt: number; queueOrder?: number;
}
function fail(code: string, message: string): never { throw new TaskError(code, message); }
const activeStates = new Set<R1AutoState>(['inspecting', 'processing', 'submitting']);
const taskActive = new Set(['running', 'waiting_approval', 'pausing', 'cancelling', 'blocked', 'awaiting_review']);
const recoverableTask = new Set(['needs_review', 'interrupted', 'paused']);
// An explicit rejection alone is insufficient: only these definition gaps may be reconsidered.
const definitionGaps = new Set(['DEFINITION_REQUIRED', 'DEFINITION_NOT_REGISTERED', 'FIELD_UNIT_REQUIRED',
  'UNIT_MEANING_REQUIRED', 'SEMANTIC_CONTEXT_REQUIRED', 'SEMANTIC_CONTENT_NATURE_REQUIRED',
  'SEMANTIC_TIME_PERIOD_REQUIRED', 'SEMANTIC_TIMEZONE_REQUIRED', 'SEMANTIC_FIELD_CONTEXT_UNKNOWN_FIELD',
  'SEMANTIC_CONTEXT_FIELD_UNSUPPORTED', 'SEMANTIC_CONTEXT_AXIS_INVALID', 'SEMANTIC_MEASUREMENT_NATURE_MISMATCH']);

/** Workflow journal only. Materials, processing artifacts, task control and WFD facts keep their existing owners. */
export class R1AutoService {
  private readonly listeners = new Set<(requestId: string) => void>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private unsubscribe?: () => void;
  private closed = false;
  constructor(private readonly options: { database: CoreDatabase; tasks(): TaskService; workspace: R1WorkspaceService;
    processing: ProcessingPlanService; materials: MaterialService; adapters?: EndpointAdapterRegistry;
    /** BD 来源字段档案；未装配时按原表头派生字段码。 */
    fieldProfiles?: SourceFieldProfileStore;
    /** 语义产品登记：指纹 → 正式数据集，用于跨来源复用与拒绝另立家族。 */
    semanticProducts?: SemanticProductRegistryStore }) {
    options.database.migrate('r1-auto', 1, `CREATE TABLE r1_auto_requests (
      request_id TEXT PRIMARY KEY,input_sha256 TEXT NOT NULL,record_json TEXT NOT NULL,updated_at INTEGER NOT NULL
    );`);
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }

  /** Called after the host has assembled TaskService and reconciled interrupted attempts. */
  attach(): void {
    if (this.unsubscribe || this.closed) return;
    this.unsubscribe = this.tasks.subscribe(({ task, event }) => {
      if (!['TASK_SUCCEEDED', 'TASK_FAILED', 'TASK_NEEDS_REVIEW', 'TASK_INTERRUPTED', 'TASK_RECONCILED', 'TASK_PAUSED', 'TASK_CANCELLED'].includes(event.type)) return;
      for (const item of this.records(true)) if (activeStates.has(item.state) && this.taskIds(item).includes(task.id)) this.schedule(item.input.requestId);
    });
    for (const item of this.records(true)) this.schedule(item.input.requestId);
  }

  start(value: unknown, operator: OperatorContext): R1AutoView {
    return this.startBound(readStart(value), operator);
  }

  /** Trusted batch entry: the selected keys form a complete, bounded replacement scope. */
  startReplacing(value: R1AutoStartInput, operator: OperatorContext): R1AutoView {
    return this.startBound(readStart(value), operator, undefined, true);
  }

  /** The public start route cannot provide a calculation, a proof, or an arbitrary definition. */
  startCalculated(value: R1AutoStartInput, proof: CalculatedMAProof, operator: OperatorContext): R1AutoView {
    const input = readStart(value);
    if (input.priorRequestId || input.xlsxSelection || input.sourceValueColumns || input.sourceAdapter || input.sourceContext || input.sourceReceiptTaskId
        || proof.method !== 'source_observation_ma' || proof.methodVersion !== sourceObservationMAMethodVersion(proof)) {
      fail('R1_MA_CALCULATED_INPUT', '派生交接须绑定本批均线、完整计算材料及固定方法版本。');
    }
    const binding = { materialSha256: proof.materialSha256, semanticCode: proof.derivativeSemanticCode, unit: proof.unitCode,
      subject: proof.subject, timezone: proof.timeZone, proofSha256: wfdSha256(canonicalWfdJson(proof)), codeDigest: proof.codeDigest,
      definition: sourceObservationMAAlgorithmDefinition(proof) };
    if (!this.find(input.requestId) && binding.codeDigest !== sourceObservationMACodeDigest()) fail('R1_MA_IMPLEMENTATION_CHANGED', '计算实现已变化，请核对原运行证明。');
    return this.startBound(input, operator, binding, proof.inputScope === 'frozen_series_snapshot');
  }

  private startBound(input: R1AutoStartInput, operator: OperatorContext, calculation?: AutoRecord['calculation'], selectedKeyReplacement = false): R1AutoView {
    const fieldProfile = this.options.fieldProfiles?.match({ sourceId: input.source.source_id, series: declaredSourceSeries(input.source) }) ?? null;
    const frozenProfile = fieldProfile
      ? { profile: fieldProfile, digest: sourceFieldProfileDigest(fieldProfile), fingerprint: profileFingerprint(fieldProfile) }
      : undefined;
    if (frozenProfile) {
      const registered = this.options.semanticProducts?.datasetFor(frozenProfile.fingerprint) ?? null;
      if (registered && registered !== input.datasetId) fail('R1_SEMANTIC_PRODUCT_CONFLICT',
        `该来源的语义指纹已登记为数据集 ${registered}；本次请求用 ${input.datasetId}，等于另立家族。请复用已登记数据集，或由操作者显式登记新语义。`);
    }
    const payload = { ...(calculation ? { input, calculation } : { input }), ...(frozenProfile ? { sourceFieldProfileSha256: frozenProfile.digest } : {}) };
    const digest = wfdSha256(canonicalWfdJson(selectedKeyReplacement ? { payload, selectedKeyReplacement } : payload));
    const existing = this.find(input.requestId);
    if (existing) {
      if (existing.inputSha256 !== digest) fail('R1_AUTO_REQUEST_CONFLICT', '原自动请求的材料、来源授权、选区和数据集已经冻结，不能覆盖。');
      const handoff=existing.revisions.at(-1)?.handoffRequestId;
      if(handoff&&['recovering','submitting'].includes(existing.state)&&['associated','partially_associated','conflicts_pending'].includes(this.options.workspace.get(handoff).state)) {
        existing.state=this.options.workspace.get(handoff).state==='associated'?'associated':'conflicts_pending';existing.error=null;this.save(existing);
      }
      return this.get(input.requestId);
    }
    if (input.priorRequestId) {
      const adopted = this.db.prepare("SELECT request_id FROM r1_auto_requests WHERE json_extract(record_json,'$.input.priorRequestId')=? LIMIT 1").get(input.priorRequestId);
      if (adopted) fail('R1_AUTO_PRIOR_ALREADY_CLAIMED', `原明确拒绝已由自动请求 ${adopted.request_id} 承接；请核对原续办，不换新编号重复办理。`);
    }
    this.assertDispatch();
    const connection = this.currentConnection(), material = this.options.materials.get(input.materialId);
    const original = this.options.materials.readOriginal(input.materialId);
    assertKnownR1Source(input.source);
    // 只接受已采用版本；配置内容在此冻结，后续阶段按同一摘要核对，不随登记更新漂移。
    const adapter = input.sourceAdapter
      ? (this.options.adapters ?? fail('R1_ADAPTER_UNAVAILABLE', '本实例未装配端点适配登记，不能按声明式适配交接。'))
        .resolve(input.sourceAdapter, { materialId: input.materialId,
          ...(input.sourceContext === undefined ? {} : { context: input.sourceContext }),
          ...(input.sourceReceiptTaskId === undefined ? {} : { sourceReceiptTaskId: input.sourceReceiptTaskId }) })
      : undefined;
    // 发布用途依赖匹配：没有本材料实际取得回执或与配置不符时，结构解析可另行办理，但不能据此发布。
    if (adapter && !(adapter.match?.verified === true || adapter.match?.consistent === true))
      fail('R1_ADAPTER_CONTEXT_REQUIRED', 'R1 发布用途须提供本材料取得回执或明确标注的合成上下文，并核过地址/协议/字段顺序/频率/复权/市场；未按已采用配置自动取得。');
    if (material.envelope.sha256 !== original.sha256) fail('R1_AUTO_MATERIAL_CHANGED', '原材料与保管摘要不同，未开始自动交接。');
    if (calculation && calculation.materialSha256 !== original.sha256) fail('R1_MA_RESULT_CHANGED', '受管派生材料与本批实际计算结果摘要不一致。');
    if (input.priorRequestId) this.assertPrior(input, connection, original.sha256, original.bytes.length);
    const now = Date.now();
    const record: AutoRecord = { ...(frozenProfile ? { fieldProfile: frozenProfile } : {}), ...(calculation ? { calculation } : {}), ...(adapter ? { adapter } : {}), ...(selectedKeyReplacement ? { selectedKeyReplacement: true } : {}), version: R1_AUTO_VERSION, input, inputSha256: digest, materialSha256: original.sha256,
      connection, controlGeneration: this.tasks.getControl().generation, operator: { ...operator, requestId: input.requestId },
      state: 'inspecting', answers: {}, questions: [], evidence: [], snapshot: null, catalog: null, revisions: [], definitionReview: null,
      localReturn: null, wfdRejection: input.priorRequestId ? this.options.workspace.get(input.priorRequestId).error : null,
      error: null, definitionAction: null, createdAt: now, updatedAt: now, queueOrder: this.nextQueueOrder() };
    this.db.prepare('INSERT INTO r1_auto_requests VALUES(?,?,?,?)').run(input.requestId, digest, canonicalWfdJson(record), now);
    this.schedule(input.requestId);
    return this.get(input.requestId);
  }

  /** Read the source version actually associated with this original. Each call stays in that fixed snapshot. */
  async readCalculationContext(autoRequestId: string): Promise<SourceObservationMAContext> {
    const item = this.require(autoRequestId); this.assertBinding(item); this.assertDispatch();
    const requestId = item.revisions.at(-1)?.handoffRequestId;
    if (item.state !== 'associated' || !requestId || item.calculation) fail('R1_MA_SOURCE_NOT_ASSOCIATED', '系列续算需要已核实的来源原报。');
    const request = this.options.workspace.get(requestId), associations = request.local.associations;
    const first = Array.isArray(associations) && isWfdRecord(associations[0]) ? associations[0] : null;
    if (typeof first?.product_id !== 'string') fail('R1_MA_SOURCE_ASSOCIATIONS', '原报产品身份尚未固定。');
    const status = await this.options.workspace.snapshotStatus();
    if (!status.snapshotId) fail('R1_MA_CONTEXT_BINDING', '系列续算没有可冻结的当前快照。');
    const parse = this.options.processing.get(request.planId).steps.find(step => step.kind === 'parse');
    const projection = readSourceProjection(parse?.parameters.sourceProjection);
    const versions: Record<string, string> = {}, cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      this.assertBinding(item); this.assertDispatch();
      const { result } = await this.options.workspace.readProduct({ snapshotId: status.snapshotId, productId: first.product_id,
        fields: [projection.fields[0]!.fieldCode], cursor });
      if (!Array.isArray(result.rows) || !isWfdRecord(result.page)) fail('R1_MA_CONTEXT_BINDING', '固定系列页无法核对。');
      for (const row of result.rows) {
        const ref = isWfdRecord(row) && isWfdRecord(row.record_ref) ? row.record_ref : null;
        if (typeof ref?.logical_key !== 'string' || typeof ref.revision_id !== 'string' || Object.hasOwn(versions, ref.logical_key))
          fail('R1_MA_CONTEXT_BINDING', '固定系列记录身份无效或重复。');
        versions[ref.logical_key] = ref.revision_id;
      }
      if (Object.keys(versions).length > 5000) fail('R1_MA_ROW_BUDGET', '系列当前快照超过 5000 行的完整重算预算；没有截断预热。');
      if (!result.page.has_more) break;
      const next = result.page.next_cursor;
      if (typeof next !== 'string' || !next || cursors.has(next)) fail('R1_MA_CONTEXT_BINDING', '系列分页游标未推进。');
      cursors.add(next); cursor = next;
    } while (true);
    return { snapshotId: status.snapshotId, productId: first.product_id, versions };
  }

  async readCalculationInput(ref: { materialId: string; autoRequestId: string }, selection: SourceObservationMASelection): Promise<SourceObservationMAInput> {
    const item = this.require(ref.autoRequestId);
    this.assertBinding(item);
    const handoffId = item.revisions.at(-1)?.handoffRequestId;
    if (item.state !== 'associated' || !handoffId || item.input.materialId !== ref.materialId || item.calculation) {
      fail('R1_MA_SOURCE_NOT_ASSOCIATED', '均线输入须来自本批已固定读回的原始来源表。');
    }
    const request = this.options.workspace.get(handoffId);
    const associations = request.local.associations;
    if (request.state !== 'associated' || !Array.isArray(associations) || !associations.length
        || associations.length !== new Set((Array.isArray((request.local.receipt as WfdRecord | undefined)?.rows) ? (request.local.receipt as WfdRecord).rows as WfdRecord[] : []).map(row => row.record_id)).size || !associations.every(isWfdRecord)) {
      fail('R1_MA_SOURCE_ASSOCIATIONS', '本件来源记录版本尚未完整关联。');
    }
    const { product_id: productId, snapshot_id: snapshotId } = associations[0]!;
    const versions = new Map<string, string>();
    for (const association of associations) {
      if (association.product_id !== productId || association.snapshot_id !== snapshotId
          || typeof association.record_id !== 'string' || typeof association.record_version !== 'string' || versions.has(association.record_id)) {
        fail('R1_MA_SOURCE_ASSOCIATIONS', '本件来源记录的产品、固定快照或逐行业务键不一致。');
      }
      versions.set(association.record_id, association.record_version);
    }
    const parse = this.options.processing.get(request.planId).steps.find(step => step.kind === 'parse');
    if (!parse || parse.parameters.materialId !== ref.materialId || !parse.parameters.sourceProjection) {
      fail('R1_MA_SOURCE_PROJECTION', '均线需要已冻结的来源原报日期、身份及数值原列映射。');
    }
    const projection = readSourceProjection(parse.parameters.sourceProjection);
    // 均线复核必须沿用原件实际格式与冻结适配；适配 JSON/JSONP 原件不能按 CSV 重读。
    const parseFormat = parse.parameters.format;
    if (parseFormat !== 'csv' && parseFormat !== 'json') fail('R1_MA_SOURCE_FORMAT', '均线来源计划缺少明确载体格式。');
    const frozenAdapter = parse.parameters.sourceAdapter;
    if (frozenAdapter !== undefined && !isWfdRecord(frozenAdapter)) fail('R1_MA_SOURCE_FORMAT', '均线来源计划的适配绑定无效。');
    const columns = [...new Set([...projection.keyColumns, selection.valueColumn])];
    const fieldCodes = columns.map(column => projection.fields.find(field => field.column === column)?.fieldCode
      ?? fail('R1_MA_SOURCE_COLUMN', `原报发布字段中没有本批均线所需的「${column}」。`));
    const fixedRows: WfdRecord[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      this.assertDispatch(); this.assertBinding(item);
      const response = await this.options.workspace.readProduct({ snapshotId, productId, fields: fieldCodes, cursor });
      const result = response.result;
      if (!Array.isArray(result.rows) || !isWfdRecord(result.page)) fail('R1_MA_READBACK', 'WFD 固定页缺少记录或分页声明。');
      for (const row of result.rows) {
        if (!isWfdRecord(row) || !isWfdRecord(row.record_ref)) fail('R1_MA_READBACK', 'WFD 记录缺少固定身份。');
        const ref = row.record_ref;
        if (typeof ref.logical_key !== 'string' || !versions.has(ref.logical_key)) continue;
        if (ref.product_id !== productId || ref.snapshot_id !== snapshotId || ref.revision_id !== versions.get(ref.logical_key)) {
          fail('R1_MA_SOURCE_REVISION', '固定读取中的记录版本与已关联原件不符。');
        }
        fixedRows.push(row); versions.delete(ref.logical_key);
      }
      if (!versions.size || !result.page.has_more) break;
      const next = result.page.next_cursor;
      if (typeof next !== 'string' || !next || cursors.has(next)) fail('R1_MA_READBACK', '来源固定分页的游标未推进。');
      cursors.add(next); cursor = next;
    } while (true);
    if (versions.size) fail('R1_MA_INCOMPLETE_READBACK', `均线仍有 ${versions.size} 条原件关联缺少对应固定记录。`);
    const material = this.options.materials.readOriginal(ref.materialId);
    if (material.sha256 !== item.materialSha256) fail('R1_AUTO_MATERIAL_CHANGED', '均线输入原件已偏离保管身份。');
    return { materialId: ref.materialId, original: material.bytes, source: item.input.source, projection, request, fixedRows,
      format: parseFormat, ...(frozenAdapter ? { sourceAdapter: frozenAdapter as unknown as FrozenAdapterBinding } : {}) };
  }

  list(): R1AutoView[] { return this.records().map(item => this.view(item)); }
  get(requestId: string): R1AutoView { return this.view(this.require(requestId)); }
  isAssociated(requestId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM r1_auto_requests WHERE request_id=? AND json_extract(record_json,'$.state')='associated'").get(requestId);
  }
  resumeAccepted(requestId:string,lookupId:string,confirmationDigest:string) {
    const item=this.require(requestId);this.assertBinding(item);this.assertDispatch();
    const handoff=item.revisions.at(-1)?.handoffRequestId;
    if(!handoff)fail('R1_ORIGINAL_NOT_ACCEPTED','本件尚无原交接文档，不创建新提交。');
    return this.options.workspace.resumeAccepted(handoff,lookupId,confirmationDigest);
  }
  subscribe(listener: (requestId: string) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  answer(requestId: string, value: unknown, operator: OperatorContext): R1AutoView {
    this.assertDispatch(); const item = this.require(requestId); this.assertBinding(item);
    const body = object(value, ['answers']);
    if (!isWfdRecord(body.answers) || !Object.keys(body.answers).length || Object.keys(body.answers).length > 128) fail('R1_AUTO_ANSWERS', '需要按待答字段提供有界文本。');
    const answers = body.answers;
    if (this.pending.has(requestId)) fail('R1_AUTO_BUSY', '原自动阶段正在收束，请等待后补答。');
    for (const [key, answer] of Object.entries(answers)) {
      if (typeof answer !== 'string' || !answer.trim() || answer.length > 2000 || /[\u0000-\u001f]/u.test(answer)) fail('R1_AUTO_ANSWERS', '补答需要有界、非空文本。');
      if (Object.hasOwn(item.answers, key)) {
        if (item.answers[key] !== answer) fail('R1_AUTO_ANSWER_FROZEN', '已保存的补答不能被覆盖；请保留原证据后另行办理。');
      } else if (!item.questions.some(question => question.key === key)) fail('R1_AUTO_ANSWERS', '只接受当前真实语义问题，不能注入目标、路径或权限。');
    }
    if (item.state !== 'awaiting_answers') {
      if (Object.entries(answers).every(([key, answer]) => item.answers[key] === answer)) return this.view(item);
      fail('R1_AUTO_ANSWERS', '当前没有待补语义问题。');
    }
    const merged = { ...item.answers, ...answers } as Record<string, string>;
    const checked = this.resolve({ ...item, answers: merged });
    if (checked.questions.some(question => Object.hasOwn(answers, question.key))) fail('R1_AUTO_ANSWERS', '补答不符合该字段的格式或选项，原有效证据保留，请修正这次补答。');
    for (const [key, answer] of Object.entries(merged)) if (key.startsWith('contractRevisionBasis:')
      && (answer.trim().length < 8 || /^(yes|同意|确认|允许|ok)$/iu.test(answer.trim()))) fail('R1_AUTO_REVISION_EVIDENCE', '需要具体来源与口径修订依据，确认词不能替代新证据。');
    item.answers = merged;
    // No document has been frozen or submitted at this point. Other files may have
    // published while this file awaited an answer. Review the now-current head
    // before building its first plan; never rebase an existing handoff.
    if (!item.revisions.length) {
      item.snapshot = null;
      item.catalog = null;
      item.definitionReview = null;
    }
    item.operator = { ...operator, requestId: item.input.requestId };
    item.controlGeneration = this.tasks.getControl().generation;
    item.state = 'inspecting'; item.error = null; item.queueOrder = this.nextQueueOrder(); this.save(item); this.schedule(requestId);
    return this.get(requestId);
  }

  /** Explicit continuation also performs original-identity recovery, never a second submit. */
  async advance(requestId: string): Promise<R1AutoView> {
    this.assertDispatch(); const item = this.require(requestId); this.assertBinding(item);
    if (item.state === 'associated' || item.state === 'conflicts_pending' || item.state === 'awaiting_answers') return this.view(item);
    if (item.state === 'blocked') return this.view(item);
    item.controlGeneration = this.tasks.getControl().generation;
    if (item.state === 'stopped') { item.state = item.revisions.length ? 'processing' : 'inspecting'; item.queueOrder = this.nextQueueOrder(); }
    this.save(item); await this.schedule(requestId, true); return this.get(requestId);
  }

  async dispose(): Promise<void> {
    this.closed = true; this.unsubscribe?.(); this.unsubscribe = undefined; this.dirty.clear();
    await Promise.allSettled([...this.pending.values()]);
    this.listeners.clear();
  }

  private schedule(requestId: string, explicit = false): Promise<void> {
    if (this.closed) return Promise.resolve();
    const current = this.pending.get(requestId);
    if (current) { this.dirty.add(requestId); return current; }
    const work = Promise.resolve().then(async () => {
      do { this.dirty.delete(requestId); await this.progress(requestId, explicit); }
      while (!this.closed && this.dirty.has(requestId) && activeStates.has(this.require(requestId).state));
    }).catch(error => {
      if (this.closed) return;
      const item = this.require(requestId);
      item.error = errorView(error);
      item.state = /STOPPED|SERVICE_CLOSED/u.test(item.error.code) ? 'stopped' : item.state === 'recovering' ? 'recovering' : 'blocked'; this.save(item);
    }).finally(() => { this.pending.delete(requestId); this.notify(requestId); });
    this.pending.set(requestId, work); return work;
  }

  private async progress(requestId: string, explicit: boolean): Promise<void> {
    const item = this.require(requestId); this.assertActive(item);
    if (['associated', 'conflicts_pending', 'awaiting_answers', 'blocked', 'stopped'].includes(item.state)) return;
    if (this.queueHead()?.input.requestId !== requestId) return;
    if (!item.snapshot) {
      const snapshot = await this.options.workspace.snapshotStatus(); this.assertActive(item);
      item.snapshot = snapshot;
      // Only an authoritative empty-store response permits the null parent.
      this.assertActive(item); this.save(item);
    }
    if (!item.revisions.length) {
      let resolved = this.resolve(item);
      if (item.calculation) this.bindCalculatedDefinition(item.calculation, resolved);
      else if (resolved.proposal && String(resolved.proposal.target.definition.semantic_code).startsWith('derived.source_observation_ma.')) {
        fail('R1_MA_PROOF_REQUIRED', '本地均线产品族只接受从已发布原行计算并核对了证明的派生材料。');
      }
      const family = resolved.sourceFamilyHint;
      const target = resolved.proposal?.target;
      if (!item.catalog && (family || target)) {
        const discovery = item.snapshot.snapshotId ? await this.options.workspace.discoverProducts({ snapshotId: item.snapshot.snapshotId }) : null;
        this.assertActive(item);
        const subject = family ? { kind: 'entity', namespace: item.connection.namespace, id: family.subjectId } : target!.subject;
        const semanticCode = family?.semanticCode ?? target!.definition.semantic_code;
        const authority = family ? item.connection.namespace : target!.definition.definition_authority;
        const candidates = (discovery?.products ?? []).filter(product => product.dataset_id === item.input.datasetId && product.logical_domain === 'observations'
          && canonicalWfdJson(product.subject) === canonicalWfdJson(subject) && product.payload_kind === 'tabular_rows'
          && isWfdRecord(product.declaration) && product.declaration.semantic_code === semanticCode
          && product.declaration.definition_authority === authority)
          .sort((a, b) => Number(b.definition_sequence ?? 0) - Number(a.definition_sequence ?? 0));
        item.catalog = { latest: candidates[0] ?? null, productIds: [...new Set(candidates.map(product => String(product.product_id)))].sort() };
      }
      if (family && item.catalog?.latest) {
        const keys = registeredSourceKeys(item.catalog.latest);
        if (keys && isWfdRecord(item.catalog.latest.declaration)) {
          const definitions = [...fields(item.catalog.latest.declaration)];
          const units = Object.fromEntries(definitions.map(([code, field]) => [code, String(field.unit_code)]));
          const types: Record<string, 'decimal' | 'integer' | 'boolean' | 'text'> = {};
          for (const [code, field] of definitions) {
            const type = field.data_type;
            if (type === 'text' || type === 'decimal' || type === 'integer' || type === 'boolean') types[code] = type;
          }
          resolved = this.resolve(item, keys, units, types, publicDefinition(item.catalog.latest.declaration));
        }
      }
      item.questions = resolved.questions; item.evidence = resolved.evidence;
      if (resolved.questions.length) { item.state = 'awaiting_answers'; this.save(item); return; }
      if (!resolved.proposal) fail('R1_AUTO_EVIDENCE', '没有足够证据形成目标定义。');
      const proposal = resolved.proposal;
      proposal.dimensions.purpose = item.input.source.usage_scope;
      item.definitionReview ??= await this.options.workspace.reviewDefinition({ snapshotId: item.snapshot.snapshotId,
        datasetId: item.input.datasetId, subject: proposal.target.subject, semanticCode: String(proposal.target.definition.semantic_code),
        fieldCodes: proposal.mapping.fields.map(field => field.fieldCode) });
      this.assertActive(item); this.save(item);
      this.selectDefinition(item, proposal);
      if (item.questions.length) { item.state = 'awaiting_answers'; this.save(item); return; }
      this.checkUnits(item, proposal);
      if (item.input.priorRequestId) {
        const prior = this.options.workspace.get(item.input.priorRequestId);
        if (!definitionRejection(prior.error)) fail('R1_AUTO_REJECTION_NOT_DEFINITION', '原请求拒绝不属于已明确的定义缺口，保留原回执，不自动修订重送。');
        const previous = this.options.processing.get(prior.planId).outputs.find(output => output.outputId === prior.outputId)?.target?.declaration;
        if (isWfdRecord(previous) && isWfdRecord(previous.target)
          && comparableDefinition(previous.target.definition as WfdRecord) === comparableDefinition(proposal.target.definition)
          && canonicalWfdJson(previous.mapping) === canonicalWfdJson(proposal.mapping)) fail('R1_AUTO_NO_NEW_EVIDENCE', '新证据没有改变被拒绝的定义或映射，不生成同内容的新身份重送。');
      }
      item.revisions.push({ proposal, evidenceSha256: wfdSha256(canonicalWfdJson(item.evidence)), planTaskId: null,
        planId: null, runTaskId: null, handoffRequestId: null });
      item.state = 'processing'; this.save(item);
    }
    const revision = item.revisions.at(-1)!;
    if (!revision.planTaskId) {
      this.assertActive(item);
      const plan = this.plan(item, revision.proposal), operator = this.operator(item, 'plan');
      const priorPlanId = item.input.priorRequestId ? this.options.workspace.get(item.input.priorRequestId).planId : null;
      const task = priorPlanId ? this.options.processing.revisePlan(priorPlanId, plan, operator) : this.options.processing.preparePlan(plan, operator);
      revision.planTaskId = task.id; this.save(item);
    }
    if (!await this.localTask(item, revision.planTaskId, explicit)) return;
    revision.planId = this.options.processing.getByTask(revision.planTaskId)?.plan?.planId ?? fail('R1_AUTO_PLAN_MISSING', '原计划任务完成但没有持久计划。');
    if (!revision.runTaskId) {
      this.assertActive(item);
      revision.runTaskId = this.options.processing.runPlan(revision.planId, this.operator(item, 'run')).id; this.save(item);
    }
    if (!await this.localTask(item, revision.runTaskId, explicit)) return;
    const output = this.options.processing.get(revision.planId).outputs[0];
    if (!output?.publishEligible) {
      item.localReturn = { code: 'R1_AUTO_PROCESSING_RETURN', message: output?.gaps.join('；') || '实际五步产物尚未具备发布资格。',
        scope: 'processing', snapshotId: item.snapshot.snapshotId };
      this.save(item);
      fail('R1_AUTO_PROCESSING_RETURN', item.localReturn.message);
    }
    const handoffId = revision.handoffRequestId ?? this.phaseId(item, 'handoff');
    this.assertActive(item);
    const request = await this.options.workspace.prepareWithRestriction({ requestId: handoffId, planId: revision.planId, outputId: 'observations',
      source: item.input.source, target: revision.proposal.target, mapping: revision.proposal.mapping });
    revision.handoffRequestId = handoffId;
    if (!request.submitTaskId) {
      item.state = 'submitting'; this.save(item); this.assertActive(item);
      this.options.workspace.submit(handoffId, request.documentSha256); this.save(item); return;
    }
    if (['associated','partially_associated','conflicts_pending'].includes(request.state)) { item.state = request.state === 'associated' ? 'associated' : 'conflicts_pending'; item.error = null; this.save(item); return; }
    if (request.state === 'rejected') {
      item.wfdRejection = request.error;
      item.error = { code: 'R1_WFD_REJECTED', message: 'WFD 已明确拒绝。原请求、计划和回执保留；只有新的定义证据才能另行办理。' };
      // All evidence in this immutable source was already used. No new definition can be justified by a generic confirmation.
      item.questions = []; item.state = 'blocked';
      this.save(item); return;
    }
    let task = this.tasks.get(request.submitTaskId);
    if (task.status === 'ready') { this.assertActive(item); this.tasks.start(task.id, task.version); return; }
    if (request.state === 'prepared' && task.status === 'interrupted' && task.error?.code === 'PROCESS_INTERRUPTED') {
      this.assertActive(item); this.tasks.resume(task.id, task.version); return;
    }
    if (taskActive.has(task.status)) { item.state = 'submitting'; this.save(item); return; }
    if (request.requiresRecovery || recoverableTask.has(task.status)) {
      item.state = 'recovering'; this.save(item);
      this.assertActive(item); await this.options.workspace.recover(handoffId, this.phaseId(item, 'lookup'));
      this.assertActive(item);
      const recovered = this.options.workspace.get(handoffId);
      if (['associated','partially_associated','conflicts_pending'].includes(recovered.state)) { item.state = recovered.state === 'associated' ? 'associated' : 'conflicts_pending'; item.error = null; }
      else if (recovered.state === 'rejected') { item.state = 'blocked'; item.wfdRejection = recovered.error; item.error = { code: 'R1_WFD_REJECTED', message: '原 identity 已核对为明确拒绝，没有重新提交。' }; }
      else item.error = { code: 'R1_AUTO_RECOVERY_PENDING', message: '原提交事实尚未核清，继续保留原 identity，不生成新请求重发。' };
      this.save(item); return;
    }
    if (task.status === 'cancelled' || task.status === 'paused') { item.state = 'stopped'; this.save(item); return; }
    fail(request.error?.code as string || task.error?.code || 'R1_AUTO_SUBMIT_FAILED', String(request.error?.message || task.error?.message || '原交接失败，未按缺语义重送。'));
  }

  private resolve(item: AutoRecord, registeredKeyColumns?: string[], registeredUnits?: Record<string, string>,
    registeredTypes?: Record<string, 'decimal' | 'integer' | 'boolean' | 'text'>, registeredSourceDefinition?: WfdRecord) {
    const material = this.options.materials.get(item.input.materialId), original = this.options.materials.readOriginal(item.input.materialId);
    if (original.sha256 !== item.materialSha256) fail('R1_AUTO_MATERIAL_CHANGED', '原件摘要变化，未重新解释或提交。');
    const resolved = resolveR1Evidence({ material, original: original.bytes, calculatedMaterial: !!item.calculation, answers: Object.fromEntries(Object.entries(item.answers).filter(([key]) => !key.startsWith('contractRevisionBasis:'))),
      namespace: item.connection.namespace, datasetId: item.input.datasetId, parentSnapshotId: item.snapshot?.snapshotId ?? null, source: item.input.source, sourceValueColumns: item.input.sourceValueColumns, registeredKeyColumns, registeredUnits, registeredTypes, registeredSourceDefinition,
      ...(item.input.xlsxSelection ? { xlsxSelection: item.input.xlsxSelection } : {}),
      ...(item.adapter ? { sourceAdapter: item.adapter } : {}),
      ...(item.fieldProfile ? { sourceFieldProfile: item.fieldProfile } : {}) });
    if (item.selectedKeyReplacement && resolved.proposal && !resolved.questions.length) {
      const proposal = resolved.proposal;
      const parsed = parseTableSource(original.bytes, { materialId: item.input.materialId, format: proposal.format,
        ...(proposal.sourceProjection ? { sourceProjection: proposal.sourceProjection } : {}) });
      const column = parsed.columns.indexOf(proposal.mapping.businessKey);
      const keys = parsed.rows.map(row => row[column]?.value);
      if (keys.some(value => typeof value !== 'string' || !value) || new Set(keys).size !== keys.length)
        fail('R1_REPLACEMENT_KEYS', '所选更正范围的原业务键缺失或重复，未扩大到整个产品。');
      proposal.target.inputMode = 'complete_snapshot';
      proposal.target.coverage = { scope: { business_keys: keys }, basis: 'declared_full', completeness: 'complete', absence_means: 'explicitly_absent' };
    }
    return resolved;
  }

  private bindCalculatedDefinition(binding: NonNullable<AutoRecord['calculation']>, resolved: ReturnType<typeof resolveR1Evidence>): void {
    const proposal = resolved.proposal;
    if (!proposal || resolved.questions.length) fail('R1_MA_RESULT_CONTRACT', '本机均线输出未满足自己的字段合同，不能用操作者补答替代计算结果。');
    const definition = proposal.target.definition;
    if (proposal.target.outputKey !== binding.semanticCode || canonicalWfdJson(proposal.target.subject) !== canonicalWfdJson(binding.subject)
        || proposal.mapping.sourceTimezone !== binding.timezone || fields(definition).get('value')?.unit_code !== binding.unit) {
      fail('R1_MA_RESULT_CONTRACT', '生成材料的产品、单位、时间或主体与固定计算证明不符。');
    }
    const context = definition.semantic_context;
    if (!isWfdRecord(context)) fail('R1_MA_RESULT_CONTRACT', '生成材料缺少语义合同。');
    context.content_nature = 'deterministic_derived';
    definition.measurement_nature = 'derived';
    definition.algorithm_definition = binding.definition;
    proposal.dimensions.role = 'calculated_result';
    proposal.dimensions.informationNature = 'deterministic_derived';
    const nature = resolved.evidence.find(fact => fact.key === 'content_nature');
    if (nature) nature.value = 'deterministic_derived';
    resolved.evidence.push({ key: 'calculation.proof_sha256', value: binding.proofSha256, origin: 'contract' },
      { key: 'calculation.implementation_sha256', value: binding.codeDigest, origin: 'contract' });
  }

  private selectDefinition(item: AutoRecord, proposal: R1EvidenceProposal): void {
    const definition = proposal.target.definition;
    const product = item.catalog?.latest;
    const review = item.definitionReview ?? fail('R1_AUTO_REVIEW_MISSING', '没有 WFD 实际契约预检回执，未自动登记定义。');
    const productIds = item.catalog?.productIds ?? [];
    if (canonicalWfdJson([...review.productIds].sort()) !== canonicalWfdJson(productIds)
      || (review.code === 'FAMILY_DEFINITION_REQUIRED') !== !product) fail('R1_AUTO_REVIEW_CONFLICT', 'WFD 预检与固定目录中的产品身份不一致，未推断新族或重送。');
    const expectedMissing = proposal.mapping.fields.map(field => field.fieldCode).filter(code => !product || !fields(product.declaration as WfdRecord).has(code));
    if (canonicalWfdJson([...expectedMissing].sort()) !== canonicalWfdJson([...review.missingFields].sort())) fail('R1_AUTO_REVIEW_CONFLICT', 'WFD 预检与最新固定定义的字段覆盖不一致，未自动采用。');
    if (review.disposition === 'return_to_bd') item.localReturn = { code: review.code,
      message: review.code === 'FAMILY_DEFINITION_REQUIRED' ? 'WFD 实际契约预检退回：固定目录没有此产品族；BD 按本次原材料证据登记定义后交接。'
        : 'WFD 实际契约预检退回：既有定义未覆盖本次明确字段；BD 按原件证据修订定义后交接。',
      scope: 'catalog', snapshotId: review.snapshotId, productIds: review.productIds, machineRequestId: review.machineRequestId };
    if (!product) {
      item.definitionAction = 'create_from_evidence'; return;
    }
    const old = publicDefinition(product.declaration as WfdRecord), proposed = publicDefinition(definition);
    item.evidence.push({ key: 'definition_predecessor', value: canonicalWfdJson({ productId: product.product_id,
      definitionRef: product.definition_ref, snapshotId: item.snapshot!.snapshotId }), origin: 'contract' });
    if (comparableDefinition(old) === comparableDefinition(proposed)) {
      proposal.target.definition = old; item.definitionAction = 'reuse_same_definition'; return;
    }
    const oldFields = fields(old), newFields = fields(proposed);
    const additive = canonicalWfdJson(withoutFields(old)) === canonicalWfdJson(withoutFields(proposed))
      && [...oldFields].every(([key, value]) => newFields.has(key) && sameFieldScope(old, proposed, key, value, newFields.get(key)!));
    if (additive) { item.definitionAction = 'evolve_additive_definition'; return; }
    const subset = newFields.size < oldFields.size && canonicalWfdJson(withoutFields(old)) === canonicalWfdJson(withoutFields(proposed))
      && [...newFields].every(([key, value]) => oldFields.has(key) && sameFieldScope(old, proposed, key, oldFields.get(key)!, value));
    if (subset) {
      item.localReturn = { code: 'R1_AUTO_PARTIAL_FIELD_OBSERVATION', message: 'WFD 已有定义覆盖本次字段，但原件只观察了其中一部分。请提供缺字段的实际值或明确缺失状态；未删除旧字段、改写合同或编造空值。',
        scope: 'processing', snapshotId: item.snapshot!.snapshotId, productIds };
      this.save(item); fail(item.localReturn.code, item.localReturn.message);
    }
    item.localReturn = { code: 'R1_AUTO_DEFINITION_CONFLICT', message: '同族已有定义与新原件声明不可直接等同，需要新口径的明确来源依据。',
      scope: 'catalog', snapshotId: item.snapshot!.snapshotId, productIds: [String(product.product_id)] };
    const key = 'contractRevisionBasis:' + wfdSha256(canonicalWfdJson([old, proposed])).slice(0, 20);
    if (!item.answers[key]) {
      item.questions.push({ key, label: `同语义码 ${definition.semantic_code} 的旧定义与本次原件口径不同，请说明本次新口径的来源与修订依据；不会覆盖原定义或改换语义码` }); return;
    }
    if (item.answers[key].trim().length < 8 || /^(yes|同意|确认|允许|ok)$/iu.test(item.answers[key].trim())) fail('R1_AUTO_REVISION_EVIDENCE', '需要具体来源与口径修订依据，确认词不能替代新证据。');
    item.evidence.push({ key, value: item.answers[key], origin: 'operator' }); item.definitionAction = 'evolve_explicit_revision';
  }

  private checkUnits(item: AutoRecord, proposal: R1EvidenceProposal): void {
    for (const field of fields(proposal.target.definition).values()) {
      const unit = String(field.unit_code ?? '');
      if (['not_applicable', 'per_field'].includes(unit)) continue;
      const entry = item.snapshot!.units[unit];
      if (!entry || !isWfdRecord(entry.definition) || !entry.definition.dimension) fail('R1_AUTO_UNIT_UNREGISTERED', `来源声明单位 ${unit} 尚无当前连接的受信单位定义；未修改配置或冒充缺少来源语义。`);
      const contracts = item.catalog?.latest?.contracts, semantic = isWfdRecord(contracts) ? contracts.semantic : null;
      const oldUnits = isWfdRecord(semantic) && isWfdRecord(semantic.unit_definitions) ? semantic.unit_definitions : {};
      if (oldUnits[unit] && canonicalWfdJson(oldUnits[unit]) !== canonicalWfdJson(entry)) fail('R1_AUTO_UNIT_CONFLICT', `单位 ${unit} 的受信当前定义与固定合同不符，未按语义缺口重送。`);
      item.evidence.push({ key: `registered_unit.${unit}`, value: canonicalWfdJson(entry), origin: 'contract' });
    }
  }

  private plan(item: AutoRecord, proposal: R1EvidenceProposal): ProcessingPlanInput {
    const bytes = this.options.materials.readOriginal(item.input.materialId).bytes;
    // 适配表源的原句证据只在声明字符集解码后的同一文本上定位；其他路径保持严格 UTF-8。
    const originalText = proposal.format === 'xlsx' ? null
      : item.adapter ? decodeAdapterSource(bytes, item.adapter.config.carrier.charset).text : bytes.toString('utf8');
    // 规范列名（如 trade_date）不一定出现在原文（原表可能是 day 或无表头）；按冻结适配的实际单元格定位。
    const adapterCells = item.adapter && originalText !== null ? this.adapterEvidenceCells(item, bytes) : null;
    const factFor = { role: 'semantic_code', informationNature: 'semantic_code', businessObject: 'subject_id',
      objectTime: 'frequency', purpose: '', structureGranularity: 'key_column' } as const;
    const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => {
      if (key === 'purpose') return [key, { status: 'known', value: item.input.source.usage_scope,
        evidence: [{ source: 'operator', field: 'source.usage_scope', quote: item.input.source.usage_scope }] }];
      const fact = item.evidence.find(candidate => candidate.key === factFor[key]);
      if (!fact) fail('R1_AUTO_DIMENSION_EVIDENCE', `没有 ${key} 的来源证据。`);
      const needle = fact.column ?? fact.value, start = originalText?.indexOf(needle) ?? -1;
      const adapterCell = adapterCells && fact.column ? adapterCells.get(fact.column) : undefined;
      const xlsxColumn = item.input.xlsxSelection?.columns.find(column => column.name === fact.column);
      const evidence = fact.origin === 'file' && originalText === null && xlsxColumn
        ? [{ source: 'material-table' as const, materialId: item.input.materialId, column: xlsxColumn.name,
          quote: fact.column?.startsWith('bd.') ? fact.value : xlsxColumn.header,
          scope: fact.column?.startsWith('bd.') ? 'column_constant' as const : 'header' as const, xlsxSelection: item.input.xlsxSelection! }]
        : fact.origin === 'file' && adapterCell
        ? [{ source: 'material' as const, materialId: item.input.materialId, quote: adapterCell.quote,
          start: adapterCell.start, end: adapterCell.end }]
        : fact.origin === 'file' && originalText !== null && start >= 0
        ? [{ source: 'material' as const, materialId: item.input.materialId, quote: needle, start, end: start + needle.length }]
        : fact.origin === 'operator' ? [{ source: 'operator' as const, field: fact.field ?? `answers.${fact.key}`, quote: fact.quote ?? fact.value }]
        : fail('R1_AUTO_DIMENSION_EVIDENCE', `原件中的 ${fact.key} 证据没有可核定位，未改写为操作者声明。`);
      return [key, { status: 'known', value: proposal.dimensions[key], evidence }];
    })) as Record<typeof DIMENSION_KEYS[number], ProcessingDimensionInput>;
    return { routing: { materials: [{ materialId: item.input.materialId, dimensions, intendedAction: 'publish' }] },
      outputs: [{ outputId: 'observations', materialIds: [item.input.materialId], intendedAction: 'publish',
        tables: [{ materialId: item.input.materialId, format: proposal.format, types: proposal.types,
          ...(item.adapter ? { sourceAdapter: { adapterId: item.adapter.adapterId, version: item.adapter.version,
            configDigest: item.adapter.configDigest }, ...(item.input.sourceContext === undefined ? {} : { sourceContext: item.input.sourceContext }),
            ...(item.input.sourceReceiptTaskId === undefined ? {} : { sourceReceiptTaskId: item.input.sourceReceiptTaskId }) } : {}),
          ...(proposal.sourceProjection ? { sourceProjection: proposal.sourceProjection } : {}),
          ...(proposal.emptyToNull ? { emptyToNull: proposal.emptyToNull } : {}),
          ...(proposal.annotations ? { annotations: proposal.annotations } : {}), ...(proposal.xlsxSelection ? { xlsxSelection: proposal.xlsxSelection } : {}) }],
        target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target: proposal.target, mapping: proposal.mapping, source: item.input.source },
          expectedSnapshotId: item.snapshot!.snapshotId } }] };
  }

  /** 冻结适配解析出的实际单元格位置；解码字符串载体退回原句检索，不伪造偏移。 */
  private adapterEvidenceCells(item: AutoRecord, bytes: Buffer): Map<string, { quote: string; start: number; end: number }> {
    const parsed = parseTableSource(bytes, { materialId: item.input.materialId, format: 'json', sourceAdapter: item.adapter! });
    const text = decodeAdapterSource(bytes, item.adapter!.config.carrier.charset).text;
    const decodedScope = parsed.adapter_evidence?.carrier !== undefined && isWfdRecord(parsed.adapter_evidence.carrier)
      && parsed.adapter_evidence.carrier.scope === 'decoded-string';
    const map = new Map<string, { quote: string; start: number; end: number }>();
    for (const [index, column] of parsed.columns.entries()) {
      const cell = parsed.rows.find(row => row[index] && row[index]!.original !== null && row[index]!.original !== '')?.[index];
      if (!cell) continue;
      if (decodedScope) {
        const start = text.indexOf(cell.quote);
        if (start < 0) continue;
        map.set(column, { quote: cell.quote, start, end: start + cell.quote.length });
        continue;
      }
      map.set(column, { quote: cell.quote, start: cell.location.start, end: cell.location.end });
    }
    return map;
  }

  private async localTask(item: AutoRecord, taskId: string, explicit: boolean): Promise<boolean> {
    let task = this.tasks.get(taskId);
    if (task.status === 'ready') { this.assertActive(item); this.tasks.start(task.id, task.version); return false; }
    if (taskActive.has(task.status)) return false;
    if (task.status === 'succeeded') return true;
    if (task.status === 'interrupted' && task.error?.code === 'PROCESS_INTERRUPTED' || task.status === 'paused' && explicit) {
      this.assertActive(item); this.tasks.resume(task.id, task.version); return false;
    }
    if (recoverableTask.has(task.status) && (explicit || ['PROCESS_INTERRUPTED', 'RESULT_UNKNOWN'].includes(task.error?.code ?? ''))) {
      this.assertActive(item); task = await this.tasks.recover(task.id); this.assertActive(item);
      if (task.status === 'succeeded') return true;
      if (task.status === 'interrupted') { this.tasks.resume(task.id, task.version); return false; }
    }
    if (['paused', 'cancelled', 'interrupted'].includes(task.status)) { item.state = 'stopped'; this.save(item); return false; }
    fail(task.error?.code ?? 'R1_AUTO_PROCESS_FAILED', task.error?.message ?? `原处理任务停在 ${task.status}，未改定义或重发。`);
  }

  private assertPrior(input: R1AutoStartInput, identity: R1ConnectionIdentity, sha256: string, byteLength: number): void {
    const prior = this.options.workspace.get(input.priorRequestId!);
    if (prior.state !== 'rejected' || prior.requiresRecovery) fail('R1_AUTO_PRIOR_NOT_REJECTED', '只能显式承接 WFD 已明确拒绝的旧请求；未知结果必须沿原身份恢复。');
    if (canonicalWfdJson(prior.connection) !== canonicalWfdJson(identity) || prior.datasetId !== input.datasetId) fail('R1_AUTO_PRIOR_BINDING', '原请求的数据集或冻结连接不同，未采用新默认连接。');
    const output = this.options.processing.get(prior.planId).outputs.find(value => value.outputId === prior.outputId);
    const refs = isWfdRecord(prior.local.local_refs) ? prior.local.local_refs : null;
    const source = Array.isArray(refs?.sourceRefs) ? refs.sourceRefs[0] : null;
    if (!output?.materialIds.includes(input.materialId) || !isWfdRecord(source)
      || canonicalWfdJson(source) !== canonicalWfdJson({ ...input.source, sha256, bytes: byteLength })) fail('R1_AUTO_PRIOR_BINDING', '重新办理必须引用同一原材料与同一原来源授权，不能改写先前证据。');
    const material = this.options.materials.get(input.materialId);
    if (material.envelope.sha256 !== sha256 || material.envelope.byteLength !== byteLength) fail('R1_AUTO_PRIOR_BINDING', '原材料内容或长度发生变化。');
  }
  private operator(item: AutoRecord, phase: string): OperatorContext { return { ...item.operator, requestId: this.phaseId(item, phase) }; }
  private phaseId(item: AutoRecord, phase: string): string { return `auto:${wfdSha256(item.input.requestId).slice(0, 32)}:${item.revisions.length}:${phase}`; }
  private currentConnection(): R1ConnectionIdentity { return this.options.workspace.capabilities().connection ?? fail('R1_NOT_CONFIGURED', '自动交接需要已装配的 data_only 连接。'); }
  private assertDispatch(): void { if (this.closed || this.tasks.getControl().stopped) fail('BD_STOPPED', '服务正在停止或已经停止，未启动自动交接。'); }
  private assertBinding(item: AutoRecord): void {
    if (item.version !== R1_AUTO_VERSION || canonicalWfdJson(this.currentConnection()) !== canonicalWfdJson(item.connection)) fail('R1_AUTO_CONNECTION_CHANGED', '当前连接、配置或实现版本与原自动请求不同，未换连接重放。');
    if (!item.adapter) return;
    const current = (this.options.adapters ?? fail('R1_ADAPTER_UNAVAILABLE', '本实例未装配端点适配登记。'))
      .resolve({ adapterId: item.adapter.adapterId, version: item.adapter.version, configDigest: item.adapter.configDigest });
    // 匹配结论取决于本材料回执，由 start 时冻结；这里只核配置身份，不用无上下文的解析结果覆盖已核结论。
    const identity = (binding: typeof item.adapter) => ({ adapterId: binding.adapterId, version: binding.version,
      configDigest: binding.configDigest, config: binding.config });
    if (canonicalWfdJson(identity(current)) !== canonicalWfdJson(identity(item.adapter)))
      fail('R1_ADAPTER_CHANGED', '原自动请求冻结的适配配置已变化；未换配置继续。');
  }
  private assertActive(item: AutoRecord): void {
    this.assertDispatch(); this.assertBinding(item);
    if (this.tasks.getControl().generation !== item.controlGeneration) fail('BD_STOPPED', '原自动请求接受后停止代次已变化，请明确继续原请求。');
  }
  private taskIds(item: AutoRecord): string[] { return item.revisions.flatMap(revision => [revision.planTaskId, revision.runTaskId,
    revision.handoffRequestId ? this.options.workspace.get(revision.handoffRequestId).submitTaskId : null]).filter((value): value is string => value !== null); }
  private records(activeOnly = false): AutoRecord[] { return this.db.prepare(`SELECT record_json FROM r1_auto_requests
    ${activeOnly ? "WHERE json_extract(record_json,'$.state') IN ('inspecting','processing','submitting','recovering')" : ''}
    ORDER BY updated_at DESC,rowid DESC ${activeOnly ? '' : 'LIMIT 20'}`).all().map(row => JSON.parse(String(row.record_json)) as AutoRecord); }
  private find(requestId: string): AutoRecord | null { id(requestId); const row = this.db.prepare('SELECT record_json FROM r1_auto_requests WHERE request_id=?').get(requestId); return row ? JSON.parse(String(row.record_json)) as AutoRecord : null; }
  private require(requestId: string): AutoRecord { return this.find(requestId) ?? fail('R1_AUTO_NOT_FOUND', '没有该自动请求的持久记录。'); }
  private queueHead(): AutoRecord | null {
    const row = this.db.prepare(`SELECT record_json FROM r1_auto_requests
      WHERE json_extract(record_json,'$.state') IN ('inspecting','processing','submitting','recovering')
      ORDER BY COALESCE(json_extract(record_json,'$.queueOrder'),json_extract(record_json,'$.createdAt')),rowid LIMIT 1`).get();
    return row ? JSON.parse(String(row.record_json)) as AutoRecord : null;
  }
  private nextQueueOrder(): number { return Number(this.db.prepare("SELECT COALESCE(MAX(COALESCE(json_extract(record_json,'$.queueOrder'),json_extract(record_json,'$.createdAt'))),0)+1 AS n FROM r1_auto_requests").get()!.n); }
  private notify(requestId: string): void { if (!this.closed) for (const listener of this.listeners) listener(requestId); }
  private save(item: AutoRecord): void {
    item.updatedAt = Date.now(); this.db.prepare('UPDATE r1_auto_requests SET record_json=?,updated_at=? WHERE request_id=?').run(canonicalWfdJson(item), item.updatedAt, item.input.requestId);
    this.notify(item.input.requestId);
    if (!['inspecting', 'processing', 'submitting', 'recovering'].includes(item.state)) {
      const next = this.queueHead(); if (next) void this.schedule(next.input.requestId);
    }
  }
  private view(item: AutoRecord): R1AutoView {
    const head = ['inspecting', 'processing', 'submitting', 'recovering'].includes(item.state) ? this.queueHead() : null;
    const waitingForRequestId = head && head.input.requestId !== item.input.requestId ? head.input.requestId : null;
    const requestIds = [...(item.input.priorRequestId ? [item.input.priorRequestId] : []), ...item.revisions.flatMap(revision => revision.handoffRequestId ? [revision.handoffRequestId] : [])];
    return { requestId: item.input.requestId, materialId: item.input.materialId, source: item.input.source, datasetId: item.input.datasetId,
      state: item.state, questions: item.questions, evidence: item.evidence, planIds: item.revisions.flatMap(revision => revision.planId ? [revision.planId] : []),
      requestIds, taskIds: this.taskIds(item), currentRequest: requestIds.length ? this.options.workspace.get(requestIds.at(-1)!) : null,
      localReturn: item.localReturn, wfdRejection: item.wfdRejection, error: item.error, parentSnapshotId: item.snapshot?.snapshotId ?? null,
      definitionAction: item.definitionAction, definitionReview: item.definitionReview, waitingForRequestId,
      waitingReason: waitingForRequestId ? head?.state === 'recovering' ? '前序自动请求的提交结果尚未核清，等待按原编号核对后继续。' : '前序自动请求正在加工或交接，等待其固定读回后取得当前快照。' : null,
      createdAt: item.createdAt, updatedAt: item.updatedAt };
  }
}

function readStart(value: unknown): R1AutoStartInput {
  const body = object(value, ['requestId', 'materialId', 'source', 'datasetId', 'priorRequestId', 'xlsxSelection', 'sourceValueColumns', 'sourceAdapter', 'sourceContext', 'sourceReceiptTaskId']);
  id(body.requestId); id(body.materialId); id(body.datasetId); if (body.priorRequestId !== undefined) id(body.priorRequestId);
  const source = object(body.source, ['source_id', 'provider', 'requested_url', 'requested_at_utc', 'acquired_at_utc', 'usage_scope', 'authorization', 'license']);
  for (const key of ['source_id', 'provider', 'requested_url', 'requested_at_utc', 'acquired_at_utc', 'usage_scope']) if (typeof source[key] !== 'string' || !source[key]) fail('R1_AUTO_SOURCE', '来源声明需要明确字段，不能从原件自授权限。');
  const requested = parseR1Utc(String(source.requested_at_utc)), acquired = parseR1Utc(String(source.acquired_at_utc));
  if (!Number.isFinite(requested) || !Number.isFinite(acquired) || acquired < requested) fail('R1_SOURCE_TIME', '来源需要实际有效的 UTC 请求和取得时间，不能以无效时间开始自动交接。');
  const selected = body.sourceValueColumns;
  if (selected !== undefined && (!Array.isArray(selected) || selected.length < 1 || selected.length > 256
    || selected.some(column => typeof column !== 'string' || !column.trim() || column.length > 256 || /[\u0000-\u001f]/u.test(column))
    || new Set(selected).size !== selected.length)) fail('R1_AUTO_COLUMN_SELECTION', '须指定 1 至 256 个不重复的原表列名。');
  return structuredClone({ ...(selected ? { sourceValueColumns: [...selected as string[]].sort() } : {}), requestId: body.requestId, materialId: body.materialId, datasetId: body.datasetId,
    source: source as unknown as R1SourceDeclaration, ...(body.priorRequestId ? { priorRequestId: body.priorRequestId as string } : {}),
    ...(body.sourceAdapter ? { sourceAdapter: readAdapterBindingRef(body.sourceAdapter) } : {}),
    ...(body.sourceContext === undefined ? {} : { sourceContext: structuredClone(body.sourceContext) }),
    ...(body.sourceReceiptTaskId === undefined ? {} : { sourceReceiptTaskId: String(body.sourceReceiptTaskId) }),
    ...(body.xlsxSelection ? { xlsxSelection: readXlsxTableSelection(body.xlsxSelection) } : {}) });
}
function object(value: unknown, keys: string[]): WfdRecord { if (!isWfdRecord(value) || Object.keys(value).some(key => !keys.includes(key))) fail('R1_AUTO_INPUT', '自动交接只接受已声明字段，不能覆盖连接、路径、目标或权限。'); return value; }
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(value)) fail('R1_AUTO_INPUT', '自动交接需要稳定编号。'); }
function errorView(error: unknown): { code: string; message: string } { return {
  code: error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'R1_AUTO_FAILED',
  message: error instanceof Error ? error.message : String(error) }; }
function definitionRejection(error: WfdRecord | null): boolean { return !!error && error.code === 'R1_WFD_REJECTED' && Array.isArray(error.errors) && error.errors.length > 0 && error.errors.every(issue => isWfdRecord(issue) && typeof issue.code === 'string' && definitionGaps.has(issue.code)); }
function registeredSourceKeys(product: WfdRecord): string[] | undefined {
  const declaration = product.declaration;
  const context = isWfdRecord(declaration) ? declaration.semantic_context : null;
  const identity = isWfdRecord(context) ? context.identity : null;
  const rule = isWfdRecord(identity) ? identity.identity_resolution_rule : null;
  const prefix = 'source_reported_date_and_identity_columns:';
  if (typeof rule !== 'string' || !rule.startsWith(prefix)) return undefined;
  const keys: unknown = JSON.parse(rule.slice(prefix.length));
  if (!Array.isArray(keys) || !keys.length || !keys.every(column => typeof column === 'string')) {
    fail('R1_AUTO_CATALOG_KEY_RULE', '固定产品定义中的原报身份列规则无法核对。');
  }
  return keys;
}
function fields(definition: WfdRecord): Map<string, WfdRecord> { return new Map((Array.isArray(definition.field_definitions) ? definition.field_definitions : []).filter(isWfdRecord).map(field => [String(field.field_code), field])); }
function withoutFields(definition: WfdRecord): WfdRecord {
  const clone = structuredClone(definition); delete clone.field_definitions; delete clone.field_semantic_context; return clone;
}
function sameFieldScope(old: WfdRecord, proposed: WfdRecord, code: string, oldField: WfdRecord, newField: WfdRecord): boolean {
  const previous = isWfdRecord(old.field_semantic_context) ? old.field_semantic_context[code] : null;
  const next = isWfdRecord(proposed.field_semantic_context) ? proposed.field_semantic_context[code] : null;
  return canonicalWfdJson(oldField) === canonicalWfdJson(newField) && canonicalWfdJson(previous ?? null) === canonicalWfdJson(next ?? null);
}

/** Remove only WFD's declared normalization metadata; retain every actual known semantic axis. */
function publicDefinition(value: WfdRecord): WfdRecord {
  const result = structuredClone(value), context = isWfdRecord(result.semantic_context) ? result.semantic_context : null;
  if (!context) return result;
  delete context.applicability; delete context.unknown_axes;
  if (context.measurement_nature === result.measurement_nature) delete context.measurement_nature;
  if (isWfdRecord(context.content) && context.content.content_nature === context.content_nature) delete context.content.content_nature;
  for (const [axis, value] of Object.entries(context)) if (value === null || isWfdRecord(value) && Object.keys(value).length === 1 && value.status === 'unknown') delete context[axis];
  const defaults: Record<string, WfdRecord> = { measurement: { measurement_nature: result.measurement_nature,
    ...(!['per_field', 'not_applicable', undefined, null, ''].includes(result.unit_code as string) ? { unit_code: result.unit_code } : {}) },
    content: {}, source: { definition_authority: result.definition_authority } };
  for (const [axis, defaultsForAxis] of Object.entries(defaults)) if (isWfdRecord(context[axis]) && canonicalWfdJson(context[axis]) === canonicalWfdJson(defaultsForAxis)) delete context[axis];
  return result;
}
function comparableDefinition(definition: WfdRecord): string {
  const normalized = publicDefinition(definition);
  if (Array.isArray(normalized.field_definitions)) normalized.field_definitions.sort((a, b) => String((a as WfdRecord).field_code).localeCompare(String((b as WfdRecord).field_code)));
  return canonicalWfdJson(normalized);
}
