import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError, type TaskRecord, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import type { ProcessRuntime } from '../../platform/runtime/programs.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1PrepareInput } from '../../contracts/r1-contracts.js';
import type { R1WorkspaceService } from './r1-workspace.js';
import type { R1AutoService } from './r1-auto.js';
import type { ProcessingPlanService } from './processing-plan.js';
import type { MaterialService } from './materials/service.js';
import { sourceObservationMAAlgorithmDefinition, type CalculatedMAProof, type SourceObservationMAContext } from './source-observation-ma.js';
import { assertFinancialLinearCandidate, readFinancialCalculation, type FinancialCalculation } from './data-processing/financial-fixed.js';
import { POLARS_FIXED_VERSION, POLARS_DEPENDENCY_VERSION, POLARS_FIXED_METHODS, polarsFixedVersionBinding, assertCompletePolarsDailySeries,
  projectDailyPolars, projectFinancialPolars, projectMacroYoYPolars, assertMacroYoYCandidate,
  readMacroYoYCalculation, type MacroYoYCalculation } from './data-processing/polars-fixed.js';
import { PURPOSE_ELIGIBILITY_RULE_VERSION, evaluatePurposeEligibility, wfdRestrictionEvidence,
  type DerivedInputEvidence, type PurposeEligibilityInput, type PurposeEligibilityResult, type PurposeEvidenceClaim,
  type RestrictionEvidence } from './purpose-eligibility.js';

export const POLARS_FIXED_RUNTIME = 'bd.polars-fixed';
type Calculation = { method: 'observation_ma20'; autoRequestIds: string[]; valueColumn: string }
  | { method: 'financial_linear'; calculation: FinancialCalculation }
  | { method: 'macro_yoy'; calculation: MacroYoYCalculation };
interface PolarsUsage { purpose: 'current_compute' | 'historical_compute'; cutoff: string | null; purposeEvidence?: PurposeEvidenceClaim[] }
type CreateInput = Calculation & { requestId: string; usage?: PolarsUsage };
interface FrozenTask { input: CreateInput; connection: unknown; python: string;
  daily?: { context: SourceObservationMAContext; refs: Array<{ materialId: string; autoRequestId: string }> } }
function fail(code: string, message: string): never { throw new TaskError(code, message); }
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)) fail('POLARS_INPUT', '需要稳定的有界身份，不接受路径。');
}
function readUsage(value: unknown, trusted: boolean): PolarsUsage | undefined {
  if (value === undefined) return undefined;
  if (!isWfdRecord(value)) fail('POLARS_INPUT', '固定计算用途须为明确对象。');
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'cutoff,purpose' && !(trusted && keys === 'cutoff,purpose,purposeEvidence')) {
    fail('POLARS_INPUT', '固定计算用途只接受 purpose/cutoff；purposeEvidence 只能由受信执行记录保存。');
  }
  if (value.purpose !== 'current_compute' && value.purpose !== 'historical_compute') fail('POLARS_INPUT', '用途须为 current_compute 或 historical_compute。');
  if (value.cutoff !== null && (typeof value.cutoff !== 'string' || !Number.isFinite(Date.parse(value.cutoff))
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value.cutoff))) {
    fail('POLARS_INPUT', '历史截止须为含明确时区的有效时刻或 null。');
  }
  if (value.purpose === 'historical_compute' && value.cutoff === null) fail('POLARS_INPUT', '历史计算须固定截止。');
  if (value.purpose === 'current_compute' && value.cutoff !== null) fail('POLARS_INPUT', '当前内容计算不能携带历史截止。');
  const evidence = trusted && Array.isArray(value.purposeEvidence)
    ? value.purposeEvidence.filter(isWfdRecord).map(item => structuredClone(item) as unknown as PurposeEvidenceClaim) : undefined;
  return { purpose: value.purpose, cutoff: value.cutoff as string | null,
    ...(evidence?.length ? { purposeEvidence: evidence } : {}) };
}
function withoutPolarsEvidence(input: CreateInput): CreateInput {
  if (!input.usage) return input;
  const { purposeEvidence, ...usage } = input.usage;
  return { ...input, usage };
}

