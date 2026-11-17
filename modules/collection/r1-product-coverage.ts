import { canonicalWfdJson, isWfdRecord, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1ProductRead } from '../../contracts/r1-contracts.js';
import { TaskError } from '../../platform/jobs/tasks.js';

export const R1_COVERAGE_LIMITS = Object.freeze({ requestedKeys: 256, pages: 50, rows: 5000, timeoutMs: 30_000 });
type Reader = (input: unknown, signal?: AbortSignal) => Promise<R1ProductRead>;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const fixed = (value: unknown): value is string => identifier(value) && !/^(latest|current)$/iu.test(value);

/** An explicit key checklist, not a trading calendar, world-coverage assertion or backfill action. */
export async function checkR1ProductCoverage(value: unknown, read: Reader, signal?: AbortSignal) {
  if (!isWfdRecord(value) || Object.keys(value).some(key => !['snapshotId', 'productId', 'businessKeys'].includes(key))
    || !fixed(value.snapshotId) || !fixed(value.productId) || !Array.isArray(value.businessKeys)
    || !value.businessKeys.length || value.businessKeys.length > R1_COVERAGE_LIMITS.requestedKeys
    || value.businessKeys.some(key => !identifier(key)) || new Set(value.businessKeys).size !== value.businessKeys.length) {
    throw new TaskError('R1_COVERAGE_INPUT', '覆盖核对须指定固定快照、产品及最多256个唯一业务键；清单不是权威日历或应有数据证明。');
  }
  const snapshotId = value.snapshotId, productId = value.productId, businessKeys = value.businessKeys as string[];
  const wait = AbortSignal.any([AbortSignal.timeout(R1_COVERAGE_LIMITS.timeoutMs), ...(signal ? [signal] : [])]);
  const seen = new Set<string>(), cursors = new Set<string>();
  const refs = new Map<string, WfdRecord>();
  let cursor: string | undefined, scannedRows = 0, pages = 0, identity: string | undefined, query: string | undefined;
  let total: number | undefined, reason: string | null = null;
  try {
    do {
      wait.throwIfAborted();
      const response = await read({ snapshotId, productId, ...(cursor ? { cursor } : {}) }, wait);
      wait.throwIfAborted();
      const result = response.result, page = result.page;
      if (response.snapshotId !== snapshotId || response.productId !== productId || response.historyMode !== 'snapshot_contents'
        || result.snapshot_id !== snapshotId || result.product_id !== productId || result.history_mode !== 'snapshot_contents'
        || !isWfdRecord(page) || !Array.isArray(result.rows) || result.rows.length > 100
        || !Number.isSafeInteger(page.total_rows) || Number(page.total_rows) < 0 || typeof page.has_more !== 'boolean'
        || page.returned_rows !== result.rows.length || typeof result.query_hash !== 'string'
        || !Array.isArray(result.diagnostics) || typeof result.complete !== 'boolean') {
        throw new TaskError('R1_COVERAGE_RESPONSE_INVALID', '固定读取身份、分页或完整性无法核对。');
      }
      const currentIdentity = canonicalWfdJson(response.connection);
      if (identity !== undefined && identity !== currentIdentity || query !== undefined && query !== result.query_hash
        || total !== undefined && total !== page.total_rows) {
        throw new TaskError('R1_COVERAGE_RESPONSE_INVALID', '覆盖核对期间连接、查询或总行数发生变化。');
      }
      identity = currentIdentity; query = result.query_hash; total = Number(page.total_rows); pages++;
      if ((!page.has_more && result.complete !== true) || result.diagnostics.length) { reason = 'read_incomplete'; break; }
      for (const row of result.rows) {
        if (!isWfdRecord(row) || !isWfdRecord(row.record_ref)) throw new TaskError('R1_COVERAGE_RESPONSE_INVALID', '固定行缺少可核对记录身份。');
        const ref = row.record_ref, key = ref.logical_key ?? ref.record_id;
        if (!identifier(key) || !fixed(ref.revision_id) || ref.product_id !== productId || ref.snapshot_id !== snapshotId || seen.has(key)) {
          throw new TaskError('R1_COVERAGE_RESPONSE_INVALID', '固定行身份错误或业务键重复；不能任取一行证明覆盖。');
        }
        seen.add(key); scannedRows++;
        if (businessKeys.includes(key)) refs.set(key, { product_id: productId, snapshot_id: snapshotId,
          logical_key: key, revision_id: ref.revision_id });
      }
      if (scannedRows > R1_COVERAGE_LIMITS.rows) { reason = 'scan_budget_exceeded'; break; }
      if (!page.has_more) {
        if (page.next_cursor !== null || scannedRows !== total) throw new TaskError('R1_COVERAGE_RESPONSE_INVALID', '分页结束与固定总行数不一致。');
        break;
      }
      if (typeof page.next_cursor !== 'string' || !page.next_cursor || page.next_cursor.length > 8192
        || /[\u0000-\u001f]/u.test(page.next_cursor) || cursors.has(page.next_cursor) || !result.rows.length) {
        throw new TaskError('R1_COVERAGE_RESPONSE_INVALID', '分页游标缺失、循环或没有进展。');
      }
      if (pages >= R1_COVERAGE_LIMITS.pages || scannedRows >= R1_COVERAGE_LIMITS.rows) { reason = 'scan_budget_exceeded'; break; }
      cursor = page.next_cursor; cursors.add(cursor);
    } while (cursor);
  } catch (error) {
    if (wait.aborted) reason = 'read_aborted';
    else if (error instanceof TaskError && ['R1_READ_BUDGET', 'BUDGET_EXCEEDED'].includes(error.code)) reason = 'scan_budget_exceeded';
    else throw error;
  }
  return { version: 'bd.fixed-product-key-coverage/1', snapshotId, productId, historyMode: 'snapshot_contents',
    basis: 'caller_explicit_business_keys', scope: 'selected_product_in_fixed_snapshot',
    calendarQualification: 'not_asserted', absenceMeaning: 'not_observed_is_not_world_absence',
    scan: { complete: reason === null, reason, pages, scannedRows, queryHash: query ?? null },
    keys: businessKeys.map(businessKey => ({ businessKey,
      status: reason ? 'unknown' : refs.has(businessKey) ? 'observed' : 'not_observed',
      recordRef: reason ? null : refs.get(businessKey) ?? null })), limits: R1_COVERAGE_LIMITS };
}
