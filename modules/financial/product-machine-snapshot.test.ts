import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { AlgorithmSnapshotReference } from './algorithm-types.js';
import { createWfdProductMachineSnapshotPort, extractSelectedCells, inspectProductMachineSemantics, matchesVolumeDefinition } from './product-machine-snapshot.js';

const reference: AlgorithmSnapshotReference = {
  kind: 'wfd_fixed_snapshot', instanceId: 'fixture', productId: 'daily', snapshotId: 'snapshot', definitionRevision: 'revision',
  fields: ['date', 'close', 'available_at'],
  fieldMapping: { timestamp: 'date', close: 'close', available_at: 'available_at' },
  calendar: { mode: 'dense' },
  semantics: { subject: 'Synthetic observation', frequency: '1d', timezone: 'UTC', currency: 'CNY',
    priceUnit: 'currency_per_share', adjustment: 'unadjusted', adjustmentBasis: 'WFD financial.price_adjustment.direction=raw',
    barClosed: true, synthetic: true, availability: { kind: 'column' } },
};
const rows: WfdRecord[] = [{ row: { observation_time: { status: 'known', precision: 'day', source_timezone: 'UTC' } } }];

function product(roles: WfdRecord, direction: string, timezone = 'UTC'): WfdRecord {
  return { product_id: 'daily', payload_kind: 'tabular_rows', declaration: {
    field_definitions: [
      { field_code: 'date', data_type: 'text', unit_code: 'date' },
      { field_code: 'close', data_type: 'decimal', unit_code: 'cny_per_share' },
      { field_code: 'available_at', data_type: 'text', unit_code: 'text' },
    ],
    semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
      time: { frequency: 'day', timezone, roles },
      financial: { price_adjustment: { direction } },
    },
  } };
}
const roles = { observation: 'date', availability: 'available_at', bar_closed: 'true' };

test('固定快照投影只将数值列的规范 reported_zero 交给算法为 0，证据保留原值和状态', async () => {
  const volumeReference: AlgorithmSnapshotReference = { ...reference, fields: [...reference.fields, 'volume'],
    fieldMapping: { ...reference.fieldMapping, volume: 'volume' }, semantics: { ...reference.semantics, volumeUnit: 'share' } };
  const identities = { definition_ref: { version: reference.definitionRevision, digest: 'sha256:' + 'd'.repeat(64) },
    contract_ref: { digest: 'sha256:' + 'a'.repeat(64) } };
  const definition = { field_code: 'volume', data_type: 'integer', unit_code: 'share' };
  const discovered = product(roles, 'raw');
  ((discovered.declaration as WfdRecord).field_definitions as WfdRecord[]).push(definition);
  const cell = { value: '0' as unknown, data_type: 'integer', value_state: 'reported_zero' };
  const raw = { ...identities, product_id: reference.productId, row: { ...rows[0].row as WfdRecord,
    values: { date: { value: '2026-01-01', value_state: 'valid_value' }, close: { value: '10', value_state: 'valid_value' },
      available_at: { value: '2026-01-01T16:00:00Z', value_state: 'valid_value' }, volume: cell } } };
  const client = {
    discover: async () => ({ result: { products: [{ ...discovered, ...identities }] }, transport: 'synthetic' }),
    read: async () => ({ result: { snapshot_id: reference.snapshotId, row_count: 1, rows: [raw] }, transport: 'synthetic' }),
  } as unknown as WfdProductMachineClient;
  const port = createWfdProductMachineSnapshotPort({ instanceId: reference.instanceId, client });
  for (const type of ['decimal', 'integer']) for (const zero of ['0', 0]) {
    cell.value = zero;
    cell.data_type = definition.data_type = type;
    const read = await port.read(volumeReference, readContext);
    assert.equal(read.rows[0].volume, 0);
    const inspected = extractSelectedCells([raw], ['volume']);
    assert.deepEqual(inspected.unsafe, []);
    assert.equal(inspected.cells[0].value, zero);
    assert.equal(inspected.cells[0].value_state, 'reported_zero');
  }
  for (const [state, value, type] of [
    ['reported_zero', '1', 'decimal'], ['reported_zero', -1, 'integer'], ['reported_zero', null, 'decimal'],
    ['reported_zero', '0.0', 'decimal'], ['reported_zero', false, 'integer'], ['reported_zero', '0', 'text'],
    ['unknown', '0', 'integer'], ['insufficient_warmup', null, 'decimal'], ['valid_value', null, 'decimal'],
  ] as const) {
    cell.value = value;
    cell.value_state = state;
    cell.data_type = definition.data_type = type;
    await assert.rejects(port.read(volumeReference, readContext), { code: 'ALGORITHM_SNAPSHOT_CELL_STATE_UNSUPPORTED' });
  }
});

