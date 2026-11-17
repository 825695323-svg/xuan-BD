import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import { WfdProductMachineError, type WfdProductMachineReply } from '../../adapters/database/wfd-product-machine.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1Runtime } from './r1-runtime.js';
import { R1ProductReader, R1_READ_LIMITS } from './r1-product-reader.js';

const identity: R1ConnectionIdentity = { connectionId: 'reader-test', profile: 'data_only', protocol: 'wfd.structured-ingest/1.0',
  mode: 'user_test', purpose: 'user_test', runtimeIdentity: 'isolated-reader-test', callerId: 'reader-test', namespace: 'read.test',
  store: '/isolated-test/store', runtime: '/isolated-test/runtime', configSha256: '1'.repeat(64), schemaSha256: '2'.repeat(64),
  entrySha256: '3'.repeat(64), pythonPath: '/isolated-test/python', entryPath: '/isolated-test/entry.py' };
const product = { product_id: 'p_fixture', dataset_id: 'actual_dataset', payload_kind: 'tabular_rows',
  subject: { kind: 'physical_object', namespace: 'test', id: 'fixture' },
  declaration: { semantic_code: 'fixture.metric', definition_authority: 'test', field_definitions: [
    { field_code: 'label', data_type: 'text', unit_code: 'text' }, { field_code: 'amount', data_type: 'decimal', unit_code: 'count' }] },
  contracts: { read: { perspectives: ['snapshot_contents', 'market_known_at', 'system_held_at'] } },
  definition_ref: { id: 'def_actual', version: 'v_actual' }, contract_ref: { id: 'contract_actual' } };
const reply = (result: WfdRecord) => ({ result, response: {}, transport: {} }) as WfdProductMachineReply;
const isCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;

function fixture() {
  const calls: { operation: string; input: unknown }[] = [];
  const state = { stopped: false, generation: 1, identity: structuredClone(identity), products: [structuredClone(product)] as WfdRecord[],
    afterRead: () => {}, changeResult: (_result: WfdRecord) => {}, error: null as Error | null };
  const client = {
    contractDiscovery: async (snapshotId: string) => { calls.push({ operation: 'contract_discovery', input: snapshotId });
      return reply({ snapshot_id: snapshotId, product_count: state.products.length, products: state.products }); },
    snapshotStatus: async () => reply({ format_version: 'wfd.snapshot-status/1', profile: 'data_only', authority: 'active_head',
      snapshot_id: null, empty: true, connection_id: identity.connectionId, caller_id: identity.callerId,
      trusted_actor_namespace: identity.namespace, caller_roles: ['read'], unit_definitions: {
        count: { definition: { dimension: 'quantity' }, digest: 'sha256:' + 'a'.repeat(64) } } }),
    readProduct: async (request: WfdRecord) => {
      calls.push({ operation: 'read_product', input: request });
      if (state.error) throw state.error;
      const result: WfdRecord = { format_version: 'wfd.read-product-result/0.1', operation: 'read_product',
        snapshot_id: request.snapshot_id, product_id: request.product_id, dataset_id: request.dataset_id,
        fields: request.fields, history_mode: request.history_mode, knowledge_cutoff: request.knowledge_cutoff, held_scope: request.held_scope,
        usable_stage: request.usable_stage, business_time_range: null, subject: null, query_hash: 'sha256:' + 'b'.repeat(64),
        budget: { max_scan_bytes: request.max_scan_bytes }, diagnostics: [], complete: true,
        rows: [{ record_ref: { logical_key: 'row-actual', revision_id: 'r_actual' }, business_time: { status: 'unknown' },
          values: { amount: { value: null, value_state: 'missing_unknown', data_type: 'decimal', unit: { unit_code: 'count' } },
            label: { value: '原值', value_state: 'valid_value', data_type: 'text', unit: { unit_code: 'text' } } } }],
        page: { page_size: R1_READ_LIMITS.pageSize, returned_rows: 1, total_rows: 1, remaining_rows: 0,
          has_more: false, next_cursor: null, page_complete: true } };
      state.changeResult(result); state.afterRead(); return reply(result);
    },
  };
  const reader = new R1ProductReader({ runtime: () => ({ client: client as unknown as R1Runtime['client'], currentIdentity: () => state.identity }),
    control: () => ({ stopped: state.stopped, generation: state.generation }) });
  return { reader, calls, state };
}

