import { createHash } from 'node:crypto';
import type { AcquisitionBinding, AcquisitionCheckpoint, AcquisitionCoverage, AcquisitionOriginal,
  AcquisitionOutcome, AcquisitionPage, AcquisitionRequest, AcquisitionReview, SourceReceiptReview } from '../../contracts/source-acquisition.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
  && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value);
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
const reference = (value: AcquisitionOriginal) => {
  if (!value || !text(value.fileRefId) || !digest(value.sha256)) fail('SOURCE_EVIDENCE_INVALID', '需要已保管原件引用与 SHA-256。');
};
const bindingKey = (value: AcquisitionBinding) => {
  if (!value || !text(value.providerId) || !text(value.connectionId) || !digest(value.configurationDigest))
    fail('SOURCE_BINDING_INVALID', '分页续取需要固定来源、连接与当前请求的配置摘要。');
  return hash([value.providerId, value.connectionId, value.configurationDigest]);
};
function keys(value: string[]): void {
  if (!Array.isArray(value) || value.length > 10000 || value.some(item => !text(item)))
    fail('SOURCE_KEYS_INVALID', '行键必须明确且有界；不从时间首尾推定行键。');
}
/** Node 24 在严格 JSON 解析时提供原始数字词素，保留对象/数组位置和字符串类型。 */
export function parseSourceJson(text: string, numberValue: (parent: object, key: string, value: number, raw: string) => unknown): unknown {
  return JSON.parse(text, function (this: object, key, value, context?: { source: string }) {
    if (typeof value !== 'number') return value;
    if (typeof context?.source !== 'string') throw new Error('JSON number source unavailable');
    return numberValue(this, key, value, context.source);
  });
}

function decimalIdentity(text: string): string {
  const [mantissa, exponent = '0'] = text.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = (whole + fraction).replace(/^-?0*/u, '');
  if (!digits) return '0';
  let end = digits.length;
  while (digits[end - 1] === '0') end--;
  return (text.startsWith('-') ? '-' : '') + digits.slice(0, end) + 'e' + (Number(exponent) - fraction.length + digits.length - end);
}

