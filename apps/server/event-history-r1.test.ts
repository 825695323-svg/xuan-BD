import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const namespace = 'full.chain.test', datasetId = 'synthetic_event_history';
const subject = { kind: 'entity', namespace, id: 'synthetic_event_subject' };
const unknown = (): WfdRecord => ({ status: 'unknown', precision: 'unknown', earliest_utc: null, latest_exclusive_utc: null, source_timezone: 'UTC' });
const second = (at: string): WfdRecord => ({ status: 'known', precision: 'second', earliest_utc: at,
  latest_exclusive_utc: new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' });
const definition = (nature: 'plan' | 'outcome') => ({ semantic_code: 'synthetic.event.history.' + nature,
  measurement_nature: 'event', unit_code: 'not_applicable', definition_authority: namespace, time_role: 'event',
  semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: nature === 'outcome' ? 'actual_outcome' : nature },
  field_definitions: [{ field_code: 'statement', data_type: 'text', unit_code: 'text', measurement_nature: 'event', time_role: 'event' }] });
function event(nature: 'plan' | 'outcome', id: string, text: string, publicTime: WfdRecord, date: string): WfdRecord {
  return { event_id: id, case_id: 'operator-declared-case-only', subject, event_type: 'production_start', content_nature: nature,
    event_time: nature === 'plan' ? unknown() : second(date), public_time: publicTime,
    ...(nature === 'plan' ? { expected_time: second(date) } : {}), status: nature === 'plan' ? 'planned' : 'completed',
    values: { statement: { data_type: 'text', value_state: 'valid_value', value: text } } };
}
function document(requestId: string, nature: 'plan' | 'outcome', rows: WfdRecord[], parent: string | null,
  definitionTime: WfdRecord, correction?: { previous: WfdRecord; definitionRef: WfdRecord }) {
  return buildStructuredIngestDocument({ requestId, namespace, producerNamespace: namespace, datasetId,
    submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ requestId, nature, rows, parent, definitionTime, correction: correction ?? null })),
    expectedParentSnapshotId: parent, outputKey: 'event.' + nature, subject, definition: definition(nature), definitionPublicTime: definitionTime,
    inputMode: correction ? 'source_correction' : 'partial_observation',
    ...(correction ? { definitionMode: 'reuse' as const, definitionRef: correction.definitionRef,
      revisions: { [String(rows[0]!.event_id)]: { previous: correction.previous, reason: 'Synthetic published plan rescheduling, not an actual outcome' } } } : {}),
    coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'event_records', rows } });
}
async function publish(host: FullChainHost, doc: WfdRecord) {
  const result = (await host.services.r1Runtime!.client.submit(doc)).result;
  assert.equal(result.state, 'published_formal', JSON.stringify(result));
  assert.equal(result.formal_publication_verified, true);
  const output = (result.output_results as WfdRecord[])[0]!;
  return { snapshotId: String(result.snapshot_id), productId: String(output.product_id), output };
}
const statements = (read: any) => Object.fromEntries(read.result.rows.map((row: any) => [row.record_ref.logical_key, row.values.statement.value]));

