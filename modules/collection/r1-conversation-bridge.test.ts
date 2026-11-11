import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Backend, BackendCheckpoint, BackendEvent, BackendInput, BackendSession } from '../../contracts/backend.js';
import type { ConversationAttachmentRef, HealthResponse } from '../../contracts/contracts.js';
import type { PiToolFactoryContext } from '../../contracts/llm.js';
import type { R1PrepareInput, R1SourceDeclaration } from '../../contracts/r1-contracts.js';
import type { JsonValue, TaskRecord } from '../../contracts/task-contracts.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { WfdProductMachineError } from '../../adapters/database/wfd-product-machine.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { DIMENSION_KEYS } from './processing-routing.js';
import { ConversationProcessingBridge } from './conversation-processing.js';
import { createApplicationServices } from '../../apps/server/services.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { isolatedPythonArgs } from '../../platform/resources/native-check.mjs';
import { PersonalCore } from '../agent/runtime/core.js';

const codeRoot = fileURLToPath(new URL('../..', import.meta.url));
const productRoot = join(codeRoot, 'wfd/product');
const python = process.env.WFD_PYTHON;
const rawCsv = Buffer.from('business_key,value_decimal,start_utc,end_utc\nrow-1,12.30,2026-01-02T00:00:00Z,2026-01-03T00:00:00Z\nrow-2,13.40,2026-01-03T00:00:00Z,2026-01-04T00:00:00Z\n');
const routingFacts = Object.freeze({ role: 'scalar_observation', informationNature: 'observed_fact',
  businessObject: 'isolated_synthetic_object', objectTime: 'UTC_day_interval_2026-01-02_to_2026-01-04',
  purpose: 'prepare_publish_after_separate_host_confirmation', structureGranularity: 'two_scalar_rows' });
const source: R1SourceDeclaration = Object.freeze({ source_id: 'conversation-fixture', provider: 'synthetic-fixture',
  requested_url: 'https://source.example.test/conversation.csv', requested_at_utc: '2026-01-02T00:00:00Z',
  acquired_at_utc: '2026-01-02T00:01:00Z', license: 'synthetic-test-only', usage_scope: 'isolated-test',
  authorization: { status: 'authorized' as const, basis: 'user declared isolated synthetic test use' } });
const mapping: R1PrepareInput['mapping'] = Object.freeze({ businessKey: 'business_key', value: 'value_decimal',
  earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc', precision: 'day', sourceTimezone: 'UTC' });
const target: R1PrepareInput['target'] = Object.freeze({ datasetId: 'r1_conversation_test', outputKey: 'r1.conversation.metric',
  expectedParentSnapshotId: null, subject: { kind: 'physical_object', namespace: 'r1.conversation.test', id: 'object_1' },
  definition: { semantic_code: 'r1.conversation.metric', measurement_nature: 'flow', unit_code: 'count',
    definition_authority: 'r1.conversation.test', time_role: 'observation',
    semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
      time: { period_type: 'natural', frequency: 'day', interval: 'closed' },
      statistical: { price_basis: 'nominal', period_aggregation: 'period' } } }, inputMode: 'partial_observation',
  coverage: { scope: { sample_only: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } });
const sourceLine = (key: string, value: unknown) => key === 'authorization'
  ? `authorization = ${JSON.stringify(value, null, 2)}` : `${key}=${value}`;
function userStatement(extra = ''): string {
  return '请处理明确附上的隔离合成CSV，并按以下事实准备R1；intendedAction=publish。正式提交另由宿主用户确认。\n'
    + Object.entries(routingFacts).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
    + Object.entries(source).map(([key, value]) => sourceLine(key, value)).join('\n')
    + '\nalternate_provider=synthetic-fixture-alternate\n固定目标与映射=' + JSON.stringify({ target, mapping }) + '\n' + extra;
}
const inspectOnlyUserQuote = '本轮仅检查已附材料；intendedAction=inspect；purpose=current_compute；不请求发布、不提交 WFD。';
const r1Actions = ['data.r1.capabilities', 'data.r1.prepare', 'data.r1.get', 'data.r1.list', 'data.r1.recover', 'data.r1.check'];
const model = Object.freeze({ provider: 'fixture-receiver', model: 'fixture-no-provider', baseUrl: 'https://model.invalid.test/v1' });
// Core toolFactory closures capture all required host context themselves. This empty adapter-only
// parameter is deliberately inert; using an unimplemented Pi extension method will fail the test.
const unusedPiContext = Object.freeze({}) as Parameters<ToolDefinition['execute']>[4];
function shareDetails(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as JsonValue;
}
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false,
  provider: model.provider, model: model.model, notice: 'Synthetic receiver identity only; no provider or network calls.' };

function json(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

/** A session transport double only: the real Core accepts/consumes the real user input.
 * It deliberately holds the active run so actual modelTools can use its host-owned identity.
 * The steer-only assistant boundary is explicitly synthetic transport scaffolding, not model inference.
 * No model_tool_calls row, processing link or publication receipt is fabricated.
 */
class CapturingBackend implements Backend {
  readonly id = 'r1-conversation-no-model';
  private readonly inputs = new Map<string, BackendInput>();
  private readonly waiting = new Map<string, (input: BackendInput) => void>();
  private capture(input: BackendInput): void {
    this.inputs.set(input.inputId, input);
    this.waiting.get(input.inputId)?.(input); this.waiting.delete(input.inputId);
  }
  async createSession(): Promise<BackendSession> {
    const checkpoint: BackendCheckpoint = { backendId: this.id, format: 'synthetic-capture', version: 1,
      sessionRef: 'capture-only', payload: null };
    let finish: () => void = () => {}, current: BackendInput | undefined;
    let emitCurrent: ((event: BackendEvent) => Promise<void>) | undefined;
    return { id: 'capture-only', send: async (input, emit) => {
      const gate = new Promise<void>(resolve => { finish = resolve; });
      current = input; emitCurrent = emit;
      await emit({ type: 'run_started' });
      await emit({ type: 'input_consumed', inputId: input.inputId, messageKey: input.messageId });
      this.capture(input);
      await gate;
      return { outcome: 'interrupted', rawStopReason: 'fixture-closed', checkpoint };
    }, steer: async input => {
      assert.ok(emitCurrent && current, 'Only Core-dispatched steering inputs can be captured.');
      const messageKey = 'capture-assistant-' + current.inputId;
      await emitCurrent({ type: 'message_started', messageKey, role: 'assistant' });
      await emitCurrent({ type: 'message_finalized', messageKey, role: 'assistant',
        text: 'Synthetic transport boundary only; no model inference.', rawStopReason: 'fixture-boundary' });
      await emitCurrent({ type: 'input_consumed', inputId: input.inputId, messageKey: input.messageId });
      current = input; this.capture(input); return { disposition: 'handled' };
    }, exportCheckpoint: async () => checkpoint,
    abort: async () => { finish(); }, dispose: () => { finish(); } };
  }
  waitForInput(inputId: string): Promise<BackendInput> {
    const input = this.inputs.get(inputId);
    if (input) return Promise.resolve(input);
    return new Promise(resolve => { this.waiting.set(inputId, resolve); });
  }
}

function fixture(machine = false) {
  // Current acceptance always supplies F05/tests. The ordinary TS runner may use its normal temporary parent.
  const root = realpathSync(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(), 'r1-conversation-')));
  const runtime = join(root, 'bd'); mkdirSync(runtime);
  const resources: Record<string, { path: string; kind: 'directory' | 'file' }> = {};
  for (const name of ['config', 'state', 'cache', 'temp', 'downloads', 'browser_home', 'model_resources']) {
    const path = join(runtime, name); mkdirSync(path); resources[name] = { path, kind: 'directory' };
  }
  const store = join(root, 'wfd-store'), wfdRuntime = join(root, 'wfd-runtime');
  const configPath = join(runtime, 'config/r1-machine.json'), registryPath = join(runtime, 'config/connections.json');
  const protocolRoot = join(root, 'isolated-protocol'), entryPath = join(root, 'isolated-product-machine.py');
  const schemaPath = join(protocolRoot, 'schemas/wfd-structured-ingest.schema.json');
  if (machine) {
    assert.ok(python, 'Real Python cases require explicitly selected WFD_PYTHON.');
    assert.ok(process.env.PYTHONPYCACHEPREFIX, 'Real Python cases require a fresh explicit bytecode read prefix.');
    mkdirSync(store); mkdirSync(wfdRuntime);
    cpSync(join(productRoot, 'protocol'), protocolRoot, { recursive: true, errorOnExist: true, force: false });
    writeFileSync(entryPath, readFileSync(join(productRoot, 'wfd_sdk/product_machine.py')), { flag: 'wx', mode: 0o600 });
    const initializationCache = join(root, 'initialization-read-cache'); mkdirSync(initializationCache);
    const initializationTemp = join(root, 'initialization-temp'); mkdirSync(initializationTemp);
    const initialized = spawnSync(python, isolatedPythonArgs(initializationCache, ['-c',
      'from pathlib import Path; import sys; sys.path.insert(0, sys.argv[4]); from wfd_sdk.duckdb_sdk import WFDDuckDBPrototype,load_protocol_validator; WFDDuckDBPrototype.initialize_new(Path(sys.argv[1]),load_protocol_validator(Path(sys.argv[3])),runtime_root=Path(sys.argv[2]),sandbox=False,writer_host="r1-conversation-test"); import json; print(json.dumps({"initialized":True,"isolated":sys.flags.isolated,"ignore_environment":sys.flags.ignore_environment,"no_user_site":sys.flags.no_user_site,"dont_write_bytecode":sys.flags.dont_write_bytecode,"pycache_prefix":sys.pycache_prefix,"source_root":str(Path(__import__("wfd_sdk").__file__).resolve().parent.parent)}))',
      store, wfdRuntime, protocolRoot, productRoot]), { cwd: initializationTemp, encoding: 'utf8', timeout: 30000,
      env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONPATH: productRoot,
        PYTHONPYCACHEPREFIX: initializationCache, TMPDIR: initializationTemp } });
    json(join(root, 'python-initialization.json'), { python, status: initialized.status, error: initialized.error?.message ?? null,
      stdout: initialized.stdout, stderr: initialized.stderr, bytecodeReadPrefix: initializationCache });
    assert.equal(initialized.status, 0, initialized.stderr + String(initialized.error ?? ''));
    const initialization = JSON.parse(initialized.stdout.trim());
    assert.equal(initialization.isolated, 1, 'Initialization must use Python isolated mode, not just -B.');
    assert.equal(initialization.ignore_environment, 1);
    assert.equal(initialization.no_user_site, 1);
    assert.equal(initialization.dont_write_bytecode, 1);
    assert.equal(initialization.pycache_prefix, initializationCache);
    assert.equal(initialization.source_root, realpathSync(productRoot));
    json(configPath, { protocol_version: 'wfd.product-machine-config/0.1', profile: 'data_only',
      connection_id: 'r1-conversation-test', store, runtime: wfdRuntime, project_root: productRoot, protocol_root: protocolRoot,
      caller: { caller_id: 'r1-conversation-test', trusted_actor_namespace: 'r1.conversation.test', roles: ['read', 'register', 'submit', 'publish'] },
      units: { count: { dimension: 'quantity' } }, sources: {}, limits: {} });
    json(registryPath, { connections: [{ id: 'r1-conversation-test', kind: 'wfd-product-machine', mode: 'user_test', purpose: 'user_test',
      protocol: 'wfd.product-machine/0.1', config_path: configPath, store, runtime: wfdRuntime, python_path: python,
      entry_path: entryPath, harness_binding: { root: runtime, root_id: 'isolated-r1-conversation' } }] });
    resources.connections_registry = { path: registryPath, kind: 'file' };
  }
  json(join(runtime, '.xuan-runtime.json'), { version: 1, application: 'xuan-bd', identity: 'isolated-r1-conversation' });
  json(join(runtime, 'config/machine.bindings.json'), { version: 1, revision: 1,
    runtimeIdentity: 'isolated-r1-conversation', resources });
  return { root, runtime, store, wfdRuntime, configPath, registryPath, entryPath, schemaPath };
}

