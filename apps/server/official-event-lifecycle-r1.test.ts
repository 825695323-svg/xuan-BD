import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { extractPublicWebHtml } from '../../platform/capabilities/browser/html-extraction.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { EVENT_TEXT_VERSION } from '../../modules/collection/data-processing/event-text.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

// Real captured official source statements, but explicitly synthetic products/subjects.
// Current HTML may have later edits: neither capture time nor page date is public-time evidence.
const subject = { kind: 'entity', namespace: 'full.chain.test', id: 'synthetic_artemis_statement_subject' };
const datasetId = 'synthetic_official_event_lifecycle';
const fields = ['occurrence_id', 'publication_id', 'publication_kind', 'independence_status', 'assertion_kind',
  'occurrence_identity_basis', 'text', 'content_sha256', 'public_time_status'];
interface Publication { kind: 'planned' | 'revised' | 'actual'; file: string; url: string; sha256: string; quote: string; rootSelector: string;
  earliestUtc: string; latestExclusiveUtc: string; sourceTimezone: string; precision: string }
const publications = (JSON.parse(readFileSync(new URL('./fixtures/official-event/nasa-artemis-provenance.json', import.meta.url), 'utf8')) as { sources: Publication[] }).sources;
const definition = (nature: 'plan' | 'outcome') => ({ semantic_code: 'synthetic.artemis.statement.' + nature,
  measurement_nature: 'event', unit_code: 'not_applicable', definition_authority: 'full.chain.test', time_role: 'event',
  field_definitions: fields.map(field_code => ({ field_code, data_type: 'text', unit_code: 'text', measurement_nature: 'event', time_role: 'event' })),
  semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: nature === 'outcome' ? 'actual_outcome' : nature } });
