import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import type { FinancialCalculation } from '../../modules/collection/data-processing/financial-fixed.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const namespace = 'full.chain.test';
const subject = { kind: 'entity', namespace, id: 'synthetic_financial_subject' };
const second = (at: string) => ({ status: 'known', precision: 'second', earliest_utc: at,
  latest_exclusive_utc: new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' });
const values = { subject_scheme: 'synthetic', subject_code: 'company', accounting_standard: 'CAS', currency: 'CNY', scope: 'consolidated',
  unit: 'cny', concept: '其中：营业收入', report_id: 'synthetic-report', report_version: 'v1', dimension: 'group', period_type: 'duration',
  start_date: '2024-01-01', end_date: '2024-03-31', value: '9007199254740993.1200',
  report_nature: 'formal', fiscal_calendar: 'declared-calendar-year', comparability_basis: 'synthetic-same-accounting-basis' };
const definition = { semantic_code: 'synthetic.financial.compatible', measurement_nature: 'mixed_observation', unit_code: 'per_field',
  definition_authority: namespace, time_role: 'observation',
  semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
    time: { period_type: 'natural', frequency: 'year', interval: 'half_open', timezone: 'UTC' } },
  field_definitions: Object.keys(values).map(field_code => ({ field_code, data_type: field_code === 'value' ? 'decimal' : 'text',
    unit_code: field_code === 'value' ? 'cny' : 'text', measurement_nature: 'flow', time_role: 'observation' })) };
function row(key: string, changes: Partial<typeof values> = {}, at = '2025-01-02T00:00:00Z') {
  return { business_key: key, subject, public_time: second(at), observation_time: { status: 'known', precision: 'day',
    earliest_utc: '2024-01-01T00:00:00Z', latest_exclusive_utc: '2025-01-01T00:00:00Z', source_timezone: 'UTC' },
  values: Object.fromEntries(Object.entries({ ...values, ...changes }).map(([key, value]) => [key,
    { data_type: key === 'value' ? 'decimal' : 'text', value_state: 'valid_value', value }])) };
}
function doc(requestId: string, rows: WfdRecord[], parent: string | null = null, revision?: { previous: WfdRecord; definitionRef: WfdRecord }) {
  return buildStructuredIngestDocument({ requestId, datasetId: 'synthetic_financial', namespace, producerNamespace: namespace,
    submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ requestId, rows, parent })), expectedParentSnapshotId: parent,
    outputKey: 'financial', subject, definition, definitionPublicTime: second('2023-01-01T00:00:00Z'),
    inputMode: revision ? 'source_correction' : 'partial_observation',
    ...(revision ? { definitionMode: 'reuse', definitionRef: revision.definitionRef,
      revisions: { q2: { previous: revision.previous, reason: 'Explicit synthetic corrected report' } } } : {}),
    coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows } });
}
async function publish(host: FullChainHost, document: WfdRecord) {
  const result = (await host.services.r1Runtime!.client.submit(document)).result;
  assert.equal(result.state, 'published_formal', JSON.stringify(result));
  return { snapshotId: String(result.snapshot_id), output: (result.output_results as WfdRecord[])[0]! };
}
async function prepare(host: FullChainHost, materialId: string, calculation: FinancialCalculation, id: string) {
  const created = await host.call('/processing/plans', { requestId: id + '-plan', input: {
    routing: { materials: [{ materialId, intendedAction: 'inspect' }] },
    outputs: [{ outputId: 'financial', materialIds: [materialId], intendedAction: 'inspect', stages: ['parse'],
      tables: [{ materialId, format: 'financial-fixed', financialCalculation: calculation }] }],
  } }, 202);
  const task = await host.settled(created.jobId);
  assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  const plan = host.services.processing!.getByTask(task.id)!.plan!;
  const step = plan.steps.find(step => step.kind === 'parse')!;
  const accepted = await host.call(`/processing/plans/${plan.planId}/steps/${step.stepId}/execute`, { requestId: id + '-execute' }, 202);
  const execution = await host.settled(accepted.jobId);
  return { planId: plan.planId, stepId: step.stepId, execution };
}

