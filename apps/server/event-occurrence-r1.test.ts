import assert from 'node:assert/strict';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { EVENT_TEXT_VERSION } from '../../modules/collection/data-processing/event-text.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

// Synthetic source claims through the real managed R1 tabular bridge, not event_records support.
test('event source claims preserve distinct propagation in actual WFD tabular publication and fixed restart read',
  { skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 300_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'event-claim-r1', machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    const quote = '合成来源主张：预计明年投产，尚须审批。', bytes = Buffer.from(quote);
    const fields = ['occurrence_id', 'publication_id', 'publication_kind', 'independence_status', 'assertion_kind',
      'occurrence_identity_basis', 'text', 'content_sha256', 'public_time_status'];
    const source = { source_id: 'synthetic-event', provider: 'isolated-fixture', requested_url: 'https://fixture.example.test/event.txt',
      requested_at_utc: '2026-01-02T00:00:00Z', acquired_at_utc: '2026-01-02T00:01:00Z', usage_scope: 'Synthetic source-claim publication regression only',
      authorization: { status: 'authorized', basis: 'Explicit synthetic fixture in isolated temporary BD/WFD store' } };
    const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc',
      precision: 'day', sourceTimezone: 'UTC', fields: fields.map(fieldCode => ({ fieldCode, value: fieldCode, state: 'metadata_state' })) };
    const values: Record<string, string> = { role: 'source_claim', informationNature: 'source_claim', businessObject: 'synthetic issuer statement',
      objectTime: 'synthetic collection date bucket; not event or public time', purpose: source.usage_scope, structureGranularity: 'exact source excerpt with declared propagation identity' };
    const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: values[key], evidence: [{ source: 'operator', field: key, quote: values[key] }] }]));
    try {
      const upload = await host.upload('synthetic-event.txt', 'data', bytes, 'claim-upload');
      assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
      const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
      let snapshotId: string | null = null, productId = '';
      for (const [index, publicationId] of ['original', 'repost', 'original'].entries()) {
        const requestId = 'claim-' + index;
        const target = { datasetId: 'synthetic_event_claims', outputKey: 'event.source.claim', expectedParentSnapshotId: snapshotId,
          subject: { kind: 'entity', namespace: 'full.chain.test', id: 'synthetic_issuer' },
          definition: { semantic_code: 'event.source.claim', measurement_nature: 'relation', unit_code: 'per_field', definition_authority: 'full.chain.test', time_role: 'observation',
            field_definitions: fields.map(field_code => ({ field_code, data_type: 'text', unit_code: 'text', measurement_nature: 'relation', time_role: 'observation' })),
            semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
              time: { period_type: 'natural', frequency: 'synthetic_collection_day', interval: 'half_open', timezone: 'UTC' },
              content: { assertion_status: 'operator_declared', target_period: 'synthetic_fixture_only' } } },
          inputMode: 'partial_observation', coverage: { scope: { synthetic: true, excerpts: 'selected' }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
        const accepted = await host.call('/processing/plans', { requestId: requestId + '-plan', input: {
          routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'claim', materialIds: [materialId], intendedAction: 'publish', stages: ['parse', 'structure', 'annotate', 'check'],
            tables: [{ materialId, format: 'text', eventTextSelection: { version: EVENT_TEXT_VERSION, sourceSha256: wfdSha256(bytes), reviewBasis: 'Synthetic fixture only; no factual validation',
              occurrence: { namespace: 'synthetic', publisherId: publicationId === 'original' ? 'issuer' : 'media', publicationId,
                kind: publicationId === 'original' ? 'original' : 'repost', upstreamPublicationId: publicationId === 'original' ? null : 'original' },
              excerpts: [{ start: 0, end: quote.length, quote }] },
              annotations: { start_utc: '2026-01-02T00:00:00Z', end_utc: '2026-01-03T00:00:00Z', metadata_state: 'valid_value' } }],
            target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: snapshotId } }] } }, 202);
        const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
        const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
        for (const kind of ['parse', 'structure', 'annotate', 'check']) {
          const step = host.services.processing!.get(planId).steps.find(step => step.kind === kind)!;
          const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: requestId + '-' + kind }, 202);
          const ran = await host.settled(run.jobId); assert.equal(ran.status, 'succeeded', JSON.stringify(ran.error));
        }
        assert.equal(host.services.processing!.get(planId).outputs[0]!.publishEligible, true);
        const prepared = await host.call('/r1/prepare', { requestId, planId, outputId: 'claim', source, target, mapping }, 201);
        const submit = await host.call(`/r1/requests/${requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
        const done = await host.settled(submit.jobId, 180_000); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
        const view = await host.call(`/r1/requests/${requestId}`); assert.equal(view.state, 'associated', JSON.stringify(view));
        const association = view.local.associations[0];
        if (index < 2) { snapshotId = association.snapshot_id; productId = association.product_id; }
        else assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, snapshotId, 'Same occurrence is an identical duplicate, not a third independent claim');
      }
      const read = () => host.call('/r1/products/read', { snapshotId, productId });
      const fixed = await read(); assert.equal(fixed.result.rows.length, 2);
      const rows = fixed.result.rows.map((row: any) => row.values);
      assert.equal(rows[0].content_sha256.value, rows[1].content_sha256.value);
      assert.notEqual(rows[0].occurrence_id.value, rows[1].occurrence_id.value);
      for (const row of rows) { assert.equal(row.assertion_kind.value, 'source_claim'); assert.equal(row.public_time_status.value, 'unknown'); assert.equal(row.independence_status.value, 'not_established'); }
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual((await read()).result.rows, fixed.result.rows);
    } finally { await host.close(); }
  });