async function host(f: ReturnType<typeof fixture>) {
  const companionDatabase = new CoreDatabase(join(f.runtime, 'state/companion.sqlite'));
  const companionCore = new PersonalCore(new CapturingBackend(), { database: companionDatabase });
  const companion = createApplicationServices(companionCore, companionDatabase, { role: 'service', health,
    projectRoot: f.runtime, codeRoot, privateRoot: join(f.runtime, 'state/companion-private'),
    resources: new ResourceBindings(f.runtime), r1ConnectionId: 'r1-conversation-test', materials: { environment: 'synthetic-test' } });
  const database = new CoreDatabase(join(f.runtime, 'state/personal.sqlite'));
  const backend = new CapturingBackend(), core = new PersonalCore(backend, { database });
  const services = createApplicationServices(core, database, { role: 'personal', health,
    projectRoot: f.runtime, codeRoot, privateRoot: join(f.runtime, 'state/personal-private'),
    resources: new ResourceBindings(f.runtime), workspaceServices: companion, modelConfigurationVersion: 'fixture-receiver-v1' });
  let closed = false;
  return { root: f.root, companionDatabase, companionCore, companion, database, backend, core, services,
    async close() {
      if (closed) return; closed = true;
      await services.tasks.dispose(); await core.dispose(); database.close();
      await companion.tasks.dispose(); await companionCore.dispose(); companionDatabase.close();
    } };
}

function resultValue(result: { content: readonly { type: string; text?: string }[] }): Record<string, any> {
  return JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text ?? '').join(''));
}

type Host = Awaited<ReturnType<typeof host>>;
let traceSequence = 0;
function toolsFor(h: Host, input: BackendInput) {
  const tools = h.services.modelTools.toolFactory({ model, getCurrentInput: () => input });
  const perform = tools.find(tool => tool.name === 'perform_action'); assert.ok(perform);
  return { tools, perform };
}
function callTask(h: Host, input: BackendInput, toolCallId: string): TaskRecord | null {
  const row = h.database.connection.prepare('SELECT task_id FROM model_tool_calls WHERE parent_run_id=? AND parent_generation=? AND tool_call_id=?')
    .get(input.runId, input.generation, toolCallId);
  return row?.task_id ? h.services.tasks.get(String(row.task_id)) : null;
}
async function invoke(h: Host, input: BackendInput, action: string, args: Record<string, unknown> = {},
  toolCallId = 'r1-call-' + (++traceSequence)) {
  const { perform } = toolsFor(h, input);
  const tracePath = join(h.root, `tool-${String(++traceSequence).padStart(4, '0')}-${toolCallId}.json`);
  try {
    const raw = await perform.execute(toolCallId, { action, args }, undefined, undefined, unusedPiContext);
    const preview = resultValue(raw);
    json(tracePath, { toolCallId, action, args, preview, details: raw.details });
    return { preview, raw, toolCallId };
  } catch (error) {
    const task = callTask(h, input, toolCallId);
    json(tracePath, { toolCallId, action, args, modelError: { code: (error as { code?: string }).code ?? null,
      message: (error as Error).message }, actualTaskId: task?.id ?? null, actualTaskStatus: task?.status ?? null,
      actualTaskError: task?.error ?? null });
    if (process.env.BD_DIAG_PROCESSING === '1' && action.startsWith('data.processing.'))
      console.error('BD_PROCESSING_DIAG', JSON.stringify({ action, toolCallId,
        modelCode: (error as { code?: string }).code ?? null, modelMessage: (error as Error).message,
        taskId: task?.id ?? null, taskStatus: task?.status ?? null, taskError: task?.error ?? null }));
    throw error;
  }
}
async function failure(h: Host, input: BackendInput, action: string, args: Record<string, unknown>,
  taskCode: string | null, toolCallId = 'r1-negative-' + (++traceSequence), modelCode?: string): Promise<void> {
  await assert.rejects(invoke(h, input, action, args, toolCallId), (error: unknown) => {
    const code = (error as { code?: string }).code;
    assert.equal(code, modelCode ?? 'MODEL_ACTION_FAILED', 'Model failure must stay a fixed public code.');
    if (taskCode) assert.equal(callTask(h, input, toolCallId)?.error?.code, taskCode, 'Inspect only the actual locally persisted task error.');
    return true;
  });
}
function projectedFailure(h: Host, input: BackendInput, toolCallId: string) {
  const projected = h.services.modelTools.projectToolResult({ role: 'toolResult', toolName: 'perform_action', toolCallId,
    content: [{ type: 'text', text: 'untrusted native diagnostic /private/secret?key=hidden' }],
    details: {}, isError: true, timestamp: Date.now() }, input, undefined, model);
  return resultValue(projected);
}
async function startInput(h: Host, text: string, requestId: string,
  options: { conversationId?: string; attachmentRefs?: ConversationAttachmentRef[]; mode?: 'send' | 'steer' } = {}) {
  const conversationId = options.conversationId ?? h.core.defaultConversationId;
  const accepted = h.core.sendMessage(conversationId, text, requestId, { attachmentRefs: options.attachmentRefs, mode: options.mode });
  const input = await h.backend.waitForInput(accepted.commandId);
  assert.equal(h.core.isRunActive(input.runId, input.generation), true);
  assert.equal(h.core.store.message(input.messageId).text, text);
  return input;
}
async function selectedInput(h: Host, caseId: string, csv = rawCsv, extension = 'csv', userText = userStatement()) {
  const path = join(h.root, caseId + '.' + extension); writeFileSync(path, csv, { flag: 'wx', mode: 0o600 });
  const conversationId = h.core.defaultConversationId;
  const reference = h.services.files.register({ path, source: 'user-attached', conversationId });
  // Explicit synthetic operator selection, not a default permission expansion or fabricated tool receipt.
  h.services.permissions.grant({ label: 'Fixture user-selected CSV only', scope: { kind: 'persistent' },
    capabilities: [{ action: 'read', target: { kind: 'file', path } }] });
  const attachment: ConversationAttachmentRef = { fileRefId: reference.id, version: reference.version, category: 'data' };
  const input = await startInput(h, userText, caseId + '-user-input', { conversationId, attachmentRefs: [attachment] });
  return { input, reference, attachment };
}
function evidenceFor(input: BackendInput, declaration = source) {
  return Object.fromEntries(Object.entries(declaration).map(([field, value]) => [field, { messageId: input.messageId,
    quote: field === 'provider' && value !== source.provider ? `alternate_provider=${value}`
      : sourceLine(field, value) }]));
}
function prepareArgs(input: BackendInput, planId: string, declaration = source) {
  return { planId, outputId: 'scalar', sourceJson: JSON.stringify(declaration), sourceEvidenceJson: JSON.stringify(evidenceFor(input, declaration)) };
}
async function actualPlan(h: Host, input: BackendInput, fileRefId: string, caseId: string) {
  const materialRead = await invoke(h, input, 'material.read', { fileRefId }, caseId + '-material-read');
  const materialId = String(materialRead.preview.data.materialId);
  assert.ok(materialId && materialId !== 'undefined', JSON.stringify(materialRead.preview));
  assert.equal(h.companion.materials!.get(materialId).envelope.sha256, materialRead.preview.data.originalSha256);
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: routingFacts[key],
    evidence: [{ source: 'user-message', messageId: input.messageId, quote: `${key}=${routingFacts[key]}` }] }]));
  const planJson = { routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
    outputs: [{ outputId: 'scalar', materialIds: [materialId], intendedAction: 'publish',
      usage: { purpose: 'current_publish', historyMode: null, cutoff: null, perspective: null,
        messageId: input.messageId, quote: 'intendedAction=publish' },
      tables: [{ materialId, format: 'csv', types: { value_decimal: 'decimal_string' } }],
      target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target, mapping }, expectedSnapshotId: null } }] };
  const prepared = await invoke(h, input, 'data.processing.plan', { planJson: JSON.stringify(planJson) }, caseId + '-processing-plan');
  const planId = String(prepared.preview.data.planId);
  assert.ok(planId && planId !== 'undefined', JSON.stringify(prepared.preview));
  const executed = await invoke(h, input, 'data.processing.run', { planId }, caseId + '-processing-run');
  const plan = h.companion.processing!.get(planId);
  assert.equal(plan.version, 'bd-processing-plan/1'); assert.equal(plan.outputs[0]!.publishEligible, true, JSON.stringify(plan));
  assert.ok(plan.steps.every(step => step.state === 'succeeded' || step.applicability === 'not_applicable'));
  const output = h.companion.processing!.outputArtifact(planId, 'scalar');
  const rows = JSON.parse(output.bytes.toString('utf8')).rows;
  assert.equal(rows.length, 2); assert.equal(rows[0].value_decimal, '12.3');
  json(join(h.root, caseId + '-actual-plan.json'), { materialId, planId, actualPlan: plan, actualRows: rows,
    materialReadModelPreview: materialRead.preview, preparedModelPreview: prepared.preview, executedModelPreview: executed.preview,
    noFabricatedOriginsOrProcessingLinks: true });
  return { materialId, planId, plan, executedModelPreview: executed.preview };
}
function assertModelView(value: unknown, f: ReturnType<typeof fixture>): void {
  const forbidden = new Set(['connection', 'previewRows', 'local', 'store', 'runtime', 'pythonPath', 'entryPath',
    'callerId', 'namespace', 'document', 'rows', 'rawError', 'error', 'localRefs', 'sourceRefs']);
  const visit = (item: unknown) => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      assert.ok(!forbidden.has(key), 'R1 model preview leaked a non-whitelisted field: ' + key); visit(child);
    }
  };
  visit(value);
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes(f.root), 'R1 model preview leaked an isolated absolute root.');
  assert.ok(!serialized.includes(productRoot), 'R1 model preview leaked the implementation root.');
  assert.ok(!serialized.includes('row-1') && !serialized.includes('12.30') && !serialized.includes('12.3'), 'R1 model preview leaked raw rows.');
}
function assertRequestPreview(value: Record<string, unknown>, f: ReturnType<typeof fixture>): void {
  assertModelView(value, f);
  const allowed = new Set(['contract', 'protocol', 'profile', 'modelSubmit', 'statusSource', 'sourceEvidenceScope',
    'requestId', 'state', 'datasetId', 'outputKey', 'planId', 'outputId', 'rowCount', 'documentSha256',
    'submitTaskId', 'requiresRecovery', 'errorCode', 'recoveryTaskId', 'recoveryTaskStatus']);
  for (const key of Object.keys(value)) assert.ok(allowed.has(key), 'R1 request preview has an unapproved field: ' + key);
  for (const key of ['requestId', 'state', 'datasetId', 'outputKey', 'planId', 'outputId', 'rowCount', 'documentSha256',
    'submitTaskId', 'requiresRecovery']) assert.ok(Object.hasOwn(value, key), 'R1 request preview lost an identity/state field: ' + key);
}
function instrumentPort(h: Host) {
  const workspace = h.companion.r1Workspace!;
  const counts = { prepare: 0, get: 0, recover: 0, checkProfile: 0, list: 0 };
  const original = new Map<string, (...args: any[]) => any>();
  for (const name of Object.keys(counts) as Array<keyof typeof counts>) {
    const method = (workspace as any)[name].bind(workspace); original.set(name, method);
    (workspace as any)[name] = (...args: any[]) => {
      counts[name]++;
      assert.notEqual(name, 'list', 'Conversation list must never consult the global workspace recent list.');
      return method(...args);
    };
  }
  return { counts, snapshot: () => ({ ...counts }), restore() { for (const [name, method] of original) (workspace as any)[name] = method; } };
}

