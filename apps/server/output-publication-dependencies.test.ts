import { prepareOutputFixture, publish, doc, row, values } from './output-publication-test-support.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
test('selected fixed input observations link to an actual BD output publication, never row-level causation',
  { skip: !enabled, timeout: 180_000 }, async () => {
  const fixture = createFullChainFixture({ name: 'output-publication-dependencies', machine: true,
    units: { cny: { dimension: 'money' }, text: { dimension: 'text' } } });
  let host = await openFullChainHost(fixture, fixture.root);
  try {
    const { initial,sourceProduct,sourceRef,planId,requestId,path,input,prepared } = await prepareOutputFixture(host);
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
    // Reopening does not promote a corrected input revision into the persisted consumer's old input.
    const mixed = await host.call(path, { ...input, recordRefs: [sourceRef, newer.result.rows[0].record_ref] });
    assert.deepEqual(mixed.inputObservations.results.map((entry: WfdRecord) => entry.status), ['observed', 'not_observed']);
    assert.deepEqual(mixed.publication, result.publication);
    assert.equal(mixed.rowAttribution, 'unknown');
    assert.equal(mixed.fullDownstreamImpact, 'unknown');
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
    await host.close(); host = await openFullChainHost(fixture, fixture.root);
    const reopenedMissing = await host.call(path, input, 409);
    assert.equal(reopenedMissing.code, 'PROCESSING_STEP_NOT_READY');
    assert.ok(!('publication' in reopenedMissing));
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_record_associations WHERE request_id=?').get(requestId)!.n, 1);
  } finally { await host.close(); }
});
