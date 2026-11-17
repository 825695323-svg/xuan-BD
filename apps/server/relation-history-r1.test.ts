import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const namespace = 'full.chain.test', datasetId = 'synthetic_relation_history';
const subject = { kind: 'entity', namespace, id: 'synthetic_company' };
// The existing identity schema has no theme kind; the declared thematic group is an explicit synthetic entity.
const identity = (id: string, kind = 'entity') => ({ kind, namespace, id });
const unknown = (): WfdRecord => ({ status: 'unknown', precision: 'unknown', earliest_utc: null, latest_exclusive_utc: null, source_timezone: 'UTC' });
const interval = (start: string, end: string): WfdRecord => ({ status: 'known', precision: 'second', earliest_utc: start, latest_exclusive_utc: end, source_timezone: 'UTC' });
const second = (at: string) => interval(at, new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'));
function edge(key: string, object: WfdRecord, type: string, effective: WfdRecord, published: WfdRecord): WfdRecord {
  return { business_key: key, subject, object, relation_type: type, effective_period: effective, public_time: published,
    values: { label: { data_type: 'text', value_state: 'valid_value', value: key } } };
}
function document(id: string, rows: WfdRecord[], definitionTime: WfdRecord) {
  const doc = buildStructuredIngestDocument({ requestId: id, datasetId, namespace, producerNamespace: namespace,
    submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ id, rows, definitionTime })), expectedParentSnapshotId: null,
    outputKey: 'relations', subject, definitionPublicTime: definitionTime,
    definition: { semantic_code: 'synthetic.relation.declared', measurement_nature: 'relation', unit_code: 'not_applicable',
      definition_authority: namespace, time_role: 'validity',
      semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim' },
      field_definitions: [{ field_code: 'label', data_type: 'text', unit_code: 'text', measurement_nature: 'relation', time_role: 'validity' }] },
    inputMode: 'partial_observation', coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'relation_edges', rows } });
  // Native WFD temporal fixture remains separate from the upload/prepare regression.
  assert.equal((doc.outputs as WfdRecord[])[0]!.logical_domain, 'foundation');
  return doc;
}
async function publish(host: FullChainHost, doc: WfdRecord) {
  const result = (await host.services.r1Runtime!.client.submit(doc)).result;
  assert.equal(result.state, 'published_formal', JSON.stringify(result));
  assert.equal(result.formal_publication_verified, true);
  return { snapshotId: String(result.snapshot_id), productId: String((result.output_results as WfdRecord[])[0]!.product_id) };
}
const labels = (read: any) => read.result.rows.map((row: any) => row.values.label.value).sort();

