import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
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
test('selected fixed input observations link to an actual BD output publication, never row-level causation',
  { skip: !enabled, timeout: 180_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'output-publication-dependencies', machine: true,
    units: { cny: { dimension: 'money' }, text: { dimension: 'text' } } });
  let host = await openFullChainHost(fixture, fixture.root);
  try {
    const initial = await publish(host, doc('input', [row('q1')]));
    const sourceProduct = String(initial.output.product_id);
    const fixed = await host.call('/r1/products/read', { snapshotId: initial.snapshotId, productId: sourceProduct });
    const sourceRef = fixed.result.rows[0].record_ref;
    const bytes = Buffer.from('instruction\nexplicit synthetic financial selection\n');
    const upload = await host.upload('selection.csv', 'data', bytes, 'selected-material');
    assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
    const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
    const source = { source_id: 'synthetic-selection', provider: 'isolated synthetic fixture',
      requested_url: 'file:///explicit-synthetic-selection', requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-01T00:00:01Z',
      usage_scope: 'isolated standardization provenance test, not supplier evidence',
      authorization: { status: 'authorized', basis: 'explicit isolated fixture' } };
    const target = { datasetId: 'standardized_fixture', outputKey: 'standardized', expectedParentSnapshotId: initial.snapshotId,
      subject, definition: { ...definition, semantic_code: 'synthetic.standardized', field_definitions: definition.field_definitions.filter(f => ['value', 'concept'].includes(f.field_code)) },
      inputMode: 'partial_observation', coverage: { scope: { selected: 'q1' }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
    const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc',
      precision: 'day', sourceTimezone: 'UTC', fields: [{ fieldCode: 'value', value: 'value', state: 'value_state' },
        { fieldCode: 'concept', value: 'concept', state: 'metadata_state' }] };
    const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: key === 'informationNature' ? 'source_claim' : key === 'role' ? 'financial-record' : 'explicit synthetic selected financial source claim',
      evidence: [{ source: 'operator', field: key, quote: 'explicit synthetic selected financial source claim' }] }]));
    const creation = await host.call('/processing/plans', { requestId: 'standardized-plan', input: {
      routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
      outputs: [{ outputId: 'financial', materialIds: [materialId], intendedAction: 'publish', stages: ['parse', 'structure', 'annotate', 'check'],
        tables: [{ materialId, format: 'financial-fixed', types: { value: 'decimal_string' }, annotations: { metadata_state: 'valid_value' },
          financialCalculation: { version: 'bd-financial-fixed/1', operation: 'standardize',
            inputs: [{ snapshotId: initial.snapshotId, productId: sourceProduct, businessKeys: ['q1'] }] } }],
        target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: initial.snapshotId } }] } }, 202);
    const task = await host.settled(creation.jobId); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
    const planId = host.services.processing!.getByTask(task.id)!.plan!.planId;
    for (const step of host.services.processing!.get(planId).steps) {
      const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: 'execute-' + step.stepId }, 202);
      const done = await host.settled(run.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    }
    const candidate = host.services.processing!.get(planId).outputs[0]!;
    assert.equal(candidate.publishEligible, true, JSON.stringify(candidate));
    const requestId = 'selected-publication';
    const prepared = await host.call('/r1/prepare', { requestId, planId, outputId: 'financial', source, target, mapping }, 201);
    const path = `/r1/requests/${requestId}/output-dependencies`;
    const input = { planId, outputId: 'financial', recordRefs: [sourceRef] };
    assert.equal((await host.call(path, input, 409)).code, 'R1_OUTPUT_DEPENDENCIES_NOT_ASSOCIATED');
    const submitted = await host.call(`/r1/requests/${requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
    const done = await host.settled(submitted.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    const published = await host.call(`/r1/requests/${requestId}`); assert.equal(published.state, 'associated');
    const counts = () => ['tasks', 'processing_plans', 'candidate_objects', 'r1_record_associations'].map(table =>
      host.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    const before = counts(), snapshot = (await host.services.r1Runtime!.connection.client.snapshotStatus()).result;
    const result = await host.call(path, input);
    assert.equal(result.publication.status, 'fixed_output_publication_verified');
    assert.equal(result.inputObservations.results[0].status, 'observed');
    assert.deepEqual(result.inputObservations.results[0].sourceRecordRef, sourceRef);
    assert.equal(result.publication.records.length, 1);
    const association = published.local.associations[0];
    assert.deepEqual(result.publication.records[0], { snapshot_id: association.snapshot_id, product_id: association.product_id,
      logical_key: association.record_id, revision_id: association.record_version });
    assert.equal(result.rowAttribution, 'unknown'); assert.equal(result.fullDownstreamImpact, 'unknown');
    assert.equal(JSON.stringify(result).includes(values.value), false);
    assert.deepEqual(counts(), before); assert.deepEqual((await host.services.r1Runtime!.connection.client.snapshotStatus()).result, snapshot);
    assert.equal((await host.call(path, { ...input, outputId: 'another' }, 409)).code, 'R1_OUTPUT_DEPENDENCIES_REQUEST');
    assert.equal((await host.call(path, { ...input, recordRefs: [...input.recordRefs, ...input.recordRefs] }, 409)).code, 'PROCESSING_RECORD_IMPACT_INPUT');
    assert.equal((await host.call(path, { ...input, recordRefs: Array.from({ length: 129 }, (_, i) => ({ ...sourceRef, logical_key: 'key-' + i })) }, 409)).code, 'PROCESSING_RECORD_IMPACT_INPUT');
    const connection = host.database.connection;
    const frozenAttempt = connection.prepare('SELECT local_refs_json,local_refs_sha256 FROM r1_handoff_attempts WHERE request_id=?').get(requestId)!;
    const wrongRefs = JSON.parse(String(frozenAttempt.local_refs_json));
    wrongRefs.processRefs[0].output_sha256 = '0'.repeat(64);
    const wrongJson = canonicalWfdJson(wrongRefs);
    connection.prepare('UPDATE r1_handoff_attempts SET local_refs_json=?,local_refs_sha256=? WHERE request_id=?')
      .run(wrongJson, wfdSha256(wrongJson), requestId);
    assert.equal((await host.call(path, input, 409)).code, 'R1_OUTPUT_DEPENDENCIES_OUTPUT_CHANGED');
    connection.prepare('UPDATE r1_handoff_attempts SET local_refs_json=?,local_refs_sha256=? WHERE request_id=?')
      .run(frozenAttempt.local_refs_json, frozenAttempt.local_refs_sha256, requestId);
    connection.prepare('UPDATE r1_record_associations SET snapshot_id=? WHERE request_id=?').run(initial.snapshotId, requestId);
    assert.equal((await host.call(path, input, 409)).code, 'R1_OUTPUT_DEPENDENCIES_ASSOCIATION');
    connection.prepare('UPDATE r1_record_associations SET snapshot_id=? WHERE request_id=?').run(association.snapshot_id, requestId);
    // A real new input version does not become a match for an old persisted parse edge.
    const corrected = await publish(host, doc('input-correction', [row('q1', { value: '25', report_version: 'v2' })], String(association.snapshot_id),
      { previous: sourceRef, definitionRef: initial.output.definition_ref as WfdRecord }));
    const newer = await host.call('/r1/products/read', { snapshotId: corrected.snapshotId, productId: sourceProduct });
    assert.equal((await host.call(path, { ...input, recordRefs: [newer.result.rows[0].record_ref] })).inputObservations.results[0].status, 'not_observed');
    // Unknown sending state cannot silently appear as no publication.
    host.database.connection.prepare("UPDATE r1_handoff_attempts SET state='pending_unknown' WHERE request_id=?").run(requestId);
    assert.equal((await host.call(path, input, 409)).code, 'R1_OUTPUT_DEPENDENCIES_NOT_ASSOCIATED');
    host.database.connection.prepare("UPDATE r1_handoff_attempts SET state='associated' WHERE request_id=?").run(requestId);
    await host.close(); host = await openFullChainHost(fixture, fixture.root);
    assert.deepEqual(await host.call(path, input), result);
    // Scoped generation change during the real fixed read rejects the late result.
    const client = host.services.r1Runtime!.client, originalRead = client.fixedReadHistory.bind(client);
    const control = host.services.tasks.getControl.bind(host.services.tasks);
    let changed = false;
    client.fixedReadHistory = async (...args) => { const response = await originalRead(...args); changed = true; return response; };
    host.services.tasks.getControl = () => ({ ...control(), generation: control().generation + (changed ? 1 : 0) });
    assert.equal((await host.call(path, input, 409)).code, 'R1_OUTPUT_DEPENDENCIES_CHANGED');
    client.fixedReadHistory = originalRead; host.services.tasks.getControl = control;
    // The real HTTP private-data gate rejects a changed generation after the WFD await.
    // Only this isolated lifecycle DB is fault-injected; no user data is disabled.
    const lifecycle = new DatabaseSync(join(fixture.root, 'lifecycle.sqlite'));
    client.fixedReadHistory = async (...args) => {
      const response = await originalRead(...args); lifecycle.exec('UPDATE local_data_lifecycle SET generation=2'); return response;
    };
    try {
      const denied = await host.call(path, input, 409);
      assert.equal(denied.code, 'STALE_LOCAL_DATA_GENERATION'); assert.ok(!('publication' in denied));
    } finally {
      client.fixedReadHistory = originalRead; lifecycle.exec('UPDATE local_data_lifecycle SET generation=1'); lifecycle.close();
    }
    const afterSetup = counts();
    // Association drift during the same real fixed read also prevents returning stale provenance.
    client.fixedReadHistory = async (...args) => {
      const response = await originalRead(...args);
      host.database.connection.prepare('UPDATE r1_record_associations SET snapshot_id=? WHERE request_id=?').run(initial.snapshotId, requestId);
      return response;
    };
    try { assert.equal((await host.call(path, input, 409)).code, 'R1_OUTPUT_DEPENDENCIES_CHANGED'); }
    finally {
      client.fixedReadHistory = originalRead;
      host.database.connection.prepare('UPDATE r1_record_associations SET snapshot_id=? WHERE request_id=?').run(association.snapshot_id, requestId);
    }
    assert.deepEqual(counts(), afterSetup);
    // Missing actual artifact is an explicit error, not an invented empty impact or deleted formal record.
    const db = host.database.connection;
    const step = db.prepare("SELECT step_id FROM processing_plan_steps WHERE plan_id=? AND kind='parse'").get(planId)!;
    db.prepare('UPDATE processing_plan_steps SET output_json=NULL WHERE plan_id=? AND step_id=?').run(planId, step.step_id);
    const failed = await host.call(path, input, 409); assert.equal(failed.code, 'PROCESSING_STEP_NOT_READY');
    assert.equal(db.prepare('SELECT count(*) AS n FROM r1_record_associations WHERE request_id=?').get(requestId)!.n, 1);
  } finally { await host.close(); }
});
