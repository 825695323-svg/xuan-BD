import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoreDatabase } from '../../platform/state/database.js';
import { isExplicitUtcInstant } from '../../contracts/financial-value.js';
import { readNumericFormat, normalizeNumericLexeme } from './data-processing/numeric-format.js';
import { compareProfileSemantics, profileFingerprint, readSourceFieldProfile, readSemanticProductRegistry,
  SourceFieldProfileStore, type SourceFieldProfile } from './source-field-profile.js';
import { PRODUCTION_MODULES, productionModuleDirectory, processingSessionContract, sourceSemanticView } from './production-module-ports.js';
import { ConversationProcessingBridge } from './conversation-processing.js';

const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object'
  && 'code' in error && error.code === expected;
const profile = (sourceId: string, changes: Partial<SourceFieldProfile> = {}): SourceFieldProfile => readSourceFieldProfile({
  version: 'bd.source-field-profile/1', profileId: sourceId + '.current', sourceId, series: 'daily.price',
  fields: [{ originalHeader: 'date', fieldCode: 'date', dataType: 'text', unitCode: 'date', role: 'date' },
    { originalHeader: 'close', fieldCode: 'close', dataType: 'decimal', unitCode: 'cny_per_share', role: 'value',
      measurement: '本交易日未复权收盘价，每股人民币' }],
  frequency: 'day', timeBucket: { labelSemantics: 'start', interval: 'closed_open', lengthMinutes: 1440, timezone: 'Asia/Shanghai' },
  adjustment: { status: 'raw' },
  confirmation: { status: 'operator_confirmed', basis: '隔离合成语义样本，只验证框架，不代表真实供应商验收',
    confirmedAtUtc: '2026-11-13T00:00:00Z' }, ...changes,
}, sourceId + '.json');
const scope = (sourceId: string) => ({ sourceId, series: 'daily.price' });

test('semantic dictionary keeps stable action and exposes independently selectable modes', () => {
  assert.equal(PRODUCTION_MODULES.length, 8);
  assert.equal(PRODUCTION_MODULES.find(item => item.id === 'semantics')?.title, '语义词典');
  assert.equal(PRODUCTION_MODULES.find(item => item.id === 'semantics')?.action, 'data.modules.semantics');
  const directory = productionModuleDirectory({ hasWfdReader: false, hasSourceProfiles: true });
  const dictionary = directory.modules.find(item => item.id === 'semantics')!;
  assert.equal(dictionary.status, 'ready');
  assert.ok('operations' in dictionary && dictionary.operations);
  const operations = dictionary.operations!;
  assert.deepEqual(operations.map(item => item.id), ['templates','source_lookup','source_compare','published_definition']);
  assert.equal(operations.find(item => item.id === 'source_lookup')!.available, true);
  assert.equal(operations.find(item => item.id === 'published_definition')!.available, false);
  const detached = productionModuleDirectory({ hasWfdReader: true, hasSourceProfiles: true, enabled: { semantics: false } })
    .modules.find(item => item.id === 'semantics')!;
  assert.equal(detached.status, 'unplugged');
  assert.ok('operations' in detached && detached.operations!.every(item => !item.available));
  assert.ok(directory.modules.every(item => item.dependencies.length === 0));
  assert.equal(processingSessionContract().automaticFiveStages, false);
  assert.equal(processingSessionContract().automaticCrossTrigger, false);
});

