/** 逻辑请求独立于股票操作目录；实际网络权限和注册能力由来源端口校验。 */
export interface AcquisitionRequest {
  scopeId: string;
  operationId: string;
  subjectId: string | null;
  start: string | null;
  end: string | null;
  adjustment: string | null;
  statement?: string;
  encodeUrl?: string;
}

const statements = ['income', 'balance_sheet', 'cash_flow'] as const;
export type FinancialStatement = typeof statements[number];
export function isFinancialStatement(value: unknown): value is FinancialStatement {
  return statements.some(statement => statement === value);
}
export function isReportEncodeUrl(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/u.test(value);
}
export interface AcquisitionBinding { providerId: string; connectionId: string; configurationDigest: string }
export interface AcquisitionOriginal { fileRefId: string; sha256: string }
export interface AcquisitionPage {
  cursor: string | null;
  /** undefined 为未声明，null 才表示明确结束。 */
  nextCursor?: string | null;
  original: AcquisitionOriginal;
  rowCount: number;
  keys: string[];
}
export interface AcquisitionCheckpoint {
  version: 'bd.source-acquisition/1';
  request: AcquisitionRequest;
  requestKey: string;
  binding: AcquisitionBinding;
  budget: { maxPages: number; maxRows: number };
  pages: AcquisitionPage[];
}
export interface AcquisitionCoverage {
  requestKey: string;
  expectedKeys: string[];
  evidence: AcquisitionOriginal;
}
export type AcquisitionOutcome = 'data' | 'confirmed_empty' | 'not_ready' | 'failed'
  | 'no_permission' | 'unsupported_history' | 'undetermined';
export interface AcquisitionReview {
  requestKey: string;
  outcome: AcquisitionOutcome;
  rowCount: number | null;
  coverage: {
    state: 'not_established' | 'incomplete' | 'declared_scope_complete' | 'conflict';
    missingKeys: string[];
    unexpectedKeys: string[];
    duplicateKeys: string[];
    evidence: AcquisitionOriginal | null;
  };
  continuation: { state: 'available' | 'finished' | 'unknown' | 'budget_exhausted' | 'blocked'; cursor: string | null };
  gaps: { code: string; reason: string }[];
  returnTo: 'agents';
  publication: 'not_requested';
}
export interface SourceReceiptReview {
  requestKey: string;
  outcome: 'data' | 'undetermined';
  coverageState: 'not_established';
  continuation: 'not_declared';
  returnTo: 'agents';
  publication: 'not_requested';
}
