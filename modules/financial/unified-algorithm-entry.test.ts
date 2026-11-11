import assert from 'node:assert/strict';
import test from 'node:test';
import type { AlgorithmCatalogView } from './algorithm-types.js';
import { basicAlgorithmToolContract, bdSessionToolContract,
  isUnmigratedLegacyAlgorithmMethod, LEGACY_FIXED_METHOD_ALIASES } from './basic-algorithm-tool-contract.js';
import { FixedCalculationService } from '../collection/fixed-calculation-service.js';

const catalog = { methods: [
  { id: 'ma', title: 'MA', status: 'ready', reason: null, methodVersion: 'ma/full-window-v1',
    implementationVersion: 'known-python-digest', parameters: { period: 5 }, requiredFields: ['timestamp', 'close'],
    outputFields: ['MA'], limitations: [] },
] } as unknown as AlgorithmCatalogView;

test('a single algorithms.calculate catalogue exposes historical Polars methods as blocked and never duplicates MA', () => {
  const directory = basicAlgorithmToolContract(catalog);
  const methods = directory.methods;
  assert.equal(directory.calculateAction, 'algorithms.calculate');
  assert.equal(methods.filter(x => x.methodId === 'ma').length, 1);
  assert.equal(methods.filter(x => x.methodId === 'source_observation_ma').length, 1);
  assert.equal(methods.find(x => x.methodId === 'ma')!.status, 'ready');
  for (const methodId of ['source_observation_ma', 'financial_linear', 'macro_yoy']) {
    const method = methods.find(x => x.methodId === methodId)!;
    assert.ok(method, methodId);
    assert.equal(method.status, 'blocked', 'No old Polars side effect can be falsely advertised ready');
    assert.equal(method.interface, 'algorithms.calculate');
    assert.equal(method.input.kind, 'fixed_snapshot');
    assert.match(method.reason!, /WFD/u);
  }
  assert.equal(methods.some(x => x.methodId === 'observation_ma20'), false,
    'Legacy fixed-window identity is represented as one migration alias, never a new calculation method');
  assert.equal((methods.find(x => x.methodId === 'source_observation_ma') as any).legacyMethodId, 'observation_ma20');
  assert.equal(basicAlgorithmToolContract(catalog, 'macro_yoy').methods.length, 1);
  assert.equal(basicAlgorithmToolContract(catalog, 'observation_ma20').unknownMethod, true,
    'Legacy raw name cannot open a second new-work intake');
  const session = bdSessionToolContract(catalog);
  assert.equal(session.toolGroups.filter(g => g.id === 'basic_algorithms').length, 1);
  assert.equal(session.toolGroups.find(g => g.id === 'wfd')!.tools.includes('data.r1.submit'), false,
    'Model cannot submit R1 as a way of bypassing independent publisher');
});

test('legacy method alias is classified consistently for central submit guard', () => {
  assert.deepEqual(Object.keys(LEGACY_FIXED_METHOD_ALIASES).sort(),
    ['financial_linear', 'macro_yoy', 'observation_ma20'].sort());
  for (const id of [...Object.keys(LEGACY_FIXED_METHOD_ALIASES),
    ...Object.values(LEGACY_FIXED_METHOD_ALIASES)]) assert.equal(isUnmigratedLegacyAlgorithmMethod(id), true, id);
  for (const id of ['ma', 'macd', 'bullish_engulfing', 'unregistered']) {
    assert.equal(isUnmigratedLegacyAlgorithmMethod(id), false, id);
  }
});

test('legacy Polars service allows historical read but never accepts a new calculation task', async () => {
  let created = 0;
  const history = { task: { id: 'old-task', args: { input: { requestId: 'old', method: 'financial_linear' } },
    status: 'failed', requestId: 'old', version: 1, updatedAt: 42, requiresReview: false,
    error: null, result: null }, candidate: null };
  const service = new FixedCalculationService({
    polars: { capabilities: () => ({ configured: true, dependency: { error: null },
      limits: { inputRows: 5000, inputBytes: 10000, outputBytes: 10000, processTimeoutMs: 5000 } }),
      create: async () => { created++; throw new Error('old Polars service must never be called'); },
      listTaskIds: () => ['old-task'], get: () => history },
  } as unknown as ConstructorParameters<typeof FixedCalculationService>[0]);
  const capabilities = service.capabilities();
  assert.equal(capabilities.configured, false);
  assert.match(capabilities.reason!, /algorithms.calculate/u);
  await assert.rejects(service.create({ method: 'financial_linear', calculation: {} }),
    (error: unknown) => (error as { code?: string }).code === 'ALGORITHM_UNIFIED_ENTRY_ONLY');
  await assert.rejects(service.create({ method: 'macro_yoy', calculation: {} }),
    (error: unknown) => (error as { code?: string }).code === 'ALGORITHM_UNIFIED_ENTRY_ONLY');
  assert.equal(created, 0);
  assert.equal(service.list().length, 1);
  assert.equal(service.get('old-task').methodId, 'financial_linear');
  assert.equal(service.get('old-task').task.id, 'old-task');
});
