import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WfdProductMachineClient } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { TaskRuntimeRegistry, TaskService, type TaskRecord } from '../../platform/jobs/tasks.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { PermissionService, digestOperationArgs } from '../../platform/security/permissions.js';
import { ProcessRuntime } from '../../platform/runtime/programs.js';
import { ResourceBindings } from '../../platform/resources/bindings.js';
import { readSourceProjection } from '../../modules/collection/source-reported-table.js';
import { polarsFixedVersionBinding, projectDailyPolars, projectFinancialPolars, projectMacroYoYPolars,
  type PolarsExecution, type MacroYoYCalculation } from '../../modules/collection/data-processing/polars-fixed.js';
import type { FinancialCalculation, FinancialReader } from '../../modules/collection/data-processing/financial-fixed.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const python = process.env.POLARS_PYTHON;
const missingInputs = ['POLARS_PYTHON', 'WFD_PYTHON', 'XUAN_FULL_CHAIN_ROOT', 'POLARS_FINANCIAL_FIXTURE']
  .filter(key => !process.env[key]);
const source = { source_id: 'polars-synthetic', provider: 'generated fixed calculation fixture',
  requested_url: 'https://fixture.example.test/polars.csv', requested_at_utc: '2026-01-01T00:00:00Z',
  acquired_at_utc: '2026-02-01T00:00:00Z', usage_scope: 'explicit isolated fixed calculation; candidate only',
  authorization: { status: 'authorized' as const, basis: 'Operator selected generated fixed inputs for isolated Polars executor acceptance.' } };
async function auto(host: FullChainHost, id: string, bytes: Buffer) {
  const uploaded = await host.upload(id + '.csv', 'data', bytes, 'upload-' + id);
  const received = await host.settled(uploaded.jobId); assert.equal(received.status, 'succeeded', JSON.stringify(received.error));
  const material = host.services.materials!.getByTask(received.id)!;
  await host.call('/r1/auto/start', { requestId: id, materialId: material.envelope.materialId, datasetId: 'polars_fixed', source }, 202);
  let answered = false;
  for (let i = 0; i < 2400; i++) {
    const view = await host.call('/r1/auto/' + id);
    if (view.state === 'associated') return { material, view };
    if (view.state === 'awaiting_answers' && !answered) {
      const selected: Record<string, string> = { source_trade_date_timezone: 'Asia/Shanghai', source_series: 'explicit synthetic daily observations' };
      assert.equal(view.questions.every((question: any) => Object.hasOwn(selected, question.key)), true, JSON.stringify(view.questions));
      await host.call('/r1/auto/' + id + '/answers', { answers: Object.fromEntries(view.questions.map((question: any) => [question.key, selected[question.key]])) }, 202);
      answered = true; continue;
    }
    if (['blocked', 'awaiting_answers', 'stopped'].includes(view.state)) assert.fail(JSON.stringify(view));
    await delay(25);
  }
  throw new Error('R1 fixture did not settle.');
}
async function readRows(host: FullChainHost, snapshotId: string, productId: string) {
  const rows: WfdRecord[] = []; let cursor: string | undefined;
  do {
    const result = await host.call('/r1/products/read', { snapshotId, productId, ...(cursor ? { cursor } : {}) });
    rows.push(...result.result.rows); cursor = result.result.page.has_more ? result.result.page.next_cursor : undefined;
  } while (cursor);
  return rows;
}
async function normalTask(host: FullChainHost, input: unknown, expected = 'succeeded') {
  const accepted = await host.call('/processing/polars/tasks', input, 202);
  const task = await host.settled(accepted.jobId);
  assert.equal(task.status, expected, JSON.stringify(task.error));
  const read = await host.call('/processing/polars/tasks/' + task.id);
  assert.equal(read.task.id, task.id);
  return task;
}