// Synthetic source declarations, real WFD machine submission and HTTP read. Not an upload/prepare test.
test('relation public history and validity stay independent; unknown-validity links are not traversed',
  { skip: !enabled, timeout: 180000 }, async () => {
    const fixture = createFullChainFixture({ name: 'relation-history-r1', machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    try {
      const effective = interval('2025-03-01T00:00:00Z', '2026-01-01T00:00:00Z');
      const published = await publish(host, document('relations-known', [
        edge('entity-link', identity('synthetic_instrument', 'instrument'), 'listed_as', effective, second('2025-01-02T08:00:00Z')),
        edge('theme-link', identity('synthetic_theme_group'), 'declared_theme_member', effective, second('2025-04-01T08:00:00Z')),
        edge('unknown-effective', identity('synthetic_unknown_effective'), 'related_to', unknown(), second('2025-01-02T08:00:00Z')),
        edge('unknown-public', identity('synthetic_unknown_public'), 'related_to', effective, unknown()),
      ], second('2025-01-01T00:00:00Z')));
      const read = (at: string) => host.call('/r1/products/read', { ...published, historyMode: 'market_known_at', at });
      assert.deepEqual(labels(await read('2025-01-02T07:00:00Z')), []);
      const beforeEffective = await read('2025-02-01T00:00:00Z');
      assert.ok(labels(beforeEffective).includes('entity-link'), 'An announced future-effective relation is knowable, not yet active');
      assert.ok(!labels(beforeEffective).includes('theme-link'), 'Effective start cannot substitute for a later public announcement');
      assert.ok(!labels(beforeEffective).includes('unknown-public'));
      assert.ok(beforeEffective.result.diagnostics.some((item: any) => item.decision === 'indeterminate'));
      const afterPublic = await read('2025-04-02T00:00:00Z');
      assert.ok(labels(afterPublic).includes('theme-link')); assert.ok(!labels(afterPublic).includes('unknown-public'));
      const entity = beforeEffective.result.rows.find((row: any) => row.values.label.value === 'entity-link');
      assert.equal(entity.times.effective_period.earliest_utc, '2025-03-01T00:00:00Z');
      assert.equal(entity.times.public_time.earliest_utc, '2025-01-02T08:00:00Z');
      const graphRequest = { operation: 'read_relation_graph', datasetId, snapshotId: published.snapshotId, subject, maxDepth: 1 };
      const graph = (date: string) => host.call('/r1/query/context', { ...graphRequest,
        businessTimeRange: { role: 'validity', start: date, end: date, timezone: 'UTC' } });
      const before = await graph('2025-02-01');
      assert.equal(before.result.nodes.length, 1, 'Known future effective edges do not connect before validity starts');
      const active = await graph('2025-05-01');
      const uncertain = active.result.edges.find((item: any) => item.object.id === 'synthetic_unknown_effective');
      assert.equal(uncertain.connectivity, 'indeterminate'); assert.equal(uncertain.traversed, false);
      assert.ok(!active.result.nodes.some((item: any) => item.identity.id === 'synthetic_unknown_effective'));
      assert.ok(active.result.edges.some((item: any) => item.relation_type === 'listed_as'));
      assert.ok(active.result.edges.some((item: any) => item.relation_type === 'declared_theme_member'));
      assert.ok(active.result.edges.every((item: any) => item.content_nature === 'source_claim'), 'Temporal connectivity does not verify a declared relation as an observed fact');
      assert.equal(active.historyMode, 'snapshot_contents');
      assert.ok(active.result.nodes.some((item: any) => item.identity.id === 'synthetic_unknown_public'),
        'Snapshot validity graph is not historical-public qualification; unknown announcement is not hidden as proof of market knowledge');
      const unsupported = await host.call('/r1/query/context', { ...graphRequest, historyMode: 'market_known_at', at: '2025-02-01T00:00:00Z' }, 409);
      assert.equal(unsupported.code, 'R1_CONTEXT_HISTORY_INPUT');
      const historicalRequest = { ...graphRequest, historyMode: 'market_known_at', at: '2025-02-01T00:00:00Z',
        businessTimeRange: { role: 'validity', start: '2025-05-01', end: '2025-05-01', timezone: 'UTC' }, pageSize: 1 };
      const historic = await host.call('/r1/query/context', historicalRequest);
      assert.equal(historic.historyMode, 'market_known_at');
      assert.ok(historic.result.nodes.some((item: any) => item.identity.id === 'synthetic_instrument'));
      assert.ok(!historic.result.nodes.some((item: any) => ['synthetic_theme_group', 'synthetic_unknown_public', 'synthetic_unknown_effective'].includes(item.identity.id)));
      assert.equal(historic.result.knowledge_cutoff.earliest_utc, historicalRequest.at);
      assert.equal(historic.result.page.has_more, true);
      const next = await host.call('/r1/query/context', { ...historicalRequest, cursor: historic.result.page.next_cursor });
      assert.equal(next.result.page.has_more, false);
      const drift = await host.call('/r1/query/context', { ...historicalRequest, at: '2025-04-02T00:00:00Z', cursor: historic.result.page.next_cursor }, 409);
      assert.ok(drift.code);
      const later = await host.call('/r1/query/context', { ...historicalRequest, pageSize: 100, at: '2025-04-02T00:00:00Z' });
      assert.ok(later.result.nodes.some((item: any) => item.identity.id === 'synthetic_theme_group'));
      assert.ok(!later.result.nodes.some((item: any) => item.identity.id === 'synthetic_unknown_public'));
      const notEffective = await host.call('/r1/query/context', { ...historicalRequest,
        businessTimeRange: { role: 'validity', start: '2025-02-01', end: '2025-02-01', timezone: 'UTC' } });
      assert.equal(notEffective.result.nodes.length, 1);
      const client = host.services.r1Runtime!.client, nativeRead = client.readContext.bind(client);
      client.readContext = async (...args) => { const reply = await nativeRead(...args); return { ...reply, result: { ...reply.result, knowledge_cutoff: null } }; };
      assert.equal((await host.call('/r1/query/context', historicalRequest, 409)).code, 'R1_CONTEXT_RESPONSE_INVALID');
      client.readContext = nativeRead;
      const typed = await host.call('/r1/query/context', { ...graphRequest, relationTypes: ['declared_theme_member'],
        businessTimeRange: { role: 'validity', start: '2025-05-01', end: '2025-05-01', timezone: 'UTC' } });
      assert.equal(typed.result.edges.length, 1); assert.equal(typed.result.edges[0].object.id, 'synthetic_theme_group');
      const tasks = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual((await read('2025-02-01T00:00:00Z')).result.rows, beforeEffective.result.rows);
      assert.deepEqual((await graph('2025-05-01')).result.edges, active.result.edges);
      assert.deepEqual((await host.call('/r1/query/context', historicalRequest)).result, historic.result);
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), tasks);
      assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, published.snapshotId);
    } finally { await host.close(); }
  });