// Real machine submission plus HTTP historical reads. Not upload/processing/prepare coverage.
// Every date and claim is an explicit synthetic fixture, not externally verified public evidence.
test('event market history separates future expected dates, announced plan revisions, and independent actual outcome',
  { skip: !enabled, timeout: 180000 }, async () => {
    const fixture = createFullChainFixture({ name: 'event-history-r1', machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    try {
      const definitionTime = second('2025-01-01T00:00:00Z');
      const first = await publish(host, document('event-plan-original', 'plan', [
        event('plan', 'plan', 'Expected June, not occurred', second('2025-01-02T08:00:00Z'), '2025-06-01T00:00:00Z'),
        event('plan', 'unannounced', 'Unknown announcement stays unknown', unknown(), '2025-05-01T00:00:00Z'),
      ], null, definitionTime));
      const original = (await host.services.r1Runtime!.client.fixedRead(first.snapshotId, first.productId)).result;
      const prior = (original.rows as WfdRecord[]).find(item => (item.row as WfdRecord).event_id === 'plan')!;
      const revisedRow = event('plan', 'plan', 'Rescheduled July, still not occurred', second('2025-03-01T08:00:00Z'), '2025-07-01T00:00:00Z');
      revisedRow.status = 'changed';
      const revised = await publish(host, document('event-plan-revised', 'plan', [revisedRow], first.snapshotId, definitionTime,
        { previous: prior.record_ref as WfdRecord, definitionRef: first.output.definition_ref as WfdRecord }));
      const actual = await publish(host, document('event-actual', 'outcome', [
        event('outcome', 'actual', 'Actual July 3, announced July 4', second('2025-07-04T08:00:00Z'), '2025-07-03T12:00:00Z'),
      ], revised.snapshotId, definitionTime));
      const read = (productId: string, at: string) => host.call('/r1/products/read', {
        snapshotId: actual.snapshotId, productId, historyMode: 'market_known_at', at });
      assert.deepEqual(statements(await read(first.productId, '2025-01-02T07:00:00Z')), {});
      const announced = await read(first.productId, '2025-02-01T00:00:00Z');
      assert.deepEqual(statements(announced), { plan: 'Expected June, not occurred' });
      assert.equal(announced.result.rows[0].times.event_time.status, 'unknown');
      assert.equal(announced.result.rows[0].times.expected_time.earliest_utc, '2025-06-01T00:00:00Z');
      assert.equal(announced.result.rows[0].times.public_time.earliest_utc, '2025-01-02T08:00:00Z');
      assert.ok(announced.result.diagnostics.some((item: any) => item.decision === 'indeterminate'), 'Unknown row public time is not replaced by its future expected date');
      const changed = await read(first.productId, '2025-03-02T00:00:00Z');
      assert.deepEqual(statements(changed), { plan: 'Rescheduled July, still not occurred' });
      assert.equal(changed.result.rows[0].times.expected_time.earliest_utc, '2025-07-01T00:00:00Z');
      assert.deepEqual(statements(await read(first.productId, '2025-08-01T00:00:00Z')), { plan: 'Rescheduled July, still not occurred' },
        'Elapsed expected date and another outcome with the same case_id do not establish an unknown announcement');
      assert.deepEqual(statements(await read(actual.productId, '2025-07-03T23:00:00Z')), {}, 'An event date is not its announcement date');
      assert.deepEqual(statements(await read(actual.productId, '2025-07-05T00:00:00Z')), { actual: 'Actual July 3, announced July 4' });
      const timelineQuery = { operation: 'read_event_timeline', datasetId, snapshotId: actual.snapshotId, subject,
        fields: ['statement'], historyMode: 'market_known_at', at: '2025-02-01T00:00:00Z', pageSize: 1 };
      const historic = await host.call('/r1/query/context', timelineQuery);
      assert.deepEqual(statements(historic), { plan: 'Expected June, not occurred' });
      assert.equal(historic.result.knowledge_cutoff.earliest_utc, timelineQuery.at);
      assert.equal(historic.result.held_scope, null); assert.equal(historic.result.usable_stage, null);
      assert.equal(historic.result.business_time_range, null);
      assert.ok(historic.result.eligibility_diagnostics.some((item: any) => item.decision === 'indeterminate'));
      const hidden = JSON.stringify({ gaps: historic.result.gaps, diagnostics: historic.result.eligibility_diagnostics });
      for (const secret of ['unannounced', 'Unknown announcement stays unknown', 'contract_ref', 'revision_id', 'expected_time']) assert.ok(!hidden.includes(secret));
      const laterQuery = { ...timelineQuery, at: '2025-08-01T00:00:00Z' };
      const page = await host.call('/r1/query/context', laterQuery);
      assert.equal(page.result.page.has_more, true);
      const nextPage = await host.call('/r1/query/context', { ...laterQuery, cursor: page.result.page.next_cursor });
      assert.equal(nextPage.result.page.has_more, false);
      assert.deepEqual({ ...statements(page), ...statements(nextPage) }, { plan: 'Rescheduled July, still not occurred', actual: 'Actual July 3, announced July 4' });
      for (const drift of [{ at: timelineQuery.at }, { fields: undefined }, { businessTimeRange: { role: 'event', start: '2025-07-01', end: '2025-08-01', timezone: 'UTC' } }]) {
        assert.ok((await host.call('/r1/query/context', { ...laterQuery, ...drift, cursor: page.result.page.next_cursor }, 409)).code);
      }
      for (const operation of ['read_company_context', 'read_applicable_rules']) assert.equal((await host.call('/r1/query/context', { ...timelineQuery, operation }, 409)).code, 'R1_CONTEXT_HISTORY_INPUT');
      const client = host.services.r1Runtime!.client, nativeRead = client.readContext.bind(client);
      client.readContext = async (...args) => { const reply = await nativeRead(...args); return { ...reply, result: { ...reply.result, knowledge_cutoff: null } }; };
      assert.equal((await host.call('/r1/query/context', timelineQuery, 409)).code, 'R1_CONTEXT_RESPONSE_INVALID');
      client.readContext = async (...args) => { const reply = await nativeRead(...args); return { ...reply, result: { ...reply.result,
        eligibility_diagnostics: [], gaps: [{ reason: 'WITHDRAWAL_PUBLIC_TIME_UNRESOLVED', business_key: 'private-injected-marker' }] } }; };
      const gapRefused = await host.call('/r1/query/context', timelineQuery, 409);
      assert.equal(gapRefused.code, 'R1_READ_REVISION_TIME_UNSUPPORTED'); assert.ok(!JSON.stringify(gapRefused).includes('private-injected-marker'));
      client.readContext = nativeRead;
      const timeline = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId, snapshotId: actual.snapshotId, subject });
      const plan = timeline.result.rows.find((row: any) => row.record_ref.logical_key === 'plan');
      const outcome = timeline.result.rows.find((row: any) => row.record_ref.logical_key === 'actual');
      assert.equal(plan.event.content_nature, 'plan'); assert.equal(plan.event.status, 'changed');
      assert.equal(plan.times.event_time.status, 'unknown');
      assert.equal(plan.times.expected_time.earliest_utc, '2025-07-01T00:00:00Z');
      assert.equal(plan.times.public_time.earliest_utc, '2025-03-01T08:00:00Z');
      assert.equal(outcome.event.content_nature, 'outcome');
      assert.notEqual(plan.record_ref.logical_key, outcome.record_ref.logical_key);
      const currentPlan = (await host.services.r1Runtime!.client.fixedRead(actual.snapshotId, first.productId)).result;
      const currentActual = (await host.services.r1Runtime!.client.fixedRead(actual.snapshotId, actual.productId)).result;
      const planRows = (currentPlan.rows as WfdRecord[]).map(item => item.row as WfdRecord);
      const actualRow = (currentActual.rows as WfdRecord[])[0]!.row as WfdRecord;
      assert.ok(planRows.every(row => row.case_id === actualRow.case_id));
      assert.ok(planRows.every(row => row.content_nature === 'plan' && (row.event_time as WfdRecord).status === 'unknown'),
        'case_id is a declared grouping, not evidence that all plans occurred');
      const oldFixed = (await host.services.r1Runtime!.client.fixedRead(first.snapshotId, first.productId)).result;
      assert.deepEqual(oldFixed.rows, original.rows, 'Later outcome and shared case_id cannot rewrite the original plan');
      const tasks = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      const requests = host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get();
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual((await read(first.productId, '2025-02-01T00:00:00Z')).result.rows, announced.result.rows);
      assert.deepEqual((await host.call('/r1/query/context', timelineQuery)).result, historic.result);
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), tasks);
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get(), requests);
      assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, actual.snapshotId);
    } finally { await host.close(); }
  });

