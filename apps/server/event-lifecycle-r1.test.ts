import assert from 'node:assert/strict';
import test from 'node:test';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
const subject = { kind: 'entity', namespace: 'full.chain.test', id: 'synthetic_company' };
const source = { source_id: 'synthetic-future-event', provider: 'isolated-fixture', requested_url: 'https://fixture.example.test/plans.json',
  requested_at_utc: '2026-07-05T00:00:00Z', acquired_at_utc: '2026-07-05T00:01:00Z', usage_scope: 'Synthetic event lifecycle regression only',
  authorization: { status: 'authorized', basis: 'Explicit synthetic original rows in isolated BD/WFD fixture' } };
const definition = (nature: string) => ({ semantic_code: 'synthetic.production.' + nature, measurement_nature: 'event', unit_code: 'not_applicable',
  definition_authority: 'full.chain.test', time_role: 'event',
  semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: nature === 'outcome' ? 'actual_outcome' : nature },
  field_definitions: [{ field_code: 'statement', data_type: 'text', unit_code: 'text', measurement_nature: 'event', time_role: 'event' }] });
const time = (prefix: string) => ({ status: 'known', earliestUtc: prefix + '_start', latestExclusiveUtc: prefix + '_end', precision: 'day', sourceTimezone: 'UTC' });
const day = (date: string) => [date + 'T00:00:00Z', new Date(Date.parse(date) + 86400000).toISOString().replace('.000Z', 'Z')];
const row = (nature: string, expected: string, publicDate: string) => ({ event_id: nature === 'outcome' ? 'production-actual' : 'production-plan',
  event_type: 'production_start', case_id: 'synthetic-production-case', nature, statement: 'Synthetic ' + nature + ' dated ' + expected, state: 'valid_value',
  expected_start: day(expected)[0], expected_end: day(expected)[1], actual_start: day(expected)[0], actual_end: day(expected)[1],
  public_start: day(publicDate)[0], public_end: day(publicDate)[1] });
