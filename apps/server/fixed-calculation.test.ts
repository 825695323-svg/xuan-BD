import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { R1HandoffService, buildStructuredIngestDocument, type R1StructuredRequest } from '../../modules/collection/r1-structured-handoff.js';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost, type FullChainFixture, type FullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.POLARS_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const source = { source_id: 'fixed-stage-synthetic', provider: '明确生成的阶段计算小样', requested_url: 'https://fixture.example.test/fixed.csv',
  requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-11-01T00:00:00Z',
  usage_scope: '用户选择的新隔离小样固定计算与R1交接验证',
  authorization: { status: 'authorized' as const, basis: '操作者明确允许生成小型合成记录并在本轮新隔离WFD实例验证。' } };
async function auto(host: FullChainHost, requestId: string, bytes: Buffer) {
  if (!host.services.r1Auto!.list().some(item => item.requestId === requestId)) {
    const upload = await host.upload(requestId + '.csv', 'data', bytes, 'upload-' + requestId);
    const received = await host.settled(upload.jobId); assert.equal(received.status, 'succeeded', JSON.stringify(received.error));
    await host.call('/r1/auto/start', { requestId, materialId: host.services.materials!.getByTask(received.id)!.envelope.materialId,
      datasetId: 'fixed_stage', source }, 202);
  }
  for (let i = 0; i < 1200; i++) {
    const view = await host.call('/r1/auto/' + requestId);
    if (view.state === 'associated') return view;
    if (view.state === 'awaiting_answers') {
      const answers: Record<string, string> = { source_trade_date_timezone: 'Asia/Shanghai', source_series: '明确合成日线系列' };
      assert.ok(view.questions.every((question: any) => answers[question.key]), JSON.stringify(view.questions));
      await host.call('/r1/auto/' + requestId + '/answers', { answers: Object.fromEntries(view.questions.map((q: any) => [q.key, answers[q.key]])) }, 202);
      continue;
    }
    assert.ok(!['blocked', 'stopped'].includes(view.state), JSON.stringify(view));
    await delay(25);
  }
  throw new Error('微型原报交接未结束。');
}
function table(fields: string[], rows: string[][], semantic: string) {
  return Buffer.from([['business_key', 'start_utc', 'end_utc', 'value_state', ...fields,
    'bd.semantic_code', 'bd.subject_kind', 'bd.subject_id', 'bd.frequency', 'bd.precision', 'bd.timezone', 'bd.period_type',
    ...fields.flatMap(field => ['bd.type.' + field, 'bd.unit.' + field, 'bd.measurement.' + field])],
  ...rows.map(([key, start, end, ...values]) => [key, start + 'T00:00:00Z', end + 'T00:00:00Z', 'valid_value', ...values,
    semantic, 'region', 'synthetic-region', 'month', 'day', 'UTC', 'natural',
    ...fields.flatMap(field => [field === 'value' ? 'decimal' : 'text', field === 'value' ? 'count' : 'text', 'stock'])])]
    .map(row => row.join(',')).join('\n') + '\n');
}
const macroBytes = () => table(['series_code', 'region', 'unit', 'seasonal_adjustment', 'base_period', 'period_start', 'period_end', 'published_at', 'release_id', 'value'], [
  ['macro-prior', '2025-01-01', '2025-02-01', 'synthetic-series', 'synthetic-region', 'count', 'not_adjusted', '2020', '2025-01-01', '2025-01-31', '2025-02-15T00:00:00Z', 'prior', '100'],
  ['macro-current', '2026-01-01', '2026-02-01', 'synthetic-series', 'synthetic-region', 'count', 'not_adjusted', '2020', '2026-01-01', '2026-01-31', '2026-02-15T00:00:00Z', 'current', '120'],
], 'macro.synthetic.fixed');
const financialBytes = () => table(['subject_scheme', 'subject_code', 'report_id', 'report_version', 'accounting_standard', 'currency', 'scope', 'unit', 'concept', 'period_type', 'start_date', 'end_date', 'dimension', 'value'], [
  ['financial-current', '2026-01-01', '2026-07-01', 'synthetic', 'company-1', 'report-1', 'v1', 'CAS', 'CNY', 'consolidated', 'cny', 'revenue', 'duration', '2026-01-01', '2026-06-30', 'all', '130.25'],
  ['financial-prior', '2026-01-01', '2026-04-01', 'synthetic', 'company-1', 'report-1', 'v1', 'CAS', 'CNY', 'consolidated', 'cny', 'revenue', 'duration', '2026-01-01', '2026-03-31', 'all', '100.10'],
  ['financial-fy', '2025-01-01', '2026-01-01', 'synthetic', 'company-1', 'report-1', 'v1', 'CAS', 'CNY', 'consolidated', 'cny', 'revenue', 'duration', '2025-01-01', '2025-12-31', 'all', '500'],
  ['financial-ytd', '2025-01-01', '2025-07-01', 'synthetic', 'company-1', 'report-1', 'v1', 'CAS', 'CNY', 'consolidated', 'cny', 'revenue', 'duration', '2025-01-01', '2025-06-30', 'all', '120'],
], 'financial.synthetic.fixed');
async function calculate(host: FullChainHost, input: unknown, expectedStatus = 'succeeded') {
  const accepted = await host.call('/computation/tasks', input, 202), task = await host.settled(accepted.task.id);
  assert.equal(task.status, expectedStatus, JSON.stringify(task.error));
  return host.call('/computation/tasks/' + task.id);
}
async function planCandidate(host: FullChainHost, task: any, materialId: string, requestId: string, derived: boolean, valueColumn = 'value') {
  const parent = (await host.call('/r1/products/snapshot', {})).snapshotId;
  const target = { datasetId: 'fixed_stage', outputKey: derived ? 'macro.fixed.yoy' : 'macro.forged.original', expectedParentSnapshotId: parent,
    subject: { kind: 'region', namespace: 'full.chain.test', id: 'synthetic-region' }, inputMode: 'partial_observation',
    coverage: { scope: { selectedRecords: 2 }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    definition: { semantic_code: derived ? 'macro.fixed.yoy' : 'macro.forged.original', measurement_nature: derived ? 'derived' : 'stock',
      unit_code: 'per_field', definition_authority: 'full.chain.test', time_role: 'observation',
      field_definitions: [{ field_code: 'value', data_type: 'decimal', unit_code: 'percent', measurement_nature: derived ? 'derived' : 'stock', time_role: 'observation' }],
      semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: derived ? 'deterministic_derived' : 'observed_fact',
        time: { period_type: 'natural', frequency: 'month', interval: 'half_open', timezone: 'UTC' } },
      ...(derived ? { algorithm_definition: task.result.algorithmDefinition } : {}) } };
  const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc', precision: 'day', sourceTimezone: 'UTC',
    fields: [{ fieldCode: 'value', value: valueColumn, state: 'value_state' }] };
  const values = { role: derived ? 'calculated_result' : 'financial_record', informationNature: derived ? 'deterministic_derived' : 'observed_fact',
    businessObject: 'synthetic macro series', objectTime: 'explicit January source versions', purpose: source.usage_scope, structureGranularity: 'one explicitly selected scalar' };
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: values[key], evidence: [{ source: 'operator', field: key, quote: values[key] }] }]));
  const planned = await host.call('/processing/plans', { requestId, input: {
    routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'calculated', materialIds: [materialId], intendedAction: 'publish',
      tables: [{ materialId, format: 'json', types: { value: 'decimal_string' } }], target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: parent } }] } }, 202);
  const plannedTask = await host.settled(planned.jobId); assert.equal(plannedTask.status, 'succeeded', JSON.stringify(plannedTask.error));
  const planId = host.services.processing!.getByTask(plannedTask.id)!.plan!.planId;
  const run = await host.call('/processing/plans/' + planId + '/run', { requestId: requestId + '-run' }, 202);
  assert.equal((await host.settled(run.jobId)).status, 'succeeded');
  return { requestId: requestId + '-prepare', planId, outputId: 'calculated', source, target, mapping };
}