test('event with unknown definition public time is snapshot-readable but refuses historical metadata',
  { skip: !enabled, timeout: 180000 }, async () => {
    const fixture = createFullChainFixture({ name: 'event-history-definition', machine: true, units: { text: { dimension: 'text' } } });
    const host = await openFullChainHost(fixture);
    try {
      const published = await publish(host, document('event-unknown-definition', 'plan', [
        event('plan', 'unknown-definition', 'Known row announcement does not prove definition publication', second('2025-01-02T08:00:00Z'), '2025-06-01T00:00:00Z'),
      ], null, unknown()));
      const selection = { snapshotId: published.snapshotId, productId: published.productId };
      assert.equal((await host.call('/r1/products/read', selection)).result.rows.length, 1);
      const refused = await host.call('/r1/products/read', { ...selection, historyMode: 'market_known_at', at: '2025-02-01T00:00:00Z' }, 409);
      assert.equal(refused.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
      assert.equal(refused.result, undefined, 'No current metadata is attached to a failed history response');
      const timeline = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId, snapshotId: published.snapshotId, subject, historyMode: 'market_known_at', at: '2025-02-01T00:00:00Z' }, 409);
      assert.equal(timeline.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED'); assert.equal(timeline.result, undefined);
    } finally { await host.close(); }
  });