/** 供必须兼容 Number 的字段核对。输入词素由 JSON 解析器提供，只忽略十进制等值写法。 */
export function sourceNumberRoundTrips(value: number, raw: string): boolean {
  return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))
    && decimalIdentity(raw) === decimalIdentity(String(value));
}
/** 请求身份不依赖供应商实现；稳定操作身份不授予网络或发布权限。 */
type LogicalRequest = AcquisitionRequest & { statement?: string; encodeUrl?: string };
export function sourceRequestKey(request: LogicalRequest): string {
  if (!request || Object.keys(request).filter(key => key !== 'statement' && key !== 'encodeUrl').sort().join(',') !== 'adjustment,end,operationId,scopeId,start,subjectId'
    || 'statement' in request && (request.operationId !== 'financial_statements' || typeof request.statement !== 'string' || !['income', 'balance_sheet', 'cash_flow'].includes(request.statement))
    || 'encodeUrl' in request && (request.operationId !== 'research_report_detail' || !text(request.encodeUrl))
    || !text(request.scopeId) || typeof request.operationId !== 'string' || !/^[a-z][a-z0-9_.:-]{0,99}$/u.test(request.operationId)
    || [request.subjectId, request.start, request.end, request.adjustment].some(value => value !== null && !text(value)))
    fail('SOURCE_REQUEST_INVALID', '只接受明确的逻辑请求字段，未知保持 null。');
  return hash([request.scopeId, request.operationId, request.subjectId, request.start, request.end, request.adjustment,
    ...(request.statement === undefined ? [] : [request.statement]), ...(request.encodeUrl === undefined ? [] : [request.encodeUrl])]);
}
export function beginSourceAcquisition(request: LogicalRequest, binding: AcquisitionBinding,
  budget: AcquisitionCheckpoint['budget']): AcquisitionCheckpoint {
  const requestKey = sourceRequestKey(request); bindingKey(binding);
  if ([request.subjectId, request.start, request.end, request.adjustment].some(value => value === null))
    fail('SOURCE_REQUEST_INCOMPLETE', '当前分页框架需要明确对象、范围和口径；不完整请求不能沿用游标。');
  if (!budget || !Number.isSafeInteger(budget.maxPages) || budget.maxPages < 1 || budget.maxPages > 128
    || !Number.isSafeInteger(budget.maxRows) || budget.maxRows < 1 || budget.maxRows > 10000)
    fail('SOURCE_BUDGET_INVALID', '明确声明本任务页数和行数预算；框架上限不是供应商限额。');
  return structuredClone({ version: 'bd.source-acquisition/1', request, requestKey, binding, budget, pages: [] });
}
function pageDigest(page: AcquisitionPage): string {
  return hash([page.cursor, page.nextCursor === undefined ? ['unknown'] : page.nextCursor,
    page.original.sha256, page.rowCount, page.keys]);
}
/** 一次只接受一页，不自动请求、重试或切备用。 */
function appendSourcePage(saved: AcquisitionCheckpoint, request: LogicalRequest,
  binding: AcquisitionBinding, page: AcquisitionPage): AcquisitionCheckpoint {
  if (saved.version !== 'bd.source-acquisition/1' || sourceRequestKey(request) !== saved.requestKey
    || sourceRequestKey(saved.request) !== saved.requestKey || bindingKey(binding) !== bindingKey(saved.binding))
    fail('SOURCE_CONTINUATION_BINDING', '请求口径或来源配置改变，原游标不能沿用。');
  if (!page || typeof page !== 'object') fail('SOURCE_PAGE_INVALID', '缺少实际分页结果。');
  reference(page.original); keys(page.keys);
  if (page.cursor !== null && !text(page.cursor) || page.nextCursor !== undefined && page.nextCursor !== null && !text(page.nextCursor)
    || !Number.isSafeInteger(page.rowCount) || page.rowCount < 0 || page.rowCount !== page.keys.length)
    fail('SOURCE_PAGE_INVALID', '游标、行数和实际行键不一致；整页未采用。');
  const old = saved.pages.find(item => item.cursor === page.cursor);
  if (old) {
    if (pageDigest(old) !== pageDigest(page)) fail('SOURCE_PAGE_CONFLICT', '同页原件或解析结果改变，不能当作无变化重试。');
    return structuredClone(saved);
  }
  const last = saved.pages.at(-1);
  if ((!last && page.cursor !== null) || (last && (last.nextCursor == null || page.cursor !== last.nextCursor)))
    fail('SOURCE_CURSOR_MISMATCH', '只接受原检查点明确返回的下一页游标。');
  if (page.nextCursor !== undefined && page.nextCursor !== null
    && (page.nextCursor === page.cursor || saved.pages.some(item => item.cursor === page.nextCursor)))
    fail('SOURCE_CURSOR_CYCLE', '来源重复返回已走过的游标，停止而不无限循环。');
  if (saved.pages.length >= saved.budget.maxPages
    || saved.pages.reduce((sum, item) => sum + item.rowCount, 0) + page.rowCount > saved.budget.maxRows)
    fail('SOURCE_BUDGET_EXCEEDED', '本任务分页或行预算已耗尽；没有截断、补齐或发起新任务。');
  return structuredClone({ ...saved, pages: [...saved.pages, page] });
}
function checkedCheckpoint(saved: AcquisitionCheckpoint): AcquisitionCheckpoint {
  if (!saved || saved.version !== 'bd.source-acquisition/1' || !Array.isArray(saved.pages) || saved.pages.length > 128)
    fail('SOURCE_CHECKPOINT_INVALID', '来源检查点格式无效。');
  let replay = beginSourceAcquisition(saved.request, saved.binding, saved.budget);
  if (replay.requestKey !== saved.requestKey) fail('SOURCE_CONTINUATION_BINDING', '检查点请求身份不符。');
  for (const page of saved.pages) replay = appendSourcePage(replay, saved.request, saved.binding, page);
  if (replay.pages.length !== saved.pages.length) fail('SOURCE_CHECKPOINT_INVALID', '检查点重复保存同一页。');
  return replay;
}
export function acceptSourcePage(saved: AcquisitionCheckpoint, request: LogicalRequest,
  binding: AcquisitionBinding, page: AcquisitionPage): AcquisitionCheckpoint {
  return appendSourcePage(checkedCheckpoint(saved), request, binding, page);
}
export function reviewSourceAcquisition(saved: AcquisitionCheckpoint, coverage?: AcquisitionCoverage): AcquisitionReview {
  saved = checkedCheckpoint(saved);
  const requestKey = sourceRequestKey(saved.request);
  if (requestKey !== saved.requestKey) fail('SOURCE_CONTINUATION_BINDING', '检查点逻辑请求摘要不符。');
  if (coverage) {
    if (coverage.requestKey !== requestKey) fail('SOURCE_COVERAGE_INVALID', '预期范围不属于本次逻辑请求。');
    reference(coverage.evidence); keys(coverage.expectedKeys);
    if (new Set(coverage.expectedKeys).size !== coverage.expectedKeys.length)
      fail('SOURCE_COVERAGE_INVALID', '预期范围不能含重复键。');
  }
  const observed = saved.pages.flatMap(page => page.keys), unique = new Set<string>(), duplicate = new Set<string>();
  for (const key of observed) { if (unique.has(key)) duplicate.add(key); unique.add(key); }
  const expected = coverage ? new Set(coverage.expectedKeys) : null;
  const missing = expected ? [...expected].filter(key => !unique.has(key)) : [];
  const unexpected = expected ? [...unique].filter(key => !expected.has(key)) : [];
  const last = saved.pages.at(-1), rowCount = saved.pages.length ? observed.length : null;
  const conflict = duplicate.size > 0 || unexpected.length > 0;
  const finished = !!last && last.nextCursor === null;
  const bounded = saved.pages.length >= saved.budget.maxPages || observed.length >= saved.budget.maxRows;
  const state = conflict ? 'conflict' : !expected ? 'not_established'
    : missing.length || !finished ? 'incomplete' : 'declared_scope_complete';
  const gaps: AcquisitionReview['gaps'] = [];
  if (!coverage) gaps.push({ code: 'COVERAGE_UNDECLARED', reason: '缺少有依据的预期范围，不推断交易日、停牌或完整历史。' });
  if (missing.length) gaps.push({ code: 'COVERAGE_MISSING', reason: '仅列出预期但未取得的键；未补零或自动补采。' });
  if (conflict) gaps.push({ code: 'ROW_IDENTITY_CONFLICT', reason: '重复或越范围行保留为冲突，不删行制造完整结果。' });
  if (!finished) gaps.push({ code: last?.nextCursor ? 'PAGES_REMAIN' : 'PAGINATION_UNCONFIRMED', reason: '尚未证实分页结束；结果交回 AGENTS。' });
  return { requestKey, outcome: rowCount ? 'data' : state === 'declared_scope_complete' ? 'confirmed_empty' : 'undetermined',
    rowCount, coverage: { state, missingKeys: missing, unexpectedKeys: unexpected,
      duplicateKeys: [...duplicate], evidence: coverage?.evidence ?? null },
    continuation: { state: conflict ? 'blocked' : finished ? 'finished' : !last || last.nextCursor === undefined ? 'unknown'
      : bounded ? 'budget_exhausted' : 'available', cursor: conflict || finished || bounded ? null : last?.nextCursor ?? null },
    gaps, returnTo: 'agents', publication: 'not_requested' };
}
export function sourceFailureDisposition(code: string): { outcome: AcquisitionOutcome; automaticRetry: false; returnTo: 'agents' } {
  const outcome: AcquisitionOutcome = ['SOURCE_PERMISSION_DENIED', 'SOURCE_AUTH_REQUIRED', 'SOURCE_UNAUTHORIZED', 'SOURCE_FORBIDDEN'].includes(code) ? 'no_permission'
    : code === 'SOURCE_HISTORY_UNSUPPORTED' ? 'unsupported_history'
    : ['SOURCE_NOT_READY', 'SOURCE_RATE_LIMITED'].includes(code) ? 'not_ready' : 'failed';
  return { outcome, automaticRetry: false, returnTo: 'agents' };
}
export function sourceReceiptReview(request: LogicalRequest, rowCount: number | null): SourceReceiptReview {
  if (rowCount !== null && (!Number.isSafeInteger(rowCount) || rowCount < 0))
    fail('SOURCE_PAGE_INVALID', '观测行数未知时用 null，不能以非法数值替代。');
  return { requestKey: sourceRequestKey(request), outcome: rowCount !== null && rowCount > 0 ? 'data' as const : 'undetermined' as const,
    coverageState: 'not_established' as const, continuation: 'not_declared' as const,
    returnTo: 'agents' as const, publication: 'not_requested' as const };
}
