import type { SourceCandidateFeedback } from './source-settings.js';

/** 只描述逻辑请求和已有证据，不授予来源权限或正式发布资格。 */
export type AcquisitionRequest = SourceCandidateFeedback['logicalRequest'];
export interface AcquisitionBinding {
  providerId: string;
  connectionId: string;
  configurationDigest: string;
}
export interface AcquisitionOriginal { fileRefId: string; sha256: string }
export interface AcquisitionPage {
  cursor: string | null;
  /** undefined 为来源未声明；null 才是来源明确没有下一页。 */
  nextCursor?: string | null;
  original: AcquisitionOriginal;
  rowCount: number;
  /** 使用来源已解析的逻辑行键，不从日期首尾推定中间完整。 */
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
  /** 预期范围由明确的产品/日历契约提供；本模块不推断交易日或停牌。 */
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
