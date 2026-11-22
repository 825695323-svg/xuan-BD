import assert from 'node:assert/strict';
import test from 'node:test';
import type { WfdProductMachineReply } from '../../adapters/database/wfd-product-machine.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { CoreDatabase } from '../../platform/state/database.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import { R1ProductReader } from '../collection/r1-product-reader.js';
import type { R1Runtime } from '../collection/r1-runtime.js';
import { ConversationAlgorithmBridge } from './conversation-algorithms.js';

/** 原件、股票、因子、历史时间和连接均为合成样本；不连接供应商或真实 WFD。 */
const identity: R1ConnectionIdentity = { connectionId: 'synthetic-screen-reader', profile: 'data_only', protocol: 'wfd.structured-ingest/1.0',
  mode: 'user_test', purpose: 'user_test', runtimeIdentity: 'synthetic-screen', callerId: 'synthetic-screen', namespace: 'screen.test',
  store: '/synthetic-screen/store', runtime: '/synthetic-screen/runtime', configSha256: '1'.repeat(64), schemaSha256: '2'.repeat(64),
  entrySha256: '3'.repeat(64), pythonPath: '/synthetic-screen/python', entryPath: '/synthetic-screen/entry.py' };
const origin: ModelTaskOrigin = { callId: 'synthetic-call', conversationId: 'synthetic-conversation', parentRunId: 'synthetic-run',
  parentGeneration: 1, inputId: 'synthetic-input', branchId: 'synthetic-branch', messageId: 'synthetic-message',
  modelDigest: 'synthetic-model', endpointDigest: 'synthetic-endpoint', toolCallId: 'synthetic-tool-call', toolName: 'perform_action',
  notice: 'synthetic test only', receiver: { provider: 'synthetic', model: 'synthetic', origin: 'https://synthetic.invalid' } };
const request = () => ({ snapshotId: 's_synthetic_screen', productId: 'p_synthetic_screen', historyMode: 'snapshot_contents',
  selection: { dateField: 'trade_date', date: '2026-01-02', dateFormat: 'YYYYMMDD' },
  factorNames: ['momentum'], keyField: 'code', filter: 'momentum > 15', orderBy: 'rank(momentum)', topN: 2 });
const cell = (value: unknown, dataType = 'text', valueState = 'valid_value') =>
  ({ value, value_state: valueState, data_type: dataType, unit: { unit_code: dataType === 'text' ? 'text' : 'ratio' } });
const row = (code: string, momentum: unknown, date = '20260102', state = 'valid_value'): WfdRecord => ({
  record_ref: { logical_key: `synthetic/${date}/${code}`, revision_id: 'r_synthetic_v1' }, business_time: { status: 'unknown' },
  values: { code: cell(code), trade_date: cell(date), momentum: cell(momentum, 'decimal', state) },
});
const hasCode = (expected: string) => (error: unknown) => error instanceof TaskError && error.code === expected;

