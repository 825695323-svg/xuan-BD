import assert from 'node:assert/strict';
import test from 'node:test';
import type { R1ProductRead } from '../../contracts/r1-contracts.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { R1_READ_LIMITS } from './r1-product-reader.js';
import { checkR1ProductCoverage } from './r1-product-coverage.js';
const input = { snapshotId: 's_one', productId: 'p_one', businessKeys: ['one', 'absent'] };
function page(keys: string[], options: WfdRecord = {}): R1ProductRead {
  return { snapshotId: 's_one', productId: 'p_one', historyMode: 'snapshot_contents', connection: { connectionId: 'fixed', profile: 'data_only', mode: 'user_test', runtimeIdentity: 'test', callerId: 'test', namespace: 'test' }, limits: R1_READ_LIMITS,
    result: { snapshot_id: 's_one', product_id: 'p_one', history_mode: 'snapshot_contents', query_hash: 'sha256:' + 'a'.repeat(64),
      complete: true, diagnostics: [], rows: keys.map(key => ({ record_ref: { logical_key: key, product_id: 'p_one', snapshot_id: 's_one', revision_id: 'r1' } })),
      page: { total_rows: keys.length, returned_rows: keys.length, has_more: false, next_cursor: null }, ...options } } as R1ProductRead;
}
test('coverage uses explicit keys only and finishes the whole pinned query before declaring not_observed', async () => {
  let count = 0;
  const result = await checkR1ProductCoverage(input, async request => {
    count++;
    if (count === 1) return page(['one'], { complete: false, page: { total_rows: 2, returned_rows: 1, has_more: true, next_cursor: 'next' } });
    assert.equal((request as WfdRecord).cursor, 'next'); return page(['other'], { page: { total_rows: 2, returned_rows: 1, has_more: false, next_cursor: null } });
  });
  assert.deepEqual(result.keys.map(row => row.status), ['observed', 'not_observed']);
  assert.equal(result.scan.complete, true); assert.equal(count, 2);
  assert.equal(result.calendarQualification, 'not_asserted');
});
test('empty fixed response is not world absence, and incomplete reads never prove a key absent', async () => {
  const empty = await checkR1ProductCoverage(input, async () => page([]));
  assert.ok(empty.keys.every(row => row.status === 'not_observed'));
  assert.equal(empty.absenceMeaning, 'not_observed_is_not_world_absence');
  for (const result of [page(['one'], { complete: false }), page([], { diagnostics: [{ code: 'UNKNOWN' }] })]) {
    const checked = await checkR1ProductCoverage(input, async () => result);
    assert.ok(checked.keys.every(row => row.status === 'unknown' && row.recordRef === null));
    assert.equal(checked.scan.reason, 'read_incomplete');
  }
});
test('budget expiry is unknown; authorization and corrupt responses remain errors', async () => {
  const exhausted = await checkR1ProductCoverage(input, async () => { throw new TaskError('R1_READ_BUDGET', 'budget'); });
  assert.ok(exhausted.keys.every(row => row.status === 'unknown'));
  await assert.rejects(checkR1ProductCoverage(input, async () => { throw new TaskError('SOURCE_ACCESS_DENIED', 'denied'); }), { code: 'SOURCE_ACCESS_DENIED' });
  await assert.rejects(checkR1ProductCoverage(input, async () => page(['one', 'one'])), { code: 'R1_COVERAGE_RESPONSE_INVALID' });
  await assert.rejects(checkR1ProductCoverage(input, async () => page([], { page: { total_rows: 1, returned_rows: 0, has_more: false, next_cursor: null } })), { code: 'R1_COVERAGE_RESPONSE_INVALID' });
});
test('coverage rejects caller calendar assertions, mutable snapshots and unbounded key lists', async () => {
  for (const value of [{ ...input, calendar: 'authority' }, { ...input, snapshotId: 'latest' }, { ...input, businessKeys: [] },
    { ...input, businessKeys: ['one', 'one'] }, { ...input, businessKeys: Array.from({ length: 257 }, (_, i) => String(i)) }]) {
    await assert.rejects(checkR1ProductCoverage(value, async () => { throw new Error('must not call'); }), { code: 'R1_COVERAGE_INPUT' });
  }
});
test('coverage does not turn a scan cap or stopped wait into a completed missing-key result', async () => {
  let calls = 0;
  const capped = await checkR1ProductCoverage(input, async () => {
    const keys = Array.from({ length: 100 }, (_, i) => `key-${calls * 100 + i}`); calls++;
    return page(keys, { complete: false, page: { total_rows: 5001, returned_rows: 100, has_more: true, next_cursor: `cursor-${calls}` } });
  });
  assert.equal(calls, 50); assert.equal(capped.scan.reason, 'scan_budget_exceeded');
  assert.ok(capped.keys.every(row => row.status === 'unknown'));
  const control = new AbortController(); control.abort();
  const stopped = await checkR1ProductCoverage(input, async () => { throw new Error('must not read'); }, control.signal);
  assert.equal(stopped.scan.reason, 'read_aborted');
  assert.ok(stopped.keys.every(row => row.status === 'unknown'));
});
test('connection drift and repeated cursors are rejected rather than returning a partial checklist', async () => {
  let calls = 0;
  await assert.rejects(checkR1ProductCoverage(input, async () => {
    const result = page([`key-${calls++}`], { complete: false, page: { total_rows: 3, returned_rows: 1, has_more: true, next_cursor: 'loop' } });
    return result;
  }), { code: 'R1_COVERAGE_RESPONSE_INVALID' });
  calls = 0;
  await assert.rejects(checkR1ProductCoverage(input, async () => {
    const result = page([`key-${calls++}`], { complete: false, page: { total_rows: 3, returned_rows: 1, has_more: true, next_cursor: 'next' } });
    result.connection.connectionId = String(calls); return result;
  }), { code: 'R1_COVERAGE_RESPONSE_INVALID' });
});
