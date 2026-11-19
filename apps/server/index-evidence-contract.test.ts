import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { textPdf } from './retrieval-evidence-test-support.js';

// Healthy-cache maintenance contract, not corruption recovery or source authenticity proof.
test('healthy index rebuild preserves fixed PDF evidence across incremental indexing and reopen',
  { skip: !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 120000 }, async () => {
    const fixture = createFullChainFixture({ name: 'index-evidence-contract' });
    let host = await openFullChainHost(fixture, fixture.root);
    const query = { method: 'keyword', query: 'provenance' };
    async function indexDocument(bytes: Buffer, id: string) {
      const upload = await host.upload(id + '.pdf', 'data', bytes, id + '-upload');
      assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
      const material = host.services.materials!.getByTask(upload.jobId)!.envelope;
      const conversion = await host.call(`/retrieval/documents/${material.materialId}/convert`, { requestId: id + '-convert' }, 202);
      assert.equal((await host.settled(conversion.jobId)).status, 'succeeded');
      for (let i = 0; i < 100; i++) {
        const result = await host.call('/retrieval/search', query);
        if (result.citations.some((entry: any) => entry.document_id === material.materialId)) return { material, result };
        await delay(20);
      }
      assert.fail('Actual PDF conversion did not reach the index');
    }
    const tasks = (h: FullChainHost) => h.database.connection.prepare('SELECT id,status,version FROM tasks ORDER BY id').all();
    try {
      const original = textPdf();
      const first = await indexDocument(original, 'first');
      const fixedQuery = { ...query, indexVersion: first.result.coverage.index_version };
      const before = await host.call('/retrieval/search', fixedQuery);
      assert.equal(before.citations.length, 1);
      const input = { indexVersion: fixedQuery.indexVersion, segmentId: before.citations[0].segment_id };
      const evidence = await host.call('/retrieval/evidence', input);
      assert.equal(evidence.cache.status, 'verified');
      assert.equal(evidence.artifact.status, 'verified');
      assert.equal(evidence.original.status, 'verified');
      assert.equal(evidence.factVerification, 'not_established');
      assert.equal(evidence.historicalQualification, 'not_evaluated');
      // Same extracted text, different actual source bytes: no invented equivalence or replacement.
      const otherBytes = Buffer.concat([original, Buffer.from('\n% independent authored evidence\n')]);
      const second = await indexDocument(otherBytes, 'second');
      assert.notEqual(second.material.materialId, first.material.materialId);
      assert.notEqual(second.result.coverage.index_version, fixedQuery.indexVersion);
      assert.equal(second.result.citations.length, 2);
      assert.deepEqual(second.result.citations.map((entry: any) => entry.excerpt), [before.citations[0].excerpt, before.citations[0].excerpt]);
      const latestQuery = { ...query, indexVersion: second.result.coverage.index_version };
      const latest = await host.call('/retrieval/search', latestQuery);
      assert.deepEqual(await host.call('/retrieval/search', fixedQuery), before);
      const versions = await host.call('/retrieval/index-versions');
      const taskRows = tasks(host);
      const rebuilt = await host.call('/retrieval/index/rebuild-fts', {});
      assert.equal(rebuilt.identityPreserved, true);
      assert.deepEqual(await host.call('/retrieval/index-versions'), versions);
      assert.deepEqual(await host.call('/retrieval/search', fixedQuery), before);
      assert.deepEqual(await host.call('/retrieval/evidence', input), evidence);
      assert.deepEqual(await host.call('/retrieval/search', latestQuery), latest);
      assert.deepEqual(tasks(host), taskRows, 'Maintenance/read must not dispatch conversion or publication');
      await host.close(); host = await openFullChainHost(fixture, fixture.root);
      assert.deepEqual(await host.call('/retrieval/index-versions'), versions);
      assert.deepEqual(await host.call('/retrieval/search', fixedQuery), before);
      assert.deepEqual(await host.call('/retrieval/evidence', input), evidence);
      assert.deepEqual(await host.call('/retrieval/search', latestQuery), latest);
      assert.deepEqual(tasks(host), taskRows);
      assert.deepEqual(host.services.materials!.readOriginal(first.material.materialId).bytes, original);
      assert.deepEqual(host.services.materials!.readOriginal(second.material.materialId).bytes, otherBytes);
    } finally { await host.close(); }
  });