function fixture() {
  const database = new CoreDatabase();
  const state = { pages: [[row('A', '10'), row('OLD', '999', '20260101')],
    [row('B', '20'), row('C', '30'), row('MISSING', '999', '20260102', 'missing_unknown')]],
    identity: structuredClone(identity), stopped: false, generation: 1, rulesVersion: 20,
    origin: structuredClone(origin) as ModelTaskOrigin | null,
    afterRead: (_page: number) => {}, changeResult: (_value: WfdRecord, _page: number) => {},
    authorized: 0, dispatchChecked: 0, readCalls: [] as WfdRecord[], discoveryCalls: [] as string[] };
  const product: WfdRecord = { product_id: 'p_synthetic_screen', dataset_id: 'synthetic_factors', payload_kind: 'tabular_rows',
    subject: { kind: 'instrument_universe', namespace: 'synthetic', id: 'screen' }, declaration: {
      field_definitions: ['code', 'trade_date', 'momentum'].map(field_code =>
        ({ field_code, data_type: field_code === 'momentum' ? 'decimal' : 'text', unit_code: field_code === 'momentum' ? 'ratio' : 'text' })) },
    contracts: { read: { perspectives: ['snapshot_contents', 'market_known_at', 'system_held_at'] } },
    definition_ref: { id: 'synthetic-definition', version: 'v1' }, contract_ref: { id: 'synthetic-contract' } };
  const reply = (result: WfdRecord) => ({ result, response: {}, transport: {} }) as WfdProductMachineReply;
  const client = {
    contractDiscovery: async (snapshotId: string) => { state.discoveryCalls.push(snapshotId);
      return reply({ snapshot_id: snapshotId, product_count: 1, products: [product] }); },
    readProduct: async (input: WfdRecord) => {
      state.readCalls.push(structuredClone(input));
      const index = input.cursor === null ? 0 : Number(String(input.cursor).replace('synthetic-page-', ''));
      const rows = state.pages[index]!, total = state.pages.flat().length, hasMore = index + 1 < state.pages.length;
      const result: WfdRecord = { format_version: 'wfd.read-product-result/0.1', operation: 'read_product',
        snapshot_id: input.snapshot_id, product_id: input.product_id, dataset_id: input.dataset_id, fields: input.fields,
        history_mode: input.history_mode, knowledge_cutoff: input.knowledge_cutoff, held_scope: input.held_scope,
        usable_stage: input.usable_stage, business_time_range: null, subject: null, query_hash: 'sha256:' + 'a'.repeat(64),
        budget: { max_scan_bytes: input.max_scan_bytes }, diagnostics: [], complete: !hasMore, rows: structuredClone(rows),
        page: { page_size: input.page_size, returned_rows: rows.length, total_rows: total,
          remaining_rows: state.pages.slice(index + 1).flat().length, has_more: hasMore,
          next_cursor: hasMore ? `synthetic-page-${index + 1}` : null, page_complete: !hasMore } };
      state.changeResult(result, index); state.afterRead(index); return reply(result);
    },
  };
  const reader = new R1ProductReader({ runtime: () => ({ client: client as unknown as R1Runtime['client'], currentIdentity: () => state.identity }),
    control: () => ({ stopped: state.stopped, generation: state.generation }) });
  const switches = { calculate: true };
  const companion = { r1Workspace: { readProduct: reader.readProduct.bind(reader), capabilities: () => ({ connection: identity }) },
    productionModuleSwitches: switches, bd: { assertDispatch: () => { state.dispatchChecked += 1; } } } as unknown as WorkspaceServices;
  const bridge = new ConversationAlgorithmBridge({ database, companion, origin: () => state.origin, rulesVersion: () => state.rulesVersion });
  const controller = new AbortController();
  async function execute(value: unknown = request(), action = 'algorithms.screen', args?: Record<string, JsonValue>) {
    const result = await bridge.execute({ task: { id: 'synthetic-screen-task', action, args: args ?? { screenJson: JSON.stringify(value) } },
      signal: controller.signal, assertAuthorized: () => { state.authorized += 1; } } as unknown as TaskExecutionContext);
    return (result.data as WfdRecord).modelPreview as WfdRecord;
  }
  return { state, bridge, execute, switches, controller, companion, close: () => database.close() };
}

test('真实会话桥通过 R1 固定读取全部合成分页后排名；不依赖 Python，不补造缺值或日期', async () => {
  const f = fixture();
  try {
    assert.equal(f.bridge.registrations.find(item => item.action === 'algorithms.screen')!.available!().available, true);
    assert.equal(f.companion.algorithms, undefined);
    const result = await f.execute();
    assert.deepEqual((result.selected as WfdRecord[]).map(item => [item.key, item.score]), [['C', 1], ['B', 2 / 3]]);
    assert.equal((result.exclusionCounts as WfdRecord).missing_factor, 1, '非值态携带的 999 不能进入排名');
    assert.equal((result.exclusionCounts as WfdRecord).filter_false, 1);
    const evidence = result.fixedRead as WfdRecord;
    assert.equal(evidence.pages, 2); assert.equal(evidence.scannedRows, 5); assert.equal(evidence.crossSectionRows, 4);
    assert.equal(evidence.complete, true); assert.equal(evidence.coverageBasis, 'selected_fixed_product_only_not_all_market');
    assert.equal((evidence.connection as WfdRecord).connectionId, identity.connectionId);
    assert.equal('store' in (evidence.connection as WfdRecord), false);
    assert.deepEqual((evidence.selectedReferences as WfdRecord[])[0]!.recordRef, { logical_key: 'synthetic/20260102/C', revision_id: 'r_synthetic_v1' });
    assert.match(String(evidence.projectionSha256), /^[0-9a-f]{64}$/u);
    assert.equal(result.publication, 'not_requested'); assert.equal(result.automaticTrading, false); assert.equal(result.taskId, 'synthetic-screen-task');
    assert.deepEqual(f.state.readCalls.map(call => call.cursor), [null, 'synthetic-page-1']);
    assert.deepEqual(f.state.readCalls[0]!.fields, ['code', 'momentum', 'trade_date']);
    assert.equal(f.state.readCalls[0]!.dataset_id, 'synthetic_factors', '数据集来自受信发现，不来自模型请求');
    assert.equal(f.state.readCalls.some(call => 'indexed_tabular' in call), false);
    assert.ok(f.state.authorized >= 5); assert.ok(f.state.dispatchChecked >= 5);
    const contract = await f.execute(undefined, 'algorithms.contract', { methodId: 'strategy_screen' });
    assert.equal(contract.available, true); assert.equal(contract.executor, 'typescript');
    const capabilities = await f.execute(undefined, 'algorithms.capabilities', {});
    assert.equal((capabilities.screening as WfdRecord).available, true);
    assert.equal(f.state.readCalls.length, 2, '合同与发现不触发新读取');
  } finally { f.close(); }
});