test('product read derives dataset and all declared fields from actual fixed discovery; preserves unknown values and time', async () => {
  const f = fixture();
  const found = await f.reader.discoverProducts({ snapshotId: 's_fixture' });
  assert.deepEqual(found.products[0], product, 'Published definition and pinned references are preserved, not reconstructed');
  assert.deepEqual(found.selections[0]!.fields, ['amount', 'label']);
  const result = await f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture' });
  const query = f.calls.find(call => call.operation === 'read_product')!.input as WfdRecord;
  assert.equal(query.dataset_id, 'actual_dataset');
  assert.deepEqual(query.fields, ['amount', 'label']);
  assert.equal(query.history_mode, 'snapshot_contents');
  for (const key of ['knowledge_cutoff', 'held_scope', 'usable_stage', 'subject', 'business_time_range']) assert.equal(query[key], null);
  assert.equal(query.max_nodes, 5000); assert.equal(query.max_scan_bytes, 16_777_216); assert.equal(query.page_size, 100);
  assert.deepEqual((result.result.rows as WfdRecord[])[0]!.business_time, { status: 'unknown' });
  assert.equal(((result.result.rows as WfdRecord[])[0]!.values as WfdRecord).amount &&
    (((result.result.rows as WfdRecord[])[0]!.values as WfdRecord).amount as WfdRecord).value_state, 'missing_unknown');
  assert.equal('store' in result.connection, false);
});

test('query refuses caller paths, datasets and history overrides before dispatch', async () => {
  const f = fixture();
  for (const value of [
    { snapshotId: 'latest' }, { snapshotId: '/tmp/store' }, { snapshotId: 's_fixture', database: 'other' },
  ]) await assert.rejects(f.reader.discoverProducts(value), isCode('R1_READ_INPUT'));
  for (const value of [
    { snapshotId: 's_fixture', productId: 'p_fixture', historyMode: 'market_known_at' },
    { snapshotId: 's_fixture', productId: 'p_fixture', historyMode: null },
    { snapshotId: 's_fixture', productId: 'p_fixture', datasetId: 'injected' },
    { snapshotId: 's_fixture', productId: 'p_fixture', cursor: 'x'.repeat(8193) },
  ]) await assert.rejects(f.reader.readProduct(value), isCode('R1_READ_INPUT'));
  assert.deepEqual(f.calls, []);
});

test('pagination preserves the fixed query and diagnostics; foreign time view and malformed continuation are rejected', async () => {
  const f = fixture();
  f.state.changeResult = result => { result.complete = false; result.diagnostics = [{ code: 'BUSINESS_TIME_UNKNOWN', decision: 'indeterminate' }];
    result.page = { page_size: 100, returned_rows: 1, total_rows: 2, remaining_rows: 1, has_more: true, next_cursor: 'actual-cursor', page_complete: false }; };
  const first = await f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture' });
  assert.equal(first.result.complete, false);
  assert.deepEqual(first.result.diagnostics, [{ code: 'BUSINESS_TIME_UNKNOWN', decision: 'indeterminate' }]);
  await f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture', cursor: 'actual-cursor' });
  assert.equal((f.calls.at(-1)!.input as WfdRecord).cursor, 'actual-cursor');
  assert.equal(f.calls.filter(call => call.operation === 'contract_discovery').length, 2, 'Every page rediscovers the same fixed contract');
  f.state.changeResult = result => { result.history_mode = 'market_known_at'; };
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture' }), isCode('R1_READ_RESPONSE_INVALID'));
  f.state.changeResult = result => { (result.page as WfdRecord).has_more = true; };
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture' }), isCode('R1_READ_RESPONSE_INVALID'));
});

test('binding or stop-generation changes discard late results, including later resumes', async () => {
  const f = fixture();
  f.state.afterRead = () => { f.state.generation += 1; };
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture' }), isCode('BD_STOPPED'));
  f.state.afterRead = () => { f.state.identity.configSha256 = '4'.repeat(64); };
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture' }), isCode('R1_CONNECTION_BINDING_CHANGED'));
});