test('F05 unsubmitted recovery preserves prepared request and never contacts Python status',
  { skip: !python ? 'Requires explicit WFD_PYTHON.' : false, timeout: 60000 }, async () => {
    const f = fixture(true), h = await host(f);
    try {
      const selected = await selectedInput(h, 'unsubmitted-recovery');
      const planned = await actualPlan(h, selected.input, selected.reference.id, 'unsubmitted-recovery');
      const prepared = await invoke(h, selected.input, 'data.r1.prepare', prepareArgs(selected.input, planned.planId));
      const requestId = String(prepared.preview.data.requestId), workspace = h.companion.r1Workspace!;
      const before = workspace.get(requestId), client = h.companion.r1Runtime!.client;
      let statuses = 0, submits = 0;
      const status = client.requestStatusPage.bind(client), submit = client.submit.bind(client);
      client.requestStatusPage = async (...args) => { statuses++; return status(...args); };
      client.submit = async (...args) => { submits++; return submit(...args); };
      try {
        await assert.rejects(async () => {
          try {
            const observed = await invoke(h, selected.input, 'data.r1.recover', { requestId }, 'unsubmitted-model-recover');
            if (observed.preview.data.recoveryTaskId) await h.companion.tasks.wait(String(observed.preview.data.recoveryTaskId));
          } catch (error) {
            assert.equal((error as { code?: string }).code, 'MODEL_ACTION_FAILED');
            assert.equal(callTask(h, selected.input, 'unsubmitted-model-recover')?.error?.code, 'R1_NOT_SUBMITTED');
            throw error;
          }
        });
        await assert.rejects(workspace.recover(requestId, 'unsubmitted-host-recover'),
          (error: unknown) => (error as { code?: string }).code === 'R1_NOT_SUBMITTED');
        assert.equal(statuses, 0); assert.equal(submits, 0);
        assert.deepEqual(workspace.get(requestId), before);
        assert.equal(before.submitTaskId, null);
      } finally {
        const after = workspace.get(requestId);
        json(join(f.root, 'unsubmitted-recovery-observation.json'), { requestId, beforeState: before.state,
          afterState: after.state, statuses, submits, submitTaskId: after.submitTaskId,
          originalDocumentPreserved: after.documentSha256 === before.documentSha256 });
      }
      // A synthetic host operator confirms the original exact digest, never a model action.
      // Rejection must leave a genuinely usable first submit, not just an unchanged local view.
      const accepted = workspace.submit(requestId, before.documentSha256);
      const completed = await h.companion.tasks.wait(accepted.id);
      assert.equal(completed.status, 'succeeded', JSON.stringify(completed));
      const associated = workspace.get(requestId);
      assert.equal(associated.state, 'associated'); assert.equal(submits, 1);
      assert.equal(associated.submitTaskId, accepted.id);
      assert.equal(associated.documentSha256, before.documentSha256);
      const associations = associated.local.associations as Array<Record<string, unknown>>;
      assert.equal(associations.length, 2);
      assert.ok(associations.every(row => row.record_id && row.record_version && row.snapshot_id));
      const replay = workspace.submit(requestId, before.documentSha256);
      assert.equal(replay.id, accepted.id); assert.equal(submits, 1);
      json(join(f.root, 'first-confirmed-submit-after-rejected-recovery.json'), {
        actualPython: true, syntheticOperator: true, modelSubmit: false, requestId,
        originalDocumentSha256: before.documentSha256, taskId: accepted.id,
        finalState: associated.state, submits, associations, replayTaskId: replay.id });
    } finally { await h.close(); }
  });

test('F05 actual Python profile response is withheld on isolated config byte drift',
  { skip: !python ? 'Requires explicitly selected WFD_PYTHON' : false, timeout: 30000 }, async () => {
    const f = fixture(true), h = await host(f);
    const workspace = h.companion.r1Workspace!, runtime = h.companion.r1Runtime!;
    const original = readFileSync(f.configPath), probe = runtime.client.probeProfile.bind(runtime.client);
    let actualProbes = 0;
    try {
      runtime.client.probeProfile = async (...args) => {
        actualProbes++; const result = await probe(...args);
        // Fault is confined to the just-created fixture config, not original runtime configuration.
        writeFileSync(f.configPath, Buffer.concat([original, Buffer.from('\n')]));
        return result;
      };
      await assert.rejects(workspace.checkProfile(),
        (error: unknown) => (error as { code?: string }).code === 'R1_CONNECTION_BINDING_CHANGED');
      assert.equal(actualProbes, 1);
      writeFileSync(f.configPath, original); runtime.client.probeProfile = probe;
      const fresh = await workspace.checkProfile(); assert.equal(fresh.supported, true);
      assert.deepEqual(readFileSync(f.configPath), original);
      json(join(f.root, 'actual-profile-config-drift.json'), { actualPython: true,
        fault: 'append newline to isolated fixture config after actual response',
        rejectedCode: 'R1_CONNECTION_BINDING_CHANGED', actualFaultProbeCalls: actualProbes,
        restoredOriginalConfigBytes: true, subsequentActualProbeSupported: fresh.supported });
    } finally {
      writeFileSync(f.configPath, original); runtime.client.probeProfile = probe; await h.close();
    }
  });

test('F05 central profile revalidates connection after awaited probe', async () => {
  const f = fixture(), h = await host(f);
  const workspace = h.companion.r1Workspace!;
  let changed = false, checks = 0;
  (workspace as any).options.runtime = {
    currentIdentity: () => { checks++; if (changed) throw Object.assign(new Error('Synthetic binding drift'), { code: 'R1_CONNECTION_RELOAD_REQUIRED' }); return {}; },
    client: { probeProfile: async () => { changed = true; return { dispatchProbeOnly: true }; } } };
  try {
    await assert.rejects(workspace.checkProfile(),
      (error: unknown) => (error as { code?: string }).code === 'R1_CONNECTION_RELOAD_REQUIRED');
    assert.equal(checks, 2);
    let revision = 1, mutate = true, valueChecks = 0;
    (workspace as any).options.runtime = {
      currentIdentity: () => { valueChecks++; return { configSha256: String(revision) }; },
      client: { probeProfile: async () => { if (mutate) revision++; return { dispatchProbeOnly: true }; } } };
    await assert.rejects(workspace.checkProfile(),
      (error: unknown) => (error as { code?: string }).code === 'R1_CONNECTION_BINDING_CHANGED');
    assert.equal(valueChecks, 2);
    mutate = false;
    const stable = await workspace.checkProfile();
    assert.deepEqual(stable, { dispatchProbeOnly: true }); assert.equal(valueChecks, 4);
    json(join(f.root, 'profile-await-binding.json'), { dispatchProbeDouble: true,
      preAndPostIdentityChecks: checks, changedBindingResultWithheld: true, switchedClient: false,
      changedIdentityValueRejected: true, stableSubsequentCheckSucceeded: true, valueIdentityChecks: valueChecks });
  } finally { await h.close(); }
});

test('F05 central profile result is withheld after STOP during probe even after resume', async () => {
  const f = fixture(), h = await host(f);
  const workspace = h.companion.r1Workspace!;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let probes = 0;
  (workspace as any).options.runtime = { currentIdentity: () => ({}),
    client: { probeProfile: async () => { probes++; await gate; return { dispatchProbeOnly: true }; } } };
  try {
    const pending = workspace.checkProfile();
    const rejected = assert.rejects(pending,
      (error: unknown) => (error as { code?: string }).code === 'BD_STOPPED');
    assert.equal(probes, 1);
    const stopped = await h.companion.tasks.stopControl('Synthetic STOP while profile probe awaits');
    h.companion.tasks.resumeControl(stopped.generation, 'Synthetic resume before stale response');
    release(); await rejected;
    await workspace.checkProfile(); assert.equal(probes, 2);
    json(join(f.root, 'profile-await-stop.json'), { controlledProbeDouble: true, realPython: false,
      stopThenResumeBeforeResponse: true, staleSuccessWithheld: true, freshProbeSucceeds: true });
  } finally { release(); await h.close(); }
});

