import assert from 'node:assert/strict';
import test from 'node:test';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const source = { source_id: 'synthetic-price-action', provider: 'isolated-fixture',
  requested_url: 'https://fixture.example.test/price-action.csv', requested_at_utc: '2026-01-03T00:00:00Z',
  acquired_at_utc: '2026-01-03T00:01:00Z', usage_scope: 'Explicit synthetic isolated price/action boundary regression',
  authorization: { status: 'authorized', basis: 'Synthetic fixture only, not a real provider or corporate action' } };
const coverage = { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' };
const subject = { kind: 'instrument', namespace: 'full.chain.test', id: 'synthetic_listing' };
async function plan(host: FullChainHost, id: string, csv: string, target: any, mapping: any) {
  const upload = await host.upload(id + '.csv', 'data', Buffer.from(csv), id + '-upload');
  assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
  const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
  const adopted = (key: string) => key === 'role' ? 'financial_record' : key === 'informationNature' ? (mapping.kind === 'event_records' ? 'source_claim' : 'direct-observation') : 'Explicit synthetic ' + key;
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known',
    value: adopted(key), evidence: [{ source: 'operator', field: key, quote: adopted(key) }] }]));
  const request = await host.call('/processing/plans', { requestId: id + '-plan', input: {
    routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
    outputs: [{ outputId: id, materialIds: [materialId], intendedAction: 'publish', stages: ['parse', 'structure', 'annotate', 'check'],
      tables: [{ materialId, format: 'csv' }], target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping },
        expectedSnapshotId: target.expectedParentSnapshotId } }] } }, 202);
  const planned = await host.settled(request.jobId);
  assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
  for (const kind of ['parse', 'structure', 'annotate', 'check']) {
    const step = host.services.processing!.get(planId).steps.find(step => step.kind === kind)!;
    const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: id + '-' + kind }, 202);
    const done = await host.settled(run.jobId);
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  }
  return { planId, view: host.services.processing!.get(planId), target, mapping, id };
}
async function publish(host: FullChainHost, preparedPlan: Awaited<ReturnType<typeof plan>>) {
  const { planId, target, mapping, id } = preparedPlan;
  const prepared = await host.call('/r1/prepare', { requestId: id, planId, outputId: id, source, target, mapping }, 201);
  const submitted = await host.call(`/r1/requests/${id}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
  const done = await host.settled(submitted.jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const view = await host.call(`/r1/requests/${id}`);
  assert.equal(view.state, 'associated', JSON.stringify(view));
  return view.local.associations[0];
}

test('actual BD keeps raw price and corporate-action claims separate and refuses unsupported adjusted-price qualification',
  { skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'price-action-boundary', machine: true,
      units: { text: { dimension: 'text' }, cny_per_share: { dimension: 'money_per_share' } } });
    let host = await openFullChainHost(fixture);
    try {
      const priceTarget = { datasetId: 'synthetic_raw_price', outputKey: 'raw.close', expectedParentSnapshotId: null, subject,
        definition: { semantic_code: 'synthetic.raw.close', measurement_nature: 'stock', unit_code: 'per_field',
          definition_authority: 'full.chain.test', time_role: 'observation',
          field_definitions: [{ field_code: 'close', data_type: 'decimal', unit_code: 'cny_per_share', measurement_nature: 'stock', time_role: 'observation' }],
          semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
            time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' },
            statistical: { price_basis: 'nominal' }, financial: { price_adjustment: { direction: 'raw' } } } },
        inputMode: 'partial_observation', coverage };
      const priceMapping = { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end',
        precision: 'day', sourceTimezone: 'UTC', fields: [{ fieldCode: 'close', value: 'close', state: 'state' }],
        bar: { frequency: 'day', close: 'close' } };
      const csv = 'key,start,end,close,state\nraw-day,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z,9007199254740993.1200,valid_value\n';
      const rawPlan = await plan(host, 'raw', csv, priceTarget, priceMapping);
      assert.equal(rawPlan.view.outputs[0]!.publishEligible, true, JSON.stringify(rawPlan.view.outputs[0]));
      const raw = await publish(host, rawPlan);
      const rawRead = await host.call('/r1/products/read', { snapshotId: raw.snapshot_id, productId: raw.product_id });
      assert.equal(rawRead.result.rows[0].values.close.value, '9007199254740993.1200');

      const actionTarget = { datasetId: 'synthetic_action_claim', outputKey: 'action.claim', expectedParentSnapshotId: raw.snapshot_id, subject,
        definition: { semantic_code: 'synthetic.action.claim', measurement_nature: 'event', unit_code: 'not_applicable',
          definition_authority: 'full.chain.test', time_role: 'event',
          field_definitions: [{ field_code: 'notice', data_type: 'text', unit_code: 'text', measurement_nature: 'event', time_role: 'event' }],
          semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
            time: { period_type: 'natural', frequency: 'synthetic_notice', interval: 'half_open', timezone: 'UTC' } } },
        inputMode: 'partial_observation', coverage };
      const actionMapping = { kind: 'event_records', eventId: 'event_id', eventType: 'event_type', assertionKind: 'assertion_kind',
        contentNature: 'source_claim', status: 'unknown', eventTime: { status: 'unknown', sourceTimezone: 'UTC' },
        publicTime: { status: 'unknown', sourceTimezone: 'UTC' }, fields: [{ fieldCode: 'notice', value: 'notice', state: 'state' }] };
      const actionPlan = await plan(host, 'action',
        'event_id,event_type,assertion_kind,notice,state,start_utc,end_utc\nnotice-1,dividend_notice,source_claim,synthetic proposed dividend not verified or effective,valid_value,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z\n',
        actionTarget, actionMapping);
      const action = await publish(host, actionPlan);
      assert.notEqual(action.product_id, raw.product_id);
      const timeline = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId: 'synthetic_action_claim',
        snapshotId: action.snapshot_id, subject });
      assert.equal(timeline.result.rows.length, 1);
      const event = timeline.result.rows[0];
      assert.equal(event.event.content_nature, 'source_claim'); assert.equal(event.event.status, 'unknown');
      assert.equal(event.times.public_time.status, 'unknown'); assert.equal(event.times.event_time.status, 'unknown');
      // This read cannot establish a known historical action from an unknown definition/announcement.
      const historical = await host.call('/r1/products/read', { snapshotId: action.snapshot_id, productId: action.product_id,
        historyMode: 'market_known_at', at: '2026-01-04T00:00:00Z' }, 409);
      assert.equal(historical.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
      for (const direction of ['adjusted', 'unknown']) {
        const target = structuredClone(priceTarget) as any;
        target.expectedParentSnapshotId = action.snapshot_id;
        target.definition.semantic_context.financial.price_adjustment.direction = direction;
        const rejected = await plan(host, direction, csv, target, priceMapping);
        assert.equal(rejected.view.outputs[0]!.publishEligible, false);
        await host.call('/r1/prepare', { requestId: direction, planId: rejected.planId, outputId: direction,
          source, target, mapping: priceMapping }, 409);
      }
      assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, action.snapshot_id);
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual((await host.call('/r1/products/read', { snapshotId: raw.snapshot_id, productId: raw.product_id })).result.rows, rawRead.result.rows);
    } finally { await host.close(); }
  });