test('历史筛选使用真实 R1 秒级截止与持有阶段；请求不能自填数据或以日期冒充时点', async () => {
  const f = fixture();
  try {
    const at = '2026-01-02T09:30:00Z';
    const result = await f.execute({ ...request(), historyMode: 'market_known_at', at });
    assert.equal((result.fixedRead as WfdRecord).historyMode, 'market_known_at');
    assert.deepEqual(f.state.readCalls[0]!.knowledge_cutoff, { status: 'known', precision: 'second', earliest_utc: at,
      latest_exclusive_utc: '2026-01-02T09:30:01Z', source_timezone: 'UTC' });
    await f.execute({ ...request(), historyMode: 'system_held_at', at, heldScope: 'synthetic-holding', usableStage: 'published_readable' });
    assert.equal(f.state.readCalls[2]!.held_scope, 'synthetic-holding');
    assert.equal(f.state.readCalls[2]!.usable_stage, 'published_readable');
    const before = f.state.readCalls.length;
    for (const input of [
      { ...request(), historyMode: 'market_known_at', at: '2026-01-02' },
      { ...request(), historyMode: 'market_known_at', at, readMode: 'indexed' },
      { ...request(), historyMode: 'system_held_at', at }, { ...request(), at },
      { ...request(), rows: [{ code: 'forged', momentum: 99 }] }, { ...request(), historyMode: undefined },
      { ...request(), snapshotId: 'latest' }, { ...request(), selection: { ...request().selection, date: '2026-02-30' } },
    ]) await assert.rejects(f.execute(input), hasCode('STRATEGY_SCREEN_WFD_INPUT'));
    assert.equal(f.state.readCalls.length, before, '非法历史或伪造行必须在读取前拒绝');
    f.state.changeResult = value => { value.knowledge_cutoff = null; };
    await assert.rejects(f.execute({ ...request(), historyMode: 'market_known_at', at }), hasCode('R1_READ_RESPONSE_INVALID'));
  } finally { f.close(); }
});

test('WFD reported_zero 原值参与排名；缺失不补零，矛盾的零值声明拒绝', async () => {
  const f = fixture();
  try {
    f.state.pages = [[row('ZERO', '0', '20260102', 'reported_zero'), row('PLUS', '10')],
      [row('UNKNOWN', '999', '20260102', 'missing_unknown')]];
    const result = await f.execute({ ...request(), filter: 'momentum >= 0', topN: 3 });
    assert.deepEqual((result.selected as WfdRecord[]).map(item => [item.key, item.score]), [['PLUS', 1], ['ZERO', .5]]);
    assert.equal((result.exclusionCounts as WfdRecord).missing_factor, 1);
    const zeroOnly = await f.execute({ ...request(), filter: 'not (momentum != 0)' });
    assert.deepEqual((zeroOnly.selected as WfdRecord[]).map(item => item.key), ['ZERO']);
    f.state.pages[0]![0] = row('ZERO', '1', '20260102', 'reported_zero');
    await assert.rejects(f.execute(), hasCode('STRATEGY_SCREEN_WFD_RESPONSE'));
  } finally { f.close(); }
});

