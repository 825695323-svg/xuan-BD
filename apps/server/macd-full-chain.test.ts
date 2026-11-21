import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Backend, BackendInput, BackendSession } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { assertInternalAgentRules } from '../../modules/agent/instructions/rules.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { ALGORITHM_METHOD_IDS, ALGORITHM_RUNTIME } from '../../modules/financial/algorithm-types.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { createFullChainFixture } from './full-chain-test-support.js';
import { localAlgorithmConfiguration } from './financial-configuration.js';
import { createApplicationServices } from './services.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const python = process.env.WFD_PYTHON;
const model = { provider: 'fixture', model: 'fixture', baseUrl: 'https://model.invalid.test/v1' };
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false,
  provider: model.provider, model: model.model, notice: 'Synthetic model transport only.' };
const columns = ['DIFF', 'DEA', 'MACD', 'ZERO'] as const;
const adjustmentBasis = 'WFD financial.price_adjustment.direction=raw';
const day = (index: number) => new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
const closes = Array.from({ length: 80 }, (_, index) => 40 + ((index * 37) % 19) + index / 8);

function expectedMacd(input = closes) {
  let short = input[0]!, long = short, signal = 0;
  return input.map(close => {
    short += (close - short) / 6.5;
    long += (close - long) / 13.5;
    const diff = short - long;
    signal += (diff - signal) / 5;
    return [diff, signal, 2 * (diff - signal), 0];
  });
}

function sourceDocument(input = closes) {
  const namespace = 'full.chain.test';
  const subject = { kind: 'entity', namespace, id: 'synthetic_security' };
  const definitions = [['trade_date', 'text', 'date'], ['close', 'decimal', 'cny_per_share'], ['available_at', 'text', 'text']];
  const definition = {
    semantic_code: 'synthetic.daily.close', measurement_nature: 'mixed_observation', unit_code: 'per_field',
    definition_authority: namespace, time_role: 'observation',
    field_definitions: definitions.map(([field_code, data_type, unit_code]) => ({ field_code, data_type, unit_code,
      measurement_nature: field_code === 'close' ? 'stock' : 'relation', time_role: 'observation' })),
    semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
      time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC',
        roles: { observation: 'trade_date', availability: 'available_at', bar_closed: 'true' } },
      financial: { price_adjustment: { direction: 'raw' } } },
  };
  const rows = input.map((close, index) => ({
    business_key: 'daily-' + day(index), subject,
    observation_time: { status: 'known', earliest_utc: day(index) + 'T00:00:00Z', latest_exclusive_utc: day(index + 1) + 'T00:00:00Z',
      precision: 'day', source_timezone: 'UTC' },
    values: Object.fromEntries([day(index), String(close), day(index + 1) + 'T00:00:00Z'].map((value, position) => {
      const [field, data_type] = definitions[position]!;
      return [field, { value, value_state: 'valid_value', data_type }];
    })),
  }));
  return buildStructuredIngestDocument({
    requestId: 'macd-test-source', datasetId: 'macd_test_source', namespace, producerNamespace: namespace,
    submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ definition, rows })),
    expectedParentSnapshotId: null, outputKey: 'macd_test_source', subject, definition,
    inputMode: 'partial_observation', coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows },
  });
}