test('empty status is verified by bound machine identity and query failures retain remote codes without arbitrary paths', async () => {
  const f = fixture(), status = await f.reader.snapshotStatus();
  assert.equal(status.snapshotId, null); assert.equal(status.empty, true);
  assert.deepEqual(status.connection.roles, ['read']);
  assert.deepEqual(status.units.count!.definition, { dimension: 'quantity' });
  f.state.identity.callerId = 'different';
  await assert.rejects(f.reader.snapshotStatus(), isCode('R1_READ_RESPONSE_INVALID'));
  f.state.identity = structuredClone(identity);
  f.state.error = new WfdProductMachineError('WFD_PRODUCT_MACHINE_REJECTED', '/private/unrelated/path', {
    operation: 'read_product', requestId: 'fixture', remoteCode: 'CALLER_PERMISSION_DENIED' });
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture' }), error =>
    isCode('CALLER_PERMISSION_DENIED')(error) && error instanceof Error && !error.message.includes('/private/'));
});

test('unknown products and oversized results do not become a partial successful read', async () => {
  const f = fixture();
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_other' }), isCode('R1_READ_PRODUCT_NOT_FOUND'));
  assert.equal(f.calls.some(call => call.operation === 'read_product'), false);
  f.state.changeResult = result => { result.diagnostics = [{ detail: 'x'.repeat(R1_READ_LIMITS.maxResultBytes) }]; };
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture' }), isCode('R1_READ_BUDGET'));
});

test('explicit projection accepts only discovered fields and normalizes their order without changing the fixed query', async () => {
  const f = fixture();
  const all = await f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture', fields: ['label', 'amount'] });
  assert.deepEqual(all.result.fields, ['amount', 'label']);
  const selected = await f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture', fields: ['amount'] });
  assert.deepEqual(selected.result.fields, ['amount']);
  const query = f.calls.at(-1)!.input as WfdRecord;
  assert.deepEqual(query.fields, ['amount']);
  assert.equal(query.dataset_id, 'actual_dataset');
  assert.equal(query.history_mode, 'snapshot_contents');
  assert.equal(query.snapshot_id, 's_fixture');
  assert.deepEqual((selected.result.rows as WfdRecord[])[0]!.business_time, { status: 'unknown' });
});

test('explicit projection rejects duplicate, empty and undiscovered fields without dispatching a product read', async () => {
  const f = fixture();
  for (const fields of [[], ['amount', 'amount'], ['amount', 'not_declared'], [''], ['/tmp/path'], null, 'amount']) {
    await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture', fields }), isCode('R1_READ_FIELDS'));
  }
  assert.equal(f.calls.some(call => call.operation === 'read_product'), false);
});

test('selected projection rejects a different response projection and preserves cursor mismatch errors', async () => {
  const f = fixture();
  f.state.changeResult = result => { result.fields = ['amount', 'label']; };
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture', fields: ['amount'] }), isCode('R1_READ_RESPONSE_INVALID'));
  f.state.error = new WfdProductMachineError('WFD_PRODUCT_MACHINE_REJECTED', 'query mismatch', {
    operation: 'read_product', requestId: 'fixture', remoteCode: 'CURSOR_QUERY_MISMATCH' });
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture', fields: ['label'], cursor: 'previous-query-cursor' }), isCode('CURSOR_QUERY_MISMATCH'));
});


test('historical reads explicitly bind mode, UTC cutoff, scope and stage to the existing WFD request', async () => {
  const f = fixture();
  const at = '2025-04-01T02:03:04Z';
  const market = await f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture', historyMode: 'market_known_at', at });
  assert.equal(market.historyMode, 'market_known_at');
  const wire = f.calls.find(call => call.operation === 'read_product')!.input as WfdRecord;
  assert.deepEqual(wire.knowledge_cutoff, { status: 'known', precision: 'second', earliest_utc: at,
    latest_exclusive_utc: '2025-04-01T02:03:05Z', source_timezone: 'UTC' });
  assert.equal(wire.held_scope, null);
  for (const usableStage of ['acquired', 'custodied', 'published_readable'] as const) {
    const result = await f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture',
      historyMode: 'system_held_at', at, heldScope: 'isolated-instance', usableStage });
    assert.equal(result.result.usable_stage, usableStage);
    assert.equal(result.result.held_scope, 'isolated-instance');
  }
  assert.ok(f.calls.every(call => ['contract_discovery', 'read_product'].includes(call.operation)),
    'Historical reads never submit, calculate or publish');
});

