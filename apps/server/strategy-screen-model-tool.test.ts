import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WfdProductMachineReply } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { Backend, BackendInput, BackendSession } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { R1ProductReader } from '../../modules/collection/r1-product-reader.js';
import { createR1HandoffRuntime, type R1Runtime } from '../../modules/collection/r1-runtime.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { screenFixedWfdStrategy } from '../../modules/financial/strategy-screen-wfd.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { createFullChainFixture } from './full-chain-test-support.js';
import { createApplicationServices } from './services.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const model = { provider: 'synthetic', model: 'synthetic', baseUrl: 'https://model.invalid.test/v1' };
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false,
  provider: model.provider, model: model.model, notice: 'Synthetic model and WFD transport only; no external calls.' };
const toolContext = {} as Parameters<ToolDefinition['execute']>[4];
const preview = (result: Awaited<ReturnType<ToolDefinition['execute']>>): Record<string, any> =>
  JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join(''));

test('隔离 WFD 真实普通产品跨页筛选，同时核对市场公开判决与实例实际持有台账', {
  skip: !(process.env.XUAN_FULL_CHAIN_ROOT && process.env.WFD_PYTHON) && '需要隔离根和显式 WFD Python', timeout: 90_000,
}, async () => {
  const f = createFullChainFixture({ name: 'screen-historical-table', machine: true,
    units: { text: { dimension: 'text' }, count: { dimension: 'quantity' } } });
  const database = new CoreDatabase();
  try {
    const runtime = createR1HandoffRuntime({ database, resources: new ResourceBindings(f.runtime), connectionId: 'full-chain-test' });
    const reader = new R1ProductReader({ runtime: () => runtime, control: () => ({ stopped: false, generation: 1 }) });
    const namespace = 'full.chain.test', subject = { kind: 'entity', namespace, id: 'screen_sample' };
    const day = (date: string) => ({ status: 'known', precision: 'day', source_timezone: 'UTC',
      earliest_utc: date + 'T00:00:00Z', latest_exclusive_utc: new Date(Date.parse(date + 'T00:00:00Z') + 86_400_000).toISOString().replace('.000Z', 'Z') });
    const text = (value: string) => ({ data_type: 'text', value_state: 'valid_value', value });
    const rows = Array.from({ length: 102 }, (_, index) => ({
      business_key: 'sample-' + index, subject, observation_time: day('2026-01-02'),
      public_time: day(index === 101 ? '2026-01-10' : '2026-01-02'),
      values: { code: text('S' + index), trade_date: text('2026-01-02'),
        score: { data_type: 'decimal', value_state: 'valid_value', value: String(index) } },
    }));
    const seed = buildStructuredIngestDocument({ requestId: 'screen-synthetic-input', datasetId: 'screen_synthetic',
      namespace, producerNamespace: namespace, submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson(rows)),
      expectedParentSnapshotId: null, outputKey: 'screen', subject, inputMode: 'partial_observation', definitionPublicTime: day('2025-12-01'),
      definition: { semantic_code: 'synthetic.screen.sample', measurement_nature: 'mixed_observation', unit_code: 'per_field',
        definition_authority: namespace, time_role: 'observation', semantic_context: { version: 'wfd.semantic-context/1.0',
          content_nature: 'observed_fact', time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' } },
        field_definitions: ['code', 'trade_date', 'score'].map(field_code => ({ field_code,
          data_type: field_code === 'score' ? 'decimal' : 'text', unit_code: field_code === 'score' ? 'count' : 'text',
          measurement_nature: field_code === 'score' ? 'stock' : 'relation', time_role: 'observation' })) },
      coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      payload: { kind: 'tabular_rows', rows } });
    const { result } = await runtime.client.submit(seed);
    assert.equal(result.state, 'published_formal', JSON.stringify(result.errors));
    const output = (result.output_results as WfdRecord[])[0]!, holding = result.holding_status;
    assert.ok(isWfdRecord(holding) && holding.state === 'recorded');
    const request = { snapshotId: result.snapshot_id, productId: output.product_id,
      selection: { dateField: 'trade_date', date: '2026-01-02', dateFormat: 'YYYY-MM-DD' }, factorNames: ['score'],
      keyField: 'code', filter: '', orderBy: 'score', topN: 1 };
    for (const [historyMode, at, selected] of [['market_known_at', '2026-01-04T00:00:00Z', 'S100'],
      ['system_held_at', String(holding.published_readable_at), 'S101']] as const) {
      const screened = await screenFixedWfdStrategy({ ...request, historyMode, at, ...(historyMode === 'system_held_at'
        ? { heldScope: holding.instance_id, usableStage: 'published_readable' } : {}) }, reader.readProduct.bind(reader), undefined, undefined,
        { purpose: 'historical_compute', historyMode, cutoff: at, authority: 'operator-http', requestId: 'screen-replay', observedAtUtc: new Date().toISOString() });
      assert.equal(screened.fixedRead.pages, 2); assert.equal(screened.selected[0]!.key, selected);
      assert.deepEqual(screened.fixedRead.definitionRefs, [output.definition_ref]);
      assert.ok(isWfdRecord(screened.fixedRead.contractRef) && screened.fixedRead.contractRef.digest);
      assert.equal(screened.fixedRead.historicalExclusions.diagnostics.length, historyMode === 'market_known_at' ? 1 : 0);
    }
    assert.equal((await runtime.client.snapshotStatus()).result.snapshot_id, result.snapshot_id);
  } finally { database.close(); }
});

