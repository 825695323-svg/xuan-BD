/** R1 当前正式交接用途的操作者授权声明；不代表独立法律真实性验证。 */
export interface R1SourceAuthorization {
  status: 'authorized' | 'unknown' | 'denied';
  basis: string | null;
}

const SOURCE_FIELDS = ['source_id', 'provider', 'requested_url', 'usage_scope'] as const;
const UNKNOWN = /^(unknown|unspecified|unverified|not_verified|not_established|native_unverified|pending|未知|待核|待确认|不明)$/iu;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const knownR1SourceText = (value: unknown): value is string => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value)
  && !UNKNOWN.test(value.trim());
/** 状态词和占位词本身不是本次授权的依据；不解释自由文本的法律含义。 */
export const knownR1AuthorizationBasis = (value: unknown): value is string => knownR1SourceText(value)
  && !/^(authorized|approved|denied|unauthorized|not_authorized|no_authorization|none|n\/a|na|null|已授权|无授权|未授权|无依据|未提供)$/iu.test(value.trim());
/** 仅识别本次用途或授权依据中的明确禁止标记，不据自由文本签发法律结论。 */
const explicitDenial = (value: unknown): boolean => typeof value === 'string'
  && (/(明确无授权|无授权|未授权|未获授权|无权入库|禁止正式入库)/u.test(value)
    || /\b(unauthorized|not\s+authorized|ingest\s+prohibited)\b/iu.test(value));

export function validR1Authorization(value: unknown): value is R1SourceAuthorization {
  return record(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'status') && Object.hasOwn(value, 'basis')
    && typeof value.status === 'string' && ['authorized', 'unknown', 'denied'].includes(value.status)
    && (value.basis === null || typeof value.basis === 'string' && value.basis.length <= 4096
      && !/[\u0000-\u001f]/u.test(value.basis));
}

export function r1SourceGaps(value: unknown): string[] {
  const source = record(value) ? value : {}, gaps: string[] = [];
  for (const field of SOURCE_FIELDS) if (!knownR1SourceText(source[field])) {
    gaps.push(`来源 ${field}: 操作者声明缺失或未知，不能据六维 known 获得发布资格。`);
  }
  const authorization = source.authorization;
  if (!validR1Authorization(authorization)) gaps.push('来源授权声明缺失或格式无效；新交接保持待核。');
  else if (authorization.status === 'denied') gaps.push('操作者明确声明本次正式交接未获授权，禁止发布。');
  else if (authorization.status !== 'authorized' || !knownR1AuthorizationBasis(authorization.basis)) {
    gaps.push('本次正式交接的操作者授权状态或依据仍未知，禁止发布。');
  }
  if (validR1Authorization(authorization) && authorization.status === 'authorized'
    && [source.usage_scope, authorization.basis].some(explicitDenial)) {
    gaps.push('本次授权状态与用途或依据中的明确禁止声明冲突，须由操作者核对，不能发布。');
  }
  return gaps;
}

export const r1SourceReadyForHandoff = (value: unknown): boolean => r1SourceGaps(value).length === 0;

export function r1SourceDenied(value: unknown): boolean {
  return record(value) && validR1Authorization(value.authorization) && value.authorization.status === 'denied';
}