test('invalid or ambiguous historical requests fail before discovery without date-to-midnight conversion', async () => {
  const f = fixture(), base = { snapshotId: 's_fixture', productId: 'p_fixture' };
  const wrong = [
    { at: '2025-01-01T00:00:00Z' }, { historyMode: 'market_known_at' },
    ...['2025-01-01', '2025-02-30T00:00:00Z', '2025-01-01T00:00:00', '2025-01-01T00:00:00.123Z']
      .map(at => ({ historyMode: 'market_known_at', at })),
    { historyMode: 'unknown' },
    { historyMode: 'system_held_at', at: '2025-01-01T00:00:00Z' },
    { historyMode: 'system_held_at', at: '2025-01-01T00:00:00Z', heldScope: 'i', usableStage: 'latest' },
    { historyMode: 'market_known_at', at: '2025-01-01T00:00:00Z', heldScope: 'i' },
  ];
  for (const item of wrong) await assert.rejects(f.reader.readProduct({ ...base, ...item }), isCode('R1_READ_INPUT'));
  assert.deepEqual(f.calls, []);
});

test('unsupported history contracts never silently fall back to snapshot contents', async () => {
  const f = fixture();
  f.state.products[0]!.contracts = { read: { perspectives: ['snapshot_contents'] } };
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture',
    historyMode: 'market_known_at', at: '2025-04-01T00:00:00Z' }), isCode('R1_READ_HISTORY_UNSUPPORTED'));
  assert.deepEqual(f.calls.map(call => call.operation), ['contract_discovery']);
});

for (const key of ['history_mode', 'knowledge_cutoff', 'held_scope', 'usable_stage'])
  test('historical read rejects a mismatched actual response: ' + key, async () => {
    const f = fixture();
    f.state.changeResult = result => { result[key] = key === 'usable_stage' ? 'acquired' : 'foreign'; };
    await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture',
      historyMode: 'system_held_at', at: '2025-04-01T00:00:00Z', heldScope: 'i', usableStage: 'published_readable' }),
    isCode('R1_READ_RESPONSE_INVALID'));
    assert.equal(f.calls.filter(call => call.operation === 'read_product').length, 1, 'No fallback or automatic retry');
  });


test('market reconstruction cannot reuse predecessor public time for a data-only withdrawal', async () => {
  const f = fixture();
  f.state.changeResult = result => { result.diagnostics = [{ decision: 'ineligible', reason: 'WITHDRAWN_AT_PERSPECTIVE' }]; };
  await assert.rejects(f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture',
    historyMode: 'market_known_at', at: '2025-02-01T00:00:00Z' }), isCode('R1_READ_REVISION_TIME_UNSUPPORTED'));
  const snapshot = await f.reader.readProduct({ snapshotId: 's_fixture', productId: 'p_fixture' });
  assert.equal(snapshot.historyMode, 'snapshot_contents', 'Fixed snapshot inspection remains available');
});

for (const code of ['FIELD_NOT_DEFINED_IN_ROW_CONTRACT', 'PRODUCT_CONTRACT_UNAVAILABLE']) {
  test('history rejects unresolved fixed metadata: ' + code, async () => {
    const f = fixture();
    f.state.changeResult = result => { result.diagnostics = [{ decision: 'indeterminate', code }]; };
    const base = { snapshotId: 's_fixture', productId: 'p_fixture' };
    for (const history of [{ historyMode: 'market_known_at' },
      { historyMode: 'system_held_at', heldScope: 'i', usableStage: 'published_readable' }]) {
      await assert.rejects(f.reader.readProduct({ ...base, ...history, at: '2025-04-01T00:00:00Z' }),
        isCode('R1_READ_HISTORY_METADATA_UNSUPPORTED'));
    }
    assert.equal((await f.reader.readProduct(base)).historyMode, 'snapshot_contents');
    assert.equal(f.calls.filter(call => call.operation === 'read_product').length, 3, 'No fallback or retry');
  });
}
