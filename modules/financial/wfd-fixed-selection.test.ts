import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { selectWfdFixedRecords, type WfdFixedRecordReader } from './wfd-fixed-selection.js';

const ref = { snapshotId: 'snapshot-A', productId: 'product-A', businessKeys: ['row-A', 'row-B'] } as const;
const originalRows = [
  { record_ref: { logical_key: 'row-A', revision_id: 'rev-A' }, values: { value: { value: '123.45' } } },
  { record_ref: { logical_key: 'row-B', revision_id: 'rev-B' }, values: { value: { value: '12.34' } } },
];
function fixedReader(rows = originalRows, overrides: Record<string, unknown> = {}): WfdFixedRecordReader {
  return async value => {
    const page = value.cursor ? 1 : 0;
    return {
      connection: { instance: 'bound-wfd-1' },
      result: { snapshot_id: value.snapshotId, product_id: value.productId, history_mode: 'snapshot_contents',
        rows: [rows[page]], page: { has_more: !page, next_cursor: page ? null : 'next-page' },
        ...overrides },
    };
  };
}
const run = (reader: WfdFixedRecordReader, overrides: Partial<typeof ref> = {}) =>
  selectWfdFixedRecords([{ ...ref, ...overrides }], reader, new AbortController().signal);

test('one WFD fixed selection scans all pages without dropping or guessing a selected business key', async () => {
  const result = await run(fixedReader());
  assert.equal(result.historyQualification, 'not_asserted');
  assert.equal(result.selections[0]!.rows.length, 2);
  assert.deepEqual(result.selections[0]!.recordVersions.map(x => x.revision_id), ['rev-A', 'rev-B']);
  assert.equal(result.selections[0]!.selectedRowsSha256, wfdSha256(canonicalWfdJson(originalRows)));
  assert.deepEqual(result.connection, { instance: 'bound-wfd-1' });
});

test('explicit macro revision binding verifies the exact historical record version', async () => {
  const selection = { snapshotId: 'snapshot-A', productId: 'product-A',
    businessKeys: ['row-A'], recordVersions: { 'row-A': 'rev-A' } };
  const reader: WfdFixedRecordReader = async () => ({
    connection: { instance: 'bound-wfd-1' },
    result: { snapshot_id: 'snapshot-A', product_id: 'product-A',
      rows: [originalRows[0]], page: { has_more: false, next_cursor: null } },
  });
  const got = await selectWfdFixedRecords([selection], reader, new AbortController().signal);
  assert.equal(got.selections[0]!.recordVersions[0]!.revision_id, 'rev-A');
  await assert.rejects(selectWfdFixedRecords(
    [{ ...selection, recordVersions: { 'row-A': 'rev-different' } }],
    reader, new AbortController().signal), /记录版本/u);
});

test('reject duplicate selected records, changed WFD identity, inconsistent pages and unstable connection', async () => {
  const selection = { snapshotId: 'snapshot-A', productId: 'product-A',
    businessKeys: ['row-A'], recordVersions: { 'row-A': 'rev-A' } };
  const reader = (changes: Record<string, unknown>, records = [originalRows[0]]): WfdFixedRecordReader =>
    async value => ({ connection: { instance: 'bound-wfd-1' }, result: {
      snapshot_id: value.snapshotId, product_id: value.productId, rows: records,
      page: { has_more: false, next_cursor: null }, ...changes,
    } });
  for (const [changes, rows] of [
    [{ snapshot_id: 'different' }, [originalRows[0]]],
    [{ product_id: 'different' }, [originalRows[0]]],
    [{ history_mode: 'market_known_at' }, [originalRows[0]]],
    [{ page: { has_more: true, next_cursor: null } }, [originalRows[0]]],
    [{}, [originalRows[0], originalRows[0]]],
    [{}, [{ ...originalRows[0], record_ref: { ...originalRows[0]!.record_ref,
      product_id: 'unrelated-product' } }]],
  ] as const) {
    await assert.rejects(selectWfdFixedRecords([selection], reader(changes, [...rows] as typeof originalRows),
      new AbortController().signal));
  }
  const drifting: WfdFixedRecordReader = async request => ({
    connection: { instance: request.cursor ? 'other-account' : 'bound-wfd-1' },
    result: { snapshot_id: request.snapshotId, product_id: request.productId,
      rows: [request.cursor ? originalRows[1] : originalRows[0]],
      page: { has_more: !request.cursor, next_cursor: request.cursor ? null : 'next-page' } },
  });
  await assert.rejects(run(drifting), /连接身份变化/u);
});

test('fixed record selection never accepts latest, repeated keys or unlimited scans', async () => {
  const reader = fixedReader();
  for (const selections of [
    [{ ...ref, snapshotId: 'latest' }],
    [{ ...ref, businessKeys: ['row-A', 'row-A'] }],
    [{ ...ref, businessKeys: [] }],
    Array.from({ length: 9 }, () => ref),
  ]) await assert.rejects(selectWfdFixedRecords(selections, reader, new AbortController().signal));
});

test('aborted task never reads WFD or accepts a partial record selection', async () => {
  const abort = new AbortController(); abort.abort();
  let reads = 0;
  const reader: WfdFixedRecordReader = async () => { reads++; throw Error('unexpected access'); };
  await assert.rejects(selectWfdFixedRecords([ref], reader, abort.signal),
    (error: unknown) => (error as { name?: string }).name === 'AbortError');
  assert.equal(reads, 0);
});