for (const size of [80, 12]) test(`AGENTS MACD publishes ${size} synthetic rows with ${size === 12 ? 'implementation replacement' : 'stable replay'}`,
  { skip: !python || !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires explicitly selected WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false,
    timeout: 180_000 }, async () => {
    const suppliedCloses = closes.slice(0, size);
    const fixture = createFullChainFixture({ name: 'macd-full-chain', machine: true,
      units: { cny_per_share: { dimension: 'money_per_share' }, text: { dimension: 'text' }, date: { dimension: 'date' } } });
    const bindingPath = join(fixture.runtime, 'config/machine.bindings.json');
    const binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
    binding.resources.python = { kind: 'program', path: python };
    writeFileSync(bindingPath, JSON.stringify(binding));
    let capture!: (input: BackendInput) => void;
    const captured = new Promise<BackendInput>(resolve => { capture = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const backend: Backend = { id: 'macd-capture', async createSession(): Promise<BackendSession> {
      const checkpoint = { backendId: this.id, format: 'capture', version: 1, sessionRef: 'capture', payload: null };
      return { id: 'capture', async send(input, emit) {
        await emit({ type: 'run_started' });
        await emit({ type: 'input_consumed', inputId: input.inputId, messageKey: input.messageId });
        capture(input); await gate;
        return { outcome: 'interrupted', rawStopReason: 'test-finished', checkpoint };
      }, steer: async () => ({ disposition: 'handled' }), exportCheckpoint: async () => checkpoint,
      abort: async () => { finish(); }, dispose: () => { finish(); } };
    } };
    const resources = new ResourceBindings(fixture.runtime);
    const processRuntime = new ProcessRuntime(resources);
    const workspaceDb = new CoreDatabase(join(fixture.runtime, 'state/workspace.sqlite'));
    const workspaceCore = new PersonalCore(backend, { database: workspaceDb });
    const common = { health, projectRoot: fixture.runtime, codeRoot, resources };
    const workspace = createApplicationServices(workspaceCore, workspaceDb, { ...common, role: 'service',
      privateRoot: join(fixture.runtime, 'state/workspace-private'), processRuntime, r1ConnectionId: 'full-chain-test',
      materials: { environment: 'local-review' }, configureAlgorithms: localAlgorithmConfiguration(codeRoot, processRuntime) });
    const personalDb = new CoreDatabase(join(fixture.runtime, 'state/personal.sqlite'));
    const personalCore = new PersonalCore(backend, { database: personalDb });
    const personal = createApplicationServices(personalCore, personalDb, { ...common,
      privateRoot: join(fixture.runtime, 'state/personal-private'), workspaceServices: workspace });
    try {
      const algorithms = workspace.algorithms!, runtime = workspace.r1Runtime!;
      assert.ok(algorithms && runtime && workspace.derivedPublisher);
      workspace.permissions.grant({ label: 'isolated MACD Python', scope: { kind: 'persistent' }, capabilities: [
        { action: 'execute', target: { kind: 'file', path: processRuntime.path('python3') } },
      ] });
      const toolsInLibrary = workspace.toolLibrary!.view().tools;
      assert.deepEqual(toolsInLibrary.filter(tool => tool.status === 'ready').map(tool => tool.id), ALGORITHM_METHOD_IDS);
      const pureTools = toolsInLibrary.filter(tool => tool.executor === 'typescript');
      assert.deepEqual(pureTools.map(tool => tool.id),
        ['financial_single_quarter', 'financial_ttm', 'financial_growth', 'financial_ratios', 'price_adjustment']);
      assert.ok(pureTools.every(tool => tool.state === 'executable' && tool.status === 'unavailable' && tool.reason?.includes('algorithms.calculate')));
      assert.equal(runtime.currentIdentity().mode, 'user_test');
      const submitted = (await runtime.client.submit(sourceDocument(suppliedCloses))).result;
      assert.equal(submitted.state, 'published_formal', JSON.stringify({ errors: submitted.errors, state: submitted.state }));
      assert.equal(submitted.formal_publication_verified, true);
      const snapshotId = String(submitted.snapshot_id);
      const discovered = (await runtime.connection.client.discover(snapshotId)).result;
      const product = (discovered.products as WfdRecord[])[0]!;
      const productId = String(product.product_id);
      assert.ok(productId && product.definition_ref, JSON.stringify({ submitted, discovered }));
      const request = { methodId: 'macd', parameters: { short_period: 12, long_period: 26, signal_period: 9, init: 'first_valid' },
        source: { kind: 'fixed_snapshot', reference: {
          kind: 'wfd_fixed_snapshot', instanceId: runtime.connection.connectionId, snapshotId, productId,
          definitionRevision: String((product.definition_ref as WfdRecord).version),
          fields: ['trade_date', 'close', 'available_at'],
          fieldMapping: { timestamp: 'trade_date', close: 'close', available_at: 'available_at' },
          semantics: { subject: 'synthetic daily closes', frequency: '1d', timezone: 'UTC', priceUnit: 'currency_per_share',
            currency: 'CNY', adjustment: 'unadjusted', adjustmentBasis, barClosed: true, synthetic: true, availability: { kind: 'column' } },
          calendar: { mode: 'dense' },
        } }, usage: { purpose: 'current_compute', historyMode: null, cutoff: null, perspective: null } };
      personalCore.sendMessage(personalCore.defaultConversationId, '计算隔离样本固定快照的 MACD。', 'macd-user');
      const input = await captured;
      const useFrozenV18 = size === 80;
      if (useFrozenV18) {
        const frozen = personalCore.runConfiguration(input.runId);
        assert.ok(frozen?.internalAgentRulesText && frozen.internalAgentRules);
        const boundary = frozen.internalAgentRulesText.indexOf('\n\n13. **算法边界**');
        assert.ok(boundary > 0);
        const v18Text = frozen.internalAgentRulesText.slice(0, boundary).replace(/^1\. .+$/mu,
          '1. **身份与范围**：你是 xuan BD（数据处理与导入应用）的内置操作代理，只处理来源采集、转换、解析、清洗、标注、核对、结构化、基础算法和导入交接。研究、交易、回测及独立 xuan 不属于本应用。') + '\n';
        const historical = { ...frozen, internalAgentRulesText: v18Text,
          internalAgentRules: { ...frozen.internalAgentRules, version: 18,
            digest: 'fb576a22f1942ea217a66180149c737f5388392e32112ec28589a592140d124c' } };
        assertInternalAgentRules(historical);
        personalDb.connection.prepare('UPDATE runs SET configuration_json=? WHERE id=?').run(JSON.stringify(historical), input.runId);
      }
      const tools = personal.modelTools.toolFactory({ model, getCurrentInput: () => input });
      const perform = tools.find(tool => tool.name === 'perform_action')!;
      const evidenceRead = tools.find(tool => tool.name === 'core_evidence_read')!;
      assert.ok(perform && evidenceRead);
      const context = {} as Parameters<ToolDefinition['execute']>[4];
      const parse = (output: Awaited<ReturnType<ToolDefinition['execute']>>) =>
        JSON.parse(output.content.filter(part => part.type === 'text').map(part => part.text).join(''));
      async function invoke(action: string, args: Record<string, unknown>, callId: string) {
        const result = parse(await perform.execute(callId, { action, args }, undefined, undefined, context));
        if (result.complete !== false) return result;
        const { evidenceId, sha256 } = result.evidence;
        let page = result.evidence, text = page.text;
        for (let index = 0; !page.done; index++) {
          assert.ok(page.nextCursor);
          page = parse(await evidenceRead.execute(`${callId}-evidence-${index}`,
            { evidenceId, sha256, cursor: page.nextCursor }, undefined, undefined, context));
          text += page.text;
        }
        assert.equal(wfdSha256(text), sha256);
        return JSON.parse(text);
      }
      for (const methodId of ['unregistered_indicator', 'ttm', 'macro_yoy']) {
        await assert.rejects(invoke('algorithms.calculate', { calculationJson: JSON.stringify({ ...request, methodId }) },
          'reject-' + methodId), { code: 'MODEL_ACTION_FAILED' });
      }
      if (useFrozenV18) {
        const toolCallId = 'reject-ma-by-frozen-rules';
        const calculationJson = JSON.stringify({ ...request, methodId: 'ma', parameters: { period: 3 } });
        await assert.rejects(invoke('algorithms.calculate', { calculationJson }, toolCallId), (error: unknown) => {
          assert.ok(error instanceof Error);
          const projected = personal.modelTools.projectToolResult({ role: 'toolResult', toolCallId, toolName: 'perform_action',
            isError: true, content: [{ type: 'text', text: error.message }], timestamp: Date.now() }, input, undefined, model);
          assert.match(projected.content.map(part => part.type === 'text' ? part.text : '').join(''), /v18.*仅允许 macd/u);
          return true;
        });
      }
      const rejected = personalDb.connection.prepare("SELECT error FROM tasks WHERE action='algorithms.calculate'").all();
      assert.deepEqual(rejected.map(row => JSON.parse(String(row.error)).code), useFrozenV18
        ? Array(4).fill('ALGORITHM_METHOD_NOT_ALLOWED_BY_RULES') : Array(3).fill('INVALID_ALGORITHM_METHOD'));
      const calculated = await invoke('algorithms.calculate', { calculationJson: JSON.stringify(request) }, 'macd-calculate')
        .catch(error => {
          const failed = personalDb.connection.prepare("SELECT error FROM tasks WHERE action='algorithms.calculate' ORDER BY rowid DESC LIMIT 1").get();
          throw new Error(String(failed?.error ?? error), { cause: error });
        });
      const data = calculated.data;
      const publication = data?.wfdPublication;
      const receipt = publication ? JSON.parse(String(workspace.r1!.attempt(publication.requestId).receipt_json ?? '{}')) : null;
      assert.equal(publication?.published, true, JSON.stringify({ calculationStatus: data?.status,
        calculationError: data?.error, publication, receiptErrors: receipt?.output_results?.map((item: WfdRecord) => item.errors) }));
      const { taskId, wfdPublication } = data;
      const result = algorithms.view(taskId).result!;
      assert.ok(result);
      const current = runtime.currentIdentity();
      const oldConnection = Object.fromEntries((['connectionId', 'protocol', 'profile', 'mode', 'purpose', 'runtimeIdentity',
        'store', 'runtime', 'callerId', 'namespace', 'configSha256', 'schemaSha256', 'entrySha256', 'pythonPath', 'entryPath'] as const)
        .map(key => [key, current[key]]));
      assert.equal((result.source as WfdRecord).connectionIdentityDigest, digestOperationArgs(oldConnection),
        '派生任务持久化的连接摘要须与旧 R1 身份完全相同，随后按原任务号恢复发布');
      assert.equal(result.rows.length, suppliedCloses.length);
      const associations = workspace.r1!.localExplanation(wfdPublication.requestId).associations as WfdRecord[];
      assert.equal(associations.length, suppliedCloses.length);
      const first = associations[0]!;
      const fixed = (await runtime.client.fixedRead(String(first.snapshot_id), String(first.product_id))).result;
      const readback = fixed.rows as WfdRecord[];
      assert.equal(readback.length, suppliedCloses.length);
      const fixedByDay = new Map(readback.map(envelope => {
        const row = envelope.row as WfdRecord;
        return [String((row.observation_time as WfdRecord).earliest_utc).slice(0, 10), row.values as WfdRecord];
      }));
      for (const [index, values] of expectedMacd(suppliedCloses).entries()) {
        const actual = result.rows[index]!;
        assert.equal(actual.timestamp, day(index));
        for (const [columnIndex, column] of columns.entries()) {
          assert.ok(Math.abs(Number(actual[column]) - values[columnIndex]!) < 1e-10, `${day(index)} ${column}`);
          assert.equal(Number((fixedByDay.get(day(index))![column] as WfdRecord).value), actual[column]);
        }
      }
      const attempts = workspaceDb.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get();
      const calculationReplay = await invoke('algorithms.calculate', { calculationJson: JSON.stringify(request) }, 'macd-calculate');
      assert.equal(calculationReplay.data.taskId, taskId);
      assert.deepEqual(calculationReplay.data.wfdPublication, wfdPublication);
      const publishingAgain = invoke('algorithms.publish', { taskId }, 'macd-publish-replay');
      publishingAgain.catch(() => {});
      let approved = false;
      for (let index = 0; index < 400 && !approved; index++) {
        const row = personalDb.connection.prepare('SELECT task_id FROM model_tool_calls WHERE tool_call_id=?').get('macd-publish-replay');
        const approvalId = row?.task_id ? personal.tasks.get(String(row.task_id)).approvalId : null;
        if (approvalId) {
          personal.tasks.approve(approvalId);
          approved = true;
        } else await delay(25);
      }
      assert.equal(approved, true);
      const replay = await publishingAgain;
      assert.deepEqual(replay.data.wfdPublication, wfdPublication);
      assert.deepEqual(workspaceDb.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get(), attempts);
      assert.equal(workspaceDb.connection.prepare('SELECT count(*) AS n FROM tasks WHERE runtime_id=?').get(ALGORITHM_RUNTIME)?.n, 1);
      if (size === 12) {
        // Same semantics, same fixed input, real different Python asset bytes. No mocked numerical result.
        const revisedRoot = join(fixture.root, 'implementation-rebuild');
        const revisedAssets = join(revisedRoot, 'plugins/financial/local-compute/assets');
        mkdirSync(revisedAssets, { recursive: true });
        cpSync(join(codeRoot, 'plugins/financial/local-compute/assets'), revisedAssets, { recursive: true });
        appendFileSync(join(revisedAssets, 'indicators.py'), '\n# Isolated test-only implementation rebuild; mathematics unchanged.\n');
        const updatedDb = new CoreDatabase(join(fixture.runtime, 'state/updated-implementation.sqlite'));
        const updatedCore = new PersonalCore(backend, { database: updatedDb });
        const updated = createApplicationServices(updatedCore, updatedDb, { ...common, role: 'service',
          privateRoot: join(fixture.runtime, 'state/updated-implementation-private'), processRuntime,
          r1ConnectionId: 'full-chain-test', materials: { environment: 'local-review' },
          configureAlgorithms: localAlgorithmConfiguration(revisedRoot, processRuntime) });
        try {
          updated.permissions.grant({ label: 'isolated rebuilt MACD Python', scope: { kind: 'persistent' }, capabilities: [
            { action: 'execute', target: { kind: 'file', path: processRuntime.path('python3') } },
          ] });
          const accepted = updated.algorithms!.submit('same-semantics-rebuilt-implementation', request,
            { authority: 'operator-http', requestId: 'same-semantics-rebuilt-implementation', observedAtUtc: new Date().toISOString() });
          const completed = await updated.tasks.wait(accepted.taskId);
          assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
          const rebuilt = updated.algorithms!.view(accepted.taskId).result!;
          assert.notEqual(rebuilt.implementationVersion, result.implementationVersion);
          assert.equal(rebuilt.methodVersion, result.methodVersion);
          assert.deepEqual(rebuilt.rows, result.rows);
          const headBefore = (await runtime.client.snapshotStatus()).result.snapshot_id;
          const second = await updated.derivedPublisher!.publish(accepted.taskId);
          assert.equal(second.published, true, JSON.stringify(second));
          const secondAttempt = updated.r1!.attempt(second.requestId);
          const secondReceipt = JSON.parse(String(secondAttempt.receipt_json));
          assert.equal(secondReceipt.wfd_state, 'unchanged', 'Implementation-only rebuild must not create financial facts');
          assert.equal(secondReceipt.row_summary.inserted, 0);
          assert.equal(secondReceipt.row_summary.duplicate_skipped, suppliedCloses.length);
          assert.equal(secondReceipt.new_snapshot_created, false);
          const links = updated.r1!.localExplanation(second.requestId).associations as WfdRecord[];
          assert.equal(links.length, suppliedCloses.length);
          assert.ok(links.every(link => link.product_id === first.product_id && link.definition_digest === first.definition_digest));
          assert.equal((await runtime.client.snapshotStatus()).result.snapshot_id, headBefore);
          const originalDocument = JSON.parse(String(workspace.r1!.attempt(wfdPublication.requestId).document_json));
          const nextDocument = JSON.parse(String(secondAttempt.document_json));
          assert.deepEqual(nextDocument.outputs[0].definition, originalDocument.outputs[0].definition);
          rmSync(revisedRoot, { recursive: true, force: true });
          updatedDb.connection.prepare('DELETE FROM algorithm_assets WHERE version=?').run(rebuilt.implementationVersion);
          assert.deepEqual(updated.algorithms!.view(accepted.taskId).result, rebuilt,
            'Reading frozen results must not require retired implementation bytes');
          assert.equal((await updated.derivedPublisher!.publish(accepted.taskId)).requestId, second.requestId);
          const pinnedAgain = (await runtime.client.fixedRead(String(first.snapshot_id), String(first.product_id))).result;
          assert.deepEqual(pinnedAgain.rows, fixed.rows, 'Old fixed read remains unchanged after an implementation rebuild');
        } finally {
          updated.segments?.close(); updated.files.closeTemporaryRetention();
          await updated.r1Batches?.dispose(); await updated.r1Auto?.dispose();
          await updated.tasks.dispose(); await updatedCore.dispose(); updatedDb.close();
        }
      }
      writeFileSync(join(fixture.root, 'macd-evidence.json'), JSON.stringify({ taskId, wfdPublication, source: { productId, snapshotId },
        derived: { snapshotId: first.snapshot_id, productId: first.product_id }, checkedRows: suppliedCloses.length, checkedCells: suppliedCloses.length * columns.length }, null, 2));
    } finally {
      finish();
      await personal.tasks.dispose(); await personalCore.dispose(); personalDb.close();
      workspace.segments?.close(); workspace.files.closeTemporaryRetention(); processRuntime.closeTemporaryRetention();
      await workspace.r1Batches?.dispose(); await workspace.r1Auto?.dispose();
      await workspace.tasks.dispose(); await workspaceCore.dispose(); workspaceDb.close();
    }
  });
