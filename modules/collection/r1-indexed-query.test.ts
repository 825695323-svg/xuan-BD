import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalWfdJson, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1MembershipSelection, R1TabularSelection } from '../../contracts/r1-contracts.js';
import { parseTabularSelection, resolveMembership, validateIndexedResult, validateMembershipDeclarations } from './r1-indexed-query.js';

const sha = (body: unknown) => 'sha256:' + createHash('sha256').update(canonicalWfdJson(body)).digest('hex');
const sid = 's_' + '1'.repeat(24), productId = 'p_' + '2'.repeat(24), rowId = 'tabular_' + '3'.repeat(64);
const version = 'r_' + '4'.repeat(32), contractHash = sha('fixed context'), code = '000001';
const stockField = 'stock_code', dateField = 'trade_date', minuteField = 'source_minute';
const plainRange = { field: dateField, format: 'YYYYMMDD' as const, start: '2024-01-02', end: '2024-01-02' };
const selection = { dateRange: plainRange, match: { [stockField]: [code] } };
const projection = [dateField, stockField];
const isCode = (wanted: string) => (error: unknown) => (error as { code: string }).code === wanted;
const text = (field: string, value: string | null) => ({ field_code: field, data_type: 'text', value,
  value_state: value === null ? 'unknown' : 'valid_value' });

function readback(minute = false) {
  const time = minute ? { role: 'observation', start: '2024-01-02T09:30:00', end: '2024-01-02T09:30:59', timezone: 'Asia/Shanghai' } as const : null;
  const fields = minute ? [...projection, minuteField] : projection;
  const contract = { version: 'wfd.tabular-contract/1', fields, key_fields: [stockField], partition_field: dateField,
    time: minute ? { kind: 'source_minute', date_field: dateField, minute_field: minuteField, timezone: 'Asia/Shanghai' } : { kind: 'unknown' } };
  const fieldDigest = sha(contract);
  const businessTime = minute ? { status: 'known', precision: 'minute', source_timezone: 'Asia/Shanghai',
    earliest_utc: '2024-01-02T01:30:00Z', latest_exclusive_utc: '2024-01-02T01:31:00Z' } : { status: 'unknown' };
  const result = {
    product_id: productId, snapshot_id: sid, sort: ['partition', 'row_index'],
    business_time_range: time && { ...time, start_utc: '2024-01-02T01:30:00Z', end_utc: '2024-01-02T01:31:00Z' },
    indexed_tabular: { protocol_version: 'wfd.tabular-batch/1', selection: { partitions: ['20240102'],
      match: minute ? {} : selection.match, date_range: minute ? null : plainRange, context_digest: contractHash },
      table_contract: { ...contract, digest: fieldDigest }, table_contract_digest: fieldDigest,
      partitions: [{ partition: '20240102', publication_snapshot_id: sid, row_count: 1,
        result_root: sha('root'), rows_digest: sha('rows') }], missing_partitions: [] },
    complete: true, page: { total_rows: 1, has_more: false, remaining_rows: 1, cursor_applied: false, next_cursor: null },
    rows: [{ product_id: productId, partition: '20240102', row_index: 0, record_id: rowId, record_version: version,
      record_ref: { product_id: productId, snapshot_id: sid, logical_key: rowId, revision_id: version },
      business_time: businessTime, business_time_role: 'observation', times: { observation_time: businessTime },
      values: { [dateField]: text(dateField, '20240102'), [stockField]: text(stockField, code),
        ...(minute ? { [minuteField]: text(minuteField, '2024-01-02 09:30:00') } : {}) } }],
  };
  const requested: R1TabularSelection = time ? { timeRange: time } : selection;
  return { result, selection: requested, fields };
}

test('indexed reply verifies dates, projected value states, published identities, counts, and empty predicates', () => {
  const { result, fields } = readback();
  const check = (value: WfdRecord, requested: R1TabularSelection = selection) =>
    validateIndexedResult(value, requested, fields, fields, null, contractHash);
  check(result);
  const bad = isCode('R1_READ_RESPONSE_INVALID');
  const missingPublication = structuredClone(result);
  delete (missingPublication.indexed_tabular.partitions[0] as Partial<typeof result.indexed_tabular.partitions[number]>).publication_snapshot_id;
  assert.throws(() => check(missingPublication), bad);
  const faultyDate = structuredClone(result);
  faultyDate.rows[0]!.values[dateField].value = '20240431';
  assert.throws(() => check(faultyDate), bad);
  const faultyCell = structuredClone(result);
  faultyCell.rows[0]!.values[stockField].value_state = 'unknown';
  assert.throws(() => check(faultyCell), bad);
  const faultyRecord = structuredClone(result);
  delete (faultyRecord.rows[0] as Partial<typeof result.rows[number]>).record_id;
  delete (faultyRecord.rows[0]!.record_ref as Partial<typeof result.rows[number]['record_ref']>).logical_key;
  assert.throws(() => check(faultyRecord), bad);
  const faultyPage = structuredClone(result);
  faultyPage.page.remaining_rows = 0;
  assert.throws(() => check(faultyPage), bad);
  const empty = { ...selection, match: { [stockField]: [] } };
  const faultyEmpty = structuredClone(result);
  faultyEmpty.indexed_tabular.selection.match = empty.match;
  assert.throws(() => check(faultyEmpty, empty), bad);
});