function jobs(root: string, runtime: ProcessRuntime) {
  const database = new CoreDatabase(join(root, 'polars-jobs.sqlite'));
  let tasks: TaskService;
  const permissions = new PermissionService({ database, isRunActive: (run, generation) => tasks.isRunActive(run, generation) });
  const runtimes = new TaskRuntimeRegistry();
  type Work = (execution: PolarsExecution) => Promise<{ jsonBytes: Buffer; evidence: unknown }>;
  const work = new Map<string, Work>();
  runtimes.register({ id: 'polars.fixed.acceptance', execute: async context => {
    const operation = { operationId: 'polars.fixed', operationVersion: 1, argsDigest: digestOperationArgs(context.task.args),
      targets: [{ kind: 'file' as const, path: python! }] };
    const capabilities = [{ action: 'execute' as const, target: { kind: 'file' as const, path: python! } }];
    const assertAuthorized = () => { context.signal.throwIfAborted(); context.assertAuthorized(operation, capabilities); };
    const output = await work.get(context.task.requestId)!({ context, processRuntime: runtime, pythonExecutable: python!, assertAuthorized });
    writeFileSync(join(root, context.task.requestId + '-candidate.json'), output.jsonBytes);
    return { summary: 'Explicit Polars candidate completed; no database publication.',
      data: JSON.parse(canonicalWfdJson({ rows: JSON.parse(output.jsonBytes.toString()), evidence: output.evidence,
        candidateSha256: wfdSha256(output.jsonBytes), publication: 'candidate_only' })) };
  } });
  tasks = new TaskService({ database, runtimes, permissions });
  permissions.grant({ capabilities: [{ action: 'execute', target: { kind: 'file', path: python! } }], label: 'isolated-polars-selected-program', scope: { kind: 'persistent' } });
  const run = async (id: string, input: WfdRecord, selected: Work, expected = 'succeeded') => {
    work.set(id, selected);
    const task = tasks.create({ title: id, ownerRole: 'service', runtimeId: 'polars.fixed.acceptance', action: 'polars.fixed',
      requestId: id, args: input as any, versions: polarsFixedVersionBinding() });
    tasks.start(task.id, task.version);
    const result = await new Promise<TaskRecord>((resolve, reject) => {
      const timer = setTimeout(() => { unsub(); reject(new Error('Polars task did not settle.')); }, 60_000);
      const unsub = tasks.subscribe(({ task: next }) => {
        if (next.id === task.id && ['succeeded', 'failed', 'cancelled', 'needs_review'].includes(next.status)) { clearTimeout(timer); unsub(); resolve(next); }
      });
    });
    assert.equal(result.status, expected, JSON.stringify(result.error));
    return result;
  };
  return { run, tasks, database, async close() { await tasks.dispose(); database.close(); } };
}

function macroCsv() {
  const fields = ['series_code', 'region', 'unit', 'seasonal_adjustment', 'base_period', 'period_start', 'period_end', 'published_at', 'release_id', 'value'];
  const header = ['business_key', 'start_utc', 'end_utc', 'value_state', ...fields,
    'bd.semantic_code', 'bd.subject_kind', 'bd.subject_id', 'bd.frequency', 'bd.precision', 'bd.timezone', 'bd.period_type',
    ...fields.flatMap(field => ['bd.type.' + field, 'bd.unit.' + field, 'bd.measurement.' + field])];
  const records = [['prior-initial', '2025', '90', '2025-02-15T00:00:00Z'], ['prior-revised', '2025', '100', '2025-03-01T00:00:00Z'],
    ['current', '2026', '120', '2026-02-15T00:00:00Z'], ['future-release', '2026', '130', '2026-04-01T00:00:00Z']];
  const rows = records.map(([key, year, value, release]) => [key, year + '-01-01T00:00:00Z', year + '-02-01T00:00:00Z', 'valid_value',
    'synthetic-index', 'region_1', 'count', 'not_adjusted', '2020', year + '-01-01', year + '-01-31', release, key, value,
    'macro.synthetic.index', 'region', 'region_1', 'month', 'day', 'UTC', 'natural',
    ...fields.flatMap(field => [field === 'value' ? 'decimal' : 'text', field === 'value' ? 'count' : 'text', 'stock'])]);
  return Buffer.from([header, ...rows].map(row => row.join(',')).join('\n') + '\n');
}