test('unknown relation definition publication refuses historical values without borrowing edge publication',
  { skip: !enabled, timeout: 180000 }, async () => {
    const fixture = createFullChainFixture({ name: 'relation-definition-r1', machine: true, units: { text: { dimension: 'text' } } });
    const host = await openFullChainHost(fixture);
    try {
      const published = await publish(host, document('relations-unknown-definition', [
        edge('known-edge', identity('synthetic_theme_group'), 'declared_theme_member', interval('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), second('2025-01-02T08:00:00Z')),
      ], unknown()));
      assert.deepEqual(labels(await host.call('/r1/products/read', published)), ['known-edge']);
      const refused = await host.call('/r1/products/read', { ...published, historyMode: 'market_known_at', at: '2025-02-01T00:00:00Z' }, 409);
      assert.equal(refused.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED'); assert.equal(refused.result, undefined);
      const graphRefused = await host.call('/r1/query/context', { operation: 'read_relation_graph', datasetId, snapshotId: published.snapshotId, subject,
        historyMode: 'market_known_at', at: '2025-02-01T00:00:00Z', businessTimeRange: { role: 'validity', start: '2025-02-01', end: '2025-02-01', timezone: 'UTC' } }, 409);
      assert.equal(graphRefused.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED'); assert.equal(graphRefused.result, undefined);
    } finally { await host.close(); }
  });

test('market relation graph preserves each visible row contract after an additive definition and rejects stale query cursors',
  { skip: !enabled, timeout: 180000 }, async () => {
    const fixture = createFullChainFixture({ name: 'relation-contract-history', machine: true, units: { text: { dimension: 'text' } } });
    const host = await openFullChainHost(fixture);
    try {
      const validity = interval('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      const first = await publish(host, document('contract-original', [edge('old-link', identity('old'), 'declared_theme_member', validity, second('2025-01-02T00:00:00Z'))], second('2025-01-01T00:00:00Z')));
      const original = (await host.services.r1Runtime!.client.fixedRead(first.snapshotId, first.productId)).result;
      const oldMeta = (original.products as WfdRecord[])[0]!;
      const addedRow = edge('new-link', identity('new'), 'declared_theme_member', validity, second('2025-02-02T00:00:00Z'));
      (addedRow.values as WfdRecord).extra = { data_type: 'text', value_state: 'valid_value', value: 'explicit additive field' };
      const doc = document('contract-additive', [addedRow], second('2025-01-01T00:00:00Z'));
      doc.expected_parent_snapshot_id = first.snapshotId;
      const output = (doc.outputs as WfdRecord[])[0]!, definition = output.definition as WfdRecord;
      (definition.field_definitions as WfdRecord[]).push({ field_code: 'extra', data_type: 'text', unit_code: 'text', measurement_nature: 'relation', time_role: 'validity' });
      const latest = await publish(host, doc); assert.equal(latest.productId, first.productId);
      const query = { operation: 'read_relation_graph', datasetId, snapshotId: latest.snapshotId, subject, fields: ['label'],
        historyMode: 'market_known_at', at: '2025-03-01T00:00:00Z', pageSize: 1,
        businessTimeRange: { role: 'validity', start: '2025-05-01', end: '2025-05-01', timezone: 'UTC' } };
      const page = await host.call('/r1/query/context', query);
      const secondPage = await host.call('/r1/query/context', { ...query, cursor: page.result.page.next_cursor });
      const edges = [...page.result.edges, ...secondPage.result.edges];
      assert.equal(edges.length, 2);
      const old = edges.find((item: any) => item.record_ref.logical_key === 'old-link');
      const next = edges.find((item: any) => item.record_ref.logical_key === 'new-link');
      assert.deepEqual(old.contract_refs, oldMeta.contract_refs);
      assert.deepEqual(old.contract_bundle_ref, oldMeta.contract_bundle_ref);
      assert.notDeepEqual(next.definition_ref, old.definition_ref);
      assert.ok(next.contract_refs.semantic && next.contract_bundle_ref);
      const oldCutoff = await host.call('/r1/query/context', { ...query, pageSize: 100, at: '2025-01-03T00:00:00Z' });
      assert.equal(oldCutoff.result.edges.length, 1); assert.deepEqual(oldCutoff.result.edges[0].contract_refs, oldMeta.contract_refs);
      for (const changed of [{ snapshotId: first.snapshotId }, { relationTypes: ['related_to'] },
        { businessTimeRange: { role: 'validity', start: '2025-06-01', end: '2025-06-01', timezone: 'UTC' } }]) {
        const refused = await host.call('/r1/query/context', { ...query, ...changed, cursor: page.result.page.next_cursor }, 409);
        assert.ok(refused.code);
      }
      assert.equal((await host.call('/r1/query/context', { ...query, operation: 'read_event_timeline' }, 409)).code, 'R1_CONTEXT_HISTORY_INPUT');
      assert.equal((await host.call('/r1/query/context', { ...query, historyMode: 'system_held_at' }, 409)).code, 'R1_READ_INPUT');
    } finally { await host.close(); }
  });
