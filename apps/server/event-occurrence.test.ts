import assert from 'node:assert/strict';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { EVENT_TEXT_VERSION } from '../../modules/collection/data-processing/event-text.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
const isolated = { skip: !process.env.XUAN_FULL_CHAIN_ROOT ? 'Requires an explicitly selected isolated HTTP test root.' : false };
test('HTTP event source selection preserves separate propagation identities and exact evidence after reopen', isolated, async () => {
  const fixture = createFullChainFixture({ name: 'event-occurrence' });
  let host = await openFullChainHost(fixture);
  try {
    const quote = '合成公告：公司预计明年投产，尚须审批。', bytes = Buffer.from(quote);
    const upload = await host.upload('synthetic-event.txt', 'data', bytes, 'event-upload');
    assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
    const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
    const outputIds = ['original', 'repost'];
    const prepared = await host.call('/processing/plans', { requestId: 'event-plan', input: {
      routing: { materials: [{ materialId, intendedAction: 'inspect' }] },
      outputs: outputIds.map((outputId, index) => ({ outputId, materialIds: [materialId], intendedAction: 'inspect',
        stages: ['parse', 'structure', 'check'], tables: [{ materialId, format: 'text', eventTextSelection: {
          version: EVENT_TEXT_VERSION, sourceSha256: wfdSha256(bytes), reviewBasis: 'Synthetic operator supplied source positions, not actual public evidence.',
          occurrence: { namespace: 'synthetic', publisherId: index ? 'media' : 'issuer', publicationId: outputId,
            kind: index ? 'repost' : 'original', upstreamPublicationId: index ? 'original' : null },
          excerpts: [{ start: 0, end: quote.length, quote }],
        } }] })),
    } }, 202);
    const preparedTask = await host.settled(prepared.jobId);
    assert.equal(preparedTask.status, 'succeeded', JSON.stringify(preparedTask.error));
    const planId = host.services.processing!.getByTask(prepared.jobId)!.plan!.planId;
    for (const outputId of outputIds) for (const kind of ['parse', 'structure', 'check']) {
      const step = host.services.processing!.get(planId).steps.find(item => item.outputId === outputId && item.kind === kind)!;
      const accepted = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: `${outputId}-${kind}` }, 202);
      const done = await host.settled(accepted.jobId);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    }
    const a = await host.call(`/processing/plans/${planId}/outputs/original/artifact`);
    const b = await host.call(`/processing/plans/${planId}/outputs/repost/artifact`);
    assert.equal(a.rows[0].text, quote);
    assert.equal(a.rows[0].content_sha256, b.rows[0].content_sha256);
    assert.notEqual(a.rows[0].business_key, b.rows[0].business_key);
    assert.equal(b.rows[0].independence_status, 'not_established');
    assert.equal(a.rows[0].public_time_status, 'unknown');
    const parse = host.services.processing!.get(planId).steps.find(item => item.outputId === 'repost' && item.kind === 'parse')!;
    const evidence = JSON.parse(host.services.processing!.artifact(planId, parse.stepId).bytes.toString()).event_text_evidence;
    assert.equal(evidence.selection.excerpts[0].quote, quote);
    assert.equal(evidence.selection.occurrence.publicationId, 'repost');
    await host.close(); host = await openFullChainHost(fixture);
    assert.deepEqual(await host.call(`/processing/plans/${planId}/outputs/repost/artifact`), b);
  } finally { await host.close(); }
});