async function prepare(host: FullChainHost, requestId: string, raw: WfdRecord, parent: string | null, correction?: { previous: WfdRecord; definitionRef: WfdRecord; definition: WfdRecord }) {
  const nature = String(raw.nature), mapping = { kind: 'event_records', eventId: 'event_id', eventType: 'event_type', assertionKind: 'nature', caseId: 'case_id', contentNature: nature,
    status: nature === 'outcome' ? 'completed' : correction ? 'changed' : 'planned',
    eventTime: nature === 'outcome' ? time('actual') : { status: 'unknown', sourceTimezone: 'UTC' }, publicTime: time('public'),
    ...(nature === 'plan' ? { expectedTime: time('expected') } : {}), fields: [{ fieldCode: 'statement', value: 'statement', state: 'state' }] };
  const target = { datasetId: 'synthetic_event_lifecycle', outputKey: 'event.' + nature, expectedParentSnapshotId: parent, subject,
    definition: correction?.definition ?? definition(nature),
    definitionPublicTime: { status: 'known', earliest_utc: '2026-01-01T00:00:00Z', latest_exclusive_utc: '2026-01-02T00:00:00Z', precision: 'day', source_timezone: 'UTC' }, inputMode: correction ? 'source_correction' : 'partial_observation',
    coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    ...(correction ? { definitionMode: 'reuse', definitionRef: correction.definitionRef,
      revisions: { [String(raw.event_id)]: { previous: correction.previous, reason: 'Explicit synthetic disclosure changes expected production date, not occurrence fact.' } } } : {}) };
  const upload = await host.upload(requestId + '.json', 'data', Buffer.from(JSON.stringify([raw])), requestId + '-upload');
  assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
  const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: key === 'informationNature' ? (nature === 'outcome' ? 'actual_outcome' : nature) : 'synthetic event ' + key,
    evidence: [{ source: 'operator', field: key, quote: 'Explicit synthetic declared event nature and dates, not inferred from the calendar.' }] }]));
  const accepted = await host.call('/processing/plans', { requestId: requestId + '-plan', input: {
    routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'event', materialIds: [materialId], intendedAction: 'publish',
      stages: ['parse', 'structure', 'check'], tables: [{ materialId, format: 'json' }],
      target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: parent } }] } }, 202);
  const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
  for (const kind of ['parse', 'structure', 'check']) {
    const step = host.services.processing!.get(planId).steps.find(step => step.kind === kind)!;
    if (step.state === 'succeeded') continue;
    const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: requestId + '-' + kind }, 202);
    const done = await host.settled(run.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  }
  return { requestId, planId, outputId: 'event', source, target, mapping };
}
async function publish(host: FullChainHost, input: Awaited<ReturnType<typeof prepare>>) {
  const prepared = await host.call('/r1/prepare', input, 201);
  const accepted = await host.call(`/r1/requests/${input.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
  const done = await host.settled(accepted.jobId, 180000);
  const view = await host.call(`/r1/requests/${input.requestId}`);
  assert.equal(done.status, 'succeeded', JSON.stringify({error:done.error,view})); assert.equal(view.state, 'associated', JSON.stringify(view));
  return view.local.associations[0];
}
test('actual R1 event lifecycle keeps changed expected date, historical plan, and later actual outcome distinct',
  { skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 300000 }, async () => {
    const fixture = createFullChainFixture({ name: 'event-lifecycle-r1', machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    try {
      const initial = await publish(host, await prepare(host, 'plan-original', row('plan', '2026-06-01', '2026-01-02'), null));
      const fixed = (await host.services.r1Runtime!.client.fixedRead(initial.snapshot_id, initial.product_id)).result;
      const product = (fixed.products as WfdRecord[])[0]!, prior = (fixed.rows as WfdRecord[])[0]!;
      const correction = { previous: prior.record_ref as WfdRecord, definitionRef: product.definition_ref as WfdRecord, definition: product.declaration as WfdRecord };
      const badDefinition = structuredClone(correction); badDefinition.definition.semantic_code = 'forged.definition';
      const badRef = structuredClone(correction); badRef.definitionRef.digest = 'sha256:' + '0'.repeat(64);
      for (const [label, invalid] of [['definition', badDefinition], ['reference', badRef]] as const) {
        const input = await prepare(host, 'bad-' + label, row('plan', '2026-08-01', '2026-02-01'), initial.snapshot_id, invalid);
        const rejected = await host.call('/r1/prepare', input, 409);
        assert.equal(rejected.code, 'R1_CORRECTION_DEFINITION');
        assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, initial.snapshot_id);
        assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts WHERE request_id=?').get(input.requestId)!.n, 0);
      }
      const delayedInput = await prepare(host, 'delayed-correction', row('plan', '2026-08-01', '2026-02-01'), initial.snapshot_id, correction);
      const delayed = await host.call('/r1/prepare', delayedInput, 201);
      const revised = await publish(host, await prepare(host, 'plan-revised', row('plan', '2026-07-01', '2026-03-01'), initial.snapshot_id, correction));
      const staleSubmit = await host.call('/r1/requests/delayed-correction/submit', { confirmationDigest: delayed.documentSha256 }, 202);
      const staleDone = await host.settled(staleSubmit.jobId, 180000);
      const staleView = await host.call('/r1/requests/delayed-correction');
      assert.equal(staleDone.status, 'failed', JSON.stringify(staleView));
      assert.equal(staleView.state, 'rejected', JSON.stringify(staleView));
      assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, revised.snapshot_id, 'Submission cannot rebind an old confirmed correction to the newer HEAD.');
      const frozenTime = await prepare(host, 'changed-definition-time', row('plan', '2026-09-01', '2026-07-05'), revised.snapshot_id);
      frozenTime.target.definitionPublicTime.earliest_utc = '2025-01-01T00:00:00Z';
      assert.equal((await host.call('/r1/prepare', frozenTime, 409)).code, 'R1_TARGET_CHANGED');
      const actual = await publish(host, await prepare(host, 'actual-published', row('outcome', '2026-07-03', '2026-07-04'), revised.snapshot_id));
      const stale = await prepare(host, 'stale-plan', row('plan', '2026-09-01', '2026-07-05'), actual.snapshot_id, correction);
      assert.equal((await host.call('/r1/prepare', stale, 409)).code, 'R1_CORRECTION_PREDECESSOR');
      const crossProduct = structuredClone(correction); crossProduct.previous.product_id = actual.product_id;
      const crossed = await prepare(host, 'cross-product', row('plan', '2026-09-01', '2026-07-05'), actual.snapshot_id, crossProduct);
      const crossedResult = await host.call('/r1/prepare', crossed, 409);
      assert.ok(crossedResult.code); assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, actual.snapshot_id);
      const historical = await host.call('/r1/products/read', { snapshotId: actual.snapshot_id, productId: revised.product_id, historyMode: 'market_known_at', at: '2026-02-01T00:00:00Z' });
      assert.equal(historical.result.rows.length, 1);
      assert.equal(historical.result.rows[0].times.expected_time.earliest_utc, '2026-06-01T00:00:00Z');
      assert.equal(historical.result.rows[0].times.event_time.status, 'unknown');
      const beforeOutcome = await host.call('/r1/products/read', { snapshotId: actual.snapshot_id, productId: actual.product_id, historyMode: 'market_known_at', at: '2026-07-03T12:00:00Z' });
      assert.equal(beforeOutcome.result.rows.length, 0, 'Actual date cannot replace its later public disclosure time.');
      const fixedActual = (await host.services.r1Runtime!.client.fixedRead(actual.snapshot_id, actual.product_id)).result;
      const fixedPlan = (await host.services.r1Runtime!.client.fixedRead(actual.snapshot_id, revised.product_id)).result;
      assert.equal(((fixedActual.rows as WfdRecord[])[0]!.row as WfdRecord).case_id, ((fixedPlan.rows as WfdRecord[])[0]!.row as WfdRecord).case_id);
      const historicalTimelineRequest = { operation: 'read_event_timeline', datasetId: 'synthetic_event_lifecycle', snapshotId: actual.snapshot_id, subject,
        historyMode: 'market_known_at', at: '2026-02-01T00:00:00Z', fields: ['statement'] };
      const timelineHistory = await host.call('/r1/query/context', historicalTimelineRequest);
      assert.equal(timelineHistory.result.rows.length, 1);
      assert.deepEqual(timelineHistory.result.rows[0].record_ref, historical.result.rows[0].record_ref);
      assert.equal(timelineHistory.result.rows[0].times.expected_time.earliest_utc, '2026-06-01T00:00:00Z');
      assert.equal(timelineHistory.result.rows[0].times.event_time.status, 'unknown');
      const tasksBeforeRead = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      const old = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId: 'synthetic_event_lifecycle', snapshotId: initial.snapshot_id, subject });
      assert.equal(old.result.rows.length, 1); assert.equal(old.result.rows[0].event.content_nature, 'plan');
      assert.equal(old.result.rows[0].times.expected_time.earliest_utc, '2026-06-01T00:00:00Z');
      const latest = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId: 'synthetic_event_lifecycle', snapshotId: actual.snapshot_id, subject });
      assert.equal(latest.result.rows.length, 2);
      const plan = latest.result.rows.find((value: any) => value.event.content_nature === 'plan');
      const outcome = latest.result.rows.find((value: any) => value.event.content_nature === 'outcome');
      assert.equal(plan.event.status, 'changed'); assert.equal(plan.times.event_time.status, 'unknown');
      assert.equal(plan.times.expected_time.earliest_utc, '2026-07-01T00:00:00Z');
      assert.equal(outcome.event.status, 'completed'); assert.equal(outcome.times.event_time.earliest_utc, '2026-07-03T00:00:00Z');
      assert.notEqual(plan.record_ref.logical_key, outcome.record_ref.logical_key);
      await host.close(); host = await openFullChainHost(fixture);
      const reopened = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId: 'synthetic_event_lifecycle', snapshotId: actual.snapshot_id, subject });
      assert.deepEqual(reopened.result.rows, latest.result.rows);
      assert.deepEqual((await host.call('/r1/query/context', historicalTimelineRequest)).result, timelineHistory.result);
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), tasksBeforeRead);
    } finally { await host.close(); }
  });