test('observation mode verifies normalized UTC range and the exact auto-selected date labels', () => {
  const { result, selection, fields } = readback(true);
  const check = (value: WfdRecord) => validateIndexedResult(value, selection, fields, fields, null, contractHash);
  check(result);
  const bad = isCode('R1_READ_RESPONSE_INVALID');
  const wrongUtc = structuredClone(result);
  wrongUtc.business_time_range!.end_utc = '2024-01-02T09:31:00Z';
  assert.throws(() => check(wrongUtc), bad);
  const outside = structuredClone(result);
  Object.assign(outside.rows[0]!.business_time, { earliest_utc: '2024-01-02T01:29:00Z', latest_exclusive_utc: '2024-01-02T01:30:00Z' });
  assert.throws(() => check(outside), bad);
  const omitted = structuredClone(result);
  omitted.indexed_tabular.selection.partitions = ['20240103'];
  assert.throws(() => check(omitted), bad);
  assert.throws(() => parseTabularSelection({ timeRange: { ...selection.timeRange, start: '2024-04-31' } }), isCode('R1_INDEXED_INPUT'));
});

const memberProduct = 'p_member', targetProduct = 'p_target', mapProduct = 'p_map';
const membership: R1MembershipSelection = { productId: memberProduct, selection: { partitions: ['sector'] }, memberField: 'member',
  targetField: stockField, basis: 'reported_snapshot' };
const raw = 'source.security.raw_code', ts = 'source.security.ts_code', market = 'source.security.cn_a_share';
function declaration(id: string, fields: Record<string, string>, reported = false, scope = market): WfdRecord {
  const definition = {
    semantic_context: { content_nature: 'source_claim' },
    field_definitions: Object.keys(fields).map(field_code => ({ field_code, data_type: 'text' })),
    field_semantic_context: Object.fromEntries(Object.entries(fields).map(([field, domain]) => [field, {
      identity: { identity_resolution_rule: domain, alias_scope: scope },
      ...(reported ? { content: { assertion_status: 'source_reported_membership' } } : {}) }])),
  };
  return { product_id: id, definition_ref: { digest: sha(definition) }, declaration: definition };
}

test('classified selection requires formal member and target domains, including both ends of an explicit map', () => {
  const source = declaration(memberProduct, { member: ts }, true);
  const target = declaration(targetProduct, { [stockField]: raw });
  const map = declaration(mapProduct, { from: ts, to: raw });
  assert.throws(() => validateMembershipDeclarations(membership, [source, target, map], targetProduct), isCode('R1_MEMBERSHIP_IDENTITY_MISMATCH'));
  const linked = { ...membership, mapping: { productId: mapProduct, selection: { partitions: ['scope'] }, sourceField: 'from', targetField: 'to' } };
  const proof = validateMembershipDeclarations(linked, [source, target, map], targetProduct);
  assert.equal(proof.mapping?.from.identityResolutionRule, ts);
  assert.equal(proof.mapping?.to.identityResolutionRule, raw);
  const otherScope = declaration(mapProduct, { from: ts, to: raw }, false, 'other.market');
  assert.throws(() => validateMembershipDeclarations(linked, [source, target, otherScope], targetProduct), isCode('R1_MEMBERSHIP_IDENTITY_MISMATCH'));
  assert.throws(() => validateMembershipDeclarations(membership, [declaration(memberProduct, { member: ts }), target], targetProduct),
    isCode('R1_MEMBERSHIP_DECLARATION_REQUIRED'));
});

test('membership refuses missing formal partitions and preserves an empty intersection', async () => {
  const domains = validateMembershipDeclarations(membership, [declaration(memberProduct, { member: raw }, true),
    declaration(targetProduct, { [stockField]: raw })], targetProduct);
  const row = { partition: 'sector', row_index: 0, values: { member: text('member', code) },
    record_ref: { product_id: memberProduct, snapshot_id: sid, logical_key: rowId, revision_id: version } };
  const reply = { indexed_tabular: { missing_partitions: [] }, page: { total_rows: 1, next_cursor: null },
    rows: [row], query_hash: sha('member query') };
  const selected = { partitions: ['20240102'], match: { [stockField]: ['399001'] } };
  const filtered = await resolveMembership(async () => reply, membership, selected, domains, sid);
  assert.deepEqual(filtered.selection.match, { [stockField]: [] });
  assert.equal(filtered.digest, sha(filtered.proof));
  assert.equal(filtered.proof.snapshotId, sid);
  await assert.rejects(resolveMembership(async () => ({ ...reply, indexed_tabular: { missing_partitions: ['sector'] } }),
    membership, selected, domains, sid), isCode('R1_MEMBERSHIP_PARTITION_MISSING'));
});
