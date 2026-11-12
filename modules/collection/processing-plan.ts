import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CoreDatabase } from '../../platform/state/database.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { TaskError, type TaskExecutionContext, type TaskRecord, type TaskResult, type TaskRuntime, type TaskService } from '../../platform/jobs/tasks.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { MaterialService } from './materials/service.js';
import type { MaterialLocation } from './materials/contracts.js';
import { readXlsxTableSelection, type XlsxTableSelection } from './data-processing/xlsx-table.js';
import { readSourceProjection } from './source-reported-table.js';
import type { PolarsSourceCleaner } from './data-processing/polars-cleaning.js';
import { MAX_SOURCE } from '../../platform/capabilities/conversion/formats.js';
import { readNumericFormat } from './data-processing/numeric-format.js';
import { readXbrlSelection } from './data-processing/xbrl-table.js';
import { readNecessaryTextSelection } from './data-processing/necessary-text.js';
import { readFinancialPdfSelection, projectFinancialPdf } from './data-processing/financial-pdf.js';
import { readFinancialCalculation, projectFinancialFixed, type FinancialReader } from './data-processing/financial-fixed.js';
import { R1_TABULAR_RULE_VERSION, checkR1TabularRows, compileR1TabularDeclaration, isR1TabularDeclaration, parseR1Utc } from './r1-tabular.js';
import { r1SourceGaps } from './r1-source.js';
import { adapterColumnType, adapterTypeCompatible, readAdapterBindingRef, type FrozenAdapterBinding } from './endpoint-adapter.js';
import { decodeAdapterSource } from './endpoint-adapter.js';
import type { EndpointAdapterRegistry } from './endpoint-adapter-registry.js';
import {
  CANDIDATE_LIMITS, CANDIDATE_SELECTION_LIMITS, CANDIDATE_STAGE_VERSIONS, annotateCandidateTable, checkCandidateTables, cleanCandidateTable,
  parseTableSource, structureCandidateTable, type AnnotatedCandidateTable, type CandidateTablePlan,
  type CandidateCsvSelectionEvidence, type CleanedCandidateTable, type ParsedCandidateTable, type StructuredCandidateTable,
} from './candidate-pipeline.js';
import {
  DIMENSION_KEYS, PROCESSING_POLICY, PROCESSING_POLICY_DIGEST, CLASSIFICATION_DIMENSIONS, REVIEW_DIMENSIONS,
  deriveMaterialRouting, deriveOutputRouting, dimensionLabel, emptyDimensions, gapsForDimensions, isPublishAction,
  mergeDimensions, type CustodyState, type DimensionKey, type DimensionSuggestion, type MaterialFacts,
  type NormalizedDimension, type NormalizedEvidence, type RoutingState, type StructuredUsage, type UsageQualification,
} from './processing-routing.js';
import { ELIGIBILITY_HISTORY_MODES, ELIGIBILITY_PURPOSES, PURPOSE_ELIGIBILITY_RULE_VERSION,
  evaluatePurposeEligibility, type EligibilityHistoryMode, type EligibilityPurpose, type PurposeEvidenceClaim } from './purpose-eligibility.js';

export const PROCESSING_PLAN_RUNTIME = 'bd.processing-plans';
export const PROCESSING_PLAN_VERSION = 'bd-processing-plan/1';
export const PROCESSING_ACTIONS = Object.freeze({ decide: 'data.processing.decide', plan: 'data.processing.plan',
  execute: 'data.processing.execute', run: 'data.processing.run', recover: 'data.processing.recover' } as const);
export const PROCESSING_LIMITS = Object.freeze({ maxOutputs: 16, maxMaterials: 32, maxTablesPerOutput: 32, maxSteps: 256,
  maxInputBytes: 131_072, maxObjectBytes: CANDIDATE_LIMITS.maxStructuredBytes, maxPlanBytes: CANDIDATE_LIMITS.maxObjectBytes,
  maxRows: CANDIDATE_LIMITS.maxRows, maxFields: CANDIDATE_LIMITS.maxFields, maxEvidence: 20, maxSuggestions: 40,
  maxRequestIdLength: 160 });
const NORMALIZATION_SUMMARY_MAX_BYTES = 4096;
export const PROCESSING_STEP_KINDS = ['parse', 'clean', 'structure', 'annotate', 'check'] as const;
export type ProcessingStepKind = typeof PROCESSING_STEP_KINDS[number];
export type ProcessingStepState = 'pending' | 'succeeded' | 'failed' | 'blocked';
export type StepApplicability = 'applicable' | 'not_applicable' | 'unknown';
export type OutputState = 'pending' | 'structured' | 'blocked' | 'failed' | 'custody_only';

export interface ManagedObjectRef { kind: 'stored-object'; sha256: string; byte_length: number; media_type: string }
/** 只由候选服务的 candidate_objects 实现，处理计划不另建对象表。 */
export interface PlanObjectStore {
  put(bytes: Buffer, mediaType: string): ManagedObjectRef;
  get(ref: ManagedObjectRef): Buffer;
  verify(ref: ManagedObjectRef): boolean;
}
export interface OperatorContext {
  operatorId: string; requestId: string; method: string; path: string; remoteAddress: string | null; observedAt: number;
  /** 受信会话宿主来源；与 operator-http 分开，HTTP 路由不能提供 user-message 证据。 */
  source?: 'operator-http' | 'conversation';
  conversation?: { conversationId: string; branchId: string; verifyUserMessage?(messageId: string, quote: string): boolean };
}
export interface ProcessingSuggestionInput { dimension: DimensionKey; value: string; proposalId?: string; judgmentId?: string }
export interface ProcessingEvidenceInput { source: 'material' | 'material-table' | 'operator' | 'user-message' | 'model-proposal';
  materialId?: string; quote?: string; start?: number; end?: number; field?: string; messageId?: string;
  proposalId?: string; judgmentId?: string; column?: string; scope?: 'header' | 'column_constant'; xlsxSelection?: XlsxTableSelection }
export interface ProcessingDimensionInput { status: 'known' | 'unknown' | 'conflict'; value?: string; gap?: string;
  evidence?: ProcessingEvidenceInput[] }
export interface ProcessingMaterialRoutingInput { materialId: string; dimensions?: Partial<Record<DimensionKey, ProcessingDimensionInput>>;
  suggestions?: ProcessingSuggestionInput[]; intendedAction?: 'inspect' | 'publish' }
export interface ProcessingTargetInput { productRef?: WfdRecord; declaration?: WfdRecord; expectedSnapshotId?: string | null }
export interface ProcessingUsageInput { purpose?: string; historyMode?: string | null; cutoff?: string | null;
  perspective?: string | null; messageId?: string; quote?: string }
export interface ProcessingOutputInput { outputId: string; materialIds: string[]; tables?: CandidateTablePlan[]; target?: ProcessingTargetInput;
  dimensions?: Partial<Record<DimensionKey, ProcessingDimensionInput>>; suggestions?: ProcessingSuggestionInput[]; rejectReason?: string;
  coverage?: { complete: boolean; gaps: string[]; scope: string }; intendedAction?: 'inspect' | 'publish'; usage?: ProcessingUsageInput }
export interface ProcessingPlanInput { routing: { materials: ProcessingMaterialRoutingInput[] }; outputs: ProcessingOutputInput[];
  previousPlanId?: string }
export interface ProcessingDecisionInput { materialId: string; dimensions?: Partial<Record<DimensionKey, ProcessingDimensionInput>>;
  suggestions?: ProcessingSuggestionInput[]; intendedAction?: 'inspect' | 'publish' }

interface StepSpec { stepId: string; outputId: string; kind: ProcessingStepKind; required: boolean; applicability: StepApplicability;
  dependsOn: string[]; implementation: string; parameters: WfdRecord; completion: WfdRecord; input: WfdRecord; gaps: string[]; specDigest: string }
interface InitializedStep { spec: StepSpec; state: ProcessingStepState; output: ManagedObjectRef | null; outputDigest: string | null;
  checkScope: string[]; gaps: string[]; reusedFrom: { planId: string; stepId: string } | null;
  startedAt: number | null; completedAt: number | null; error: null; semantic: ProcessingSemanticEvidence | null;
  normalization: WfdRecord | null }
export interface ProcessingSemanticEvidence {
  quality: 'pending' | 'pass' | 'fail' | 'indeterminate';
  ruleVersion: string; ruleDigest: string; checkScope: string[]; gaps: string[];
  coverage: { scope: 'processed_output_rows'; inputRows: number | null; checkedRows: number | null; complete: boolean;
    sourceSelections?: CandidateCsvSelectionEvidence[] };
  error?: { code: string; message: string };
}
interface NormalizedMaterialRouting { materialId: string; facts: MaterialFacts; dimensions: NormalizedDimension[];
  suggestions: DimensionSuggestion[]; routingState: RoutingState; gaps: string[]; intendedAction: 'inspect' | 'publish' }
interface NormalizedOutput { outputId: string; materialIds: string[]; tables: CandidateTablePlan[]; target: ProcessingTargetInput | null;
  intendedAction: 'inspect' | 'publish'; usage: StructuredUsage; dimensions: NormalizedDimension[]; suggestions: DimensionSuggestion[]; rejectReason: string | null;
  coverage: { complete: boolean; gaps: string[]; scope: string } | null; adapterGaps: string[]; routingState: RoutingState;
  gaps: string[]; steps: StepSpec[] }
interface NormalizedPlanInput { requestId: string; previousPlanId: string | null; operator: OperatorContext;
  materials: NormalizedMaterialRouting[]; outputs: NormalizedOutput[]; steps: StepSpec[]; scopeKey: string;
  executionDigest: string; contentDigest: string; reuseFromPlanId: string | null }
interface NormalizedDecisionInput { requestId: string; operator: OperatorContext; materialId: string; facts: MaterialFacts;
  dimensions: NormalizedDimension[]; suggestions: DimensionSuggestion[]; routingState: RoutingState; gaps: string[];
  contentDigest: string; decisionId: string }
interface RequestRow { request_key: string; client_request_id: string; kind: string; task_id: string | null; plan_id: string | null;
  decision_id: string | null; content_digest: string; input_json: string; created_at: number }
interface PlanRow { plan_id: string; request_key: string; parent_plan_id: string | null; plan_digest: string; scope_key: string;
  policy_version: string; policy_digest: string; policy_json: string; operator_json: string; material_manifest_json: string;
  plan_json: string; status: string; created_at: number; updated_at: number }
interface StepRow { plan_id: string; step_id: string; ordinal: number; output_id: string; kind: string; required: number;
  applicability: string; depends_json: string; implementation: string; parameters_json: string; completion_json: string;
  spec_digest: string; state: string; input_json: string; output_json: string | null; output_digest: string | null;
  check_scope_json: string; gaps_json: string; error_json: string | null; reused_from_plan_id: string | null;
  reused_from_step_id: string | null; started_at: number | null; completed_at: number | null; attempt_task_id: string | null;
  semantic_json: string | null; normalization_json: string | null }
interface OutputRow { plan_id: string; output_id: string; state: string; structured_json: string | null; structured_digest: string | null;
  routing_state: string; dimensions_json: string; gaps_json: string; updated_at: number }
interface DecisionRow { decision_id: string; scope_kind: string; material_id: string; output_id: string | null; plan_id: string | null;
  material_ids_json: string; custody_state: string; routing_state: string; dimensions_json: string; suggestions_json: string;
  gaps_json: string; request_key: string; revision: number; created_at: number; updated_at: number }

const SCHEMA = `
CREATE TABLE processing_requests (
 request_key TEXT PRIMARY KEY, client_request_id TEXT NOT NULL, kind TEXT NOT NULL,
 task_id TEXT, plan_id TEXT, decision_id TEXT, content_digest TEXT NOT NULL,
 input_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX processing_requests_client ON processing_requests(client_request_id,created_at);
CREATE INDEX processing_requests_task ON processing_requests(task_id);
CREATE TABLE processing_plans (
 plan_id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE REFERENCES processing_requests(request_key),
 parent_plan_id TEXT, plan_digest TEXT NOT NULL, scope_key TEXT NOT NULL,
 policy_version TEXT NOT NULL, policy_digest TEXT NOT NULL, policy_json TEXT NOT NULL,
 operator_json TEXT NOT NULL, material_manifest_json TEXT NOT NULL, plan_json TEXT NOT NULL,
 status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX processing_plans_scope ON processing_plans(scope_key,policy_version,created_at);
CREATE TABLE processing_plan_steps (
 plan_id TEXT NOT NULL REFERENCES processing_plans(plan_id), step_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 output_id TEXT NOT NULL, kind TEXT NOT NULL, required INTEGER NOT NULL, applicability TEXT NOT NULL,
 depends_json TEXT NOT NULL, implementation TEXT NOT NULL, parameters_json TEXT NOT NULL, completion_json TEXT NOT NULL,
 spec_digest TEXT NOT NULL, state TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT, output_digest TEXT,
 check_scope_json TEXT NOT NULL, gaps_json TEXT NOT NULL, error_json TEXT, reused_from_plan_id TEXT,
 reused_from_step_id TEXT, started_at INTEGER, completed_at INTEGER, attempt_task_id TEXT,
 PRIMARY KEY(plan_id,step_id)
);
CREATE INDEX processing_plan_steps_spec ON processing_plan_steps(spec_digest,state);
CREATE TABLE processing_plan_outputs (
 plan_id TEXT NOT NULL REFERENCES processing_plans(plan_id), output_id TEXT NOT NULL, state TEXT NOT NULL,
 structured_json TEXT, structured_digest TEXT, routing_state TEXT NOT NULL, dimensions_json TEXT NOT NULL,
 gaps_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(plan_id,output_id)
);
CREATE TABLE routing_decisions (
 decision_id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, material_id TEXT NOT NULL, output_id TEXT,
 plan_id TEXT, material_ids_json TEXT NOT NULL, custody_state TEXT NOT NULL, routing_state TEXT NOT NULL,
 dimensions_json TEXT NOT NULL, suggestions_json TEXT NOT NULL, gaps_json TEXT NOT NULL,
 request_key TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX routing_decisions_material ON routing_decisions(scope_kind,material_id,created_at);
CREATE INDEX routing_decisions_output ON routing_decisions(plan_id,output_id);
`;

/**
 * 六维路由与独立处理步骤的持久化服务。
 * 任务受理、停止、预算、generation 和恢复仍由唯一 TaskService 拥有；本服务只保存计划、步骤、产物与路由事实。
 */
export class ProcessingPlanService {
  readonly versionBinding: Record<string, string>;
  constructor(private readonly options: { database: CoreDatabase; tasks(): TaskService; materials: MaterialService;
    objects: PlanObjectStore; financialReader?: FinancialReader; financialReaderIdentity?(): unknown;
    /** 端点适配登记：只提供已采用版本的冻结配置与漂移记录。 */
    adapters?: EndpointAdapterRegistry;
    /** 独立清洗引擎，仅处理 parse→clean；不调用金融公式或计算任务。 */
    polarsCleaner?: PolarsSourceCleaner;
    /** Host-only module switches; cannot be changed by model tools or an existing plan. */
    modules?: Partial<Record<ProcessingStepKind, boolean>> }) {
    const files = ['./processing-plan.ts', './processing-routing.ts', './candidate-pipeline.ts', './candidate-csv-records.ts', './source-reported-table.ts', './r1-source.ts', './data-processing/xlsx-table.ts', './data-processing/numeric-format.ts', './data-processing/xbrl-table.ts', './data-processing/necessary-text.ts', './data-processing/financial-pdf.ts', './data-processing/financial-fixed.ts', './endpoint-adapter.ts', '../../platform/capabilities/conversion/office.ts', '../../platform/capabilities/conversion/formats.ts'].map(path => readFileSync(new URL(path, import.meta.url)));
    this.versionBinding = Object.freeze({ processing: PROCESSING_PLAN_VERSION,
      implementation: wfdSha256(Buffer.concat(files)), policy: PROCESSING_POLICY_DIGEST,
      ...(options.modules ? { productionModules: wfdSha256(canonicalWfdJson(options.modules)) } : {}),
      ...(options.polarsCleaner ? options.polarsCleaner.versionBinding : {}) });
    options.database.migrate('collection_processing', 1, SCHEMA);
    options.database.migrate('collection_processing_semantic_checks', 1, 'ALTER TABLE processing_plan_steps ADD COLUMN semantic_json TEXT;');
    options.database.migrate('collection_processing_type_changes', 1, 'ALTER TABLE processing_plan_steps ADD COLUMN normalization_json TEXT;');
  }
  private get db() { return this.options.database.connection; }
  private get tasks() { return this.options.tasks(); }

  /** Each of five stages is independently detachable without creating another TaskService runtime. */
  moduleCapability(kind: ProcessingStepKind) {
    if (!PROCESSING_STEP_KINDS.includes(kind)) fail('PRODUCTION_MODULE_KIND', '未登记的数据处理模块。');
    const enabled = this.options.modules?.[kind] !== false;
    const numerical = kind === 'clean' || kind === 'structure';
    const backend = numerical ? this.options.polarsCleaner?.capabilities() : undefined;
    const status = !enabled ? 'unplugged' as const
      : backend?.status === 'blocked' ? 'blocked' as const : 'ready' as const;
    return { module: kind, status, reason: !enabled ? '受信宿主已拔除该处理模块。'
      : backend?.status === 'blocked' ? backend.reason
        : null, engine: numerical ? backend ? 'polars' : 'typescript_compatibility'
        : kind === 'check' ? 'shared_production_verifier' : 'fixed_typescript',
      interface: 'data.modules.' + kind, ownsTaskRuntime: false,
      sourcePolicy: 'frozen_material_plan_or_wfd_read_only' };
  }
  private assertModuleEnabled(kind: ProcessingStepKind): void {
    const capability = this.moduleCapability(kind);
    if (capability.status !== 'ready') fail('PRODUCTION_MODULE_UNAVAILABLE',
      capability.reason ?? '该数据生产模块尚不可执行。');
  }

