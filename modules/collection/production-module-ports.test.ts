import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { isModelActionAllowed } from '../agent/model-tools.js';
import { ConversationProcessingBridge } from './conversation-processing.js';
import { ConversationAlgorithmBridge } from '../financial/conversation-algorithms.js';
import { PRODUCTION_MODULES, productionModuleDirectory,
  fixedWfdModuleReference, readWfdModulePage,
  factorLibraryView, semanticDictionaryView, readPublishedWfdSemanticDefinition,
  PRODUCTION_MODULE_PORTS_VERSION } from './production-module-ports.js';

const code = (target: string) => (error: unknown) => (error as { code?: string }).code === target;

test('exactly eight distinct on-demand interfaces are registered, discoverable and individually detachable', () => {
  assert.deepEqual(PRODUCTION_MODULES.map(item => item.id), [
    'parse', 'clean', 'structure', 'annotate', 'check', 'calculate', 'factors', 'semantics',
  ]);
  assert.equal(new Set(PRODUCTION_MODULES.map(item => item.action)).size, 8);
  assert.ok(PRODUCTION_MODULES.every(item => isModelActionAllowed(item.action)));
  const processing = { moduleCapability: (kind: string) => ({
    status: 'ready', engine: kind === 'clean' || kind === 'structure' ? 'polars' : 'fixed_typescript',
  }) };
  const calculation = { capabilities: () => ({
    methods: [{ methodId: 'macro_yoy', status: 'ready' }],
  }) };
  const found = productionModuleDirectory({ processing: processing as never,
    calculation: calculation as never, hasWfdReader: true });
  assert.equal(found.version, PRODUCTION_MODULE_PORTS_VERSION);
  assert.equal(found.modules.length, 8);
  assert.equal(found.mode, 'eight_parallel_ports');
  assert.equal(found.autoTrigger, false);
  assert.ok(found.modules.every(item => item.status === 'ready'));
  assert.ok(found.modules.every(item => item.wfdRead));
  assert.deepEqual(found.modules.find(item => item.id === 'calculate')?.dependencies, []);
  const detached = productionModuleDirectory({ processing: processing as never,
    calculation: calculation as never, hasWfdReader: true,
    enabled: { annotate: false, calculate: false, factors: false, semantics: false } });
  for (const id of ['annotate','calculate','factors','semantics'])
    assert.equal(detached.modules.find(item => item.id === id)?.status, 'unplugged');
  assert.equal(detached.modules.find(item => item.id === 'clean')?.status, 'ready');
});

test('factor library reuses existing registry and definitions without granting execution or publication', () => {
  const found = factorLibraryView('ma');
  assert.equal(found.kind, 'read_only_factor_library');
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0]?.id, 'ma');
  assert.equal(found.items[0]?.publication, 'not_granted_by_library');
  assert.equal(found.items[0]?.execution, 'only_registered_calculation_module_can_execute');
  assert.ok(found.definitions.counts.definitions >= 1);
  assert.throws(() => factorLibraryView('../etc'), code('PRODUCTION_FACTOR_ID'));
  assert.throws(() => factorLibraryView('not_registered_abc'), code('PRODUCTION_FACTOR_NOT_FOUND'));
});

test('semantic dictionary is actual bundled read-only WFD templates, not an adopted product or an agent judgment', () => {
  const market = semanticDictionaryView('market');
  assert.equal(market.kind, 'read_only_semantic_dictionary');
  assert.equal(market.status, 'templates_only_not_products');
  assert.equal(market.noAutomaticAnnotation, true);
  assert.equal(market.businessGroups.length, 1);
  assert.equal(market.businessGroups[0]?.group_id, 'market');
  assert.throws(() => semanticDictionaryView('unknown_group_abc'), code('PRODUCTION_SEMANTIC_GROUP'));
});

