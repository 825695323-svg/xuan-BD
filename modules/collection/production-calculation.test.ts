import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProductionCalculation } from './production-calculation.js';

const code = (value: string) => (error: unknown) => (error as { code?: string }).code === value;
const request = (methodId: string) => ({ methodId, source: { kind: 'fixed_snapshot' },
  calculation: { version: 'trusted-only' }, usage: { purpose: 'current_compute' } });

test('calculation belongs to production: one method registry selects default Polars without new task or publisher', async () => {
  let polarsCalls = 0, legacyCalls = 0, publishCalls = 0;
  const polars = {
    capabilities: () => ({ status: 'ready', reason: null, version: 'bd.algorithms.polars/1',
      methods: ['financial_linear','macro_yoy'] }),
    submit: (id: string, input: unknown) => {
      assert.equal(id, 'production-task'); assert.deepEqual(input, request('macro_yoy'));
      polarsCalls++; return { taskId: 'original-task-id' };
    },
    view: () => ({ status: 'succeeded' }),
    owns: () => true,
  };
  const gateway = new ProductionCalculation({ polars: polars as never,
    legacy: { submit: () => { legacyCalls++; return { taskId: 'legacy-original-id' }; }, view: () => ({}) } as never,
    publisher: { publish: async (taskId: string) => {
      assert.equal(taskId, 'original-task-id'); publishCalls++;
      return { requestId: 'r1-original', state: 'associated', published: true, requiresRecovery: false,
        fixedReadback: true, error: null };
    } } as never,
  });
  const capabilities = gateway.capabilities();
  assert.equal(capabilities.owner, 'data_production');
  assert.deepEqual(capabilities.engines.map(item => item.id), ['polars','pandas']);
  assert.equal(capabilities.engines[0]?.status, 'ready');
  assert.equal(capabilities.engines[1]?.status, 'blocked');
  assert.equal(capabilities.methods.find(item => item.methodId === 'macro_yoy')?.status, 'ready');
  assert.equal(capabilities.methods.find(item => item.methodId === 'source_observation_ma')?.status, 'blocked');
  assert.equal(gateway.submit('production-task', request('macro_yoy')).taskId, 'original-task-id');
  assert.equal((await gateway.publish('original-task-id')).fixedReadback, true);
  assert.equal(polarsCalls, 1); assert.equal(publishCalls, 1); assert.equal(legacyCalls, 0);
});

test('unmigrated source MA and missing pandas refuse new jobs, no silent fallback or caller engine override', () => {
  let calls = 0;
  const gateway = new ProductionCalculation({ polars: {
    capabilities: () => ({ status: 'ready', reason: null, version: 'pinned',
      methods: ['financial_linear','macro_yoy'] }),
    submit: () => { calls++; throw Error('must not run'); },
    view: () => ({}), owns: () => false,
  } as never });
  assert.throws(() => gateway.submit('attempt', request('source_observation_ma')),
    code('PRODUCTION_CALCULATION_NOT_READY'));
  assert.throws(() => gateway.submit('attempt', { ...request('macro_yoy'), engine: 'pandas' }),
    code('PRODUCTION_CALCULATION_INPUT'));
  assert.throws(() => gateway.submit('attempt', request('not_registered')),
    code('PRODUCTION_CALCULATION_METHOD'));
  assert.equal(calls, 0);
});

test('pandas is an explicit trusted adapter for future registered formulas, not a fallback for failed Polars', () => {
  const calls: string[] = [];
  const gateway = new ProductionCalculation({
    pandasFormulas: [{ methodId: 'third_party_stat', engine: 'pandas', description: '受信统计库兼容' }],
    pandas: {
      capabilities: () => ({ status: 'ready', reason: null, methods: ['third_party_stat'], version: 'pandas.adapter/pinned' }),
      submit: (id, _) => { calls.push(id); return { taskId: 'original-stat-task' }; },
    },
  });
  assert.equal(gateway.capabilities().methods.find(item => item.methodId === 'third_party_stat')?.status, 'ready');
  assert.equal(gateway.submit('stat-request', request('third_party_stat')).taskId, 'original-stat-task');
  assert.deepEqual(calls, ['stat-request']);
  assert.throws(() => gateway.submit('unsupported', request('financial_linear')),
    code('PRODUCTION_CALCULATION_NOT_READY'));
});
