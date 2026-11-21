import assert from 'node:assert/strict';
import test from 'node:test';
import type { WfdProductMachineReply } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import { CoreDatabase } from '../../platform/state/database.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import { R1ProductReader } from '../collection/r1-product-reader.js';
import type { R1Runtime } from '../collection/r1-runtime.js';
import { ConversationAlgorithmBridge } from './conversation-algorithms.js';
import { screenFixedWfdStrategy } from './strategy-screen-wfd.js';

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
const syntheticContract = { digest: 'sha256:' + 'c'.repeat(64) };
const row = (code: string, momentum: unknown, date = '20260102', state = 'valid_value'): WfdRecord => ({
  contract_ref: syntheticContract, record_ref: { logical_key: `synthetic/${date}/${code}`, revision_id: 'r_synthetic_v1' }, business_time: { status: 'unknown' },
  values: { code: cell(code), trade_date: cell(date), momentum: cell(momentum, 'decimal', state) },
});
const hasCode = (expected: string) => (error: unknown) => error instanceof TaskError && error.code === expected;

function fixture() {
  const database = new CoreDatabase();
  const state = { pages: [[row('A', '10'), row('OLD', '999', '20260101')],
    [row('B', '20'), row('C', '30'), row('MISSING', '999', '20260102', 'missing_unknown')]],
    identity: structuredClone(identity), stopped: false, generation: 1, rulesVersion: 21 as number | undefined,
    historicalPurpose: false, audit: null as WfdRecord | null,
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
        budget: { max_scan_bytes: input.max_scan_bytes }, diagnostics: [], complete: !hasMore, rows: structuredClone(rows).map(raw => {
          if (input.history_mode === 'market_known_at') return { ...raw,
            times: { public_time: { status: 'known', earliest_utc: '2026-01-01T09:00:00Z', latest_exclusive_utc: '2026-01-01T09:00:01Z' } },
            eligibility: { decision: 'eligible', reason: 'evidence_interval_ended_before_cutoff' } };
          if (input.history_mode === 'system_held_at') {
            const held_at = '2026-01-02T09:29:00Z';
            return { ...raw, held_at, held_scope: input.held_scope, usable_stage: input.usable_stage,
              eligibility: { decision: 'eligible', reason: 'held_at_usable_stage', mode: input.history_mode, held_at, usable_stage: input.usable_stage } };
          }
          return raw;
        }),
        page: { page_size: input.page_size, returned_rows: rows.length, total_rows: total,
          remaining_rows: state.pages.slice(index).flat().length, has_more: hasMore,
          next_cursor: hasMore ? `synthetic-page-${index + 1}` : null, page_complete: !hasMore } };
      state.changeResult(result, index); state.afterRead(index); return reply(result);
    },
  };
  const reader = new R1ProductReader({ runtime: () => ({ client: client as unknown as R1Runtime['client'], currentIdentity: () => state.identity }),
    control: () => ({ stopped: state.stopped, generation: state.generation }) });
  const switches = { calculate: true };
  const companion = { r1Workspace: { readProduct: reader.readProduct.bind(reader), capabilities: () => ({ connection: identity }),
    readBinding: () => ({ readSchemaSha256: '4'.repeat(64), queryImplSha256: '5'.repeat(64) }) },
    productionModuleSwitches: switches, bd: { assertDispatch: () => { state.dispatchChecked += 1; } } } as unknown as WorkspaceServices;
  const bridge = new ConversationAlgorithmBridge({ database, companion, origin: () => state.origin, rulesVersion: () => state.rulesVersion,
    submissionContext: () => state.historicalPurpose ? { authority: 'operator-http', requestId: 'isolated-operator',
      observedAtUtc: '2026-01-02T09:30:00Z' } : undefined });
  const controller = new AbortController();
  async function execute(value: unknown = request(), action = 'algorithms.screen', args?: Record<string, JsonValue>) {
    const result = await bridge.execute({ task: { id: 'synthetic-screen-task', action, args: args ?? { screenJson: JSON.stringify(value) } },
      signal: controller.signal, assertAuthorized: () => { state.authorized += 1; } } as unknown as TaskExecutionContext);
    state.audit = result.data as WfdRecord;
    return state.audit.modelPreview as WfdRecord;
  }
  return { state, bridge, reader, execute, switches, controller, companion, close: () => database.close() };
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
    for (const history of [{ historyMode: 'market_known_at', at },
      { historyMode: 'system_held_at', at, heldScope: 'synthetic-holding', usableStage: 'published_readable' }]) {
      await assert.rejects(f.execute({ ...request(), ...history }), hasCode('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED'));
      await assert.rejects(f.execute({ ...request(), ...history, purposeContext: { authority: 'operator-http' } }), hasCode('STRATEGY_SCREEN_WFD_INPUT'));
    }
    assert.equal(f.state.discoveryCalls.length, 0);
    f.state.historicalPurpose = true;
    const started = Date.now();
    const result = await f.execute({ ...request(), historyMode: 'market_known_at', at });
    assert.equal((result.fixedRead as WfdRecord).historyMode, 'market_known_at');
    assert.equal(result.replay, true);
    assert.ok(Date.parse(String(result.evaluatedAtUtc)) >= started && Date.parse(String(result.evaluatedAtUtc)) <= Date.now());
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
    f.state.pages = [[row('ZERO', '0', '20260102', 'reported_zero')]];
    const zero = (f.state.pages[0][0].values as Record<string, WfdRecord>).momentum;
    zero.data_type = 'integer';
    assert.equal(((await f.execute({ ...request(), filter: 'momentum == 0' })).selected as WfdRecord[])[0].key, 'ZERO');
    zero.data_type = 'text';
    await assert.rejects(f.execute(), hasCode('STRATEGY_SCREEN_WFD_RESPONSE'));
    f.state.pages[0]![0] = row('ZERO', '1', '20260102', 'reported_zero');
    await assert.rejects(f.execute(), hasCode('STRATEGY_SCREEN_WFD_RESPONSE'));
  } finally { f.close(); }
});