test('processing dedicated formats cross the genuine personal tool bridge with exact selectors', { timeout: 60000 }, async () => {
  const paragraph = '本次会计差错更正仅影响营业收入和营业成本，不涉及资产负债表、现金流量表，不会导致盈亏性质改变。';
  const text = Buffer.from('更正说明。\n\n' + paragraph + '\n\n其余原文。');
  const xml = Buffer.from('<a:xbrl xmlns:a="http://www.xbrl.org/2003/instance" xmlns:g="urn:regression:gaap" xmlns:c="urn:currency"><a:context id="c"><a:entity><a:identifier scheme="urn:issuer">000001</a:identifier></a:entity><a:period><a:startDate>2024-01-01</a:startDate><a:endDate>2024-06-30</a:endDate></a:period></a:context><a:unit id="u"><a:measure>c:CNY</a:measure></a:unit><g:Revenue contextRef="c" unitRef="u" decimals="2">1234.56</g:Revenue></a:xbrl>');
  for (const format of ['text', 'xbrl'] as const) {
    const f = fixture(), h = await host(f);
    try {
      const bytes = format === 'text' ? text : xml;
      const selected = await selectedInput(h, 'dedicated-' + format, bytes, format === 'text' ? 'txt' : 'xml', inspectOnlyUserQuote);
      const read = await invoke(h, selected.input, 'material.read', { fileRefId: selected.reference.id }, 'dedicated-read-' + format);
      const materialId = String(read.preview.data.materialId), start = text.toString().indexOf(paragraph);
      const table = format === 'text' ? { materialId, format, necessaryTextSelection: { version: 'bd-necessary-business-paragraph/1', sourceSha256: wfdSha256(text),
        documentVersion: 'regression-v1', purpose: 'correction_scope', reviewBasis: '操作者核对完整原文段及全部限制条件用于本次工具桥回归', paragraphs: [{ start, end: start + paragraph.length, quote: paragraph }] } }
        : { materialId, format, xbrlSelection: { version: 'bd-xbrl-numeric/1', reportId: 'regression', reportVersion: 'v1', concepts: [] }, types: { value: 'decimal_string' } };
      const planJson = { routing: { materials: [{ materialId, intendedAction: 'inspect' }] }, outputs: [{ outputId: 'selected', materialIds: [materialId], intendedAction: 'inspect',
        usage: { purpose: 'current_compute', messageId: selected.input.messageId, quote: inspectOnlyUserQuote }, tables: [table] }] };
      const accepted = await invoke(h, selected.input, 'data.processing.plan', { planJson: JSON.stringify(planJson) }, 'dedicated-plan-' + format);
      const planId = String(accepted.preview.data.planId);
      await invoke(h, selected.input, 'data.processing.run', { planId }, 'dedicated-run-' + format);
      const plan = h.companion.processing!.get(planId); assert.equal(plan.status, 'completed', JSON.stringify(plan));
      assert.equal(plan.outputs[0]!.publishEligible, false);
      const output = JSON.parse(h.companion.processing!.outputArtifact(planId, 'selected').bytes.toString());
      assert.equal(output.rows.length, 1);
      assert.equal(format === 'text' ? output.rows[0].text : output.rows[0].value, format === 'text' ? paragraph : '1234.56');
      const caps = await invoke(h, selected.input, 'data.processing.capabilities', {}, 'dedicated-capabilities-' + format);
      assert.ok(caps.preview.data.catalog.tableInputs.dedicated[format].required.length);
      json(join(f.root, 'dedicated-bridge-proof.json'), { format, materialId, planId, actualOutput: output, genuineToolOrigin: true,
        providerInvoked: false, syntheticRegressionSource: true, published: false });
    } finally { await h.close(); }
  }
});

test('processing financial-fixed selector survives personal tool schema and normalizes fixed refs without accepting caller values',
  { skip: !python, timeout: 60000 }, async () => {
    const f = fixture(true), h = await host(f);
    try {
      const selected = await selectedInput(h, 'financial-fixed-contract');
      const read = await invoke(h, selected.input, 'material.read', { fileRefId: selected.reference.id }, 'financial-fixed-contract-read');
      const materialId = String(read.preview.data.materialId), financialCalculation = { version: 'bd-financial-fixed/1', operation: 'standardize',
        inputs: [{ snapshotId: 'explicit-test-snapshot', productId: 'explicit-test-product', businessKeys: ['explicit-test-key'] }] };
      const planJson = { routing: { materials: [{ materialId, intendedAction: 'inspect' }] }, outputs: [{ outputId: 'calculation', materialIds: [materialId],
        intendedAction: 'inspect', tables: [{ materialId, format: 'financial-fixed', financialCalculation }] }] };
      const accepted = await invoke(h, selected.input, 'data.processing.plan', { planJson: JSON.stringify(planJson) }, 'financial-fixed-contract-plan');
      const planId = String(accepted.preview.data.planId), plan = h.companion.processing!.get(planId);
      assert.deepEqual(plan.steps[0]!.parameters.financialCalculation, financialCalculation);
      assert.equal(typeof plan.steps[0]!.parameters.financialReaderBinding, 'string');
      assert.equal(plan.steps[0]!.state, 'pending'); // Contract acceptance only; these regression references do not assert existing financial rows.
      const invalid = structuredClone(planJson) as any; invalid.outputs[0].tables[0].financialCalculation.value = '999';
      await failure(h, selected.input, 'data.processing.plan', { planJson: JSON.stringify(invalid) }, 'FINANCIAL_FIXED', 'financial-fixed-no-caller-value');
      json(join(f.root, 'financial-fixed-contract-proof.json'), { planId, financialCalculation, normalized: plan.steps[0]!.parameters.financialCalculation,
        trustedReaderBound: true, genuineToolOrigin: true, executionAttempted: false, providerInvoked: false, published: false });
    } finally { await h.close(); }
  });

test('F05 R1 UI invalidates confirmation on detail loads and gates recovery on original submission', () => {
  const source = readFileSync(join(codeRoot, 'apps/web/src/ui/R1Panel.tsx'), 'utf8');
  const show = /const showView = \(current: R1RequestView\) => \{([\s\S]*?)\n  \};/u.exec(source);
  assert.ok(show);
  assert.ok(show[1]!.includes('setConfirmed(false)'), 'Every detail load must invalidate prior human confirmation.');
  const recoveryButton = source.split(String.fromCharCode(10)).find(line =>
    line.includes('r1Api.recover(view.requestId') && line.includes('disabled={busy || !ready || !view.submitTaskId ||'));
  assert.ok(recoveryButton, 'Unsubmitted requests must not offer external recovery.');
  for (const terminal of ['associated', 'partially_associated', 'conflicts_pending', 'rejected'])
    assert.ok(recoveryButton.includes("'" + terminal + "'"), 'Terminal state ' + terminal + ' must not offer redundant recovery.');
});

test('F05 R1 version manifest covers authority-bearing connection dependencies', () => {
  // Static contract only. Runtime loaded-byte drift and task-version checks are separate gates.
  const source = readFileSync(join(codeRoot, 'platform/plugins/direct-versions.ts'), 'utf8');
  const group = /\br1:\s*\[([\s\S]*?)\],/u.exec(source);
  assert.ok(group, 'R1 explicit implementation group must exist.');
  for (const path of ['modules/financial/product-machine-connection.ts', 'platform/config/connections.ts',
    'platform/resources/bindings.ts', 'modules/collection/r1-paged-readback.ts']) {
    assert.ok(group[1]!.includes("'" + path + "'"), 'R1 version manifest missing ' + path);
  }
});

test('F05 central profile check honors companion STOP before external probe', async () => {
  const f = fixture(), h = await host(f);
  const workspace = h.companion.r1Workspace!;
  let probes = 0;
  // Narrow dispatch spy: no Python, network, publication or fabricated business receipt.
  (workspace as any).options.runtime = { currentIdentity: () => ({}),
    client: { probeProfile: async () => { probes++; return { syntheticDispatchProbe: true }; } } };
  try {
    const stopped = await h.companion.tasks.stopControl('Synthetic central profile STOP');
    await assert.rejects(workspace.checkProfile(),
      (error: unknown) => (error as { code?: string }).code === 'BD_STOPPED');
    assert.equal(probes, 0);
    h.companion.tasks.resumeControl(stopped.generation, 'Synthetic explicit resume');
    await workspace.checkProfile(); assert.equal(probes, 1);
    json(join(f.root, 'profile-stop-dispatch.json'), { dispatchSpyOnly: true, realPython: false,
      stoppedProbeCalls: 0, resumedProbeCalls: probes });
  } finally { await h.close(); }
});

test('F05 R1 direct task refuses changed host version before workspace dispatch', async () => {
  const f = fixture(), h = await host(f);
  const workspace = h.companion.r1Workspace!;
  const descriptor = Object.getOwnPropertyDescriptor(workspace, 'versionBinding');
  try {
    const original = workspace.versionBinding;
    const versions = h.services.direct.registry.captureVersions('data.r1.capabilities', {});
    const task = h.services.tasks.create({ title: 'Synthetic version fault probe', ownerRole: 'personal',
      runtimeId: 'direct', action: 'data.r1.capabilities', requestId: 'r1-version-fault-test', args: {}, versions });
    Object.defineProperty(workspace, 'versionBinding', { configurable: true, get: () => ({ ...original, r1Workspace: 'metadata-fault-version' }) });
    const started = await h.services.tasks.start(task.id, task.version);
    const final = await h.services.tasks.wait(started.id);
    assert.equal(final.status, 'failed'); assert.equal(final.error?.code, 'DIRECT_VERSION_CONFLICT');
    assert.equal(Number(h.companionDatabase.connection.prepare('SELECT count(*) n FROM r1_workspace_requests').get()!.n), 0);
    json(join(f.root, 'version-guard-observation.json'), { fault: 'host version metadata only', taskId: final.id,
      status: final.status, code: final.error?.code, publicationReceiptMocked: false });
  } finally {
    if (descriptor) Object.defineProperty(workspace, 'versionBinding', descriptor);
    else Reflect.deleteProperty(workspace, 'versionBinding');
    await h.close();
  }
});