test('three explicitly selected Polars tasks use real published fixed inputs and preserve candidate/task evidence',
  { skip: missingInputs.length ? `未显式选择 ${missingInputs.join('、')}；财报专项须选择已验隔离样本，不自动寻找原实例。` : false, timeout: 300_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'polars-three-fixed', machine: true,
    units: { count: { dimension: 'quantity' }, text: { dimension: 'text' }, date: { dimension: 'date' }, percent: { dimension: 'ratio' },
      cny_per_share: { dimension: 'money_per_share' } } });
  const bindingPath = join(fixture.runtime, 'config/machine.bindings.json');
  const bindings = JSON.parse(readFileSync(bindingPath, 'utf8'));
  bindings.resources.polars_python = { kind: 'program', path: python }; bindings.revision++;
  writeFileSync(bindingPath, JSON.stringify(bindings, null, 2));
  const host = await openFullChainHost(fixture), executor = jobs(fixture.root, new ProcessRuntime(new ResourceBindings(fixture.runtime)));
  const proof: Record<string, unknown> = { dependency: polarsFixedVersionBinding() };
  try {
    const daily = [];
    for (const [first, last] of [[1, 10], [11, 26]]) {
      const bytes = Buffer.from('交易日期,股票代码,股票名称,收盘价（元）\n' + Array.from({ length: last! - first! + 1 }, (_, i) => {
        const day = first! + i; return '202601' + String(day).padStart(2, '0') + ',A,合成观测,' + (day === 26 ? '' : day);
      }).join('\n') + '\n');
      daily.push(await auto(host, 'polars-daily-' + first, bytes));
    }
    const current = await host.call('/r1/products/snapshot', {});
    const requests = daily.map(item => item.view.currentRequest);
    const productId = requests[0].local.associations[0].product_id;
    const allRows = await readRows(host, current.snapshotId, productId);
    const versions = Object.fromEntries(allRows.map((row: any) => [row.record_ref.logical_key, row.record_ref.revision_id]));
    const inputs = daily.map(item => {
      const request = item.view.currentRequest, keys = new Set(request.local.associations.map((a: any) => a.record_id));
      const plan = host.services.processing!.get(request.planId);
      const projection = readSourceProjection(plan.steps.find(step => step.kind === 'parse')?.parameters.sourceProjection);
      return { materialId: item.material.envelope.materialId, original: host.services.materials!.readOriginal(item.material.envelope.materialId).bytes,
        source, projection, request, fixedRows: allRows.filter((row: any) => keys.has(row.record_ref.logical_key)) };
    });
    const dailyTask = await executor.run('polars-daily', { method: 'observation_ma20', snapshotId: current.snapshotId, productId },
      execution => projectDailyPolars(execution, '收盘价（元）', inputs, { snapshotId: current.snapshotId, productId, versions }));
    const dailyResult = dailyTask.result!.data as any;
    assert.equal(dailyResult.rows[19].value, '10.50000000'); assert.equal(dailyResult.rows[24].value, '15.50000000');
    assert.equal(dailyResult.rows[25].value_state, 'unknown'); assert.equal(dailyResult.rows[25].calculation_status, 'window_missing');
    assert.equal(dailyResult.rows.slice(0, 19).every((row: any) => row.value === null), true);
    assert.equal(dailyResult.evidence.execution.executor, 'polars'); assert.equal(dailyResult.evidence.execution.resources.thread_pool_size, 2);
    proof.daily = dailyResult;
    const broken = structuredClone(inputs); (broken[0]!.fixedRows[0]!.values as any)[broken[0]!.projection.fields.at(-1)!.fieldCode].value = '999';
    await executor.run('polars-daily-invalid', { method: 'observation_ma20', snapshotId: current.snapshotId, productId },
      execution => projectDailyPolars(execution, '收盘价（元）', broken, { snapshotId: current.snapshotId, productId, versions }), 'failed');

    const macro = await auto(host, 'polars-macro', macroCsv());
    const macroRequest = macro.view.currentRequest, macroAssociation = macroRequest.local.associations[0];
    const sourceRows = await readRows(host, macroAssociation.snapshot_id, macroAssociation.product_id);
    const reference = (key: string) => {
      const row = sourceRows.find((row: any) => row.record_ref.logical_key === key) as any; assert.ok(row);
      return { snapshotId: macroAssociation.snapshot_id, productId: macroAssociation.product_id, businessKey: key, recordVersion: row.record_ref.revision_id };
    };
    const macroInput: MacroYoYCalculation = { version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents',
      knowledgeCutoff: '2026-03-01T00:00:00Z', inputs: [reference('current'), reference('prior-revised')] };
    const macroTask = await executor.run('polars-macro', macroInput as any,
      execution => projectMacroYoYPolars(execution, macroInput, host.services.r1Workspace!.readProduct.bind(host.services.r1Workspace!)));
    assert.equal((macroTask.result!.data as any).rows[0].value, '20.00000000'); proof.macro = macroTask.result!.data;
    const initial = { ...macroInput, inputs: [reference('current'), reference('prior-initial')] };
    const initialTask = await executor.run('polars-macro-initial', initial as any,
      execution => projectMacroYoYPolars(execution, initial, host.services.r1Workspace!.readProduct.bind(host.services.r1Workspace!)));
    assert.equal((initialTask.result!.data as any).rows[0].value, '33.33333333'); proof.macroInitial = initialTask.result!.data;
    const future = { ...macroInput, inputs: [reference('future-release'), reference('prior-revised')] };
    const futureTask = await executor.run('polars-macro-future', future as any,
      execution => projectMacroYoYPolars(execution, future, host.services.r1Workspace!.readProduct.bind(host.services.r1Workspace!)), 'failed');
    assert.equal(futureTask.error!.code, 'POLARS_MACRO_RELEASE_UNAVAILABLE');

    const financialRoot = process.env.POLARS_FINANCIAL_FIXTURE; assert.ok(financialRoot, 'Select the already verified real financial fixture.');
    const financialFixture = JSON.parse(readFileSync(join(financialRoot, 'financial-fixture.json'), 'utf8'));
    const ledgerName = readdirSync(financialRoot).find(name => /^financial-fixed-(?!complete).*\.json$/u.test(name))!;
    const ledger = JSON.parse(readFileSync(join(financialRoot, ledgerName), 'utf8')) as any[];
    const expected = ledger.filter(item => item.operation === 'quarter_difference').at(-1)!;
    assert.ok(expected, 'Real fixed financial input has not been published.');
    const productRoot = fileURLToPath(new URL('../../wfd/product', import.meta.url));
    const financialClient = new WfdProductMachineClient({ pythonPath: process.env.WFD_PYTHON!,
      configPath: financialFixture.configPath, projectRoot: productRoot, entryPath: join(productRoot, 'wfd_sdk/product_machine.py') });
    const reader: FinancialReader = async input => {
      const discovered = await financialClient.discover(input.snapshotId);
      const product = (discovered.result.products as any[]).find(item => item.product_id === input.productId); assert.ok(product);
      const result = await financialClient.readProduct({ protocol_version: 'wfd.read/1.3-product1', operation: 'read_product',
        dataset_id: product.dataset_id, snapshot_id: input.snapshotId, product_id: input.productId,
        fields: product.declaration.field_definitions.map((field: any) => field.field_code), subject: null,
        history_mode: 'snapshot_contents', knowledge_cutoff: null, held_scope: null, usable_stage: null, business_time_range: null,
        page_size: 100, max_nodes: 5000, max_scan_bytes: 16777216, cursor: input.cursor ?? null });
      return { result: result.result, connection: { connectionId: 'read-only-real-financial-fixture' } };
    };
    const financial: FinancialCalculation = { version: 'bd-financial-fixed/1', operation: 'quarter_difference',
      inputs: expected.proof.inputs.map(({ snapshotId, productId, businessKeys }: any) => ({ snapshotId, productId, businessKeys })) };
    const financialTask = await executor.run('polars-financial', financial as any,
      execution => projectFinancialPolars(execution, financial, reader, () => { throw new Error('No unverified cross-revision review.'); }));
    const financialResult = financialTask.result!.data as any;
    assert.equal(financialResult.rows[0].value, '456780603.01');
    assert.equal(financialResult.rows[0].value, expected.rows[0].values.value.value); proof.financial = financialResult;
    assert.equal(financialResult.evidence.execution.executor, 'polars');
    const headAfter = await host.call('/r1/products/snapshot', {});
    assert.equal(headAfter.snapshotId, macroAssociation.snapshot_id, 'The calculation executor never publishes its candidate to WFD.');
    const caps = await host.call('/processing/polars/capabilities');
    assert.equal(caps.configured, true); assert.equal(caps.default, false); assert.equal(caps.publication, 'candidate_only');
    const selectedDaily = { requestId: 'normal-daily', method: 'observation_ma20', autoRequestIds: ['polars-daily-1', 'polars-daily-11'], valueColumn: '收盘价（元）' };
    const normalDaily = await normalTask(host, selectedDaily);
    assert.equal((normalDaily.result!.data as any).rows[19].value, '10.50000000');
    assert.equal((await host.call('/processing/polars/tasks', selectedDaily, 202)).jobId, normalDaily.id);
    const normalMacro = await normalTask(host, { requestId: 'normal-macro', method: 'macro_yoy', calculation: macroInput });
    assert.equal((normalMacro.result!.data as any).rows[0].value, '20.00000000');
    const normalFuture = await normalTask(host, { requestId: 'normal-macro-future', method: 'macro_yoy', calculation: future }, 'failed');
    assert.equal(normalFuture.error!.code, 'POLARS_MACRO_RELEASE_UNAVAILABLE');
    const oldVersion = host.services.tasks.create({ title: 'old dependency rejection', ownerRole: 'service', runtimeId: normalDaily.runtimeId,
      action: normalDaily.action, args: normalDaily.args, requestId: 'polars-version-mismatch', versions: { ...normalDaily.versions, polarsDependency: '0.0.0' } });
    host.services.tasks.start(oldVersion.id, oldVersion.version);
    const oldVersionResult = await host.settled(oldVersion.id); assert.equal(oldVersionResult.status, 'failed');
    assert.equal(oldVersionResult.error!.code, 'POLARS_IMPLEMENTATION_CHANGED');
    let cancelStarted = false;
    const unsubscribe = host.services.tasks.subscribe(({ task, event }) => {
      if (task.requestId === 'polars:normal-cancel' && event.type === 'WORKER_STATE' && (event.data as any)?.state === 'started') {
        cancelStarted = true; setImmediate(() => { void host.services.tasks.cancel(task.id); });
      }
    });
    const cancelled = await normalTask(host, { requestId: 'normal-cancel', method: 'macro_yoy', calculation: macroInput }, 'cancelled');
    unsubscribe(); assert.equal(cancelStarted, true); assert.equal(cancelled.result, null);
    await host.call('/processing/polars/tasks/' + cancelled.id + '/stage', {}, 409);

    // A second BD state owns no financial business writes and reads the actual already-published financial store.
    const financialReadFixture = createFullChainFixture({ name: 'polars-financial-readonly', machine: true });
    const originalConfig = JSON.parse(readFileSync(financialFixture.configPath, 'utf8'));
    writeFileSync(financialReadFixture.configPath, JSON.stringify({ ...originalConfig, connection_id: 'full-chain-test',
      caller: { ...originalConfig.caller, caller_id: 'full-chain-test', roles: ['read'] } }, null, 2));
    const financialRegistry = JSON.parse(readFileSync(financialReadFixture.registryPath, 'utf8'));
    financialRegistry.connections[0].store = originalConfig.store; financialRegistry.connections[0].runtime = originalConfig.runtime;
    writeFileSync(financialReadFixture.registryPath, JSON.stringify(financialRegistry, null, 2));
    const financialBindingPath = join(financialReadFixture.runtime, 'config/machine.bindings.json');
    const financialBindings = JSON.parse(readFileSync(financialBindingPath, 'utf8'));
    financialBindings.resources.polars_python = { kind: 'program', path: python }; financialBindings.revision++;
    writeFileSync(financialBindingPath, JSON.stringify(financialBindings, null, 2));
    const financialHost = await openFullChainHost(financialReadFixture);
    try {
      const before = await financialHost.call('/r1/products/snapshot', {});
      const normalFinancial = await normalTask(financialHost, { requestId: 'normal-financial', method: 'financial_linear', calculation: financial });
      assert.equal((normalFinancial.result!.data as any).rows[0].value, '456780603.01');
      assert.equal((await financialHost.call('/r1/products/snapshot', {})).snapshotId, before.snapshotId);
      proof.normalFinancial = normalFinancial;
      writeFileSync(join(financialReadFixture.root, 'fixture.json'), JSON.stringify(financialReadFixture, null, 2));
    } finally { await financialHost.close(); }
    const staged = await host.call('/processing/polars/tasks/' + normalMacro.id + '/stage', {}, 202);
    const custody = await host.settled(staged.custodyTaskId); assert.equal(custody.status, 'succeeded');
    const candidateView = await host.call('/processing/polars/tasks/' + normalMacro.id);
    const materialId = candidateView.candidate.materialId; assert.ok(materialId);
    const candidate = normalMacro.result!.data as any;
    const parent = (await host.call('/r1/products/snapshot', {})).snapshotId;
    const target = { datasetId: 'polars_fixed', outputKey: 'macro.polars_yoy', expectedParentSnapshotId: parent,
      subject: { kind: 'region', namespace: 'full.chain.test', id: 'region_1' }, inputMode: 'partial_observation',
      coverage: { scope: { series: 'synthetic-index', selectedRecords: 2 }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      definition: { semantic_code: 'macro.polars_yoy', measurement_nature: 'derived', unit_code: 'per_field', definition_authority: 'full.chain.test', time_role: 'observation',
        field_definitions: [{ field_code: 'value', data_type: 'decimal', unit_code: 'percent', measurement_nature: 'derived', time_role: 'observation' }],
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'deterministic_derived',
          time: { period_type: 'natural', frequency: 'month', interval: 'half_open', timezone: 'UTC' } }, algorithm_definition: candidate.algorithmDefinition } };
    const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc', precision: 'day', sourceTimezone: 'UTC',
      fields: [{ fieldCode: 'value', value: 'value', state: 'value_state' }] };
    const dimensionValues = { role: 'calculated_result', informationNature: 'deterministic_derived', businessObject: 'synthetic-index fixed source releases',
      objectTime: 'explicit January 2026 versus January 2025; snapshot contents; no historical qualification', purpose: source.usage_scope,
      structureGranularity: 'one percentage computed by the explicitly selected native Polars fixed task' };
    const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: dimensionValues[key], evidence: [{ source: 'operator', field: key, quote: dimensionValues[key] }] }]));
    const planned = await host.call('/processing/plans', { requestId: 'normal-polars-bridge-plan', input: {
      routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'calculated', materialIds: [materialId],
        intendedAction: 'publish', tables: [{ materialId, format: 'json', types: { value: 'decimal_string' } }],
        target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: parent } }] } }, 202);
    const plannedTask = await host.settled(planned.jobId); assert.equal(plannedTask.status, 'succeeded', JSON.stringify(plannedTask.error));
    const planId = host.services.processing!.getByTask(plannedTask.id)!.plan!.planId;
    const running = await host.call('/processing/plans/' + planId + '/run', { requestId: 'normal-polars-bridge-run' }, 202);
    const runTask = await host.settled(running.jobId); assert.equal(runTask.status, 'succeeded', JSON.stringify(runTask.error));
    const prepareInput = { requestId: 'normal-polars-publish', planId, outputId: 'calculated', source, target, mapping };
    const prepared = await host.call('/processing/polars/tasks/' + normalMacro.id + '/prepare', prepareInput, 201);
    assert.equal(prepared.state, 'prepared_profile_pending');
    assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, parent, 'Prepare still has no publication authority.');
    const submitted = await host.call('/r1/requests/' + prepareInput.requestId + '/submit', { confirmationDigest: prepared.documentSha256 }, 202);
    const submittedTask = await host.settled(submitted.jobId); assert.equal(submittedTask.status, 'succeeded', JSON.stringify(submittedTask.error));
    const published = await host.call('/r1/requests/' + prepareInput.requestId);
    assert.equal(published.state, 'associated');
    const output = published.local.associations[0]; const publishedRows = await readRows(host, output.snapshot_id, output.product_id);
    assert.equal((publishedRows[0]!.values as any).value.value, '20');
    proof.normalDaily = normalDaily; proof.normalMacro = normalMacro; proof.bridge = { staged, prepared, published };
    const saved = executor.tasks.get(financialTask.id); assert.deepEqual(saved.result, financialTask.result);
    writeFileSync(join(fixture.root, 'polars-verification.json'), JSON.stringify(proof, null, 2));
    writeFileSync(join(fixture.root, 'fixture.json'), JSON.stringify(fixture, null, 2));
  } finally { await executor.close(); await host.close(); }
});

