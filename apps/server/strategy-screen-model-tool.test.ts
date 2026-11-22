import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WfdProductMachineReply } from '../../adapters/database/wfd-product-machine.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { Backend, BackendInput, BackendSession } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { R1ConnectionIdentity } from '../../contracts/r1-contracts.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { R1ProductReader } from '../../modules/collection/r1-product-reader.js';
import type { R1Runtime } from '../../modules/collection/r1-runtime.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
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

/** 仅替换 WFD 进程响应，固定读合同、查询验证、会话、权限、任务和结果保管均用真实实现。 */
function syntheticReader() {
  const identity: R1ConnectionIdentity = { connectionId: 'synthetic-screen', profile: 'data_only', protocol: 'wfd.structured-ingest/1.0',
    mode: 'user_test', purpose: 'user_test', runtimeIdentity: 'synthetic-screen', callerId: 'synthetic-screen', namespace: 'synthetic.screen',
    store: '/synthetic/store', runtime: '/synthetic/runtime', configSha256: '1'.repeat(64), schemaSha256: '2'.repeat(64),
    entrySha256: '3'.repeat(64), pythonPath: '/synthetic/not-executed', entryPath: '/synthetic/not-executed.py' };
  const calls: WfdRecord[] = [];
  const reply = (result: WfdRecord) => ({ result, response: {}, transport: {} }) as WfdProductMachineReply;
  const client = {
    contractDiscovery: async (snapshotId: string) => reply({ snapshot_id: snapshotId, product_count: 1,
      products: [{ product_id: 'p_synthetic', dataset_id: 'synthetic_cross_section', payload_kind: 'tabular_rows',
        subject: { kind: 'instrument_universe', namespace: 'synthetic', id: 'screen' },
        declaration: { field_definitions: ['code', 'trade_date', 'momentum'].map(field_code =>
          ({ field_code, data_type: field_code === 'momentum' ? 'decimal' : 'text' })) },
        contracts: { read: { perspectives: ['snapshot_contents'] } }, definition_ref: { id: 'synthetic-def', version: 'v1' },
        contract_ref: { id: 'synthetic-contract' } }] }),
    readProduct: async (input: WfdRecord) => {
      calls.push(structuredClone(input));
      const cell = (value: unknown, dataType = 'text') => ({ value, value_state: 'valid_value', data_type: dataType,
        unit: { unit_code: dataType === 'text' ? 'text' : 'ratio' } });
      return reply({ format_version: 'wfd.read-product-result/0.1', operation: 'read_product',
        snapshot_id: input.snapshot_id, product_id: input.product_id, dataset_id: input.dataset_id, fields: input.fields,
        history_mode: input.history_mode, knowledge_cutoff: input.knowledge_cutoff, held_scope: input.held_scope,
        usable_stage: input.usable_stage, business_time_range: null, subject: null,
        query_hash: 'sha256:' + 'a'.repeat(64), budget: { max_scan_bytes: input.max_scan_bytes }, diagnostics: [], complete: true,
        rows: [['A', '2'], ['B', '5']].map(([code, momentum]) => ({
          record_ref: { logical_key: `synthetic-${code}`, revision_id: 'r_synthetic' }, business_time: { status: 'unknown' },
          values: { code: cell(code), trade_date: cell('2026-01-02'), momentum: cell(momentum, 'decimal') } })),
        page: { page_size: input.page_size, returned_rows: 2, total_rows: 2, remaining_rows: 0,
          has_more: false, next_cursor: null, page_complete: true } });
    },
  };
  const reader = new R1ProductReader({ runtime: () => ({ client: client as unknown as R1Runtime['client'], currentIdentity: () => identity }),
    control: () => ({ stopped: false, generation: 1 }) });
  return { reader, calls, identity };
}

