import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { renameSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createIndexVersion } from '../../modules/collection/segments/store.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
import { textPdf } from './retrieval-evidence-test-support.js';

test('fixed retrieval evidence verifies actual PDF conversion and original without changing cached hits',
 { skip: !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 120000 }, async () => {
  const fixture = createFullChainFixture({ name: 'retrieval-evidence' });
  let h = await openFullChainHost(fixture, fixture.root); let db: DatabaseSync | undefined;
  try {
    const bytes = textPdf(), uploaded = await h.upload('evidence.pdf', 'data', bytes, 'evidence-upload');
    assert.equal((await h.settled(uploaded.jobId)).status, 'succeeded');
    const material = h.services.materials!.getByTask(uploaded.jobId)!.envelope;
    const conversion = await h.call(`/retrieval/documents/${material.materialId}/convert`, { requestId: 'evidence-convert' }, 202);
    assert.equal((await h.settled(conversion.jobId)).status, 'succeeded');
    let hit: any;
    for (let n = 0; n < 100; n++) {
      const result = await h.call('/retrieval/search', { method: 'keyword', query: 'provenance' });
      if (result.status === 'matched') { hit = result; break; } await delay(20);
    }
    assert.ok(hit);
    const query = { method: 'keyword', query: 'provenance', indexVersion: hit.coverage.index_version };
    const input = { indexVersion: query.indexVersion, segmentId: hit.citations[0].segment_id };
    const before = await h.call('/retrieval/search', query);
    const evidence = await h.call('/retrieval/evidence', input);
    assert.equal(evidence.cache.status, 'verified'); assert.equal(evidence.artifact.status, 'verified', JSON.stringify(evidence));
    assert.equal(evidence.original.status, 'verified'); assert.equal(evidence.factVerification, 'not_established');
    assert.equal(evidence.historicalQualification, 'not_evaluated');
    assert.deepEqual(evidence.citation, before.citations[0]);
    await h.call('/retrieval/evidence', { ...input, indexVersion: 'not-an-index' }, 409);
    await h.call('/retrieval/evidence', { ...input, path: '/etc/passwd' }, 409);
    db = new DatabaseSync(join(dirname(h.database.path), 'segments.sqlite'));
    // Same text from a different original retains separate material/segment identities.
    const second = await h.upload('other.pdf', 'data', Buffer.concat([bytes, Buffer.from('\n% distinct original\n')]), 'second-evidence');
    assert.equal((await h.settled(second.jobId)).status, 'succeeded');
    const other = h.services.materials!.getByTask(second.jobId)!.envelope;
    const otherConversion = await h.call(`/retrieval/documents/${other.materialId}/convert`, { requestId: 'other-convert' }, 202);
    assert.equal((await h.settled(otherConversion.jobId)).status, 'succeeded');
    let otherHit: any;
    for (let n = 0; n < 100; n++) {
      const result = await h.call('/retrieval/search', { method: 'keyword', query: 'provenance' });
      otherHit = result.citations.find((c: any) => c.document_id === other.materialId);
      if (otherHit) break; await delay(20);
    }
    assert.ok(otherHit); assert.notEqual(otherHit.segment_id, input.segmentId);
    createIndexVersion(db, { indexVersion: 'other-explicit-subset', segmentIds: [otherHit.segment_id] }, Date.now());
    await h.call('/retrieval/evidence', { ...input, indexVersion: 'other-explicit-subset' }, 409);
    const explicit = await h.call('/retrieval/artifacts', { requestId: 'explicit-logical-version', materialId: material.materialId,
      artifactRef: before.citations[0].artifact_ref, documentVersion: 'v1', conversionTaskId: conversion.jobId }, 202);
    assert.equal((await h.settled(explicit.jobId)).status, 'succeeded');
    const logical = await h.call('/retrieval/search', { method: 'keyword', query: 'provenance' });
    const logicalHit = logical.citations.find((c: any) => c.document_id === material.materialId && c.document_version === 'v1');
    assert.ok(logicalHit);
    const logicalEvidence = await h.call('/retrieval/evidence', { indexVersion: logical.coverage.index_version, segmentId: logicalHit.segment_id });
    assert.equal(logicalEvidence.artifact.status, 'verified'); assert.equal(logicalEvidence.original.status, 'verified');
    const tasksAfterSetup = h.database.connection.prepare('SELECT id,version FROM tasks ORDER BY id').all();
    // A source changed during the asynchronous artifact read must not retain an earlier verified status.
    const sourceRow = h.database.connection.prepare('SELECT original_bytes FROM material_objects WHERE material_id=?').get(material.materialId)!;
    const verify = h.services.files.verify.bind(h.services.files); let calls = 0;
    h.services.files.verify = ref => {
      const value = verify(ref);
      if (++calls === 3) h.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(Buffer.from('late-corruption'), material.materialId);
      return value;
    };
    try { assert.equal((await h.call('/retrieval/evidence', input)).original.status, 'mismatch'); assert.ok(calls >= 3); }
    finally { h.services.files.verify = verify; h.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(sourceRow.original_bytes, material.materialId); }
    // Real private lifecycle generation changes during a read reject the HTTP result; no second task is dispatched.
    const lifecycle = new DatabaseSync(join(fixture.root, 'lifecycle.sqlite')); calls = 0;
    h.services.files.verify = ref => { const value = verify(ref); if (++calls === 3) lifecycle.exec('UPDATE local_data_lifecycle SET generation=2'); return value; };
    try { const rejected = await h.call('/retrieval/evidence', input, 409); assert.ok(!('citation' in rejected)); assert.ok(calls >= 3); }
    finally { h.services.files.verify = verify; lifecycle.exec('UPDATE local_data_lifecycle SET generation=1'); lifecycle.close(); }
    // Full cache SHA is checked even when the displayed excerpt is shorter. It is not artifact corroboration.
    const old = db.prepare('SELECT text,text_digest FROM doc_segments WHERE segment_id=?').get(input.segmentId)!;
    const long = 'x'.repeat(2500);
    db.prepare('UPDATE doc_segments SET text=?,text_digest=? WHERE segment_id=?').run(long, createHash('sha256').update(long).digest('hex'), input.segmentId);
    try {
      const extended = await h.call('/retrieval/evidence', input);
      assert.equal(extended.citation.excerpt_truncated, true); assert.equal(extended.citation.excerpt.length, 2000);
      assert.equal(extended.cache.status, 'verified'); assert.equal(extended.artifact.status, 'mismatch');
    } finally { db.prepare('UPDATE doc_segments SET text=?,text_digest=? WHERE segment_id=?').run(old.text, old.text_digest, input.segmentId); }
    // A currently missing artifact never deletes the historical cached hit.
    const artifact = h.services.files.getRef(before.citations[0].artifact_ref);
    renameSync(artifact.invocationPath, artifact.invocationPath + '.held');
    try { assert.equal((await h.call('/retrieval/evidence', input)).artifact.status, 'unknown'); }
    finally { renameSync(artifact.invocationPath + '.held', artifact.invocationPath); }
    const artifactBytes = readFileSync(artifact.invocationPath);
    writeFileSync(artifact.invocationPath, 'broken');
    try { assert.equal((await h.call('/retrieval/evidence', input)).artifact.status, 'mismatch'); }
    finally { writeFileSync(artifact.invocationPath, artifactBytes); }
    // Missing exact custody identity is unknown; never borrow another same-text material.
    const custody = h.database.connection.prepare('SELECT * FROM material_object_records WHERE material_id=?').get(material.materialId)!;
    h.database.connection.prepare('DELETE FROM material_object_records WHERE material_id=?').run(material.materialId);
    try { assert.equal((await h.call('/retrieval/evidence', input)).original.status, 'unknown'); }
    finally { h.database.connection.prepare('INSERT INTO material_object_records VALUES(?,?,?,?,?,?)').run(custody.material_id, custody.envelope_json, custody.envelope_digest, custody.preview_json, custody.preview_digest, custody.content_sha256); }
    // Corrupt only isolated fixture custody bytes, not any real user original.
    const stored = h.database.connection.prepare('SELECT original_bytes FROM material_objects WHERE material_id=?').get(material.materialId)!;
    h.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(Buffer.from('wrong'), material.materialId);
    try { assert.equal((await h.call('/retrieval/evidence', input)).original.status, 'mismatch'); }
    finally { h.database.connection.prepare('UPDATE material_objects SET original_bytes=? WHERE material_id=?').run(stored.original_bytes, material.materialId); }
    assert.deepEqual(await h.call('/retrieval/search', query), before);
    assert.deepEqual(h.database.connection.prepare('SELECT id,version FROM tasks ORDER BY id').all(), tasksAfterSetup);
    const denied = await fetch(h.base + '/retrieval/evidence', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mashiro-client': 'web' }, body: JSON.stringify(input) });
    assert.notEqual(denied.status, 200);
    db.close(); db = undefined; await h.close(); h = await openFullChainHost(fixture, fixture.root);
    assert.deepEqual(await h.call('/retrieval/search', query), before);
    // The deliberate artifact overwrite changed its registered file identity: no silent rebind at reopen.
    assert.equal((await h.call('/retrieval/evidence', input)).artifact.status, 'mismatch');
    assert.deepEqual(h.services.materials!.readOriginal(material.materialId).bytes, bytes);
  } finally { db?.close(); await h.close(); }
});
