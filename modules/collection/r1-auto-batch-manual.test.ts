import assert from 'node:assert/strict';
import test from 'node:test';
import { R1AutoBatchService } from './r1-auto-batch.js';
import type { OperatorContext } from './processing-plan.js';

/** 输入路由在访问数据库和任务服务以前，必须拒绝自动算法参数。 */
test('新原报批次拒绝旧均线参数和算法自动路由，不创建任何任务', () => {
  const service = {} as R1AutoBatchService;
  const source = { source_id: 'test', provider: 'test', requested_url: 'file:///test/',
    requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-01T00:00:00Z',
    usage_scope: 'test', authorization: { status: 'authorized', basis: 'test-only' } };
  const base = { batchId: 'manual-only-test', datasetId: 'test', source, files: [] };
  const operator = {} as OperatorContext;
  assert.throws(() => R1AutoBatchService.prototype.start.call(service,
    { ...base, calculation: { method: 'source_observation_ma', period: 5, valueColumn: 'close' } }, operator),
    { code: 'R1_BATCH_ALGORITHM_MANUAL_ONLY' });
  assert.throws(() => R1AutoBatchService.prototype.start.call(service,
    { ...base, algorithmRouting: { version: 'bd.r1-algorithm-routing/1', settings: {}, files: [] } }, operator),
    { code: 'R1_BATCH_ALGORITHM_MANUAL_ONLY' });
});
