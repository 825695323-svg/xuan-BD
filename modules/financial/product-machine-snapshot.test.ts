import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { AlgorithmSnapshotReference } from './algorithm-types.js';
import { inspectProductMachineSemantics } from './product-machine-snapshot.js';

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