test('logical semantic conditions are independent of source implementation and never modify profiles', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bd-dictionary-framework-'));
  try {
    const a = profile('provider-a'), b = profile('provider-b', {
      fields: profile('provider-b').fields.map(field => ({ ...field, originalHeader: 'other_' + field.originalHeader })) });
    writeFileSync(join(directory, 'a.json'), JSON.stringify(a));
    writeFileSync(join(directory, 'b.json'), JSON.stringify(b));
    const profiles = new SourceFieldProfileStore(directory);
    const query = { left: scope('provider-a'), right: scope('provider-b'), conditions: {
      frequency: 'day', adjustment: 'raw', timezone: 'Asia/Shanghai', fieldUnits: { close: 'cny_per_share' } } };
    const good = sourceSemanticView(query, { profiles }) as any;
    assert.equal(good.status, 'candidate_equivalent');
    assert.equal(good.applicability.left.status, 'applicable');
    assert.equal(good.applicability.right.status, 'applicable');
    assert.equal(good.displayName, '语义词典');
    assert.equal(good.returnTo, 'agents');
    assert.equal(good.adoption, 'not_granted');
    assert.equal(good.publication, 'not_requested');
    assert.equal(good.dataWrite, 'forbidden');
    assert.equal(good.comparison.identicalSignature, true);
    for (const changed of [{ adjustment: 'qfq' }, { frequency: 'minute' }, { timezone: 'UTC' }, { fieldUnits: { close: 'usd_per_share' } }]) {
      const mismatch = sourceSemanticView({ ...query, conditions: { ...query.conditions, ...changed } }, { profiles }) as any;
      assert.equal(mismatch.status, 'different_semantics');
      assert.equal(mismatch.applicability.left.status, 'incompatible');
      assert.equal(mismatch.comparison.sameSignature, false);
      assert.equal(mismatch.comparison.identicalSignature, true, 'Changing a request is not a mutation of registered semantics');
    }
    const missing = sourceSemanticView({ ...query, conditions: { fieldUnits: { absent: 'share' } } }, { profiles }) as any;
    assert.equal(missing.status, 'needs_evidence');
    assert.equal(profiles.match(scope('provider-a'))!.adjustment.status, 'raw');
    assert.equal(profileFingerprint(profiles.match(scope('provider-a'))!), profileFingerprint(a));
    assert.equal(sourceSemanticView(query).status, 'not_configured');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('semantic dictionary preserves unknown evidence separately from confirmed differences', () => {
  const a = profile('provider-a', { adjustment: { status: 'qfq' } });
  const b = profile('provider-b', { adjustment: { status: 'qfq' } });
  assert.equal(profileFingerprint(a), profileFingerprint(b));
  assert.equal(compareProfileSemantics(a, b).status, 'needs_evidence');
  const ports = { profiles: { match: ({ sourceId }: { sourceId: string }) => sourceId === a.sourceId ? a : b } };
  const pending = sourceSemanticView({ left: scope(a.sourceId), right: scope(b.sourceId) }, ports) as any;
  assert.equal(pending.comparison.identicalSignature, true);
  assert.equal(pending.comparison.sameSignature, false);
  assert.ok(pending.comparison.gapCount >= 2);
  const known = { status: 'qfq' as const, method: 'company-action', basis: '2026-11-13' };
  assert.equal(compareProfileSemantics(profile('provider-a', { adjustment: known }),
    profile('provider-b', { adjustment: known })).sameProduct, true);
});

test('framework rejects injected definitions, precision settings and unknown modes before store access', () => {
  let reads = 0;
  const ports = { profiles: { match: () => { reads++; return profile('provider-a'); } } };
  for (const conditions of [{ precision: 18, scale: 2 }, {}, { timezone: 'Not/A_Zone' },
    { adjustment: 'unknown' }, { fieldUnits: { close: '../file' } }, { endpoint: 'https://example.test' }])
    assert.throws(() => sourceSemanticView({ left: scope('provider-a'), conditions }, ports), code('PRODUCTION_SEMANTIC_SOURCE_QUERY'));
  assert.equal(reads, 0);
  const numeric = { decimal: '.' as const, grouping: null, negative: 'minus' as const, plus: false, percent: 'reject' as const };
  assert.equal(normalizeNumericLexeme('1.234567890123', numeric), '1.234567890123');
  assert.throws(() => readNumericFormat({ ...numeric, precision: { precision: 18, scale: 2, rounding: 'reject' } }),
    code('CANDIDATE_NUMERIC_FORMAT'), 'Deferred precision configuration must not become a silently ignored option');
});

test('UTC metadata remains explicit and is not a financial precision implementation', () => {
  for (const value of ['2024-02-29T00:00:00Z', '2026-11-13T23:59:59.1Z', '2026-11-13T23:59:59.001Z'])
    assert.equal(isExplicitUtcInstant(value), true);
  for (const value of ['2026-11-13', '2026-11-13T00:00:00', '2026-02-29T00:00:00Z', '2026-11-13T24:00:00Z']) {
    assert.equal(isExplicitUtcInstant(value), false);
    const current = profile('provider-a');
    assert.throws(() => readSourceFieldProfile({ ...current, confirmation: { ...current.confirmation, confirmedAtUtc: value } },
      'invalid'), code('SOURCE_FIELD_PROFILE'));
  }
  assert.throws(() => readSemanticProductRegistry({ version: 'bd.semantic-products/1',
    products: [{ fingerprint: 'a'.repeat(64), datasetId: 'dataset', registeredAtUtc: '2026-11-13' }] }, 'invalid'),
    code('SOURCE_FIELD_PROFILE'));
});

// 以下替身只验证会话桥的模式隔离，不冒充真实模型或真实 WFD 数据验收。
test('conversation dictionary only invokes the requested reader and returns control to agents', async () => {
  const database = new CoreDatabase(':memory:');
  let sourceReads = 0, definitionReads = 0, dataReads = 0;
  const current = profile('provider-a');
  const bridge = new ConversationProcessingBridge({ database, core: {} as never,
    origin: () => ({ conversationId: 'c1', branchId: 'b1', messageId: 'm1' }) as never,
    companion: { bd: { assertDispatch: () => {} }, sourceFieldProfiles: {
      match: () => { sourceReads++; return current; } }, semanticProducts: { datasetFor: () => null },
      r1Workspace: {
        readProduct: async () => { dataReads++; throw new Error('Dictionary mode must not read value rows'); },
        discoverProducts: async ({ snapshotId }: { snapshotId: string }) => {
          definitionReads++;
          return { snapshotId, historyMode: 'snapshot_contents', connection: {}, products: [{ product_id: 'product-1',
            dataset_id: 'dataset-1', subject: { kind: 'entity', namespace: 'test', id: 'one' },
            declaration: { semantic_code: 'test.metric', unit_code: 'CNY', measurement_nature: 'stock' } }] };
        },
      },
    } as never });
  const context = { task: { id: 'dictionary-task', action: 'data.modules.semantics', args: {}, versions: {} },
    signal: new AbortController().signal, assertAuthorized: () => {},
    requestApproval: async () => { throw new Error('Read-only dictionary cannot request write approval'); } };
  try {
    const action = bridge.registrations.find(item => item.action === 'data.modules.semantics')!;
    assert.equal(JSON.stringify(action).includes('G5'), false);
    const sourceQueryJson = JSON.stringify({ left: scope('provider-a'), conditions: { adjustment: 'raw' } });
    const source = await bridge.execute(context as never, action.action, { sourceQueryJson });
    const sourceView = (source.data as any).modelPreview;
    assert.equal(sourceView.catalog, null);
    assert.equal(sourceView.wfdPage, null);
    assert.equal(sourceView.returnTo, 'agents');
    assert.equal(sourceView.displayName, '语义词典');
    assert.equal(sourceView.sourceSemantics.applicability.left.status, 'applicable');
    const wfdRefJson = JSON.stringify({ snapshotId: 'snapshot-1', productId: 'product-1' });
    const fixed = await bridge.execute(context as never, action.action, { wfdRefJson });
    const fixedView = (fixed.data as any).modelPreview;
    assert.equal(fixedView.catalog, null);
    assert.equal(fixedView.wfdPage, null);
    assert.equal(fixedView.publishedDefinition.productId, 'product-1');
    assert.equal(sourceReads, 1);
    assert.equal(definitionReads, 1);
    assert.equal(dataReads, 0);
    for (const args of [{ sourceQueryJson, groupId: 'market' }, { wfdRefJson, groupId: 'market' }, { sourceQueryJson, wfdRefJson }])
      await assert.rejects(bridge.execute(context as never, action.action, args), code('PRODUCTION_SEMANTIC_SOURCE_QUERY'));
    assert.equal(sourceReads, 1);
    assert.equal(definitionReads, 1);
  } finally { database.close(); }
});