test('WFD 已确定排除未来修订时保留合法历史截面及原诊断；不确定或改变的资格拒绝', async () => {
  const f = fixture(), at = '2026-01-02T09:30:00Z';
  try {
    const market = { product_id: request().productId, business_key: 'synthetic-older-record', revision_id: 'r_future',
      decision: 'ineligible', reason: 'time_interval_starts_after_cutoff', diagnostic_source: 'product_service_eligibility' };
    f.state.changeResult = value => { value.diagnostics = [market]; value.diagnostics_total = 1; };
    const result = await f.execute({ ...request(), historyMode: 'market_known_at', at });
    assert.deepEqual((result.selected as WfdRecord[]).map(item => item.key), ['C', 'B']);
    const evidence = result.fixedRead as WfdRecord;
    assert.equal(evidence.datasetId, 'synthetic_factors');
    assert.equal((evidence.knowledgeCutoff as WfdRecord).earliest_utc, at);
    assert.deepEqual(evidence.historicalExclusions, { source: 'WFD', scope: 'fixed_product_not_date_filtered', diagnostics: [market] });
    const holding = { product_id: request().productId, code: 'INSTANCE_HOLDING_COVERAGE_GAP', scope: 'product',
      aggregation: 'record_versions_by_holding_state', holding_state: 'not_yet_held', decision: 'ineligible',
      reason: 'HELD_STAGE_AFTER_CUTOFF', count: 2, count_basis: 'current_fixed_snapshot_not_subject_filtered_not_historical_known_total',
      diagnostic_source: 'product_service_eligibility' };
    f.state.changeResult = value => { value.diagnostics = [holding]; };
    const held = await f.execute({ ...request(), historyMode: 'system_held_at', at, heldScope: 'synthetic-holding', usableStage: 'published_readable' });
    assert.deepEqual(((held.fixedRead as WfdRecord).historicalExclusions as WfdRecord).diagnostics, [holding]);
    for (const diagnostic of [{ ...market, decision: 'indeterminate' }, { ...market, reason: 'UNKNOWN_NEW_POLICY' },
      { ...market, diagnostic_source: 'unverified' }, { ...market, product_id: 'p_other' }]) {
      f.state.changeResult = value => { value.diagnostics = [diagnostic]; };
      await assert.rejects(f.execute({ ...request(), historyMode: 'market_known_at', at }), hasCode('STRATEGY_SCREEN_WFD_INCOMPLETE'));
    }
    f.state.changeResult = (value, index) => { value.diagnostics = index ? [] : [market]; };
    await assert.rejects(f.execute({ ...request(), historyMode: 'market_known_at', at }), hasCode('STRATEGY_SCREEN_WFD_CHANGED'));
  } finally { f.close(); }
});

test('不完整、诊断、读取预算或缺标的均拒绝返回部分排名', async () => {
  const cases: Array<{ change(result: WfdRecord, index: number): void; code: string }> = [
    { change: (value, index) => { if (index === 1) value.complete = false; }, code: 'STRATEGY_SCREEN_WFD_INCOMPLETE' },
    { change: value => { value.diagnostics = [{ code: 'MISSING_SOURCE_PARTITION' }]; }, code: 'STRATEGY_SCREEN_WFD_INCOMPLETE' },
    { change: value => { (value.page as WfdRecord).total_rows = 10001; }, code: 'STRATEGY_SCREEN_WFD_BUDGET' },
    { change: (value, index) => { if (index === 1) value.query_hash = 'sha256:' + 'b'.repeat(64); }, code: 'STRATEGY_SCREEN_WFD_CHANGED' },
    { change: (value, index) => { if (index === 1) Object.assign(value.page as WfdRecord,
      { has_more: true, page_complete: false, next_cursor: 'synthetic-page-1' }); }, code: 'STRATEGY_SCREEN_WFD_RESPONSE' },
  ];
  for (const entry of cases) {
    const f = fixture();
    try { f.state.changeResult = entry.change; await assert.rejects(f.execute(), hasCode(entry.code)); }
    finally { f.close(); }
  }
  const f = fixture();
  try {
    await assert.rejects(f.execute({ ...request(), selection: { ...request().selection, keys: ['A', 'ABSENT'] } }),
      hasCode('STRATEGY_SCREEN_WFD_INCOMPLETE'));
    const result = await f.execute({ ...request(), filter: '', selection: { ...request().selection, keys: ['A', 'B'] } });
    assert.deepEqual((result.selected as WfdRecord[]).map(item => [item.key, item.score]), [['B', 1], ['A', .5]]);
  } finally { f.close(); }
});