// Primary gate uses the actual application assembly + actual toolFactory/list_actions/perform_action.
// Do not import r1-routes.test.ts: importing it would auto-register unrelated legacy test cases.
test('F05 actual personal+companion catalogue exposes exactly six R1 actions, never model submit', { timeout: 30000 }, async () => {
  const f = fixture(), h = await host(f);
  try {
    assert.ok(h.companion.materials && h.companion.processing && h.companion.r1Workspace,
      'Companion must be the real material/processing/R1 workspace assembly.');
    const accepted = h.core.sendMessage(h.core.defaultConversationId, '请先查看本会话可用的 R1 能力；本轮不提交。', 'r1-catalogue-user-input');
    const input = await h.backend.waitForInput(accepted.commandId);
    assert.equal(h.core.isRunActive(input.runId, input.generation), true);
    const factory: PiToolFactoryContext = { model, getCurrentInput: () => input };
    const tools = h.services.modelTools.toolFactory(factory);
    const catalogue = tools.find(tool => tool.name === 'list_actions'), perform = tools.find(tool => tool.name === 'perform_action');
    assert.ok(catalogue && perform, 'Personal toolFactory must expose the actual discovery and dispatch tools.');
    assert.match(catalogue.description, /去首尾空白.*不区分大小写的整段子串.*不按空格拆词/);
    const web = resultValue(await catalogue.execute('r1-catalogue-web-query', { query: ' WEB ', limit: 20 }, undefined, undefined, unusedPiContext));
    assert.equal(web.query, 'web');
    assert.ok(web.total >= 2);
    assert.ok(web.actions.some((action: { action: string }) => action.action === 'web.read_public'));
    assert.match(web.scope, /去首尾空白.*不区分大小写的整段子串.*不按空格拆词.*规范化值.*total.*done.*当前query/);
    const unmatched = resultValue(await catalogue.execute('r1-catalogue-unmatched-query',
      { query: '文件 读取 本地' }, undefined, undefined, unusedPiContext));
    assert.equal(unmatched.query, '文件 读取 本地');
    assert.equal(unmatched.total, 0); assert.deepEqual(unmatched.actions, []);
    assert.equal(unmatched.done, true); assert.equal(unmatched.nextOffset, null);
    assert.match(unmatched.scope, /短关键字.*空query.*nextOffset/);
    const unfiltered = resultValue(await catalogue.execute('r1-catalogue-unfiltered-page',
      { limit: 1 }, undefined, undefined, unusedPiContext));
    assert.equal(unfiltered.query, '');
    assert.ok(unfiltered.total > web.total);
    assert.equal(unfiltered.actions.length, 1); assert.equal(unfiltered.nextOffset, 1); assert.equal(unfiltered.done, false);
    const registry = h.services.direct.registry, actualList = registry.list.bind(registry);
    const first = registry.get('web.read_public'), large = registry.get('web.search');
    registry.list = () => [first, { ...large, description: 'z'.repeat(22_000) }];
    try {
      const nearLimit = resultValue(await catalogue.execute('r1-catalogue-near-limit',
        { limit: 20 }, undefined, undefined, unusedPiContext));
      assert.ok(Buffer.byteLength(JSON.stringify(nearLimit), 'utf8') <= 23_000,
        'The full catalogue receipt must fit the original 23 KB page budget.');
      assert.equal(nearLimit.actions.length, 1);
      assert.equal(nearLimit.nextOffset, 1); assert.equal(nearLimit.done, false);
      const lastPage = resultValue(await catalogue.execute('r1-catalogue-near-limit-next',
        { offset: 1, limit: 20 }, undefined, undefined, unusedPiContext));
      assert.equal(lastPage.actions.length, 1); assert.equal(lastPage.nextOffset, null); assert.equal(lastPage.done, true);
      assert.ok(Buffer.byteLength(JSON.stringify(lastPage), 'utf8') <= 23_000);
      const combinedActions = [...nearLimit.actions, ...lastPage.actions];
      assert.deepEqual(combinedActions.map(action => action.action), ['web.read_public', 'web.search'],
        '每页须独立符合预算，跨页不得丢失或重复动作；合并页不承担单页字节限制。');
      assert.equal(new Set(combinedActions.map(action => action.action)).size, combinedActions.length);
      assert.ok(Buffer.byteLength(JSON.stringify(nearLimit), 'utf8') <= 23_000);
      assert.ok(Buffer.byteLength(JSON.stringify(lastPage), 'utf8') <= 23_000);
    } finally { registry.list = actualList; }
    const listed = resultValue(await catalogue.execute('r1-catalogue-discovery', { query: 'data.r1.', limit: 20 }, undefined, undefined, unusedPiContext));
    const present = (listed.actions as Array<{ action: string }>).map(action => action.action).sort();
    let dispatched: unknown = null, dispatchError: { code: string | null; message: string } | null = null;
    try { dispatched = resultValue(await perform.execute('r1-catalogue-capabilities', { action: 'data.r1.capabilities', args: {} }, undefined, undefined, unusedPiContext)); }
    catch (error) { dispatchError = { code: (error as { code?: string }).code ?? null, message: String((error as Error).message) }; }
    const observation = { assembly: 'createApplicationServices personal + actual materials companion',
      actualToolFactory: true, actualCoreInput: input, noProviderOrNetwork: true,
      listed, expectedActions: [...r1Actions].sort(), present, missing: r1Actions.filter(action => !present.includes(action)),
      dispatched, dispatchError, syntheticTransportDoubleOnly: true };
    json(join(f.root, 'catalogue-observation.json'), observation);
    console.log('F05_CATALOGUE_OBSERVATION', JSON.stringify(observation));
    assert.deepEqual(present, [...r1Actions].sort(), 'Actual personal catalogue must expose the frozen R1 action set.');
    assert.equal(dispatchError, null, 'Actual perform_action(data.r1.capabilities) must dispatch.');
    assert.equal((dispatched as { data?: { submitByAgent?: string } } | null)?.data?.submitByAgent,
      'disabled_host_user_only', '正常模型回执不得暗示 AGENTS 能提交 R1');
    assert.ok(!present.includes('data.r1.submit'));
    const prepare = (listed.actions as Array<{ action: string; fields: Array<{ key: string }> }>).find(action => action.action === 'data.r1.prepare');
    assert.deepEqual(prepare?.fields.map(field => field.key).sort(), ['outputId', 'planId', 'sourceEvidenceJson', 'sourceJson']);
    await failure(h, input, 'data.r1.submit', {}, null, 'r1-forbidden-model-submit', 'MODEL_ACTION_NOT_ALLOWED');
    await failure(h, input, 'data.r1.get', { requestId: 'not-present', connection: 'model-selected' }, null,
      'r1-forbidden-unknown-field', 'MODEL_ARGS_INVALID');
  } finally { await h.close(); }
});

test('F05 actual attachment → material.read → processing.plan/run keeps genuine input and plan origins', { timeout: 60000 }, async () => {
  const f = fixture(), h = await host(f);
  try {
    const selected = await selectedInput(h, 'processing-origin');
    const guidance = h.services.modelContext(selected.input);
    assert.match(guidance, /material\.process仅保存语义判断和受控清洗，不是五步处理文件产物/u);
    assert.match(guidance, /继续加工或形成可流转处理产物.*data\.processing\.capabilities/u);
    assert.match(guidance, /应用受控产物区.*无需另找个人目录/u);
    assert.match(guidance, /material\.ocr.*不等于.*image\.ocr/u);
    assert.match(guidance, /material\.transcribe.*不等于.*audio\.transcribe/u);
    const planned = await actualPlan(h, selected.input, selected.reference.id, 'processing-origin');
    const structureStep = planned.plan.steps.find(step => step.kind === 'structure')!;
    const normalization = structureStep.normalization as { clean_changes_total: number; type_changes_total: number;
      decimal_lexeme_changes_total: number; type_changes: { before: string; after: string }[] } | null;
    assert.equal(normalization?.clean_changes_total, 0);
    assert.equal(normalization?.type_changes_total, 2);
    assert.equal(normalization?.decimal_lexeme_changes_total, 2);
    assert.equal(structureStep.normalization?.type_changes_sample_count, 2);
    assert.equal(structureStep.normalization?.type_changes_truncated, false);
    assert.deepEqual(normalization?.type_changes.map(change => [change.before, change.after]),
      [['12.30', '12.3'], ['13.40', '13.4']]);
    const modelStructureStep = planned.executedModelPreview.data.steps.find((step: { kind: string }) => step.kind === 'structure');
    assert.equal(modelStructureStep?.normalization?.decimal_lexeme_changes_total, 2);
    h.companionDatabase.connection.prepare('UPDATE processing_plan_steps SET normalization_json=NULL WHERE plan_id=? AND step_id=?')
      .run(planned.planId, structureStep.stepId);
    const oldStep = h.companion.processing!.get(planned.planId).steps.find(step => step.kind === 'structure')!;
    assert.equal(oldStep.normalization?.state, 'not_recorded');
    assert.equal(oldStep.normalization?.type_changes_total, null);
    const oldStatus = await invoke(h, selected.input, 'data.processing.status', { planId: planned.planId }, 'processing-origin-old-metadata-status');
    const oldModelStep = oldStatus.preview.data.steps.find((step: { kind: string }) => step.kind === 'structure');
    assert.equal(oldModelStep?.normalization?.state, 'not_recorded');
    assert.equal(oldModelStep?.normalization?.decimal_lexeme_changes_total, null);
    assert.deepEqual(planned.plan.outputs[0]!.target?.declaration, { protocol: 'wfd.structured-ingest/1.0', target, mapping });
    assert.equal(Number(h.companionDatabase.connection.prepare('SELECT count(*) n FROM r1_workspace_requests').get()!.n), 0);
    const saved = h.database.connection.prepare("SELECT origin_json FROM conversation_processing_links WHERE ref_id=? AND kind='plan'").get(planned.planId);
    assert.ok(saved);
    const origin = JSON.parse(String(saved.origin_json));
    assert.equal(origin.messageId, selected.input.messageId); assert.equal(origin.branchId, selected.input.branchId);
    const call = h.database.connection.prepare('SELECT tool_call_id,task_id FROM model_tool_calls WHERE id=?').get(origin.callId);
    assert.equal(call?.tool_call_id, 'processing-origin-processing-plan');
    assert.equal(h.services.tasks.get(String(call!.task_id)).status, 'succeeded');
    json(join(f.root, 'actual-origin-summary.json'), { actualPublicCoreInput: selected.input, materialId: planned.materialId,
      planId: planned.planId, genuineTaskOrigin: origin, syntheticInputOnly: true, fakeToolCalls: false, fakeProcessingLinks: false,
      r1Prepared: false, pythonInvoked: false, providerInvoked: false });
  } finally { await h.close(); }
});

test('processing structure summary keeps counts when a real changed cell is too large for model evidence', { timeout: 60000 }, async () => {
  const f = fixture(), h = await host(f);
  try {
    const originalValue = ' '.repeat(100_000) + '31.0';
    const selected = await selectedInput(h, 'large-normalization', Buffer.from(`value\n${originalValue}\n`), 'csv', inspectOnlyUserQuote);
    const read = await invoke(h, selected.input, 'material.read', { fileRefId: selected.reference.id }, 'large-normalization-read');
    const materialId = String(read.preview.data.materialId);
    const planJson = { routing: { materials: [{ materialId, intendedAction: 'inspect' }] }, outputs: [{ outputId: 'large', materialIds: [materialId],
      intendedAction: 'inspect', usage: { purpose: 'current_compute', messageId: selected.input.messageId, quote: inspectOnlyUserQuote },
      tables: [{ materialId, format: 'csv', trim: ['value'], types: { value: 'decimal_string' } }] }] };
    const prepared = await invoke(h, selected.input, 'data.processing.plan', { planJson: JSON.stringify(planJson) }, 'large-normalization-plan');
    const planId = String(prepared.preview.data.planId);
    await invoke(h, selected.input, 'data.processing.run', { planId }, 'large-normalization-run');
    const plan = h.companion.processing!.get(planId);
    const structure = plan.steps.find(step => step.kind === 'structure')!;
    assert.equal(structure.state, 'succeeded', JSON.stringify(structure.error));
    const artifact = JSON.parse(h.companion.processing!.artifact(planId, structure.stepId).bytes.toString('utf8'));
    assert.equal(artifact.type_changes_total, 1);
    assert.equal(artifact.type_changes[0].original, originalValue);
    assert.equal(artifact.type_changes[0].after, '31');
    const saved = h.companionDatabase.connection.prepare('SELECT normalization_json FROM processing_plan_steps WHERE plan_id=? AND step_id=?')
      .get(planId, structure.stepId);
    assert.ok(saved?.normalization_json);
    assert.ok(Buffer.byteLength(String(saved.normalization_json), 'utf8') <= 4096);
    assert.equal(structure.normalization?.type_changes_total, 1);
    assert.equal(structure.normalization?.decimal_lexeme_changes_total, 1);
    assert.deepEqual(structure.normalization?.type_changes, []);
    assert.equal(structure.normalization?.type_changes_sample_count, 0);
    assert.equal(structure.normalization?.type_changes_truncated, true);
    assert.equal(JSON.parse(h.companion.processing!.outputArtifact(planId, 'large').bytes.toString('utf8')).rows[0].value, '31');
  } finally { await h.close(); }
});

