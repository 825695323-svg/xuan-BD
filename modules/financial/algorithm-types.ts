import type { JsonValue } from '../../contracts/task-contracts.js';
import type { EligibilityHistoryMode, FixedObjectEvidence, HoldingTimeEvidence, PublicationTimeEvidence, PurposeEligibilityResult,
  PurposeEvidenceClaim, RestrictionEvidence, RevisionEvidence, WfdDecisionEvidence, WfdHistorySupportEvidence } from '../collection/purpose-eligibility.js';

/** 本模块登记固定 12/26/9 MACD 与 WFD 输入合同。 */
export const ALGORITHM_CONTRACT_VERSION = 'bd-local-algorithms/1';
export const ALGORITHM_RUNTIME = 'bd.algorithms';
export const ALGORITHM_CALL_ACTION = 'algorithms.calculate';
export const ALGORITHM_INPUT_ADAPTER_VERSION = 'wfd-fixed-snapshot/1';
export const ALGORITHM_METHOD_IDS = ['macd'] as const;
export type AlgorithmMethodId = typeof ALGORITHM_METHOD_IDS[number];
export type AlgorithmEnvironment = 'local-review' | 'synthetic-test';
export type AlgorithmMethodStatus = 'ready' | 'blocked' | 'unavailable';
export type AlgorithmDateFormats = 'YYYY-MM-DD' | 'YYYY/MM/DD' | 'YYYYMMDD';
export type AlgorithmAdjustment = 'unadjusted' | 'as_stored';

export const ALGORITHM_METHODS = Object.freeze({
  macd: { operation: 'MACD', kind: 'indicator', version: 'macd/12-26-9-first-valid-v1', field: 'MACD',
    title: 'MACD · 固定 12/26/9',
    description: '调用既有 12/26/9 MACD 实现，以所供窗口首条收盘价初始化短、长 EMA 与 DEA；返回 DIFF、DEA、MACD 和 ZERO。',
    source: 'plugins/financial/local-compute/assets/indicators.py: MACD; operators.py: smooth',
    reference: '独立 EMA/DEA 递推核对；首值初始化，不补窗口前历史',
    requiredFields: ['timestamp', 'close'], outputFields: ['DIFF', 'DEA', 'MACD', 'ZERO'],
    limitations: ['仅按所供连续观测做首值初始化递推；不含窗口之前历史，不能视为完整历史 MACD。', '不接受递推状态续算、不补历史、不自动入库。'] },
} as const);

export type AlgorithmMethodDefinition = typeof ALGORITHM_METHODS[AlgorithmMethodId];

export interface AlgorithmFieldMapping {
  timestamp: string;
  close: string;
  open?: string;
  high?: string;
  low?: string;
  available_at?: string;
}

export interface AlgorithmSemantics {
  /** 用户明确填写的标的或序列名称；不从文件名推断证券身份。 */
  subject: string;
  frequency: '1d';
  timezone: string;
  priceUnit: 'currency_per_share';
  currency: string;
  adjustment: AlgorithmAdjustment;
  adjustmentBasis: string;
  barClosed: true;
  /** 全部所供观测均为已生成/合成测试数据时必须显式声明。 */
  synthetic: boolean;
  /** 逐行可得时刻，或用户明确声明的收盘后可得时刻；未提供即拒绝。 */
  availability: { kind: 'column' } | { kind: 'bar_close'; closeTime: string };
}

export type AlgorithmCalendar =
  | { mode: 'dense' }
  | { mode: 'declared'; expectedDates: string[] }
  | { mode: 'not_verified'; note: string };

export interface AlgorithmManagedTableSource {
  kind: 'managed_table';
  materialId: string;
  materialSha256: string;
  format: 'csv' | 'json';
  fieldMapping: AlgorithmFieldMapping;
  dateFormat?: AlgorithmDateFormats;
  semantics: AlgorithmSemantics;
  calendar: AlgorithmCalendar;
  /** 可选明确切片；缺省表示用户显式选择的整张受管表。 */
  range?: { start: string; end: string };
}

/**
 * 真实 WFD `wfd.data-service/v1` 固定快照引用。
 *
 * 只固定实际 `data.read` 能核对的实例、产品、具体快照与定义修订；不出现旧
 * `outputIdentity/unitId/schemaRevision` 假字段。分页由端口按 `next_cursor` 读取并校验
 * `rows_sha256`、`row_count`、字段集与提交身份，不能使用 latest 或隐式扩围。
 */