test('event timeline binds each historical event to its own additive contract',
  { skip: !enabled, timeout: 180000 }, async () => {
    const fixture = createFullChainFixture({ name: 'event-timeline-contract', machine: true, units: { text: { dimension: 'text' } } });
    const host = await openFullChainHost(fixture);
    try {
      const first = await publish(host, document('timeline-original', 'plan', [event('plan', 'old', 'old declaration', second('2025-01-02T00:00:00Z'), '2025-06-01T00:00:00Z')], null, second('2025-01-01T00:00:00Z')));
      const next = event('plan', 'new', 'new declaration', second('2025-02-02T00:00:00Z'), '2025-07-01T00:00:00Z');
      (next.values as WfdRecord).extra = { data_type: 'text', value_state: 'valid_value', value: 'additive statement' };
      const doc = document('timeline-additive', 'plan', [next], first.snapshotId, second('2025-01-01T00:00:00Z'));
      const def = (doc.outputs as WfdRecord[])[0]!.definition as WfdRecord;
      (def.field_definitions as WfdRecord[]).push({ field_code: 'extra', data_type: 'text', unit_code: 'text', measurement_nature: 'event', time_role: 'event' });
      const latest = await publish(host, doc); assert.equal(latest.productId, first.productId);
      const direct = await host.call('/r1/products/read', { snapshotId: latest.snapshotId, productId: first.productId, fields: ['statement'], historyMode: 'market_known_at', at: '2025-03-01T00:00:00Z' });
      const raw = (await host.services.r1Runtime!.client.readContext('read_event_timeline', {
        protocol_version: 'wfd.read/1.3-product1b', operation: 'read_event_timeline', dataset_id: datasetId,
        snapshot_id: latest.snapshotId, subject, history_mode: 'snapshot_contents', knowledge_cutoff: null,
        held_scope: null, usable_stage: null, fields: ['statement'], page_size: 100, max_nodes: 10000, max_scan_bytes: 64 * 1024 * 1024,
        cursor: null, business_time_range: null,
      })).result;
      assert.equal((raw.rows as any[]).length, 2);
      const history = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId, snapshotId: latest.snapshotId, subject, fields: ['statement'], historyMode: 'market_known_at', at: '2025-03-01T00:00:00Z' });
      assert.deepEqual(history.result.rows.map((row: any) => row.contract_refs), (raw.rows as any[]).map(row => row.contract_refs));
      const defaults = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId, snapshotId: latest.snapshotId, subject,
        historyMode: 'market_known_at', at: '2025-03-01T00:00:00Z' });
      assert.equal(defaults.result.rows.find((row: any) => row.record_ref.logical_key === 'old').values.extra, undefined);
      assert.equal(defaults.result.rows.find((row: any) => row.record_ref.logical_key === 'new').values.extra.value, 'additive statement');
      const manifest = (await host.services.r1Runtime!.client.fixedRead(latest.snapshotId, first.productId)).result;
      for (const row of raw.rows as any[]) {
        const fixed = direct.result.rows.find((item: any) => item.record_ref.logical_key === row.record_ref.logical_key);
        const meta = (manifest.products as any[]).find(item => canonicalWfdJson(item.contract_ref) === canonicalWfdJson(fixed.contract_ref));
        assert.ok(meta);
        assert.deepEqual(row.contract_refs, meta.contract_refs);
        assert.deepEqual(row.contract_bundle_ref, meta.contract_bundle_ref);
        assert.deepEqual(row.definition_ref, meta.definition_ref);
      }
    } finally { await host.close(); }
  });

test('event market timeline refuses unresolved withdrawal even when no visible row remains',
  { skip: !enabled, timeout: 180000 }, async () => {
    const fixture = createFullChainFixture({ name: 'event-timeline-withdrawal', machine: true, units: { text: { dimension: 'text' } } });
    const host = await openFullChainHost(fixture);
    try {
      const row = event('plan', 'private-withdrawn-key', 'private withdrawn wording', second('2025-01-02T00:00:00Z'), '2025-06-01T00:00:00Z');
      const first = await publish(host, document('withdraw-event-first', 'plan', [row], null, second('2025-01-01T00:00:00Z')));
      const fixed = (await host.services.r1Runtime!.client.fixedRead(first.snapshotId, first.productId)).result;
      const doc = document('withdraw-event-next', 'plan', [row], first.snapshotId, second('2025-01-01T00:00:00Z'), {
        previous: (fixed.rows as any[])[0].record_ref, definitionRef: first.output.definition_ref as WfdRecord });
      (doc.outputs as WfdRecord[])[0]!.input_mode = 'withdrawal';
      const withdrawn = await publish(host, doc);
      const refused = await host.call('/r1/query/context', { operation: 'read_event_timeline', datasetId, snapshotId: withdrawn.snapshotId, subject,
        historyMode: 'market_known_at', at: '2025-03-01T00:00:00Z' }, 409);
      assert.ok(refused.code); assert.equal(refused.result, undefined);
      assert.ok(!JSON.stringify(refused).includes('private-withdrawn-key'));
      assert.ok(!JSON.stringify(refused).includes('private withdrawn wording'));
    } finally { await host.close(); }
  });
