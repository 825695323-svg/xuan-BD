/** 文档片段化的类型契约；规则见《4.2-文档片段化实现契约-v1》。 */

export const SEGMENT_SCHEMA = 'bd.doc-segment/1';
export const SEGMENTER_VERSION = 'bd.segmenter/1';
export const SEGMENT_TOKENIZER = 'cjk-bigram+unicode61-v1';

export type SegmentKind = 'paragraph' | 'table';

export interface SegmentBBox { x0: number; y0: number; x1: number; y1: number }

export interface TableCell { cell_ref: string; text: string; x0: number; x1: number }
export interface TableRow { row: number; label: string | null; cells: TableCell[] }
export interface SegmentTable {
  table_id: string;
  part: number;
  parts: number;
  header: string[];
  /** 表头首格之外的原样文本；不推断年份语义。 */
  period_axis: string[];
  rows: TableRow[];
  row_count: number;
  cell_count: number;
  verification: 'unverified-geometry';
  /** 单位不推断；缺失即 null 并置缺口码。 */
  unit: null;
  /** 表头上方相邻行的文本（未确认、可能是跨行表头的另一半）；无则 null。 */
  header_adjacent: string[] | null;
}

export interface DocSegment {
  segment_id: string;
  document_id: string;
  document_version: string;
  parser_version: string;
  ordinal: number;
  kind: SegmentKind;
  page_number: number;
  page_label: string | null;
  section_path: string[];
  bbox: SegmentBBox;
  table: SegmentTable | null;
  source_ref: string;
  text: string;
  text_digest: string;
  char_start: number;
  char_end: number;
  issues: string[];
}

/** 片段生成输入：只取 PDf 抽取已给出的原生项与几何候选，不重新做版面推断。 */
export interface PdfItemInput { index: number; text: string; x: number; y: number; width: number; height: number; endOfLine: boolean }
export interface PdfCellInput { x: number; endX: number; text: string; itemIndexes: number[] }
export interface PdfRowInput { row: number; baselineY: number; cells: PdfCellInput[] }
export interface PdfPageInput {
  page: number;
  pageLabel: string | null;
  width: number;
  height: number;
  items: PdfItemInput[];
  tableCandidates: PdfRowInput[];
}

export interface SegmentBuildInput {
  documentId: string;
  documentVersion: string;
  parserVersion?: string;
  sourceRef: string;
  pages: PdfPageInput[];
}

export interface SegmentBuildResult {
  segments: DocSegment[];
  /** 各片段 text 按 ordinal 以换行连接；char_start/char_end 以此为坐标。 */
  fullText: string;
  /** 文档级缺口（如整页无文字层），不对应任何片段。 */
  documentIssues: { code: string; page: number; detail?: string }[];
}

export interface SearchHit { segment: DocSegment; matched: 'keyword' | 'exact'; score?: number }

// ── 检索接口合同（2026-11-03 v2：时间适用性 + 双历史资格） ────────────────────

/** 结果合同版本；v1 → v2 只增字段与显式模式，默认行为仍为严格系统持有。 */
export const SEGMENT_RETRIEVAL_SCHEMA = 'bd.doc-retrieval/2';

/**
 * 一个时间维度的三种状态：
 * - `known`：有明确时间（可带精度）；
 * - `unknown`：应有时间但无法确定；
 * - `not_applicable`：该类型文档本来就不需要这类时间，**不作为可见性门槛**。
 *
 * 把 `not_applicable` 并入 `unknown` 会让“没有业务事件时间”的财报永久不可见。
 */
export type TimeDimensionState = 'known' | 'unknown' | 'not_applicable';
export type TimePrecision = 'datetime' | 'date' | 'month' | 'quarter' | 'year';