test('persisted Polars candidates and the original confirmed R1 bridge survive host reopen', { skip: !process.env.POLARS_REOPEN_FIXTURE, timeout: 60_000 }, async () => {
  const root = process.env.POLARS_REOPEN_FIXTURE!;
  const fixture = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
  const proof = JSON.parse(readFileSync(join(root, 'polars-verification.json'), 'utf8'));
  const host = await openFullChainHost(fixture);
  try {
    const daily = await host.call('/processing/polars/tasks/' + proof.normalDaily.id);
    assert.deepEqual(daily.task.result, proof.normalDaily.result);
    const repeated = await host.call('/processing/polars/tasks', { requestId: 'normal-daily', method: 'observation_ma20',
      autoRequestIds: ['polars-daily-1', 'polars-daily-11'], valueColumn: '收盘价（元）' }, 202);
    assert.equal(repeated.jobId, proof.normalDaily.id, 'A later published head does not silently freeze new inputs for the original request.');
    const macro = await host.call('/processing/polars/tasks/' + proof.normalMacro.id);
    assert.deepEqual(macro.task.result, proof.normalMacro.result);
    assert.ok(macro.candidate.materialId);
    assert.equal(host.services.processing!.get(proof.bridge.prepared.planId).outputs[0]!.materialIds[0], macro.candidate.materialId);
    assert.equal(host.services.materials!.readOriginal(macro.candidate.materialId).sha256, macro.candidate.sha256);
    const published = await host.call('/r1/requests/normal-polars-publish');
    assert.equal(published.state, 'associated');
    assert.deepEqual(published.local.associations, proof.bridge.published.local.associations);
    const output = published.local.associations[0], rows = await readRows(host, output.snapshot_id, output.product_id);
    assert.equal((rows[0]!.values as any).value.value, '20');
    writeFileSync(join(root, 'polars-reopen-verification.json'), JSON.stringify({ passed: true,
      dailyTaskId: daily.task.id, macroTaskId: macro.task.id, candidateSha256: macro.candidate.sha256,
      materialId: macro.candidate.materialId, snapshotId: output.snapshot_id, productId: output.product_id, rows }, null, 2));
  } finally { await host.close(); }
});