  catalog(): JsonValue {
    return asJson({
      contract: 'bd.processing-plan/1', version: PROCESSING_PLAN_VERSION, versions: this.versionBinding, limits: PROCESSING_LIMITS,
      stageModules: PROCESSING_STEP_KINDS.map(kind => this.moduleCapability(kind)),
      cleaningEngine: this.options.polarsCleaner?.capabilities() ?? {
        engine: 'typescript', status: 'legacy_compatibility', reason: '受信 Polars 未装配，沿原冻结处理契约执行。',
        methods: ['trim', 'empty_to_null'], noSilentFallback: true },
      calculationMethods: 'not_part_of_cleaning',
      custodyStates: ['inventoried', 'receiving', 'received'], routingStates: ['needs_classification', 'needs_adapter', 'needs_target', 'needs_review', 'ready_candidate', 'rejected'],
      dimensions: DIMENSION_KEYS.map(key => ({ key, label: dimensionLabel(key), statuses: ['known', 'unknown', 'conflict'] })),
      policy: PROCESSING_POLICY,
      steps: [
        { kind: 'parse', implementation: CANDIDATE_STAGE_VERSIONS.parse, adapters: ['utf8-csv/1', 'utf8-json-table/1', 'utf8-csv-exact-selection/1', 'xlsx-explicit-selection/1',
          'bd-xbrl-numeric/1', 'bd-necessary-business-paragraph/1', 'bd-financial-pdf-regions/1', 'bd-financial-fixed/1'],
          rules: ['strict_utf8', 'csv_or_json_row_table', 'unique_nonempty_source_fields', 'explicit_field_mapping', 'explicit_scalar_types', 'trim', 'empty_to_null', 'constant_annotations'],
          applicability: 'CSV/JSON tables; explicit XLSX cells; namespace-resolved numeric XBRL subset; reviewed whole UTF-8 business paragraphs; frozen native PDF regions; trusted fixed financial records. Unsupported structures remain blocked.', required: true,
          output: 'parsed table with original values, source types, quotes and locations' },
        { kind: 'clean', implementation: CANDIDATE_STAGE_VERSIONS.clean, rules: ['trim', 'empty_to_null'],
          applicability: 'not_applicable only when neither rule is declared', required: true, output: 'cleaned table with per-change original values' },
        { kind: 'structure', implementation: CANDIDATE_STAGE_VERSIONS.structure,
          rules: ['string', 'safe_integer', 'decimal_string', 'boolean', 'binary64_hex', 'json_number_literal_preservation'],
          applicability: 'always for supported table sources; unsafe precision blocks', required: true, output: 'typed table retaining original values and bounded actual type-change evidence' },
        { kind: 'annotate', implementation: CANDIDATE_STAGE_VERSIONS.annotate, rules: ['constant_scalars_only', 'no_source_field_override'],
          applicability: 'not_applicable when no constant is declared', required: true, output: 'typed table plus validated constants' },
        { kind: 'check', implementation: CANDIDATE_STAGE_VERSIONS.check,
          rules: ['strict_utf8_decoding', 'table_shape', 'unique_nonempty_fields', 'explicit_field_mapping', 'explicit_scalar_types', 'finite_scalars', 'decimal_precision_roundtrip', 'type_changes_recorded', 'row_budget', 'output_digest'],
          applicability: 'tables projected by listed adapters independent of routing semantics; semantic gaps remain explicit and are never lifted by a structural check', required: true,
          output: 'candidate-ready {rows} object and structural evidence; business semantics remain explicit gaps' },
      ],
      notImplemented: ['business rule applicability and implementation coverage beyond the listed bindings are unverified', 'OCR/transcription semantic validation', 'binary/code execution', 'formal database admission', 'archive member expansion'],
      semanticAdapters: [{ protocol: 'wfd.structured-ingest/1.0', mappingKind: 'tabular_rows', ruleVersion: R1_TABULAR_RULE_VERSION,
        scope: 'explicit general table fields or declared daily/minute market roles; structural artifacts and per-output semantic quality remain separate',
        publication: 'only a matching pass permits this rule-qualified candidate; source authority and WFD admission remain separate' }],
      csvSelection: { predicate: 'exact original column/string equality', maxSourceBytes: CANDIDATE_LIMITS.maxObjectBytes,
        ...CANDIDATE_SELECTION_LIMITS, completion: 'full EOF scan with selected/excluded coverage; no truncation' },
      endpointAdapter: { contract: 'bd.endpoint-adapter/1', configured: !!this.options.adapters,
        binding: '{adapterId, version, configDigest}',
        lifecycle: 'candidate → actual replay (accept+reject samples) → trusted local adoption → only new plans consume the adopted version',
        carriers: ['json', 'jsonp', 'js-variable-assignment', 'json-embedded-delimited'],
        charsets: ['utf-8', 'gbk', 'gb18030'],
        scope: 'one declarative operator for all endpoints; securities and dates are call inputs, never configuration keys',
        adoptionAuthority: 'trusted local entry only; model-supplied authorization or READY is not adoption evidence',
        drift: 'success-predicate/container/carrier mismatch fails the step and records an isolated reason; no fallback to another version' },
      financialFixed: { version: 'bd-financial-fixed/1', operations: ['standardize', 'quarter_difference', 'ttm'],
        calculation: { version: 'bd-financial-fixed/1', operation: 'one listed operation', inputs: [{ snapshotId: 'exact fixed snapshot ID',
          productId: 'exact fixed product ID', businessKeys: ['exact logical key from fixed read'] }],
          compatibilityReview: 'optional {materialId,originalSha256,quote}; required for listed unchanged-net-profit cross-revision cases, using an actual material in this output' },
        input: 'fixed snapshotId/productId/businessKeys only, read by bound host; no caller-supplied values',
        scope: 'CAS/CNY registered primary-statement concepts; explicit natural-year adjacent quarters and TTM; additive flows only; reviewed unchanged net profit across revisions',
        limits: '38 decimal digits, 18 fractional digits; unsupported units, fiscal calendars, concepts and revision compatibility remain blocked' },
      tableInputs: { common: ['materialId', 'format'], optional: ['fieldMapping', 'types', 'trim', 'emptyToNull', 'annotations', 'numericFormats'],
        endpointAdapter: 'optional sourceAdapter:{adapterId,version,configDigest}; only an adopted version is resolved and frozen into this plan; format stays the carrier family (csv|json)',
        dedicated: { xlsx: { required: ['xlsxSelection'], shape: 'sheetName,headerRow,firstDataRow,lastDataRow,firstColumn,lastColumn,columns[{column,header,name,type?}]' },
          xbrl: { required: ['xbrlSelection'], shape: '{version:"bd-xbrl-numeric/1",reportId,reportVersion,concepts:["{namespaceURI}localName"]}; empty concepts selects all supported numeric facts' },
          text: { required: ['necessaryTextSelection'], shape: '{version:"bd-necessary-business-paragraph/1",sourceSha256,documentVersion,purpose,reviewBasis,paragraphs:[{start,end,quote}]}; complete original paragraphs only' },
          pdf: { required: ['pdfSelection'], shape: '{version:"bd-financial-pdf-regions/1",sourceSha256,report:{id,version,subjectScheme,subjectCode,accountingStandard,currency,auditStatus},regions:[{page,yMin,yMax,statement,scope,section,label:[xMin,xMax],expectedLabels,rowBands:[{yMin,yMax}],columns:[{xMin,xMax,dimension,periodType,startDate,endDate,unit,numericFormat}],continuations?:[{rowIndex,columnIndex,page,yMin,yMax,xMin,xMax,quote}]}]}' },
          'financial-fixed': { required: ['financialCalculation'], shape: 'financialFixed.calculation above; executable only through this managed plan and bound trusted reader' } },
        numericFormat: '{decimal:"."|",",grouping:"."|","|" "|null,negative:"minus"|"minus_or_parentheses",plus:boolean,percent:"reject"|"as_reported"|"fraction"}; only for explicit decimal_string columns' },
      operatorInput: { requestId: 'stable request identity', operatorId: 'trusted local operator identity', evidence: 'operator-http field evidence or material quote; user-message evidence is accepted only from the trusted conversation host, never from HTTP' },
      reuse: 'same material sha256 + same step implementation/parameters/completion + same policy reuses succeeded step artifacts; changed rules recompute the step and downstream only',
    });
  }
  status(): JsonValue {
    return asJson({ state: 'step_plans_enabled', version: PROCESSING_PLAN_VERSION, versions: this.versionBinding,
      routingStates: ['needs_classification', 'needs_adapter', 'needs_target', 'needs_review', 'ready_candidate', 'rejected'],
      custodyStates: ['inventoried', 'receiving', 'received'], steps: PROCESSING_STEP_KINDS, limits: PROCESSING_LIMITS,
      note: '材料保管与逐输出路由分开；步骤产物写入 candidate_objects，未知不按不适用跳过。' });
  }

  /* ── 对外操作：受理只创建唯一任务，实际持久化在 runtime 内完成。 ───────────────────────── */