export interface TimeDimension {
  state: TimeDimensionState;
  /** 仅 `known` 时为毫秒时间戳（区间起点）；其余为 null。 */
  value: number | null;
  /** 精度：`date`/`month`/`quarter`/`year` 表示这是区间而非瞬时。 */
  precision: TimePrecision | null;
  /**
   * 精度区间的**末端**（毫秒）。可见性一律与它比较，避免把“2024 年 1 月”
   * 当成 1 月 1 日零点就已公开。非 `known` 为 null。
   */
  upper: number | null;
}

export const UNKNOWN_TIME: TimeDimension = Object.freeze({ state: 'unknown', value: null, precision: null, upper: null });
export const NOT_APPLICABLE_TIME: TimeDimension = Object.freeze({ state: 'not_applicable', value: null, precision: null, upper: null });

/** 文档版本的时间记录。原件摘要与产物摘要分别保存，互不替代。 */
export interface DocumentTimeRecord {
  document_id: string;
  document_version: string;
  parser_version: string;
  /** 已登记转换产物引用（structured-conversion 的 fileRefId）。 */
  artifact_ref: string;
  /** 已登记产物的字节摘要（派生件自身身份）。 */
  artifact_sha256: string;
  /** 原件内容摘要；用于核对片段化输入与 4.3 保管材料是同一份字节。 */
  origin_sha256: string;
  /** BD 取得时间（材料受理时间）。 */
  acquired_at: number;
  /** 业务/事件时间；财报常为报告期，研报可 not_applicable。 */
  event_time: TimeDimension;
  /** 首次合格公开时间（披露/发布）。 */
  disclosed_at: TimeDimension;
  /** 本次解析（片段生成）时间。 */
  parsed_at: number;
  page_count: number;
  segment_count: number;
  issues: string[];
}

/** 两种历史资格互不替代：市场当时可得 ≠ 本系统当时持有。 */
export type RetrievalHistoryMode = 'system_held_at' | 'market_known_at';

export type RetrievalExclusionReason = 'not_yet_acquired' | 'not_yet_parsed'
  | 'event_time_unknown' | 'event_time_after_as_of'
  | 'disclosure_time_unknown' | 'disclosure_time_not_applicable' | 'disclosed_after_as_of'
  /** 同文档的后续版本在目标时点之后才发布：旧版本可答，新版本不答。 */
  | 'superseded_by_revision'
  /** 多版本无法按披露时间排序：整份排除，不猜哪个是当时版本。 */
  | 'version_order_unresolved';

export interface RetrievalExclusion { document_id: string; document_version: string; reason: RetrievalExclusionReason }

export interface RetrievalQualification {
  mode: RetrievalHistoryMode;
  /** 本次是否真的施加了时间门（未给 `as_of` 时为 false）。 */
  applied: boolean;
  /** 用后来生成的索引回答历史公开时点：明确标识为事后重建。 */
  reconstruction: 'none' | 'post_hoc';
  index_built_at: number | null;
}

/**
 * 结果状态只描述本次查询实际能证明的事；4.3 §8.5 要求的“权限收紧/歧义/解析失败”
 * 本轮没有对应数据来源，不伪造，另在 coverage 与 gaps 里如实报告。
 */
export type SegmentRetrievalStatus = 'matched' | 'no_match' | 'index_missing' | 'history_unavailable';

export interface RetrievalCoverage {
  index_version: string | null;
  index_built_at: number | null;
  indexed_segments: number;
  indexed_documents: number;
  /** 已登记但整份没有文字层的文档数（0 片段）。 */
  documents_without_text_layer: number;
  as_of: number | null;
  excluded: RetrievalExclusion[];
}

export interface RetrievalCitation {
  segment_id: string;
  document_id: string;
  document_version: string;
  parser_version: string;
  ordinal: number;
  kind: SegmentKind;
  page_number: number;
  page_label: string | null;
  section_path: string[];
  bbox: SegmentBBox;
  /** 表格定位：分片范围与首末单元格引用；段落为 null。 */
  table: { table_id: string; part: number; parts: number; header: string[]; period_axis: string[];
    unit: null; verification: 'unverified-geometry'; first_cell_ref: string | null; last_cell_ref: string | null } | null;
  excerpt: string;
  excerpt_truncated: boolean;
  text_digest: string;
  char_start: number;
  char_end: number;
  artifact_ref: string;
  index_version: string;
  issues: string[];
}

