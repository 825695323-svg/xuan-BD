import assert from 'node:assert/strict';
import test from 'node:test';
import { ALGORITHM_METHODS, type AlgorithmComputedResult } from './algorithm-types.js';
import { checkDerivedForWfd } from './derived-wfd-check.js';
import { buildStructuredIngestDocument } from '../collection/r1-structured-handoff.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';

const sample = (): AlgorithmComputedResult => ({
  status: 'computed', taskId: 'test-derivation-1', methodId: 'ma',
  methodVersion: ALGORITHM_METHODS.ma.version,
  implementationVersion: 'sha256:' + '1'.repeat(64), inputDigest: 'sha256:' + '2'.repeat(64),
  environment: 'synthetic-test', parameters: { period: 5 }, computedAt: '2026-11-10T09:00:00Z',
  metadata: { frequency: '1d', timezone: 'UTC', window_start: '2026-11-01', window_end: '2026-11-01' },
  coverage: { suppliedRows: 1 },
  eligibility: { input: { status: 'eligible' } },
  rows: [{ timestamp: '2026-11-01', available_at: '2026-11-01T23:59:59Z', MA: 12.5 }],
  source: { kind: 'wfd_fixed_snapshot', productId: 'p_test', snapshotId: 'snap_test',
    definitionRevision: 'def1', fieldMapping: { close: 'close' },
    resolution: { productId: 'p_test', snapshotId: 'snap_test', rowCount: 1,
      fields: { definitions: [{ field_code: 'close', data_type: 'decimal', unit_code: 'cny_per_share' }] },
      envelope: { rows: [{ business_key: 'b_1', subject: { kind: 'instrument', namespace: 'test', id: 's1' },
        observation_time: { status: 'known', precision: 'day', earliest_utc: '2026-11-01T00:00:00Z',
          latest_exclusive_utc: '2026-11-02T00:00:00Z', source_timezone: 'UTC' } }] } } },
}) as unknown as AlgorithmComputedResult;
const binding = { namespace: 'bd.test', mode: 'user_test' as const, expectedParentSnapshotId: 'snap_head' };

test('固定算法只做一次独立核对即可生成完整的结构化 WFD 提交记录', () => {
  const valid = checkDerivedForWfd(sample(), binding, 'derived-1');
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
  assert.throws(() => checkDerivedForWfd(invalid, binding, 'derived-1'), {
    code: 'DERIVED_TIME_MISMATCH',
  });
});

test('合成算法结果不能作为生产数据入 WFD', () => {
  assert.throws(() => checkDerivedForWfd(sample(), { ...binding, mode: 'production' }, 'derived-1'), {
    code: 'DERIVED_SYNTHETIC_FORBIDDEN',
  });
});

test('缺真实 WFD 行身份及单位时拒绝发布', () => {
  const missing = sample();
  const resolution = (missing.source as Record<string, unknown>).resolution as Record<string, unknown>;
  resolution.envelope = { rows: [] };
  assert.throws(() => checkDerivedForWfd(missing, binding, 'derived-1'), {
    code: 'DERIVED_SOURCE_INVALID',
  });
});

test('不同窗口参数不复用同一派生产品定义', () => {
  const left = checkDerivedForWfd(sample(), binding, 'derived-1');
  const other = sample();
  other.parameters = { period: 10 };
  const right = checkDerivedForWfd(other, binding, 'derived-2');
  assert.notEqual(left.structured.outputKey, right.structured.outputKey);
});