test('AGENTS discovers and executes strategy screen through real perform_action / TaskService; replay is fixed and disable blocks new work', {
  skip: !process.env.XUAN_FULL_CHAIN_ROOT && '需要显式 XUAN_FULL_CHAIN_ROOT（隔离测试根）；不使用真实 WFD 或模型。', timeout: 30_000,
}, async () => {
  const f = createFullChainFixture({ name: 'strategy-screen-model' }), synthetic = syntheticReader();
  let capture!: (input: BackendInput) => void, finish!: () => void;
  const captured = new Promise<BackendInput>(resolve => { capture = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const backend: Backend = { id: 'synthetic-screen-capture', async createSession(): Promise<BackendSession> {
    const checkpoint = { backendId: this.id, format: 'synthetic-capture', version: 1, sessionRef: 'screen-capture', payload: null };
    return { id: 'screen-capture', send: async (input, emit) => {
      await emit({ type: 'run_started' });
      await emit({ type: 'input_consumed', inputId: input.inputId, messageKey: input.messageId });
      capture(input); await gate;
      return { outcome: 'interrupted', rawStopReason: 'synthetic-finished', checkpoint };
    }, steer: async () => ({ disposition: 'handled' }), exportCheckpoint: async () => checkpoint,
    abort: async () => { finish(); }, dispose: () => { finish(); } };
  } };
  const resources = new ResourceBindings(f.runtime), switches = { calculate: true };
  const companionDb = new CoreDatabase(join(f.runtime, 'state/companion.sqlite'));
  const companionCore = new PersonalCore(backend, { database: companionDb });
  const companion = createApplicationServices(companionCore, companionDb, { role: 'service', health, projectRoot: f.runtime,
    codeRoot, privateRoot: join(f.runtime, 'state/companion-private'), resources, productionModuleSwitches: switches });
  companion.r1Workspace = { readProduct: synthetic.reader.readProduct.bind(synthetic.reader),
    capabilities: () => ({ connection: synthetic.identity }) } as unknown as NonNullable<typeof companion.r1Workspace>;
  const database = new CoreDatabase(join(f.runtime, 'state/personal.sqlite')), core = new PersonalCore(backend, { database });
  const services = createApplicationServices(core, database, { role: 'personal', health, projectRoot: f.runtime, codeRoot,
    privateRoot: join(f.runtime, 'state/personal-private'), resources, workspaceServices: companion });
  try {
    assert.equal(companion.algorithms, undefined, '纯 TS 筛选不能要求 Python 指标服务');
    core.sendMessage(core.defaultConversationId, '对隔离合成固定截面运行有限筛选，返回候选，不发布或下单。', 'synthetic-screen-user');
    const input = await captured;
    const tools = services.modelTools.toolFactory({ model, getCurrentInput: () => input });
    const list = tools.find(tool => tool.name === 'list_actions')!, perform = tools.find(tool => tool.name === 'perform_action')!;
    assert.ok(list && perform);
    const listed = preview(await list.execute('screen-list', { query: 'algorithms.screen' }, undefined, undefined, toolContext));
    assert.equal(listed.actions.length, 1); assert.equal(listed.actions[0].available, true);
    const contract = preview(await perform.execute('screen-contract', { action: 'algorithms.contract', args: { methodId: 'strategy_screen' } },
      undefined, undefined, toolContext));
    assert.equal(contract.data.executor, 'typescript'); assert.equal(contract.data.available, true);
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
    switches.calculate = false;
    const disabled = preview(await list.execute('screen-list-disabled', { query: 'algorithms.screen' }, undefined, undefined, toolContext));
    assert.equal(disabled.actions[0].available, false);
    await assert.rejects(perform.execute('screen-disabled', args, undefined, undefined, toolContext));
    assert.equal(synthetic.calls.length, 1, '停用后新调用不读取数据');
  } finally {
    finish();
    await services.tasks.dispose(); await core.dispose(); services.segments?.close(); services.files.closeTemporaryRetention(); database.close();
    await companion.tasks.dispose(); await companionCore.dispose(); companion.segments?.close(); companion.files.closeTemporaryRetention(); companionDb.close();
  }
});