test('actual HTTP financial processing reads one historical basis from WFD, keeps exact values and rejects missing periods',
  { skip: !enabled ? 'Requires explicit WFD_PYTHON and isolated full-chain root.' : false, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'financial-compatible', machine: true,
      units: { cny: { dimension: 'money' }, text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    try {
      const first = await publish(host, doc('financial-original', [row('q1'), row('q2', { end_date: '2024-06-30', value: '20.0000' }),
        row('bad-scope', { end_date: '2024-06-30', scope: 'parent_only' })]));
      const productId = String(first.output.product_id);
      const read = await host.call('/r1/products/read', { snapshotId: first.snapshotId, productId });
      const q2 = read.result.rows.find((item: WfdRecord) => (item.record_ref as WfdRecord).logical_key === 'q2');
      const correction = await publish(host, doc('financial-correction', [row('q2', { end_date: '2024-06-30', value: '25.0000',
        report_version: 'v2', report_nature: 'correction' }, '2025-03-01T00:00:00Z')], first.snapshotId,
      { previous: q2.record_ref, definitionRef: first.output.definition_ref as WfdRecord }));
      const uploaded = await host.upload('synthetic-financial-instruction.csv', 'data', Buffer.from('kind\nsynthetic financial selection\n'), 'financial-material');
      const upload = await host.settled(uploaded.jobId);
      assert.equal(upload.status, 'succeeded');
      const materialId = host.services.materials!.getByTask(upload.id)!.envelope.materialId;
      const calculation: FinancialCalculation = { version: 'bd-financial-fixed/1', operation: 'standardize',
        inputs: [{ snapshotId: correction.snapshotId, productId, businessKeys: ['q1', 'q2'] }],
        history: { historyMode: 'market_known_at', at: '2025-02-01T00:00:00Z' },
        compatibleInputs: { periodType: 'duration', periods: [
          { startDate: '2024-01-01', endDate: '2024-03-31' }, { startDate: '2024-01-01', endDate: '2024-06-30' }] } };
      const completed = await prepare(host, materialId, calculation, 'financial-before-correction');
      assert.equal(completed.execution.status, 'succeeded', JSON.stringify(completed.execution.error));
      const artifact = JSON.parse(host.services.processing!.artifact(completed.planId, completed.stepId).bytes.toString());
      assert.equal(artifact.financial_evidence.historicalQualification, 'market_known_at');
      assert.equal(artifact.financial_evidence.compatibility.calculation, 'not_requested');
      const column = artifact.columns.indexOf('value');
      assert.deepEqual(artifact.rows.map((row: any[]) => row[column].value).sort(), ['20.0000', '9007199254740993.1200']);
      const later = await prepare(host, materialId, { ...calculation, history: { historyMode: 'market_known_at', at: '2025-04-01T00:00:00Z' } }, 'financial-after-correction');
      assert.equal(later.execution.status, 'succeeded', JSON.stringify(later.execution.error));
      const laterArtifact = JSON.parse(host.services.processing!.artifact(later.planId, later.stepId).bytes.toString());
      assert.deepEqual(laterArtifact.rows.map((row: any[]) => row[column].value).sort(), ['25.0000', '9007199254740993.1200']);
      const missing = await prepare(host, materialId, { ...calculation, compatibleInputs: { periodType: 'duration', periods: [
        ...calculation.compatibleInputs!.periods, { startDate: '2024-01-01', endDate: '2024-09-30' }] } }, 'financial-missing-period');
      assert.equal(missing.execution.status, 'failed');
      assert.match(JSON.stringify(missing.execution.error), /期间缺失/u);
      const mixed = await prepare(host, materialId, { ...calculation, inputs: [
        { snapshotId: correction.snapshotId, productId, businessKeys: ['q1', 'bad-scope'] }] }, 'financial-mixed-scope');
      assert.equal(mixed.execution.status, 'failed', 'Actual published rows with different consolidation scope are incompatible');
      assert.match(JSON.stringify(mixed.execution.error), /不一致/u);
      const future = await prepare(host, materialId, { ...calculation, history: { historyMode: 'market_known_at', at: '2024-12-01T00:00:00Z' } }, 'financial-not-public');
      assert.equal(future.execution.status, 'failed', 'Cannot substitute latest for unavailable historical inputs');
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual(JSON.parse(host.services.processing!.artifact(completed.planId, completed.stepId).bytes.toString()), artifact);
    } finally { await host.close(); }
  });

test('actual HTTP standardization rejects impossible financial periods without compatibility opt-in',
  { skip: !enabled ? 'Requires explicit WFD_PYTHON and isolated full-chain root.' : false, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'financial-period-quality', machine: true,
      units: { cny: { dimension: 'money' }, text: { dimension: 'text' } } });
    const host = await openFullChainHost(fixture);
    try {
      // These are valid text cells in WFD, not valid financial periods. No original/source timestamps are altered.
      const cases = [
        { key: 'impossible-end', changes: { end_date: '2024-02-30' } },
        { key: 'impossible-start', changes: { start_date: '2024-02-30' } },
        { key: 'reversed', changes: { start_date: '2024-04-01', end_date: '2024-03-31' } },
        { key: 'instant-range', changes: { concept: '资产总计', period_type: 'instant', start_date: '2024-01-01', end_date: '2024-03-31' } },
      ];
      const published = await publish(host, doc('financial-period-source', [row('valid'), ...cases.map(item => row(item.key, item.changes))]));
      const uploaded = await host.upload('synthetic-period-instruction.csv', 'data', Buffer.from('kind\nsynthetic period validation\n'), 'period-material');
      const task = await host.settled(uploaded.jobId); assert.equal(task.status, 'succeeded');
      const materialId = host.services.materials!.getByTask(task.id)!.envelope.materialId;
      const selection = (key: string): FinancialCalculation => ({ version: 'bd-financial-fixed/1', operation: 'standardize',
        inputs: [{ snapshotId: published.snapshotId, productId: String(published.output.product_id), businessKeys: [key] }] });
      const valid = await prepare(host, materialId, selection('valid'), 'valid-period');
      assert.equal(valid.execution.status, 'succeeded', JSON.stringify(valid.execution.error));
      for (const item of cases) {
        const invalid = await prepare(host, materialId, selection(item.key), item.key);
        assert.equal(invalid.execution.status, 'failed', item.key + ' must not generate inferred or impossible timestamps');
        assert.match(JSON.stringify(invalid.execution.error), /期间/u);
      }
      const read = await host.call('/r1/products/read', { snapshotId: published.snapshotId, productId: String(published.output.product_id) });
      assert.equal(read.result.rows.length, cases.length + 1, 'Quality rejection must not delete or rewrite source claims');
    } finally { await host.close(); }
  });
