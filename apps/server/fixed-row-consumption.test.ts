import assert from 'node:assert/strict';
import { fixedRowConsumption } from '../../modules/collection/r1-fixed-row-consumption.js';
import type { ProcessingPlanService } from '../../modules/collection/processing-plan.js';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { prepareOutputFixture, publish, doc, row } from './output-publication-test-support.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
test('real BD standardize publication proves exact unchanged row consumption without changing legacy output observations',
  { skip: !enabled, timeout: 180_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'fixed-row-consumption', machine: true,
    units: { cny: { dimension: 'money' }, text: { dimension: 'text' } } });
  let host = await openFullChainHost(fixture, fixture.root);
  try {
    const f = await prepareOutputFixture(host, true);
    const path = `/r1/requests/${f.requestId}/fixed-row-consumption`;
    assert.equal((await host.call(path, f.input, 409)).code, 'R1_OUTPUT_DEPENDENCIES_NOT_ASSOCIATED');
    const submit = await host.call(`/r1/requests/${f.requestId}/submit`, { confirmationDigest: f.prepared.documentSha256 }, 202);
    assert.equal((await host.settled(submit.jobId)).status, 'succeeded');
    const counts = () => ['tasks', 'processing_plans', 'candidate_objects', 'r1_record_associations'].map(table =>
      host.database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    const before = counts();
    const result = await host.call(path, f.input);
    assert.equal(result.schema, 'bd.fixed-row-consumption/1');
    assert.equal(result.results[0].status, 'consumed', JSON.stringify(result));
    assert.deepEqual(result.results[0].sourceRecordRef, f.sourceRef);
    assert.deepEqual(result.results[0].outputRecords, result.publication.records);
    assert.equal(result.fullDownstreamImpact, 'unknown');
    const sourceRead = (await host.services.r1Runtime!.client.fixedReadHistory(f.initial.snapshotId, f.sourceProduct)).result;
    const sourceDefinition = (sourceRead.products as WfdRecord[]).find(p => p.product_id === f.sourceProduct)!.definition_ref as WfdRecord;
    // Helper-level unsupported transformations use the same real persisted fixture, not fabricated positive evidence.
    const processing = host.services.processing!;
    const actualCandidate = processing.candidateOutput(f.planId, 'financial');
    const actualArtifact = processing.outputArtifact(f.planId, 'financial');
    const target = actualCandidate.target!;
    const frozen = JSON.parse(String(host.database.connection.prepare('SELECT document_json FROM r1_handoff_attempts WHERE request_id=?').get(f.requestId)!.document_json));
    const checkUnsupported = (overrides: Partial<ProcessingPlanService>) => {
      const proxy = new Proxy(processing, { get(object, key) { const method = (overrides as any)[key] ?? (object as any)[key]; return typeof method === 'function' ? method.bind(object) : method; } });
      const checked = fixedRowConsumption(proxy, f.planId, 'financial', host.services.r1Runtime!.currentIdentity(), frozen.outputs[0].payload.rows);
      assert.equal(checked.status, 'unknown'); assert.deepEqual(checked.edges, []);
    };
    for (const change of [
      (v: any) => { delete v.rows[0].business_key; },
      (v: any) => { v.rows.push(structuredClone(v.rows[0])); },
      (v: any) => { v.rows[0].value = '99'; },
    ]) {
      const value = JSON.parse(actualArtifact.bytes.toString()); change(value);
      const bytes = Buffer.from(canonicalWfdJson(value));
      checkUnsupported({ outputArtifact: () => ({ ...actualArtifact, bytes }),
        candidateOutput: () => ({ ...actualCandidate, ref: { ...actualCandidate.ref, sha256: wfdSha256(bytes) } }) });
    }
    checkUnsupported({ candidateOutput: () => ({ ...actualCandidate, target: { ...target,
      declaration: { ...(target.declaration as any), mapping: { ...(target.declaration as any).mapping, businessKey: 'original_concept' } } } }) });
    const actualPlan = processing.get(f.planId);
    checkUnsupported({ get: () => ({ ...actualPlan, steps: [...actualPlan.steps, { ...actualPlan.steps[0]!, stepId: 'another-parse' }] }) });
    checkUnsupported({ get: () => ({ ...actualPlan, steps: actualPlan.steps.map(s => s.kind === 'check' ? { ...s, dependsOn: [] } : s) }) });
    checkUnsupported({ get: () => ({ ...actualPlan, steps: actualPlan.steps.map(s => s.kind === 'parse' ? { ...s, parameters: { ...s.parameters, selection: { predicate: 'unknown' } } } : s) }) });
    const corrected = await publish(host, doc('source-r2', [row('q1', { value: '25', report_version: 'v2' })], result.publication.snapshotId,
      { previous: f.sourceRef, definitionRef: sourceDefinition }));
    const newer = await host.call('/r1/products/read', { snapshotId: corrected.snapshotId, productId: f.sourceProduct });
    const newerRef = newer.result.rows[0].record_ref;
    const mixed = await host.call(path, { ...f.input, recordRefs: [f.sourceRef, newerRef] });
    assert.deepEqual(mixed.results.map((r: any) => r.status), ['consumed', 'not_observed']);
    const otherPublication = await publish(host, doc('other-source', [row('q1')], corrected.snapshotId, undefined, 'synthetic.independent.source'));
    const otherRead = await host.call('/r1/products/read', { snapshotId: otherPublication.snapshotId, productId: String(otherPublication.output.product_id) });
    const otherRef = otherRead.result.rows.find((r: any) => r.record_ref.logical_key === 'q1').record_ref;
    assert.notEqual(otherRef.product_id, f.sourceRef.product_id);
    assert.equal(otherRef.logical_key, f.sourceRef.logical_key);
    assert.deepEqual((await host.call(path, { ...f.input, recordRefs: [otherRef, f.sourceRef] })).results.map((r: any) => r.status), ['not_observed', 'consumed']);
    assert.notEqual(f.sourceRef.revision_id, result.results[0].outputRecords[0].revision_id);
    assert.equal((await host.call(f.path, f.input)).rowAttribution, 'unknown');
    assert.deepEqual(counts(), before);
    // Isolated ordinary damaged/missing evidence, not an alternate authorization or successful fabricated publication.
    let db = host.database.connection;
    const step = db.prepare("SELECT * FROM processing_plan_steps WHERE plan_id=? AND kind='parse'").get(f.planId)!;
    const original = JSON.parse(host.services.processing!.artifact(f.planId, String(step.step_id)).bytes.toString());
    for (const change of [
      (v: any) => { delete v.financial_evidence.connection; },
      (v: any) => { v.financial_evidence.connection.runtimeIdentity = 'different-instance'; },
      (v: any) => { const i=v.columns.indexOf('value'); v.rows[0][i].original='99'; v.rows[0][i].value='99'; },
    ]) {
      const value = structuredClone(original); change(value);
      const ref = host.services.candidates!.saveObject(Buffer.from(canonicalWfdJson(value)), 'application/json');
      db.prepare('UPDATE processing_plan_steps SET output_json=?,output_digest=? WHERE plan_id=? AND step_id=?')
        .run(canonicalWfdJson(ref), ref.sha256, f.planId, step.step_id);
      const denied = await host.call(path, f.input);
      assert.equal(denied.results[0].status, 'unknown'); assert.deepEqual(denied.results[0].outputRecords, []);
    }
    // Unsupported persisted evidence remains unknown after opening a new service, not merely in one process cache.
    await host.close(); host = await openFullChainHost(fixture, fixture.root); db = host.database.connection;
    const reopenedUnknown = await host.call(path, f.input);
    assert.equal(reopenedUnknown.results[0].status, 'unknown');
    assert.deepEqual(reopenedUnknown.results[0].outputRecords, []);
    db.prepare('UPDATE processing_plan_steps SET output_json=?,output_digest=? WHERE plan_id=? AND step_id=?')
      .run(step.output_json, step.output_digest, f.planId, step.step_id);
    const params = JSON.parse(String(step.parameters_json));
    db.prepare('UPDATE processing_plan_steps SET parameters_json=? WHERE plan_id=? AND step_id=?')
      .run(canonicalWfdJson({ ...params, financialReaderBinding: '0'.repeat(64) }), f.planId, step.step_id);
    assert.equal((await host.call(path, f.input)).results[0].reason, 'input_instance_not_verified');
    db.prepare('UPDATE processing_plan_steps SET parameters_json=? WHERE plan_id=? AND step_id=?').run(step.parameters_json, f.planId, step.step_id);
    // Real fixed read, then actual isolated local-data generation invalidation: no proof is returned.
    const client = host.services.r1Runtime!.client, read = client.fixedReadHistory.bind(client);
    const lifecycle = new DatabaseSync(join(fixture.root, 'lifecycle.sqlite'));
    client.fixedReadHistory = async (...args) => { const response = await read(...args); lifecycle.exec('UPDATE local_data_lifecycle SET generation=2'); return response; };
    try { const denied = await host.call(path, f.input, 409); assert.equal(denied.code, 'STALE_LOCAL_DATA_GENERATION'); assert.ok(!denied.results); }
    finally { client.fixedReadHistory = read; lifecycle.exec('UPDATE local_data_lifecycle SET generation=1'); lifecycle.close(); }
    await host.close(); host = await openFullChainHost(fixture, fixture.root);
    assert.deepEqual(await host.call(path, f.input), result);
    assert.deepEqual((await host.call(path, { ...f.input, recordRefs: [f.sourceRef, newerRef] })).results.map((r: any) => r.status), ['consumed', 'not_observed']);
    assert.deepEqual((await host.call(path, { ...f.input, recordRefs: [otherRef, f.sourceRef] })).results.map((r: any) => r.status), ['not_observed', 'consumed']);
    host.database.connection.prepare("UPDATE processing_plan_steps SET output_json=NULL WHERE plan_id=? AND kind='parse'").run(f.planId);
    assert.equal((await host.call(path, f.input, 409)).code, 'PROCESSING_STEP_NOT_READY');
  } finally { await host.close(); }
});