test('日期未知、截面重复证券、重复引用、单位变化及伪造固定身份均拒绝', async () => {
  const cases: Array<{ change(result: WfdRecord, index: number): void; code: string }> = [
    { change: value => { ((value.rows as WfdRecord[])[0]!.values as WfdRecord).trade_date = cell(null, 'text', 'unknown'); },
      code: 'STRATEGY_SCREEN_CROSS_SECTION_UNKNOWN' },
    { change: (value, index) => { if (index === 1) ((value.rows as WfdRecord[])[0]!.values as WfdRecord).code = cell('A'); },
      code: 'STRATEGY_SCREEN_CROSS_SECTION_UNKNOWN' },
    { change: (value, index) => { if (index === 1) (value.rows as WfdRecord[])[0]!.record_ref =
      { logical_key: 'synthetic/20260102/A', revision_id: 'r_synthetic_v1' }; }, code: 'STRATEGY_SCREEN_WFD_RESPONSE' },
    { change: (value, index) => { if (index === 1) (((value.rows as WfdRecord[])[0]!.values as WfdRecord).momentum as WfdRecord).unit =
      { unit_code: 'currency' }; }, code: 'STRATEGY_SCREEN_FIELD_CHANGED' },
    { change: value => { ((value.rows as WfdRecord[])[0]!.record_ref as WfdRecord).snapshot_id = 's_another'; },
      code: 'STRATEGY_SCREEN_WFD_RESPONSE' },
  ];
  for (const entry of cases) {
    const f = fixture();
    try { f.state.changeResult = entry.change; await assert.rejects(f.execute(), hasCode(entry.code)); }
    finally { f.close(); }
  }
});

test('完整候选证据超过原 TaskService 结果预算时明确拒绝，不返回截断结果', async () => {
  const f = fixture();
  try {
    const rows = Array.from({ length: 115 }, (_, index) => ({ ...row(`S${index}`, String(index)),
      record_ref: { logical_key: `synthetic-${index}-` + 'x'.repeat(8000), revision_id: 'r_synthetic' } }));
    f.state.pages = [rows.slice(0, 100), rows.slice(100)];
    await assert.rejects(f.execute({ ...request(), filter: '', topN: 115 }), hasCode('STRATEGY_SCREEN_WFD_BUDGET'));
    assert.equal(f.state.readCalls.length, 2, '两个真实固定分页均读取完整，限制针对完整输出体积');
  } finally { f.close(); }
});

test('计算停用、真实会话撤销与取消在分页间生效，不能返回已经读到的部分结果', async () => {
  const disabled = fixture();
  try {
    disabled.switches.calculate = false;
    assert.equal(disabled.bridge.registrations.find(item => item.action === 'algorithms.screen')!.available!().available, false);
    await assert.rejects(disabled.execute(), hasCode('PRODUCTION_CALCULATION_DISABLED'));
    assert.equal(disabled.state.readCalls.length, 0);
  } finally { disabled.close(); }
  for (const stop of ['module', 'origin', 'cancel'] as const) {
    const f = fixture();
    try {
      f.state.afterRead = () => {
        if (stop === 'module') f.switches.calculate = false;
        if (stop === 'origin') f.state.origin = null;
        if (stop === 'cancel') f.controller.abort(new Error('synthetic cancellation'));
      };
      await assert.rejects(f.execute(), stop === 'module' ? hasCode('PRODUCTION_CALCULATION_DISABLED')
        : stop === 'origin' ? hasCode('ALGORITHM_CONVERSATION_REQUIRED') : hasCode('R1_READ_ABORTED'));
      assert.equal(f.state.readCalls.length, 1);
    } finally { f.close(); }
  }
});

test('无 WFD 或旧会话冻结规则不会获得新筛选能力', async () => {
  const f = fixture();
  try {
    f.state.rulesVersion = 19;
    await assert.rejects(f.execute(), hasCode('ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES'));
    assert.equal(f.state.readCalls.length, 0);
    f.state.rulesVersion = 20; f.state.origin = null;
    await assert.rejects(f.execute(), hasCode('ALGORITHM_CONVERSATION_REQUIRED'));
    f.state.origin = structuredClone(origin); f.companion.r1Workspace = undefined;
    assert.equal(f.bridge.registrations.find(item => item.action === 'algorithms.screen')!.available!().available, false);
    await assert.rejects(f.execute(), hasCode('PRODUCTION_CALCULATION_UNAVAILABLE'));
  } finally { f.close(); }
});