/** 仅替换 WFD 进程响应，固定读合同、查询验证、会话、权限、任务和结果保管均用真实实现。 */
function syntheticReader() {
  const identity: R1ConnectionIdentity = { connectionId: 'synthetic-screen', profile: 'data_only', protocol: 'wfd.structured-ingest/1.0',
    mode: 'user_test', purpose: 'user_test', runtimeIdentity: 'synthetic-screen', callerId: 'synthetic-screen', namespace: 'synthetic.screen',
    store: '/synthetic/store', runtime: '/synthetic/runtime', configSha256: '1'.repeat(64), schemaSha256: '2'.repeat(64),
    entrySha256: '3'.repeat(64), pythonPath: '/synthetic/not-executed', entryPath: '/synthetic/not-executed.py' };
  const calls: WfdRecord[] = [];
  let largeScreenRows = false;
  const reply = (result: WfdRecord) => ({ result, response: {}, transport: {} }) as WfdProductMachineReply;
  const client = {
    contractDiscovery: async (snapshotId: string) => reply({ snapshot_id: snapshotId, product_count: 1,
      products: [{ product_id: 'p_synthetic', dataset_id: 'synthetic_cross_section', payload_kind: 'tabular_rows',
        subject: { kind: 'instrument_universe', namespace: 'synthetic', id: 'screen' },
        declaration: { field_definitions: ['code', 'trade_date', 'momentum'].map(field_code =>
          ({ field_code, data_type: field_code === 'momentum' ? 'decimal' : 'text' })) },
        contracts: { read: { perspectives: ['snapshot_contents', 'market_known_at'] } }, definition_ref: { id: 'synthetic-def', version: 'v1' },
        contract_ref: { id: 'synthetic-contract' } }] }),
    readProduct: async (input: WfdRecord) => {
      calls.push(structuredClone(input));
      const cell = (value: unknown, dataType = 'text') => ({ value, value_state: 'valid_value', data_type: dataType,
        unit: { unit_code: dataType === 'text' ? 'text' : 'ratio' } });
      return reply({ format_version: 'wfd.read-product-result/0.1', operation: 'read_product',
        snapshot_id: input.snapshot_id, product_id: input.product_id, dataset_id: input.dataset_id, fields: input.fields,
        history_mode: input.history_mode, knowledge_cutoff: input.knowledge_cutoff, held_scope: input.held_scope,
        usable_stage: input.usable_stage, business_time_range: null, subject: null,
        query_hash: 'sha256:' + 'a'.repeat(64), budget: { max_scan_bytes: input.max_scan_bytes },
        diagnostics: input.history_mode === 'market_known_at' ? [{ product_id: input.product_id, business_key: 'future-key',
          revision_id: 'r_future', subject: { id: 'future-subject' }, reason: 'time_interval_starts_after_cutoff',
          decision: 'ineligible', diagnostic_source: 'product_service_eligibility' }] : [], complete: true,
        rows: (largeScreenRows ? Array.from({ length: 95 }, (_, idx) => [`S${String(idx).padStart(4, '0')}_${'X'.repeat(90)}`, String(idx + 1)]) : [['A', '2'], ['B', '5']])
          .map(([code, momentum]) => ({
          contract_ref: { digest: 'sha256:' + 'a'.repeat(64) },
          times: { public_time: { status: 'known', earliest_utc: '2026-01-01T09:00:00Z', latest_exclusive_utc: '2026-01-02T09:30:00Z' } },
          eligibility: { decision: 'eligible', reason: 'evidence_interval_ended_before_cutoff' },
          record_ref: { logical_key: `synthetic-${code}`, revision_id: 'r_synthetic' }, business_time: { status: 'unknown' },
          values: { code: cell(code), trade_date: cell('2026-01-02'), momentum: cell(momentum, 'decimal') } })),
        page: { page_size: input.page_size, returned_rows: largeScreenRows ? 95 : 2, total_rows: largeScreenRows ? 95 : 2, remaining_rows: largeScreenRows ? 95 : 2,
          has_more: false, next_cursor: null, page_complete: true } });
    },
  };
  const reader = new R1ProductReader({ runtime: () => ({ client: client as unknown as R1Runtime['client'], currentIdentity: () => identity }),
    control: () => ({ stopped: false, generation: 1 }) });
  return { reader, calls, identity, setLargeScreenRows(value: boolean) { largeScreenRows = value; } };
}

