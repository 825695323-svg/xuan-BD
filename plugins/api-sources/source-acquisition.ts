import { createHash } from 'node:crypto';
import { SOURCE_OPERATION_IDS } from '../../contracts/source-settings.js';
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
/** 请求身份与供应商实现、任务号、尝试次数、取得时刻无关；不是金融事实去重键。 */
export function sourceRequestKey(request: AcquisitionRequest): string {
  if (!request || Object.keys(request).sort().join(',') !== 'adjustment,end,operationId,scopeId,start,subjectId'
    || !text(request.scopeId) || !SOURCE_OPERATION_IDS.includes(request.operationId)
    || [request.subjectId, request.start, request.end, request.adjustment].some(value => value !== null && !text(value)))
    fail('SOURCE_REQUEST_INVALID', '只接受明确的逻辑请求字段，未知保持 null。');
  return hash([request.scopeId, request.operationId, request.subjectId, request.start, request.end, request.adjustment]);
}

/** 放入原 TaskService 检查点即可；不新增状态数据库、调度器或网络调用。 */
export function beginSourceAcquisition(request: AcquisitionRequest, binding: AcquisitionBinding,
  budget: AcquisitionCheckpoint['budget']): AcquisitionCheckpoint {
  const requestKey = sourceRequestKey(request); bindingKey(binding);
  if ([request.subjectId, request.start, request.end, request.adjustment].some(value => value === null))
    fail('SOURCE_REQUEST_INCOMPLETE', '当前分页框架需要明确对象、范围和口径；原始响应仍可保管，但不能沿用不完整请求的游标。');
  if (!budget || !Number.isSafeInteger(budget.maxPages) || budget.maxPages < 1 || budget.maxPages > 128
    || !Number.isSafeInteger(budget.maxRows) || budget.maxRows < 1 || budget.maxRows > 10000)
    fail('SOURCE_BUDGET_INVALID', '明确声明本任务页数和行数预算；框架上限不是供应商限额。');
  return structuredClone({ version: 'bd.source-acquisition/1', request, requestKey, binding, budget, pages: [] });
}
function pageDigest(page: AcquisitionPage): string {
  // 文件引用可能变化；同一游标重放按原件摘要与解析内容核对，不再计一页。
  return hash([page.cursor, page.nextCursor === undefined ? ['unknown'] : page.nextCursor,
    page.original.sha256, page.rowCount, page.keys]);
}
/** 一次只接受一页；调用方读取反馈后决定续取。不自动请求、重试或切备用。 */
function appendSourcePage(saved: AcquisitionCheckpoint, request: AcquisitionRequest,
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
    if (pageDigest(old) !== pageDigest(page)) fail('SOURCE_PAGE_CONFLICT', '同一页的原件或解析结果改变，不能当作无变化重试。');
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

/** 恢复时重核现有轻量回执，不信任单独写入的计数或完成标记。 */
function checkedCheckpoint(saved: AcquisitionCheckpoint): AcquisitionCheckpoint {
  if (!saved || saved.version !== 'bd.source-acquisition/1' || !Array.isArray(saved.pages) || saved.pages.length > 128)
    fail('SOURCE_CHECKPOINT_INVALID', '来源检查点格式无效。');
  let replay = beginSourceAcquisition(saved.request, saved.binding, saved.budget);
  if (replay.requestKey !== saved.requestKey) fail('SOURCE_CONTINUATION_BINDING', '检查点请求身份不符。');
  for (const page of saved.pages) replay = appendSourcePage(replay, saved.request, saved.binding, page);
  if (replay.pages.length !== saved.pages.length) fail('SOURCE_CHECKPOINT_INVALID', '检查点重复保存同一页。');
  return replay;
}

export function acceptSourcePage(saved: AcquisitionCheckpoint, request: AcquisitionRequest,
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
  if (missing.length) gaps.push({ code: 'COVERAGE_MISSING', reason: '仅列出明确预期但尚未取得的键；未补零或自动补采。' });
  if (conflict) gaps.push({ code: 'ROW_IDENTITY_CONFLICT', reason: '重复或越范围行保留为冲突，不通过删行制造完整结果。' });
  if (!finished) gaps.push({ code: last?.nextCursor ? 'PAGES_REMAIN' : 'PAGINATION_UNCONFIRMED', reason: '尚未证实分页结束；结果交回 AGENTS。' });
  return { requestKey, outcome: rowCount ? 'data' : state === 'declared_scope_complete' ? 'confirmed_empty' : 'undetermined',
    rowCount, coverage: { state, missingKeys: missing, unexpectedKeys: unexpected,
      duplicateKeys: [...duplicate], evidence: coverage?.evidence ?? null },
    continuation: { state: conflict ? 'blocked' : finished ? 'finished' : !last || last.nextCursor === undefined ? 'unknown'
      : bounded ? 'budget_exhausted' : 'available', cursor: conflict || finished || bounded ? null : last?.nextCursor ?? null },
    gaps, returnTo: 'agents', publication: 'not_requested' };
}

/** 映射固定错误码；无依据的空响应、网络异常不被改写为“确认无数据”。 */
export function sourceFailureDisposition(code: string): { outcome: AcquisitionOutcome; automaticRetry: false; returnTo: 'agents' } {
  const outcome: AcquisitionOutcome = ['SOURCE_PERMISSION_DENIED', 'SOURCE_AUTH_REQUIRED'].includes(code) ? 'no_permission'
    : code === 'SOURCE_HISTORY_UNSUPPORTED' ? 'unsupported_history'
    : ['SOURCE_NOT_READY', 'SOURCE_RATE_LIMITED'].includes(code) ? 'not_ready' : 'failed';
  return { outcome, automaticRetry: false, returnTo: 'agents' };
}

/** 当前下载入口尚未提供分页/覆盖证据时的真实反馈，不伪造已完成的检查点。 */
export function sourceReceiptReview(request: AcquisitionRequest, rowCount: number | null): SourceReceiptReview {
  if (rowCount !== null && (!Number.isSafeInteger(rowCount) || rowCount < 0))
    fail('SOURCE_PAGE_INVALID', '观测行数未知时用 null，不能以非法数值替代。');
  return { requestKey: sourceRequestKey(request), outcome: rowCount !== null && rowCount > 0 ? 'data' as const : 'undetermined' as const,
    coverageState: 'not_established' as const, continuation: 'not_declared' as const,
    returnTo: 'agents' as const, publication: 'not_requested' as const };
}
