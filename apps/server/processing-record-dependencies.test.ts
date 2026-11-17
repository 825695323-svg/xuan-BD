import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
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
    outputKey: 'financial', subject, definition,
    inputMode: revision ? 'source_correction' : 'partial_observation',
    ...(revision ? { definitionMode: 'reuse', definitionRef: revision.definitionRef,
      revisions: { q1: { previous: revision.previous, reason: 'Explicit synthetic corrected report' } } } : {}),
    coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows } });
}
async function publish(host: FullChainHost, document: WfdRecord) {
  const result = (await host.services.r1Runtime!.client.submit(document)).result;
  assert.equal(result.state, 'published_formal', JSON.stringify(result));
  return { snapshotId: String(result.snapshot_id), output: (result.output_results as WfdRecord[])[0]! };
}
test('verified fixed record dependencies remain parse candidates, read-only and stable after reopening',
  { skip: !enabled, timeout: 180_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'record-dependencies', machine: true,
    units: { cny: { dimension: 'money' }, text: { dimension: 'text' } } });
  let host = await openFullChainHost(fixture);
  try {
    const published = await publish(host, doc('record-input', [row('q1')]));
    const productId = String(published.output.product_id);
    const read = await host.call('/r1/products/read', { snapshotId: published.snapshotId, productId });
    const sourceRef = read.result.rows[0].record_ref;
    const upload = await host.upload('instruction.csv', 'data', Buffer.from('kind\nsynthetic\n'), 'record-material');
    assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
    const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
    const created = await host.call('/processing/plans', { requestId: 'record-plan', input: {
      routing: { materials: [{ materialId, intendedAction: 'inspect' }] },
      outputs: [{ outputId: 'financial', materialIds: [materialId], intendedAction: 'inspect',
        stages: ['parse', 'structure', 'annotate', 'check'], tables: [{ materialId, format: 'financial-fixed',
          types: { value: 'decimal_string' }, financialCalculation: { version: 'bd-financial-fixed/1', operation: 'standardize',
            inputs: [{ snapshotId: published.snapshotId, productId, businessKeys: ['q1'] }] } }] }],
    } }, 202);
    const accepted = await host.settled(created.jobId);
    assert.equal(accepted.status, 'succeeded', JSON.stringify(accepted.error));
    const planId = host.services.processing!.getByTask(accepted.id)!.plan!.planId;
    for (const kind of ['parse', 'structure', 'annotate', 'check']) {
      const step = host.services.processing!.get(planId).steps.find(item => item.kind === kind)!;
      const task = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: `record-${kind}` }, 202);
      const done = await host.settled(task.jobId);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    }
    const correction = await publish(host, doc('record-correction', [row('q1', { value: '25.0000', report_version: 'v2' },
      '2025-03-01T00:00:00Z')], published.snapshotId,
      { previous: sourceRef, definitionRef: published.output.definition_ref as WfdRecord }));
    const current = await host.call('/r1/products/read', { snapshotId: correction.snapshotId, productId });
    assert.notEqual(current.result.rows[0].record_ref.revision_id, sourceRef.revision_id);
    const counts = () => ['tasks', 'processing_plans', 'candidate_objects'].map(table =>
      host.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    const before = counts();
    const result = await host.call(`/processing/plans/${planId}/outputs/financial/dependencies`);
    assert.equal(result.complete, false, 'Record references do not imply complete field lineage');
    assert.equal(result.recordDependencies.coverage, 'verified_parse_candidates_only');
    assert.equal(result.recordDependencies.publishedProductQualification, 'not_asserted');
    assert.equal(result.recordDependencies.downstreamImpact, 'unknown');
    assert.deepEqual(result.recordDependencies.gaps, []);
    assert.equal(result.recordDependencies.edges.length, 1);
    assert.deepEqual(result.recordDependencies.edges[0].sourceRecordRef, sourceRef);
    assert.equal(JSON.stringify(result).includes(values.value), false);
    const impactRequest = { recordRefs: [sourceRef, current.result.rows[0].record_ref] };
    const impact = await host.call(`/processing/plans/${planId}/outputs/financial/dependencies`, impactRequest);
    assert.deepEqual(impact.recordImpact.results.map((item: any) => item.status), ['observed', 'not_observed']);
    assert.equal(impact.recordImpact.results[0].matches.length, 1);
    assert.equal(impact.recordImpact.results[1].matches.length, 0);
    assert.equal(impact.recordImpact.downstreamImpact, 'unknown');
    assert.equal(JSON.stringify(impact).includes(values.value), false);
    assert.deepEqual(counts(), before);
    await host.close(); host = await openFullChainHost(fixture);
    assert.deepEqual(await host.call(`/processing/plans/${planId}/outputs/financial/dependencies`), result);
    assert.deepEqual(await host.call(`/processing/plans/${planId}/outputs/financial/dependencies`, impactRequest), impact);
    host.database.connection.prepare("DELETE FROM processing_plan_steps WHERE plan_id=? AND kind='parse'").run(planId);
    const incomplete = await host.call(`/processing/plans/${planId}/outputs/financial/dependencies`, impactRequest);
    assert.deepEqual(incomplete.recordImpact.results.map((item: any) => item.status), ['unknown', 'unknown']);
    assert.ok(incomplete.recordImpact.gaps.some((gap: string) => gap.includes('persisted_step_missing')));
  } finally { await host.close(); }
});