function readInput(value: unknown, trusted = false): CreateInput {
  if (!isWfdRecord(value)) fail('POLARS_INPUT', '固定任务需要明确的登记方法和受信输入引用。');
  id(value.requestId);
  const usage = readUsage(value.usage, trusted);
  const usageKey = usage ? ',usage' : '';
  if (value.method === 'observation_ma20') {
    if (Object.keys(value).sort().join(',') !== (usage ? 'autoRequestIds,method,requestId,usage,valueColumn' : 'autoRequestIds,method,requestId,valueColumn')
      || !Array.isArray(value.autoRequestIds) || !value.autoRequestIds.length || value.autoRequestIds.length > 100
      || new Set(value.autoRequestIds).size !== value.autoRequestIds.length || typeof value.valueColumn !== 'string'
      || !value.valueColumn.trim() || value.valueColumn.length > 128) fail('POLARS_INPUT', '日线观测MA20需要完整明确的已关联原报请求和数值列。');
    value.autoRequestIds.forEach(id);
    return { ...structuredClone(value), ...(usage ? { usage } : {}) } as unknown as CreateInput;
  } else if (value.method === 'financial_linear' || value.method === 'macro_yoy') {
    if (Object.keys(value).sort().join(',') !== 'calculation,method,requestId' + usageKey) fail('POLARS_INPUT', '期间任务不能覆盖数值、执行程序、路径、连接或权限。');
    const calculation = value.method === 'financial_linear' ? readFinancialCalculation(value.calculation) : readMacroYoYCalculation(value.calculation);
    if (value.method === 'financial_linear' && (calculation as FinancialCalculation).operation === 'standardize') fail('POLARS_FINANCIAL_OPERATION', '本执行器登记单季/TTM算术；固定映射沿用现有财报流程。');
    return { ...structuredClone(value), calculation, ...(usage ? { usage } : {}) } as unknown as CreateInput;
  } else fail('POLARS_METHOD', '未登记的Polars固定方法。');
}

function assertEligible(result: PurposeEligibilityResult): PurposeEligibilityResult {
  if (result.status === 'eligible') return result;
  throw new TaskError(result.status === 'ineligible' ? 'PURPOSE_ELIGIBILITY_INELIGIBLE' : 'PURPOSE_ELIGIBILITY_INSUFFICIENT',
    canonicalWfdJson({ ruleVersion: result.ruleVersion, status: result.status, purpose: result.purpose,
      history: result.history, historyUse: result.historyUse, timings: result.timings,
      gaps: result.gaps.filter(gap => gap.blocking), checks: result.checks, evidenceSha256: result.evidenceSha256 }));
}

function derivedInputsFromPolarsEvidence(input: CreateInput, evidence: WfdRecord, computedAt: string): DerivedInputEvidence[] {
  const items: DerivedInputEvidence[] = [];
  if (input.method === 'macro_yoy' && Array.isArray(evidence.inputs)) {
    for (const item of evidence.inputs.filter(isWfdRecord)) {
      const values = isWfdRecord(item.values) ? item.values : {};
      const published = typeof values.published_at === 'string' && Number.isFinite(Date.parse(values.published_at + 'T00:00:00Z'))
        ? values.published_at + 'T00:00:00Z' : computedAt;
      items.push({ ref: String(item.businessKey ?? item.record ?? 'macro-input'),
        latestAvailableAtUtc: new Date(published).toISOString().replace('.000Z', 'Z'),
        basis: '宏观来源实际公布时间；仅供当前内容计算，历史资格另判',
        evidenceSha256: typeof item.selectedSha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.selectedSha256)
          ? item.selectedSha256 : wfdSha256(canonicalWfdJson(item)) });
    }
  } else if (input.method === 'observation_ma20' && isWfdRecord(evidence.checkedInput)
    && Array.isArray(evidence.checkedInput.lineage)) {
    for (const line of evidence.checkedInput.lineage.filter(isWfdRecord)) items.push({
      ref: String(line.businessKey ?? 'daily-input'), latestAvailableAtUtc: computedAt,
      basis: '本入口只读当前固定系列；未声明历史可得时间，保守采用本次实际计算时间',
      evidenceSha256: wfdSha256(canonicalWfdJson(line)) });
  } else if (input.method === 'financial_linear' && Array.isArray(evidence.recordVersions)) {
    for (const version of evidence.recordVersions.filter(isWfdRecord)) items.push({
      ref: String(version.logical_key ?? version.record_id ?? 'financial-input'), latestAvailableAtUtc: computedAt,
      basis: '本入口只读固定财务记录；未声明历史公开时间，保守采用本次实际计算时间',
      evidenceSha256: wfdSha256(canonicalWfdJson(version)) });
  }
  if (!items.length) items.push({ ref: input.method, latestAvailableAtUtc: computedAt,
    basis: '没有逐行可得时间证据；保守采用本次实际计算时间', evidenceSha256: wfdSha256(canonicalWfdJson({ method: input.method, computedAt })) });
  return items;
}