test('processing model preview compacts by UTF-8 bytes and keeps normalization counts', () => {
  const bridge = Object.create(ConversationProcessingBridge.prototype) as { planPreview(found: unknown): any };
  const normalization = { state: 'recorded', scope: 'structure_type_changes', clean_changes_total: 0,
    type_changes_total: 1, decimal_lexeme_changes_total: 1, type_changes: [{ before: '31.0', after: '31' }] };
  const step = { stepId: 'structure:large:0', outputId: 'large', kind: 'structure', state: 'succeeded', normalization };
  const preview = bridge.planPreview({ planId: 'test-plan', status: 'completed', materials: [],
    outputs: [{ outputId: 'large', steps: [{ ...step, parameters: { note: '中'.repeat(8000) } }] }], steps: [step] });
  assert.ok(Buffer.byteLength(JSON.stringify(preview), 'utf8') < 22000);
  assert.equal(preview.steps[0].normalization.type_changes_total, 1);
  assert.equal(preview.steps[0].normalization.scope, 'structure_type_changes');
  assert.equal(preview.steps[0].normalization.type_changes_sample_count, 0);
  assert.equal(preview.outputs[0].steps[0].parameters, undefined);
  assert.equal(preview.outputs[0].steps[0].normalization.type_changes_total, 1);
});

test('F05 processing capability contract and bounded failure receipt use real selected tasks', { timeout: 60000 }, async () => {
  const f = fixture(), h = await host(f);
  try {
    const selected = await selectedInput(h, 'processing-contract');
    const read = await invoke(h, selected.input, 'material.read', { fileRefId: selected.reference.id }, 'processing-contract-material-read');
    const materialId = String(read.preview.data.materialId);
    const wrongBinding = 'processing-contract-material-binding';
    await failure(h, selected.input, 'material.process', { fileRefId: selected.reference.id, materialId,
      proposalJson: JSON.stringify({ materialId, originalSha256: '0'.repeat(64) }) },
      'MATERIAL_BINDING_MISMATCH', wrongBinding);
    const bindingError = projectedFailure(h, selected.input, wrongBinding);
    assert.equal(bindingError.code, 'MATERIAL_BINDING_MISMATCH');
    assert.match(bindingError.message, /materialId.*originalSha256/u);
    assert.match(bindingError.message, /重新执行 material\.read/u);
    assert.ok(!JSON.stringify(bindingError).includes('0'.repeat(64)));
    const invalidJson = 'processing-contract-material-json';
    await failure(h, selected.input, 'material.process', { fileRefId: selected.reference.id, materialId,
      proposalJson: '{/private/secret marker' }, 'MATERIAL_PROPOSAL_INVALID', invalidJson);
    const jsonError = projectedFailure(h, selected.input, invalidJson);
    assert.equal(jsonError.code, 'MATERIAL_PROPOSAL_INVALID');
    assert.match(jsonError.message, /material\.read/u);
    assert.ok(!JSON.stringify(jsonError).includes('/private/secret'));
    const caps = await invoke(h, selected.input, 'data.processing.capabilities', {}, 'processing-contract-capabilities');
    const contract = caps.preview.data.inputContract;
    assert.deepEqual(contract.dimensionsJson.allowedKeys, DIMENSION_KEYS);
    assert.deepEqual(contract.evidence.material.required, ['source', 'materialId', 'quote']);
    assert.deepEqual(contract.evidence.userMessage.required, ['source', 'messageId', 'quote']);
    assert.deepEqual(contract.planJson.rootKeys, ['routing', 'outputs']);
    const example = contract.dimensionsJson.example;
    assert.ok(Object.keys(example).every(key => DIMENSION_KEYS.includes(key as typeof DIMENSION_KEYS[number])));
    const demonstrated = await invoke(h, selected.input, 'data.processing.route',
      { materialId, dimensionsJson: JSON.stringify(example), intendedAction: 'inspect' }, 'processing-contract-valid-example');
    assert.equal(demonstrated.preview.ok, true);

    const missingSource = 'processing-contract-missing-source';
    await failure(h, selected.input, 'data.processing.route', { materialId, dimensionsJson: JSON.stringify({
      role: { status: 'known', value: 'CSV', evidence: [{ materialId, quote: 'business_key,value_decimal,start_utc,end_utc' }] },
    }), intendedAction: 'inspect' }, 'PROCESSING_EVIDENCE', missingSource);
    const processingError = projectedFailure(h, selected.input, missingSource);
    assert.equal(processingError.code, 'PROCESSING_EVIDENCE');
    assert.match(processingError.message, /source.*material.*user-message/u);
    assert.ok(!JSON.stringify(processingError).includes('/private/secret'));

    const wrappedDimensions = 'processing-contract-wrapped-dimensions';
    await failure(h, selected.input, 'data.processing.route', { materialId,
      dimensionsJson: JSON.stringify({ dimensions: example }), intendedAction: 'inspect' }, 'PROCESSING_DIMENSIONS', wrappedDimensions);
    const dimensionError = projectedFailure(h, selected.input, wrappedDimensions);
    assert.equal(dimensionError.code, 'PROCESSING_DIMENSIONS');
    assert.match(dimensionError.message, /role.*structureGranularity/u);

    const fileTooLarge = 'processing-contract-file-limit';
    await failure(h, selected.input, 'file.read', { fileRefId: selected.reference.id, maxBytes: 1 }, 'FILE_TOO_LARGE', fileTooLarge);
    const fileError = projectedFailure(h, selected.input, fileTooLarge);
    assert.equal(fileError.code, 'FILE_TOO_LARGE');
    assert.match(fileError.message, /读取上限/u);
    assert.ok(!JSON.stringify(fileError).includes(f.root));

    const unknown = 'processing-contract-unlisted-error';
    await failure(h, selected.input, 'data.processing.route', { materialId: 'foreign-material-id' }, 'PROCESSING_MATERIAL_ORIGIN', unknown);
    const generic = projectedFailure(h, selected.input, unknown);
    assert.equal(generic.code, 'MODEL_ACTION_FAILED');
    assert.ok(!JSON.stringify(generic).includes('foreign-material-id'));
  } finally { await h.close(); }
});

test('F05 processing conversation operator evidence cannot self-authorize purpose', { timeout: 60000 }, async () => {
  const f = fixture(), h = await host(f);
  try {
    const selected = await selectedInput(h, 'processing-evidence');
    const read = await invoke(h, selected.input, 'material.read', { fileRefId: selected.reference.id }, 'processing-evidence-material-read');
    const materialId = String(read.preview.data.materialId);
    const quote = `purpose=${routingFacts.purpose}`;
    await failure(h, selected.input, 'data.processing.route', { materialId, dimensionsJson: JSON.stringify({
      purpose: { status: 'known', value: routingFacts.purpose, evidence: [{ source: 'operator', field: 'purpose', quote }] },
    }), intendedAction: 'inspect' }, 'PROCESSING_EVIDENCE_UNTRUSTED', 'processing-evidence-forged-operator');
    const realMessage = await invoke(h, selected.input, 'data.processing.route', { materialId, dimensionsJson: JSON.stringify({
      purpose: { status: 'known', value: routingFacts.purpose,
        evidence: [{ source: 'user-message', messageId: selected.input.messageId, quote }] },
    }), intendedAction: 'inspect' }, 'processing-evidence-real-user');
    assert.equal(realMessage.preview.ok, true);
    const http = h.companion.processing!.decideMaterial({ materialId, dimensions: {
      purpose: { status: 'known', value: 'isolated operator inspect', evidence: [{ source: 'operator', field: 'purpose', quote: 'isolated operator inspect' }] },
    }, intendedAction: 'inspect' }, { operatorId: 'isolated-http-operator', requestId: 'isolated-http-purpose',
      method: 'POST', path: '/isolated/processing', remoteAddress: null, observedAt: Date.now(), source: 'operator-http' });
    assert.equal((await h.companion.tasks.wait(http.id)).status, 'succeeded');
  } finally { await h.close(); }
});

