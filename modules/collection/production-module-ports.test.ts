import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRODUCTION_MODULE_IDS, ProductionModulePorts } from './production-module-ports.js';

const failCode = (code: string) => (error: unknown) =>
  (error as { code?: string }).code === code;
const signal = () => new AbortController().signal;

function sample(options: { disabled?: Record<string, boolean>; wfd?: boolean } = {}) {
  const calls: string[] = [];
  const processing = {
    moduleStatus: (kind: string) => ({ available: true, reason: null, implementation: 'frozen.' + kind }),
    get: (planId: string) => ({ planId, steps: [
      { stepId: 'parse:one', kind: 'parse' }, { stepId: 'clean:one', kind: 'clean' },
    ] }),
    executeStep: (_planId: string, stepId: string) => { calls.push('stage:' + stepId); return { id: 'real_task' }; },
  };
  const calculation = {
    capabilities: () => ({ version: 'bd.production-calculation/1',
      methods: [{ methodId: 'source_observation_ma', status: 'ready' },
        { methodId: 'financial_linear', status: 'ready' }] }),
    submit: (_id: string, _raw: unknown) => { calls.push('calculate'); return { taskId: 'existing_calc_task' }; },
    publish: async () => { calls.push('publish'); return { published: true, requestId: 'r1_task' }; },
  };
  const connection = { connectionId: 'trusted-wfd-read' };
  const wfd = {
    capabilities: () => ({ configuration: { state: options.wfd === false ? 'not_configured' : 'ready',
      reason: options.wfd === false ? 'disabled' : null }, connection: options.wfd === false ? null : connection }),
    async discoverProducts({ snapshotId }: { snapshotId: string }) {
      calls.push('discover:' + snapshotId);
      return { products: [
        { product_id: 'product_one', dataset_id: 'dataset_1',
          subject: { kind: 'entity', namespace: 'SSE', id: 'company_1' },
          declaration: { semantic_code: 'company.revenue', unit_code: 'cny',
            field_definitions: [{ field_code: 'value', data_type: 'decimal' }] } },
        { product_id: 'product_two', dataset_id: 'dataset_2',
          subject: { kind: 'region', namespace: 'CN', id: 'CN' },
          declaration: { semantic_code: 'macro.gdp', unit_code: 'cny' } },
      ], connection };
    },
    async readProduct({ snapshotId, productId }: { snapshotId: string; productId: string }) {
      calls.push('read:' + snapshotId + '/' + productId);
      return { snapshotId, productId, connection,
        result: { page: { has_more: false, next_cursor: null }, rows: [
          { record_ref: { logical_key: 'fixed-key', revision_id: 'fixed-r1' },
            values: { value_decimal: { value: '123.000', value_state: 'valid_value' } } },
        ] } };
    },
  };
  return { calls, ports: new ProductionModulePorts({ processing: processing as never,
    calculation: calculation as never, wfd: wfd as never,
    ...(options.disabled ? { enabledModules: options.disabled as never } : {}) }) };
}

test('eight separate discoverable, equal and removable module ports have distinct actions', () => {
  const { ports, calls } = sample();
  const descriptor = ports.capabilities();
  assert.equal(PRODUCTION_MODULE_IDS.length, 8);
  assert.deepEqual(descriptor.modules.map(x => x.id), [
    'parse', 'clean', 'structure', 'annotate', 'check', 'calculate',
    'factor_library', 'semantic_dictionary',
  ]);
  assert.equal(new Set(descriptor.modules.map(x => x.action)).size, 8);
  assert.ok(descriptor.modules.every(x => x.status === 'ready'));
  assert.equal(descriptor.automaticCrossTrigger, false);
  assert.equal(descriptor.publication, 'existing_R1_WFD');
  assert.deepEqual(calls, [], 'Discovery must not trigger computation, parsing or publication');
});

test('each stage executes only a frozen matching step and cannot silently run adjacent stages', () => {
  const { ports, calls } = sample();
  assert.throws(() => ports.stage('parse', 'original-plan', 'clean:one', { requestId: 'r', operatorId: 'service' } as never),
    failCode('PRODUCTION_MODULE_STEP_MISMATCH'));
  assert.equal(calls.length, 0);
  assert.equal(ports.stage('parse', 'original-plan', 'parse:one',
    { requestId: 'r', operatorId: 'service' } as never).id, 'real_task');
  assert.deepEqual(calls, ['stage:parse:one']);
  assert.throws(() => ports.stage('clean', 'original-plan', 'parse:one', { requestId: 'r', operatorId: 'service' } as never),
    failCode('PRODUCTION_MODULE_STEP_MISMATCH'));
});

