import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Backend, BackendInput, BackendSession } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { ALGORITHM_RUNTIME } from '../../modules/financial/algorithm-types.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
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

function expectedMacd() {
  let short = closes[0]!, long = short, signal = 0;
  return closes.map(close => {
    short += (close - short) / 6.5;
    long += (close - long) / 13.5;
    const diff = short - long;
    signal += (diff - signal) / 5;
    return [diff, signal, 2 * (diff - signal), 0];
  });
}

function sourceDocument() {
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
  const rows = closes.map((close, index) => ({
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

test('AGENTS computes only MACD and publishes all 80 synthetic rows to isolated WFD with stable replay',
  { skip: !python || !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires explicitly selected WFD_PYTHON and XUAN_FULL_CHAIN_ROOT.' : false,
    timeout: 180_000 }, async () => {
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
      assert.deepEqual(workspace.toolLibrary!.view().tools.map(tool => [tool.id, tool.status]), [['macd', 'ready']]);
      assert.equal(runtime.currentIdentity().mode, 'user_test');
      const submitted = (await runtime.client.submit(sourceDocument())).result;
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
      for (const methodId of ['ma', 'ttm', 'macro_yoy']) {
        await assert.rejects(invoke('algorithms.calculate', { calculationJson: JSON.stringify({ ...request, methodId }) },
          'reject-' + methodId), { code: 'MODEL_ACTION_FAILED' });
      }
      const rejected = personalDb.connection.prepare("SELECT error FROM tasks WHERE action='algorithms.calculate'").all();
      assert.deepEqual(rejected.map(row => JSON.parse(String(row.error)).code), Array(3).fill('INVALID_ALGORITHM_METHOD'));
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
      assert.equal(result.rows.length, closes.length);
      const associations = workspace.r1!.localExplanation(wfdPublication.requestId).associations as WfdRecord[];
      assert.equal(associations.length, closes.length);
      const first = associations[0]!;
      const fixed = (await runtime.client.fixedRead(String(first.snapshot_id), String(first.product_id))).result;
      const readback = fixed.rows as WfdRecord[];
      assert.equal(readback.length, closes.length);
      const fixedByDay = new Map(readback.map(envelope => {
        const row = envelope.row as WfdRecord;
        return [String((row.observation_time as WfdRecord).earliest_utc).slice(0, 10), row.values as WfdRecord];
      }));
      for (const [index, values] of expectedMacd().entries()) {
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
      writeFileSync(join(fixture.root, 'macd-evidence.json'), JSON.stringify({ taskId, wfdPublication, source: { productId, snapshotId },
        derived: { snapshotId: first.snapshot_id, productId: first.product_id }, checkedRows: closes.length, checkedCells: closes.length * columns.length }, null, 2));
    } finally {
      finish();
      await personal.tasks.dispose(); await personalCore.dispose(); personalDb.close();
      workspace.segments?.close(); workspace.files.closeTemporaryRetention(); processRuntime.closeTemporaryRetention();
      await workspace.r1Batches?.dispose(); await workspace.r1Auto?.dispose();
      await workspace.tasks.dispose(); await workspaceCore.dispose(); workspaceDb.close();
    }
  });