test('F05 actual personal R1 prepare → host-confirmed real Python publish with lost receipt → restart recovery never resubmits',
  { skip: !python ? 'Requires explicit WFD_PYTHON; no interpreter/locator discovery.' : false, timeout: 180000 }, async () => {
    const f = fixture(true); let h = await host(f);
    let submitCalls = 0, preparedRequestId = '', originalTaskId = '';
    try {
      const selected = await selectedInput(h, 'python-recovery');
      const planned = await actualPlan(h, selected.input, selected.reference.id, 'python-recovery');
      assert.ok(h.companion.r1Runtime, JSON.stringify(h.companion.r1Configuration));
      const client = h.companion.r1Runtime.client, submit = client.submit.bind(client), probeProfile = client.probeProfile.bind(client);
      let profileChecks = 0;
      client.probeProfile = async (...args) => { profileChecks++; return probeProfile(...args); };
      client.submit = async (...args) => {
        submitCalls++;
        const actual = await submit(...args);
        json(join(f.root, 'actual-python-published-before-receipt-loss.json'), actual);
        assert.equal(actual.result.state, 'published_formal', JSON.stringify(actual.result));
        throw new WfdProductMachineError('TEST_LOST_RECEIPT', 'Injected only after actual Python published the real request.',
          { operation: 'submit', requestId: 'fault-injection', mayHaveBeenAccepted: true });
      };
      const caps = await invoke(h, selected.input, 'data.r1.capabilities', {}, 'python-r1-capabilities');
      assertModelView(caps.preview.data, f); assert.equal(profileChecks, 0, 'Discovery must not call the live Python profile.');
      const checked = await invoke(h, selected.input, 'data.r1.check', {}, 'python-r1-explicit-check');
      assertModelView(checked.preview.data, f); assert.equal(checked.preview.data.checked, true); assert.equal(profileChecks, 1);
      const prepared = await invoke(h, selected.input, 'data.r1.prepare', prepareArgs(selected.input, planned.planId), 'python-r1-prepare');
      assertRequestPreview(prepared.preview.data, f);
      assert.equal(prepared.preview.data.sourceEvidenceScope, 'verified_user_statement_only');
      assert.equal(profileChecks, 1, 'Prepare must stay local and must not silently probe or submit.');
      preparedRequestId = String(prepared.preview.data.requestId);
      assert.ok(preparedRequestId && preparedRequestId !== 'undefined', JSON.stringify(prepared.preview));
      const fixed = h.companion.r1Workspace!.get(preparedRequestId);
      assert.equal(fixed.rowCount, 2); assert.equal(fixed.submitTaskId, null); assert.equal(submitCalls, 0);
      assert.equal(fixed.planId, planned.planId); assert.deepEqual(fixed.connection.profile, 'data_only');
      const replay = await invoke(h, selected.input, 'data.r1.prepare', prepareArgs(selected.input, planned.planId), 'python-r1-prepare');
      assert.equal(replay.preview.taskId, prepared.preview.taskId, 'Same toolCall must reuse its actual local task.');
      const repeated = await invoke(h, selected.input, 'data.r1.prepare', prepareArgs(selected.input, planned.planId), 'python-r1-prepare-again');
      assert.equal(repeated.preview.data.requestId, preparedRequestId); assert.equal(submitCalls, 0);
      const firstGet = await invoke(h, selected.input, 'data.r1.get', { requestId: preparedRequestId }, 'python-r1-get-prepared');
      assertRequestPreview(firstGet.preview.data, f); assert.equal(firstGet.preview.data.submitTaskId, null);
      // Existing host-only confirmation path. No model action can reach submit, even knowing the digest.
      json(join(f.root, 'host-user-confirmation.json'), { actor: 'explicit synthetic test operator',
        entry: 'existing R1Workspace.submit host-user path, not a model action', requestId: preparedRequestId,
        confirmationDigest: fixed.documentSha256 });
      const accepted = h.companion.r1Workspace!.submit(preparedRequestId, fixed.documentSha256);
      originalTaskId = accepted.id;
      const lost = await h.companion.tasks.wait(accepted.id);
      assert.equal(lost.status, 'needs_review', JSON.stringify(lost)); assert.equal(submitCalls, 1);
      const pending = h.companion.r1Workspace!.get(preparedRequestId);
      assert.equal(pending.state, 'pending_unknown'); assert.equal(pending.submitTaskId, originalTaskId);
      assert.equal(h.companion.r1Workspace!.submit(preparedRequestId, fixed.documentSha256).id, originalTaskId);
      assert.equal(submitCalls, 1);
      const pendingModel = await invoke(h, selected.input, 'data.r1.get', { requestId: preparedRequestId }, 'python-r1-get-pending');
      assert.equal(pendingModel.preview.data.state, 'pending_unknown'); assertModelView(pendingModel.preview.data, f);
      const originalConversation = selected.input.conversationId, originalBranch = selected.input.branchId;
      await h.close(); h = await host(f);
      h.companion.r1Runtime!.client.submit = async () => { submitCalls++; throw new Error('Restart recovery attempted a forbidden resubmit.'); };
      const resumedInput = await startInput(h, '请沿原request、原任务和原连接核对结果，不重新提交。', 'python-recovery-user-resume',
        { conversationId: originalConversation });
      assert.equal(resumedInput.branchId, originalBranch);
      const restored = await invoke(h, resumedInput, 'data.r1.get', { requestId: preparedRequestId }, 'python-r1-restored-get');
      assert.equal(restored.preview.data.state, 'pending_unknown'); assert.equal(restored.preview.data.submitTaskId, originalTaskId);
      const recovered = await invoke(h, resumedInput, 'data.r1.recover', { requestId: preparedRequestId }, 'python-r1-recover-original');
      assertModelView(recovered.preview.data, f);
      const associated = h.companion.r1Workspace!.get(preparedRequestId);
      assert.equal(associated.state, 'associated'); assert.equal(associated.submitTaskId, originalTaskId);
      assert.equal(h.companion.tasks.get(originalTaskId).status, 'succeeded'); assert.equal(submitCalls, 1);
      assert.equal(associated.documentSha256, fixed.documentSha256); assert.deepEqual(associated.connection, fixed.connection);
      const associations = associated.local.associations as Array<Record<string, unknown>>;
      assert.equal(associations.length, 2);
      assert.ok(associations.every(row => row.record_id && row.record_version && row.snapshot_id));
      assert.equal(new Set(associations.map(row => row.snapshot_id)).size, 1);
      const finalModel = await invoke(h, resumedInput, 'data.r1.get', { requestId: preparedRequestId }, 'python-r1-associated-get');
      assert.equal(finalModel.preview.data.state, 'associated'); assertModelView(finalModel.preview.data, f);
      const driftResults: Array<{ resource: string; taskCode: string; submitCalls: number }> = [];
      for (const [name, path] of [['config', f.configPath], ['entry', f.entryPath], ['schema', f.schemaPath]] as const) {
        const original = readFileSync(path);
        try {
          writeFileSync(path, Buffer.concat([original, Buffer.from(name === 'entry' ? '\n# isolated binding drift\n' : '\n ')]));
          await failure(h, resumedInput, 'data.r1.recover', { requestId: preparedRequestId }, 'R1_CONNECTION_BINDING_CHANGED', 'python-r1-drift-' + name);
          assert.equal(submitCalls, 1);
          driftResults.push({ resource: name, taskCode: 'R1_CONNECTION_BINDING_CHANGED', submitCalls });
        } finally { writeFileSync(path, original); }
      }
      json(join(f.root, 'actual-python-recovery-summary.json'), { syntheticInput: true, actualCreateApplicationServices: true,
        primaryEntry: 'actual modelTools.toolFactory/perform_action', noProviderOrNetwork: true,
        transportDoubleOnly: 'Backend input capture + disconnect after actual Python publish', mockedPublicationReceipt: false,
        requestId: preparedRequestId, originalTaskId, recoveredTaskId: associated.submitTaskId, submitCalls,
        sourceEvidence: evidenceFor(selected.input), documentSha256: associated.documentSha256,
        connectionUnchanged: true, associations, driftResults, modelRecoveryPreview: recovered.preview,
        python, bytecodeReadPrefix: process.env.PYTHONPYCACHEPREFIX, productionAcceptance: false });
      // Transparent scheduling fault: hold the actual original-request recovery result, never invent a receipt.
      const workspace = h.companion.r1Workspace!, realRecover = workspace.recover.bind(workspace), realGet = workspace.get.bind(workspace);
      let release!: () => void, entered!: () => void, readsAfterGate = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const reached = new Promise<void>(resolve => { entered = resolve; });
      workspace.recover = async (...args) => {
        const actualTask = await realRecover(...args);
        await h.companion.tasks.wait(actualTask.id);
        entered(); await gate; return actualTask;
      };
      let waiting: ReturnType<typeof invoke> | undefined;
      try {
        waiting = invoke(h, resumedInput, 'data.r1.recover', { requestId: preparedRequestId }, 'python-r1-abort-await');
        // Install a handler before cancellation; the parent task may settle while Core.abort completes.
        const outcome = waiting.then(value => ({ value, error: null }), error => ({ value: null, error }));
        await reached;
        workspace.get = (...args) => { readsAfterGate++; return realGet(...args); };
        await h.core.abort(resumedInput.runId, resumedInput.conversationId);
        release(); const stopped = await outcome;
        assert.ok(stopped.error, 'Stopped parent must not share a completed service result.');
        assert.equal(readsAfterGate, 0); assert.equal(submitCalls, 1);
        assert.equal(realGet(preparedRequestId).state, 'associated');
        json(join(f.root, 'actual-await-stop-summary.json'), { schedulingFaultOnly: true, realPythonReceipt: true,
          stoppedModelCode: (stopped.error as { code?: string }).code, readsAfterGate, submitCalls,
          originalTaskId, requestId: preparedRequestId, originalAssociationPreserved: true });
      } finally { release(); workspace.recover = realRecover; workspace.get = realGet; }
      console.log('F05_ACTUAL_PYTHON_RECOVERY', JSON.stringify({ root: f.root, requestId: preparedRequestId, originalTaskId,
        recoveredTaskId: associated.submitTaskId, submitCalls, associations: associations.length, driftChecks: driftResults.length }));
    } finally { await h.close(); }
  });