test('parallel source and catalog modules can read fixed WFD page without changing it or running calculations', async () => {
  assert.throws(() => fixedWfdModuleReference({ snapshotId: 'latest', productId: 'p1' }),
    code('PRODUCTION_MODULE_WFD_REFERENCE'));
  assert.throws(() => fixedWfdModuleReference({ snapshotId: 's1', productId: 'p1', arbitraryRows: [1] }),
    code('PRODUCTION_MODULE_WFD_REFERENCE'));
  const source = { snapshotId: 'snapshot_one', productId: 'product_one' };
  const fixed = { snapshotId: 'snapshot_one', productId: 'product_one',
    historyMode: 'snapshot_contents', connection: { connectionId: 'test_wfd' },
    result: { snapshot_id: 'snapshot_one', product_id: 'product_one', rows: [{
      record_ref: { logical_key: 'id1', revision_id: 'r1' },
      values: { close: { value: '10.123', value_state: 'valid_value' } },
    }], page: { has_more: false, next_cursor: null } } };
  const reader = async () => fixed as never;
  const signal = new AbortController().signal;
  for (const module of ['parse', 'check', 'factors', 'semantics'] as const) {
    const result = await readWfdModulePage(module, source, reader, signal);
    assert.equal(result.module, module);
    assert.equal(result.mode, 'wfd_read_only');
    assert.equal(result.rowCount, 1);
    assert.equal(result.execution, 'not_requested');
    assert.equal(result.publication, 'not_requested');
    assert.equal(result.source.historicalQualification, 'not_asserted');
    assert.deepEqual(result.rows, fixed.result.rows);
  }
  await assert.rejects(readWfdModulePage('parse', source, async () =>
    ({ ...fixed, snapshotId: 'other_snap' }) as never, signal), code('PRODUCTION_MODULE_WFD_CHANGED'));
});

test('AGENTS registers all eight endpoints without adding a new runtime; disabled calculation stays unavailable', () => {
  const database = new CoreDatabase();
  try {
    const processing = { moduleCapability: (kind: string) => ({
      module: kind, status: 'ready', engine: 'fixed_typescript',
    }), catalog: () => ({}) };
    const processingBridge = new ConversationProcessingBridge({
      database, core: {} as never, origin: () => null,
      companion: { processing, productionModuleSwitches: { calculate: false, semantics: false } } as never,
    });
    const algorithmBridge = new ConversationAlgorithmBridge({
      database, core: {} as never, origin: () => null,
      companion: { productionCalculation: { capabilities: () => ({
        methods: [{ methodId: 'macro_yoy', status: 'ready' }] }) },
        productionModuleSwitches: { calculate: false } } as never,
    });
    const all = [...processingBridge.registrations, ...algorithmBridge.registrations];
    for (const module of PRODUCTION_MODULES) {
      const registration = all.find(item => item.action === module.action);
      assert.ok(registration, module.action);
      const availability = registration.available();
      assert.equal(availability.available, !['calculate','semantics'].includes(module.id), module.id);
    }
    assert.equal(algorithmBridge.registrations.find(item => item.action === 'algorithms.calculate')?.available().available,
      false, 'Host removal must block old public calculation path too');
  } finally { database.close(); }
});


test('semantic dictionary resolves actual published WFD definitions without confusing reference templates with adopted data', async () => {
  const target = { snapshotId: 'fixed_snapshot_2026', productId: 'product_revenue_1' };
  let called = 0;
  const actual = async ({ snapshotId }: { snapshotId: string }) => {
    called++;
    return { snapshotId, historyMode: 'snapshot_contents',
      connection: { connectionId: 'real_frozen_connection' },
      products: [{
        product_id: target.productId, dataset_id: 'company_finance',
        subject: { kind: 'entity', namespace: 'SSE', id: 'company_1' },
        declaration: { semantic_code: 'company.revenue', unit_code: 'cny',
          measurement_nature: 'flow',
          field_definitions: [{ field_code: 'value', data_type: 'decimal' }] },
      }] } as never;
  };
  const proof = await readPublishedWfdSemanticDefinition(target, actual, new AbortController().signal);
  assert.equal(proof.kind, 'wfd_published_semantic_definition');
  assert.equal(proof.authority, 'actual_fixed_snapshot');
  assert.equal((proof.declaration as any).unit_code, 'cny');
  assert.equal((proof.declaration as any).semantic_code, 'company.revenue');
  assert.equal(proof.source.historyMode, 'snapshot_contents');
  assert.equal(proof.publication, 'not_requested');
  assert.equal(proof.declarationSha256.length, 64);
  assert.equal(called, 1);
  await assert.rejects(readPublishedWfdSemanticDefinition({ ...target, snapshotId: 'latest' },
    actual, new AbortController().signal), code('PRODUCTION_MODULE_WFD_REFERENCE'));
  await assert.rejects(readPublishedWfdSemanticDefinition(target,
    async () => ({ ...(await actual(target)), snapshotId: 'unrelated_snapshot' }) as never,
    new AbortController().signal), code('PRODUCTION_SEMANTIC_WFD_CHANGED'));
  await assert.rejects(readPublishedWfdSemanticDefinition(target,
    async () => ({ ...(await actual(target)), products: [] }) as never,
    new AbortController().signal), code('PRODUCTION_SEMANTIC_WFD_NOT_FOUND'));
});