test('WFD 已确定排除未来修订时保留合法历史截面及原诊断；不确定或改变的资格拒绝', async () => {
  const f = fixture(), at = '2026-01-02T09:30:00Z';
  try {
    f.state.historicalPurpose = true;
    const market = { product_id: request().productId, business_key: 'synthetic-older-record', revision_id: 'r_future',
      subject: { id: 'secret-future-subject' },
      decision: 'ineligible', reason: 'time_interval_starts_after_cutoff', diagnostic_source: 'product_service_eligibility' };
    f.state.changeResult = value => { value.diagnostics = [market]; value.diagnostics_total = 1; };
    const result = await f.execute({ ...request(), historyMode: 'market_known_at', at });
    assert.deepEqual((result.selected as WfdRecord[]).map(item => item.key), ['C', 'B']);
    const evidence = result.fixedRead as WfdRecord;
    assert.equal(evidence.datasetId, 'synthetic_factors');
    assert.equal((evidence.knowledgeCutoff as WfdRecord).earliest_utc, at);
    assert.deepEqual(f.state.audit!.historicalExclusions, { source: 'WFD', scope: 'fixed_product_not_date_filtered', diagnostics: [market] });
    assert.deepEqual(evidence.historicalExclusions, { source: 'WFD', scope: 'fixed_product_not_date_filtered',
      excludedCount: 1, byReason: { time_interval_starts_after_cutoff: 1 } });
    assert.doesNotMatch(JSON.stringify(result), /synthetic-older-record|r_future|business_key|secret-future-subject/u);
    const holding = { product_id: request().productId, code: 'INSTANCE_HOLDING_COVERAGE_GAP', scope: 'product',
      aggregation: 'record_versions_by_holding_state', holding_state: 'not_yet_held', decision: 'ineligible',
      reason: 'HELD_STAGE_AFTER_CUTOFF', count: 2, count_basis: 'current_fixed_snapshot_not_subject_filtered_not_historical_known_total',
      diagnostic_source: 'product_service_eligibility' };
    f.state.changeResult = value => { value.diagnostics = [holding]; };
    const held = await f.execute({ ...request(), historyMode: 'system_held_at', at, heldScope: 'synthetic-holding', usableStage: 'published_readable' });
    assert.equal(((held.fixedRead as WfdRecord).historicalExclusions as WfdRecord).excludedCount, 2);
    assert.deepEqual((f.state.audit!.historicalExclusions as WfdRecord).diagnostics, [holding]);
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
    { change: value => { (value.page as WfdRecord).remaining_rows = 3; }, code: 'STRATEGY_SCREEN_WFD_RESPONSE' },
    { change: (value, index) => { if (index === 1) (value.page as WfdRecord).remaining_rows = 0; }, code: 'STRATEGY_SCREEN_WFD_RESPONSE' },
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

test('普通产品及兼容顶层返回均固定定义和合同，仅相同版本的截面行可以混合排名', async () => {
  const f = fixture();
  const definition = { version: 'v1', digest: 'sha256:' + '1'.repeat(64) };
  const contract = { digest: 'sha256:' + 'a'.repeat(64) }, other = { digest: 'sha256:' + 'b'.repeat(64) };
  const version = { definition_ref: definition, contract_ref: contract, fields: [{ field_code: 'momentum' }] };
  const metadata = { definition_refs: [definition], contract_refs: [contract], contract_versions: [version] };
  try {
    assert.deepEqual(((await f.execute()).fixedRead as WfdRecord).contractRef, syntheticContract);
    f.state.changeResult = value => { for (const raw of value.rows as WfdRecord[]) delete raw.contract_ref; };
    await assert.rejects(f.execute(), hasCode('STRATEGY_SCREEN_DEFINITION_MIXED'));
    f.state.changeResult = value => {
      value.product = metadata;
      for (const raw of value.rows as WfdRecord[]) delete raw.contract_ref;
    };
    assert.deepEqual(((await f.execute()).fixedRead as WfdRecord).definitionRef, definition);
    f.state.changeResult = value => {
      value.product = { definition_refs: [definition] };
    };
    assert.deepEqual(((await f.execute()).fixedRead as WfdRecord).contractRef, syntheticContract);
    assert.deepEqual(((await f.execute()).fixedRead as WfdRecord).definitionRef, definition);
    f.state.changeResult = value => {
      value.product = { definition_refs: [definition] };
      for (const raw of value.rows as WfdRecord[]) delete raw.contract_ref;
    };
    await assert.rejects(f.execute(), hasCode('STRATEGY_SCREEN_DEFINITION_MIXED'));
    f.state.changeResult = value => {
      value.product = { definition_refs: [definition] };
      delete (value.rows as WfdRecord[])[0].contract_ref;
    };
    await assert.rejects(f.execute(), hasCode('STRATEGY_SCREEN_DEFINITION_MIXED'));
    f.state.changeResult = value => {
      value.contract_versions = [{ version: 'v1' }];
      for (const raw of value.rows as WfdRecord[]) delete raw.contract_ref;
    };
    assert.equal(((await f.execute()).fixedRead as WfdRecord).contractVersionsSha256, wfdSha256(canonicalWfdJson([{ version: 'v1' }])));
    f.state.changeResult = value => {
      value.contract_versions = [{ version: 'v1' }];
      for (const raw of value.rows as WfdRecord[]) raw.contract_ref = { version: 'v1' };
    };
    assert.equal(((await f.execute()).fixedRead as WfdRecord).crossSectionRows, 4);
    for (const mismatch of [{ version: 'v2' }, { version: 'v1', digest: 'sha256:' + 'f'.repeat(64) }]) {
      f.state.changeResult = value => {
        value.contract_versions = [{ version: 'v1' }];
        for (const raw of value.rows as WfdRecord[]) raw.contract_ref = mismatch;
      };
      await assert.rejects(f.execute(), hasCode('STRATEGY_SCREEN_DEFINITION_MIXED'));
    }
    for (const nested of [true, false]) {
      f.state.changeResult = value => {
        Object.assign(value, nested ? { product: metadata } : metadata);
        for (const raw of value.rows as WfdRecord[]) raw.contract_ref = contract;
      };
      const fixed = (await f.execute()).fixedRead as WfdRecord;
      assert.deepEqual(fixed.definitionRefs, [definition]); assert.deepEqual(fixed.contractRef, contract);
      assert.equal(fixed.contractVersionsSha256, wfdSha256(canonicalWfdJson([version])));
    }
    for (const change of [
      (value: WfdRecord) => { for (const raw of value.rows as WfdRecord[]) raw.contract_ref = {}; },
      (value: WfdRecord) => { delete (value.rows as WfdRecord[])[0].contract_ref; },
      (value: WfdRecord) => { value.product = { definition_refs: [definition, { ...definition, version: 'v2' }] }; },
      (value: WfdRecord) => { value.contract_versions = [version, { ...version, contract_ref: other }]; },
      (value: WfdRecord) => { value.product = metadata; value.contract_versions = [{ ...version, contract_ref: other }]; },
      (value: WfdRecord) => { value.product = metadata; (value.rows as WfdRecord[])[0]!.contract_ref = other; },
      (value: WfdRecord, index: number) => { value.product = { definition_refs: [{ ...definition, version: 'v' + index }] }; },
      (value: WfdRecord, index: number) => { value.product = { contract_versions: [{ ...version, contract_ref: index ? other : contract }] }; },
      (value: WfdRecord, index: number) => { for (const raw of value.rows as WfdRecord[]) raw.contract_ref = index ? other : contract; },
      (value: WfdRecord, index: number) => { if (index) (value.rows as WfdRecord[])[0]!.contract_ref = contract; },
      (value: WfdRecord, index: number) => { if (!index) (value.rows as WfdRecord[])[0]!.contract_ref = contract; },
    ]) {
      f.state.changeResult = change;
      await assert.rejects(f.execute(), hasCode('STRATEGY_SCREEN_DEFINITION_MIXED'));
    }
    f.state.changeResult = (value, index) => {
      for (const raw of value.rows as WfdRecord[]) raw.contract_ref = contract;
      if (!index) (value.rows as WfdRecord[])[1]!.contract_ref = other; // OLD 不在选择日期内
    };
    assert.equal(((await f.execute()).fixedRead as WfdRecord).crossSectionRows, 4);
  } finally { f.close(); }
});

test('每一历史行须有匹配视角的合格判决和截止前的实际持有阶段', async () => {
  const f = fixture(), at = '2026-01-02T09:30:00Z';
  f.state.historicalPurpose = true;
  try {
    for (const historyMode of ['system_held_at', 'market_known_at']) {
      const held = historyMode === 'system_held_at';
      const call = { ...request(), at, historyMode, ...(held ? { heldScope: 'test', usableStage: 'custodied' } : {}) };
      for (const change of [
        (raw: WfdRecord) => { delete raw.eligibility; },
        (raw: WfdRecord) => { raw.eligibility = { decision: 'indeterminate' }; },
        (raw: WfdRecord) => { raw.eligibility = { decision: 'eligible', mode: 'snapshot_contents' }; },
        ...(held ? [
          (raw: WfdRecord) => { delete raw.held_at; },
          (raw: WfdRecord) => { raw.held_at = '2026-01-03T00:00:00Z'; },
          (raw: WfdRecord) => { raw.held_scope = 'other'; },
          (raw: WfdRecord) => { raw.usable_stage = 'acquired'; },
          (raw: WfdRecord) => { (raw.eligibility as WfdRecord).usable_stage = 'acquired'; },
        ] : [
          (raw: WfdRecord) => { delete raw.times; },
          (raw: WfdRecord) => { raw.times = { public_time: { status: 'unknown' } }; },
          ...[['2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z'], ['2026-01-01T00:00:00Z', '2026-01-02T09:30:01Z'],
            [at, '2026-01-01T00:00:00Z'], ['invalid', at]].map(([start, end]) => (raw: WfdRecord) => {
            raw.times = { public_time: { status: 'known', earliest_utc: start, latest_exclusive_utc: end } };
          }),
        ]),
      ]) {
        f.state.changeResult = value => change((value.rows as WfdRecord[])[0]!);
        await assert.rejects(f.execute(call), hasCode('STRATEGY_SCREEN_ROW_INELIGIBLE'));
      }
    }
  } finally { f.close(); }
});

test('单调时钟覆盖等待、同步筛选及最终证据序列化，事件循环忙时不能越过耗时上限', async t => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const f = fixture();
  try {
    f.state.pages = [[row('A', '18')]];
    f.state.afterRead = () => { elapsed += 30_000; };
    await assert.rejects(f.execute(), hasCode('R1_READ_ABORTED'));
    f.state.afterRead = () => {};
    for (const checkpoint of [2, 3, 4, 5]) {
      let checks = 0;
      await assert.rejects(screenFixedWfdStrategy(request(), f.reader.readProduct.bind(f.reader), undefined, () => {
        // 单页的页后、计算前、计算后和最终结果检查。
        if (++checks === checkpoint) elapsed += 60_000;
      }), hasCode('STRATEGY_SCREEN_WFD_BUDGET'));
    }
  } finally { f.close(); }
});

test('两个已验证页之间的绑定漂移、错误的历史截止以及读取中撤回用途均拒绝', async () => {
  const f = fixture(), at = '2026-01-02T09:30:00Z';
  try {
    await assert.rejects(screenFixedWfdStrategy(request(), async (input, signal) => {
      const response = await f.reader.readProduct(input, signal);
      f.state.identity.configSha256 = 'f'.repeat(64);
      return response;
    }), hasCode('STRATEGY_SCREEN_WFD_CHANGED'));
    const historyMode = 'market_known_at';
    await assert.rejects(screenFixedWfdStrategy({ ...request(), historyMode, at }, async (input, signal) => {
      const response = await f.reader.readProduct(input, signal);
      (response.result.knowledge_cutoff as WfdRecord).earliest_utc = '2026-01-03T09:30:00Z';
      return response;
    }, undefined, undefined, { authority: 'operator-http', requestId: 'test', observedAtUtc: at,
      purpose: 'historical_compute', historyMode, cutoff: at }), hasCode('STRATEGY_SCREEN_WFD_RESPONSE'));
    f.state.historicalPurpose = true;
    f.state.afterRead = () => { f.state.historicalPurpose = false; };
    await assert.rejects(f.execute({ ...request(), historyMode, at }), hasCode('ALGORITHM_PURPOSE_EVIDENCE_REQUIRED'));
  } finally { f.close(); }
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
    for (const version of [18, 19, 20, undefined]) {
      f.state.rulesVersion = version;
      await assert.rejects(f.execute(), hasCode('ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES'));
      await assert.rejects(f.execute(undefined, 'algorithms.contract', { methodId: 'strategy_screen' }), hasCode('ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES'));
    }
    assert.equal(f.state.readCalls.length, 0);
    f.state.rulesVersion = 21; f.state.origin = null;
    await assert.rejects(f.execute(), hasCode('ALGORITHM_CONVERSATION_REQUIRED'));
    f.state.origin = structuredClone(origin); f.companion.r1Workspace = undefined;
    assert.equal(f.bridge.registrations.find(item => item.action === 'algorithms.screen')!.available!().available, false);
    await assert.rejects(f.execute(), hasCode('PRODUCTION_CALCULATION_UNAVAILABLE'));
  } finally { f.close(); }
});

test('固定读配置、连接身份和模块开关共同决定工具可用性，失效后拒绝后续分页', async () => {
  const f = fixture(), port = f.companion.r1Workspace!;
  const registration = f.bridge.registrations.find(item => item.action === 'algorithms.screen')!;
  try {
    for (const [configuration, connection, available] of [
      [undefined, identity, true], ['configured', identity, true], ['unavailable', identity, false],
      ['not_configured', identity, false], ['ready', identity, false], ['configured', null, false], [undefined, null, false],
    ] as const) {
      port.capabilities = () => ({ configuration: configuration && { state: configuration }, connection }) as ReturnType<typeof port.capabilities>;
      assert.equal(registration.available().available, available);
      assert.equal((await f.execute(undefined, 'algorithms.contract', { methodId: 'strategy_screen' })).available, available);
      assert.equal(((await f.execute(undefined, 'algorithms.capabilities', {})).screening as WfdRecord).available, available);
      if (!available) await assert.rejects(f.execute(), hasCode('PRODUCTION_CALCULATION_UNAVAILABLE'));
    }
    assert.equal(f.state.readCalls.length, 0);
    port.capabilities = () => ({ connection: identity }) as ReturnType<typeof port.capabilities>;
    f.state.afterRead = () => { port.capabilities = () => ({ connection: null }) as ReturnType<typeof port.capabilities>; };
    await assert.rejects(f.execute(), hasCode('PRODUCTION_CALCULATION_UNAVAILABLE'));
    assert.equal(f.state.readCalls.length, 1);
  } finally { f.close(); }
});