  decideMaterial(input: unknown, operator: OperatorContext): TaskRecord {
    const normalized = this.normalizeDecision(input, operator);
    const requestKey = requestKeyFor('decide', operator.requestId);
    const previous = this.request(requestKey);
    if (previous) {
      if (previous.content_digest !== normalized.contentDigest) fail('REQUEST_CONFLICT', '同一路由请求不能更换材料、维度、证据或操作者。');
      return this.task(previous);
    }
    this.assertDispatch();
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      this.assertDispatch();
      accepted = this.tasks.createInTransaction({ title: `材料路由决定：${normalized.materialId}`, ownerRole: 'service',
        runtimeId: PROCESSING_PLAN_RUNTIME, action: PROCESSING_ACTIONS.decide, args: json({ decisionId: normalized.decisionId,
          requestId: operator.requestId, contentDigest: normalized.contentDigest, materialId: normalized.materialId }),
        requestId: requestKey, versions: this.versionBinding });
      this.db.prepare('INSERT INTO processing_requests VALUES(?,?,?,?,?,?,?,?,?)').run(requestKey, operator.requestId, 'decide',
        accepted.task.id, null, normalized.decisionId, normalized.contentDigest, canonicalWfdJson(normalized), Date.now());
    });
    accepted.publish(); return this.tasks.start(accepted.task.id, accepted.task.version);
  }

  preparePlan(input: unknown, operator: OperatorContext): TaskRecord {
    const normalized = this.normalizePlan(input, operator);
    const requestKey = requestKeyFor('plan', operator.requestId);
    const previous = this.request(requestKey);
    if (previous) {
      if (previous.content_digest !== normalized.contentDigest) fail('REQUEST_CONFLICT', '同一计划请求不能更换原件、规则、声明、维度或操作者。');
      return this.task(previous);
    }
    this.assertDispatch();
    const planId = randomUUID();
    const reuseFromPlanId = normalized.previousPlanId ?? this.findReusePlanId(normalized.scopeKey);
    const accepted = this.createTaskWithRequest({ title: normalized.previousPlanId ? `修订处理计划：${normalized.outputs.map(o => o.outputId).join(',')}`
      : `准备处理计划：${normalized.outputs.map(o => o.outputId).join(',')}`, kind: 'plan', action: PROCESSING_ACTIONS.plan,
      requestKey, requestId: operator.requestId, planId, decisionId: null, contentDigest: normalized.contentDigest,
      args: { planId, requestId: operator.requestId, contentDigest: normalized.contentDigest },
      input: { ...normalized, planId, reuseFromPlanId },
      ...(normalized.previousPlanId && this.planTaskId(normalized.previousPlanId) ? { parentTaskId: this.planTaskId(normalized.previousPlanId) } : {}),
      ...(!normalized.previousPlanId ? { budget: { maxStorageBytes: PROCESSING_LIMITS.maxPlanBytes } } : {}) });
    return accepted;
  }

  revisePlan(planId: string, input: unknown, operator: OperatorContext): TaskRecord {
    validId(planId, 'PROCESSING_PLAN_ID');
    if (!this.planRow(planId)) fail('PROCESSING_PLAN_NOT_FOUND', '没有该处理计划。');
    if (!isWfdRecord(input)) fail('PROCESSING_INPUT', '修订输入须为明确计划对象。');
    return this.preparePlan({ ...(input as unknown as ProcessingPlanInput), previousPlanId: planId }, operator);
  }

  executeStep(planId: string, stepId: string, operator: OperatorContext): TaskRecord {
    validId(planId, 'PROCESSING_PLAN_ID'); validStepId(stepId);
    const plan = this.planRow(planId); if (!plan) fail('PROCESSING_PLAN_NOT_FOUND', '没有该处理计划。');
    const step = this.stepRow(planId, stepId); if (!step) fail('PROCESSING_STEP_NOT_FOUND', '没有该处理步骤。');
    this.assertModuleEnabled(step.kind as ProcessingStepKind);
    if (step.state === 'succeeded') fail('PROCESSING_STEP_ALREADY_SUCCEEDED', '该步骤已有完成产物；查询原步骤，不重复执行。');
    const contentDigest = digestOperationArgs({ planId, stepId });
    const requestKey = requestKeyFor('execute', operator.requestId), previous = this.request(requestKey);
    if (previous) {
      if (previous.content_digest !== contentDigest) fail('REQUEST_CONFLICT', '同一执行请求不能更换计划或步骤。');
      return this.task(previous);
    }
    this.assertDispatch();
    return this.createTaskWithRequest({ title: `执行处理步骤：${stepId}`, kind: 'execute', action: PROCESSING_ACTIONS.execute,
      requestKey, requestId: operator.requestId, planId, decisionId: null, contentDigest,
      args: { planId, stepId, requestId: operator.requestId, contentDigest }, input: { planId, stepId },
      ...(this.planTaskId(planId) ? { parentTaskId: this.planTaskId(planId) } : {}) });
  }

  runPlan(planId: string, operator: OperatorContext): TaskRecord {
    validId(planId, 'PROCESSING_PLAN_ID'); if (!this.planRow(planId)) fail('PROCESSING_PLAN_NOT_FOUND', '没有该处理计划。');
    for (const step of this.stepRows(planId)) if (step.state === 'pending' && step.applicability === 'applicable')
      this.assertModuleEnabled(step.kind as ProcessingStepKind);
    const contentDigest = digestOperationArgs({ planId, action: 'run' });
    const requestKey = requestKeyFor('run', operator.requestId), previous = this.request(requestKey);
    if (previous) {
      if (previous.content_digest !== contentDigest) fail('REQUEST_CONFLICT', '同一运行请求不能更换计划。');
      return this.task(previous);
    }
    this.assertDispatch();
    return this.createTaskWithRequest({ title: `运行处理计划：${planId}`, kind: 'run', action: PROCESSING_ACTIONS.run,
      requestKey, requestId: operator.requestId, planId, decisionId: null, contentDigest,
      args: { planId, requestId: operator.requestId, contentDigest }, input: { planId },
      ...(this.planTaskId(planId) ? { parentTaskId: this.planTaskId(planId) } : {}) });
  }

  recoverPlan(planId: string, operator: OperatorContext): TaskRecord {
    validId(planId, 'PROCESSING_PLAN_ID'); if (!this.planRow(planId)) fail('PROCESSING_PLAN_NOT_FOUND', '没有该处理计划。');
    const contentDigest = digestOperationArgs({ planId, action: 'recover' });
    const requestKey = requestKeyFor('recover', operator.requestId), previous = this.request(requestKey);
    if (previous) {
      if (previous.content_digest !== contentDigest) fail('REQUEST_CONFLICT', '同一恢复请求不能更换计划。');
      return this.task(previous);
    }
    this.assertDispatch();
    return this.createTaskWithRequest({ title: `核对处理计划产物：${planId}`, kind: 'recover', action: PROCESSING_ACTIONS.recover,
      requestKey, requestId: operator.requestId, planId, decisionId: null, contentDigest,
      args: { planId, requestId: operator.requestId, contentDigest }, input: { planId },
      ...(this.planTaskId(planId) ? { parentTaskId: this.planTaskId(planId) } : {}) });
  }

  /* ── 查询：旧计划不因实现升级改写；查询只读持久事实。 ─────────────────────────────── */

  get(planId: string) { return this.planView(planId); }
  getByTask(taskId: string) {
    validId(taskId, 'PROCESSING_TASK_ID');
    const row = this.db.prepare('SELECT * FROM processing_requests WHERE task_id=?').get(taskId) as RequestRow | undefined;
    if (!row) return null;
    const planId = row.plan_id ?? this.requestPlanId(row);
    return { taskId, kind: row.kind, requestId: row.client_request_id, plan: planId && this.planRow(planId) ? this.planView(planId) : null,
      decision: row.decision_id ? this.decisionView(row.decision_id) : null };
  }
  findByRequest(requestId: string) {
    validId(requestId, 'PROCESSING_REQUEST_ID');
    const row = this.db.prepare('SELECT * FROM processing_requests WHERE client_request_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(requestId) as RequestRow | undefined;
    if (!row) return null;
    const planId = row.plan_id ?? this.requestPlanId(row);
    return { requestKey: row.request_key, kind: row.kind, taskId: row.task_id, plan: planId && this.planRow(planId) ? this.planView(planId) : null,
      decision: row.decision_id ? this.decisionView(row.decision_id) : null };
  }
  getDecision(materialId: string) {
    validId(materialId, 'PROCESSING_MATERIAL_ID');
    const material = this.db.prepare(`SELECT * FROM routing_decisions WHERE scope_kind='material' AND material_id=?
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(materialId) as DecisionRow | undefined;
    const outputs = this.db.prepare(`SELECT * FROM routing_decisions WHERE scope_kind='output'
      AND (material_id=? OR EXISTS(SELECT 1 FROM json_each(material_ids_json) WHERE value=?))
      ORDER BY created_at DESC,rowid DESC LIMIT 50`).all(materialId, materialId) as unknown as DecisionRow[];
    if (!material && !outputs.length) return null;
    return { materialId, material: material ? this.decisionView(material.decision_id) : null,
      outputs: outputs.map(row => this.decisionView(row.decision_id)) };
  }
  artifact(planId: string, stepId: string) {
    validId(planId, 'PROCESSING_PLAN_ID'); validStepId(stepId);
    const step = this.stepRow(planId, stepId); if (!step || step.state !== 'succeeded' || !step.output_json) fail('PROCESSING_STEP_NOT_READY', '该步骤尚无已持久化产物。');
    const ref = this.ref(step.output_json);
    return { step: this.stepView(step), ref, bytes: this.options.objects.get(ref) };
  }
  outputArtifact(planId: string, outputId: string) {
    validId(planId, 'PROCESSING_PLAN_ID'); validId(outputId, 'PROCESSING_OUTPUT_ID');
    const row = this.outputRow(planId, outputId); if (!row || row.state !== 'structured' || !row.structured_json) fail('PROCESSING_OUTPUT_NOT_READY', '该输出尚未形成完整结构产物。');
    const ref = this.ref(row.structured_json);
    return { outputId, ref, bytes: this.options.objects.get(ref), routingState: row.routing_state, gaps: parseJson(row.gaps_json) };
  }
  /** 候选服务只从这里取已核对的受管引用；不读取客户端自带对象或路径。 */
  candidateOutput(planId: string, outputId: string) {
    const plan = this.planView(planId), output = plan.outputs.find(item => item.outputId === outputId);
    if (!output) fail('PROCESSING_OUTPUT_NOT_FOUND', '该计划没有此输出。');
    if (output.state !== 'structured' || !output.structured) fail('PROCESSING_OUTPUT_NOT_READY', `该输出尚未完成核对：${output.gaps.join('；') || '无缺口说明'}`);
    const ref = this.ref(canonicalWfdJson(output.structured));
    if (!this.options.objects.verify(ref)) fail('PROCESSING_ARTIFACT_CHANGED', '结构产物对象不存在或长度不符。');
    return { planId, outputId, ref, materialIds: output.materialIds, target: output.target ?? null,
      routingState: output.routingState, gaps: output.gaps, semantic: output.semantic,
      planDigest: plan.planDigest, executionDigest: plan.executionDigest, policy: plan.policy,
      steps: output.steps.map(step => ({ stepId: step.stepId, kind: step.kind, state: step.state, applicability: step.applicability,
        implementation: step.implementation, specDigest: step.specDigest, outputDigest: step.outputDigest, reusedFrom: step.reusedFrom })),
      materials: output.materialIds.map(materialId => plan.materials.find(material => material.materialId === materialId)
        ?? fail('PROCESSING_MATERIAL_NOT_FOUND', `输出引用的材料 ${materialId} 不在计划事实中。`))
        .map(material => ({ materialId: material.materialId, sha256: material.sha256, custodyState: material.custodyState })) };
  }

  /* ── 运行时：计划、单步、运行、核对都走同一 TaskService。 ───────────────────────────── */

  readonly runtime: TaskRuntime = { id: PROCESSING_PLAN_RUNTIME, execute: async context => {
    this.assertTaskVersion(context.task); this.assertActive(context);
    const args = context.task.args as { requestId?: unknown; planId?: unknown; decisionId?: unknown };
    const request = this.request(requestKeyFor(actionKind(context.task.action), String(args.requestId)));
    if (!request) fail('PROCESSING_REQUEST_NOT_FOUND', '处理请求的持久输入不存在。');
    if (context.task.action === PROCESSING_ACTIONS.decide) return this.executeDecide(context, request);
    if (context.task.action === PROCESSING_ACTIONS.plan) return this.executePlan(context, request);
    if (context.task.action === PROCESSING_ACTIONS.execute) return this.executeOne(context, request);
    if (context.task.action === PROCESSING_ACTIONS.run) return this.executeRun(context, request);
    if (context.task.action === PROCESSING_ACTIONS.recover) return this.executeRecover(context, request);
    fail('PROCESSING_ACTION', '未登记的处理动作。');
  }, recover: async ({ task, signal }) => {
    const request = this.requestByTask(task.id);
    if (!request) return { outcome: 'not_applied', evidence: '本地处理请求尚未持久化，没有外部副作用。', effects: [] };
    const planId = request.plan_id ?? (task.args as { planId?: string }).planId ?? null;
    if (!planId) return { outcome: 'not_applied', evidence: '该请求没有处理计划；没有可核对的外部对象。', effects: [] };
    if (!this.planRow(planId)) return { outcome: 'not_applied', evidence: '处理计划尚未持久化；没有可复用步骤或外部副作用。', effects: [] };
    signal.throwIfAborted();
    const verified = this.verifyPlan(planId);
    if (verified.corrupt.length) return { outcome: 'failed', evidence: `步骤产物校验失败：${verified.corrupt.join('；')}`, effects: [] };
    const plan = this.planView(planId);
    if (plan.status === 'prepared' || plan.status === 'partial' || plan.status === 'blocked' || plan.status === 'failed') {
      return { outcome: 'succeeded', evidence: '已按原计划身份核对持久步骤与产物；未自动执行新步骤。', result: this.result(plan), effects: [] };
    }
    return { outcome: 'succeeded', evidence: '原计划已完成；按原身份核对持久产物，无外部重发。', result: this.result(plan), effects: [] };
  } };

  private executeDecide(context: TaskExecutionContext, request: RequestRow): TaskResult {
    const input = parseJson(request.input_json) as unknown as NormalizedDecisionInput;
    const existing = input.decisionId ? this.decisionRow(input.decisionId) : null;
    if (existing) return this.resultForDecision(existing);
    this.assertActive(context);
    this.options.database.transaction(() => {
      this.assertActive(context);
      this.insertDecision({ decisionId: input.decisionId, scopeKind: 'material', materialId: input.materialId, outputId: null,
        planId: null, materialIds: [input.materialId], custodyState: input.facts.custodyState, routingState: input.routingState,
        dimensions: input.dimensions, suggestions: input.suggestions, gaps: input.gaps, requestKey: request.request_key });
      this.db.prepare('UPDATE processing_requests SET decision_id=? WHERE request_key=?').run(input.decisionId, request.request_key);
    });
    return this.resultForDecision(this.decisionRow(input.decisionId)!);
  }

  private executePlan(context: TaskExecutionContext, request: RequestRow): TaskResult {
    const stored = parseJson(request.input_json) as unknown as (NormalizedPlanInput & { planId: string; reuseFromPlanId: string | null });
    const existing = this.planRow(stored.planId);
    if (existing) return this.result(this.planView(stored.planId));
    this.assertActive(context);
    const document = this.buildPlanDocument(stored.planId, stored, stored.reuseFromPlanId);
    this.options.database.transaction(() => {
      this.assertActive(context);
      this.insertPlan(document, stored);
      this.db.prepare('UPDATE processing_requests SET plan_id=? WHERE request_key=?').run(stored.planId, request.request_key);
    });
    return this.result(this.planView(stored.planId));
  }

  private async executeOne(context: TaskExecutionContext, request: RequestRow): Promise<TaskResult> {
    const args = parseJson(request.input_json) as { planId: string; stepId: string };
    this.assertPlanExecutable(args.planId);
    const plan = this.planView(args.planId);
    const step = plan.steps.find(item => item.stepId === args.stepId);
    if (!step) fail('PROCESSING_STEP_NOT_FOUND', '没有该处理步骤。');
    this.assertModuleEnabled(step.kind as ProcessingStepKind);
    if (step.state === 'succeeded') return this.result(plan);
    if (step.applicability === 'unknown') fail('PROCESSING_STEP_BLOCKED', `步骤存在未决适用性：${step.gaps.join('；') || '未说明'}`);
    if (step.state === 'blocked') fail('PROCESSING_STEP_BLOCKED', `步骤被上游或语义缺口阻塞：${step.gaps.join('；') || '未说明'}`);
    this.assertActive(context);
    try {
      await this.executeStepCore(context, args.planId, args.stepId);
    } catch (error) {
      if (!isStopError(error)) this.markStepFailed(args.planId, args.stepId, context.task.id, error);
      throw error;
    }
    return this.result(this.planView(args.planId));
  }

  private async executeRun(context: TaskExecutionContext, request: RequestRow): Promise<TaskResult> {
    const { planId } = parseJson(request.input_json) as { planId: string };
    this.assertPlanExecutable(planId);
    let executed = 0;
    for (let iteration = 0; iteration < PROCESSING_LIMITS.maxSteps; iteration++) {
      this.assertActive(context);
      const plan = this.planView(planId);
      if (plan.status === 'completed') break;
      const next = plan.steps.find(step => step.state === 'pending' && step.applicability !== 'unknown'
        && step.dependsOn.every(dep => plan.steps.find(item => item.stepId === dep)?.state === 'succeeded'));
      if (!next) break;
      try {
        await this.executeStepCore(context, planId, next.stepId);
        executed++;
      } catch (error) {
        if (isStopError(error) || isBudgetError(error)) throw error;
        this.markStepFailed(planId, next.stepId, context.task.id, error);
      }
    }
    const plan = this.planView(planId);
    if (executed === 0 && plan.status === 'prepared') {
      const blocked = plan.steps.filter(step => step.state === 'blocked' || step.applicability === 'unknown');
      if (blocked.length) {
        this.options.database.transaction(() => this.refreshPlan(planId));
        return { summary: `没有可执行步骤；${blocked.length} 个步骤因缺口阻塞。`, data: json(this.planView(planId)) as Record<string, JsonValue> };
      }
    }
    return this.result(plan);
  }

  private executeRecover(context: TaskExecutionContext, request: RequestRow): TaskResult {
    const { planId } = parseJson(request.input_json) as { planId: string };
    this.assertActive(context);
    const verified = this.verifyPlan(planId);
    this.options.database.transaction(() => this.refreshPlan(planId));
    return { summary: verified.corrupt.length ? '处理计划产物存在完整性缺口；已记录，未重算或覆盖原对象。' : '已按原计划身份核对步骤产物；未重发或重建已完成步骤。',
      data: json({ plan: this.planView(planId), integrity: verified }) as Record<string, JsonValue> };
  }

  /* ── 标准化：输入、六维证据、材料事实、步骤与摘要。 ─────────────────────────────── */

  private normalizeDecision(input: unknown, operator: OperatorContext): NormalizedDecisionInput {
    validateOperator(operator);
    const raw = readRecord(input, ['materialId', 'dimensions', 'suggestions', 'intendedAction'], 'PROCESSING_DECISION_INPUT');
    const materialId = readId(raw.materialId, 'PROCESSING_MATERIAL_ID');
    const facts = this.materialFacts(materialId);
    const dimensions = this.normalizeDimensions(readDimensions(raw.dimensions), [facts], operator, readSuggestions(raw.suggestions));
    const intendedAction = readIntendedAction(raw.intendedAction);
    const routing = deriveMaterialRouting({ material: facts, dimensions, rejected: false, outputId: null, intendedAction });
    const suggestions = dimensions.flatMap(item => item.suggestions);
    return { requestId: operator.requestId, operator: storedOperator(operator), materialId, facts, dimensions, suggestions,
      routingState: routing.routingState, gaps: routing.gaps, decisionId: randomUUID(),
      contentDigest: digestOperationArgs(withoutVolatile({ materialId, sha256: facts.sha256, dimensions, operatorId: operator.operatorId, intendedAction })) };
  }

  private normalizePlan(input: unknown, operator: OperatorContext): NormalizedPlanInput {
    validateOperator(operator);
    if (Buffer.byteLength(canonicalWfdJson(input), 'utf8') > PROCESSING_LIMITS.maxInputBytes) fail('PROCESSING_INPUT_BUDGET', '计划输入超过 HTTP 请求预算。');
    const raw = readRecord(input, ['routing', 'outputs', 'previousPlanId'], 'PROCESSING_PLAN_INPUT');
    const routing = readRecord(raw.routing, ['materials'], 'PROCESSING_ROUTING_INPUT');
    const materialInputs = readArray(routing.materials, 1, PROCESSING_LIMITS.maxMaterials, 'PROCESSING_MATERIALS');
    // 适配表源的原句证据须在按声明字符集解码后的同一文本上定位；先按引用取出冻结配置，未采用则留待规范化时明确失败。
    const adapterTexts = this.preScanAdapterTexts(raw.outputs);
    const facts = new Map<string, MaterialFacts>(), materials: NormalizedMaterialRouting[] = [];
    const seenMaterials = new Set<string>();
    for (const item of materialInputs) {
      const record = readRecord(item, ['materialId', 'dimensions', 'suggestions', 'intendedAction'], 'PROCESSING_MATERIAL_ROUTING');
      const materialId = readId(record.materialId, 'PROCESSING_MATERIAL_ID');
      if (seenMaterials.has(materialId)) fail('PROCESSING_MATERIALS', '同一材料不能在路由输入中重复。');
      seenMaterials.add(materialId);
      const material = this.materialFacts(materialId); facts.set(materialId, material);
      const dimensions = this.normalizeDimensions(readDimensions(record.dimensions), [material], operator, readSuggestions(record.suggestions), adapterTexts);
      const intendedAction = readIntendedAction(record.intendedAction);
      const decision = deriveMaterialRouting({ material, dimensions, rejected: false, outputId: null, intendedAction });
      materials.push({ materialId, facts: material, dimensions, suggestions: dimensions.flatMap(item => item.suggestions),
        routingState: decision.routingState, gaps: decision.gaps, intendedAction });
    }
    const outputInputs = readArray(raw.outputs, 1, PROCESSING_LIMITS.maxOutputs, 'PROCESSING_OUTPUTS');
    const outputs: NormalizedOutput[] = [], seenOutputs = new Set<string>(), allSteps: StepSpec[] = [];
    for (const item of outputInputs) {
      const record = readRecord(item, ['outputId', 'materialIds', 'tables', 'target', 'dimensions', 'suggestions', 'rejectReason', 'coverage', 'intendedAction', 'usage'], 'PROCESSING_OUTPUT');
      const outputId = readId(record.outputId, 'PROCESSING_OUTPUT_ID');
      if (seenOutputs.has(outputId)) fail('PROCESSING_OUTPUTS', '输出编号不能重复。'); seenOutputs.add(outputId);
      const materialIds = readArray(record.materialIds, 1, CANDIDATE_LIMITS.maxOriginals, 'PROCESSING_OUTPUT_MATERIALS').map(value => readId(value, 'PROCESSING_MATERIAL_ID'));
      if (new Set(materialIds).size !== materialIds.length) fail('PROCESSING_OUTPUTS', '一个输出不能重复引用同一原件。');
      const outputFacts = materialIds.map(materialId => facts.get(materialId) ?? fail('PROCESSING_MATERIAL_NOT_FOUND', `输出引用了未路由的材料 ${materialId}。`));
      const tables = readTables(record.tables, materialIds);
      for (const table of tables) {
        if (!table.sourceAdapter) continue;
        if (!this.options.adapters) fail('PROCESSING_ADAPTER_UNAVAILABLE', '本实例未装配端点适配登记，不能使用声明式适配表源。');
        const frozen: FrozenAdapterBinding = this.options.adapters.resolve(table.sourceAdapter,
          { materialId: table.materialId, ...(table.sourceContext === undefined ? {} : { context: table.sourceContext }),
            ...(table.sourceReceiptTaskId === undefined ? {} : { sourceReceiptTaskId: table.sourceReceiptTaskId }) });
        table.sourceAdapter = frozen;
        delete table.sourceContext; delete table.sourceReceiptTaskId;
        // 适配字段类型是配置声明的一部分；冻结进计划，结构步骤据此转换，不在执行时重新解释。
        const declared: NonNullable<CandidateTablePlan['types']> = Object.assign(Object.create(null),
          Object.fromEntries(frozen.config.fields.map(field => [table.fieldMapping?.[field.name] ?? field.name, adapterColumnType(field)])));
        for (const [name, type] of Object.entries(table.types ?? {})) {
          if (declared[name] && !adapterTypeCompatible(type, declared[name]!)) fail('PROCESSING_ADAPTER_TYPES', '结构类型声明与已采用适配的字段类型冲突。');
          declared[name] = type;
        }
        table.types = declared;
      }
      for (const table of tables) if (table.financialCalculation) {
        if (!this.options.financialReader || !this.options.financialReaderIdentity) fail('FINANCIAL_FIXED', '财务固定变换没有装配受信固定读取器及连接身份。');
        const binding = this.options.financialReaderIdentity();
        if (!binding) fail('FINANCIAL_FIXED', '财务固定读取连接尚未选定。');
        table.financialReaderBinding = wfdSha256(canonicalWfdJson(binding));
        const review = table.financialCalculation.compatibilityReview;
        if (review && !materialIds.includes(review.materialId)) fail('FINANCIAL_FIXED', '跨修订相容性原文必须是本输出明确选择并路由的受管材料。');
      }
      const target = readTarget(record.target);
      if (target && /"text_role":"necessary_condition"/u.test(canonicalWfdJson(target)) && !tables.every(table => table.necessaryTextSelection))
        fail('NECESSARY_TEXT_REVIEW', '目标声明的必要文字必须来自已核定的完整原文选择；产品标签不能代替选择证明。');
      const intendedAction = readIntendedAction(record.intendedAction);
      const usage = this.normalizeStructuredUsage(record.usage, intendedAction, operator, outputId);
      const rejectReason = record.rejectReason === undefined ? null : readText(record.rejectReason, 1, 2000, 'PROCESSING_REJECT_REASON');
      const coverage = record.coverage === undefined ? null : readCoverage(record.coverage);
      const base = materials.find(material => material.materialId === materialIds[0]!)!;
      const overrides = record.dimensions === undefined ? [] : this.normalizeDimensions(readDimensions(record.dimensions), outputFacts, operator, readSuggestions(record.suggestions), adapterTexts);
      const dimensions = overrides.length ? mergeDimensions(base.dimensions, overrides) : structuredClone(base.dimensions);
      const adapterGaps = [...tables.flatMap((table, index) => this.tableCapabilityGaps(facts.get(table.materialId)!, table, index)),
        // 未与材料实际取得回执核对时，结构解析可继续，但依赖匹配的算法与发布用途不自动成立。
        // 完全没有取得上下文时匹配未核，依赖匹配的用途不成立；已标注的合成上下文只记录缺口，不冒称真实回执。
        ...tables.flatMap(table => table.sourceAdapter && 'match' in table.sourceAdapter && table.sourceAdapter.match
          && table.sourceAdapter.match.kind === 'unverified' ? table.sourceAdapter.match.gaps : [])];
      const semanticGaps = dimensions.filter(dimension => dimension.status !== 'known').map(dimension => `${dimension.key}: ${dimension.gap ?? '未知'}`);
      const steps = rejectReason ? [] : this.buildSteps(outputId, materialIds, tables, dimensions, semanticGaps, intendedAction, outputFacts, target);
      const usageQualification = this.usageQualification(usage, base.facts.sha256);
      const outputRouting = deriveOutputRouting({ material: this.outputMaterialFacts(base.facts, tables), dimensions, target: target ? { present: true, kind: target.productRef ? 'productRef' : target.declaration ? 'declaration' : 'none', expectedSnapshotId: target.expectedSnapshotId ?? null } : undefined,
        rejected: !!rejectReason, outputId, outputState: steps.length ? 'pending' : 'custody_only', intendedAction, usage: usageQualification,
        processingGaps: steps.flatMap(step => step.gaps), adapterGaps });
      outputs.push({ outputId, materialIds, tables, target, intendedAction, usage, dimensions, suggestions: dimensions.flatMap(item => item.suggestions),
        rejectReason, coverage, adapterGaps, routingState: outputRouting.routingState, gaps: outputRouting.gaps, steps });
      allSteps.push(...steps);
    }
    if (allSteps.length > PROCESSING_LIMITS.maxSteps) fail('PROCESSING_STEP_BUDGET', '处理步骤超过本计划预算。');
    const scopeKey = wfdSha256(canonicalWfdJson({ policy: PROCESSING_POLICY.version,
      materials: materials.map(item => ({ materialId: item.materialId, sha256: item.facts.sha256 })).sort((a, b) => a.materialId.localeCompare(b.materialId)),
      outputs: outputs.map(item => item.outputId).sort() }));
    const executionDigest = wfdSha256(canonicalWfdJson({ policy: PROCESSING_POLICY.version,
      materials: materials.map(item => ({ materialId: item.materialId, sha256: item.facts.sha256 })).sort((a, b) => a.materialId.localeCompare(b.materialId)),
      outputs: outputs.map(item => ({ outputId: item.outputId, materialIds: item.materialIds, tables: item.tables, target: item.target,
        intendedAction: item.intendedAction, usage: item.usage,
        dimensions: item.dimensions.map(dimension => ({ key: dimension.key, status: dimension.status, value: dimension.value })) })),
      steps: allSteps.map(step => ({ stepId: step.stepId, specDigest: step.specDigest })) }));
    const previousPlanId = raw.previousPlanId === undefined ? null : readId(raw.previousPlanId, 'PROCESSING_PLAN_ID');
    const contentDigest = digestOperationArgs(withoutVolatile({ previousPlanId, operatorId: operator.operatorId,
      policy: PROCESSING_POLICY.version,
      materials: materials.map(material => ({ materialId: material.materialId, sha256: material.facts.sha256,
        dimensions: material.dimensions, suggestions: material.suggestions, intendedAction: material.intendedAction })),
      outputs: outputs.map(output => ({ outputId: output.outputId, materialIds: output.materialIds, tables: output.tables,
        target: output.target, usage: output.usage, dimensions: output.dimensions, suggestions: output.suggestions,
        rejectReason: output.rejectReason, coverage: output.coverage })) }));
    if (Buffer.byteLength(canonicalWfdJson({ materials, outputs, steps: allSteps }), 'utf8') > 2 * 1024 * 1024) fail('PROCESSING_INPUT_BUDGET', '计划输入超过持久化预算。');
    return { requestId: operator.requestId, previousPlanId, operator: storedOperator(operator), materials, outputs, steps: allSteps, scopeKey,
      executionDigest, contentDigest, reuseFromPlanId: previousPlanId ?? null };
  }

  /**
   * 结构化用途：purpose/history 由受信请求字段或结构化 intendedAction 决定，
   * 不从六维自由文本原话反推；历史必须显式模式/截止。
   */
  private normalizeStructuredUsage(raw: unknown, intendedAction: 'inspect' | 'publish', operator: OperatorContext, outputId: string): StructuredUsage {
    const value = raw === undefined ? {} : readRecord(raw, ['purpose', 'historyMode', 'cutoff', 'perspective', 'messageId', 'quote', 'restriction'], 'PROCESSING_USAGE');
    const purpose = (value.purpose === undefined
      ? (intendedAction === 'publish' ? 'current_publish' : 'current_compute')
      : readText(value.purpose, 1, 80, 'PROCESSING_USAGE')) as EligibilityPurpose;
    if (!(ELIGIBILITY_PURPOSES as readonly unknown[]).includes(purpose)) fail('PROCESSING_USAGE', '用途须为已登记的共用用途。');
    const historyMode = value.historyMode === undefined || value.historyMode === null ? null
      : readText(value.historyMode, 1, 64, 'PROCESSING_USAGE') as EligibilityHistoryMode;
    if (historyMode !== null && !(ELIGIBILITY_HISTORY_MODES as readonly unknown[]).includes(historyMode)) fail('PROCESSING_USAGE', '历史模式须使用现有 history_mode 稳定名称。');
    const cutoff = value.cutoff === undefined || value.cutoff === null ? null : readText(value.cutoff, 1, 64, 'PROCESSING_USAGE');
    if (cutoff !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(cutoff)
      || !Number.isFinite(Date.parse(cutoff)))) fail('PROCESSING_USAGE', '历史截止须为含明确时区的有效时刻。');
    const perspective = value.perspective === undefined || value.perspective === null ? null : readText(value.perspective, 1, 64, 'PROCESSING_USAGE');
    const historical = purpose.startsWith('historical');
    if (intendedAction === 'publish' && purpose !== 'current_publish' && purpose !== 'historical_publish') {
      fail('PROCESSING_USAGE', '发布动作的用途须为 current_publish 或 historical_publish；不能用当前内容用途冒充发布。');
    }
    if (intendedAction === 'inspect' && (purpose === 'current_publish' || purpose === 'historical_publish')) {
      fail('PROCESSING_USAGE', '检查动作不能声明发布用途；发布须由明确 publish 动作。');
    }
    if (historical) {
      if (historyMode === null || cutoff === null) fail('PROCESSING_USAGE', '历史用途须显式选择历史模式并固定截止。');
      if (historyMode === 'snapshot_contents') fail('PROCESSING_USAGE', '快照内容不是历史可知资格；历史用途须使用实际历史模式与公开/持有证据。');
      if (perspective !== null && perspective !== historyMode) fail('PROCESSING_USAGE', 'perspective 必须与历史模式一致。');
    } else if (historyMode !== null || cutoff !== null || perspective !== null) {
      fail('PROCESSING_USAGE', '当前用途不能携带历史模式/截止/视角；不静默升级资格。');
    }
    const authority: 'operator-http' | 'user-message' = operator.source === 'conversation' ? 'user-message' : 'operator-http';
    let messageId: string | undefined;
    let quote = `structured action: intendedAction=${intendedAction}; purpose=${purpose}`;
    if (authority === 'user-message') {
      messageId = value.messageId === undefined ? undefined : readText(value.messageId, 1, 160, 'PROCESSING_USAGE');
      const userQuote = value.quote === undefined ? null : readText(value.quote, 1, 4000, 'PROCESSING_USAGE');
      if (!messageId || !userQuote || !operator.conversation?.verifyUserMessage?.(messageId, userQuote)) {
        fail('PROCESSING_USAGE_EVIDENCE', '会话发布/历史用途须引用真实用户原话；模型不能自授。');
      }
      quote = userQuote;
    }
    const claim: PurposeEvidenceClaim = { purpose, authority, quote,
      observedAtUtc: new Date(operator.observedAt).toISOString().replace('.000Z', 'Z'),
      evidenceSha256: wfdSha256(canonicalWfdJson({ outputId, intendedAction, purpose, historyMode, cutoff, perspective, requestId: operator.requestId })),
      ...(authority === 'operator-http' ? { requestId: operator.requestId } : { messageId: messageId! }) };
    const restriction = value.restriction === undefined ? undefined
      : isWfdRecord(value.restriction) ? value.restriction as unknown as StructuredUsage['restriction'] : undefined;
    return { purpose, historyMode, cutoff, perspective, purposeEvidence: [claim],
      ...(restriction ? { restriction } : {}) };
  }

  private usageQualification(usage: StructuredUsage, objectSha256: string): UsageQualification {
    const result = evaluatePurposeEligibility({
      ruleVersion: PURPOSE_ELIGIBILITY_RULE_VERSION,
      purpose: usage.purpose, purposeEvidence: usage.purposeEvidence,
      history: { mode: usage.historyMode, cutoff: usage.cutoff, perspective: usage.perspective },
      object: { objectSha256, origin: 'managed_original', productId: null, snapshotId: null, recordVersion: objectSha256,
        definitionRevision: null, contentVerified: true,
        contentBasis: '处理计划形成时按实际受管材料/结构化对象摘要核对' },
      publicationTime: null, holdingTime: null, revisions: null, wfdHistory: null,
      restriction: usage.restriction ?? null, derived: null, wfdDecision: null, boundary: 'candidate',
    });
    return { status: result.status, checkedScope: result.checkedScope, evidenceSha256: result.evidenceSha256,
      historyUse: result.historyUse,
      gaps: result.gaps.filter(item => item.blocking).map(item => `用途资格: ${item.code}: ${item.message}`) };
  }

  private normalizeDimensions(raw: Partial<Record<DimensionKey, ProcessingDimensionInput>> | null, facts: MaterialFacts[],
    operator: OperatorContext, suggestions: ProcessingSuggestionInput[], adapterTexts?: Map<string, string>): NormalizedDimension[] {
    const result: NormalizedDimension[] = [];
    const textCache = new Map<string, string | null>(adapterTexts ?? []);
    const tableCache = new Map<string, ParsedCandidateTable>();
    for (const key of DIMENSION_KEYS) {
      const input = raw?.[key];
      if (input === undefined) {
        const empty = emptyDimensions().find(item => item.key === key)!;
        const derived = suggestions.filter(item => item.dimension === key).map(item => this.suggestion(item));
        result.push({ ...empty, gap: derived.length ? `${empty.gap} 模型建议仅保存为未采用建议，需操作者或真实用户证据确认。` : empty.gap, suggestions: derived });
        continue;
      }
      const record = readRecord(input, ['status', 'value', 'gap', 'evidence'], 'PROCESSING_DIMENSION');
      const status = record.status;
      if (status !== 'known' && status !== 'unknown' && status !== 'conflict') fail('PROCESSING_DIMENSION', `${key} 状态须为 known、unknown 或 conflict。`);
      const value = record.value === undefined ? null : readText(record.value, 1, 2000, `PROCESSING_DIMENSION_${key}`);
      if (status === 'known' && !value) fail('PROCESSING_DIMENSION', `${dimensionLabel(key)} 为 known 时必须提供明确值。`);
      if (status !== 'known' && value !== null) fail('PROCESSING_DIMENSION', `${dimensionLabel(key)} 的 unknown/conflict 不能携带已确定值。`);
      const evidence = this.normalizeEvidence(record.evidence, facts, operator, textCache, tableCache);
      if (status === 'known' && !evidence.length) fail('PROCESSING_DIMENSION', `${dimensionLabel(key)} 为 known 时必须保留来源证据。`);
      if (key === 'purpose' && status === 'known' && !evidence.some(item => item.source === 'operator-http' || item.source === 'user-message')) {
        fail('PROCESSING_PURPOSE_AUTHORITY', '使用目的必须由真实操作者请求字段或真实用户消息确认；材料文字和模型建议不能自授用途。');
      }
      const derivedSuggestions = suggestions.filter(item => item.dimension === key).map(item => this.suggestion(item));
      const baseGap = status === 'known' ? null : (record.gap === undefined ? `${dimensionLabel(key)} 明确未知，未按不适用跳过。`
        : readText(record.gap, 1, 1000, 'PROCESSING_DIMENSION_GAP'));
      const gap = baseGap && derivedSuggestions.length ? `${baseGap} 模型建议仅保存为未采用建议，需操作者或真实用户证据确认。` : baseGap;
      result.push({ key, status, value, gap, evidence, suggestions: derivedSuggestions });
    }
    return result;
  }

  private normalizeEvidence(raw: unknown, facts: MaterialFacts[], operator: OperatorContext, textCache: Map<string, string | null>,
    tableCache: Map<string, ParsedCandidateTable>): NormalizedEvidence[] {
    if (raw === undefined) return [];
    const list = readArray(raw, 1, PROCESSING_LIMITS.maxEvidence, 'PROCESSING_EVIDENCE');
    return list.map(item => {
      const record = readRecord(item, ['source', 'materialId', 'quote', 'start', 'end', 'field', 'messageId', 'proposalId', 'judgmentId',
        'column', 'scope', 'xlsxSelection'], 'PROCESSING_EVIDENCE');
      if (record.source === 'material-table') {
        const materialId = readId(record.materialId, 'PROCESSING_MATERIAL_ID'), fact = facts.find(item => item.materialId === materialId);
        if (!fact || fact.format !== 'excel') fail('PROCESSING_EVIDENCE', '表格证据必须引用本计划中的 XLSX 原件与明确选区。');
        const selection = readXlsxTableSelection(record.xlsxSelection), column = readText(record.column, 1, 256, 'PROCESSING_EVIDENCE_COLUMN');
        const quote = readText(record.quote, 1, 4000, 'PROCESSING_EVIDENCE_QUOTE');
        if (!['header', 'column_constant'].includes(String(record.scope))) fail('PROCESSING_EVIDENCE', '工作簿证据须明确为原表头或全选区一致的列声明。');
        const cacheKey = `${materialId}:${wfdSha256(canonicalWfdJson(selection))}`;
        if (!tableCache.has(cacheKey)) tableCache.set(cacheKey, parseTableSource(this.options.materials.readOriginal(materialId).bytes,
          { materialId, format: 'xlsx', xlsxSelection: selection }));
        const table = tableCache.get(cacheKey)!, index = table.columns.indexOf(column), projection = table.source_projection;
        if (index < 0 || !projection || projection.evidence.sourceSha256 !== fact.sha256) fail('PROCESSING_EVIDENCE_MISMATCH', '所选工作簿原件、列或投影摘要不符。');
        const selected = projection.evidence.columns[index]!;
        if (record.scope === 'header' ? selected.header !== quote
          : !table.total_rows || table.rows.some(row => row[index]?.original !== quote)) fail('PROCESSING_EVIDENCE_MISMATCH', '工作簿原表头或逐行一致声明与证据不符。');
        return { source: 'material', materialId, materialSha256: fact.sha256, quote,
          table: { selectionSha256: wfdSha256(canonicalWfdJson(selection)), projectionSha256: projection.json_sha256,
            sheetName: projection.evidence.sheetName, sheetPart: projection.evidence.sheetPart, column,
            scope: record.scope as 'header' | 'column_constant', headerCell: selected.cell.address,
            firstDataRow: projection.evidence.firstDataRow, lastDataRow: projection.evidence.lastDataRow,
            selectedRows: projection.evidence.selectedRows } };
      }
      if (['column', 'scope', 'xlsxSelection'].some(key => record[key] !== undefined)) fail('PROCESSING_EVIDENCE', '选区字段只适用于明确的工作簿材料证据。');
      if (record.source === 'model-proposal') fail('PROCESSING_EVIDENCE_UNTRUSTED', '模型建议只能作为未采用建议，不能作为 known 维度证据。');
      if (record.source === 'user-message') {
        if (operator.source !== 'conversation' || !operator.conversation) fail('PROCESSING_EVIDENCE_UNTRUSTED', 'user-message 证据只能由受信会话宿主核对；HTTP 操作者不能注入。');
        const messageId = readId(record.messageId, 'PROCESSING_MESSAGE_ID');
        const quote = readText(record.quote, 1, 4000, 'PROCESSING_EVIDENCE_QUOTE');
        if (!operator.conversation.verifyUserMessage?.(messageId, quote)) fail('PROCESSING_EVIDENCE_UNTRUSTED', '用户消息证据不在当前分支真实用户原话中。');
        return { source: 'user-message', messageId, quote };
      }
      if (record.source === 'operator' && operator.source === 'conversation') {
        fail('PROCESSING_EVIDENCE_UNTRUSTED', '会话模型不能自报操作者证据；用户目的须引用本分支真实用户消息。');
      }
      if (record.source !== 'material' && record.source !== 'operator') fail('PROCESSING_EVIDENCE', '证据来源须为 material、operator 或受信 user-message。');
      if (record.source === 'material') {
        const materialId = readId(record.materialId, 'PROCESSING_MATERIAL_ID'), fact = facts.find(item => item.materialId === materialId);
        if (!fact) fail('PROCESSING_EVIDENCE', '材料证据必须引用本计划中的原件。');
        const quote = readText(record.quote, 1, 10_000, 'PROCESSING_EVIDENCE_QUOTE');
        if (!textCache.has(materialId)) textCache.set(materialId, decodeText(this.options.materials.readOriginal(materialId).bytes));
        const text = textCache.get(materialId);
        if (text === null || text === undefined) fail('PROCESSING_EVIDENCE_UNAVAILABLE', '材料不是可核 UTF-8 文本；不能伪造原句证据。');
        let start: number, end: number;
        if (record.start !== undefined || record.end !== undefined) {
          start = readInteger(record.start, 0, text.length, 'PROCESSING_EVIDENCE_START');
          end = readInteger(record.end, 1, text.length, 'PROCESSING_EVIDENCE_END');
          if (end <= start || text.slice(start, end) !== quote) fail('PROCESSING_EVIDENCE_MISMATCH', '证据精确偏移与原句不符。');
        } else {
          start = text.indexOf(quote);
          if (start < 0) fail('PROCESSING_EVIDENCE_MISMATCH', '证据原句不在材料原文中。');
          if (text.indexOf(quote, start + 1) >= 0) fail('PROCESSING_EVIDENCE_AMBIGUOUS', '证据原句重复；须提供精确起止偏移。');
          end = start + quote.length;
        }
        const location = locate(text, start, end);
        return { source: 'material', materialId, materialSha256: fact.sha256, quote, ...location };
      }
      const field = readText(record.field, 1, 200, 'PROCESSING_EVIDENCE_FIELD');
      const quote = readText(record.quote, 1, 4000, 'PROCESSING_EVIDENCE_QUOTE');
      return { source: 'operator-http', quote, field, requestId: operator.requestId, method: operator.method,
        path: operator.path, remoteAddress: operator.remoteAddress, observedAt: operator.observedAt };
    });
  }

  private suggestion(input: ProcessingSuggestionInput): DimensionSuggestion {
    const record = readRecord(input, ['dimension', 'value', 'proposalId', 'judgmentId'], 'PROCESSING_SUGGESTION');
    if (!DIMENSION_KEYS.includes(record.dimension as DimensionKey)) fail('PROCESSING_SUGGESTION', '模型建议的维度无效。');
    return { source: 'model-proposal', value: readText(record.value, 1, 2000, 'PROCESSING_SUGGESTION'),
      proposalId: record.proposalId === undefined ? null : readId(record.proposalId, 'PROCESSING_PROPOSAL_ID'),
      judgmentId: record.judgmentId === undefined ? null : readId(record.judgmentId, 'PROCESSING_JUDGMENT_ID'), adopted: false };
  }

  private materialFacts(materialId: string): MaterialFacts {
    const material = this.options.materials.get(materialId), original = this.options.materials.readOriginal(materialId);
    if (original.sha256 !== material.envelope.sha256) fail('PROCESSING_MATERIAL_CHANGED', '材料原件摘要与信封不一致。');
    // 预览预算（2 MiB/1000 行）只服务只读预览；解析能力按实际选定解析器与完整原件 64 MiB 预算独立核定。
    const detected: string = material.preview.format;
    const withinFullBudget = material.envelope.byteLength <= CANDIDATE_LIMITS.maxStructuredBytes;
    let jsonArrayRoot = false;
    if (detected === 'json-table' && withinFullBudget) {
      const bytes = original.bytes;
      let offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
      while (bytes[offset] === 0x20 || bytes[offset] === 0x09 || bytes[offset] === 0x0a || bytes[offset] === 0x0d) offset++;
      jsonArrayRoot = bytes[offset] === 0x5b;
    }
    const nonTableJson = detected === 'json-table' && withinFullBudget && !jsonArrayRoot;
    // 现有 JSON 表格解析器只接受根行对象数组；转换信封等根对象不能凭 .json 后缀获得五步资格。
    const parseFormat = detected === 'csv' || detected === 'json-table' && jsonArrayRoot ? detected : null;
    const support = nonTableJson ? 'needs_adapter' : withinFullBudget && parseFormat ? 'supported' : withinFullBudget ? material.preview.support : 'needs_adapter';
    return { materialId, filename: material.envelope.filename, sha256: material.envelope.sha256,
      byteLength: material.envelope.byteLength, mediaType: material.envelope.mediaType,
      format: nonTableJson ? 'json-document' : parseFormat ?? material.preview.format, support,
      adapter: nonTableJson ? null : material.preview.adapter ?? (parseFormat ? { id: parseFormat === 'csv' ? 'utf8-csv' : 'utf8-json-table', version: '1' } : null),
      custodyState: 'received' };
  }

  /**
   * 适配表源的原句证据只能在其声明字符集解码后的文本上定位。
   * 这里只按已采用版本解码本计划实际引用的材料；未采用或摘要不符留给规范化阶段明确失败，不猜测编码。
   */
  private preScanAdapterTexts(outputs: unknown): Map<string, string> {
    const texts = new Map<string, string>();
    if (!this.options.adapters || !Array.isArray(outputs)) return texts;
    for (const output of outputs) {
      if (!isWfdRecord(output) || !Array.isArray(output.tables)) continue;
      for (const table of output.tables) {
        if (!isWfdRecord(table) || table.sourceAdapter === undefined || typeof table.materialId !== 'string' || texts.has(table.materialId)) continue;
        try {
          const frozen = this.options.adapters.resolve(readAdapterBindingRef(table.sourceAdapter));
          texts.set(table.materialId, decodeAdapterSource(this.options.materials.readOriginal(table.materialId).bytes, frozen.config.carrier.charset).text);
        } catch { /* 该表会在 readTables/规范化时以明确错误失败；不在预扫描阶段改写结论。 */ }
      }
    }
    return texts;
  }

  /** 完整表保留64 MiB默认；显式选件仅放行其原件保管预算，不拿预览截断提交。 */
  private tableCapabilityGaps(fact: MaterialFacts, table: CandidateTablePlan, index: number): string[] {
    // 已冻结端点适配以实际载体解析能力准入；预览格式、扩展名不是拒绝依据，预算与身份仍逐项核对。
    if (table.sourceAdapter) {
      const gaps: string[] = [];
      if (fact.byteLength > CANDIDATE_LIMITS.maxStructuredBytes) gaps.push(`tables[${index}] ${table.materialId}: 完整原件 ${fact.byteLength} 字节超过本次 ${CANDIDATE_LIMITS.maxStructuredBytes} 字节解析预算；未用截断预览提交。`);
      if (!['csv', 'json'].includes(table.format)) gaps.push(`tables[${index}] ${table.materialId}: 端点适配表源须声明载体族 csv|json，当前 ${table.format}。`);
      if (table.sourceAdapter.configDigest.length !== 64) gaps.push(`tables[${index}] ${table.materialId}: 适配配置摘要无效。`);
      return gaps;
    }
    const expected = table.format === 'financial-fixed' ? fact.format : table.format === 'csv' ? 'csv' : table.format === 'xlsx' ? 'excel' : table.format === 'pdf' ? 'pdf'
      : table.format === 'xbrl' || table.format === 'text' ? 'text' : 'json-table';
    const gaps: string[] = [];
    const byteBudget = table.format === 'xlsx' ? MAX_SOURCE : table.selection ? CANDIDATE_LIMITS.maxObjectBytes : CANDIDATE_LIMITS.maxStructuredBytes;
    if (fact.byteLength > byteBudget) {
      gaps.push(`tables[${index}] ${table.materialId}: 完整原件 ${fact.byteLength} 字节超过本次 ${byteBudget} 字节解析预算；未用截断预览提交。`);
    }
    if ((table.format === 'xbrl' ? !/\.(?:xbrl|xml|xhtml)$/iu.test(fact.filename) : fact.format !== expected)
      || table.format === 'xlsx' && (!table.xlsxSelection || !/\.xlsx$/iu.test(fact.filename))) {
      gaps.push(`tables[${index}] ${table.materialId}: 材料实际格式=${fact.format}，声明格式=${table.format}；缺对应解析器，预览只作线索。`);
    }
    return gaps;
  }

  private outputMaterialFacts(fact: MaterialFacts, tables: CandidateTablePlan[]): MaterialFacts {
    const selected = tables.find(table => table.materialId === fact.materialId && (table.selection || table.xlsxSelection || table.xbrlSelection || table.necessaryTextSelection || table.pdfSelection || table.financialCalculation || table.sourceAdapter)
      && this.tableCapabilityGaps(fact, table, 0).length === 0);
    return selected ? { ...fact, support: 'supported', ...(selected.format === 'xlsx'
      ? { adapter: { id: 'xlsx-explicit-selection', version: '1' } }
      : selected.sourceAdapter ? { adapter: { id: selected.sourceAdapter.adapterId, version: selected.sourceAdapter.version } } : {}) } : fact;
  }

  private buildSteps(outputId: string, materialIds: string[], tables: CandidateTablePlan[], dimensions: NormalizedDimension[],
    semanticGaps: string[], intendedAction: 'inspect' | 'publish', facts: MaterialFacts[], target: ProcessingTargetInput | null): StepSpec[] {
    const steps: StepSpec[] = [], lastBySource: string[] = [];
    tables.forEach((table, index) => {
      const factsById = new Map(facts.map(fact => [fact.materialId, fact]));
      const fact = factsById.get(table.materialId)!;
      const parseGaps = this.tableCapabilityGaps(fact, table, index);
      const parseId = `parse:${outputId}:${index}`;
      const dedicatedAdapter = ({ xlsx: 'xlsx-explicit-selection', xbrl: 'bd-xbrl-numeric', text: 'bd-necessary-business-paragraph',
        pdf: 'bd-financial-pdf-regions', 'financial-fixed': 'bd-financial-fixed' } as Partial<Record<CandidateTablePlan['format'], string>>)[table.format]
        ?? (table.sourceAdapter ? `endpoint:${table.sourceAdapter.adapterId}` : table.selection ? 'utf8-csv-exact-selection' : undefined);
      const adapterVersion = table.sourceAdapter ? `${table.sourceAdapter.version}:${table.sourceAdapter.configDigest.slice(0, 12)}`
        : dedicatedAdapter ? '1' : fact.adapter?.version ?? '0';
      const parse: StepSpec = { stepId: parseId, outputId, kind: 'parse', required: true,
        applicability: parseGaps.length ? 'unknown' : 'applicable', dependsOn: [],
        implementation: `${CANDIDATE_STAGE_VERSIONS.parse}:${dedicatedAdapter ?? fact.adapter?.id ?? 'unavailable'}:${adapterVersion}`,
        parameters: { materialId: table.materialId, format: table.format, fieldMapping: table.fieldMapping ?? {},
          types: table.types ?? {}, trim: table.trim ?? [], emptyToNull: table.emptyToNull ?? [], annotations: table.annotations ?? {},
          ...(table.sourceAdapter ? { sourceAdapter: table.sourceAdapter } : {}),
          ...(table.selection ? { selection: table.selection } : {}), ...(table.xlsxSelection ? { xlsxSelection: table.xlsxSelection } : {}),
          ...(table.numericFormats ? { numericFormats: table.numericFormats } : {}),
          ...(table.xbrlSelection ? { xbrlSelection: table.xbrlSelection } : {}),
          ...(table.necessaryTextSelection ? { necessaryTextSelection: table.necessaryTextSelection } : {}),
          ...(table.pdfSelection ? { pdfSelection: table.pdfSelection } : {}),
          ...(table.financialCalculation ? { financialCalculation: table.financialCalculation, financialReaderBinding: table.financialReaderBinding } : {}),
          ...(table.sourceProjection ? { sourceProjection: table.sourceProjection } : {}) },
        completion: { kind: 'parsed_table', source_sha256: fact.sha256, row_count_gt: 0, unique_nonempty_fields: true, original_cells_preserved: true,
          ...(table.sourceAdapter ? { adapter_id: table.sourceAdapter.adapterId, adapter_version: table.sourceAdapter.version,
            adapter_config_digest: table.sourceAdapter.configDigest } : {}) },
        input: { kind: 'material', materialId: table.materialId, sha256: fact.sha256, media_type: fact.mediaType },
        gaps: [...parseGaps, ...(table.sourceAdapter && 'match' in table.sourceAdapter && table.sourceAdapter.match?.kind === 'synthetic'
          ? table.sourceAdapter.match.gaps : [])], specDigest: '' };
      parse.specDigest = stepDigest(parse);
      steps.push(parse);
      const cleanId = `clean:${outputId}:${index}`;
      const cleanApplicable = (table.trim?.length ?? 0) > 0 || (table.emptyToNull?.length ?? 0) > 0;
      const clean: StepSpec = { stepId: cleanId, outputId, kind: 'clean', required: cleanApplicable, applicability: cleanApplicable ? 'applicable' : 'not_applicable',
        dependsOn: [parseId], implementation: CANDIDATE_STAGE_VERSIONS.clean,
        parameters: { materialId: table.materialId, trim: table.trim ?? [], emptyToNull: table.emptyToNull ?? [] },
        completion: cleanApplicable ? { kind: 'cleaned_table', all_rows: true, changes_recorded: true, change_window: 1000 }
          : { kind: 'pass_through', reason: '未声明 trim 或 empty_to_null；规则不适用。' },
        input: { kind: 'step', stepId: parseId, specDigest: parse.specDigest }, gaps: [], specDigest: '' };
      clean.specDigest = stepDigest(clean, parse); steps.push(clean);
      const structureId = `structure:${outputId}:${index}`;
      const structure: StepSpec = { stepId: structureId, outputId, kind: 'structure', required: true, applicability: 'applicable',
        dependsOn: [cleanId], implementation: CANDIDATE_STAGE_VERSIONS.structure,
        parameters: { materialId: table.materialId, types: table.types ?? {}, fieldMapping: table.fieldMapping ?? {} },
        completion: { kind: 'structured_table', finite_scalars: true, precision_checked: true, original_cells_preserved: true },
        input: { kind: 'step', stepId: cleanId, specDigest: clean.specDigest }, gaps: [], specDigest: '' };
      structure.specDigest = stepDigest(structure, clean); steps.push(structure);
      const annotateId = `annotate:${outputId}:${index}`;
      const annotateApplicable = Object.keys(table.annotations ?? {}).length > 0;
      const annotate: StepSpec = { stepId: annotateId, outputId, kind: 'annotate', required: annotateApplicable,
        applicability: annotateApplicable ? 'applicable' : 'not_applicable', dependsOn: [structureId], implementation: CANDIDATE_STAGE_VERSIONS.annotate,
        parameters: { materialId: table.materialId, annotations: table.annotations ?? {} },
        completion: annotateApplicable ? { kind: 'annotated_table', constants_do_not_override: true }
          : { kind: 'pass_through', reason: '未声明常量标注；规则不适用。' },
        input: { kind: 'step', stepId: structureId, specDigest: structure.specDigest }, gaps: [], specDigest: '' };
      annotate.specDigest = stepDigest(annotate, structure); steps.push(annotate);
      lastBySource.push(annotateId);
    });
    if (tables.length) {
      const checkId = `check:${outputId}`;
      const deps = lastBySource.map(stepId => steps.find(step => step.stepId === stepId)!);
      const semantic = isR1TabularDeclaration(target?.declaration)
        ? { ...compileR1TabularDeclaration(target!.declaration), declaration: target!.declaration!,
          sourceDimensions: dimensions.filter(dimension => dimension.key === 'role' || dimension.key === 'informationNature')
            .map(({ key, status, value }) => ({ key, status, value })) } : null;
      const sourceGaps = semantic ? this.tabularSourceGaps(semantic.declaration, semantic.sourceDimensions) : [];
      const publishGap = intendedAction === 'publish' && semanticGaps.length ? ['发布资格未确认：必要语义仍未知，不能由结构检查通过替代。']
        : intendedAction === 'publish' ? ['发布用途仍须真实目标、必要语义与真实权限；候选交接由用户明确授权，本计划只做结构准备。'] : [];
      const check: StepSpec = { stepId: checkId, outputId, kind: 'check', required: true,
        applicability: 'applicable', dependsOn: lastBySource,
        implementation: CANDIDATE_STAGE_VERSIONS.check,
        parameters: { sourceCount: tables.length, rowBudget: PROCESSING_LIMITS.maxRows, outputByteBudget: PROCESSING_LIMITS.maxObjectBytes,
          checkScope: ['strict_utf8_decoding', 'table_shape', 'unique_nonempty_fields', 'explicit_field_mapping', 'explicit_scalar_types',
            'finite_scalars', 'decimal_precision_roundtrip', 'type_changes_recorded', 'row_budget', 'output_digest'],
          ...(semantic ? { semantic } : {}) },
        completion: { kind: 'structural_table', row_count_lte: PROCESSING_LIMITS.maxRows, output_sha256: true,
          check_scope: 'structural_only', business_rules_executed: false, semantic_check: false, source_authenticity_verified: false,
          ...(semantic ? { required_semantic: { ruleVersion: semantic.ruleVersion, ruleDigest: semantic.ruleDigest, quality: 'pass' } } : {}) },
        input: { kind: 'steps', steps: deps.map(step => ({ stepId: step.stepId, specDigest: step.specDigest })) },
        gaps: [...semanticGaps, ...publishGap, ...(semantic?.gaps ?? []), ...sourceGaps,
          '结构检查只证明编码、形状、类型、行预算与摘要；不证明来源真实性、业务语义、单位、时间身份或发布资格。'],
        specDigest: '' };
      check.specDigest = stepDigest(check, ...deps); steps.push(check);
    }
    return steps;
  }

  /* ── 持久化与状态推进。 ─────────────────────────────────────────────────────────── */

  private buildPlanDocument(planId: string, input: NormalizedPlanInput & { planId?: string; reuseFromPlanId?: string | null }, reuseFromPlanId: string | null) {
    const prior = reuseFromPlanId ? this.reusablePriorSteps(reuseFromPlanId) : new Map<string, StepRow>();
    const steps = input.steps.map(spec => this.initialStep(spec, reuseFromPlanId, prior.get(spec.specDigest)));
    // 复用必须沿实际阶段依赖闭合：任一前置未复用，后续不得借用旧产物。
    const byId = new Map(steps.map(step => [step.spec.stepId, step]));
    for (const step of steps) {
      if (step.state !== 'succeeded' || !step.reusedFrom) continue;
      const closed = step.spec.dependsOn.every(depId => {
        const dep = byId.get(depId);
        if (!dep || dep.state !== 'succeeded' || !dep.outputDigest) return false;
        const priorDep = prior.get(dep.spec.specDigest);
        return !!priorDep && priorDep.output_digest === dep.outputDigest;
      });
      if (!closed) {
        step.state = 'pending'; step.output = null; step.outputDigest = null; step.checkScope = []; step.reusedFrom = null;
        step.semantic = null;
        step.startedAt = null; step.completedAt = null;
        step.gaps = [...step.gaps, '前置阶段未复用或旧产物不可核；未借用旧步骤证明。'];
      }
    }
    const materialFacts = new Map(input.materials.map(material => [material.materialId, material]));
    const outputRows = input.outputs.map(output => this.initialOutput(output, steps, materialFacts.get(output.materialIds[0]!)!));
    const createdAt = Date.now();
    const document = { contract: 'bd.processing-plan/1', version: PROCESSING_PLAN_VERSION, implementation: this.versionBinding.implementation, planId,
      requestId: input.requestId, parentPlanId: input.previousPlanId, policy: PROCESSING_POLICY, policyDigest: PROCESSING_POLICY_DIGEST,
      operator: { operatorId: input.operator.operatorId }, createdAt, scopeKey: input.scopeKey, executionDigest: input.executionDigest,
      contentDigest: input.contentDigest, reuseFromPlanId,
      materials: input.materials.map(material => ({ ...material.facts, dimensions: material.dimensions,
        suggestions: material.suggestions, routingState: material.routingState, gaps: material.gaps, intendedAction: material.intendedAction })),
      outputs: input.outputs.map(output => ({ outputId: output.outputId, materialIds: output.materialIds, tables: output.tables,
        target: output.target, intendedAction: output.intendedAction, usage: output.usage, dimensions: output.dimensions, suggestions: output.suggestions, rejectReason: output.rejectReason,
        coverage: output.coverage, adapterGaps: output.adapterGaps, routingState: output.routingState, gaps: output.gaps,
        steps: output.steps.map(step => step.stepId) })),
      steps: input.steps.map(spec => ({ ...spec, reuseFrom: steps.find(step => step.spec.stepId === spec.stepId)?.reusedFrom ?? null })) };
    const planJson = canonicalWfdJson(document);
    return { document, planJson, planDigest: wfdSha256(planJson), steps, outputs: outputRows, createdAt };
  }

  private initialStep(spec: StepSpec, reuseFromPlanId: string | null, prior: StepRow | undefined): InitializedStep {
    if (prior && prior.state === 'succeeded' && prior.output_json && this.priorStepMatches(prior, spec)) {
      try {
        const ref = this.ref(prior.output_json);
        if (this.options.objects.verify(ref) && wfdSha256(this.options.objects.get(ref)) === prior.output_digest
          && ref.sha256 === prior.output_digest) {
          return { spec, state: 'succeeded' as ProcessingStepState, output: ref,
            outputDigest: prior.output_digest, checkScope: parseJson(prior.check_scope_json) as string[], gaps: parseJson(prior.gaps_json) as string[],
            reusedFrom: { planId: prior.plan_id, stepId: prior.step_id }, startedAt: prior.started_at, completedAt: prior.completed_at, error: null,
            semantic: prior.semantic_json ? parseJson<ProcessingSemanticEvidence>(prior.semantic_json) : null,
            normalization: prior.normalization_json ? parseJson<WfdRecord>(prior.normalization_json) : null };
        }
      } catch { /* 旧对象缺失/损坏：退回执行，不复制旧通过。 */ }
    }
    const blocked = spec.applicability === 'unknown';
    return { spec, state: blocked ? 'blocked' as ProcessingStepState : 'pending' as ProcessingStepState, output: null, outputDigest: null,
      checkScope: [], gaps: [...spec.gaps, ...(blocked ? [] : (prior ? ['旧步骤对象损坏、实现变化或身份不符；未复用旧通过。'] : []))],
      reusedFrom: null, startedAt: null, completedAt: null, error: null, semantic: null, normalization: null };
  }

  private initialOutput(output: NormalizedOutput, steps: ReturnType<ProcessingPlanService['initialStep']>[], materialFacts: NormalizedMaterialRouting) {
    const own = steps.filter(step => step.spec.outputId === output.outputId);
    const check = own.find(step => step.spec.kind === 'check');
    const structured = check?.state === 'succeeded' ? check.output : null;
    const state: OutputState = !own.length ? 'custody_only' : own.some(step => step.state === 'blocked') ? 'blocked'
      : structured ? 'structured' : 'pending';
    const processingGaps = own.flatMap(step => step.spec.kind === 'check' && step.state === 'succeeded' ? step.gaps
      : step.state === 'failed' ? [`${step.spec.stepId}: 失败`] : step.state === 'blocked' ? step.gaps : []);
    const semantic = this.outputSemantic(output.target, check?.semantic ?? null, output.dimensions);
    const usageDeclaration = output.usage ?? { purpose: output.intendedAction === 'publish' ? 'current_publish' as const : 'current_compute' as const,
      historyMode: null, cutoff: null, perspective: null, purposeEvidence: [] };
    const usage = this.usageQualification(usageDeclaration, structured?.sha256 ?? materialFacts.facts.sha256);
    const routing = deriveOutputRouting({ material: this.outputMaterialFacts(materialFacts.facts, output.tables),
      dimensions: output.dimensions, target: output.target ? { present: true, kind: output.target.productRef ? 'productRef' : output.target.declaration ? 'declaration' : 'none',
        expectedSnapshotId: output.target.expectedSnapshotId ?? null } : undefined, rejected: !!output.rejectReason, outputId: output.outputId,
      outputState: state, intendedAction: output.intendedAction, usage, processingGaps, adapterGaps: output.adapterGaps, semantic });
    return { outputId: output.outputId, state, structured, structuredDigest: structured?.sha256 ?? null,
      routingState: routing.routingState, gaps: routing.gaps, updatedAt: Date.now() };
  }

  private insertPlan(document: ReturnType<ProcessingPlanService['buildPlanDocument']>, input: NormalizedPlanInput) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO processing_plans VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(document.document.planId,
      requestKeyFor('plan', input.requestId), input.previousPlanId, document.planDigest, input.scopeKey, PROCESSING_POLICY.version,
      PROCESSING_POLICY_DIGEST, canonicalWfdJson(PROCESSING_POLICY), canonicalWfdJson(document.document.operator),
      canonicalWfdJson(document.document.materials.map(material => ({ materialId: material.materialId, sha256: material.sha256 }))),
      document.planJson, this.planStatus(document.outputs), document.createdAt, now);
    for (const [index, step] of document.steps.entries()) {
      this.db.prepare(`INSERT INTO processing_plan_steps (
        plan_id,step_id,ordinal,output_id,kind,required,applicability,depends_json,implementation,parameters_json,completion_json,
        spec_digest,state,input_json,output_json,output_digest,check_scope_json,gaps_json,error_json,reused_from_plan_id,
        reused_from_step_id,started_at,completed_at,attempt_task_id,semantic_json,normalization_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        document.document.planId, step.spec.stepId, index, step.spec.outputId, step.spec.kind, Number(step.spec.required),
        step.spec.applicability, canonicalWfdJson(step.spec.dependsOn), step.spec.implementation, canonicalWfdJson(step.spec.parameters),
        canonicalWfdJson(step.spec.completion), step.spec.specDigest, step.state, canonicalWfdJson(step.spec.input),
        step.output ? canonicalWfdJson(step.output) : null, step.outputDigest, canonicalWfdJson(step.checkScope), canonicalWfdJson(step.gaps),
        step.error ? canonicalWfdJson(step.error) : null, step.reusedFrom?.planId ?? null, step.reusedFrom?.stepId ?? null,
        step.startedAt, step.completedAt, null, step.semantic ? canonicalWfdJson(step.semantic) : null,
        step.normalization ? canonicalWfdJson(step.normalization) : null);
    }
    for (const output of document.outputs) {
      this.db.prepare('INSERT INTO processing_plan_outputs VALUES(?,?,?,?,?,?,?,?,?)').run(document.document.planId, output.outputId,
        output.state, output.structured ? canonicalWfdJson(output.structured) : null, output.structuredDigest, output.routingState,
        canonicalWfdJson(document.document.outputs.find(item => item.outputId === output.outputId)!.dimensions), canonicalWfdJson(output.gaps), output.updatedAt);
    }
    for (const material of document.document.materials) {
      const decision = deriveMaterialRouting({ material, dimensions: material.dimensions, rejected: false, outputId: null, intendedAction: (material as { intendedAction?: 'inspect' | 'publish' }).intendedAction });
      this.insertDecision({ decisionId: randomUUID(), scopeKind: 'material', materialId: material.materialId, outputId: null,
        planId: document.document.planId, materialIds: [material.materialId], custodyState: material.custodyState,
        routingState: decision.routingState, dimensions: material.dimensions, suggestions: material.suggestions, gaps: decision.gaps,
        requestKey: requestKeyFor('plan', input.requestId) });
    }
    for (const output of document.outputs) {
      const spec = document.document.outputs.find(item => item.outputId === output.outputId)!;
      this.insertDecision({ decisionId: randomUUID(), scopeKind: 'output', materialId: spec.materialIds[0]!, outputId: output.outputId,
        planId: document.document.planId, materialIds: spec.materialIds, custodyState: 'received', routingState: output.routingState,
        dimensions: spec.dimensions, suggestions: spec.suggestions, gaps: output.gaps, requestKey: requestKeyFor('plan', input.requestId) });
    }
  }

  private insertDecision(input: { decisionId: string; scopeKind: 'material' | 'output'; materialId: string; outputId: string | null;
    planId: string | null; materialIds: string[]; custodyState: CustodyState; routingState: RoutingState;
    dimensions: NormalizedDimension[]; suggestions: DimensionSuggestion[]; gaps: string[]; requestKey: string }): void {
    const revision = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM routing_decisions WHERE scope_kind=? AND material_id=? AND COALESCE(output_id,'')=?`)
      .get(input.scopeKind, input.materialId, input.outputId ?? '')!.n) + 1;
    const now = Date.now();
    this.db.prepare('INSERT INTO routing_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(input.decisionId, input.scopeKind,
      input.materialId, input.outputId, input.planId, canonicalWfdJson(input.materialIds), input.custodyState, input.routingState,
      canonicalWfdJson(input.dimensions), canonicalWfdJson(input.suggestions), canonicalWfdJson(input.gaps), input.requestKey, revision, now, now);
  }

  private async executeStepCore(context: TaskExecutionContext, planId: string, stepId: string): Promise<void> {
    const plan = this.planView(planId), step = plan.steps.find(item => item.stepId === stepId)!;
    const started = Date.now(), dependencies = step.dependsOn.map(id => plan.steps.find(item => item.stepId === id)!);
    for (const dependency of dependencies) if (dependency.state !== 'succeeded') fail('PROCESSING_DEPENDENCY', `前置步骤 ${dependency.stepId} 尚未完成；未越过依赖执行。`);
    this.assertActive(context);
    let computed: { bytes: Buffer; digest: string; checkScope: string[]; gaps: string[]; passthrough?: boolean; normalization?: WfdRecord };
    let semantic: ProcessingSemanticEvidence | null = null;
    if (step.applicability === 'not_applicable') {
      if (!dependencies.length || !dependencies[0]!.output) fail('PROCESSING_DEPENDENCY', '不适用步骤缺少可传递的上游产物。');
      if (step.kind === 'annotate') {
        const structured = this.readArtifact<StructuredCandidateTable>(dependencies[0]!.output, 'structured-table', 'cleaned-table');
        const annotated = annotateCandidateTable(structured, {}), bytes = Buffer.from(canonicalWfdJson(annotated));
        computed = { bytes, digest: wfdSha256(bytes), checkScope: ['no_constants'], gaps: ['未声明常量标注；规则不适用，已清除旧标注。'] };
      } else {
        computed = { bytes: Buffer.alloc(0), digest: dependencies[0]!.outputDigest!, checkScope: [],
          gaps: [`${step.kind} 规则不适用；按固定依赖传递上游产物，未生成通过证明。`], passthrough: true };
      }
    } else if (step.kind === 'parse') {
      const params = step.parameters as unknown as CandidateTablePlan, material = plan.materials.find(item => item.materialId === params.materialId);
      if (!material) fail('PROCESSING_MATERIAL_NOT_FOUND', '解析步骤没有对应材料事实。');
      const original = this.options.materials.readOriginal(params.materialId);
      if (original.sha256 !== material.sha256) fail('PROCESSING_MATERIAL_CHANGED', '解析前材料摘要与计划冻结值不符。');
      if (params.financialCalculation && (!this.options.financialReader || !this.options.financialReaderIdentity
        || wfdSha256(canonicalWfdJson(this.options.financialReaderIdentity())) !== params.financialReaderBinding)) fail('FINANCIAL_FIXED', '固定计划的财务读取连接身份已变化；未改绑或读取其他实例。');
      const projection = params.format === 'pdf' ? await projectFinancialPdf(original.bytes, params.pdfSelection!, context.signal)
        : params.format === 'financial-fixed' ? await projectFinancialFixed(params.financialCalculation!, this.options.financialReader!, context.signal, review => {
          const material = this.options.materials.readOriginal(review.materialId);
          const text = decodeText(material.bytes);
          if (material.sha256 !== review.originalSha256 || !text?.includes(review.quote)) fail('FINANCIAL_FIXED', '跨修订相容性原文或受管材料摘要不符。');
          const normalized = review.quote.replace(/\s+/gu, '');
          if (!/(?:更正|调整)/u.test(normalized) || !/(?:不会对|不影响)/u.test(normalized) || !/净利润/u.test(normalized)) fail('FINANCIAL_FIXED', '更正原文没有明确说明净利润不受影响；本版不推断其他科目相容。');
        }) : null;
      const projected = projection ? parseTableSource(projection.jsonBytes, { ...params, format: 'json', pdfSelection: undefined, financialCalculation: undefined }) : null;
      let parsed: ParsedCandidateTable;
      try {
        parsed = projected && projection ? { ...projected, format: params.format, source_sha256: original.sha256,
          adapter: { id: params.format === 'pdf' ? 'bd-financial-pdf-regions' : 'bd-financial-fixed', version: '1' }, financial_evidence: projection.evidence } : parseTableSource(original.bytes, params);
      } catch (error) {
        // 适配漂移按实际失败原因隔离；不换配置、不回退到通用解析、不重试其他版本。
        if (params.sourceAdapter && error instanceof TaskError) this.options.adapters?.recordDrift({ adapterId: params.sourceAdapter.adapterId,
          version: params.sourceAdapter.version, configDigest: params.sourceAdapter.configDigest, materialId: params.materialId,
          code: error.code, message: error.message, detail: { planId, stepId, sourceSha256: original.sha256, format: params.format } });
        throw error;
      }
      const bytes = Buffer.from(canonicalWfdJson(parsed));
      const adapterGaps = isWfdRecord(parsed.adapter_evidence) && Array.isArray(parsed.adapter_evidence.gaps)
        ? (parsed.adapter_evidence.gaps as unknown[]).filter((gap): gap is string => typeof gap === 'string') : [];
      computed = { bytes, digest: wfdSha256(bytes), checkScope: ['strict_utf8_decoding', 'table_shape', 'original_cells_preserved'],
        gaps: ['未验证来源真实性、业务语义、单位或时间身份。', ...adapterGaps] };
    } else if (step.kind === 'clean') {
      const parsed = this.readArtifact<ParsedCandidateTable>(dependencies[0]!.output!, 'parsed-table');
      const params = step.parameters as { trim?: string[]; emptyToNull?: string[] };
      const rules = { trim: params.trim ?? [], emptyToNull: params.emptyToNull ?? [] };
      // 仅在宿主明确绑定 Polars 时执行真实严格列式清洗；执行失败绝不隐式回退到 TypeScript。
      // 未装配受信进程的旧独立/隔离运行继续按已有纯规则处理，历史身份不变。
      const executed = this.options.polarsCleaner
        ? await this.options.polarsCleaner.clean(context, parsed, rules) : null;
      const cleaned = executed?.cleaned ?? cleanCandidateTable(parsed, rules);
      const bytes = Buffer.from(canonicalWfdJson(cleaned));
      computed = { bytes, digest: wfdSha256(bytes),
        checkScope: ['all_rows', 'changes_recorded', 'original_cells_preserved',
          ...(executed ? ['polars_strict_columns', 'polars_verified_against_original_rules'] : [])],
        gaps: ['未验证清洗规则是否符合业务含义；只执行了显式空白与空值规则。'],
        ...(executed ? { normalization: { scope: 'cleaning_engine', ...executed.evidence } } : {}) };
    } else if (step.kind === 'structure') {
      const cleaned = this.readArtifact<CleanedCandidateTable | ParsedCandidateTable>(dependencies[0]!.output!, 'cleaned-table', 'parsed-table');
      const params = step.parameters as { types?: CandidateTablePlan['types'] };
      // 未显式声明类型时沿用上游产物类型：适配配置声明的 decimal/integer 必须在此实际生效。
      const declared = params.types && Object.keys(params.types).length ? params.types : undefined;
      // 清洗与算法计算仍为不同业务模块；只有固定结构化步骤才运行严格 Polars 类型转换。
      // 原 TypeScript 规则作为无损精度的独立核验，真实结果必须来自受信 Polars 回执。
      const executed = this.options.polarsCleaner
        ? await this.options.polarsCleaner.structure(context, cleaned, declared) : null;
      const structured = executed?.structured ?? structureCandidateTable(cleaned, declared);
      const bytes = Buffer.from(canonicalWfdJson(structured));
      const typeChanges: StructuredCandidateTable['type_changes'] = [];
      const normalizationBase = { state: 'recorded', scope: 'structure_type_changes',
        clean_changes_total: structured.changes_total, type_changes_total: structured.type_changes_total,
        decimal_lexeme_changes_total: structured.decimal_lexeme_changes_total,
        type_change_window_limit: 4, summary_byte_limit: NORMALIZATION_SUMMARY_MAX_BYTES,
        artifact_change_window_limit: structured.type_change_window_limit,
        artifact_changes_truncated: structured.type_changes_truncated };
      for (const change of structured.type_changes.slice(0, 4)) {
        const candidate = { ...normalizationBase, type_changes: [...typeChanges, change],
          type_changes_sample_count: typeChanges.length + 1,
          type_changes_truncated: structured.type_changes_total > typeChanges.length + 1 };
        if (Buffer.byteLength(canonicalWfdJson(candidate), 'utf8') > NORMALIZATION_SUMMARY_MAX_BYTES) break;
        typeChanges.push(change);
      }
      computed = { bytes, digest: wfdSha256(bytes), checkScope: ['finite_scalars', 'precision_checked', 'original_cells_preserved',
          ...(executed ? ['polars_strict_structure', 'independent_precision_comparison'] : [])],
        gaps: ['未验证类型是否符合外部业务定义；只执行显式类型。'],
        normalization: { ...normalizationBase,
          ...(executed ? { engine: 'polars', workerSha256: executed.evidence.workerSha256,
            engineReceiptSha256: executed.evidence.chunkReceiptsSha256 } : {}),
          type_changes: typeChanges,
          type_changes_sample_count: typeChanges.length,
          type_changes_truncated: structured.type_changes_total > typeChanges.length } };
    } else if (step.kind === 'annotate') {
      const structured = this.readArtifact<StructuredCandidateTable>(dependencies[0]!.output!, 'structured-table');
      const params = step.parameters as { annotations?: Record<string, string | number | boolean | null> };
      const annotated = annotateCandidateTable(structured, params.annotations ?? {}), bytes = Buffer.from(canonicalWfdJson(annotated));
      computed = { bytes, digest: wfdSha256(bytes), checkScope: ['constants_do_not_override', 'scalar_constants'],
        gaps: ['常量标注来源与业务含义未由业务规则验证。'] };
    } else if (step.kind === 'check') {
      const tables = dependencies.map(dependency => this.readArtifact<AnnotatedCandidateTable>(dependency.output!, 'annotated-table', 'structured-table'));
      const checked = checkCandidateTables(tables);
      computed = { bytes: checked.bytes, digest: checked.evidence.structured_sha256, checkScope: checked.evidence.check_scope, gaps: checked.evidence.gaps };
      semantic = this.checkSemantic(checked.rows, step.parameters);
      const selections = checked.evidence.sources.flatMap(source => source.selection ? [source.selection] : []);
      if (semantic && selections.length) semantic.coverage.sourceSelections = selections;
    } else fail('PROCESSING_STEP_KIND', '未知处理步骤。');
    this.assertActive(context);
    if (computed.bytes.byteLength > PROCESSING_LIMITS.maxObjectBytes) fail('PROCESSING_OBJECT_BUDGET', '步骤产物超过对象字节预算。');
    const consume = computed.passthrough ? { toolMs: Math.max(1, Date.now() - started) }
      : { storageBytes: computed.bytes.byteLength, toolMs: Math.max(1, Date.now() - started) };
    context.consumeBudget(consume);
    const gaps = [...new Set([...(step.gaps ?? []), ...computed.gaps, ...(semantic?.gaps ?? [])])];
    this.options.database.transaction(() => {
      this.assertActive(context);
      const output = computed.passthrough ? dependencies[0]!.output : this.options.objects.put(computed.bytes, 'application/json');
      if (!output) fail('PROCESSING_OBJECT', '步骤产物没有受管对象引用。');
      this.db.prepare(`UPDATE processing_plan_steps SET state='succeeded',output_json=?,output_digest=?,check_scope_json=?,gaps_json=?,
        error_json=NULL,completed_at=?,attempt_task_id=?,semantic_json=?,normalization_json=? WHERE plan_id=? AND step_id=?`).run(canonicalWfdJson(output), computed.digest,
        canonicalWfdJson(computed.checkScope), canonicalWfdJson(gaps), Date.now(), context.task.id,
        semantic ? canonicalWfdJson(semantic) : null, computed.normalization ? canonicalWfdJson(computed.normalization) : null, planId, stepId);
      this.refreshPlan(planId);
    });
    // 阶段产物已持久；真实等待检查点写入并让出事件循环，再重新核对停止、generation 和预算。
    await context.emit({ type: 'checkpoint', checkpoint: { planId, stepId, state: 'succeeded', outputDigest: computed.digest } });
    await new Promise<void>(resolve => setImmediate(resolve));
    context.consumeBudget({ toolMs: 1 });
    this.assertActive(context);
  }

  /** 结构产物与金融证明分别落盘；坏行情不销毁已完成的结构检查。 */
  private checkSemantic(rows: WfdRecord[], parameters: WfdRecord): ProcessingSemanticEvidence | null {
    if (parameters.semantic === undefined) return null;
    const frozen = readRecord(parameters.semantic, ['applicable', 'ruleVersion', 'ruleDigest', 'checkScope', 'gaps', 'declaration', 'sourceDimensions'], 'PROCESSING_SEMANTIC_BINDING');
    const compiled = compileR1TabularDeclaration(frozen.declaration);
    const sourceGaps = this.tabularSourceGaps(frozen.declaration,
      Array.isArray(frozen.sourceDimensions) ? frozen.sourceDimensions as Pick<NormalizedDimension, 'key' | 'status' | 'value'>[] : []);
    const incomplete = { scope: 'processed_output_rows' as const, inputRows: rows.length, checkedRows: null, complete: false };
    if (!compiled.applicable || frozen.ruleVersion !== compiled.ruleVersion || frozen.ruleDigest !== compiled.ruleDigest) {
      return { quality: 'indeterminate', ruleVersion: String(frozen.ruleVersion), ruleDigest: String(frozen.ruleDigest),
        checkScope: [], gaps: ['原计划冻结的金融规则或目标摘要已变化；须形成关联新计划，未沿旧证明发布。'], coverage: incomplete };
    }
    try {
      const checked = checkR1TabularRows(rows, frozen.declaration);
      const quality = checked.quality === 'pass' && sourceGaps.length === 0 ? 'pass' : 'indeterminate';
      return { quality, ruleVersion: checked.ruleVersion, ruleDigest: checked.ruleDigest,
        checkScope: [...checked.checkScope, 'operator_source_declaration_binding', 'source_acquisition_time_order',
          'operator_declared_usage_and_handoff_authorization',
          ...(isWfdRecord(frozen.declaration) && isWfdRecord(frozen.declaration.mapping) && frozen.declaration.mapping.bar
            ? ['financial_record_role_adoption', 'direct_observation_nature_adoption']
            : ['declared_material_role_adoption', 'content_nature_adoption'])],
        gaps: [...checked.gaps, ...sourceGaps],
        coverage: quality === 'pass' ? { scope: 'processed_output_rows', inputRows: rows.length, checkedRows: rows.length, complete: true } : incomplete };
    } catch (error) {
      if (!(error instanceof TaskError)) throw error;
      return { quality: 'fail', ruleVersion: compiled.ruleVersion, ruleDigest: compiled.ruleDigest, checkScope: [],
        gaps: [`${error.code}: ${error.message}`], coverage: incomplete, error: { code: error.code, message: error.message } };
    }
  }

  private outputSemantic(target: ProcessingTargetInput | null, evidence: ProcessingSemanticEvidence | null,
    dimensions: Pick<NormalizedDimension, 'key' | 'status' | 'value'>[]): ProcessingSemanticEvidence | null {
    if (!isR1TabularDeclaration(target?.declaration)) return null;
    const binding = compileR1TabularDeclaration(target!.declaration);
    const sourceGaps = this.tabularSourceGaps(target!.declaration, dimensions);
    if (!evidence) return { quality: 'pending', ruleVersion: binding.ruleVersion, ruleDigest: binding.ruleDigest,
      checkScope: [], gaps: [...binding.gaps, ...sourceGaps, '本输出金融规则尚未执行；六维已知与结构完成不代替证明。'],
      coverage: { scope: 'processed_output_rows', inputRows: null, checkedRows: null, complete: false } };
    if (evidence.ruleVersion !== binding.ruleVersion || evidence.ruleDigest !== binding.ruleDigest) {
      return { ...evidence, quality: 'indeterminate', checkScope: [],
        gaps: [...binding.gaps, ...sourceGaps, '当前金融规则、映射或目标与原证明绑定不一致；保留历史证明，禁止当前发布。'],
        coverage: { ...evidence.coverage, complete: false } };
    }
    if (evidence.quality === 'pass' && sourceGaps.length) return { ...evidence, quality: 'indeterminate',
      gaps: [...evidence.gaps, ...sourceGaps], coverage: { ...evidence.coverage, complete: false } };
    return evidence;
  }

  /** 仅核受信操作者的采用声明与来源时间；不签发独立来源真实性或法律许可结论。 */
  private tabularSourceGaps(declaration: unknown, dimensions: Pick<NormalizedDimension, 'key' | 'status' | 'value'>[]): string[] {
    const source = isWfdRecord(declaration) && isWfdRecord(declaration.source) ? declaration.source : {};
    const gaps = r1SourceGaps(source);
    const requested = parseR1Utc(source.requested_at_utc), acquired = parseR1Utc(source.acquired_at_utc);
    if (!Number.isFinite(requested) || !Number.isFinite(acquired) || acquired < requested) gaps.push('来源请求/取得时刻须为有效明确 UTC 且取得不早于请求；不以业务日期补造。');
    const role = dimensions.find(item => item.key === 'role'), nature = dimensions.find(item => item.key === 'informationNature');
    const mapping = isWfdRecord(declaration) && isWfdRecord(declaration.mapping) ? declaration.mapping : {};
    const context = isWfdRecord(declaration) && isWfdRecord(declaration.target)
      && isWfdRecord(declaration.target.definition) && isWfdRecord(declaration.target.definition.semantic_context)
      ? declaration.target.definition.semantic_context : {};
    if (mapping.bar) {
      if (role?.status !== 'known' || !['financial-record', 'financial_record', '金融记录'].includes(role.value ?? '')) gaps.push('行情材料角色须明确采用为金融记录；代码、训练材料或未识别自由文本不能进入行情。');
      if (nature?.status !== 'known' || !['direct-observation', 'observed_fact', '直接观察'].includes(nature.value ?? '')) gaps.push('行情信息性质须明确采用为直接观察；来源主张、预测或未识别自由文本不能洗成实测行情。');
    } else {
      if (role?.status !== 'known' || !role.value?.trim()) gaps.push('通用表格材料角色须由操作者明确采用。');
      const natureValues = context.content_nature === 'observed_fact'
        ? ['direct-observation', 'observed_fact', '直接观察'] : [context.content_nature];
      if (nature?.status !== 'known' || !natureValues.includes(nature.value)) gaps.push('通用表格信息性质须与目标 content_nature 明确一致；来源主张、预测不能洗成已观测事实。');
    }
    return gaps;
  }

  private markStepFailed(planId: string, stepId: string, taskId: string, error: unknown): void {
    const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'PROCESSING_STEP_FAILED';
    const message = error instanceof Error ? error.message : '处理步骤失败。';
    this.options.database.transaction(() => {
      const current = this.stepRow(planId, stepId);
      if (!current || current.state === 'succeeded') return;
      const gaps = [...(parseJson(current.gaps_json) as string[]), `${stepId}: ${code}: ${message.slice(0, 500)}`];
      this.db.prepare(`UPDATE processing_plan_steps SET state='failed',error_json=?,gaps_json=?,completed_at=?,attempt_task_id=?
        WHERE plan_id=? AND step_id=?`).run(canonicalWfdJson({ code, message: message.slice(0, 2000) }), canonicalWfdJson(gaps),
        Date.now(), taskId, planId, stepId);
      this.refreshPlan(planId);
    });
  }

  /** 完成步骤先持久对象与步骤状态，再据同一事务内的步骤事实更新输出和计划；没有跨事务“先推进后落盘”。 */
  private refreshPlan(planId: string): void {
    const plan = this.planRow(planId); if (!plan) return;
    const document = this.document(plan), steps = this.stepRows(planId);
    const now = Date.now();
    for (const output of document.outputs) {
      const own = steps.filter(step => step.output_id === output.outputId);
      const check = own.find(step => step.kind === 'check');
      const state: OutputState = !own.length ? 'custody_only' : own.some(step => step.state === 'failed') ? 'failed'
        : own.some(step => step.required && (step.state === 'blocked' || step.applicability === 'unknown')) ? 'blocked'
        : check?.state === 'succeeded' ? 'structured' : 'pending';
      const structured = check?.state === 'succeeded' && check.output_json ? this.ref(check.output_json) : null;
      const processingGaps = own.flatMap(step => step.state === 'failed'
        ? [`${step.step_id}: ${(parseJson(step.error_json ?? '{}') as { message?: string }).message ?? '失败'}`]
        : step.kind === 'check' && step.state === 'succeeded' ? (parseJson(step.gaps_json) as string[])
        : step.state === 'blocked' || step.applicability === 'unknown' ? (parseJson(step.gaps_json) as string[]) : []);
      const material = document.materials.find(item => item.materialId === output.materialIds[0])!;
      const semantic = this.outputSemantic(output.target, check?.semantic_json ? parseJson<ProcessingSemanticEvidence>(check.semantic_json) : null, output.dimensions);
      const usage = output.usage ?? { purpose: output.intendedAction === 'publish' ? 'current_publish' as const : 'current_compute' as const,
        historyMode: null, cutoff: null, perspective: null, purposeEvidence: [] };
      const usageQualification = this.usageQualification(usage, structured?.sha256 ?? material.sha256);
      const routing = deriveOutputRouting({ material: this.outputMaterialFacts(material, output.tables), dimensions: output.dimensions, target: output.target
        ? { present: true, kind: output.target.productRef ? 'productRef' : output.target.declaration ? 'declaration' : 'none',
          expectedSnapshotId: output.target.expectedSnapshotId ?? null } : undefined,
        rejected: !!output.rejectReason, outputId: output.outputId, outputState: state, intendedAction: output.intendedAction,
        usage: usageQualification, processingGaps, adapterGaps: output.adapterGaps, semantic });
      this.db.prepare('UPDATE processing_plan_outputs SET state=?,structured_json=?,structured_digest=?,routing_state=?,gaps_json=?,updated_at=? WHERE plan_id=? AND output_id=?')
        .run(state, structured ? canonicalWfdJson(structured) : null, structured?.sha256 ?? null, routing.routingState,
          canonicalWfdJson(routing.gaps), now, planId, output.outputId);
      this.db.prepare(`UPDATE routing_decisions SET routing_state=?,gaps_json=?,updated_at=? WHERE plan_id=? AND scope_kind='output' AND output_id=?`)
        .run(routing.routingState, canonicalWfdJson(routing.gaps), now, planId, output.outputId);
    }
    const outputs = this.outputRows(planId);
    this.db.prepare('UPDATE processing_plans SET status=?,updated_at=? WHERE plan_id=?').run(this.planStatus(outputs), now, planId);
  }

  private planStatus(outputs: { state: string }[]): string {
    if (!outputs.length) return 'blocked';
    const states = outputs.map(output => output.state);
    if (states.every(state => state === 'structured' || state === 'custody_only')) return 'completed';
    if (states.every(state => state === 'blocked')) return 'blocked';
    if (states.every(state => state === 'failed')) return 'failed';
    if (states.some(state => state === 'structured') && states.some(state => state === 'blocked' || state === 'failed')) return 'partial';
    if (states.some(state => state === 'structured')) return 'partial';
    if (states.some(state => state === 'blocked' || state === 'failed')) return 'partial';
    return 'prepared';
  }

  private verifyPlan(planId: string) {
    const verified: { stepId: string; outputDigest: string; state: string }[] = [], corrupt: string[] = [];
    const planRow = this.planRow(planId);
    if (!planRow) return { planId, verified, corrupt: ['处理计划本身缺失，核对范围不成立'] };
    // 计划规格里的每一步都必须有持久步骤行；缺行不是「没有问题」，而是核对范围不成立。
    const steps = this.stepRows(planId), present = new Set(steps.map(step => step.step_id));
    for (const specification of this.document(planRow).steps ?? []) {
      if (specification.stepId && !present.has(specification.stepId)) {
        corrupt.push(`${specification.stepId}: 步骤记录缺失，核对范围不成立`);
      }
    }
    for (const step of steps) {
      if (step.state !== 'succeeded' || !step.output_json) continue;
      const ref = this.ref(step.output_json);
      if (!this.options.objects.verify(ref)) { corrupt.push(`${step.step_id}: 对象缺失或长度不符`); continue; }
      try {
        const bytes = this.options.objects.get(ref);
        if (wfdSha256(bytes) !== step.output_digest) { corrupt.push(`${step.step_id}: 对象摘要与步骤记录不符`); continue; }
        verified.push({ stepId: step.step_id, outputDigest: step.output_digest ?? '', state: step.state });
      } catch (error) { corrupt.push(`${step.step_id}: ${error instanceof Error ? error.message : '对象读取失败'}`); }
    }
    return { planId, verified, corrupt };
  }

  /* ── 只读组合与视图。 ──────────────────────────────────────────────────────────── */

  private planView(planId: string) {
    validId(planId, 'PROCESSING_PLAN_ID');
    const row = this.planRow(planId); if (!row) fail('PROCESSING_PLAN_NOT_FOUND', '没有该处理计划。');
    const requestRow = this.request(row.request_key), document = this.document(row), steps = this.stepRows(planId), outputs = this.outputRows(planId);
    const integrity = [...steps.filter(step => step.output_json).map(step => {
      const ref = this.ref(step.output_json as string); return { stepId: step.step_id, present: this.options.objects.verify(ref) };
    })];
    // 规格里有、持久行里没有的步骤与输出：缺失不是「没有问题」，视图必须显式报出。
    const missingSteps = (document.steps ?? []).map(specification => specification.stepId)
      .filter(stepId => !steps.some(step => step.step_id === stepId));
    const missingOutputs = document.outputs.map(output => output.outputId)
      .filter(outputId => !outputs.some(item => item.output_id === outputId));
    return { planId, version: document.version ?? null, requestId: requestRow?.client_request_id ?? row.request_key, parentPlanId: row.parent_plan_id, status: row.status, planDigest: row.plan_digest,
      scopeKey: row.scope_key, executionDigest: document.executionDigest, policy: document.policy, policyDigest: row.policy_digest,
      operator: document.operator, createdAt: row.created_at, updatedAt: row.updated_at, reuseFromPlanId: document.reuseFromPlanId,
      materials: document.materials.map(material => ({ materialId: material.materialId, filename: material.filename, sha256: material.sha256,
        byteLength: material.byteLength, mediaType: material.mediaType, format: material.format, support: material.support,
        adapter: material.adapter, custodyState: material.custodyState, routingState: material.routingState, gaps: material.gaps,
        dimensions: material.dimensions, suggestions: material.suggestions })),
      outputs: document.outputs.map(output => {
        const state = outputs.find(item => item.output_id === output.outputId);
        if (!state) {
          // 输出行已缺失：不能凭空读字段，也不能据此给出发布资格。
          return { outputId: output.outputId, materialIds: output.materialIds, target: output.target, intendedAction: output.intendedAction,
            usage: output.usage ?? null, rejectReason: null, routingState: 'needs_review' as const, state: 'missing', structured: null,
            gaps: ['输出记录缺失：计划规格存在但持久输出行不在，禁止据此发布。'], dimensions: [], semanticGaps: [], semantic: null,
            publishEligible: false,
            ...(output.intendedAction === 'publish' ? { publishAuthorization: 'not_evaluated', publishScope: 'planning_only' } : {}),
            evidenceScope: null, steps: [] };
        }
        const dimensions = parseJson<NormalizedDimension[]>(state.dimensions_json);
        const semanticGaps = dimensions.filter(item => item.status !== 'known').map(item => `${item.key}: ${item.gap ?? '未知'}`);
        const check = steps.find(step => step.output_id === output.outputId && step.kind === 'check');
        const semantic = this.outputSemantic(output.target, check?.semantic_json ? parseJson<ProcessingSemanticEvidence>(check.semantic_json) : null, dimensions);
        const routingState = semantic && semantic.quality !== 'pass' && state.routing_state === 'ready_candidate' ? 'needs_review' : state.routing_state;
        return { outputId: output.outputId, materialIds: output.materialIds, target: output.target, intendedAction: output.intendedAction,
          usage: output.usage ?? null,
          rejectReason: typeof output.rejectReason === 'string' ? output.rejectReason : null,
          routingState, state: state.state, structured: state.structured_json ? parseJson<ManagedObjectRef>(state.structured_json) : null,
          gaps: [...new Set([...parseJson<string[]>(state.gaps_json), ...(semantic?.gaps ?? [])])], dimensions, semanticGaps, semantic,
          publishEligible: output.intendedAction === 'publish' && state.state === 'structured' && routingState === 'ready_candidate'
            && semanticGaps.length === 0 && !!output.target && (!semantic || semantic.quality === 'pass'),
          ...(output.intendedAction === 'publish' ? { publishAuthorization: 'not_evaluated', publishScope: 'planning_only' } : {}),
          evidenceScope: state.state === 'structured' ? 'structural_only' : null,
          steps: steps.filter(step => step.output_id === output.outputId).map(step => this.stepView(step)) };
      }),
      steps: steps.map(step => this.stepView(step)), integrity, missingSteps, missingOutputs };
  }
  private stepView(step: StepRow) {
    return { stepId: step.step_id, outputId: step.output_id, kind: step.kind, required: !!step.required, applicability: step.applicability,
      state: step.state, dependsOn: parseJson<string[]>(step.depends_json), implementation: step.implementation, parameters: parseJson<WfdRecord>(step.parameters_json),
      completion: parseJson<WfdRecord>(step.completion_json), input: parseJson<WfdRecord>(step.input_json), gaps: parseJson<string[]>(step.gaps_json),
      specDigest: step.spec_digest, output: step.output_json ? parseJson<ManagedObjectRef>(step.output_json) : null, outputDigest: step.output_digest,
      checkScope: parseJson<string[]>(step.check_scope_json), error: step.error_json ? parseJson<WfdRecord>(step.error_json) : null,
      semantic: step.semantic_json ? parseJson<ProcessingSemanticEvidence>(step.semantic_json) : null,
      normalization: step.kind === 'structure' ? step.normalization_json ? parseJson<WfdRecord>(step.normalization_json)
        : { state: 'not_recorded', scope: 'structure_type_changes', clean_changes_total: null,
          type_changes_total: null, decimal_lexeme_changes_total: null, type_changes_sample_count: null } : null,
      reusedFrom: step.reused_from_plan_id ? { planId: step.reused_from_plan_id, stepId: step.reused_from_step_id } : null,
      startedAt: step.started_at, completedAt: step.completed_at };
  }
  private decisionView(decisionId: string) {
    const row = this.decisionRow(decisionId); if (!row) fail('PROCESSING_DECISION_NOT_FOUND', '没有该路由决定。');
    return { decisionId: row.decision_id, scope: row.scope_kind, materialId: row.material_id, outputId: row.output_id,
      planId: row.plan_id, materialIds: parseJson<string[]>(row.material_ids_json), custodyState: row.custody_state, routingState: row.routing_state,
      dimensions: parseJson<NormalizedDimension[]>(row.dimensions_json), suggestions: parseJson<DimensionSuggestion[]>(row.suggestions_json), gaps: parseJson<string[]>(row.gaps_json),
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private result(plan: ReturnType<ProcessingPlanService['planView']>): TaskResult {
    return { summary: `处理计划 ${plan.status}；${plan.outputs.filter(output => output.state === 'structured').length}/${plan.outputs.length} 个输出已形成结构产物。`,
      data: json(plan) as Record<string, JsonValue> };
  }
  private resultForDecision(row: DecisionRow): TaskResult {
    return { summary: `材料路由已保存：${row.routing_state}；保管状态 ${row.custody_state}。`, data: json(this.decisionView(row.decision_id)) as Record<string, JsonValue> };
  }

  /* ── 行读取和任务工具。 ────────────────────────────────────────────────────────── */

  private planRow(planId: string): PlanRow | undefined { return this.db.prepare('SELECT * FROM processing_plans WHERE plan_id=?').get(planId) as PlanRow | undefined; }
  private stepRow(planId: string, stepId: string): StepRow | undefined { return this.db.prepare('SELECT * FROM processing_plan_steps WHERE plan_id=? AND step_id=?').get(planId, stepId) as StepRow | undefined; }
  private stepRows(planId: string): StepRow[] { return this.db.prepare('SELECT * FROM processing_plan_steps WHERE plan_id=? ORDER BY ordinal').all(planId) as unknown as StepRow[]; }
  private outputRow(planId: string, outputId: string): OutputRow | undefined { return this.db.prepare('SELECT * FROM processing_plan_outputs WHERE plan_id=? AND output_id=?').get(planId, outputId) as OutputRow | undefined; }
  private outputRows(planId: string): OutputRow[] { return this.db.prepare('SELECT * FROM processing_plan_outputs WHERE plan_id=? ORDER BY output_id').all(planId) as unknown as OutputRow[]; }
  private decisionRow(decisionId: string): DecisionRow | undefined { return this.db.prepare('SELECT * FROM routing_decisions WHERE decision_id=?').get(decisionId) as DecisionRow | undefined; }
  private request(requestKey: string): RequestRow | undefined { return this.db.prepare('SELECT * FROM processing_requests WHERE request_key=?').get(requestKey) as RequestRow | undefined; }
  private planTaskId(planId: string): string | undefined {
    const plan = this.planRow(planId); if (!plan) return undefined;
    return this.request(plan.request_key)?.task_id ?? undefined;
  }
  private requestPlanId(row: RequestRow): string | null {
    if (!row.task_id) return null;
    const args = this.tasks.get(row.task_id).args as { planId?: unknown };
    return typeof args.planId === 'string' ? args.planId : null;
  }
  private requestByTask(taskId: string): RequestRow | undefined { return this.db.prepare('SELECT * FROM processing_requests WHERE task_id=?').get(taskId) as RequestRow | undefined; }
  private task(request: RequestRow): TaskRecord { if (!request.task_id) fail('PROCESSING_TASK_NOT_FOUND', '处理请求尚未绑定任务。'); return this.tasks.get(request.task_id); }
  private document(row: PlanRow) {
    if (wfdSha256(row.plan_json) !== row.plan_digest) fail('PROCESSING_PLAN_CHANGED', '处理计划摘要与持久记录不符。');
    return parseJson(row.plan_json) as { planId: string; version?: string; implementation?: string; policy: WfdRecord; operator: WfdRecord; executionDigest: string; reuseFromPlanId: string | null;
      materials: (MaterialFacts & { dimensions: NormalizedDimension[]; suggestions: DimensionSuggestion[]; routingState: RoutingState; gaps: string[] })[];
      outputs: (Omit<NormalizedOutput, 'steps'> & { steps: string[] })[];
      steps: { stepId: string }[] };
  }
  /** 只有政策、实际实现和逐对象字节都核过的旧步骤才进入复用索引。 */
  private reusablePriorSteps(planId: string): Map<string, StepRow> {
    const plan = this.planRow(planId);
    if (!plan || plan.policy_version !== PROCESSING_POLICY.version || plan.policy_digest !== PROCESSING_POLICY_DIGEST) return new Map();
    const document = this.document(plan);
    if (document.implementation !== this.versionBinding.implementation) return new Map();
    const map = new Map<string, StepRow>();
    for (const row of this.stepRows(planId)) {
      if (row.state !== 'succeeded' || !row.output_json) continue;
      let ref: ManagedObjectRef;
      try { ref = this.ref(row.output_json); } catch { continue; }
      if (!this.options.objects.verify(ref) || wfdSha256(this.options.objects.get(ref)) !== row.output_digest || ref.sha256 !== row.output_digest) continue;
      map.set(row.spec_digest, row);
    }
    return map;
  }
  private priorStepMatches(prior: StepRow, spec: StepSpec): boolean {
    if (spec.parameters.semantic && !prior.semantic_json) return false;
    let priorParameters: WfdRecord;
    try { priorParameters = digestParameters({ kind: spec.kind, parameters: parseJson<WfdRecord>(prior.parameters_json) }); }
    catch { return false; }
    return prior.kind === spec.kind && prior.output_id === spec.outputId && prior.implementation === spec.implementation
      && canonicalWfdJson(priorParameters) === canonicalWfdJson(digestParameters(spec)) && prior.completion_json === canonicalWfdJson(spec.completion)
      && prior.input_json === canonicalWfdJson(spec.input) && prior.depends_json === canonicalWfdJson(spec.dependsOn)
      && prior.applicability === spec.applicability && !!prior.required === spec.required;
  }
  private findReusePlanId(scopeKey: string): string | null {
    const rows = this.db.prepare(`SELECT p.plan_id FROM processing_plans p WHERE p.scope_key=? AND p.policy_version=? AND p.policy_digest=? AND p.status<>'rejected'
      ORDER BY p.created_at DESC,p.rowid DESC LIMIT 20`).all(scopeKey, PROCESSING_POLICY.version, PROCESSING_POLICY_DIGEST) as unknown as { plan_id: string }[];
    for (const row of rows) if (this.reusablePriorSteps(row.plan_id).size) return row.plan_id;
    return null;
  }
  private readArtifact<T>(ref: ManagedObjectRef, ...expectedKinds: string[]): T {
    const bytes = this.options.objects.get(ref);
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('PROCESSING_ARTIFACT_CHANGED', '步骤产物不是有效 JSON。'); }
    if (!isWfdRecord(value) || typeof value.kind !== 'string' || !expectedKinds.includes(value.kind)) fail('PROCESSING_ARTIFACT_CHANGED', `步骤产物类型不是 ${expectedKinds.join(' 或 ')}。`);
    return value as T;
  }
  private ref(value: string | WfdRecord): ManagedObjectRef {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    if (!isWfdRecord(parsed) || parsed.kind !== 'stored-object' || typeof parsed.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(parsed.sha256)
      || !Number.isSafeInteger(parsed.byte_length) || (parsed.byte_length as number) < 1 || typeof parsed.media_type !== 'string') {
      fail('PROCESSING_ARTIFACT_CHANGED', '受管对象引用无效。');
    }
    return { kind: 'stored-object', sha256: parsed.sha256 as string, byte_length: parsed.byte_length as number, media_type: parsed.media_type as string };
  }
  private assertPlanExecutable(planId: string): void {
    const row = this.planRow(planId); if (!row) fail('PROCESSING_PLAN_NOT_FOUND', '没有该处理计划。');
    if (row.policy_version !== PROCESSING_POLICY.version || row.policy_digest !== PROCESSING_POLICY_DIGEST) {
      fail('PROCESSING_VERSION_CHANGED', '原计划政策版本已变化；旧计划只可查询，须建立关联的新计划继续。');
    }
    const document = this.document(row);
    if (document.planId !== planId) fail('PROCESSING_PLAN_CHANGED', '处理计划身份不一致。');
    if ((document as { implementation?: string }).implementation !== this.versionBinding.implementation) fail('PROCESSING_VERSION_CHANGED', '原计划实现版本已变化；旧计划只可查询，须建立关联的新计划继续。');
  }
  private assertTaskVersion(task: TaskRecord): void {
    for (const [key, value] of Object.entries(this.versionBinding)) if (task.versions[key] !== value) fail('PROCESSING_VERSION_CHANGED', '原处理任务实现或政策版本已变化，不能冒充原版本执行。');
  }
  private assertDispatch(): void { if (this.tasks.getControl().stopped) fail('SERVICE_STOPPED', '服务已停止，未受理新的处理派发。'); }
  private assertActive(context: TaskExecutionContext): void {
    context.signal.throwIfAborted(); this.assertDispatch();
    const task = this.tasks.get(context.task.id);
    if (!this.tasks.isRunActive(context.runId, context.generation) || task.currentAttemptId !== context.attemptId || task.runtimeId !== PROCESSING_PLAN_RUNTIME) {
      fail('TASK_NOT_ACTIVE', '当前运行已不再拥有处理任务，未写入迟到结果。');
    }
  }
  private createTaskWithRequest(input: { title: string; kind: string; action: string; requestKey: string; requestId: string;
    planId: string | null; decisionId: string | null; contentDigest: string; args: WfdRecord; input: WfdRecord;
    parentTaskId?: string; budget?: { maxStorageBytes: number } }): TaskRecord {
    this.assertDispatch();
    let accepted!: ReturnType<TaskService['createInTransaction']>;
    this.options.database.transaction(() => {
      this.assertDispatch();
      accepted = this.tasks.createInTransaction({ title: input.title, ownerRole: 'service', runtimeId: PROCESSING_PLAN_RUNTIME,
        action: input.action, args: json(input.args), requestId: input.requestKey, versions: this.versionBinding,
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}), ...(input.budget ? { budget: input.budget } : {}) });
      const previous = this.request(input.requestKey);
      if (previous) {
        if (previous.content_digest !== input.contentDigest) fail('REQUEST_CONFLICT', '同一处理请求不能更换内容。');
        if (previous.task_id !== accepted.task.id) fail('PROCESSING_REQUEST_CHANGED', '处理请求绑定的任务身份不一致。');
        return;
      }
      this.db.prepare('INSERT INTO processing_requests VALUES(?,?,?,?,?,?,?,?,?)').run(input.requestKey, input.requestId, input.kind,
        accepted.task.id, input.planId, input.decisionId, input.contentDigest, canonicalWfdJson(input.input), Date.now());
    });
    accepted.publish(); return this.tasks.start(accepted.task.id, accepted.task.version);
  }
}

/* ── 纯工具：输入形状、证据定位、步骤摘要、JSON。 ───────────────────────────────────── */

function digestParameters(spec: Pick<StepSpec, 'kind' | 'parameters'>): WfdRecord {
  return spec.kind === 'parse' ? { materialId: spec.parameters.materialId, format: spec.parameters.format,
    fieldMapping: spec.parameters.fieldMapping, ...(spec.parameters.selection ? { selection: spec.parameters.selection } : {}),
    ...(spec.parameters.sourceAdapter ? { sourceAdapter: spec.parameters.sourceAdapter } : {}),
    ...(spec.parameters.xlsxSelection ? { xlsxSelection: spec.parameters.xlsxSelection } : {}),
    ...(spec.parameters.sourceProjection ? { sourceProjection: spec.parameters.sourceProjection } : {}),
    ...(spec.parameters.numericFormats ? { numericFormats: spec.parameters.numericFormats } : {}),
    ...(spec.parameters.xbrlSelection ? { xbrlSelection: spec.parameters.xbrlSelection } : {}),
    ...(spec.parameters.necessaryTextSelection ? { necessaryTextSelection: spec.parameters.necessaryTextSelection } : {}),
    ...(spec.parameters.pdfSelection ? { pdfSelection: spec.parameters.pdfSelection } : {}),
    ...(spec.parameters.financialCalculation ? { financialCalculation: spec.parameters.financialCalculation,
      financialReaderBinding: spec.parameters.financialReaderBinding } : {}) } : spec.parameters;
}
function stepDigest(spec: Omit<StepSpec, 'specDigest'>, ...dependencies: StepSpec[]): string {
  const parameters = digestParameters(spec);
  return wfdSha256(canonicalWfdJson({ kind: spec.kind, outputId: spec.outputId, implementation: spec.implementation,
    applicability: spec.applicability, parameters, completion: spec.completion, input: spec.input,
    dependsOn: spec.dependsOn.map(stepId => ({ stepId, specDigest: dependencies.find(step => step.stepId === stepId)?.specDigest ?? null })) }));
}
function actionKind(action: string): string {
  if (action === PROCESSING_ACTIONS.decide) return 'decide';
  if (action === PROCESSING_ACTIONS.plan) return 'plan';
  if (action === PROCESSING_ACTIONS.execute) return 'execute';
  if (action === PROCESSING_ACTIONS.run) return 'run';
  if (action === PROCESSING_ACTIONS.recover) return 'recover';
  return 'unknown';
}
function requestKeyFor(kind: string, requestId: string): string { validId(requestId, 'PROCESSING_REQUEST_ID'); return `processing:${kind}:${requestId}`; }
function validateOperator(operator: OperatorContext): void {
  if (!operator || typeof operator !== 'object' || Array.isArray(operator)) fail('PROCESSING_OPERATOR', '需要真实操作者请求身份。');
  validId(operator.operatorId, 'PROCESSING_OPERATOR_ID'); validId(operator.requestId, 'PROCESSING_REQUEST_ID');
  const conversation = operator.source === 'conversation';
  if (conversation) {
    if (!operator.conversation || !operator.conversation.conversationId || !operator.conversation.branchId || operator.method !== 'conversation'
      || typeof operator.path !== 'string' || !operator.path.startsWith('/') || typeof operator.remoteAddress !== 'string' && operator.remoteAddress !== null
      || !Number.isSafeInteger(operator.observedAt)) fail('PROCESSING_OPERATOR', '会话操作者身份、分支、方法、路径或时间无效。');
    return;
  }
  if (operator.source !== undefined && operator.source !== 'operator-http' || !['POST', 'PUT', 'PATCH'].includes(operator.method) || typeof operator.path !== 'string' || !operator.path.startsWith('/')
    || typeof operator.remoteAddress !== 'string' && operator.remoteAddress !== null || !Number.isSafeInteger(operator.observedAt)) {
    fail('PROCESSING_OPERATOR', '操作者请求方法、路径、来源地址或时间无效。');
  }
}
/** 持久化只保留来源身份与分支；用户消息核对函数属于本次受信调用，不写入计划或请求记录。 */
function storedOperator(operator: OperatorContext): OperatorContext {
  return { ...operator, ...(operator.conversation ? { conversation: { conversationId: operator.conversation.conversationId,
    branchId: operator.conversation.branchId } } : {}) };
}
function readRecord(value: unknown, keys: string[], code: string): WfdRecord {
  if (!isWfdRecord(value) || Object.keys(value).some(key => !keys.includes(key))) fail(code, `需要明确对象且只接受字段：${keys.join(', ')}。`);
  return value;
}
function readArray(value: unknown, min: number, max: number, code: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(code, `数组长度须在 ${min} 到 ${max}。`);
  return value;
}
function readId(value: unknown, code: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(value)) fail(code, '须使用稳定受控身份，不接受路径。');
  return value;
}
function validId(value: string, code: string): void { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(value)) fail(code, '身份无效。'); }
function validStepId(value: string): void { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/u.test(value)) fail('PROCESSING_STEP_ID', '步骤身份无效。'); }
function readText(value: unknown, min: number, max: number, code: string): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail(code, `文本长度须在 ${min} 到 ${max}。`);
  return value;
}
function readInteger(value: unknown, min: number, max: number, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(code, '整数或范围无效。');
  return value;
}
function readDimensions(value: unknown): Partial<Record<DimensionKey, ProcessingDimensionInput>> | null {
  if (value === undefined) return null;
  const record = readRecord(value, [...DIMENSION_KEYS], 'PROCESSING_DIMENSIONS');
  for (const key of Object.keys(record)) if (!DIMENSION_KEYS.includes(key as DimensionKey)) fail('PROCESSING_DIMENSIONS', '未知维度。');
  return record as Partial<Record<DimensionKey, ProcessingDimensionInput>>;
}
function readSuggestions(value: unknown): ProcessingSuggestionInput[] {
  if (value === undefined) return [];
  return readArray(value, 0, PROCESSING_LIMITS.maxSuggestions, 'PROCESSING_SUGGESTIONS') as ProcessingSuggestionInput[];
}
function readTables(value: unknown, materialIds: string[]): CandidateTablePlan[] {
  if (value === undefined) return [];
  const list = readArray(value, 1, PROCESSING_LIMITS.maxTablesPerOutput, 'PROCESSING_TABLES');
  return list.map(item => {
    const record = readRecord(item, ['materialId', 'format', 'sourceAdapter', 'sourceContext', 'sourceReceiptTaskId', 'fieldMapping', 'types', 'trim', 'emptyToNull', 'annotations', 'selection', 'xlsxSelection', 'sourceProjection', 'numericFormats', 'xbrlSelection', 'necessaryTextSelection', 'pdfSelection', 'financialCalculation'], 'PROCESSING_TABLE');
    const materialId = readId(record.materialId, 'PROCESSING_MATERIAL_ID');
    if (!materialIds.includes(materialId)) fail('PROCESSING_TABLES', '表源必须属于本输出的原件。');
    if (!['csv', 'json', 'xlsx', 'xbrl', 'text', 'pdf', 'financial-fixed'].includes(String(record.format))) fail('PROCESSING_TABLES', '表源须明确为受支持格式及其专用选择规则。');
    const sourceAdapter = record.sourceAdapter === undefined ? undefined : readAdapterBindingRef(record.sourceAdapter);
    if ((record.sourceContext !== undefined || record.sourceReceiptTaskId !== undefined) && !sourceAdapter)
      fail('PROCESSING_TABLES', '来源回执上下文只适用于已声明端点适配的表源。');
    if (record.sourceContext !== undefined && record.sourceReceiptTaskId !== undefined)
      fail('PROCESSING_TABLES', '同一表源不能同时声明合成上下文与真实取得回执。');
    for (const key of ['fieldMapping', 'types', 'annotations'] as const) if (record[key] !== undefined && !isWfdRecord(record[key])) fail('PROCESSING_TABLES', `${key} 须为明确对象。`);
    for (const key of ['trim', 'emptyToNull'] as const) if (record[key] !== undefined && (!Array.isArray(record[key]) || (record[key] as unknown[]).some(value => typeof value !== 'string'))) fail('PROCESSING_TABLES', `${key} 须为字符串数组。`);
    let selection: CandidateTablePlan['selection'];
    if (record.selection !== undefined) {
      if (record.format !== 'csv') fail('PROCESSING_SELECTION', '行选件只支持明确 CSV 原件。');
      const selected = readRecord(record.selection, ['predicate', 'maxSelectedRows', 'maxScannedRows'], 'PROCESSING_SELECTION');
      const predicate = readRecord(selected.predicate, ['column', 'equals'], 'PROCESSING_SELECTION');
      selection = { predicate: { column: readText(predicate.column, 1, 256, 'PROCESSING_SELECTION'),
        equals: readText(predicate.equals, 0, 1_048_576, 'PROCESSING_SELECTION') },
        maxSelectedRows: readInteger(selected.maxSelectedRows, 1, CANDIDATE_SELECTION_LIMITS.maxSelectedRows, 'PROCESSING_SELECTION'),
        maxScannedRows: readInteger(selected.maxScannedRows, 1, CANDIDATE_SELECTION_LIMITS.maxScannedRows, 'PROCESSING_SELECTION') };
    }
    const xlsxSelection = record.xlsxSelection === undefined ? undefined : readXlsxTableSelection(record.xlsxSelection);
    const sourceProjection = record.sourceProjection === undefined ? undefined : readSourceProjection(record.sourceProjection);
    const xbrlSelection = record.xbrlSelection === undefined ? undefined : readXbrlSelection(record.xbrlSelection);
    const necessaryTextSelection = record.necessaryTextSelection === undefined ? undefined : readNecessaryTextSelection(record.necessaryTextSelection);
    const pdfSelection = record.pdfSelection === undefined ? undefined : readFinancialPdfSelection(record.pdfSelection);
    const financialCalculation = record.financialCalculation === undefined ? undefined : readFinancialCalculation(record.financialCalculation);
    if ((record.format === 'xbrl') !== !!xbrlSelection || (record.format === 'text') !== !!necessaryTextSelection
      || (record.format === 'pdf') !== !!pdfSelection || (record.format === 'financial-fixed') !== !!financialCalculation) fail('PROCESSING_TABLES', '专用格式须具有同格式的明确投影选择，不能挪用其他格式规则。');
    if (sourceAdapter && !['csv', 'json'].includes(String(record.format))) fail('PROCESSING_TABLES', '端点适配表源须声明载体族 csv 或 json。');
    if (sourceAdapter && (selection || xlsxSelection || xbrlSelection || necessaryTextSelection || pdfSelection
      || financialCalculation || record.numericFormats !== undefined)) fail('PROCESSING_TABLES', '端点适配表源不接受选区、专用投影或区域数值规则。');
    if (record.numericFormats !== undefined && !isWfdRecord(record.numericFormats)) fail('PROCESSING_NUMERIC_FORMAT', '数值语法须按明确列名逐项声明。');
    const numericFormats = record.numericFormats === undefined ? undefined : Object.fromEntries(Object.entries(record.numericFormats as WfdRecord).map(([key, format]) => [key, readNumericFormat(format)]));
    if ((record.format === 'xlsx') !== !!xlsxSelection) fail('PROCESSING_XLSX_SELECTION', 'XLSX 必须提供明确选区，其他格式不能带工作簿选区。');
    const types: NonNullable<CandidateTablePlan['types']> = Object.assign(Object.create(null), record.types ?? {});
    for (const column of xlsxSelection?.columns ?? []) if (column.type) {
      const mapping = record.fieldMapping as Record<string, string> | undefined;
      const name = mapping && Object.hasOwn(mapping, column.name) ? mapping[column.name]! : column.name;
      if (types[name] && types[name] !== column.type) fail('PROCESSING_XLSX_TYPES', '选区列类型与结构类型声明冲突。');
      types[name] = column.type;
    }
    return { materialId, format: record.format as CandidateTablePlan['format'], ...(sourceAdapter ? { sourceAdapter } : {}),
      ...(record.sourceContext !== undefined ? { sourceContext: record.sourceContext } : {}),
      ...(record.sourceReceiptTaskId !== undefined ? { sourceReceiptTaskId: readId(record.sourceReceiptTaskId, 'PROCESSING_RECEIPT_TASK_ID') } : {}), ...(xlsxSelection ? { xlsxSelection } : {}), ...(record.fieldMapping ? { fieldMapping: record.fieldMapping as Record<string, string> } : {}),
      ...(numericFormats ? { numericFormats } : {}), ...(xbrlSelection ? { xbrlSelection } : {}),
      ...(necessaryTextSelection ? { necessaryTextSelection } : {}), ...(pdfSelection ? { pdfSelection } : {}),
      ...(financialCalculation ? { financialCalculation } : {}),
      ...(Object.keys(types).length ? { types } : {}),
      ...(record.trim ? { trim: record.trim as string[] } : {}), ...(record.emptyToNull ? { emptyToNull: record.emptyToNull as string[] } : {}),
      ...(record.annotations ? { annotations: record.annotations as Record<string, string | number | boolean | null> } : {}),
      ...(selection ? { selection } : {}), ...(sourceProjection ? { sourceProjection } : {}) };
  });
}
function readIntendedAction(value: unknown): 'inspect' | 'publish' {
  if (value === undefined) return 'inspect';
  if (value !== 'inspect' && value !== 'publish') fail('PROCESSING_INTENDED_ACTION', '用途动作须由请求明确为 inspect 或 publish，不能从自然语言推断。');
  return value;
}
function readTarget(value: unknown): ProcessingTargetInput | null {
  if (value === undefined) return null;
  const record = readRecord(value, ['productRef', 'declaration', 'expectedSnapshotId'], 'PROCESSING_TARGET');
  if (record.productRef !== undefined && !isWfdRecord(record.productRef) || record.declaration !== undefined && !isWfdRecord(record.declaration)
    || record.productRef && record.declaration) fail('PROCESSING_TARGET', '已有产品引用与新产品声明只能选择一项。');
  if (record.expectedSnapshotId !== undefined && record.expectedSnapshotId !== null) readId(record.expectedSnapshotId, 'PROCESSING_SNAPSHOT_ID');
  return { ...(record.productRef ? { productRef: record.productRef as WfdRecord } : {}), ...(record.declaration ? { declaration: record.declaration as WfdRecord } : {}),
    ...(record.expectedSnapshotId !== undefined ? { expectedSnapshotId: record.expectedSnapshotId as string | null } : {}) };
}
function readCoverage(value: unknown): { complete: boolean; gaps: string[]; scope: string } {
  const record = readRecord(value, ['complete', 'gaps', 'scope'], 'PROCESSING_COVERAGE');
  if (typeof record.complete !== 'boolean' || !Array.isArray(record.gaps) || record.gaps.some(item => typeof item !== 'string')
    || typeof record.scope !== 'string') fail('PROCESSING_COVERAGE', '覆盖声明须有完整性、缺口和范围。');
  return { complete: record.complete, gaps: record.gaps as string[], scope: record.scope as string };
}
function decodeText(bytes: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}
function locate(text: string, start: number, end: number): Pick<MaterialLocation, 'start' | 'end' | 'line' | 'column'> {
  let line = 1, lineStart = 0;
  for (let index = 0; index < start; index++) if (text[index] === '\n') { line++; lineStart = index + 1; }
  return { start, end, line, column: start - lineStart + 1 };
}
function withoutVolatile<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item) => key === 'observedAt' ? undefined : item)) as T;
}
function parseJson<T = unknown>(value: string): T { try { return JSON.parse(value) as T; } catch { fail('PROCESSING_JSON', '持久记录不是有效 JSON。'); } }
function json(value: unknown): JsonValue { return JSON.parse(canonicalWfdJson(value)) as JsonValue; }
function asJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function fail(code: string, message: string): never { throw new TaskError(code, message); }
function isStopError(error: unknown): boolean {
  return error instanceof TaskError && ['TASK_NOT_ACTIVE', 'SERVICE_STOPPED', 'TASK_STOPPED'].includes(error.code)
    || error instanceof Error && error.name === 'AbortError';
}
function isBudgetError(error: unknown): boolean {
  return error instanceof TaskError && /BUDGET|DEADLINE/u.test(error.code);
}