test('成交量使用明示的数量单位并与数值字段定义精确匹配', () => {
  for (const unit of ['share', 'shares', 'lot', 'lot_100_shares', 'hand', 'contract', 'unit', 'count', 'volume_shares']) {
    for (const type of ['decimal', 'integer'])
      assert.equal(matchesVolumeDefinition({ data_type: type, unit_code: unit }, unit), true);
  }
  for (const unit of ['cny', 'usd', 'money', 'cny_100million', 'cny_per_share', 'percent', 'ratio', 'bps',
    'text', 'not_applicable', 'volume_usd', 'unknown'])
    assert.equal(matchesVolumeDefinition({ data_type: 'decimal', unit_code: unit }, unit), false);
  assert.equal(matchesVolumeDefinition({ data_type: 'text', unit_code: 'share' }, 'share'), false);
  assert.equal(matchesVolumeDefinition({ data_type: 'decimal', unit_code: 'lot' }, 'share'), false);
});

test('MACD 用 WFD 固定定义的实际语义轴核对未复权收盘价和可得时间列', () => {
  const result = inspectProductMachineSemantics(product(roles, 'raw'), rows, reference);
  assert.equal(result.status, 'supported', result.reason);
  assert.equal(result.effective.adjustment_basis?.value, reference.semantics.adjustmentBasis);
  assert.deepEqual(result.effective.availability?.value, { kind: 'column' });
});

test('MACD 保留未知价格、收盘和可得时间的缺口，拒绝与逐行时区不符的声明', () => {
  const result = inspectProductMachineSemantics(
    product({ observation: 'date', availability: 'another_field' }, 'unknown', 'Asia/Shanghai'), rows, reference);
  assert.equal(result.status, 'unsupported');
  for (const missing of ['adjustment', 'bar_closed', 'availability']) assert.ok(result.missing.includes(missing));
  assert.ok(result.mismatches.some(item => item.includes('fixed observation timezone')));
  const guessed = structuredClone(reference);
  guessed.semantics.availability = { kind: 'bar_close', closeTime: '15:00' };
  assert.equal(inspectProductMachineSemantics(product(roles, 'raw'), rows, guessed).status, 'unsupported');
});


function holdingPort(mutate: (result: WfdRecord) => void) {
  let calls = 0;
  const client = {
    discover: async () => ({ result: { products: [{ product_id: 'daily' }] } }),
    read: async () => {
      calls++;
      const result: WfdRecord = { snapshot_id: 'snapshot', perspective: 'system_held_at', at: '2025-02-01T00:00:00Z',
        held_scope: 'instance-a', usable_stage: 'published_readable', row_count: 1,
        rows: [{ product_id: 'daily', held_scope: 'instance-a', usable_stage: 'published_readable', held_at: '2025-01-15T00:00:00Z' }] };
      mutate(result); return { result };
    },
  } as unknown as WfdProductMachineClient;
  return { port: createWfdProductMachineSnapshotPort({ client, instanceId: 'fixture' }), calls: () => calls };
}
const heldReference: AlgorithmSnapshotReference = { ...reference, perspective: 'system_held_at', at: '2025-02-01T00:00:00Z',
  heldScope: 'instance-a', usableStage: 'published_readable' };
const readContext = { signal: new AbortController().signal };

for (const [scope, field, value] of [
  ['result', 'held_scope', 'other-instance'], ['result', 'usable_stage', 'acquired'],
  ['row', 'held_scope', 'other-instance'], ['row', 'usable_stage', 'custodied'], ['row', 'usable_stage', null],
]) test(`algorithm history binds ${scope} ${field} to actual stage evidence`, async () => {
  const f = holdingPort(result => {
    const target = scope === 'row' ? (result.rows as WfdRecord[])[0]! : result;
    target[field!] = value;
  });
  await assert.rejects(f.port.read(heldReference, readContext), { code: 'ALGORITHM_SNAPSHOT_HOLDING_MISMATCH' });
  assert.equal(f.calls(), 1);
});

test('algorithm history requires explicit cutoff, scope and stage before reading', async () => {
  const f = holdingPort(() => {});
  for (const change of [{ at: undefined }, { at: '2025-02-30T00:00:00Z' }, { at: '2025-01-01' },
    { heldScope: undefined }, { usableStage: undefined }, { snapshotId: 'latest' },
    { perspective: 'snapshot_contents' as const }]) {
    await assert.rejects(f.port.read({ ...heldReference, ...change }, readContext), { code: 'ALGORITHM_SNAPSHOT_INVALID' });
  }
  assert.equal(f.calls(), 0);
});


test('algorithm history refuses unresolved public or withdrawal evidence rather than computing partial eligible rows', async () => {
  const f = holdingPort(result => { result.diagnostics = [{ decision: 'indeterminate', reason: 'WITHDRAWAL_PUBLIC_TIME_UNKNOWN' }]; });
  await assert.rejects(f.port.read(heldReference, readContext), { code: 'ALGORITHM_SNAPSHOT_HISTORY_INCOMPLETE' });
  assert.equal(f.calls(), 1);
});


test('algorithm market history rejects a withdrawal without independent publication-time evidence', async () => {
  const f = holdingPort(result => { result.perspective = 'market_known_at';
    result.diagnostics = [{ decision: 'ineligible', reason: 'WITHDRAWN_AT_PERSPECTIVE' }]; });
  await assert.rejects(f.port.read({ ...reference, perspective: 'market_known_at', at: '2025-02-01T00:00:00Z' }, readContext),
    { code: 'ALGORITHM_SNAPSHOT_HISTORY_INCOMPLETE' });
});
