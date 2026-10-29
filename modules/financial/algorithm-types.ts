import type { JsonValue } from '../../contracts/task-contracts.js';

/** 本模块只服务当前已有的 MA、固定 12/26/9 MACD 和严格看涨吞没；不扩成通用工具平台。 */
export const ALGORITHM_CONTRACT_VERSION = 'bd-local-algorithms/1';
export const ALGORITHM_RUNTIME = 'harness.algorithms';
export const ALGORITHM_CALL_ACTION = 'algorithms.calculate';
export const ALGORITHM_TABLE_ADAPTER_VERSION = 'managed-material-table/1';
export const ALGORITHM_METHOD_IDS = ['ma', 'macd', 'bullish_engulfing'] as const;
export type AlgorithmMethodId = typeof ALGORITHM_METHOD_IDS[number];
export type AlgorithmEnvironment = 'local-review' | 'synthetic-test';
export type AlgorithmMethodStatus = 'ready' | 'blocked' | 'unavailable';
export type AlgorithmDateFormats = 'YYYY-MM-DD' | 'YYYY/MM/DD' | 'YYYYMMDD';
export type AlgorithmAdjustment = 'unadjusted' | 'as_stored';

export const ALGORITHM_METHODS = Object.freeze({
  ma: { operation: 'MA', kind: 'indicator', version: 'ma/full-window-v1', field: 'MA',
    title: 'MA · 算术移动均线',
    description: '调用既有 MA 实现，按明确提供的有序日线收盘价计算完整窗口算术平均；前置观测不足保留为空。',
    source: 'plugins/financial/local-compute/assets/indicators.py: MA',
    reference: '独立算术平均；窗口不足不补零、不前向填充',
    requiredFields: ['timestamp', 'close'], outputFields: ['MA'],
    limitations: ['周期按所供有序观测计数；未提供交易所日历时不声称完整交易日覆盖。', '不做复权、不补历史、不自动入库；结果只是本地计算候选。'] },
  macd: { operation: 'MACD', kind: 'indicator', version: 'macd/12-26-9-first-valid-v1', field: 'MACD',
    title: 'MACD · 固定 12/26/9',
    description: '调用既有 12/26/9 MACD 实现，以所供窗口首条收盘价初始化短、长 EMA 与 DEA；返回 DIFF、DEA、MACD 和 ZERO。',
    source: 'plugins/financial/local-compute/assets/indicators.py: MACD; operators.py: smooth',
    reference: '独立 EMA/DEA 递推核对；首值初始化，不补窗口前历史',
    requiredFields: ['timestamp', 'close'], outputFields: ['DIFF', 'DEA', 'MACD', 'ZERO'],
    limitations: ['仅按所供连续观测做首值初始化递推；不含窗口之前历史，不能视为完整历史 MACD。', '不接受递推状态续算、不补历史、不自动入库。'] },
  bullish_engulfing: { operation: 'bullish_engulfing', kind: 'pattern', version: 'bullish-engulfing/strict-v1', field: 'bullish_engulfing',
    title: '严格看涨吞没',
    description: '调用既有严格实体吞没规则：前一条为阴线、当前为阳线，且当前实体严格包含前一条实体；缺少前一条观测时为空值。',
    source: 'plugins/financial/local-compute/assets/patterns.py: bullish_engulfing',
    reference: '严格开收盘实体包含；不把缺失当未命中',
    requiredFields: ['timestamp', 'open', 'close'], outputFields: ['bullish_engulfing'],
    limitations: ['只判断所供相邻日线的开盘价和收盘价；不补历史、不做交易解释。', '形态真假不构成交易建议；不自动入库。'] },
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

export type AlgorithmParameters =
  | { period: number }
  | { short_period: 12; long_period: 26; signal_period: 9; init: 'first_valid' }
  | Record<string, never>;

export interface AlgorithmCallRequest {
  methodId: AlgorithmMethodId;
  parameters: AlgorithmParameters;
  source: AlgorithmSource;
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
}

/** 真实 `wfd.data-service/v1` 固定快照只读端口。 */
export interface AlgorithmSnapshotPort {
  status(): { status: 'available' | 'unavailable'; reason: string | null };
  read(reference: AlgorithmSnapshotReference, context: { signal: AbortSignal; taskId?: string }): Promise<AlgorithmSnapshotRead>;
}

export interface ManagedTableCell { type: 'string' | 'number' | 'boolean' | 'null' | 'missing'; value: string | boolean | null }
export interface ManagedTableRow { values: ManagedTableCell[] }

export interface ManagedTableSummary {
  materialId: string;
  displayName: string;
  format: 'csv' | 'json';
  sha256: string;
  rowCount: number;
  columns: string[];
  createdAt: number;
}

export interface ManagedTableData extends ManagedTableSummary {
  rows: ManagedTableRow[];
}

/** 已受管材料只读端口；按材料身份读取，不按任意路径扫描。 */
export interface ManagedTableReader {
  list(limit?: number): ManagedTableSummary[];
  read(materialId: string): ManagedTableData;
}

export interface AlgorithmInvalidInterval { start: string; end: string; reason: 'insufficient_history' | 'insufficient_warmup'; count: number }
export interface AlgorithmGap { code: string; message: string; scope?: string }

export interface AlgorithmResultRow { timestamp: string; available_at: string; [field: string]: JsonValue }

export interface AlgorithmComputedResult {
  status: 'computed';
  persistence: 'not_requested';
  publication: { state: 'not_requested'; route: 'existing_generic_candidate_service'; performed: false };
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
    managedTables: { status: 'available' | 'unavailable'; reason: string | null; items: ManagedTableSummary[] };
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