type Correction = { previous: WfdRecord; definitionRef: WfdRecord; definition: WfdRecord };
async function prepare(host: FullChainHost, publication: Publication, requestId: string, parent: string | null,
  correction?: Correction, overwriteOriginal = false) {
  const bytes = readFileSync(new URL('./fixtures/official-event/' + publication.file, import.meta.url));
  assert.equal(wfdSha256(bytes), publication.sha256);
  const extraction = extractPublicWebHtml(bytes.toString('utf8'), { rootSelector: publication.rootSelector });
  const start = extraction.text.indexOf(publication.quote); assert.ok(start >= 0, 'Exact selected quotation must exist in the frozen HTML projection.');
  const readAt = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const source = { source_id: 'official-nasa-public-fixture', provider: 'captured-official-nasa-fixture', requested_url: publication.url,
    requested_at_utc: readAt, acquired_at_utc: readAt, usage_scope: 'Isolated official statement lifecycle regression; not production NASA authority',
    authorization: { status: 'authorized', basis: 'Public official source captured for explicitly isolated source-excerpt regression' } };
  const nature = publication.kind === 'actual' ? 'outcome' : 'plan', eventId = nature === 'plan' ? 'synthetic-artemis-plan' : 'synthetic-artemis-outcome';
  const mapping = { kind: 'event_records', eventId: 'event_id', eventType: 'event_type', assertionKind: 'event_nature', caseId: 'case_id',
    contentNature: nature, status: nature === 'outcome' ? 'completed' : correction ? 'changed' : 'planned',
    eventTime: nature === 'plan' ? { status: 'unknown', sourceTimezone: 'UTC' } : { status: 'known', earliestUtc: 'date_start', latestExclusiveUtc: 'date_end', precision: publication.precision, sourceTimezone: publication.sourceTimezone },
    publicTime: { status: 'unknown', sourceTimezone: 'UTC' },
    ...(nature === 'plan' ? { expectedTime: { status: 'known', earliestUtc: 'date_start', latestExclusiveUtc: 'date_end', precision: publication.precision, sourceTimezone: publication.sourceTimezone } } : {}),
    fields: fields.map(fieldCode => ({ fieldCode, value: fieldCode, state: 'metadata_state' })) };
  const target = { datasetId, outputKey: 'event.' + nature, expectedParentSnapshotId: parent, subject,
    definition: correction?.definition ?? definition(nature), inputMode: correction ? 'source_correction' : 'partial_observation',
    coverage: { scope: { synthetic: true, excerpts: 'selected' }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    ...(correction ? { definitionMode: 'reuse', definitionRef: correction.definitionRef,
      revisions: { [eventId]: { previous: correction.previous, reason: 'Explicit official source statement changes expected date; not a claim the earlier plan occurred.' } } } : {}) };
  const upload = await host.upload(publication.file, 'data', bytes, requestId + '-upload');
  assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
  const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known',
    value: key === 'informationNature' ? (nature === 'outcome' ? 'actual_outcome' : nature) : 'isolated official statement ' + key,
    evidence: [{ source: 'operator', field: key, quote: 'Explicit test mapping of selected official source statement, not inferred truth or historical public time.' }] }]));
  const accepted = await host.call('/processing/plans', { requestId: requestId + '-plan', input: {
    routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'event', materialIds: [materialId], intendedAction: 'publish',
      stages: ['parse', 'structure', 'annotate', 'check'], tables: [{ materialId, format: 'text',
        eventTextSelection: { version: EVENT_TEXT_VERSION, sourceSha256: publication.sha256,
          reviewBasis: 'Exact official text selection with separately declared plan/outcome semantics; current HTML does not establish historic public time or independent verification.',
          sourceView: { kind: 'html_static_text', textSha256: wfdSha256(extraction.text), rootSelector: publication.rootSelector },
          occurrence: { namespace: 'official-event-lifecycle-regression', publisherId: 'nasa_official', publicationId: publication.url, kind: 'original', upstreamPublicationId: null },
          excerpts: [{ start, end: start + publication.quote.length, quote: publication.quote }] },
        annotations: { event_id: eventId, event_type: 'declared_launch', event_nature: nature, case_id: 'synthetic-artemis-case',
          date_start: publication.earliestUtc, date_end: publication.latestExclusiveUtc, metadata_state: 'valid_value',
          ...(overwriteOriginal ? { text: 'Forged replacement of official source quote' } : {}) } }],
      target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: parent } }] } }, 202);
  const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
  for (const kind of ['parse', 'structure', 'annotate', 'check']) {
    const step = host.services.processing!.get(planId).steps.find(step => step.kind === kind)!;
    if (step.state === 'succeeded') continue;
    const execution = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: requestId + '-' + kind }, 202);
    const done = await host.settled(execution.jobId);
    if (overwriteOriginal && done.status === 'failed') {
      assert.equal(done.error?.code, 'CANDIDATE_ANNOTATIONS');
      assert.equal(host.services.processing!.get(planId).outputs[0]!.publishEligible, false);
      return null;
    }
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  }
  assert.equal(overwriteOriginal, false, 'Overwriting original evidence must never pass all stages.');
  const parsed = host.services.processing!.get(planId).steps.find(step => step.kind === 'parse')!;
  const parseArtifact = JSON.parse(host.services.processing!.artifact(planId, parsed.stepId).bytes.toString());
  assert.ok(parseArtifact.event_text_evidence.sourceProjection.positions[0].locations.length > 0);
  return { requestId, planId, outputId: 'event', source, target, mapping };
}
async function publish(host: FullChainHost, input: NonNullable<Awaited<ReturnType<typeof prepare>>>) {
  const prepared = await host.call('/r1/prepare', input, 201);
  const submitted = await host.call(`/r1/requests/${input.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
  const done = await host.settled(submitted.jobId, 180000), view = await host.call(`/r1/requests/${input.requestId}`);
  assert.equal(done.status, 'succeeded', JSON.stringify({ error: done.error, view })); assert.equal(view.state, 'associated', JSON.stringify(view));
  return view.local.associations[0];
}

test('captured official plan revision and outcome pass actual HTML-to-WFD lifecycle without invented historical public time',
  { skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 300000 }, async () => {
    assert.equal(publications.length, 3, 'Requires all three reviewed official captured originals.');
    const fixture = createFullChainFixture({ name: 'official-event-lifecycle', machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    try {
      const initial = await publish(host, (await prepare(host, publications[0]!, 'official-plan-first', null))!);
      const fixed = (await host.services.r1Runtime!.client.fixedRead(initial.snapshot_id, initial.product_id)).result;
      const product = (fixed.products as WfdRecord[])[0]!, previous = (fixed.rows as WfdRecord[])[0]!;
      const correction: Correction = { previous: previous.record_ref as WfdRecord, definitionRef: product.definition_ref as WfdRecord, definition: product.declaration as WfdRecord };
      const invalid = structuredClone(correction); invalid.definition.semantic_code = 'forged-definition';
      const invalidInput = await prepare(host, publications[1]!, 'official-bad-revision', initial.snapshot_id, invalid);
      assert.equal((await host.call('/r1/prepare', invalidInput, 409)).code, 'R1_CORRECTION_DEFINITION');
      assert.equal(await prepare(host, publications[1]!, 'official-overwrite-quote', initial.snapshot_id, correction, true), null);
      assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, initial.snapshot_id);
      const revised = await publish(host, (await prepare(host, publications[1]!, 'official-plan-revised', initial.snapshot_id, correction))!);
      const actual = await publish(host, (await prepare(host, publications[2]!, 'official-actual', revised.snapshot_id))!);
      assert.equal(revised.product_id, initial.product_id, 'Plan correction reuses its fixed definition/product.');
      assert.notEqual(actual.product_id, revised.product_id, 'An outcome is a separate product, not a rewritten plan.');
      const stale = await prepare(host, publications[1]!, 'official-stale-predecessor', actual.snapshot_id, correction);
      assert.equal((await host.call('/r1/prepare', stale, 409)).code, 'R1_CORRECTION_PREDECESSOR');
      assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, actual.snapshot_id);
      const timeline = (snapshotId: string) => host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId, snapshotId, subject });
      const old = await timeline(initial.snapshot_id), latest = await timeline(actual.snapshot_id);
      assert.equal(old.result.rows.length, 1); assert.equal(latest.result.rows.length, 2);
      const plan = latest.result.rows.find((r: any) => r.event.content_nature === 'plan');
      const outcome = latest.result.rows.find((r: any) => r.event.content_nature === 'outcome');
      assert.equal(old.result.rows[0].times.expected_time.earliest_utc, '2022-11-14T05:07:00Z');
      assert.equal(plan.times.expected_time.earliest_utc, '2022-11-16T06:04:00Z');
      assert.equal(old.result.rows[0].times.expected_time.latest_exclusive_utc, '2022-11-14T06:16:00Z');
      assert.equal(plan.times.expected_time.latest_exclusive_utc, '2022-11-16T08:04:00Z');
      assert.equal(plan.times.event_time.status, 'unknown'); assert.equal(plan.event.status, 'changed');
      assert.equal(outcome.times.event_time.earliest_utc, '2022-11-16T06:47:00Z'); assert.equal(outcome.event.status, 'completed');
      assert.equal(outcome.times.event_time.latest_exclusive_utc, '2022-11-16T06:48:00Z');
      assert.notEqual(plan.record_ref.logical_key, outcome.record_ref.logical_key);
      assert.equal(old.result.rows[0].values.text.value, publications[0]!.quote);
      assert.equal(plan.values.text.value, publications[1]!.quote);
      assert.equal(outcome.values.text.value, publications[2]!.quote);
      assert.notEqual(old.result.rows[0].values.occurrence_id.value, plan.values.occurrence_id.value);
      for (const record of [...old.result.rows, ...latest.result.rows]) {
        assert.equal(record.times.public_time.status, 'unknown');
        assert.equal(record.values.assertion_kind.value, 'source_claim');
        assert.equal(record.values.public_time_status.value, 'unknown');
        assert.equal(record.values.independence_status.value, 'not_established');
      }
      const planFixed = (await host.services.r1Runtime!.client.fixedRead(actual.snapshot_id, revised.product_id)).result;
      const outcomeFixed = (await host.services.r1Runtime!.client.fixedRead(actual.snapshot_id, actual.product_id)).result;
      assert.equal(((planFixed.rows as WfdRecord[])[0]!.row as WfdRecord).case_id, ((outcomeFixed.rows as WfdRecord[])[0]!.row as WfdRecord).case_id);
      const historical = await host.call('/r1/products/read', { snapshotId: actual.snapshot_id, productId: revised.product_id, historyMode: 'market_known_at', at: '2022-11-17T00:00:00Z' }, 409);
      assert.equal(historical.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
      const count = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual((await timeline(initial.snapshot_id)).result.rows, old.result.rows);
      assert.deepEqual((await timeline(actual.snapshot_id)).result.rows, latest.result.rows);
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), count);
    } finally { await host.close(); }
  });