export interface AlgorithmSnapshotReference {
  kind: 'wfd_fixed_snapshot';
  instanceId: string;
  productId: string;
  snapshotId: string;
  definitionRevision: string;
  /** 实际 data.read 请求字段；必须覆盖 fieldMapping 与 availability 所需列。 */
  fields: string[];
  fieldMapping: AlgorithmFieldMapping;
  dateFormat?: AlgorithmDateFormats;
  semantics: AlgorithmSemantics;
  calendar: AlgorithmCalendar;
  range?: { start: string; end: string };
  /** 历史请求必须显式指定的现有 WFD 视角与实际截止；缺省只读快照内容。 */
  perspective?: EligibilityHistoryMode;
  at?: string;
  includeHistory?: boolean;
  /** system_held_at 必须显式固定的实例持有范围与可用阶段。 */
  heldScope?: string;
  usableStage?: 'acquired' | 'custodied' | 'published_readable';
  /** 可选现场核对摘要；实际页仍逐页核对并在封闭输入中记录解析后的真实摘要。 */
  expectedRowsSha256?: string;
  expectedRowCount?: number;
  expectedDefinitionSha256?: string;
  contractDigest?: string;
}

export interface AlgorithmFixedSnapshotSource {
  kind: 'fixed_snapshot';
  reference: AlgorithmSnapshotReference;
}

export type AlgorithmSource = AlgorithmManagedTableSource | AlgorithmFixedSnapshotSource;

export type AlgorithmParameters = { short_period: 12; long_period: 26; signal_period: 9; init: 'first_valid' };

export interface AlgorithmUsage {
  /** 只接受本机算法当前内容或历史计算两类；发布资格不属于本算法入口。 */
  purpose: 'current_compute' | 'historical_compute';
  /** 历史计算必须显式选择现有 WFD 历史模式并固定截止；当前计算保持 null。 */
  historyMode: EligibilityHistoryMode | null;
  cutoff: string | null;
  perspective: string | null;
  /** 由受信提交上下文写入，不接受请求正文自报。 */
  purposeEvidence?: PurposeEvidenceClaim[];
}

/** 真实提交来源：HTTP 操作者或受信会话宿主核对过的用户消息；模型不能自报。 */
export type AlgorithmSubmissionContext =
  | { authority: 'operator-http'; requestId: string; observedAtUtc: string }
  | { authority: 'user-message'; messageId: string; quote: string; observedAtUtc: string };

export interface AlgorithmCallRequest {
  methodId: AlgorithmMethodId;
  parameters: AlgorithmParameters;
  source: AlgorithmSource;
  /** 缺省保持原有当前内容计算能力，不自动提升历史资格。 */
  usage?: AlgorithmUsage;
}

export interface AlgorithmMetadata {
  series_id: string;
  subject: string;
  frequency: '1d';
  timezone: string;
  price_unit: 'currency_per_share';
  currency: string;
  adjustment: AlgorithmAdjustment;
  adjustment_basis: string;
  window_start: string;
  window_end: string;
  as_of: string;
  availability_basis: 'explicit_per_bar' | 'declared_bar_close';
  bar_closed: true;
  /** 只表示所供序列自身连续；不把未核对的交易日历说成完整。 */
  observations_are_consecutive: true;
  calendar_verification: 'dense' | 'declared' | 'not_verified';
  synthetic: boolean;
}

export interface AlgorithmBar {
  timestamp: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
  available_at: string;
  bar_closed: true;
}

export interface AlgorithmData { metadata: AlgorithmMetadata; rows: AlgorithmBar[] }

export interface AlgorithmSnapshotRead {
  /** 受信宿主实际核对的连接身份摘要，不接受调用者声明。 */
  connectionIdentityDigest?: string;
  /** 必须与请求逐字段相同；不接受 latest 或扩围。 */
  reference: AlgorithmSnapshotReference;
  /** data.read 返回的 JSON 行；由算法服务按显式字段映射与语义转成封闭输入。 */
  rows: Record<string, JsonValue>[];
  /**
   * 产品/快照/定义/分页/摘要解析证据；不含重复行。`rowsSha256` 始终是服务端完整行资源摘要，
   * `projection.sha256` 才是本地对选定字段的重算结果，二者不可互相冒充。
   */
  resolution: JsonValue;
  /**
   * 本次读取实际完成的验证范围：仅当请求字段覆盖全部声明字段时才在本地重算完整行资源，
   * 否则只核对服务端身份/descriptor 并单独证明本地投影摘要。
   */
  verifiedScope: 'server_identity_descriptor_and_projection' | 'server_identity_descriptor_and_full_rows';
  /** 逐行实际 WFD 资格/公开时间/修订/限制证据；与 rows 同序，供共用规则消费。 */
  evidence?: AlgorithmSnapshotRowEvidence[];
}

