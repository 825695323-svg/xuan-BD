import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { AlgorithmSnapshotReference } from './algorithm-types.js';
import { createWfdProductMachineSnapshotPort, inspectProductMachineSemantics } from './product-machine-snapshot.js';

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
