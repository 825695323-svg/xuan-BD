import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { CoreDatabase } from '../../platform/state/database.js';
import type { TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import { R1ProductReader } from '../collection/r1-product-reader.js';
import { createR1HandoffRuntime, type R1Runtime } from '../collection/r1-runtime.js';
import { createFullChainFixture } from '../../apps/server/full-chain-test-support.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ConversationAlgorithmBridge } from './conversation-algorithms.js';
import { verifyPureOperator, type PureOperatorInput } from './pure-operator-verification.js';
import { factorLibraryView } from '../collection/production-module-ports.js';
import { ALGORITHM_DEFINITIONS } from './algorithm-definitions.js';
import { ALGORITHM_REGISTRY } from './algorithm-registry.js';
import { ALGORITHM_METHOD_IDS, PURE_OPERATOR_IDS, type AlgorithmCatalogView } from './algorithm-types.js';
import { algorithmAllowedByRules, basicAlgorithmToolContract, frozenAlgorithmCapabilities } from './basic-algorithm-tool-contract.js';
import { computeFinancialGrowth, computeFinancialRatios, computeFinancialSingleQuarter, computeFinancialTtm,
  type FinancialObservation } from './financial-l4-operators.js';
import { computeAdjustedMarketSeries } from './market-adjustment-contract.js';
import { basis, observation, bars, marketInput, fixedSnapshot, revision, cutoff, ratioRow, sourceRows, products, calculation, fields, cell,
  pureFixtureUnits, seedPureOperatorProducts, discoveredPureReference } from './pure-operator-test-support.js';
import { ToolLibraryService } from './tool-library.js';

test('累计转单季及 TTM 按相容期间精确计算并保留源观测', () => {
  const q1 = observation(2025, 'Q1_YTD', '10000000000000000.000000000000000001');
  const h1 = observation(2025, 'H1', '10000000000000000.000000000000000003');
  const q3 = observation(2025, 'Q3_YTD', '10000000000000000.100000000000000003');
  const fy = observation(2025, 'FY', '10000000000000000.300000000000000003');
  const quarters = computeFinancialSingleQuarter([fy, q3, q1, h1]);
  assert.deepEqual(quarters.map(({ period, value }) => [period, value]),
    [['Q1', q1.value], ['Q2', '0.000000000000000002'], ['Q3', '0.1'], ['Q4', '0.2']]);
  assert.ok(quarters.every(row => row.fiscalCalendar === basis.fiscalCalendar));
  assert.deepEqual(quarters[1].lineage.inputs, [q1, h1]);
  const currentQ1 = observation(2026, 'Q1', '0.4');
  const ttmQuarters = computeFinancialTtm([currentQ1, ...quarters.slice(1)]);
  const ttmYtd = computeFinancialTtm([h1, fy, observation(2026, 'H1', '0.7')]);
  assert.equal(computeFinancialTtm(quarters).value, fy.value);
  assert.equal(ttmQuarters.value, '0.700000000000000002');
  assert.equal(ttmQuarters.lineage.method, 'four_quarters');
  assert.equal(ttmYtd.value, '1');
  assert.equal(ttmYtd.lineage.method, 'fy_plus_ytd_delta');
});

test('财务期间算子拒绝跨口径、非加性科目、缺期、重复或无效数值', () => {
  const q1 = observation(2025, 'Q1_YTD', '1'), h1 = observation(2025, 'H1', '2');
  for (const axis of ['subject', 'accounting_standard', 'currency', 'scope', 'comparability_basis', 'unit', 'fiscalCalendar'] as const) {
    assert.throws(() => computeFinancialSingleQuarter([q1, { ...h1, [axis]: 'other_basis' }]), { code: 'FINANCIAL_BASIS_MISMATCH' });
  }
  const missingCalendar = [q1, h1].map(({ fiscalCalendar: _calendar, ...row }) => row as FinancialObservation);
  assert.throws(() => computeFinancialSingleQuarter(missingCalendar), { code: 'FINANCIAL_BASIS_REQUIRED' });
  assert.throws(() => computeFinancialSingleQuarter([q1, missingCalendar[1]!]), { code: 'FINANCIAL_BASIS_REQUIRED' });
  for (const fiscalCalendar of ['', 'unknown', 'unresolved', 'unspecified']) {
    assert.throws(() => computeFinancialSingleQuarter([q1, { ...h1, fiscalCalendar }]), { code: 'FINANCIAL_BASIS_REQUIRED' });
  }
  const eps = { ...q1, concept: 'basic_eps', additive: false };
  assert.throws(() => computeFinancialSingleQuarter([eps]), { code: 'FINANCIAL_NON_ADDITIVE' });
  assert.throws(() => computeFinancialTtm([eps]), { code: 'FINANCIAL_NON_ADDITIVE' });
  assert.throws(() => computeFinancialSingleQuarter([{ ...q1, periodType: 'instant' }]), { code: 'FINANCIAL_NON_ADDITIVE' });
  assert.throws(() => computeFinancialSingleQuarter([q1, observation(2025, 'Q3_YTD', 3)]), { code: 'FINANCIAL_MISSING_PERIOD' });
  assert.throws(() => computeFinancialSingleQuarter([q1, q1]), { code: 'FINANCIAL_DUPLICATE_PERIOD' });
  assert.throws(() => computeFinancialSingleQuarter([{ ...q1, value: null }]), { code: 'FINANCIAL_MISSING_INPUT' });
  assert.throws(() => computeFinancialSingleQuarter([{ ...q1, value: Infinity }]), { code: 'NUMERIC_PRECISION_VALUE' });
  const quarters = computeFinancialSingleQuarter([q1, h1, observation(2025, 'Q3_YTD', 4), observation(2025, 'FY', 5)]);
  assert.throws(() => computeFinancialTtm(quarters.slice(1)), { code: 'FINANCIAL_MISSING_PERIOD' });
  assert.throws(() => computeFinancialTtm([...quarters.slice(1), observation(2026, 'Q2', 1)]), { code: 'FINANCIAL_MISSING_PERIOD' });
  assert.throws(() => computeFinancialTtm([...quarters.slice(1), { ...quarters[0], comparability_basis: 'revision_b' }]),
    { code: 'FINANCIAL_BASIS_MISMATCH' });
  assert.throws(() => computeFinancialTtm([h1, observation(2025, 'FY', 5), observation(2026, 'Q3_YTD', 4)]),
    { code: 'FINANCIAL_MISSING_PERIOD' });
});

test('同比、环比和百分点差有明确期间与基期规则', () => {
  const current = observation(2026, 'Q1', '5'), prior = observation(2025, 'Q1', '4');
  assert.equal(computeFinancialGrowth(current, prior, { comparison: 'yoy' }).value, '0.25');
  assert.equal(computeFinancialGrowth(current, { ...prior, period: 'Q4' }, { comparison: 'qoq' }).value, '0.25');
  assert.throws(() => computeFinancialGrowth(current, prior, { comparison: 'qoq' }), { code: 'FINANCIAL_PERIOD' });
  for (const [value, code] of [[0, 'ZERO_BASE'], [-2, 'NON_POSITIVE_BASE'], [null, 'MISSING_INPUT']] as const) {
    const result = computeFinancialGrowth(current, { ...prior, value }, { comparison: 'yoy' });
    assert.equal(result.value, null);
    assert.deepEqual(result.diagnostics, [{ code, output: 'value', fields: ['prior'] }]);
  }
  assert.equal(computeFinancialGrowth(current, { ...prior, value: -2 },
    { comparison: 'yoy', allowSignedBase: true }).value, '-3.5');
  assert.equal(computeFinancialGrowth({ ...current, unit: 'ratio', value: '0.031' }, { ...prior, unit: 'ratio', value: 0 },
    { comparison: 'yoy', mode: 'percentage_points' }).value, '3.1');
});

test('比率、杜邦和 CCC 保留分项，缺项和零分母各有诊断', () => {
  const snapshot = { ...basis, periodRef: 'synthetic/2025/Q1', revenue: 100, costOfRevenue: 60, netProfit: 10,
    averageAssets: 200, averageEquity: 50, currentAssets: 60, currentLiabilities: 25,
    averageReceivables: 20, averageInventory: 30, averagePayables: 10, periodDays: 90, cfo: 25, capex: 5 };
  const result = computeFinancialRatios(snapshot);
  assert.deepEqual(result.values, { grossMargin: '0.4', netMargin: '0.1', roe: '0.2', roa: '0.05',
    assetTurnover: '0.5', equityMultiplier: '4', dupontRoe: '0.2', workingCapital: '35',
    dso: '18', dio: '45', dpo: '15', ccc: '48', freeCashFlow: '20', earningsQuality: '2.5' });
  assert.deepEqual(result.diagnostics, []);
  const partial = computeFinancialRatios({ ...snapshot, revenue: 0, netProfit: 0, averagePayables: null, capex: null });
  assert.equal(partial.values.earningsQuality, null);
  assert.equal(partial.values.dupontRoe, null);
  assert.equal(partial.values.ccc, null);
  assert.equal(partial.values.dio, '45');
  assert.equal(partial.values.freeCashFlow, null);
  assert.ok(partial.diagnostics.some(item => item.output === 'earningsQuality' && item.code === 'ZERO_DENOMINATOR'));
  assert.ok(partial.diagnostics.some(item => item.output === 'freeCashFlow' && item.fields.includes('capex')));
});

test('前后复权按各自锚点归一，四种行动因子可核对且原价完整保留', () => {
  const forward = computeAdjustedMarketSeries({ ...marketInput, bars: [...bars].reverse() });
  const backward = computeAdjustedMarketSeries({ ...marketInput, direction: 'backward_hfq', anchorDate: bars[0].date });
  assert.deepEqual(forward.rows.map(row => row.adj_factor), ['0.2', '0.5', '1']);
  assert.deepEqual(backward.rows.map(row => row.adj_factor), ['1', '2.5', '5']);
  for (const [index, bar] of bars.entries()) {
    const { adjusted, adj_factor, ...raw } = forward.rows[index];
    assert.deepEqual(raw, bar);
    assert.deepEqual(adjusted, { open: '20', high: '24', low: '16', close: '20' });
    assert.deepEqual(backward.rows[index].adjusted, { open: '100', high: '120', low: '80', close: '100' });
    assert.equal(Number(adj_factor) * 5, Number(backward.rows[index].adj_factor));
  }
  assert.equal(forward.lineage.direction, 'forward_qfq');
  assert.equal(forward.lineage.anchorDate, bars[2].date);
  assert.deepEqual(forward.lineage.appliedActions.map(item => item.stepFactor), ['0.4', '0.5']);
  assert.deepEqual(forward.lineage.appliedActions.flatMap(item => item.events), marketInput.actions);
});

test('复权拒绝来源主张、未知生效状态、隐式锚点或方向、以及缺少生效日原价', () => {
  for (const status of [{ claimStatus: 'source_claim' }, { effectiveStatus: 'unknown' }]) {
    assert.throws(() => computeAdjustedMarketSeries({ ...marketInput,
      actions: [{ ...marketInput.actions[0], ...status }] }), { code: 'MARKET_ADJUSTMENT_ACTION_NOT_EFFECTIVE' });
  }
  assert.throws(() => computeAdjustedMarketSeries({ ...marketInput, anchorDate: undefined as never }), { code: 'MARKET_ADJUSTMENT_ANCHOR' });
  assert.throws(() => computeAdjustedMarketSeries({ ...marketInput, direction: undefined as never }), { code: 'MARKET_ADJUSTMENT_DIRECTION' });
  assert.throws(() => computeAdjustedMarketSeries({ ...marketInput, adjustment: 'forward_qfq' as never }),
    { code: 'MARKET_ADJUSTMENT_RAW_DAILY_REQUIRED' });
  assert.throws(() => computeAdjustedMarketSeries({ ...marketInput, bars: [bars[0], bars[2]] }),
    { code: 'MARKET_ADJUSTMENT_ACTION_BAR_MISSING' });
});

test('统一登记表、定义和两个目录包含新增五个因子，纯算子就绪状态取决于受信读取与计算开关', () => {
  const pureIds = ['financial_single_quarter', 'financial_ttm', 'financial_growth', 'financial_ratios', 'price_adjustment'];
  const fixedDailyIds = ['macd', 'ma', 'ema', 'rsi', 'boll', 'roc', 'obv', 'returns', 'volatility', 'max_drawdown'] as const;
  const reusedFactorIds = ['alpha191_014', 'alpha191_031', 'alpha191_116', 'alpha191_168', 'alpha191_189'] as const;
  for (const id of [...fixedDailyIds, ...reusedFactorIds])
    assert.ok(ALGORITHM_METHOD_IDS.includes(id), `${id} must remain discoverable as a calculation method`);
  const ids = [...ALGORITHM_METHOD_IDS, ...pureIds];
  assert.equal(new Set(ids).size, ids.length, '共用登记目录不得重复登记方法或财务算子');
  const catalog = { methods: ALGORITHM_METHOD_IDS.map(id => ({ id, status: 'ready' })) } as AlgorithmCatalogView;
  const toolLibrary = new ToolLibraryService({ algorithms: { catalog: () => catalog } }).view();
  const factors = factorLibraryView();
  assert.equal(factors.total, ids.length);
  assert.deepEqual(ALGORITHM_REGISTRY.map(item => item.id), ids);
  assert.deepEqual(ALGORITHM_DEFINITIONS.map(item => item.registryId), ids);
  assert.deepEqual(factors.items.map(item => item.id), ids);
  assert.deepEqual(toolLibrary.tools.map(item => item.id), ids);
  assert.deepEqual(factors.items.map(item => item.definition), ALGORITHM_DEFINITIONS);
  assert.deepEqual(toolLibrary.tools.map(item => item.definition), ALGORITHM_DEFINITIONS);
  assert.deepEqual(toolLibrary.tools.filter(item => item.status === 'ready').map(item => item.id), ALGORITHM_METHOD_IDS);
  assert.ok([...toolLibrary.tools, ...factors.items].every(item => item.state === 'executable'));
  assert.deepEqual(toolLibrary.registry?.counts, { executable: 20, assets_only: 0, not_implemented: 0, needs_data: 0 });
  let attached = true, enabled = true;
  const live = new ToolLibraryService({ algorithms: { catalog: () => catalog }, hasWfdReader: () => attached, calculateEnabled: () => enabled });
  assert.ok(live.view().tools.every(item => item.status === 'ready'));
  attached = false;
  assert.ok(live.view().tools.filter(item => pureIds.includes(item.id)).every(item => item.status === 'unavailable'));
  enabled = false;
  assert.ok(live.view().tools.every(item => item.status === 'unavailable'));
  assert.deepEqual(frozenAlgorithmCapabilities(21).methods, ALGORITHM_METHOD_IDS);
  assert.equal(frozenAlgorithmCapabilities(21).screen, true);
  for (const id of PURE_OPERATOR_IDS) {
    assert.ok([18, 19, 20, 21, undefined].every(version => !algorithmAllowedByRules(id, version)));
    assert.equal(algorithmAllowedByRules(id, 22), true);
  }
  assert.deepEqual(factors.counts, toolLibrary.registry?.counts);
  assert.ok(factors.items.every(item => item.execution === 'not_granted_by_library'
    && item.publication === 'not_granted_by_library'));
  assert.deepEqual(toolLibrary.tools.slice(-5).map(item => item.category), ['financial', 'financial', 'financial', 'financial', 'adjustment']);
  assert.deepEqual(basicAlgorithmToolContract(catalog, undefined, 21).methods.map(item => item.methodId), ALGORITHM_METHOD_IDS);
  for (const id of reusedFactorIds) {
    const selected = basicAlgorithmToolContract(catalog, id, 21);
    assert.equal(selected.unknownMethod, false);
    assert.deepEqual(selected.methods.map(item => item.methodId), [id]);
  }
  for (const id of pureIds)
    assert.equal(basicAlgorithmToolContract(catalog, id, 21).unknownMethod, true);
  const detached = new ToolLibraryService().view().tools;
  assert.ok(detached.every(item => item.status === 'unavailable'));
});

function fixture() {
  const root = mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'synthetic-pure-'));
  const path = join(root, 'personal.sqlite');
  let database = new CoreDatabase(path);
  const rows = structuredClone(sourceRows);
  const origin = { conversationId: 'synthetic-conversation', branchId: 'synthetic-branch', parentRunId: 'synthetic-run',
    parentGeneration: 1, inputId: 'synthetic-input', messageId: 'synthetic-message' } as ModelTaskOrigin;
  const identity = { connectionId: 'synthetic-read', profile: 'data_only', protocol: 'wfd.structured-ingest/1.0',
    mode: 'user_test', purpose: 'user_test', runtimeIdentity: 'synthetic-instance', callerId: 'synthetic', namespace: 'synthetic',
    store: '/synthetic/store', runtime: '/synthetic/runtime', configSha256: '1'.repeat(64), schemaSha256: '2'.repeat(64),
    entrySha256: '3'.repeat(64), pythonPath: '/synthetic/unused', entryPath: '/synthetic/unused.py' } satisfies R1ConnectionIdentity;
  const fixedDefinition = { id: 'definition', version: revision }, contract = { id: 'contract', version: 'v1' };
  const state = { rules: 22, queryCalls: [] as WfdRecord[], discovered: [] as unknown[], switches: { calculate: true },
    quote: '', diagnostics: [] as WfdRecord[], changePage: (_page: WfdRecord, _offset: number) => {} };
  const client = {
    async contractDiscovery(snapshotId: string) {
      const entries = Object.keys(rows).map(product_id => ({ product_id, dataset_id: 'synthetic', payload_kind: 'tabular_rows',
        subject: { kind: 'issuer', namespace: 'synthetic', id: basis.subject }, definition_ref: fixedDefinition, contract_ref: contract,
        declaration: { field_definitions: fields(product_id).map(field_code => {
          const c = cell(rows[product_id][0] ?? {}, field_code); return { field_code, data_type: c.data_type, unit_code: c.unit.unit_code };
        }) }, contracts: { read: { perspectives: ['snapshot_contents', 'market_known_at', 'system_held_at'] } } }));
      return { result: { snapshot_id: snapshotId, product_count: entries.length, products: entries } };
    },
    async readProduct(query: WfdRecord) {
      state.queryCalls.push(structuredClone(query));
      const id = String(query.product_id), offset = query.cursor === null ? 0 : Number(String(query.cursor).slice(1));
      const list = rows[id], slice = list.slice(offset, offset + 1);
      const more = offset + slice.length < list.length;
      const page = { page_size: query.page_size, remaining_rows: list.length - offset, returned_rows: slice.length,
        total_rows: list.length, has_more: more, next_cursor: more ? 'c' + (offset + slice.length) : null, page_complete: !more };
      const result: WfdRecord = { format_version: 'wfd.read-product-result/0.1', operation: 'read_product', snapshot_id: query.snapshot_id,
        product_id: id, dataset_id: query.dataset_id, fields: query.fields, history_mode: query.history_mode, knowledge_cutoff: query.knowledge_cutoff,
        held_scope: query.held_scope, usable_stage: query.usable_stage, business_time_range: null, subject: null, page, complete: !more,
        query_hash: 'sha256:' + 'a'.repeat(64), budget: {}, product: { product_id: id, definition_refs: [fixedDefinition], contract_refs: [contract] },
        diagnostics: structuredClone(state.diagnostics), rows: slice.map(row => ({
          record_ref: { logical_key: id + offset, revision_id: 'r_synthetic_visible' }, definition_ref: fixedDefinition, contract_ref: contract,
          values: Object.fromEntries((query.fields as string[]).map(field => [field, cell(row, field)])),
          ...(query.history_mode === 'market_known_at' ? { eligibility: { decision: 'eligible', mode: query.history_mode },
            times: { public_time: { status: 'known', earliest_utc: '2026-05-01T01:00:00Z', latest_exclusive_utc: '2026-05-01T01:00:01Z' } } }
            : query.history_mode === 'system_held_at' ? { eligibility: { decision: 'eligible', reason: 'held_at_usable_stage' },
              held_at: '2026-05-01T01:00:00Z', held_scope: query.held_scope, usable_stage: query.usable_stage } : {}),
        })) };
      state.changePage(result, offset); return { result };
    },
  };
  const reader = new R1ProductReader({ runtime: () => ({ client: client as unknown as R1Runtime['client'], currentIdentity: () => identity }),
    control: () => ({ stopped: false, generation: 1 }) });
  const port = { readProduct: reader.readProduct.bind(reader), discoverProducts(input: WfdRecord, signal: AbortSignal) {
    state.discovered.push(input); return reader.discoverProducts(input, signal);
  }, capabilities: () => ({ connection: identity }), readBinding: () => ({ readSchemaSha256: 'e'.repeat(64), queryImplSha256: 'f'.repeat(64) }) };
  const companion = { r1Workspace: port, productionModuleSwitches: state.switches } as unknown as WorkspaceServices;
  const open = () => new ConversationAlgorithmBridge({ database, companion, origin: () => origin, rulesVersion: () => state.rules,
    submissionContext: () => state.quote ? { authority: 'user-message', messageId: origin.messageId, quote: state.quote,
      observedAtUtc: '2026-05-03T01:00:00Z' } : undefined });
  let bridge = open(), sequence = 0;
  async function invoke(action: string, args: Record<string, JsonValue> = {}, id = 'task-' + ++sequence) {
    const response = await bridge.execute({ task: { id, action, args, versions: { directImplementation: 'synthetic-bytes' } },
      signal: new AbortController().signal, assertAuthorized() {} } as unknown as TaskExecutionContext);
    return (response.data as Record<string, any>).modelPreview;
  }
  return { state, rows, companion, origin, invoke, get database() { return database; },
    run: (request: unknown, action = 'algorithms.calculate', id?: string) => invoke(action, { calculationJson: JSON.stringify(request) }, id),
    reopen() { database.close(); database = new CoreDatabase(path); bridge = open(); },
    close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('v22 合同按真实端口暴露 20 项，固定快照发现只读且无端口可查询目录', async () => {
  const f = fixture();
  try {
    const directory = await f.invoke('algorithms.contract');
    assert.deepEqual(directory.methods.map((m: any) => m.methodId), [...ALGORITHM_METHOD_IDS, ...PURE_OPERATOR_IDS]);
    for (const m of directory.methods.slice(-5)) {
      assert.equal(m.executor, 'typescript'); assert.equal(m.executable, true); assert.equal(m.interface, 'algorithms.calculate');
      assert.ok(m.input.requiredIdentity.includes('definitionRevision')); assert.ok(m.input.fields.required.length);
      assert.ok(m.definition.implementations.some((v: any) => v.role === 'reference' && v.location.endsWith('pure-operator-verification.ts')));
    }
    assert.ok(directory.methods.slice(0, 15).every((m: any) => !m.executable));
    const session = await f.invoke('bd.session.capabilities');
    assert.equal(session.parallelModuleDirectory.modules.find((m: any) => m.id === 'calculate').engine, 'typescript');
    const discovery = (await f.invoke('algorithms.capabilities', { snapshotId: fixedSnapshot })).snapshotDiscovery;
    assert.equal(discovery.status, 'available'); assert.equal(discovery.products.length, 6);
    assert.deepEqual(f.state.discovered, [{ snapshotId: fixedSnapshot }]); assert.equal(f.state.queryCalls.length, 0);
    assert.equal(discovery.products[0].definitionRef.version, revision);
    assert.ok(discovery.products[0].fields.some((field: any) => field.fieldCode === 'value' && field.dataType === 'decimal'));
    assert.ok(discovery.products[0].contracts.read.perspectives.includes('market_known_at'));
    for (const snapshotId of ['', 'latest', 'CURRENT', ' x ', '../temp']) await assert.rejects(f.invoke('algorithms.capabilities', { snapshotId }));
    assert.equal(f.state.discovered.length, 1);
    f.state.switches.calculate = false;
    assert.ok((await f.invoke('algorithms.contract')).methods.every((m: any) => !m.executable));
    await assert.rejects(f.run(calculation('financial_ttm')), { code: 'PRODUCTION_CALCULATION_DISABLED' });
    f.state.rules = 21; f.state.switches.calculate = true;
    assert.equal((await f.invoke('algorithms.contract')).methods.length, 15);
    await assert.rejects(f.run(calculation('financial_ttm')), { code: 'ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES' });
    await assert.rejects(f.invoke('algorithms.capabilities', { snapshotId: fixedSnapshot }), { code: 'ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES' });
    f.state.rules = 22; f.companion.r1Workspace = undefined;
    assert.equal((await f.invoke('algorithms.capabilities', { snapshotId: fixedSnapshot })).snapshotDiscovery.status, 'unavailable');
    assert.equal((await f.invoke('algorithms.capabilities')).methodDirectory.length, 20);
  } finally { f.close(); }
});

test('五个纯算子从完整固定产品执行、独立核验，关闭 SQLite 后按原会话任务精确读回', async t => {
  const f = fixture(), receipts: { taskId: string }[] = [];
  try {
    for (const method of PURE_OPERATOR_IDS) await t.test(method, async () => {
      const request = calculation(method);
      const status = await f.run(request, method === 'financial_growth' ? 'data.modules.calculate' : 'algorithms.calculate', method);
      assert.equal(status.taskId, method); assert.equal(status.status, 'succeeded'); assert.equal(status.verification.status, 'verified');
      assert.equal(status.versionBinding.rulesVersion, 22); assert.equal(status.versionBinding.taskVersions.directImplementation, 'synthetic-bytes');
      assert.deepEqual(status.publication, { state: 'not_requested', mode: 'explicit_r1_handoff_required' });
      assert.equal(status.fixedReads[0].pages, f.rows[products[method]].length);
      assert.equal(status.fixedReads[0].complete, true);
      const audit = f.database.connection.prepare('SELECT * FROM pure_operator_runs WHERE task_id=?').get(method)!;
      assert.equal(wfdSha256(String(audit.sealed_input)), status.inputDigest);
      const sealed = JSON.parse(String(audit.sealed_input)), result = JSON.parse(String(audit.result_json));
      assert.equal(wfdSha256(canonicalWfdJson(sealed.input)), status.verification.inputSha256);
      assert.equal(wfdSha256(canonicalWfdJson(result)), status.verification.resultSha256);
      assert.equal(sealed.records.length, f.rows[products[method]].length);
      if (method === 'financial_single_quarter') assert.equal(status.result.rows[1].value, '7.000000000000000007');
      if (method === 'financial_ttm') assert.equal(status.result.value, '9');
      if (method === 'financial_growth') assert.equal(status.result.value, '0.5');
      if (method === 'financial_ratios') assert.equal(status.result.values.dupontRoe, status.result.values.roe);
      if (method === 'price_adjustment') {
        assert.equal(status.fixedReads[1].pages, 4); assert.deepEqual(status.result.rows.map((r: any) => r.adj_factor), ['0.2', '0.5', '1']);
      }
      const reads = f.state.queryCalls.length;
      assert.deepEqual(await f.run(request, method === 'financial_growth' ? 'data.modules.calculate' : 'algorithms.calculate', method), status);
      assert.equal(f.state.queryCalls.length, reads);
      receipts.push(status);
    });
    f.reopen(); f.companion.r1Workspace = undefined; f.state.switches.calculate = false;
    for (const status of receipts) assert.deepEqual(await f.invoke('algorithms.status', { taskId: status.taskId }), status);
    await assert.rejects(f.invoke('algorithms.publish', { taskId: receipts[0].taskId }), { code: 'PURE_OPERATOR_R1_HANDOFF_REQUIRED' });
    f.origin.branchId = 'other-branch';
    await assert.rejects(f.invoke('algorithms.status', { taskId: receipts[0].taskId }), { code: 'ALGORITHM_TASK_ORIGIN' });
  } finally { f.close(); }
});

test('历史市场可知与系统持有逐行核验，排除的未来与撤销版本只返回分类计数', async () => {
  const f = fixture();
  try {
    for (const mode of ['market_known_at', 'system_held_at']) {
      const held = mode === 'system_held_at', history = { perspective: mode, at: cutoff,
        ...(held ? { heldScope: 'synthetic-instance', usableStage: 'custodied' } : {}) };
      f.state.diagnostics = held ? [{ product_id: 'single', decision: 'ineligible', diagnostic_source: 'product_service_eligibility',
        reason: 'WITHDRAWN_AT_HELD_CUTOFF', business_key: 'secret_withdrawn_key', held_scope: history.heldScope, usable_stage: history.usableStage,
        eligibility: { decision: 'ineligible', reason: 'WITHDRAWN_AT_HELD_CUTOFF' }, revision_id: 'secret_withdrawn_revision' }]
        : [{ product_id: 'single', decision: 'ineligible', diagnostic_source: 'product_service_eligibility',
          reason: 'time_interval_starts_after_cutoff', business_key: 'secret_future_key', revision_id: 'secret_future_revision' }];
      const request = calculation('financial_single_quarter', history), before = f.state.queryCalls.length;
      f.state.quote = '读取当前结果';
      await assert.rejects(f.run(request), { code: 'ALGORITHM_PURPOSE_EVIDENCE_REQUIRED' });
      assert.equal(f.state.queryCalls.length, before);
      f.state.quote = JSON.stringify({ purpose: 'historical_compute', action: 'algorithms.calculate', historyMode: mode, cutoff });
      const status = await f.run(request);
      assert.equal(status.fixedReads[0].historicalExclusionSummary.excludedCount, 1);
      assert.deepEqual(await f.invoke('algorithms.status', { taskId: status.taskId }), status);
      assert.doesNotMatch(JSON.stringify(status), /secret_|revision_id|business_key|diagnostic_source/u);
      f.state.changePage = page => { const row = (page.rows as WfdRecord[])[0];
        if (held) row.held_at = '2026-06-01T00:00:00Z'; else row.times = {}; };
      await assert.rejects(f.run(request), { code: 'STRATEGY_SCREEN_ROW_INELIGIBLE' });
      f.state.changePage = () => {};
    }
    const port = f.companion.r1Workspace!;
    port.readProduct = async () => { throw Error('secret_future_revision raw diagnostics'); };
    await assert.rejects(f.run(calculation('financial_ttm', { perspective: 'system_held_at', at: cutoff,
      heldScope: 'synthetic-instance', usableStage: 'custodied' })), (error: Error) => {
      assert.doesNotMatch(error.message, /secret_|diagnostics/u); return true;
    });
  } finally { f.close(); }
});

test('拒绝动态引用、定义漂移、残页、非法行值与不相容财务口径，失败不留下成功记录', async () => {
  const f = fixture();
  try {
    for (const override of [{ snapshotId: 'latest' }, { snapshotId: 'CURRENT' }, { definitionRevision: undefined }])
      await assert.rejects(f.run(calculation('financial_ttm', override)), { code: 'PURE_OPERATOR_FIXED_REFERENCE' });
    assert.equal(f.state.queryCalls.length, 0);
    await assert.rejects(f.run(calculation('financial_ttm', { definitionRevision: 'different' })), { code: 'PURE_OPERATOR_DEFINITION_MISMATCH' });
    for (const change of [(page: any) => { page.snapshot_id = 'elsewhere'; }, (page: any) => { page.product_id = 'elsewhere'; },
      (page: any) => { page.page.next_cursor = 'c1'; }, (page: any) => { page.page.has_more = false; },
      (page: any) => { page.page.remaining_rows = 0; }, (page: any) => { page.complete = false; },
      (page: any) => { page.rows[0].definition_ref = { id: 'definition', version: 'other' }; }]) {
      f.state.changePage = (page, offset) => { if (offset > 0) change(page); };
      await assert.rejects(f.run(calculation('financial_ttm')));
    }
    f.state.changePage = () => {};
    f.rows.single[0].value = null;
    await assert.rejects(f.run(calculation('financial_single_quarter')), { code: 'FINANCIAL_MISSING_INPUT' });
    f.rows.single = structuredClone(sourceRows.single);
    for (const axis of ['subject', 'accounting_standard', 'currency', 'scope', 'comparability_basis', 'unit', 'fiscalCalendar']) {
      f.rows.single[0][axis] = 'other';
      await assert.rejects(f.run(calculation('financial_single_quarter')), { code: 'FINANCIAL_BASIS_MISMATCH' });
      f.rows.single = structuredClone(sourceRows.single);
    }
    f.rows.ratios[0].fiscalCalendar = 'unknown';
    await assert.rejects(f.run(calculation('financial_ratios')), { code: 'FINANCIAL_BASIS_REQUIRED' });
    for (const field of ['claimStatus', 'effectiveStatus']) {
      f.rows.actions[0][field] = 'pending';
      await assert.rejects(f.run(calculation('price_adjustment')), { code: 'MARKET_ADJUSTMENT_ACTION_NOT_EFFECTIVE' });
      f.rows.actions = structuredClone(sourceRows.actions);
    }
    f.rows.bars[0].adjustment = 'qfq';
    await assert.rejects(f.run(calculation('price_adjustment')), { code: 'MARKET_ADJUSTMENT_RAW_DAILY_REQUIRED' });
    assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM pure_operator_runs').get()!.n, 0);
    assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM conversation_algorithm_links').get()!.n, 0);
  } finally { f.close(); }
});

test('独立核验拒绝五类数值篡改，核对 TTM 两条公式、零基期、百分点、杜邦和空值诊断', () => {
  const q = [1, 2, 3, 4].map(q => observation(2025, ('Q' + q) as FinancialObservation['period'], String(q)));
  const single = [observation(2025, 'Q1_YTD', 0), observation(2025, 'H1', '0.030000000000000001')];
  function verify(input: PureOperatorInput, result: any, tamper: (copy: any) => void) {
    assert.equal(verifyPureOperator(input, result).status, 'verified');
    const copy = structuredClone(result); tamper(copy);
    assert.throws(() => verifyPureOperator(input, copy), { code: 'PURE_OPERATOR_VERIFICATION_FAILED' });
  }
  verify({ methodId: 'financial_single_quarter', observations: single }, computeFinancialSingleQuarter(single), r => { r[1].value = '0.03'; });
  verify({ methodId: 'financial_ttm', observations: q }, computeFinancialTtm(q), r => { r.value = '9'; });
  for (const base of [0, -1, null, '3']) {
    const current = observation(2026, 'Q1', '5'), prior = observation(2025, 'Q1', base), options = { comparison: 'yoy' as const };
    verify({ methodId: 'financial_growth', current, prior, options }, computeFinancialGrowth(current, prior, options),
      r => { if (r.value === null) r.diagnostics[0].code = 'OTHER'; else r.value = '0'; });
  }
  const current = { ...q[1], unit: 'ratio' }, prior = { ...q[0], unit: 'ratio' };
  const options = { comparison: 'qoq', mode: 'percentage_points' } as const;
  verify({ methodId: 'financial_growth', current, prior, options }, computeFinancialGrowth(current, prior, options), r => { r.value = '1'; });
  for (const snapshot of [ratioRow, { ...ratioRow, revenue: 0, averagePayables: null, capex: null }]) {
    const input = { methodId: 'financial_ratios' as const, snapshot }, result = computeFinancialRatios(snapshot);
    for (const key of Object.keys(result.values)) verify(input, result, r => { r.values[key] = '-123'; });
    if (result.diagnostics.length) verify(input, result, r => { r.diagnostics.pop(); });
  }
  for (const direction of ['forward_qfq', 'backward_hfq'] as const) {
    const market = { ...marketInput, direction, anchorDate: bars[direction === 'forward_qfq' ? 2 : 0].date };
    const input = { methodId: 'price_adjustment' as const, market }, result = computeAdjustedMarketSeries(market);
    verify(input, result, r => { r.rows[1].adj_factor = '0'; });
    verify(input, result, r => { r.rows[1].adjusted.high = '0'; });
    verify(input, result, r => { r.lineage.appliedActions[0].stepFactor = '0.5'; });
  }
});

test('隔离 WFD 正式存储的六个合成产品经 discoverProducts/readProduct 驱动五个 TS 算子，计算保持原快照', {
  skip: !(process.env.WFD_PYTHON && process.env.XUAN_FULL_CHAIN_ROOT) && '需要显式 WFD 解释器和隔离测试根', timeout: 120_000,
}, async () => {
  const host = createFullChainFixture({ name: 'pure-fixed-products', machine: true,
    units: pureFixtureUnits });
  const f = fixture(), db = new CoreDatabase();
  try {
    const runtime = createR1HandoffRuntime({ database: db, resources: new ResourceBindings(host.runtime), connectionId: 'full-chain-test' });
    const reader = new R1ProductReader({ runtime: () => runtime, control: () => ({ stopped: false, generation: 1 }) });
    f.companion.r1Workspace = { capabilities: () => ({ connection: runtime.currentIdentity() }), readBinding: () => runtime.currentReadBinding(),
      readProduct: reader.readProduct.bind(reader), discoverProducts: reader.discoverProducts.bind(reader) } as unknown as typeof f.companion.r1Workspace;
    const snapshotId = await seedPureOperatorProducts(runtime);
    const directory = (await f.invoke('algorithms.capabilities', { snapshotId })).snapshotDiscovery;
    const actualRef = (key: string) => discoveredPureReference(directory, snapshotId, key);
    for (const id of PURE_OPERATOR_IDS) {
      const request = calculation(id);
      const status = await f.run({ ...request, source: { kind: 'fixed_snapshot', reference: actualRef(products[id]),
        ...(id === 'price_adjustment' ? { actionReference: actualRef('actions') } : {}) } });
      assert.equal(status.methodId, id); assert.equal(status.verification.status, 'verified');
      assert.equal(status.fixedReads[0].snapshotId, snapshotId); assert.deepEqual(await f.invoke('algorithms.status', { taskId: status.taskId }), status);
    }
    f.state.quote = JSON.stringify({ purpose: 'historical_compute', action: 'algorithms.calculate', historyMode: 'market_known_at', cutoff });
    const historical = calculation('financial_ttm', { perspective: 'market_known_at', at: cutoff });
    const ttm = await f.run({ ...historical, source: { kind: 'fixed_snapshot', reference: { ...actualRef('ttm'), perspective: 'market_known_at', at: cutoff } } });
    assert.equal(ttm.result.value, '9'); assert.equal(ttm.fixedReads[0].historyMode, 'market_known_at');
    assert.equal((await reader.snapshotStatus()).snapshotId, snapshotId);
  } finally { f.close(); db.close(); }
});


test('原任务并发与失败保持单份密封结果，状态读回检出回执损坏', async () => {
  const f = fixture(), id = 'synthetic-retry';
  try {
    const request = calculation('financial_growth');
    const [first, retry] = await Promise.all([f.run(request, 'algorithms.calculate', id), f.run(request, 'algorithms.calculate', id)]);
    assert.deepEqual(retry, first);
    assert.equal(f.database.connection.prepare('SELECT count(*) AS n FROM pure_operator_runs').get()!.n, 1);
    await assert.rejects(f.run(calculation('financial_ttm'), 'algorithms.calculate', id), { code: 'PURE_OPERATOR_TASK_CONFLICT' });
    assert.deepEqual(await f.invoke('algorithms.status', { taskId: id }), first);
    f.database.connection.prepare("UPDATE pure_operator_runs SET receipt_json='{}' WHERE task_id=?").run(id);
    await assert.rejects(f.invoke('algorithms.status', { taskId: id }), { code: 'PURE_OPERATOR_RECEIPT_INVALID' });
  } finally { f.close(); }
});
