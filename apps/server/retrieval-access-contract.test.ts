import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
import { textPdf } from './retrieval-evidence-test-support.js';

// Normal local-client qualification only: no new ACL, revocation, hostile input or lifecycle mutation.
test('same PDF read surfaces share current local qualification without granting access on ordinary unqualified requests',
  { skip: !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 120000 }, async () => {
    const fixture = createFullChainFixture({ name: 'retrieval-access-contract' });
    const host = await openFullChainHost(fixture, fixture.root);
    try {
      const bytes = textPdf();
      const upload = await host.upload('qualified.pdf', 'data', bytes, 'qualified-upload');
      assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
      const material = host.services.materials!.getByTask(upload.jobId)!.envelope;
      const conversion = await host.call(`/retrieval/documents/${material.materialId}/convert`, { requestId: 'qualified-convert' }, 202);
      assert.equal((await host.settled(conversion.jobId)).status, 'succeeded');
      let hit: any;
      for (let i = 0; i < 100; i++) {
        const result = await host.call('/retrieval/search', { method: 'keyword', query: 'provenance' });
        if (result.status === 'matched') { hit = result; break; }
        await delay(20);
      }
      assert.ok(hit); assert.equal(hit.citations.length, 1);
      assert.equal(hit.citations[0].document_id, material.materialId);
      const segmentId = hit.citations[0].segment_id, indexVersion = hit.coverage.index_version;
      const routes = [
        { path: '/retrieval/search', body: { method: 'keyword', query: 'provenance', indexVersion } },
        { path: `/retrieval/segments/${segmentId}` },
        { path: '/retrieval/evidence', body: { segmentId, indexVersion } },
        { path: `/materials/${material.materialId}/original` },
      ];
      const tasks = () => host.database.connection.prepare('SELECT id,status,version FROM tasks ORDER BY id').all();
      const beforeTasks = tasks(), beforeVersions = await host.call('/retrieval/index-versions');
      const qualification = await host.call('/local-data/current');
      const responses: Buffer[] = [];
      for (const route of routes) {
        const read = (qualified: boolean) => fetch(host.base + route.path, {
          method: route.body ? 'POST' : 'GET',
          headers: { 'x-mashiro-client': 'web', ...(qualified ? { 'x-local-data-generation': String(qualification.record.generation) } : {}),
            ...(route.body ? { 'content-type': 'application/json' } : {}) },
          ...(route.body ? { body: JSON.stringify(route.body) } : {}),
        });
        const allowed = await read(true); assert.equal(allowed.status, 200, route.path);
        const expected = Buffer.from(await allowed.arrayBuffer()); responses.push(expected);
        const denied = await read(false); assert.equal(denied.status, 409, route.path);
        const rejection = await denied.json();
        assert.equal(rejection.code, 'LOCAL_DATA_QUALIFICATION_REQUIRED');
        assert.ok(!JSON.stringify(rejection).includes('provenance'));
        assert.ok(!('citation' in rejection) && !('citations' in rejection) && !('text' in rejection));
        const allowedAgain = await read(true); assert.equal(allowedAgain.status, 200);
        assert.deepEqual(Buffer.from(await allowedAgain.arrayBuffer()), expected);
      }
      const evidence = JSON.parse(responses[2]!.toString());
      for (const layer of ['cache', 'artifact', 'original']) assert.equal(evidence[layer].status, 'verified');
      assert.equal(evidence.factVerification, 'not_established');
      assert.equal(evidence.historicalQualification, 'not_evaluated');
      assert.deepEqual(responses[3], bytes);
      assert.deepEqual(tasks(), beforeTasks);
      assert.deepEqual(await host.call('/retrieval/index-versions'), beforeVersions);
      assert.deepEqual(await host.call('/local-data/current'), qualification);
    } finally { await host.close(); }
  });