function evaluateResultEligibility(input: CreateInput, evidence: unknown, rows: WfdRecord[], candidateSha256: string, computedAt: string):
  { result: PurposeEligibilityResult; restriction: RestrictionEvidence; derivedInputs: DerivedInputEvidence[] } {
  const record = isWfdRecord(evidence) ? evidence : {};
  const governance = isWfdRecord(record.governance) ? { usage_governance: record.governance } : null;
  const restriction = wfdRestrictionEvidence(governance, { checkedAtUtc: computedAt });
  const usage = input.usage;
  const historical = usage?.purpose === 'historical_compute';
  const derivedInputs = derivedInputsFromPolarsEvidence(input, record, computedAt);
  const result = evaluatePurposeEligibility({
    ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION,
    purpose: usage?.purpose ?? 'current_compute',
    purposeEvidence: usage?.purposeEvidence ?? null,
    history: { mode: historical ? 'snapshot_contents' : null, cutoff: historical ? usage!.cutoff : null,
      perspective: historical ? 'snapshot_contents' : null },
    object: { objectSha256: candidateSha256, origin: 'derived_candidate', productId: null, snapshotId: null,
      recordVersion: null, definitionRevision: POLARS_FIXED_VERSION, contentVerified: true,
      contentBasis: '固定计算候选行按实际Polars结果与冻结输入逐行核对；尚未发布' },
    publicationTime: null, holdingTime: null, revisions: null, wfdHistory: null,
    restriction, wfdDecision: null,
    derived: { methodVersion: POLARS_FIXED_VERSION,
      businessTime: typeof rows.at(-1)?.start_utc === 'string' ? String(rows.at(-1)!.start_utc).slice(0, 10) : null,
      inputs: derivedInputs, computedAtUtc: computedAt, computedAtBasis: '实际Polars固定计算任务完成时间',
      publishedAtUtc: null, usableAtUtc: null, resultObjectSha256: candidateSha256 },
  });
  return { result: assertEligible(result), restriction, derivedInputs };
}

