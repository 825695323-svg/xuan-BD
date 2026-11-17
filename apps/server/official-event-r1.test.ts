import { readFileSync } from 'node:fs';
import { extractPublicWebHtml } from '../../platform/capabilities/browser/html-extraction.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { EVENT_TEXT_VERSION } from '../../modules/collection/data-processing/event-text.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

// Captured public government HTML originals; actual upload/processing/R1/WFD path, isolated non-production product.
// A repeated official notice remains two declared publication occurrences, not two independent facts.
test('official original and attributed repost HTML preserve source locations through actual event publication',
  { skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 300_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'official-event-r1', machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    const quote = '一、元旦：1月1日（周三）放假1天，不调休。';
    const sources = [
      { file: 'gov-cn-2025-holidays.html', url: 'https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm', publisher: 'gov_cn', selector: '.trs_editor_view', sha: '2ce246e9776a9b2102e96ac9d438804a869a541c530c62c9db5a54aedc9e7b13' },
      { file: 'kashi-2025-holidays.html', url: 'https://www.kashi.gov.cn/ksdqxzgs/c115966/202411/e116097ae08f4324ae5802863f2a96ba.shtml', publisher: 'kashi_gov', selector: 'body', sha: 'c8dceca4859f14a8b81e8d89397407dff08b9792c762434e7b9739e339ede6cc' },
    ];
    const fields = ['occurrence_id', 'publication_id', 'publication_kind', 'independence_status', 'assertion_kind',
      'occurrence_identity_basis', 'text', 'content_sha256', 'public_time_status'];
    const mapping = { kind: 'event_records', eventId: 'business_key', eventType: 'event_type', assertionKind: 'assertion_kind',
      contentNature: 'source_claim', status: 'unknown', eventTime: { status: 'unknown', sourceTimezone: 'UTC' }, publicTime: { status: 'unknown', sourceTimezone: 'UTC' }, fields: fields.map(fieldCode => ({ fieldCode, value: fieldCode, state: 'metadata_state' })) };
    const values: Record<string, string> = { role: 'source_claim', informationNature: 'source_claim', businessObject: 'synthetic issuer statement',
      objectTime: 'synthetic collection date bucket; not event or public time', purpose: 'Public government source excerpt, isolated regression, not a verified holiday occurrence', structureGranularity: 'exact source excerpt with declared propagation identity' };
    const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: values[key], evidence: [{ source: 'operator', field: key, quote: values[key] }] }]));
    try {
      let snapshotId: string | null = null, productId = '';
      for (const [index, publication] of sources.entries()) {
        const publicationId = publication.url;
        const fixtureReadAt = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
        const bytes = readFileSync(new URL('./fixtures/official-event/' + publication.file, import.meta.url));
        assert.equal(wfdSha256(bytes), publication.sha);
        const extraction = extractPublicWebHtml(bytes.toString('utf8'), { rootSelector: publication.selector });
        const start = extraction.text.indexOf(quote); assert.ok(start >= 0);
        if (index === 0) assert.equal(bytes.toString('utf8').includes(quote), false, 'Original notice crosses strong/text nodes, not a raw contiguous substring');
        else assert.ok(extraction.text.includes('中国政府网'), 'Repost visibly attributes its source; no implicit upstream resolution');
        const source = { source_id: publication.publisher, provider: 'captured-government-fixture', requested_url: publication.url,
          requested_at_utc: fixtureReadAt, acquired_at_utc: fixtureReadAt, usage_scope: values.purpose,
          authorization: { status: 'authorized', basis: 'Public government notice captured for isolated exact excerpt regression; not vendor production authorization' } };
        const upload = await host.upload(publication.file, 'data', bytes, 'official-upload-' + index);
        assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
        const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
        const requestId = 'claim-' + index;
        const target = { datasetId: 'synthetic_event_claims', outputKey: 'event.source.claim', expectedParentSnapshotId: snapshotId,
          subject: { kind: 'entity', namespace: 'full.chain.test', id: 'synthetic_issuer' },
          definition: { semantic_code: 'event.source.claim', measurement_nature: 'event', unit_code: 'not_applicable', definition_authority: 'full.chain.test', time_role: 'event',
            field_definitions: fields.map(field_code => ({ field_code, data_type: 'text', unit_code: 'text', measurement_nature: 'event', time_role: 'event' })),
            semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
              time: { period_type: 'natural', frequency: 'synthetic_collection_day', interval: 'half_open', timezone: 'UTC' },
              content: { assertion_status: 'operator_declared', target_period: 'synthetic_fixture_only' } } },
          inputMode: 'partial_observation', coverage: { scope: { synthetic: true, excerpts: 'selected' }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
        const accepted = await host.call('/processing/plans', { requestId: requestId + '-plan', input: {
          routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'claim', materialIds: [materialId], intendedAction: 'publish', stages: ['parse', 'structure', 'annotate', 'check'],
            tables: [{ materialId, format: 'text', eventTextSelection: { version: EVENT_TEXT_VERSION, sourceSha256: wfdSha256(bytes), reviewBasis: 'Explicit government notice excerpt and repost source label; not independent event truth or historical public-time evidence',
              sourceView: { kind: 'html_static_text', textSha256: wfdSha256(extraction.text), rootSelector: publication.selector },
              occurrence: { namespace: 'official-notice-regression', publisherId: publication.publisher, publicationId,
                kind: index === 0 ? 'original' : 'repost', upstreamPublicationId: index === 0 ? null : sources[0]!.url },
              excerpts: [{ start, end: start + quote.length, quote }] },
              annotations: { start_utc: '2026-01-02T00:00:00Z', end_utc: '2026-01-03T00:00:00Z', metadata_state: 'valid_value', event_type: 'declared_holiday_notice' } }],
            target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: snapshotId } }] } }, 202);
        const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
        const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
        for (const kind of ['parse', 'structure', 'annotate', 'check']) {
          const step = host.services.processing!.get(planId).steps.find(step => step.kind === kind)!;
          if (step.state === 'succeeded') continue;
          const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: requestId + '-' + kind }, 202);
          const ran = await host.settled(run.jobId); assert.equal(ran.status, 'succeeded', JSON.stringify(ran.error));
        }
        assert.equal(host.services.processing!.get(planId).outputs[0]!.publishEligible, true);
        const prepared = await host.call('/r1/prepare', { requestId, planId, outputId: 'claim', source, target, mapping }, 201);
        const submit = await host.call(`/r1/requests/${requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
        const done = await host.settled(submit.jobId, 180_000);
        assert.equal(done.status, 'succeeded', JSON.stringify(await host.call(`/r1/requests/${requestId}`)));
        const view = await host.call(`/r1/requests/${requestId}`);
        assert.equal(view.state, 'associated', JSON.stringify(view));
        const association = view.local.associations[0];
        snapshotId = association.snapshot_id; productId = association.product_id;
        const parse = host.services.processing!.get(planId).steps.find(step => step.kind === 'parse')!;
        const evidence = JSON.parse(host.services.processing!.artifact(planId, parse.stepId).bytes.toString()).event_text_evidence;
        assert.equal(evidence.sourceProjection.scope, 'existing_static_html_projection_not_rendered_page_or_raw_byte_offsets');
        assert.ok(evidence.sourceProjection.positions[0].locations.length > 0);
        assert.equal(evidence.sourceProjection.complete, false);

      }
      const read = () => host.call('/r1/products/read', { snapshotId, productId });
      const timeline = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId: 'synthetic_event_claims', snapshotId,
        subject: { kind: 'entity', namespace: 'full.chain.test', id: 'synthetic_issuer' } });
      assert.equal(timeline.result.rows.length, 2);
      for (const row of timeline.result.rows) { assert.equal(row.event.content_nature, 'source_claim'); assert.equal(row.event.status, 'unknown');
        assert.equal(row.times.event_time.status, 'unknown'); assert.equal(row.times.public_time.status, 'unknown'); }
      const fixed = await read(); assert.equal(fixed.result.rows.length, 2);
      const rows = fixed.result.rows.map((row: any) => row.values);
      assert.equal(rows[0].content_sha256.value, rows[1].content_sha256.value);
      assert.notEqual(rows[0].occurrence_id.value, rows[1].occurrence_id.value);
      for (const row of rows) { assert.equal(row.assertion_kind.value, 'source_claim'); assert.equal(row.public_time_status.value, 'unknown'); assert.equal(row.independence_status.value, 'not_established'); }
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual((await read()).result.rows, fixed.result.rows);
    } finally { await host.close(); }
  });