export interface AlgorithmSnapshotRowEvidence {
  object: FixedObjectEvidence;
  publicationTime: PublicationTimeEvidence;
  holdingTime: HoldingTimeEvidence | null;
  revision: RevisionEvidence | null;
  wfdHistory: WfdHistorySupportEvidence;
  restriction: RestrictionEvidence;
  wfdDecision: WfdDecisionEvidence | null;
}

/** 真实 `wfd.data-service/v1` 固定快照只读端口。 */
export interface AlgorithmSnapshotPort {
  status(): { status: 'available' | 'unavailable'; reason: string | null };
  read(reference: AlgorithmSnapshotReference, context: { signal: AbortSignal; taskId?: string }): Promise<AlgorithmSnapshotRead>;
}

export interface AlgorithmInvalidInterval { start: string; end: string; reason: 'insufficient_history' | 'insufficient_warmup'; count: number }
export interface AlgorithmGap { code: string; message: string; scope?: string }

export interface AlgorithmResultRow { timestamp: string; available_at: string; [field: string]: JsonValue }

export interface AlgorithmComputedResult {
  status: 'computed';
  persistence: 'not_requested';
  publication: { state: 'not_requested'; performed: false };
  environment: AlgorithmEnvironment;
  taskId: string;
  methodId: AlgorithmMethodId;
  methodVersion: string;
  contractVersion: string;
  implementationVersion: string;
  parameters: JsonValue;
  metadata: AlgorithmMetadata;
  source: JsonValue;
  inputDigest: string;
  rows: AlgorithmResultRow[];
  validInterval: { start: string; end: string } | null;
  invalidIntervals: AlgorithmInvalidInterval[];
  coverage: { suppliedRows: number; validRows: number; leadingInvalidRows: number; windowStart: string; windowEnd: string };
  diagnostics: JsonValue[];
  gaps: AlgorithmGap[];
  method: JsonValue;
  limitations: string[];
  /** 使用边界实际执行的共用用途资格：输入冻结后、结果形成后分别保留。 */
  eligibility: { input: PurposeEligibilityResult; result: PurposeEligibilityResult } | null;
  /** 实际执行完成时间；历史回放不得倒填为截止前已存在。 */
  computedAt: string;
  externalActionExecuted: false;
}

export interface AlgorithmMethodView {
  id: AlgorithmMethodId;
  title: string;
  description: string;
  status: AlgorithmMethodStatus;
  reason: string | null;
  methodVersion: string;
  implementationVersion: string;
  parameters: JsonValue;
  requiredFields: string[];
  outputFields: string[];
  limitations: string[];
  methodEvidence: JsonValue;
}

export interface AlgorithmAdoptionRecord {
  version: 1;
  environment: AlgorithmEnvironment;
  assetsVersion: string;
  codeVersion: string;
  codeFiles: Record<string, string>;
  fileHashes: Record<string, string>;
  pythonDigest: string;
  assetsRoot: string;
  adoptedAt: string;
}
export interface AlgorithmAdoptionView {
  state: 'adopted' | 'not_adopted' | 'stale';
  reason: string | null;
  current: { environment: AlgorithmEnvironment; assetsVersion: string; codeVersion: string; pythonDigest: string };
  record: AlgorithmAdoptionRecord | null;
  required: { environment: 'local-review'; expectedAssetsVersion: string; expectedCodeVersion: string; confirmation: 'adopt-local-review' };
}

export interface AlgorithmCatalogView {
  contractVersion: string;
  runtime: string;
  environment: AlgorithmEnvironment;
  status: 'available' | 'unavailable';
  enabled: boolean;
  reason: string | null;
  adoption: AlgorithmAdoptionView;
  implementation: { version: string; files: Record<string, string>; codeVersion: string; codeFiles: Record<string, string>;
    binding: 'source-code'; bindingRequired: false };
  execution: { pythonDigest: string | null; permission: 'granted' | 'approval_required' | 'unavailable'; reason: string | null };
  methods: AlgorithmMethodView[];
  inputs: {
    managedTables: { status: 'unavailable'; reason: string | null; items: [] };
    fixedSnapshots: { status: 'available' | 'unavailable'; reason: string | null; contract: JsonValue };
  };
  limitations: string[];
}

export interface AlgorithmTaskError { code: string; message: string }
export interface AlgorithmTaskView {
  taskId: string;
  requestId: string;
  methodId: AlgorithmMethodId;
  status: string;
  taskVersion: number;
  requiresReview: boolean;
  createdAt: string;
  updatedAt: string;
  result: AlgorithmComputedResult | null;
  error: AlgorithmTaskError | null;
  publication: { state: 'not_requested' };
  guidance: string | null;
}
