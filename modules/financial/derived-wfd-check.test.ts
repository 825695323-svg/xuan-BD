import assert from 'node:assert/strict';
import test from 'node:test';
import { ALGORITHM_METHODS, type AlgorithmComputedResult, type AlgorithmData } from './algorithm-types.js';
import { checkDerivedForWfd } from './derived-wfd-check.js';
import { buildStructuredIngestDocument } from '../collection/r1-structured-handoff.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';

const sample = (): AlgorithmComputedResult => ({
  status: 'computed', taskId: 'test-derivation-1', methodId: 'ma',
  methodVersion: ALGORITHM_METHODS.ma.version,
  implementationVersion: 'sha256:' + '1'.repeat(64), inputDigest: 'sha256:' + '2'.repeat(64),
  environment: 'synthetic-test', parameters: { period: 1 }, computedAt: '2026-11-10T09:00:00Z',
  metadata: { ...frozenInput().metadata },
  coverage: { suppliedRows: 1 },
  eligibility: { input: { status: 'eligible' } },
  rows: [{ timestamp: '2026-11-01', available_at: '2026-11-01T23:59:59Z', MA: 12.5 }],
  source: { kind: 'wfd_fixed_snapshot', instanceId: 'instance_test',
    productId: 'p_test', snapshotId: 'snap_test',
    definitionRevision: 'def1', fieldMapping: { close: 'close' },
    resolution: { instanceId: 'instance_test', productId: 'p_test', snapshotId: 'snap_test', rowCount: 1,
      fields: { definitions: [{ field_code: 'close', data_type: 'decimal', unit_code: 'cny_per_share' }] },
      envelope: { rows: [{ business_key: 'b_1', subject: { kind: 'instrument', namespace: 'test', id: 's1' },
        observation_time: { status: 'known', precision: 'day', earliest_utc: '2026-11-01T00:00:00Z',
          latest_exclusive_utc: '2026-11-02T00:00:00Z', source_timezone: 'UTC' } }] } } },
}) as unknown as AlgorithmComputedResult;
const binding = { namespace: 'bd.test', mode: 'user_test' as const, expectedParentSnapshotId: 'snap_head' };
const frozenInput = (): AlgorithmData => ({ metadata: {
  series_id: 'series-1', subject: 'stock-1', frequency: '1d', timezone: 'UTC',
  price_unit: 'currency_per_share', currency: 'CNY', adjustment: 'unadjusted',
  adjustment_basis: 'original', window_start: '2026-11-01', window_end: '2026-11-01',
  as_of: '2026-11-10T09:00:00Z', availability_basis: 'explicit_per_bar',
  bar_closed: true, observations_are_consecutive: true, calendar_verification: 'dense', synthetic: true },
  rows: [{ timestamp: '2026-11-01', close: 12.5, available_at: '2026-11-01T23:59:59Z', bar_closed: true }],
});


test('固定算法只做一次独立核对即可生成完整的结构化 WFD 提交记录', () => {
  const valid = checkDerivedForWfd(sample(), binding, 'derived-1', frozenInput());
  const doc = buildStructuredIngestDocument(valid.structured);
  assert.equal(doc.protocol_version, 'wfd.structured-ingest/1.0');
  assert.equal(valid.structured.expectedParentSnapshotId, 'snap_head');
  assert.equal(valid.structured.payload.kind, 'tabular_rows');
  const row = (valid.structured.payload.rows as Array<Record<string, unknown>>)[0]!;
  const cells = row.values as Record<string, { data_type: string; value_state: string; value: unknown }>;
  assert.deepEqual(cells.MA, { data_type: 'decimal', value_state: 'valid_value', value: '12.5' });
  assert.ok(row.business_key);
  assert.equal(valid.source.sha256, wfdSha256(valid.originalBytes));
  assert.equal(valid.structured.definition.measurement_nature, 'derived');
  assert.equal((valid.structured.definition.semantic_context as Record<string, unknown>).content_nature, 'deterministic_derived');
});

test('业务日期与真实固定快照不一致时拒绝入库', () => {
  const invalid = sample();
  invalid.rows[0]!.timestamp = '2026-11-02';
  assert.throws(() => checkDerivedForWfd(invalid, binding, 'derived-1', frozenInput()), (error: unknown) =>
    (error as { code?: string }).code === 'DERIVED_NUMERIC_MISMATCH'
      && /时间/.test(String((error as { message?: string }).message)),
    '独立核验应在原 WFD 时间映射前阻断被篡改的日期');
});

test('合成算法结果不能作为生产数据入 WFD', () => {
  assert.throws(() => checkDerivedForWfd(sample(), { ...binding, mode: 'production' }, 'derived-1', frozenInput()), {
    code: 'DERIVED_SYNTHETIC_FORBIDDEN',
  });
});

test('缺真实 WFD 行身份及单位时拒绝发布', () => {
  const missing = sample();
  const resolution = (missing.source as Record<string, unknown>).resolution as Record<string, unknown>;
  resolution.envelope = { rows: [] };
  assert.throws(() => checkDerivedForWfd(missing, binding, 'derived-1', frozenInput()), {
    code: 'DERIVED_SOURCE_INVALID',
  });
});

test('不同窗口参数不复用同一派生产品定义', () => {
  const left = checkDerivedForWfd(sample(), binding, 'derived-1', frozenInput());
  const other = sample();
  other.parameters = { period: 10 };
  other.rows[0]!.MA = null;
  const right = checkDerivedForWfd(other, binding, 'derived-2', frozenInput());
  assert.notEqual(left.structured.outputKey, right.structured.outputKey);
});

test('独立数值核对拒绝计算正确性被篡改的 MA 输出', () => {
  const altered = sample();
  altered.rows[0]!.MA = 99;
  assert.throws(() => checkDerivedForWfd(altered, binding, 'derived-bad', frozenInput()), {
    code: 'DERIVED_NUMERIC_MISMATCH',
  });
});