test('AGENTS discovers and executes strategy screen through real perform_action / TaskService; replay is fixed and disable blocks new work', {
  skip: !process.env.XUAN_FULL_CHAIN_ROOT && '需要显式 XUAN_FULL_CHAIN_ROOT（隔离测试根）；不使用真实 WFD 或模型。', timeout: 30_000,
}, async t => {
  const f = createFullChainFixture({ name: 'strategy-screen-model' }), synthetic = syntheticReader();
  let capture!: (input: BackendInput) => void, finish: () => void = () => {};
  const gates = new Map<string, () => void>();
  const backend: Backend = { id: 'synthetic-screen-capture', async createSession(): Promise<BackendSession> {
    const checkpoint = { backendId: this.id, format: 'synthetic-capture', version: 1, sessionRef: 'screen-capture', payload: null };
    return { id: 'screen-capture', send: async (input, emit) => {
      await emit({ type: 'run_started' });
      await emit({ type: 'input_consumed', inputId: input.inputId, messageKey: input.messageId });
      const runGate = new Promise<void>(resolve => { gates.set(input.runId, resolve); });
      capture(input); await runGate;
      return { outcome: 'completed', checkpoint };
    }, steer: async () => ({ disposition: 'handled' }), exportCheckpoint: async () => checkpoint,
    abort: async () => { for (const done of gates.values()) done(); gates.clear(); }, dispose: () => { for (const done of gates.values()) done(); gates.clear(); } };
  } };
  finish = () => { for (const done of gates.values()) done(); gates.clear(); };
  const resources = new ResourceBindings(f.runtime), switches = { calculate: true };
  const companionDb = new CoreDatabase(join(f.runtime, 'state/companion.sqlite'));
  const companionCore = new PersonalCore(backend, { database: companionDb });
  const companion = createApplicationServices(companionCore, companionDb, { role: 'service', health, projectRoot: f.runtime,
    codeRoot, privateRoot: join(f.runtime, 'state/companion-private'), resources, productionModuleSwitches: switches });
  companion.r1Workspace = { readProduct: synthetic.reader.readProduct.bind(synthetic.reader),
    readBinding: () => ({ readSchemaSha256: 'b'.repeat(64), queryImplSha256: 'c'.repeat(64) }),
    capabilities: () => ({ connection: synthetic.identity }) } as unknown as NonNullable<typeof companion.r1Workspace>;
  const database = new CoreDatabase(join(f.runtime, 'state/personal.sqlite')), core = new PersonalCore(backend, { database });
  const services = createApplicationServices(core, database, { role: 'personal', health, projectRoot: f.runtime, codeRoot,
    privateRoot: join(f.runtime, 'state/personal-private'), resources, workspaceServices: companion });
  try {
    assert.equal(companion.algorithms, undefined, '纯 TS 筛选不能要求 Python 指标服务');
    const captured = new Promise<BackendInput>(resolve => { capture = resolve; });
    core.sendMessage(core.defaultConversationId, '对隔离合成固定截面运行有限筛选，返回候选，不发布或下单。', 'synthetic-screen-user');
    const input = await captured;
    const tools = services.modelTools.toolFactory({ model, getCurrentInput: () => input });
    const list = tools.find(tool => tool.name === 'list_actions')!, perform = tools.find(tool => tool.name === 'perform_action')!;
    assert.ok(list && perform);
    const listed = preview(await list.execute('screen-list', { query: 'algorithms.screen' }, undefined, undefined, toolContext));
    assert.equal(listed.actions.length, 1); assert.equal(listed.actions[0].available, true);
    const frozen = core.runConfiguration(input.runId)!;
    for (const version of [18, 19, 20, undefined]) {
      const old = t.mock.method(core, 'runConfiguration', () => ({ ...frozen, internalAgentRules: version === undefined ? undefined :
        { ...frozen.internalAgentRules!, version } }));
      try {
        const page = preview(await list.execute('screen-list-' + version, { query: 'algorithms.screen' }, undefined, undefined, toolContext));
        assert.deepEqual(page.actions, []); assert.equal(page.total, 0);
        const calculate = preview(await list.execute('calculate-list-' + version, { query: 'algorithms.calculate' }, undefined, undefined, toolContext));
        assert.equal(calculate.actions.some((item: WfdRecord) => item.action === 'algorithms.calculate'), version !== undefined);
        await assert.rejects(perform.execute('legacy-screen-' + version, { action: 'algorithms.screen', args: { screenJson: '{}' } },
          undefined, undefined, toolContext), { code: 'MODEL_ACTION_NOT_ALLOWED' });
      } finally { old.mock.restore(); }
    }
    const contract = preview(await perform.execute('screen-contract', { action: 'algorithms.contract', args: { methodId: 'strategy_screen' } },
      undefined, undefined, toolContext));
    assert.equal(contract.data.executor, 'typescript'); assert.equal(contract.data.available, true); assert.equal(contract.data.executable, true);
    const screenJson = JSON.stringify({ snapshotId: 's_synthetic', productId: 'p_synthetic', historyMode: 'snapshot_contents',
      selection: { dateField: 'trade_date', date: '2026-01-02', dateFormat: 'YYYY-MM-DD' }, factorNames: ['momentum'],
      keyField: 'code', filter: 'momentum > 0', orderBy: 'rank(momentum)', topN: 1 });
    const args = { action: 'algorithms.screen', args: { screenJson } };
    const calculated = preview(await perform.execute('screen-execute', args, undefined, undefined, toolContext));
    assert.equal(calculated.ok, true); assert.deepEqual(calculated.data.selected.map((item: WfdRecord) => item.key), ['B']);
    assert.equal(calculated.data.fixedRead.complete, true); assert.equal(calculated.data.publication, 'not_requested');
    assert.equal(calculated.data.automaticTrading, false);
    const persisted = services.tasks.get(calculated.data.taskId);
    assert.equal(persisted.status, 'succeeded'); assert.equal(persisted.action, 'algorithms.screen');
    assert.equal(persisted.conversationId, input.conversationId);
    assert.equal(services.modelTools.taskOrigin(persisted.id)!.branchId, input.branchId);
    assert.equal(Number(database.connection.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND type='APPROVAL_REQUESTED'")
      .get(persisted.id)!.n), 0, '已授权受控筛选复用原自动工具通道，不新增人工批准');
    const replay = preview(await perform.execute('screen-execute', args, undefined, undefined, toolContext));
    assert.equal(replay.data.taskId, persisted.id); assert.deepEqual(replay.data.selected, calculated.data.selected);
    assert.equal(synthetic.calls.length, 1, '同一调用只读回原任务，不重新读取 WFD');
    const at = '2026-01-02T09:30:00Z', historyRequest = { ...JSON.parse(screenJson), historyMode: 'market_known_at', at };
    const historical = { action: 'algorithms.screen', args: { screenJson: JSON.stringify(historyRequest) } };
    await assert.rejects(perform.execute('screen-no-purpose', historical, undefined, undefined, toolContext));
    assert.equal(synthetic.calls.length, 1, '当前用户只要求快照内容，模型选择历史视角不授予该用途');
    switches.calculate = false;
    const disabled = preview(await list.execute('screen-list-disabled', { query: 'algorithms.screen' }, undefined, undefined, toolContext));
    assert.equal(disabled.actions[0].available, false);
    const disabledContract = preview(await perform.execute('screen-contract-disabled', { action: 'algorithms.contract', args: { methodId: 'strategy_screen' } },
      undefined, undefined, toolContext));
    assert.equal(disabledContract.data.executable, false);
    await assert.rejects(perform.execute('screen-disabled', args, undefined, undefined, toolContext));
    assert.equal(synthetic.calls.length, 1, '停用后新调用不读取数据');
    switches.calculate = true;
    const nextInput = async (message: string, requestId: string) => {
      const pending = new Promise<BackendInput>(resolve => { capture = resolve; });
      core.sendMessage(core.createConversation().conversationId, message, requestId);
      return pending;
    };
    const historyInput = await nextInput(`请按市场可知视角，以 ${at} 为截止筛选历史候选。`, 'synthetic-history-user');
    const historyTool = services.modelTools.toolFactory({ model, getCurrentInput: () => historyInput })
      .find(tool => tool.name === 'perform_action')!;
    const historicalResult = preview(await historyTool.execute('authorized-screen', historical, undefined, undefined, toolContext));
    assert.equal(historicalResult.data.replay, true);
    assert.deepEqual(historicalResult.data.fixedRead.historicalExclusions.byReason, { time_interval_starts_after_cutoff: 1 });
    assert.doesNotMatch(JSON.stringify(historicalResult), /r_future|future-key|future-subject|business_key/u);
    const stored = services.tasks.get(historicalResult.data.taskId).result!.data as Record<string, any>;
    assert.equal(stored.historicalExclusions.diagnostics[0].revision_id, 'r_future');
    assert.equal(stored.purposeContext.messageId, historyInput.messageId);
    const recovered = preview(await historyTool.execute('authorized-screen', historical, undefined, undefined, toolContext));
    assert.deepEqual(recovered.data, historicalResult.data);
    assert.equal(synthetic.calls.length, 2);
    const changedCutoff = { ...historical, args: { screenJson: JSON.stringify({ ...historyRequest, at: '2026-01-03T00:00:00Z' }) } };
    await assert.rejects(historyTool.execute('different-cutoff', changedCutoff, undefined, undefined, toolContext));
    assert.equal(synthetic.calls.length, 2);

    // 保留宿主、工具与用户消息的真实绑定，仅截获服务 submit 边界。
    const calls: unknown[][] = [];
    companion.algorithms = { versionBinding: { synthetic: '1' },
      catalog: () => ({ enabled: true, status: 'available', methods: [{ id: 'macd', status: 'ready' }] }), submit(...args: unknown[]) {
      calls.push(args); throw new Error('synthetic submit captured');
    } } as unknown as NonNullable<typeof companion.algorithms>;
    companion.derivedPublisher = { publish: () => assert.fail('capture must not publish') } as unknown as NonNullable<typeof companion.derivedPublisher>;
    for (const enabled of [true, false]) {
      switches.calculate = enabled;
      const action = preview(await list.execute('list-calculate-' + enabled, { query: 'algorithms.calculate' }, undefined, undefined, toolContext))
        .actions.find((item: WfdRecord) => item.action === 'algorithms.calculate');
      const contract = preview(await perform.execute('contract-calculate-' + enabled, { action: 'algorithms.contract', args: { methodId: 'macd' } },
        undefined, undefined, toolContext));
      assert.equal(action.available, enabled);
      assert.equal(contract.data.methods[0].executable, enabled);
    }
    switches.calculate = true;
    const declaration = JSON.stringify({ purpose: 'historical_compute', action: 'algorithms.calculate',
      historyMode: 'market_known_at', cutoff: at, methodId: 'macd', productId: 'p_synthetic' });
    const calcInput = await nextInput(declaration, 'synthetic-historical-calculation');
    const calcTool = services.modelTools.toolFactory({ model, getCurrentInput: () => calcInput }).find(tool => tool.name === 'perform_action')!;
    const calculation = { methodId: 'macd', source: { kind: 'fixed_snapshot', reference: { productId: 'p_synthetic', snapshotId: 's_synthetic' } },
      usage: { purpose: 'historical_compute', historyMode: 'market_known_at', cutoff: at } };
    const calculate = { action: 'algorithms.calculate', args: { calculationJson: JSON.stringify(calculation) } };
    await assert.rejects(historyTool.execute('screen-user-cannot-calculate', calculate, undefined, undefined, toolContext));
    assert.equal(calls.length, 0);
    await assert.rejects(calcTool.execute('capture-submit', calculate, undefined, undefined, toolContext));
    assert.equal(calls.length, 1);
    assert.partialDeepStrictEqual(calls[0]![2], { authority: 'user-message', quote: declaration, messageId: calcInput.messageId,
      conversationId: calcInput.conversationId, branchId: calcInput.branchId, parentRunId: calcInput.runId });

    // 旧版未脱敏的 historical calculate/status 缓存 preview_json、分页包装或错误细节均不得重放；
    // 缺失 derivedPublisher 时计算合同可执行性同为 false，撤回 Python 权限后 algorithms.publish 仍可恢复发布。
    const origCaps = companion.r1Workspace!.capabilities, origBinding = companion.r1Workspace!.readBinding;
    (companion.r1Workspace as unknown as { capabilities?: unknown }).capabilities = undefined;
    assert.equal(preview(await perform.execute('screen-no-caps', { action: 'algorithms.contract', args: { methodId: 'strategy_screen' } },
      undefined, undefined, toolContext)).data.executable, false);
    companion.r1Workspace!.capabilities = origCaps;
    for (const badBinding of [{}, { readSchemaSha256: '', queryImplSha256: '' }]) {
      companion.r1Workspace!.readBinding = () => badBinding as never;
      assert.equal(preview(await perform.execute('screen-bad-binding', { action: 'algorithms.contract', args: { methodId: 'strategy_screen' } },
        undefined, undefined, toolContext)).data.executable, false);
    }
    companion.r1Workspace!.readBinding = origBinding;

    companion.algorithms = { versionBinding: { synthetic: '1' },
      catalog: () => ({ enabled: true, status: 'unavailable', reason: 'python paused', methods: [{ id: 'macd', status: 'unavailable' }] }),
      submit() { throw new Error('paused'); } } as unknown as NonNullable<typeof companion.algorithms>;
    const publishPausedAction = preview(await list.execute('list-publish-python-paused', { query: 'algorithms.publish' }, undefined, undefined, toolContext))
      .actions.find((item: WfdRecord) => item.action === 'algorithms.publish');
    assert.equal(publishPausedAction.available, true, '已完成的派生任务恢复发布不依赖 Python 执行许可');

    companion.derivedPublisher = undefined;
    const withoutPub = preview(await list.execute('list-calc-no-pub', { query: 'algorithms.calculate' }, undefined, undefined, toolContext))
      .actions.find((item: WfdRecord) => item.action === 'algorithms.calculate');
    const contractWithoutPub = preview(await perform.execute('contract-calc-no-pub', { action: 'algorithms.contract', args: { methodId: 'macd' } },
      undefined, undefined, toolContext));
    assert.equal(withoutPub.available, false);
    assert.equal(contractWithoutPub.data.methods[0].executable, false);

    const leaked = { taskId: 'legacy-calc', status: 'succeeded', result: { source: { kind: 'wfd_fixed_snapshot', perspective: 'market_known_at',
      resolution: { historicalRead: { actualPerspective: 'market_known_at', diagnostics: [{ revision_id: 'r_future' }] } } } } };
    const callRow = services.database.connection.prepare('SELECT * FROM model_tool_calls WHERE task_id=?').get(historicalResult.data.taskId) as Record<string, any> | undefined;
    assert.ok(callRow);
    const scope = { conversationId: callRow.conversation_id, branchId: callRow.branch_id, subject: 'personal', modelDigest: callRow.model_digest };
    const realTask = services.tasks.get(historicalResult.data.taskId);
    const bridge = services.modelTools as unknown as {
      assertHistoricalAlgorithmPreview(c: unknown, t: unknown, s: unknown, r?: unknown): void;
      evidence: { retain(s: unknown, src: unknown, text: string): { evidenceId: string; sha256: string; totalBytes: number; format: 'utf8' };
        read(s: unknown, req: { evidenceId: string; sha256: string; offset?: number; maxBytes?: number }, assertAccess: () => void): Record<string, unknown>;
        decodeCursorOffset(s: unknown, ref: { evidenceId: string; sha256: string }, cursor: string): number | null };
    };
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview(callRow, { ...realTask, action: 'algorithms.calculate', result: { data: { modelPreview: leaked } } },
      scope), { code: 'MODEL_SHARE_REVOKED' });
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview(callRow, { ...realTask, action: 'algorithms.status', result: { data: { modelPreview: { error: {
      code: 'ALGORITHM_HISTORICAL_NO_ELIGIBLE_VERSION', message: JSON.stringify({ diagnostics: [{ revision_id: 'r_future' }] }) } } } } }, scope),
      { code: 'MODEL_SHARE_REVOKED' });
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview(callRow, { ...realTask, action: 'algorithms.status', result: { data: { modelPreview: { error: {
      code: 'ALGORITHM_HISTORICAL_NO_ELIGIBLE_VERSION', message: JSON.stringify({ source: 'WFD', scope: 'fixed_product_not_date_filtered',
        excludedCount: 1, byReason: { fabricated_reason_not_registered: 1 } }) } } } } }, scope), { code: 'MODEL_SHARE_REVOKED' });
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview(callRow, { ...realTask, action: 'algorithms.status', result: { data: { modelPreview: { error: {
      code: 'PURPOSE_ELIGIBILITY_INELIGIBLE', message: JSON.stringify({ purpose: 'historical_compute', checks: [{ detail: 'r_future' }] }) } } } } }, scope),
      { code: 'MODEL_SHARE_REVOKED' });
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview(callRow, { ...realTask, action: 'algorithms.status', result: { data: { modelPreview: { error: {
      code: 'PURPOSE_ELIGIBILITY_INELIGIBLE', message: JSON.stringify({ ruleVersion: 'bd.purpose-eligibility/2',
        status: { checks: [{ detail: 'r_future' }] }, purpose: 'historical_compute', history: null,
        blockingGapCodes: ['PUBLICATION_AFTER_CUTOFF'], evidenceSha256: 'a'.repeat(64),
        action: '该固定快照在所请求的历史视角/截止下未通过用途资格；完整核对明细保留在原任务审计记录。' }) } } } } }, scope),
      { code: 'MODEL_SHARE_REVOKED' });
    const safeCalcPreview = { taskId: 'safe-calc', status: 'failed', error: { code: 'PURPOSE_ELIGIBILITY_INELIGIBLE',
      message: JSON.stringify({ ruleVersion: 'bd.purpose-eligibility/2', status: 'ineligible', purpose: 'historical_compute',
        history: { mode: 'market_known_at', cutoff: at, perspective: 'market_known_at', historical: true },
        blockingGapCodes: ['PUBLICATION_AFTER_CUTOFF'], evidenceSha256: 'a'.repeat(64),
        action: '该固定快照在所请求的历史视角/截止下未通过用途资格；完整核对明细保留在原任务审计记录。' }) } };
    const safeText = JSON.stringify({ ok: true, taskId: callRow.task_id, data: safeCalcPreview });
    const safeRef = bridge.evidence.retain(scope, { callId: callRow.id, runId: callRow.parent_run_id, inputId: callRow.input_id, messageId: callRow.message_id }, safeText);
    const safeStatusTask = { ...realTask, action: 'algorithms.status', result: { data: { modelPreview: safeCalcPreview } } };
    const defaultSlice = bridge.evidence.read(scope, { ...safeRef }, () => {});
    const validSlice = bridge.evidence.read(scope, { ...safeRef, maxBytes: 10 }, () => {});
    const pageArgs = JSON.stringify({ ...safeRef, maxBytes: 10 });
    const pagedCall = { ...callRow, preview_json: JSON.stringify({ ok: true, taskId: callRow.task_id, complete: false,
      note: '完整结果按固定摘要保管；使用core_evidence_read续取nextCursor，done=true表示已读到末尾。', evidence: defaultSlice }) };
    assert.doesNotThrow(() => bridge.assertHistoricalAlgorithmPreview(pagedCall, safeStatusTask, scope, safeRef));
    const pageWrapper = { ...callRow, tool_name: 'core_evidence_read', args_json: pageArgs, preview_json: JSON.stringify(validSlice) };
    assert.doesNotThrow(() => bridge.assertHistoricalAlgorithmPreview(pageWrapper, safeStatusTask, scope));
    assert.equal(bridge.evidence.decodeCursorOffset(scope, safeRef, `${String(validSlice.nextCursor)}.`), null);
    for (const badSlice of [
      { ...validSlice, done: true, nextCursor: null },
      { ...validSlice, format: 'raw' },
      { ...validSlice, nextCursor: 'tampered.sig' },
      { ...validSlice, nextCursor: `${String(validSlice.nextCursor)}.` },
    ]) {
      assert.throws(() => bridge.assertHistoricalAlgorithmPreview({ ...callRow, tool_name: 'core_evidence_read',
        args_json: pageArgs, preview_json: JSON.stringify(badSlice) }, safeStatusTask, scope), { code: 'MODEL_SHARE_REVOKED' });
    }
    const shortSlice = bridge.evidence.read(scope, { ...safeRef, offset: 0, maxBytes: 64 }, () => {});
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview({ ...callRow, tool_name: 'core_evidence_read',
      args_json: JSON.stringify({ ...safeRef, offset: 0, maxBytes: 256 }), preview_json: JSON.stringify(shortSlice) }, safeStatusTask, scope),
      { code: 'MODEL_SHARE_REVOKED' });
    const secondRef = bridge.evidence.retain(scope, { callId: callRow.id, runId: callRow.parent_run_id, inputId: callRow.input_id, messageId: callRow.message_id }, safeText.replace('safe-calc', 'safe-calc-b'));
    const secondSlice = bridge.evidence.read(scope, { ...secondRef, maxBytes: 10 }, () => {});
    const eofSlice = bridge.evidence.read(scope, { ...safeRef, offset: safeRef.totalBytes }, () => {});
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview({ ...callRow, tool_name: 'core_evidence_read',
      args_json: pageArgs, preview_json: JSON.stringify(secondSlice) }, safeStatusTask, scope), { code: 'MODEL_SHARE_REVOKED' });
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview({ ...callRow, tool_name: 'core_evidence_read',
      args_json: pageArgs, preview_json: JSON.stringify(eofSlice) }, safeStatusTask, scope), { code: 'MODEL_SHARE_REVOKED' });
    const tamperedWrapper = { ...callRow, preview_json: JSON.stringify({ ok: true, taskId: callRow.task_id, complete: false,
      evidence: { ...validSlice, text: 'TAMPERED!!' } }) };
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview(tamperedWrapper, safeStatusTask, scope), { code: 'MODEL_SHARE_REVOKED' });
    const outOfRangeSlice = { ...callRow, preview_json: JSON.stringify({ ok: true, taskId: callRow.task_id, complete: false,
      evidence: { ...validSlice, startByte: 99999, endByte: 100010, text: '' } }) };
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview(outOfRangeSlice, safeStatusTask, scope), { code: 'MODEL_SHARE_REVOKED' });
    const dualFieldBypass = { ...callRow, preview_json: JSON.stringify({ ok: true, taskId: callRow.task_id, data: safeCalcPreview,
      evidence: { ...validSlice, text: 'TAMPERED!!' } }) };
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview(dualFieldBypass, safeStatusTask, scope), { code: 'MODEL_SHARE_REVOKED' });
    const retainedDualText = JSON.stringify({ ok: true, taskId: callRow.task_id, data: safeCalcPreview,
      evidence: { ...validSlice, text: 'record_id=sample-42' } });
    const retainedDualRef = bridge.evidence.retain(scope, { callId: callRow.id, runId: callRow.parent_run_id, inputId: callRow.input_id, messageId: callRow.message_id }, retainedDualText);
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview({ ...callRow, preview_json: JSON.stringify({ ok: true, taskId: callRow.task_id, data: safeCalcPreview }) },
      safeStatusTask, scope, retainedDualRef), { code: 'MODEL_SHARE_REVOKED' });
    const statusCheckCall = { ...callRow, action: 'algorithms.status', preview_json: JSON.stringify({ ok: true, taskId: callRow.task_id, data: safeCalcPreview }) };
    for (const forgedField of [
      { ruleVersion: 'synthetic-rev-42', cutoff: at },
      { ruleVersion: 'bd.purpose-eligibility/2', cutoff: 'synthetic-rev-42' },
      { ruleVersion: 'bd.purpose-eligibility/2', cutoff: '2025-02-29T00:00:00Z' },
      { ruleVersion: 'bd.purpose-eligibility/2', cutoff: '2026-04-31T00:00:00+08:00' },
    ]) {
      assert.throws(() => bridge.assertHistoricalAlgorithmPreview(statusCheckCall, { ...realTask, action: 'algorithms.status', result: { data: { modelPreview: { error: {
        code: 'PURPOSE_ELIGIBILITY_INELIGIBLE', message: JSON.stringify({ ruleVersion: forgedField.ruleVersion, status: 'ineligible',
          purpose: 'historical_compute', history: { mode: 'market_known_at', cutoff: forgedField.cutoff, perspective: 'market_known_at', historical: true },
          blockingGapCodes: ['PUBLICATION_AFTER_CUTOFF'], evidenceSha256: 'a'.repeat(64),
          action: '该固定快照在所请求的历史视角/截止下未通过用途资格；完整核对明细保留在原任务审计记录。' }) } } } } }, scope), { code: 'MODEL_SHARE_REVOKED' });
    }
    for (const validCutoff of ['2024-02-29T00:00:00Z', '0001-01-01T00:00:00Z', '0096-02-29T00:00:00Z']) {
      const validEarlyPreview = { error: {
        code: 'PURPOSE_ELIGIBILITY_INELIGIBLE', message: JSON.stringify({ ruleVersion: 'bd.purpose-eligibility/2', status: 'ineligible',
          purpose: 'historical_compute', history: { mode: 'market_known_at', cutoff: validCutoff, perspective: 'market_known_at', historical: true },
          blockingGapCodes: ['PUBLICATION_AFTER_CUTOFF'], evidenceSha256: 'a'.repeat(64),
          action: '该固定快照在所请求的历史视角/截止下未通过用途资格；完整核对明细保留在原任务审计记录。' }) } };
      assert.doesNotThrow(() => bridge.assertHistoricalAlgorithmPreview({ ...callRow, action: 'algorithms.status',
        preview_json: JSON.stringify({ ok: true, taskId: callRow.task_id, data: validEarlyPreview }) },
        { ...realTask, action: 'algorithms.status', result: { data: { modelPreview: validEarlyPreview } } }, scope));
    }
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview(statusCheckCall, { ...realTask, action: 'algorithms.status', result: { data: { modelPreview: { error: {
      code: 'ALGORITHM_SNAPSHOT_HISTORY_INCOMPLETE', message: 'record_id=sample-42 r_secret' } } } } }, scope), { code: 'MODEL_SHARE_REVOKED' });
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview(statusCheckCall, { ...realTask, action: 'algorithms.status', result: { data: { modelPreview: { error: {
      code: 'ALGORITHM_SNAPSHOT_HISTORY_INCOMPLETE', message: '历史版本选择存在待补证据；完整核对明细保留在原任务审计记录。',
      nextAction: 'record_id=sample-42' } } } } }, scope), { code: 'MODEL_SHARE_REVOKED' });
    const companionHost = companion as unknown as { algorithms?: { versionBinding: Record<string, string>; catalog(): unknown; submit(...args: unknown[]): unknown; view?(id: string): unknown } };
    const prevAlg = companionHost.algorithms;
    let injectedStatusError: { code: string; message: string } | null = null;
    companionHost.algorithms = {
      ...(prevAlg as NonNullable<typeof prevAlg>),
      view: (id: string) => ({ taskId: id, requestId: id, methodId: 'macd', status: 'failed', taskVersion: 1, requiresReview: false,
        createdAt: 1, updatedAt: 1, error: injectedStatusError, publication: null, guidance: null, result: null }),
    };
    try {
      const originJson = JSON.stringify(services.modelTools.taskOrigin(historicalResult.data.taskId));
      const invokeStatusWithError = async (reqId: string, error: { code: string; message: string }) => {
        injectedStatusError = error;
        const created = companionDb.transaction(() => companion.tasks.createInTransaction({
          conversationId: historyInput.conversationId, title: reqId, runtimeId: 'bd.algorithms',
          action: 'algorithms.calculate', args: {}, requestId: reqId }));
        created.publish();
        companionDb.connection.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(created.task.id);
        services.database.connection.prepare('INSERT INTO conversation_algorithm_links VALUES(?,?,?,?,?)')
          .run(created.task.id, historicalResult.data.taskId, 'algorithms.calculate', originJson, Date.now());
        return preview(await historyTool.execute(`status-${reqId}`, { action: 'algorithms.status', args: { taskId: created.task.id } }, undefined, undefined, toolContext));
      };
      const statusIncomplete = await invokeStatusWithError('req-status-sanitize-1', {
        code: 'ALGORITHM_SNAPSHOT_HISTORY_INCOMPLETE', message: 'record_id=sample-42 r_secret' });
      assert.doesNotMatch(JSON.stringify(statusIncomplete), /sample-42|r_secret/u);
      assert.equal(statusIncomplete.data.error.message, '历史版本选择存在待补证据；完整核对明细保留在原任务审计记录。');

      const forgedEligibilityErr = JSON.stringify({ ruleVersion: 'synthetic-rev-42', status: 'ineligible', purpose: 'historical_compute',
        history: { mode: 'market_known_at', cutoff: 'synthetic-rev-99', perspective: 'market_known_at', historical: true },
        blockingGapCodes: ['PUBLICATION_AFTER_CUTOFF'], evidenceSha256: 'a'.repeat(64) });
      const statusForgedRule = await invokeStatusWithError('req-status-sanitize-2', {
        code: 'PURPOSE_ELIGIBILITY_INELIGIBLE', message: forgedEligibilityErr });
      assert.doesNotMatch(JSON.stringify(statusForgedRule), /synthetic-rev-42|synthetic-rev-99/u);

      const forgedCutoffOnly = JSON.stringify({ ruleVersion: 'bd.purpose-eligibility/2', status: 'ineligible', purpose: 'historical_compute',
        history: { mode: 'market_known_at', cutoff: 'synthetic-rev-99', perspective: 'market_known_at', historical: true },
        blockingGapCodes: ['PUBLICATION_AFTER_CUTOFF'], evidenceSha256: 'a'.repeat(64) });
      const statusForgedCutoff = await invokeStatusWithError('req-status-sanitize-3', {
        code: 'PURPOSE_ELIGIBILITY_INELIGIBLE', message: forgedCutoffOnly });
      assert.doesNotMatch(JSON.stringify(statusForgedCutoff), /synthetic-rev-99/u);
      assert.equal(JSON.parse(statusForgedCutoff.data.error.message).history.cutoff, null);

      const invalidCalendarCutoff = await invokeStatusWithError('req-status-sanitize-4', {
        code: 'PURPOSE_ELIGIBILITY_INELIGIBLE', message: JSON.stringify({ ruleVersion: 'bd.purpose-eligibility/2', status: 'ineligible', purpose: 'historical_compute',
          history: { mode: 'market_known_at', cutoff: '2025-02-29T00:00:00Z', perspective: 'market_known_at', historical: true },
          blockingGapCodes: ['PUBLICATION_AFTER_CUTOFF'], evidenceSha256: 'a'.repeat(64) }) });
      assert.equal(JSON.parse(invalidCalendarCutoff.data.error.message).history.cutoff, null);

      const statusRulesLeak = await invokeStatusWithError('req-status-sanitize-5', {
        code: 'ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES', message: '本会话冻结的内置代理规则 v18 仅允许 macd。record_id=sample-42' });
      assert.doesNotMatch(JSON.stringify(statusRulesLeak), /sample-42/u);
    } finally { companionHost.algorithms = prevAlg; }
    const smuggledSummary = JSON.stringify({ ok: true, taskId: callRow.task_id, summary: 'leaked r_future', data: safeCalcPreview });
    const smuggledRef = bridge.evidence.retain(scope, { callId: callRow.id, runId: callRow.parent_run_id, inputId: callRow.input_id, messageId: callRow.message_id }, smuggledSummary);
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview({ ...callRow, preview_json: JSON.stringify({ ok: true, taskId: callRow.task_id, data: safeCalcPreview }) },
      safeStatusTask, scope, smuggledRef), { code: 'MODEL_SHARE_REVOKED' });
    const leakedText = JSON.stringify({ ok: true, taskId: callRow.task_id, data: leaked });
    const leakedRef = bridge.evidence.retain(scope, { callId: callRow.id, runId: callRow.parent_run_id, inputId: callRow.input_id, messageId: callRow.message_id }, leakedText);
    assert.throws(() => bridge.assertHistoricalAlgorithmPreview({ ...callRow, preview_json: JSON.stringify({ ok: true, taskId: callRow.task_id, data: safeCalcPreview }) },
      safeStatusTask, scope, leakedRef), { code: 'MODEL_SHARE_REVOKED' });
    const invalidMsg = '工具参数无效，请使用动作表的字段和当前会话引用编号。';
    for (const detail of ['r_future {"checks":[]}', 'record_id=sample-42 subject=sample-subject']) {
      const projectedErr = services.modelTools.projectToolResult({
        role: 'toolResult', toolCallId: 'synthetic-err', toolName: 'perform_action', isError: true, timestamp: Date.now(),
        content: [{ type: 'text', text: `${invalidMsg}具体原因：${detail}` }],
      }, historyInput, undefined, model);
      assert.equal(JSON.parse((projectedErr.content[0] as { text: string }).text).message, invalidMsg);
    }
    const readDetail = `${invalidMsg}具体原因：源码路径须为工程内的相对路径，长度不超过 512。`;
    assert.equal(JSON.parse((services.modelTools.projectToolResult({
      role: 'toolResult', toolCallId: 'synthetic-perform-whitelist', toolName: 'perform_action', isError: true, timestamp: Date.now(),
      content: [{ type: 'text', text: readDetail }],
    }, historyInput, undefined, model).content[0] as { text: string }).text).message, invalidMsg);
    assert.equal(JSON.parse((services.modelTools.projectToolResult({
      role: 'toolResult', toolCallId: 'synthetic-read-whitelist', toolName: 'core_code_read', isError: true, timestamp: Date.now(),
      content: [{ type: 'text', text: readDetail }],
    }, historyInput, undefined, model).content[0] as { text: string }).text).message, readDetail);
    const createdFailed = services.database.transaction(() => services.tasks.createInTransaction({
      conversationId: historyInput.conversationId, title: 'failed alg', runtimeId: 'direct',
      action: 'algorithms.screen', args: {}, requestId: 'req-failed-alg' }));
    createdFailed.publish();
    const failedAlgId = createdFailed.task.id, failedCallId = 'failed-alg-call';
    services.database.connection.prepare("UPDATE tasks SET status='failed', error=? WHERE id=?")
      .run(JSON.stringify({ code: 'ALGORITHM_SNAPSHOT_HISTORY_INCOMPLETE', message: 'record_id=sample-42 r_secret' }), failedAlgId);
    services.database.connection.prepare(`INSERT INTO model_tool_calls(id,conversation_id,branch_id,parent_run_id,parent_generation,input_id,message_id,tool_call_id,tool_name,action,args_json,payload_digest,model_json,model_digest,selection_json,task_request_id,task_id,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      failedCallId, historyInput.conversationId, historyInput.branchId, historyInput.runId, historyInput.generation,
      historyInput.inputId, historyInput.messageId, 'tc-failed-alg', 'perform_action', 'algorithms.screen', '{}', 'd',
      callRow.model_json, callRow.model_digest, '[]', 'req-failed-alg', failedAlgId, 'prepared', Date.now(), Date.now());
    const algErrMsg = JSON.parse((services.modelTools.projectToolResult({
      role: 'toolResult', toolCallId: 'tc-failed-alg', toolName: 'perform_action', isError: true, timestamp: Date.now(),
      content: [{ type: 'text', text: 'raw failure' }],
    }, historyInput, undefined, model).content[0] as { text: string }).text).message as string;
    assert.doesNotMatch(algErrMsg, /sample-42|r_secret/u);
    const createdPubFailed = services.database.transaction(() => services.tasks.createInTransaction({
      conversationId: historyInput.conversationId, title: 'failed pub', runtimeId: 'direct',
      action: 'algorithms.publish', args: {}, requestId: 'req-failed-pub' }));
    createdPubFailed.publish();
    services.database.connection.prepare("UPDATE tasks SET status='failed', error=? WHERE id=?")
      .run(JSON.stringify({ code: 'DERIVED_PROOF_CHANGED', message: 'record_id=sample-42' }), createdPubFailed.task.id);
    services.database.connection.prepare(`INSERT INTO model_tool_calls(id,conversation_id,branch_id,parent_run_id,parent_generation,input_id,message_id,tool_call_id,tool_name,action,args_json,payload_digest,model_json,model_digest,selection_json,task_request_id,task_id,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'failed-pub-call', historyInput.conversationId, historyInput.branchId, historyInput.runId, historyInput.generation,
      historyInput.inputId, historyInput.messageId, 'tc-failed-pub', 'perform_action', 'algorithms.publish', '{}', 'd',
      callRow.model_json, callRow.model_digest, '[]', 'req-failed-pub', createdPubFailed.task.id, 'prepared', Date.now(), Date.now());
    const pubErrMsg = JSON.parse((services.modelTools.projectToolResult({
      role: 'toolResult', toolCallId: 'tc-failed-pub', toolName: 'perform_action', isError: true, timestamp: Date.now(),
      content: [{ type: 'text', text: 'raw pub failure' }],
    }, historyInput, undefined, model).content[0] as { text: string }).text).message as string;
    assert.doesNotMatch(pubErrMsg, /sample-42/u);
    const createdRuleFailed = services.database.transaction(() => services.tasks.createInTransaction({
      conversationId: historyInput.conversationId, title: 'failed alg rule', runtimeId: 'direct',
      action: 'algorithms.calculate', args: {}, requestId: 'req-failed-alg-rule' }));
    createdRuleFailed.publish();
    services.database.connection.prepare("UPDATE tasks SET status='failed', error=? WHERE id=?")
      .run(JSON.stringify({ code: 'ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES', message: 'record_id=sample-42' }), createdRuleFailed.task.id);
    services.database.connection.prepare(`INSERT INTO model_tool_calls(id,conversation_id,branch_id,parent_run_id,parent_generation,input_id,message_id,tool_call_id,tool_name,action,args_json,payload_digest,model_json,model_digest,selection_json,task_request_id,task_id,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'failed-alg-rule-call', historyInput.conversationId, historyInput.branchId, historyInput.runId, historyInput.generation,
      historyInput.inputId, historyInput.messageId, 'tc-failed-alg-rule', 'perform_action', 'algorithms.calculate', '{}', 'd',
      callRow.model_json, callRow.model_digest, '[]', 'req-failed-alg-rule', createdRuleFailed.task.id, 'prepared', Date.now(), Date.now());
    const forgedRuleErrMsg = JSON.parse((services.modelTools.projectToolResult({
      role: 'toolResult', toolCallId: 'tc-failed-alg-rule', toolName: 'perform_action', isError: true, timestamp: Date.now(),
      content: [{ type: 'text', text: 'raw rule failure' }],
    }, historyInput, undefined, model).content[0] as { text: string }).text).message as string;
    assert.doesNotMatch(forgedRuleErrMsg, /sample-42/u);
    for (const [suffixIdx, [act, msg]] of ([
      ['algorithms.contract', 'record_id=sample-42'],
      ['data.modules.factors', 'apps/server/services.ts'],
      ['algorithms.calculate', '本会话冻结的内置代理规则 v18 仅允许 macd。 '],
      ['algorithms.calculate', '本会话冻结的内置代理规则 v18 仅允许 macd。\0'],
      ['algorithms.calculate', '本会话冻结的内置代理规则\tv18 仅允许 macd。'],
    ] as const).entries()) {
      const reqId = `req-rule-edge-${suffixIdx}`, tcId = `tc-rule-edge-${suffixIdx}`;
      const tEdge = services.database.transaction(() => services.tasks.createInTransaction({
        conversationId: historyInput.conversationId, title: reqId, runtimeId: 'direct', action: act, args: {}, requestId: reqId }));
      tEdge.publish();
      services.database.connection.prepare("UPDATE tasks SET status='failed', error=? WHERE id=?")
        .run(JSON.stringify({ code: 'ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES', message: msg }), tEdge.task.id);
      services.database.connection.prepare(`INSERT INTO model_tool_calls(id,conversation_id,branch_id,parent_run_id,parent_generation,input_id,message_id,tool_call_id,tool_name,action,args_json,payload_digest,model_json,model_digest,selection_json,task_request_id,task_id,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `call-${reqId}`, historyInput.conversationId, historyInput.branchId, historyInput.runId, historyInput.generation,
        historyInput.inputId, historyInput.messageId, tcId, 'perform_action', act, '{}', 'd',
        callRow.model_json, callRow.model_digest, '[]', reqId, tEdge.task.id, 'prepared', Date.now(), Date.now());
      const outMsg = JSON.parse((services.modelTools.projectToolResult({
        role: 'toolResult', toolCallId: tcId, toolName: 'perform_action', isError: true, timestamp: Date.now(),
        content: [{ type: 'text', text: 'raw rule edge' }],
      }, historyInput, undefined, model).content[0] as { text: string }).text).message as string;
      assert.equal(outMsg, '本会话冻结规则不允许所选方法或因子；完整核对明细保留在原任务审计记录。');
    }

    // 真实超长历史筛选结果分页（core_evidence_read 同输入与新输入续页 1..N 全数放行，异常新输入缓存页撤回）。
    const pagedInput = await nextInput(`请按市场可知视角，以 ${at} 为截止筛选历史候选。`, 'synthetic-paged-history');
    const pagedTools = services.modelTools.toolFactory({ model, getCurrentInput: () => pagedInput });
    const pagedScreenTool = pagedTools.find(t => t.name === 'perform_action')!;
    const evTool = pagedTools.find(t => t.name === 'core_evidence_read')!;
    synthetic.setLargeScreenRows(true);
    try {
      const bigScreenJson = JSON.stringify({ snapshotId: 's_synthetic', productId: 'p_synthetic', historyMode: 'market_known_at', at,
        selection: { dateField: 'trade_date', date: '2026-01-02', dateFormat: 'YYYY-MM-DD' }, factorNames: ['momentum'],
        keyField: 'code', filter: 'momentum > 0', orderBy: 'momentum', topN: 95 });
      const firstPaged = await pagedScreenTool.execute('big-screen-1', { action: 'algorithms.screen', args: { screenJson: bigScreenJson } }, undefined, undefined, toolContext);
      const projectedFirst = services.modelTools.projectToolResult({
        role: 'toolResult', toolCallId: 'big-screen-1', toolName: 'perform_action', isError: false, timestamp: Date.now(),
        content: firstPaged.content as any, details: firstPaged.details as any,
      }, pagedInput, undefined, model);
      const firstBody = JSON.parse((projectedFirst.content[0] as { text: string }).text) as { evidence?: { evidenceId: string; sha256: string; text: string; nextCursor: string | null; done: boolean } };
      assert.ok(firstBody.evidence && firstBody.evidence.nextCursor && !firstBody.evidence.done, '须触发多页分页包装');
      let accumulated = firstBody.evidence.text, cursor: string | null = firstBody.evidence.nextCursor, pagesRead = 1;
      while (cursor) {
        const callId = `big-screen-${pagesRead + 1}`;
        const page = await evTool.execute(callId, { evidenceId: firstBody.evidence.evidenceId, sha256: firstBody.evidence.sha256, cursor } as any, undefined, undefined, toolContext);
        const projectedPage = services.modelTools.projectToolResult({
          role: 'toolResult', toolCallId: callId, toolName: 'core_evidence_read', isError: false, timestamp: Date.now(),
          content: page.content as any, details: page.details as any,
        }, pagedInput, undefined, model);
        const body = JSON.parse((projectedPage.content[0] as { text: string }).text) as { evidenceId?: string; text: string; nextCursor: string | null; done: boolean };
        assert.equal(body.evidenceId, firstBody.evidence.evidenceId);
        accumulated += body.text;
        cursor = body.nextCursor;
        pagesRead += 1;
        assert.ok(pagesRead <= 20);
      }
      assert.ok(pagesRead >= 3);
      const assembled = JSON.parse(accumulated) as { data: { selected: unknown[] } };
      assert.equal(assembled.data.selected.length, 95);
      assert.doesNotMatch(accumulated, /r_future|future-key|future-subject/u);
      // 换到同会话下一条新输入走 model.evidence.read 也能正常续页，而异常缓存页一律撤回。
      gates.get(pagedInput.runId)?.();
      gates.delete(pagedInput.runId);
      while (core.isRunActive(pagedInput.runId, pagedInput.generation)) await new Promise<void>(resolve => setImmediate(resolve));
      const pendingNewInput = new Promise<BackendInput>(resolve => { capture = resolve; });
      core.sendMessage(pagedInput.conversationId, '在新输入继续读取同一证据分页。', 'synthetic-new-input-paging');
      const newPagedInput = await pendingNewInput;
      const newEvTool = services.modelTools.toolFactory({ model, getCurrentInput: () => newPagedInput }).find(t => t.name === 'core_evidence_read')!;
      const newPage2 = await newEvTool.execute('new-ev-p2', { evidenceId: firstBody.evidence.evidenceId, sha256: firstBody.evidence.sha256,
        cursor: firstBody.evidence.nextCursor } as any, undefined, undefined, toolContext);
      const projectedNewP2 = services.modelTools.projectToolResult({
        role: 'toolResult', toolCallId: 'new-ev-p2', toolName: 'core_evidence_read', isError: false, timestamp: Date.now(),
        content: newPage2.content as any, details: newPage2.details as any,
      }, newPagedInput, undefined, model);
      const newP2Body = JSON.parse((projectedNewP2.content[0] as { text: string }).text) as Record<string, any>;
      assert.equal(newP2Body.evidenceId, firstBody.evidence.evidenceId);
      assert.ok(newP2Body.startByte > 0 && newP2Body.nextCursor);
      const callNewRow = services.database.connection.prepare('SELECT id,preview_json,ticket_json,task_id,parent_run_id,parent_generation FROM model_tool_calls WHERE tool_call_id=?')
        .get('new-ev-p2') as { id: string; preview_json: string; ticket_json: string; task_id: string; parent_run_id: string; parent_generation: number };
      const origTicket = JSON.parse(callNewRow.ticket_json) as Record<string, any>;
      const newPagedScope = { conversationId: newPagedInput.conversationId, branchId: newPagedInput.branchId, subject: 'personal', modelDigest: callRow.model_digest };
      const newPageArgs = services.database.connection.prepare('SELECT args_json FROM model_tool_calls WHERE id=?').get(callNewRow.id) as { args_json: string };
      const newReq = JSON.parse(newPageArgs.args_json) as { evidenceId: string; sha256: string; cursor: string };
      const expectedOffset = bridge.evidence.decodeCursorOffset(newPagedScope, newReq, newReq.cursor)!;
      const newShortSlice = bridge.evidence.read(newPagedScope, { evidenceId: newReq.evidenceId, sha256: newReq.sha256, offset: expectedOffset, maxBytes: 64 }, () => {});
      const matchedShare = (payload: Record<string, unknown>) => ({
        mashiroShare: { callId: callNewRow.id, parentRunId: callNewRow.parent_run_id, generation: Number(callNewRow.parent_generation), digest: digestOperationArgs(payload as any) },
      });
      for (const badNewPage of [
        { ...newP2Body, done: true, nextCursor: null },
        { ...newP2Body, format: 'raw' },
        { ...newP2Body, nextCursor: 'tampered.sig' },
        { ...newP2Body, startByte: 0, text: newP2Body.text },
        newShortSlice,
        { ...newP2Body, evidenceId: secondRef.evidenceId, sha256: secondRef.sha256, startByte: secondSlice.startByte, endByte: secondSlice.endByte, totalBytes: secondSlice.totalBytes, text: secondSlice.text, nextCursor: secondSlice.nextCursor },
      ]) {
        services.database.connection.prepare('UPDATE model_tool_calls SET preview_json=?,ticket_json=? WHERE id=?')
          .run(JSON.stringify(badNewPage), JSON.stringify({ ...origTicket, previewDigest: digestOperationArgs(badNewPage as any) }), callNewRow.id);
        const withheldNew = services.modelTools.projectToolResult({
          role: 'toolResult', toolCallId: 'new-ev-p2', toolName: 'core_evidence_read', isError: false, timestamp: Date.now(),
          content: newPage2.content as any, details: matchedShare(badNewPage),
        }, newPagedInput, undefined, model);
        assert.equal((withheldNew.details as Record<string, unknown>).mashiroShareWithheld, true);
      }
    } finally { synthetic.setLargeScreenRows(false); }
  } finally {
    finish();
    await services.tasks.dispose(); await core.dispose(); services.segments?.close(); services.files.closeTemporaryRetention(); database.close();
    await companion.tasks.dispose(); await companionCore.dispose(); companion.segments?.close(); companion.files.closeTemporaryRetention(); companionDb.close();
  }
});