/** Optional host service. No caller rows, execution paths or automatic publication. */
export class PolarsFixedService {
  constructor(private readonly options: { database: CoreDatabase; tasks(): TaskService; workspace: R1WorkspaceService;
    auto: R1AutoService; processing: ProcessingPlanService; materials: MaterialService; processRuntime?: ProcessRuntime;
    accept(input: { bytes: Buffer; name: string; category: 'data'; requestId: string }): Promise<string>;
    verifyFinancialReview?(review: NonNullable<FinancialCalculation['compatibilityReview']>): void }) {}
  private get tasks() { return this.options.tasks(); }
  capabilities() {
    let program: string | null = null, error: string | null = null;
    try { program = this.options.processRuntime?.path('polars-python') ?? null; } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    if (!program && !error) error = '尚未装配独立的polars_python程序资源。';
    return { version: POLARS_FIXED_VERSION, runtime: POLARS_FIXED_RUNTIME, optional: true, default: false,
      configured: !!program && !!this.options.workspace.capabilities().connection,
      dependency: { package: 'polars', version: POLARS_DEPENDENCY_VERSION, programBound: !!program,
        verification: 'exact version and native Decimal expressions checked on each actual execution', error },
      methods: Object.fromEntries(Object.entries(POLARS_FIXED_METHODS).map(([id, method]) => [id, method.legacyDescription])),
      limits: { inputRows: 5000, inputBytes: 2000000, outputBytes: 2000000,
        processTimeoutMs: 15000, threads: 2, peakRssHardLimit: false },
      input: 'host-read fixed WFD snapshots/record versions; daily requires already associated original requests',
      dailyScope: 'source observation rows, MA20; price basis/currency/historical public availability remain unverified',
      historicalQualification: 'not_asserted', publication: 'candidate_only',
      handoff: 'stage the candidate as a managed material; run an explicit existing processing plan; prepare then confirm through original R1' };
  }
  async create(value: unknown): Promise<TaskRecord> {
    const input = readInput(value), requestId = 'polars:' + input.requestId;
    const previous = this.options.database.connection.prepare('SELECT id FROM tasks WHERE request_id=?').get(requestId);
    if (previous) {
      const task = this.task(String(previous.id));
      // 受理时间/用途证据不是请求身份的一部分；同一请求必须仍可复开。
      if (canonicalWfdJson(withoutPolarsEvidence((task.args as unknown as FrozenTask).input)) !== canonicalWfdJson(input)) {
        fail('POLARS_REQUEST_CONFLICT', '原Polars请求的输入已经冻结，不能覆盖。');
      }
      return task;
    }
    // 固定计算入口的当前用途来自本机操作者请求；历史用途也由同一请求显式声明，
    // 但本入口只读 snapshot_contents，仍由共用规则明确拒绝，不另写更宽松规则。
    if (input.usage && !input.usage.purposeEvidence) {
      input.usage.purposeEvidence = [{ purpose: input.usage.purpose, authority: 'operator-http',
        quote: '本机操作者固定计算请求声明用途', observedAtUtc: new Date().toISOString().replace('.000Z', 'Z'),
        evidenceSha256: wfdSha256(canonicalWfdJson({ requestId: input.requestId, usage: input.usage })),
        requestId: input.requestId }];
    }
    this.assertDispatch();
    const python = this.options.processRuntime?.path('polars-python') ?? fail('POLARS_NOT_CONFIGURED', '尚未装配独立polars_python程序；没有搜索PATH或临时替代。');
    const connection = this.connection();
    const frozen: FrozenTask = { input, connection, python };
    if (input.method === 'observation_ma20') {
      const refs = input.autoRequestIds.map(autoRequestId => {
        const source = this.options.auto.get(autoRequestId);
        if (source.state !== 'associated' || !source.currentRequest) fail('POLARS_INPUT_BINDING', '日线输入须先完成原报发布、固定读回和完整关联。');
        return { autoRequestId, materialId: source.materialId };
      });
      const context = await this.options.auto.readCalculationContext(input.autoRequestIds.at(-1)!);
      frozen.daily = { context, refs };
    }
    this.assertDispatch(); this.assertConnection(connection);
    const task = this.tasks.create({ title: '显式Polars固定计算：' + input.method, ownerRole: 'service', runtimeId: POLARS_FIXED_RUNTIME,
      action: 'polars.fixed.calculate', requestId, args: JSON.parse(canonicalWfdJson(frozen)), versions: { ...polarsFixedVersionBinding(),
        polarsConnection: wfdSha256(canonicalWfdJson(connection)), polarsInput: wfdSha256(canonicalWfdJson(frozen)) } });
    return task.status === 'ready' ? this.tasks.start(task.id, task.version) : task;
  }
  get(taskId: string) {
    const task = this.task(taskId), stage = this.stageState(taskId);
    return { task, candidate: task.status === 'succeeded' ? { sha256: this.result(task).candidateSha256,
      rowCount: this.result(task).rows.length, publication: 'candidate_only', ...stage } : null };
  }
  listTaskIds(): string[] {
    return this.options.database.connection.prepare('SELECT id FROM tasks WHERE runtime_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20')
      .all(POLARS_FIXED_RUNTIME).map(row => String(row.id));
  }
  /** Uses the existing durable intake and stable request. This never creates an R1 publication. */
  async stage(taskId: string) {
    this.assertDispatch(); const task = this.task(taskId), result = this.result(task);
    const frozen = task.args as unknown as FrozenTask; this.assertConnection(frozen.connection);
    const bytes = Buffer.from(canonicalWfdJson(result.rows));
    const custodyTaskId = await this.options.accept({ bytes, name: 'polars-' + taskId + '.json', category: 'data', requestId: this.stageRequest(taskId) });
    return { ...this.stageState(taskId), custodyTaskId, candidateSha256: result.candidateSha256, publication: 'candidate_only' };
  }
  /** A narrow bridge to the unchanged prepare/confirmation authority. */
  async prepare(taskId: string, value: unknown) {
    const materialId = this.stageState(taskId).materialId;
    if (!materialId) fail('POLARS_STAGE_PENDING', '候选须先经原材料入口完成保管，再执行明确的五步计划。');
    if (!isWfdRecord(value) || typeof value.planId !== 'string' || typeof value.outputId !== 'string') fail('POLARS_PREPARE', '须提供原R1准备请求及明确的已完成加工计划。');
    const target = isWfdRecord(value.target) ? value.target : {};
    this.verifyCandidate(taskId, { materialId, planId: value.planId, outputId: value.outputId,
      definition: isWfdRecord(target.definition) ? target.definition : {} });
    return this.options.workspace.prepareWithRestriction(value as unknown as R1PrepareInput);
  }
  /** Shared by the dedicated bridge and the central R1 prepare gate. Caller markers are not evidence. */
  verifyCandidate(taskId: string, input: { materialId: string; planId: string; outputId: string; definition: WfdRecord; payload?: WfdRecord }): void {
    this.assertDispatch(); const task = this.task(taskId), result = this.result(task);
    const frozen = task.args as unknown as FrozenTask;
    this.assertConnection(frozen.connection);
    // R1 准备与首次发送共用本核验器：发布前再次要求执行时实际保存的用途资格，
    // 并以真实加工计划的用途证据与实际限制证据复核。只改用途/内容性质不能绕过。
    const plan = this.options.processing.get(input.planId);
    const planOutput = (plan.outputs as Array<Record<string, unknown>>).find(output => output.outputId === input.outputId);
    if (!planOutput) fail('POLARS_PREPARE', '加工计划没有本次输出。');
    const stored = result.eligibility;
    if (!stored || stored.status !== 'eligible') fail('POLARS_ELIGIBILITY_EVIDENCE_MISSING', '原固定计算任务没有可核对的实际用途资格；不能按普通原件准备或首次发送。');
    const usage = isWfdRecord(planOutput.usage) ? planOutput.usage : null;
    if (!usage || (usage.purpose !== 'current_publish' && usage.purpose !== 'historical_publish')
      || !Array.isArray(usage.purposeEvidence) || usage.purposeEvidence.length === 0) {
      fail('POLARS_PUBLISH_USAGE_MISSING', '加工计划没有真实受信结构化发布用途与证据；不能从自由文本或任意原话重贴发布资格。');
    }
    const publishEligibility = evaluatePurposeEligibility({
      ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION,
      purpose: usage.purpose as 'current_publish' | 'historical_publish',
      purposeEvidence: usage.purposeEvidence as unknown as PurposeEvidenceClaim[],
      history: { mode: (usage.historyMode ?? null) as PurposeEligibilityInput['history']['mode'],
        cutoff: typeof usage.cutoff === 'string' ? usage.cutoff : null,
        perspective: typeof usage.perspective === 'string' ? usage.perspective : null },
      object: { objectSha256: result.candidateSha256, origin: 'derived_candidate', productId: null, snapshotId: null,
        recordVersion: null, definitionRevision: POLARS_FIXED_VERSION, contentVerified: true,
        contentBasis: '已保管候选与本次实际Polars结果、加工产物逐行核对' },
      publicationTime: isWfdRecord(usage.publicationTime) ? usage.publicationTime as unknown as PurposeEligibilityInput['publicationTime'] : null,
      holdingTime: isWfdRecord(usage.holdingTime) ? usage.holdingTime as unknown as PurposeEligibilityInput['holdingTime'] : null,
      revisions: Array.isArray(usage.revisions) ? usage.revisions as unknown as PurposeEligibilityInput['revisions'] : null,
      wfdHistory: isWfdRecord(usage.wfdHistory) ? usage.wfdHistory as unknown as PurposeEligibilityInput['wfdHistory'] : null,
      restriction: result.restriction ?? null, wfdDecision: null, boundary: 'prepare',
      derived: { methodVersion: POLARS_FIXED_VERSION,
        businessTime: result.computedAt ? String(result.computedAt).slice(0, 10) : null,
        inputs: result.derivedInputs ?? [], computedAtUtc: result.computedAt ?? null,
        computedAtBasis: '实际Polars固定计算任务完成时间', publishedAtUtc: null, usableAtUtc: null,
        resultObjectSha256: result.candidateSha256 },
    });
    assertEligible(publishEligibility);
    if (frozen.input.method === 'observation_ma20') {
      const proof = isWfdRecord(result.evidence) && isWfdRecord(result.evidence.checkedInput) ? result.evidence.checkedInput : null;
      if (!proof || !Array.isArray(proof.lineage) || !frozen.daily) fail('POLARS_INPUT_BINDING', '原固定日线结果缺少完整的冻结系列及逐行计算证明。');
      assertCompletePolarsDailySeries(proof as unknown as CalculatedMAProof, frozen.daily.context);
    }
    if (frozen.input.method === 'financial_linear') {
      assertFinancialLinearCandidate(frozen.input.calculation, isWfdRecord(result.evidence) ? result.evidence : {}, result.rows,
        this.options.verifyFinancialReview ?? (() => fail('POLARS_FINANCIAL_REVIEW', '本宿主尚未装配跨修订原文核对，不能新发布。')));
    }
    if (frozen.input.method === 'macro_yoy') {
      // 与财务一样，准备/首次发送时重新执行数值和来源版本独立核验。
      assertMacroYoYCandidate(frozen.input.calculation, isWfdRecord(result.evidence) ? result.evidence : {}, result.rows);
    }
    const materialId = this.stageState(taskId).materialId;
    if (!materialId || materialId !== input.materialId) fail('POLARS_PREPARE', '材料不是本次原计算任务实际保管的候选。');
    const material = this.options.materials.readOriginal(materialId);
    if (material.sha256 !== result.candidateSha256) fail('POLARS_CANDIDATE_CHANGED', '已保管候选与本次实际Polars结果不符。');
    const output = this.options.processing.get(input.planId).outputs.find(item => item.outputId === input.outputId);
    if (!output || output.materialIds.length !== 1 || output.materialIds[0] !== materialId) fail('POLARS_PREPARE', '加工计划必须选择本任务准确的候选材料，不能替换原件或结果。');
    const artifact = JSON.parse(this.options.processing.outputArtifact(input.planId, input.outputId).bytes.toString()) as WfdRecord;
    const normalized = (rows: unknown) => Array.isArray(rows) ? rows.map(row => {
      if (!isWfdRecord(row)) fail('POLARS_CANDIDATE_CHANGED', '加工结果没有完整候选行。');
      const value = row.value;
      const decimal = typeof value === 'string' && /^-?(0|[1-9]\d*)(\.\d+)?$/u.test(value)
        ? value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '').replace(/^-0$/u, '0') : value.replace(/^-0$/u, '0') : value;
      return { ...row, value: decimal };
    }) : null;
    if (canonicalWfdJson(normalized(artifact.rows)) !== canonicalWfdJson(normalized(result.rows))) fail('POLARS_CANDIDATE_CHANGED', '五步产物与本次实际Polars候选不一致；只允许数值等价的十进制词面规范化。');
    const definition = input.definition;
    if (!isWfdRecord(definition.semantic_context) || definition.semantic_context.content_nature !== 'deterministic_derived'
      || definition.measurement_nature !== 'derived' || canonicalWfdJson(definition.algorithm_definition ?? null) !== canonicalWfdJson(result.algorithmDefinition)) {
      fail('POLARS_DERIVED_CONTRACT', '目标必须明确为确定性派生，算法定义须对应本任务的冻结公式；不能按原始披露发布。');
    }
    if (input.payload) {
      const payload = input.payload, rows = payload.rows;
      if (!Array.isArray(rows)) fail('POLARS_CANDIDATE_CHANGED', '交接载荷缺计算候选行。');
      const fields = Array.isArray(definition.field_definitions) ? definition.field_definitions.filter(isWfdRecord) : [];
      if (payload.kind === 'tabular_rows' && (fields.length !== 1 || fields[0]!.data_type !== 'decimal'
        || fields[0]!.measurement_nature !== 'derived')) fail('POLARS_DERIVED_CONTRACT', '本固定计算输出一个派生数值字段，不能把其他来源列登记为本算法结果。');
      const projected = rows.map(row => {
        if (!isWfdRecord(row) || !isWfdRecord(row.observation_time)) fail('POLARS_CANDIDATE_CHANGED', '交接行缺原计算业务键或期间。');
        const values = isWfdRecord(row.values) ? row.values : {};
        const value = payload.kind === 'scalar_rows' ? { value: row.value_decimal, value_state: row.value_state }
          : isWfdRecord(values[String(fields[0]!.field_code)]) ? values[String(fields[0]!.field_code)] as WfdRecord : {};
        return { business_key: row.business_key, start_utc: row.observation_time.earliest_utc,
          end_utc: row.observation_time.latest_exclusive_utc, value: value.value, value_state: value.value_state };
      });
      const expected = result.rows.map(row => ({ business_key: row.business_key, start_utc: row.start_utc,
        end_utc: row.end_utc, value: row.value, value_state: row.value_state }));
      if (canonicalWfdJson(normalized(projected)) !== canonicalWfdJson(normalized(expected))) {
        fail('POLARS_CANDIDATE_CHANGED', '交接的业务键、期间、数值或未知状态偏离原计算候选；不能通过字段映射替换结果。');
      }
    }
  }
  readonly runtime: TaskRuntime = { id: POLARS_FIXED_RUNTIME, execute: async context => {
    if (context.task.action !== 'polars.fixed.calculate') fail('POLARS_METHOD', '未登记的固定计算动作。');
    const frozen = context.task.args as unknown as FrozenTask, input = readInput(frozen.input, true);
    if (context.task.versions.polarsInput !== wfdSha256(canonicalWfdJson(frozen))
      || context.task.versions.polarsConnection !== wfdSha256(canonicalWfdJson(frozen.connection))) fail('POLARS_INPUT_BINDING', '任务固定输入或连接摘要不符。');
    const runtime = this.options.processRuntime ?? fail('POLARS_NOT_CONFIGURED', '受信进程运行时尚未装配。');
    const assertAuthorized = () => {
      context.signal.throwIfAborted(); this.assertConnection(frozen.connection);
      if (!this.tasks.isRunActive(context.runId, context.generation) || this.tasks.get(context.task.id).currentAttemptId !== context.attemptId) fail('TASK_NOT_ACTIVE', '原计算尝试已失效。');
      if (runtime.path('polars-python') !== frozen.python) fail('POLARS_IMPLEMENTATION_CHANGED', '任务选定的Polars专用Python程序已改变。');
      context.assertAuthorized({ operationId: 'polars.fixed', operationVersion: 1, argsDigest: digestOperationArgs(context.task.args),
        targets: [{ kind: 'file', path: frozen.python }], approvalMode: 'automatic' }, [{ action: 'execute', target: { kind: 'file', path: frozen.python } }]);
    };
    const execution = { context, processRuntime: runtime, pythonExecutable: frozen.python, assertAuthorized };
    assertAuthorized();
    let output: { jsonBytes: Buffer; evidence: unknown }, algorithmDefinition: WfdRecord;
    if (input.method === 'observation_ma20') {
      const daily = frozen.daily ?? fail('POLARS_INPUT_BINDING', '任务没有冻结日线完整系列选集。');
      const inputs = [];
      for (const ref of daily.refs) {
        assertAuthorized();
        inputs.push(await this.options.auto.readCalculationInput(ref, { method: 'source_observation_ma', period: 20, valueColumn: input.valueColumn }));
      }
      output = await projectDailyPolars(execution, input.valueColumn, inputs, daily.context);
      algorithmDefinition = sourceObservationMAAlgorithmDefinition((output.evidence as any).checkedInput as CalculatedMAProof);
    } else if (input.method === 'financial_linear') {
      output = await projectFinancialPolars(execution, input.calculation, this.options.workspace.readProduct.bind(this.options.workspace),
        this.options.verifyFinancialReview ?? (() => fail('POLARS_FINANCIAL_REVIEW', '本宿主尚未装配跨修订原文核对；未因已登记其他财务任务而放宽。')));
      algorithmDefinition = (output.evidence as any).algorithmDefinition;
    } else {
      output = await projectMacroYoYPolars(execution, input.calculation, this.options.workspace.readProduct.bind(this.options.workspace));
      algorithmDefinition = (output.evidence as any).algorithmDefinition;
    }
    assertAuthorized();
    const rows = JSON.parse(output.jsonBytes.toString()) as WfdRecord[];
    const candidateSha256 = wfdSha256(output.jsonBytes), computedAt = new Date().toISOString();
    const eligibility = evaluateResultEligibility(input, output.evidence, rows, candidateSha256, computedAt);
    const data = canonicalWfdJson({ version: POLARS_FIXED_VERSION, rows, evidence: output.evidence, algorithmDefinition,
      candidateSha256, computedAt, eligibility: eligibility.result, restriction: eligibility.restriction,
      derivedInputs: eligibility.derivedInputs, publication: 'candidate_only' });
    if (input.method === 'financial_linear' && Buffer.byteLength(data) > 2_000_000) fail('POLARS_OUTPUT_BUDGET', '财务候选及必要固定行证据超过原2MB输出预算；未截断证据或采用候选。');
    return { summary: `Polars ${input.method} 完成 ${rows.length} 行候选；尚未正式发布。`,
      data: JSON.parse(data) };
  } };
  private task(taskId: string): TaskRecord {
    id(taskId); const task = this.tasks.get(taskId);
    if (task.runtimeId !== POLARS_FIXED_RUNTIME) fail('POLARS_TASK_NOT_FOUND', '该任务不是本固定Polars入口创建。'); return task;
  }
  private result(task: TaskRecord): WfdRecord & { rows: WfdRecord[]; candidateSha256: string; algorithmDefinition: WfdRecord;
    eligibility?: PurposeEligibilityResult; restriction?: RestrictionEvidence; computedAt?: string; derivedInputs?: DerivedInputEvidence[] } {
    const result = task.result?.data;
    if (task.status !== 'succeeded' || !isWfdRecord(result) || !Array.isArray(result.rows) || !isWfdRecord(result.algorithmDefinition)
      || result.publication !== 'candidate_only' || result.candidateSha256 !== wfdSha256(canonicalWfdJson(result.rows))) fail('POLARS_RESULT_UNAVAILABLE', '任务没有可核对的完整成功候选。');
    return result as WfdRecord & { rows: WfdRecord[]; candidateSha256: string; algorithmDefinition: WfdRecord;
      eligibility?: PurposeEligibilityResult; restriction?: RestrictionEvidence; computedAt?: string; derivedInputs?: DerivedInputEvidence[] };
  }
  private stageRequest(taskId: string) { return 'polars-stage:' + taskId; }
  private stageState(taskId: string) {
    const exists = this.options.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='harness_material_uploads'").get();
    const saved = exists ? this.options.database.connection.prepare('SELECT task_id FROM harness_material_uploads WHERE request_id=?').get(this.stageRequest(taskId)) : null;
    const custodyTaskId = saved?.task_id ? String(saved.task_id) : null;
    const material = custodyTaskId ? this.options.materials.getByTask(custodyTaskId) : null;
    return { custodyTaskId, materialId: material?.envelope.materialId ?? null };
  }
  private connection() { return this.options.workspace.capabilities().connection ?? fail('POLARS_NOT_CONFIGURED', '没有已装配的受信R1固定读取连接。'); }
  private assertConnection(expected: unknown) { if (canonicalWfdJson(this.connection()) !== canonicalWfdJson(expected)) fail('POLARS_CONNECTION_CHANGED', '任务固定的读取连接已变化；没有改读其他实例。'); }
  private assertDispatch() { if (this.tasks.getControl().stopped) fail('BD_STOPPED', '服务已停止，未创建新的Polars任务或交接。'); }
}
