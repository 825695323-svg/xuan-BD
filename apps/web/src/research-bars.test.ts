import assert from 'node:assert/strict';
import test from 'node:test';
import type { R1ProductDiscovery } from '../../../contracts/r1-contracts';
import { RESEARCH_FIELDS, chartBars, researchProducts } from './research-bars.js';

const selection = { productId: 'price', datasetId: 'test', subject: { kind: 'instrument', namespace: 'synthetic-test', id: 'EXAMPLE' },
  payloadKind: 'tabular_rows', fields: [...RESEARCH_FIELDS], readable: true, reason: null };
const contract = { product_id: selection.productId, dataset_id: selection.datasetId, logical_domain: 'observations',
  declaration: { time_role: 'observation', semantic_context: { content_nature: 'observed_fact',
    time: { frequency: 'day', interval: 'half_open', timezone: 'Asia/Shanghai' }, statistical: { price_basis: 'nominal' },
    financial: { price_adjustment: { direction: 'raw' } } },
  field_definitions: RESEARCH_FIELDS.map(field_code => ({ field_code, data_type: 'decimal', unit_code: 'cny_per_share',
    measurement_nature: 'stock', time_role: 'observation' })) } };
const discovery = { selections: [selection], products: [contract] } satisfies Pick<R1ProductDiscovery, "selections" | "products">;
const [product] = researchProducts(discovery);

function row(start: string, end: string) {
  return { business_time: { status: 'known', earliest_utc: start, latest_exclusive_utc: end }, values: Object.fromEntries(
    RESEARCH_FIELDS.map((code, index) => [code, { value: ['100', '102', '98', '101'][index], value_state: 'valid_value', data_type: 'decimal',
      unit: { resolved: true, unit_code: 'cny_per_share', digest: 'sha256:' + 'a'.repeat(64) } }])) };
}

test('research catalog uses only a unique readable fixed instrument price contract with shared OHLC semantics', () => {
  assert.equal(product?.unit, 'cny_per_share');
  assert.deepEqual(researchProducts({ ...discovery, products: [contract, contract] }), []);
  assert.deepEqual(researchProducts({ ...discovery, selections: [{ ...selection, readable: false }] }), []);
  assert.deepEqual(researchProducts({ ...discovery, products: [{ ...contract, declaration: { time_role: 'observation' } }] }), []);
  assert.deepEqual(researchProducts({ ...discovery, products: [{ ...contract, dataset_id: 'different' }] }), []);
});

test('research plots verified numeric bars at their actual UTC positions and never fills missing data', () => {
  const a = row('2026-04-06T00:00:00Z', '2026-04-07T00:00:00Z');
  const missing = row('2026-04-07T00:00:00Z', '2026-04-08T00:00:00Z');
  missing.values.close!.value_state = 'not_yet_known';
  const c = row('2026-04-09T00:00:00Z', '2026-04-10T00:00:00Z');
  const result = chartBars([c, missing, a], product!);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.bars.map(item => item.time), [Date.parse(a.business_time.earliest_utc) / 1000, Date.parse(c.business_time.earliest_utc) / 1000]);
  assert.deepEqual(result.bars[0], { time: Date.parse(a.business_time.earliest_utc) / 1000, end: Date.parse(a.business_time.latest_exclusive_utc) / 1000, open: 100, high: 102, low: 98, close: 101 });
});

test('research rejects ambiguous interval or unit definitions without treating them as zero', () => {
  const a = row('2026-04-06T00:00:00Z', '2026-04-07T00:00:00Z');
  assert.deepEqual(chartBars([a, a], product!), { skipped: 0, conflict: true, bars: [] });
  const b = row('2026-04-07T00:00:00Z', '2026-04-08T00:00:00Z');
  for (const cell of Object.values(b.values)) cell.unit.digest = 'sha256:' + 'b'.repeat(64);
  assert.equal(chartBars([a, b], product!).conflict, true);
  b.values.open!.unit.resolved = false;
  assert.equal(chartBars([b], product!).skipped, 1);
});