test('unplugging one stage or calculation does not remove factor definitions, dictionary or old records', async () => {
  const { ports, calls } = sample({ disabled: { clean: false, calculate: false } });
  assert.equal(ports.capability('clean').status, 'blocked');
  assert.equal(ports.capability('calculate').status, 'blocked');
  assert.equal(ports.capability('parse').status, 'ready');
  assert.equal(ports.capability('factor_library').status, 'ready');
  assert.equal(ports.capability('semantic_dictionary').status, 'ready');
  assert.throws(() => ports.stage('clean', 'original-plan', 'clean:one', { requestId: 'r', operatorId: 'service' } as never),
    failCode('PRODUCTION_MODULE_DISABLED'));
  assert.throws(() => ports.calculate('r', { methodId: 'financial_linear' }),
    failCode('PRODUCTION_MODULE_DISABLED'));
  const found = await ports.semanticLookup({ snapshotId: 'snapshot_2026', semanticCode: 'company.revenue' }, signal());
  assert.equal(found.count, 1);
  assert.deepEqual(calls, ['discover:snapshot_2026']);
});

test('factor library reuses frozen source definitions, never falsely treats a draft as executable', () => {
  const { ports, calls } = sample();
  const index = ports.factorCatalog();
  assert.ok(index.definitionCount > 0);
  assert.equal(index.scope, 'read_only');
  assert.equal(index.notProofOfAdoption, true);
  assert.ok(index.fixedMethods.some(x => x.id === 'source_observation_ma'));
  assert.ok(index.definitions.some(x => x.registryId === 'ma'));
  const exact = ports.factorCatalog('ma');
  assert.equal(exact.definitions.length, 1);
  assert.ok(Array.isArray(exact.definitions[0]?.formula));
  assert.throws(() => ports.factorCatalog('invented.factor'), failCode('PRODUCTION_FACTOR_UNKNOWN'));
  assert.deepEqual(calls, []);
});

test('semantic dictionary reads actual pinned WFD declarations and never self-adopts templates', async () => {
  const { ports, calls } = sample();
  const result = await ports.semanticLookup({ snapshotId: 'snapshot_2026', productId: 'product_one' }, signal());
  assert.equal(result.authority, 'WFD_published_snapshot');
  assert.equal(result.historyMode, 'snapshot_contents');
  assert.equal(result.templatesNotAcceptedAsFacts, true);
  assert.equal(result.count, 1);
  assert.equal(result.definitions[0]?.declaration.semantic_code, 'company.revenue');
  assert.equal(result.definitions[0]?.declaration.unit_code, 'cny');
  assert.deepEqual(calls, ['discover:snapshot_2026']);
  await assert.rejects(ports.semanticLookup({ snapshotId: 'latest' }, signal()), failCode('PRODUCTION_SEMANTIC_INPUT'));
});

test('all eight modules use one authorized, bounded WFD read-only port; no implicit execution', async () => {
  const { ports, calls } = sample();
  const selected = { snapshotId: 'snapshot_2026', productId: 'product_one',
    fields: ['value_decimal'] };
  for (const moduleId of PRODUCTION_MODULE_IDS) {
    const result = await ports.readWfd(moduleId, selected, signal());
    assert.equal(result.mode, 'read_only');
    assert.equal(result.moduleId, moduleId);
    assert.equal(result.snapshotId, selected.snapshotId);
    assert.equal(result.response.result.rows[0].record_ref.revision_id, 'fixed-r1');
  }
  assert.equal(calls.filter(x => x.startsWith('read:')).length, 8);
  assert.equal(calls.includes('calculate'), false);
  assert.equal(calls.some(x => x.startsWith('stage:')), false);
  await assert.rejects(ports.readWfd('factor_library', { ...selected, snapshotId: 'latest' }, signal()),
    failCode('PRODUCTION_WFD_SELECTION'));
  await assert.rejects(ports.readWfd('semantic_dictionary', { ...selected, rows: [{ value: 1 }] }, signal()),
    failCode('PRODUCTION_WFD_SELECTION'));
  const disconnected = sample({ wfd: false });
  await assert.rejects(disconnected.ports.readWfd('factor_library', selected, signal()),
    failCode('PRODUCTION_WFD_UNAVAILABLE'));
  assert.equal(disconnected.ports.capability('semantic_dictionary').status, 'blocked');
  assert.equal(disconnected.ports.capability('factor_library').status, 'ready');
});