test('unified fixed routes use real small WFD records; candidate provenance applies to every R1 preparation', { skip: !enabled, timeout: 300_000 }, async () => {
  const prior = process.env.FIXED_COMPUTATION_FIXTURE;
  const fixture: FullChainFixture = prior ? JSON.parse(readFileSync(join(prior, 'fixture.json'), 'utf8')) : createFullChainFixture({ name: 'unified-fixed-small', machine: true,
    units: { count: { dimension: 'quantity' }, text: { dimension: 'text' }, date: { dimension: 'date' },
      percent: { dimension: 'ratio' }, srcunit_5YWD: { dimension: 'number' } } });
  if (!prior) {
    const path = join(fixture.runtime, 'config/machine.bindings.json'), binding = JSON.parse(readFileSync(path, 'utf8'));
    binding.resources.polars_python = { kind: 'program', path: process.env.POLARS_PYTHON }; binding.revision++;
    writeFileSync(path, JSON.stringify(binding, null, 2)); writeFileSync(join(fixture.root, 'fixture.json'), JSON.stringify(fixture, null, 2));
  }
  const host = await openFullChainHost(fixture), proof: Record<string, any> = { fixture: fixture.root };
  try {
    const macro = await auto(host, 'fixed-macro-source', macroBytes()), association = macro.currentRequest.local.associations[0];
    const page = await host.call('/computation/records', { snapshotId: association.snapshot_id, productId: association.product_id });
    const ref = (key: string) => {
      const row = page.rows.find((row: any) => row.businessKey === key); assert.ok(row);
      return { snapshotId: page.snapshotId, productId: page.productId, businessKey: row.businessKey, recordVersion: row.recordVersion };
    };
    const macroInput = { requestId: 'fixed-macro-task', method: 'macro_yoy', calculation: { version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents',
      knowledgeCutoff: '2026-03-01T00:00:00Z', inputs: [ref('macro-current'), ref('macro-prior')] } };
    const calculated = await calculate(host, macroInput); assert.equal(calculated.result.rows[0].value, '20.00000000');
    assert.equal((await host.call('/computation/tasks', macroInput, 202)).task.id, calculated.task.id);
    const staged = await host.call('/computation/tasks/' + calculated.task.id + '/stage', {}, 202);
    assert.equal((await host.settled(staged.candidate.custodyTaskId)).status, 'succeeded');
    const candidate = await host.call('/computation/tasks/' + calculated.task.id), materialId = candidate.candidate.materialId;
    assert.ok(materialId); proof.macro = candidate; proof.macroInput = macroInput;
    const baseline = process.env.FIXED_COMPUTATION_CAPTURE_BASELINE === '1';
    const forged = await planCandidate(host, candidate, materialId, baseline ? 'fixed-bypass-baseline' : 'fixed-bypass-protected', false);
    const response = await fetch(host.base + '/r1/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' }, body: JSON.stringify(forged) });
    proof.forged = { status: response.status, response: await response.json(), request: forged };
    writeFileSync(join(fixture.root, baseline ? 'baseline-bypass.json' : 'fixed-calculation-verification.json'), JSON.stringify(proof, null, 2));
    if (baseline) { assert.equal(response.status, 201, JSON.stringify(proof.forged)); return; }
    assert.equal(response.status, 409, JSON.stringify(proof.forged)); assert.equal(proof.forged.response.code, 'POLARS_DERIVED_CONTRACT');
    if (prior) {
      const original = host.services.r1!.attempt('fixed-bypass-baseline-prepare');
      let sends = 0;
      await assert.rejects(host.services.r1!.submitAndAssociate('fixed-bypass-baseline-prepare', {
        submit: async () => { sends++; throw new Error('Unexpected WFD send'); },
      } as never), (error: any) => error.code === 'POLARS_DERIVED_CONTRACT');
      assert.equal(sends, 0);
      await host.call('/r1/requests/fixed-bypass-baseline-prepare/submit', { confirmationDigest: original.document_sha256 }, 409);
      assert.equal(host.services.r1!.attempt('fixed-bypass-baseline-prepare').state, original.state);
      proof.preparedBeforeFix = { status: original.state, after: host.services.r1!.attempt('fixed-bypass-baseline-prepare').state, sends,
        code: 'POLARS_DERIVED_CONTRACT' };
    }
    const wrongMapping = await planCandidate(host, candidate, materialId, 'fixed-mapped-wrong-value', true, 'base_period');
    const wrongResponse = await fetch(host.base + '/r1/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mashiro-client': 'web' }, body: JSON.stringify(wrongMapping) });
    proof.wrongMapping = { status: wrongResponse.status, response: await wrongResponse.json() };
    assert.equal(wrongResponse.status, 409, JSON.stringify(proof.wrongMapping)); assert.equal(proof.wrongMapping.response.code, 'POLARS_CANDIDATE_CHANGED');
    writeFileSync(join(fixture.root, 'fixed-calculation-verification.json'), JSON.stringify(proof, null, 2));
    if (process.env.FIXED_COMPUTATION_GUARD_ONLY === '1') return;
    const before = (await host.call('/r1/products/snapshot', {})).snapshotId;
    const daily = [];
    for (const [first, last] of [[1, 10], [11, 11], [12, 22]]) {
      daily.push(await auto(host, 'fixed-daily-source-' + first, Buffer.from('交易日期,股票代码,股票名称,收盘价（元）\n'
        + Array.from({ length: last! - first! + 1 }, (_, i) => { const day = first! + i;
          return `202601${String(day).padStart(2, '0')},A,合成观测,${day}`; }).join('\n') + '\n')));
    }
    proof.incompleteDaily = await calculate(host, { requestId: 'fixed-daily-incomplete', method: 'observation_ma20',
      autoRequestIds: [daily[0]!.requestId, daily[2]!.requestId], valueColumn: '收盘价（元）' }, 'failed');
    assert.equal(proof.incompleteDaily.task.error.code, 'POLARS_SERIES_INCOMPLETE');
    proof.daily = await calculate(host, { requestId: 'fixed-daily-task', method: 'observation_ma20', autoRequestIds: daily.map(item => item.requestId), valueColumn: '收盘价（元）' });
    assert.equal(proof.daily.result.rows[19].value, '10.50000000');
    assert.equal(proof.daily.result.rows[21].value, '12.50000000');
    const financial = await auto(host, 'fixed-financial-source', financialBytes()), financialRef = financial.currentRequest.local.associations[0];
    const financialInput = (businessKey: string) => ({ snapshotId: financialRef.snapshot_id, productId: financialRef.product_id, businessKeys: [businessKey] });
    proof.financial = await calculate(host, { requestId: 'fixed-financial-task', method: 'financial_linear', calculation: { version: 'bd-financial-fixed/1', operation: 'quarter_difference',
      inputs: [financialInput('financial-current'), financialInput('financial-prior')] } });
    assert.equal(proof.financial.result.rows[0].value, '30.15');
    proof.ttm = await calculate(host, { requestId: 'fixed-ttm-task', method: 'financial_linear', calculation: { version: 'bd-financial-fixed/1', operation: 'ttm',
      inputs: [financialInput('financial-fy'), financialInput('financial-current'), financialInput('financial-ytd')] } });
    assert.equal(proof.ttm.result.rows[0].value, '510.25');
    proof.inputs = await host.call('/computation/inputs'); proof.capabilities = await host.call('/computation/capabilities');
    assert.ok(proof.inputs.sources.some((item: any) => item.autoRequestId === 'fixed-daily-source-1' && item.valueColumns.includes('收盘价（元）')));
    assert.ok(proof.inputs.products.some((item: any) => item.methods.includes('financial_linear')));
    assert.ok(proof.inputs.products.some((item: any) => item.methods.includes('macro_yoy')));
    assert.equal(proof.capabilities.query.registeredCalculationMethods, 0);
    await host.call('/computation/tasks', { ...macroInput, requestId: 'fixed-no-override', implementation: 'duckdb' }, 409);
    const prepare = await planCandidate(host, candidate, materialId, 'fixed-derived-valid', true);
    const prepared = await host.call('/r1/prepare', prepare, 201);
    proof.prepared = prepared;
    // An independently assembled R1 service may not silently treat a managed computed candidate as an ordinary original.
    const saved = host.services.r1!.attempt(prepared.requestId), document = JSON.parse(String(saved.document_json)), outputDocument = document.outputs[0];
    const independent = new R1HandoffService({ database: host.database, materials: host.services.materials, processing: host.services.processing });
    const structured: R1StructuredRequest = { ...prepare.target, requestId: 'fixed-verifier-unbound', namespace: document.request_identity.trusted_actor_namespace,
      producerNamespace: document.producer_namespace, submissionDigest: document.request_identity.submission_digest, payload: outputDocument.payload };
    const refs = JSON.parse(String(saved.local_refs_json));
    for (const process of refs.processRefs) process.document_sha256 = wfdSha256(canonicalWfdJson(buildStructuredIngestDocument(structured)));
    assert.throws(() => independent.prepare({ structured, localRefs: refs }), (error: any) => error.code === 'R1_CALCULATION_VERIFIER_UNBOUND');
    proof.unboundVerifier = 'R1_CALCULATION_VERIFIER_UNBOUND';
    const submit = await host.call('/r1/requests/' + prepared.requestId + '/submit', { confirmationDigest: prepared.documentSha256 }, 202);
    const committed = await host.settled(submit.jobId); assert.equal(committed.status, 'succeeded', JSON.stringify(committed.error));
    proof.published = await host.call('/r1/requests/' + prepared.requestId);
    assert.equal(proof.published.state, 'associated');
    const output = proof.published.local.associations[0]; proof.fixedRead = await host.call('/r1/products/read', { snapshotId: output.snapshot_id, productId: output.product_id });
    assert.equal(proof.fixedRead.result.rows[0].values.value.value, '20');
    proof.before = before;
    writeFileSync(join(fixture.root, 'fixed-calculation-verification.json'), JSON.stringify(proof, null, 2));
  } finally { await host.close(); }
});