test('F05 actual R1 rejects unproven source, cross-scope and non-ancestor plans before workspace calls; scoped paging, STOP and share guards',
  { skip: !python ? 'Requires explicit WFD_PYTHON for the real prepared-request fixture.' : false, timeout: 180000 }, async () => {
    const f = fixture(true), h = await host(f);
    const port = instrumentPort(h);
    const checks: string[] = [];
    try {
      const selected = await selectedInput(h, 'scope-source');
      const planned = await actualPlan(h, selected.input, selected.reference.id, 'scope-first');
      const validArgs = prepareArgs(selected.input, planned.planId);
      const rejectBeforePort = async (input: BackendInput, action: string, args: Record<string, unknown>,
        expectedTaskCode: string | null, id: string, expectedModelCode?: string) => {
        const before = port.snapshot();
        await failure(h, input, action, args, expectedTaskCode, id, expectedModelCode);
        assert.deepEqual(port.snapshot(), before, 'Rejected input must not reach any workspace method: ' + id);
        checks.push(id);
      };
      const missing = evidenceFor(selected.input); delete missing.license;
      await rejectBeforePort(selected.input, 'data.r1.prepare', { ...validArgs, sourceEvidenceJson: JSON.stringify(missing) },
        'R1_SOURCE_EVIDENCE', 'scope-missing-source-field-evidence');
      const missingAuthorizationProof = evidenceFor(selected.input); delete missingAuthorizationProof.authorization;
      await rejectBeforePort(selected.input, 'data.r1.prepare', { ...validArgs, sourceEvidenceJson: JSON.stringify(missingAuthorizationProof) },
        'R1_SOURCE_EVIDENCE', 'scope-missing-authorization-evidence');
      const forgedAuthorizationProof = evidenceFor(selected.input);
      forgedAuthorizationProof.authorization = { messageId: selected.input.messageId, quote: 'authorization={"status":"authorized","basis":"invented"}' };
      await rejectBeforePort(selected.input, 'data.r1.prepare', { ...validArgs, sourceEvidenceJson: JSON.stringify(forgedAuthorizationProof) },
        'R1_SOURCE_EVIDENCE', 'scope-forged-authorization-evidence');
      const noAuthorization = { ...source }; delete noAuthorization.authorization;
      await failure(h, selected.input, 'data.r1.prepare', { ...validArgs, sourceJson: JSON.stringify(noAuthorization),
        sourceEvidenceJson: JSON.stringify(evidenceFor(selected.input, noAuthorization)) }, 'R1_SOURCE_UNKNOWN', 'scope-no-authorization');
      assert.equal(h.companionDatabase.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts').get()!.n, 0);
      checks.push('scope-no-authorization');
      const forged = evidenceFor(selected.input); forged.provider = { messageId: selected.input.messageId, quote: 'provider=not-the-real-provider' };
      await rejectBeforePort(selected.input, 'data.r1.prepare', { ...validArgs, sourceEvidenceJson: JSON.stringify(forged) },
        'R1_SOURCE_EVIDENCE', 'scope-forged-source-quote');
      const noValue = evidenceFor(selected.input); noValue.provider = { messageId: selected.input.messageId, quote: '请处理明确附上的隔离合成CSV' };
      await rejectBeforePort(selected.input, 'data.r1.prepare', { ...validArgs, sourceEvidenceJson: JSON.stringify(noValue) },
        'R1_SOURCE_EVIDENCE', 'scope-literal-quote-without-source-value');
      await rejectBeforePort(selected.input, 'data.r1.prepare', { ...validArgs, sourceJson: JSON.stringify({ ...source, rows: [] }) },
        'R1_SOURCE_EVIDENCE', 'scope-unknown-source-field');
      for (const [name, value] of [['recipe', {}], ['rows', []], ['target', target], ['mapping', mapping], ['requestId', 'model-chosen'],
        ['store', f.store], ['roles', ['publish']]] as const) {
        await rejectBeforePort(selected.input, 'data.r1.prepare', { ...validArgs, [name]: value }, null,
          'scope-forbidden-prepare-' + name, 'MODEL_ARGS_INVALID');
      }
      await rejectBeforePort(selected.input, 'data.r1.submit', { requestId: 'model-guessed' }, null, 'scope-no-model-submit', 'MODEL_ACTION_NOT_ALLOWED');
      const prepared = await invoke(h, selected.input, 'data.r1.prepare', validArgs, 'scope-first-r1-prepare');
      assertModelView(prepared.preview.data, f);
      const firstRequestId = String(prepared.preview.data.requestId);
      const firstCount = port.counts.prepare;
      const replay = await invoke(h, selected.input, 'data.r1.prepare', validArgs, 'scope-first-r1-prepare');
      assert.equal(port.counts.prepare, firstCount); assert.equal(replay.preview.taskId, prepared.preview.taskId); checks.push('same-tool-call-no-reexecute');
      await rejectBeforePort(selected.input, 'data.r1.prepare', { ...validArgs, outputId: 'changed' }, null,
        'scope-first-r1-prepare', 'MODEL_TOOL_CALL_CONFLICT');
      const changedSource = { ...source, provider: 'synthetic-fixture-alternate' };
      await failure(h, selected.input, 'data.r1.prepare', prepareArgs(selected.input, planned.planId, changedSource),
        'R1_REQUEST_CONFLICT', 'scope-same-request-source-recipe-conflict'); checks.push('same-request-recipe-conflict');
      assert.equal(h.companion.r1Workspace!.get(firstRequestId).submitTaskId, null);
      // Real public steer: Core commits a later user message on the SAME active branch/run.
      const later = await startInput(h, userStatement('后续独立计划；不提交。'), 'scope-later-user-input',
        { conversationId: selected.input.conversationId, mode: 'steer' });
      assert.equal(later.runId, selected.input.runId); assert.equal(later.branchId, selected.input.branchId);
      const laterPlan = await actualPlan(h, later, selected.reference.id, 'scope-later');
      await rejectBeforePort(selected.input, 'data.r1.prepare', prepareArgs(selected.input, laterPlan.planId),
        'R1_PLAN_ORIGIN', 'scope-same-branch-non-ancestor-plan');
      const laterSource = { ...source }; delete laterSource.license;
      const laterPrepared = await invoke(h, later, 'data.r1.prepare', prepareArgs(later, laterPlan.planId, laterSource), 'scope-later-r1-prepare');
      const laterRequestId = String(laterPrepared.preview.data.requestId);
      assert.notEqual(laterRequestId, firstRequestId);
      const laterRefs = JSON.parse(String(h.companion.r1!.attempt(laterRequestId).local_refs_json));
      assert.equal(Object.hasOwn(laterRefs.sourceRefs[0], 'license'), false);
      await rejectBeforePort(selected.input, 'data.r1.get', { requestId: laterRequestId }, 'R1_CONVERSATION_SCOPE', 'scope-non-ancestor-request-get');
      await rejectBeforePort(selected.input, 'data.r1.recover', { requestId: laterRequestId }, 'R1_CONVERSATION_SCOPE', 'scope-non-ancestor-request-recover');
      const earlierList = await invoke(h, selected.input, 'data.r1.list', { offset: 0, limit: 1 }, 'scope-earlier-list');
      assert.deepEqual(earlierList.preview.data.requests.map((item: { requestId: string }) => item.requestId), [firstRequestId]);
      assert.equal(earlierList.preview.data.done, true); assert.equal(earlierList.preview.data.nextOffset, null);
      const firstPage = await invoke(h, later, 'data.r1.list', { offset: 0, limit: 1 }, 'scope-later-list-page-one');
      const secondPage = await invoke(h, later, 'data.r1.list', { offset: 1, limit: 1 }, 'scope-later-list-page-two');
      const beyond = await invoke(h, later, 'data.r1.list', { offset: 2, limit: 1 }, 'scope-later-list-page-end');
      const requests = [...firstPage.preview.data.requests, ...secondPage.preview.data.requests];
      assert.deepEqual(requests.map(item => item.requestId).sort(), [firstRequestId, laterRequestId].sort());
      assert.equal(firstPage.preview.data.nextOffset, 1); assert.equal(firstPage.preview.data.done, false);
      assert.equal(secondPage.preview.data.nextOffset, null); assert.equal(secondPage.preview.data.done, true);
      assert.deepEqual(beyond.preview.data.requests, []); assert.equal(beyond.preview.data.done, true);
      for (const page of [earlierList, firstPage, secondPage, beyond]) assertModelView(page.preview.data, f);
      assert.equal(port.counts.list, 0); checks.push('scope-filter-before-pagination-no-global-list');
      // Genuine share marker, malicious transport content: projector reconstructs persisted safe preview only.
      const projected = h.services.modelTools.projectToolResult({ role: 'toolResult', toolName: 'perform_action',
        toolCallId: laterPrepared.toolCallId, content: [{ type: 'text', text: JSON.stringify({ connection: f.runtime,
          previewRows: [{ value_decimal: '12.30' }], local: { raw: 'transport-tamper' } }) }],
        details: shareDetails(laterPrepared.raw.details), isError: false, timestamp: Date.now() }, later, undefined, model);
      const projectedValue = resultValue(projected);
      assert.equal(projectedValue.data.requestId, laterRequestId); assertModelView(projectedValue.data, f); checks.push('raw-transport-result-not-shared');
      const foreignConversation = h.core.createConversation('foreign-synthetic-conversation').conversationId;
      const foreign = await startInput(h, userStatement(), 'scope-foreign-user-input', { conversationId: foreignConversation });
      const foreignEvidence = evidenceFor(foreign);
      await rejectBeforePort(later, 'data.r1.prepare', { ...prepareArgs(later, laterPlan.planId), sourceEvidenceJson: JSON.stringify(foreignEvidence) },
        'R1_SOURCE_EVIDENCE', 'scope-cross-conversation-source-evidence');
      await rejectBeforePort(foreign, 'data.r1.prepare', prepareArgs(foreign, laterPlan.planId), 'R1_PLAN_ORIGIN', 'scope-cross-conversation-plan');
      await rejectBeforePort(foreign, 'data.r1.get', { requestId: laterRequestId }, 'R1_CONVERSATION_SCOPE', 'scope-cross-conversation-get');
      await rejectBeforePort(foreign, 'data.r1.recover', { requestId: laterRequestId }, 'R1_CONVERSATION_SCOPE', 'scope-cross-conversation-recover');
      const foreignList = await invoke(h, foreign, 'data.r1.list', {}, 'scope-cross-conversation-list');
      assert.deepEqual(foreignList.preview.data.requests, []); assert.equal(port.counts.list, 0); checks.push('cross-conversation-list-empty');
      await h.core.abort(later.runId, later.conversationId);
      const beforeBranch = h.core.getState(later.conversationId);
      const branched = h.core.createBranch(later.conversationId, beforeBranch.treeRevision);
      assert.notEqual(branched.branchId, later.branchId);
      const branch = await startInput(h, userStatement(), 'scope-branch-user-input', { conversationId: later.conversationId });
      await rejectBeforePort(branch, 'data.r1.prepare', prepareArgs(branch, laterPlan.planId), 'R1_PLAN_ORIGIN', 'scope-cross-branch-plan');
      await rejectBeforePort(branch, 'data.r1.get', { requestId: laterRequestId }, 'R1_CONVERSATION_SCOPE', 'scope-cross-branch-get');
      await rejectBeforePort(branch, 'data.r1.recover', { requestId: laterRequestId }, 'R1_CONVERSATION_SCOPE', 'scope-cross-branch-recover');
      const branchList = await invoke(h, branch, 'data.r1.list', {}, 'scope-cross-branch-list');
      assert.deepEqual(branchList.preview.data.requests, []); assert.equal(port.counts.list, 0); checks.push('cross-branch-list-empty');
      const stopped = await h.companion.tasks.stopControl('Synthetic companion STOP test');
      await rejectBeforePort(branch, 'data.r1.capabilities', {}, 'SERVICE_STOPPED', 'scope-companion-stop');
      h.companion.tasks.resumeControl(stopped.generation, 'Synthetic explicit resume after STOP assertion');
      // Current parent remains real; policy revocation invalidates an earlier genuine result ticket.
      const currentCaps = await invoke(h, branch, 'data.r1.capabilities', {}, 'scope-current-safe-capabilities');
      h.services.permissions.grant({ effect: 'deny', label: 'Synthetic current model share revoked', scope: { kind: 'persistent' },
        capabilities: [{ action: 'network', target: { kind: 'network', origin: new URL(model.baseUrl).origin } }] });
      const withheld = h.services.modelTools.projectToolResult({ role: 'toolResult', toolName: 'perform_action', toolCallId: currentCaps.toolCallId,
        content: currentCaps.raw.content, details: shareDetails(currentCaps.raw.details), isError: false, timestamp: Date.now() }, branch, undefined, model);
      assert.equal((withheld.details as { mashiroShareWithheld?: boolean }).mashiroShareWithheld, true);
      assert.ok(!JSON.stringify(withheld.content).includes('conversation-r1/1')); checks.push('genuine-result-share-revoked');
      await h.core.abort(branch.runId, branch.conversationId);
      await rejectBeforePort(branch, 'data.r1.capabilities', {}, null, 'scope-stale-parent-input', 'MODEL_ACTION_STOPPED');
      assert.equal(h.companion.r1Workspace!.get(firstRequestId).submitTaskId, null);
      assert.equal(h.companion.r1Workspace!.get(laterRequestId).submitTaskId, null);
      json(join(f.root, 'actual-scope-source-summary.json'), { primaryEntry: 'actual createApplicationServices/modelTools',
        syntheticInputOnly: true, noProviderOrNetwork: true, fakeToolCalls: false, fakeProcessingLinks: false,
        requestIds: [firstRequestId, laterRequestId], checks, actualPortCallCounts: port.snapshot(),
        modelSubmitRegistered: false, hostSubmitInvoked: false, sourceEvidenceScope: 'verified_user_statement_only', productionAcceptance: false });
      console.log('F05_ACTUAL_SCOPE_SOURCE', JSON.stringify({ root: f.root, checks: checks.length, counts: port.snapshot() }));
    } finally { port.restore(); await h.close(); }
  });