export interface SegmentRetrievalResult {
  schema: typeof SEGMENT_RETRIEVAL_SCHEMA;
  /** 结构化侧（HB-02）尚未接线；恒为 null，不用空对象冒充。 */
  structured: null;
  status: SegmentRetrievalStatus;
  query: { method: 'keyword' | 'exact'; text: string; as_of: string | null };
  qualification: RetrievalQualification;
  citations: RetrievalCitation[];
  coverage: RetrievalCoverage;
  gaps: string[];
}

// ── 4.3 证据账本：材料 ↔ 转换产物（一对多） ──────────────────────────────

/** 可进入片段与索引的转换产物类型；其余（页图/媒体/字幕/归档）只登记不入索引。 */
export const SEGMENTABLE_ARTIFACT_TYPES = ['conversion.document', 'pdf.extract'] as const;
export const REGISTRABLE_ARTIFACT_TYPES = [...SEGMENTABLE_ARTIFACT_TYPES, 'conversion.structured',
  'conversion.inspect', 'conversion.subtitle', 'conversion.archive', 'conversion.pdf_render', 'conversion.image',
  'conversion.media'] as const;

export type ArtifactProcessingStatus = 'registered' | 'segmented' | 'rejected';

/**
 * 一条材料 → 产物登记。同一份材料可以有多个产物（文本、结构化、页图、不同解析器版本），
 * 关系保留历史，不做“只留最新一条”。
 */
export interface ConversionArtifactRecord {
  artifact_record_id: string;
  material_id: string;
  material_version: string;
  /** 原件摘要（登记时按 4.3 保管材料冻结）。 */
  material_sha256: string;
  /** 产生该产物的转换运行身份：任务 id（无任务时为 `direct:<action>`）。 */
  conversion_run_id: string;
  artifact_ref: string;
  artifact_type: string;
  /** 产物字节摘要，与原件摘要分别保存。 */
  artifact_sha256: string;
  artifact_bytes: number;
  /** 产物自己声明的实现版本（如 pdfjs）。 */
  parser_version: string | null;
  /** 产物自称的源摘要，用于核对与原件一致。 */
  declared_source_sha256: string | null;
  processing_status: ArtifactProcessingStatus;
  created_at: number;
}

export const SEGMENT_ISSUES = {
  sectionUnavailable: 'section_unavailable',
  tableGeometryUnverified: 'table_geometry_unverified',
  tableUnitNotExtracted: 'table_unit_not_extracted',
  tableContinuedSuspected: 'table_continued_suspected',
  tableLineOverlap: 'table_line_overlap',
  pageTextLayerIncomplete: 'page_text_layer_incomplete',
  /** 连续候选段首行是数据行：不伪造表头，全部按数据行处理。 */
  tableHeaderNotFound: 'table_header_not_found',
  /** 上方相邻行可能是表头另一半，未确认，单独保留不并入期间轴。 */
  tableHeaderAdjacentUnverified: 'table_header_adjacent_unverified',
  /** 单独成段的短数字/页码类文本：保留原样，标为检索可降权的候选，不删除。 */
  isolatedShortLine: 'isolated_short_line',
  /** 业务/事件时间应有时但无法确定：历史时点查询不能算作可见。 */
  eventTimeUnknown: 'event_time_unknown',
  /** 首次合格公开时间应有时但无法确定：同上。 */
  disclosureTimeUnknown: 'disclosure_time_unknown',
  /** 该类文档不需要业务/事件时间：不构成可见性门槛。 */
  eventTimeNotApplicable: 'event_time_not_applicable',
  /** 该类文档不需要公开时间：不构成可见性门槛，但市场公开模式无法据此成立。 */
  disclosureTimeNotApplicable: 'disclosure_time_not_applicable',
} as const;
