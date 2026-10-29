/** 接收类别固定在原件身份上；unclassified 不代表用户声明了数据或工具用途。 */
export type MaterialCategory = 'unclassified' | 'data' | 'tool';
export type MaterialEnvironment = 'local-review' | 'synthetic-test';
export type MaterialFormat = 'csv' | 'json-table' | 'text' | 'excel' | 'pdf' | 'image' | 'audio' | 'video' | 'archive' | 'unknown';
export type MaterialSupport = 'supported' | 'needs_adapter' | 'unsupported';
export type MaterialSemanticKey = 'field' | 'unit' | 'currency' | 'period' | 'adjustment' | 'timeAvailability'
  | 'methodName' | 'parameters' | 'dependencies' | 'version' | 'source';
export interface MaterialLimits {
  maxBytes: number;
  maxCharacters: number;
  maxRows: number;
  maxColumns: number;
  maxCellCharacters: number;
  maxPreviewRows: number;
  maxChanges: number;
}
export interface MaterialLocation {
  /** 原文 UTF-16 字符偏移为 0 基；行、列为 1 基；end 为开区间。 */
  start: number;
  end: number;
  line: number;
  column: number;
  row?: number;
  field?: number;
  jsonPath?: string;
}
export interface MaterialEvidence {
  source: 'original' | 'user-declaration';
  quote: string;
  location?: MaterialLocation;
  declarationIndex?: number;
}
export interface MaterialDeclaration {
  key: Exclude<MaterialSemanticKey, 'field'>;
  value: string;
  scope?: string;
  statement: string;
}
export interface MaterialSemantic {
  key: MaterialSemanticKey;
  scope?: string;
  status: 'candidate' | 'unknown' | 'conflict';
  candidates: { value: string; evidence: MaterialEvidence[] }[];
}
export type MaterialScalar = string | boolean | null;
export interface MaterialCell {
  /** JSON 数字保留精确原文字面量字符串，不转换浮点数。 */
  sourceType: 'string' | 'number' | 'boolean' | 'null' | 'missing';
  original: MaterialScalar;
  proposed: MaterialScalar;
  location: MaterialLocation;
  quote: string;
}
export interface MaterialColumn {
  name: string;
  proposedName: string;
  location: MaterialLocation;
  quote: string;
}
export interface MaterialTable {
  columns: MaterialColumn[];
  rows: MaterialCell[][];
  totalRows: number;
  previewTruncated: boolean;
}
export interface MaterialChange {
  operation: 'trim' | 'empty_to_null' | 'align_missing_key';
  original: MaterialScalar;
  proposed: MaterialScalar;
  location: MaterialLocation;
  reason: string;
}
export interface MaterialIssue { code: string; message: string; location?: MaterialLocation }
export interface MaterialPreview {
  category: MaterialCategory;
  format: MaterialFormat;
  support: MaterialSupport;
  reason: string;
  adapter: { id: string; version: string } | null;
  source: { encoding: 'utf-8'; byteOrderMark: boolean; characterCount: number; lineCount: number; positionUnit: 'UTF-16' } | null;
  table: MaterialTable | null;
  text: { original: string; proposed: string } | null;
  semantics: MaterialSemantic[];
  cleaning: { applied: false; changes: MaterialChange[]; totalChanges: number; changesTruncated: boolean };
  checks: { status: 'preview_only' | 'needs_confirmation' | 'blocked'; issues: MaterialIssue[] };
  limitations: string[];
  pending: string[];
}
export interface MaterialEnvelope {
  materialId: string;
  taskId: string;
  category: MaterialCategory;
  environment: MaterialEnvironment;
  filename: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  version: 1;
  fileRefId: string;
  fileRefVersion: number;
  inspectorVersion: string;
  adapter: { id: string; version: string } | null;
  createdAt: number;
  localOnly: true;
}
export interface MaterialRecord { envelope: MaterialEnvelope; preview: MaterialPreview }
export interface MaterialSubmitInput {
  fileRefId: string;
  category: MaterialCategory;
  mediaType?: string;
  expectedSha256?: string;
  declaredMetadata?: MaterialDeclaration[];
}
export interface MaterialCapability { category: MaterialCategory; format: MaterialFormat }
export interface MaterialAdapterDefinition { id: string; version: string; capabilities: readonly MaterialCapability[] }
/** 适配器由受信宿主装配；上传材料不能登记或执行适配器。 */
export interface MaterialParserAdapter extends MaterialAdapterDefinition {
  parse(input: { text: string; limits: MaterialLimits }): { table?: MaterialTable; text?: { original: string; proposed: string }; changes?: MaterialChange[] };
}
export interface MaterialInspectionInput {
  category: MaterialCategory;
  filename: string;
  mediaType?: string;
  declaredMetadata?: MaterialDeclaration[];
  limits?: Partial<MaterialLimits>;
  adapters?: readonly MaterialParserAdapter[];
}
