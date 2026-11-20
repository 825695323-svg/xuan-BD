import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
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
      assert.equal((await host.call('/r1/query/context', { ...query, operation: 'read_company_context' }, 409)).code, 'R1_CONTEXT_HISTORY_INPUT');
      assert.equal((await host.call('/r1/query/context', { ...query, historyMode: 'system_held_at' }, 409)).code, 'R1_READ_INPUT');
    } finally { await host.close(); }
  });

test('formal HTTP read_relation_graph honors system_held_at with heldScope, usableStage, pagination and reopen without bypass',
  { skip: !enabled, timeout: 180000 }, async () => {
    const fixture = createFullChainFixture({ name: 'relation-held-http', machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    try {
      const published = await publish(host, document('held-graph-edges', [
        edge('held-edge-1', identity('held_obj_1'), 'listed_as', interval('2025-03-01T00:00:00Z', '2026-01-01T00:00:00Z'), unknown()),
        edge('held-edge-2', identity('held_obj_2'), 'listed_as', interval('2025-03-01T00:00:00Z', '2026-01-01T00:00:00Z'), unknown()),
      ], second('2025-01-01T00:00:00Z')));
      const heldScope = (await host.call('/r1/products/snapshot', {})).holdingInstance.instanceId;
      assert.ok(heldScope);
      const baseQuery = {
        operation: 'read_relation_graph', datasetId, snapshotId: published.snapshotId, subject, maxDepth: 1,
        historyMode: 'system_held_at', heldScope, usableStage: 'published_readable',
        businessTimeRange: { role: 'validity', start: '2025-05-01', end: '2025-05-01', timezone: 'UTC' },
      };
      const early = await host.call('/r1/query/context', { ...baseQuery, at: '2025-01-01T00:00:00Z' });
      assert.equal(early.historyMode, 'system_held_at');
      assert.equal(early.result.edges.length, 0);
      const page1 = await host.call('/r1/query/context', { ...baseQuery, at: '2099-05-01T00:00:00Z', pageSize: 1 });
      assert.equal(page1.historyMode, 'system_held_at');
      assert.equal(page1.result.edges.length, 1);
      assert.equal(page1.result.page.has_more, true);
      const page2 = await host.call('/r1/query/context', { ...baseQuery, at: '2099-05-01T00:00:00Z', pageSize: 1, cursor: page1.result.page.next_cursor });
      assert.equal(page2.result.edges.length, 1);
      assert.equal(page2.result.page.has_more, false);
      const drift = await host.call('/r1/query/context', { ...baseQuery, at: '2025-01-01T00:00:00Z', pageSize: 1, cursor: page1.result.page.next_cursor }, 409);
      assert.ok(drift.code);
      await host.close(); host = await openFullChainHost(fixture);
      const reopened = await host.call('/r1/query/context', { ...baseQuery, at: '2099-05-01T00:00:00Z' });
      assert.equal(reopened.result.edges.length, 2);
    } finally { await host.close(); }
  });

test('formal workspace prepare/submit/readback supports relation complete_snapshot, source_correction and rejects stale predecessors',
  { skip: !enabled, timeout: 240000 }, async () => {
    const fixture = createFullChainFixture({ name: 'relation-workspace-modes', machine: true, units: { text: { dimension: 'text' } } });
    const host = await openFullChainHost(fixture);
    const relSource = {
      source_id: 'synthetic-rel-source', provider: 'isolated-fixture', requested_url: 'https://fixture.example.test/rel.json',
      requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-01T00:00:00Z',
      usage_scope: 'Synthetic relation complete_snapshot and source_correction regression',
      authorization: { status: 'authorized', basis: 'Explicit synthetic isolated fixture' },
    };
    const relFields = [{ fieldCode: 'label', value: 'label', state: 'state' }];
    const relMapping = {
      kind: 'relation_edges', businessKey: 'key', relationType: 'relation',
      object: { kind: 'object_kind', namespace: 'object_namespace', id: 'object_id' },
      effectivePeriod: { status: 'known', earliestUtc: 'start', latestExclusiveUtc: 'end', precision: 'second', sourceTimezone: 'UTC' },
      publicTime: { status: 'known', earliestUtc: 'pub_start', latestExclusiveUtc: 'pub_end', precision: 'second', sourceTimezone: 'UTC' },
      fields: relFields,
    };
    const relDefinition = {
      semantic_code: 'synthetic.relation.membership', definition_authority: namespace,
      measurement_nature: 'relation', unit_code: 'not_applicable', time_role: 'validity',
      semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim' },
      field_definitions: [{ field_code: 'label', data_type: 'text', unit_code: 'text', measurement_nature: 'relation', time_role: 'validity' }],
    };
    const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, {
      status: 'known', value: key === 'informationNature' ? 'source_claim' : 'synthetic relation ' + key,
      evidence: [{ source: 'operator', field: key, quote: 'Synthetic explicit relation claim' }],
    }]));
    async function runPlan(tag: string, rows: WfdRecord[], target: WfdRecord) {
      const upload = await host.upload(tag + '.json', 'data', Buffer.from(JSON.stringify(rows)), 'upload-' + tag);
      assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
      const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
      const accepted = await host.call('/processing/plans', {
        requestId: 'plan-' + tag,
        input: {
          routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
          outputs: [{
            outputId: 'rel_out', materialIds: [materialId], intendedAction: 'publish', stages: ['parse', 'structure', 'check'],
            tables: [{ materialId, format: 'json' }],
            target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source: relSource, target, mapping: relMapping }, expectedSnapshotId: target.expectedParentSnapshotId },
          }],
        },
      }, 202);
      const planned = await host.settled(accepted.jobId);
      assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
      const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
      for (const kind of ['parse', 'structure', 'check']) {
        const step = host.services.processing!.get(planId).steps.find(s => s.kind === kind)!;
        const exec = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: tag + '-' + kind }, 202);
        const done = await host.settled(exec.jobId);
        assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      }
      return planId;
    }
    try {
      const row1 = {
        key: 'mem-1', relation: 'member_of_theme', object_kind: 'definition', object_namespace: namespace, object_id: 'theme_1',
        start: '2025-01-01T00:00:00Z', end: '2026-01-01T00:00:00Z', pub_start: '2025-01-02T00:00:00Z', pub_end: '2025-01-02T00:00:01Z',
        label: 'v1', state: 'valid_value',
      };
      const row2 = { ...row1, key: 'mem-2', object_id: 'theme_2' };
      // 1. Initial complete_snapshot with 2 members
      const t1: WfdRecord = {
        datasetId: 'synthetic_rel_modes', outputKey: 'theme_members', expectedParentSnapshotId: null, subject,
        definition: relDefinition, inputMode: 'complete_snapshot', definitionPublicTime: second('2025-01-01T00:00:00Z'),
        coverage: { scope: { product: 'synthetic.relation.membership' }, basis: 'declared_full', completeness: 'complete', absence_means: 'explicitly_absent' },
      };
      const plan1 = await runPlan('rel-init', [row1, row2], t1);
      const prep1 = await host.call('/r1/prepare', { requestId: 'req-rel-1', planId: plan1, outputId: 'rel_out', source: relSource, mapping: relMapping, target: t1 }, 201);
      const sub1 = await host.call('/r1/requests/req-rel-1/submit', { confirmationDigest: prep1.documentSha256 }, 202);
      assert.equal((await host.settled(sub1.jobId, 180000)).status, 'succeeded');
      const view1 = await host.call('/r1/requests/req-rel-1');
      assert.equal(view1.state, 'associated');
      const snap1 = view1.local.receipt.snapshot_id as string;
      const prodId = view1.local.receipt.product_id as string;
      const read1 = await host.call('/r1/products/read', { snapshotId: snap1, productId: prodId });
      assert.equal(read1.result.rows.length, 2);

      // 2. Follow-up complete_snapshot with only mem-1 -> mem-2 withdrawn in snap2, preserved in snap1
      const t2: WfdRecord = { ...t1, expectedParentSnapshotId: snap1 };
      const plan2 = await runPlan('rel-complete', [{ ...row1, label: 'v2-complete' }], t2);
      const prep2 = await host.call('/r1/prepare', { requestId: 'req-rel-2', planId: plan2, outputId: 'rel_out', source: relSource, mapping: relMapping, target: t2 }, 201);
      const sub2 = await host.call('/r1/requests/req-rel-2/submit', { confirmationDigest: prep2.documentSha256 }, 202);
      const settled2 = await host.settled(sub2.jobId, 180000);
      assert.equal(settled2.status, 'succeeded', JSON.stringify({ error: settled2.error, view2: await host.call('/r1/requests/req-rel-2') }));
      const view2 = await host.call('/r1/requests/req-rel-2');
      assert.equal(view2.state, 'associated');
      assert.deepEqual((view2.local.receipt.withdrawn_rows as WfdRecord[]).map(r => r.record_id), ['mem-2']);
      const snap2 = view2.local.receipt.snapshot_id as string;
      assert.equal((await host.call('/r1/products/read', { snapshotId: snap2, productId: prodId })).result.rows.length, 1);
      assert.equal((await host.call('/r1/products/read', { snapshotId: snap1, productId: prodId })).result.rows.length, 2);

      // 3. source_correction on mem-1 using exact predecessor from snap2
      const fixed2 = (await host.services.r1Runtime!.client.fixedRead(snap2, prodId)).result;
      const prodMeta = (fixed2.products as WfdRecord[])[0]!;
      const prevRow2 = (fixed2.rows as WfdRecord[]).find(r => r.record_id === 'mem-1')!;
      const prevRef2 = prevRow2.record_ref as WfdRecord;
      const t3: WfdRecord = {
        datasetId: 'synthetic_rel_modes', outputKey: 'theme_members', expectedParentSnapshotId: snap2, subject,
        definition: prodMeta.declaration as WfdRecord, inputMode: 'source_correction',
        definitionMode: 'reuse', definitionRef: prodMeta.definition_ref as WfdRecord,
        coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
        revisions: { 'mem-1': { previous: prevRef2, reason: 'Explicit synthetic relation correction' } },
      };
      const plan3 = await runPlan('rel-corr', [{ ...row1, label: 'v3-corrected' }], t3);
      const prep3 = await host.call('/r1/prepare', { requestId: 'req-rel-3', planId: plan3, outputId: 'rel_out', source: relSource, mapping: relMapping, target: t3 }, 201);
      const sub3 = await host.call('/r1/requests/req-rel-3/submit', { confirmationDigest: prep3.documentSha256 }, 202);
      assert.equal((await host.settled(sub3.jobId, 180000)).status, 'succeeded');
      const view3 = await host.call('/r1/requests/req-rel-3');
      assert.equal(view3.state, 'associated');
      const snap3 = view3.local.receipt.snapshot_id as string;
      const read3 = await host.call('/r1/products/read', { snapshotId: snap3, productId: prodId });
      assert.equal(read3.result.rows[0].values.label.value, 'v3-corrected');

      // 4. Stale predecessor (from snap2 after snap3 superseded mem-1) must be rejected at prepare
      const tStale: WfdRecord = { ...t3, expectedParentSnapshotId: snap3 };
      const planStale = await runPlan('rel-stale', [{ ...row1, label: 'v4-stale' }], tStale);
      const staleFail = await host.call('/r1/prepare', { requestId: 'req-rel-stale', planId: planStale, outputId: 'rel_out', source: relSource, mapping: relMapping, target: tStale }, 409);
      assert.equal(staleFail.code, 'R1_CORRECTION_PREDECESSOR');
    } finally { await host.close(); }
  });

test('formal processing and WFD publication enforce global supply/trade rules end-to-end and block invalid observations',
  { skip: !enabled, timeout: 240000 }, async () => {
    const fixture = createFullChainFixture({
      name: 'supply-trade-formal', machine: true,
      units: { text: { dimension: 'text' }, metric_ton: { dimension: 'quantity' } },
    });
    const host = await openFullChainHost(fixture);
    const stSource = {
      source_id: 'synthetic-st-source', provider: 'isolated-fixture', requested_url: 'https://fixture.example.test/st.json',
      requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-01T00:00:00Z',
      usage_scope: 'Synthetic global supply/trade formal pipeline regression',
      authorization: { status: 'authorized', basis: 'Explicit synthetic isolated fixture' },
    };
    const stFields = ['region_id', 'commodity_id', 'stage_code', 'category', 'period_basis', 'period_label', 'quantity_basis', 'unit_code', 'inventory_scope', 'qty']
      .map(code => ({ fieldCode: code, value: code, state: code === 'qty' ? 'qty_state' : 'txt_state' }));
    const stMapping = {
      kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end', precision: 'day', sourceTimezone: 'UTC',
      fields: stFields,
      supplyTrade: {
        kind: 'geo_commodity_observation', regionId: 'region_id', commodityId: 'commodity_id', stageCode: 'stage_code',
        category: 'category', periodBasis: 'period_basis', periodLabel: 'period_label', quantityBasis: 'quantity_basis',
        unitCode: 'unit_code', inventoryScope: 'inventory_scope', value: 'qty',
      },
    };
    const stTarget = {
      datasetId: 'synthetic_supply_trade', outputKey: 'geo_obs', expectedParentSnapshotId: null, subject,
      inputMode: 'partial_observation',
      coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      definition: {
        semantic_code: 'wfd.observation.geo_commodity.synthetic', definition_authority: namespace,
        measurement_nature: 'mixed_observation', unit_code: 'per_field', time_role: 'observation',
        semantic_context: {
          version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
          time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' },
        },
        field_definitions: stFields.map(f => ({
          field_code: f.fieldCode, data_type: f.fieldCode === 'qty' ? 'decimal' : 'text',
          unit_code: f.fieldCode === 'qty' ? 'metric_ton' : 'text',
          measurement_nature: 'stock', time_role: 'observation',
        })),
      },
    };
    const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, {
      status: 'known', value: key === 'informationNature' ? 'source_claim' : 'synthetic st ' + key,
      evidence: [{ source: 'operator', field: key, quote: 'Synthetic explicit supply-trade claim' }],
    }]));
    async function runCheck(tag: string, rows: WfdRecord[]) {
      const upload = await host.upload(tag + '.json', 'data', Buffer.from(JSON.stringify(rows)), 'st-up-' + tag);
      assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
      const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
      const accepted = await host.call('/processing/plans', {
        requestId: 'st-plan-' + tag,
        input: {
          routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
          outputs: [{
            outputId: 'st_out', materialIds: [materialId], intendedAction: 'publish', stages: ['parse', 'structure', 'check'],
            tables: [{ materialId, format: 'json', types: { qty: 'decimal_string' } }],
            target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source: stSource, target: stTarget, mapping: stMapping }, expectedSnapshotId: null },
          }],
        },
      }, 202);
      const planned = await host.settled(accepted.jobId);
      assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
      const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
      for (const kind of ['parse', 'structure', 'check']) {
        const step = host.services.processing!.get(planId).steps.find(s => s.kind === kind)!;
        const exec = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: tag + '-' + kind }, 202);
        const done = await host.settled(exec.jobId);
        assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
      }
      return planId;
    }
    try {
      // 1. Invalid: port_annual_throughput declared as inventory must fail semantic check and block R1 prepare
      const badPlan = await runCheck('st-bad', [{
        key: 'bad-inv', start: '2025-01-01T00:00:00Z', end: '2025-01-02T00:00:00Z',
        region_id: 'AUS-WA', commodity_id: 'iron_ore', stage_code: 'ore', category: 'inventory',
        period_basis: 'calendar_year', period_label: '2025', quantity_basis: 'dry_weight', unit_code: 'metric_ton',
        inventory_scope: 'port_annual_throughput', qty: '500', qty_state: 'valid_value', txt_state: 'valid_value',
      }]);
      const badOut = host.services.processing!.get(badPlan).outputs[0]!;
      assert.equal(badOut.publishEligible, false);
      assert.equal(badOut.semantic?.quality, 'fail');
      assert.equal(badOut.semantic?.error?.code, 'GLOBAL_SUPPLY_TRADE_THROUGHPUT_AS_INVENTORY');
      await host.call('/r1/prepare', { requestId: 'req-st-bad', planId: badPlan, outputId: 'st_out', source: stSource, mapping: stMapping, target: stTarget }, 409);

      // 2. Valid: actual_output passes check -> formal prepare -> submit -> WFD publication -> fixed readback
      const goodPlan = await runCheck('st-good', [{
        key: 'wa-iron-2025', start: '2025-01-01T00:00:00Z', end: '2025-01-02T00:00:00Z',
        region_id: 'AUS-WA', commodity_id: 'iron_ore', stage_code: 'ore', category: 'actual_output',
        period_basis: 'calendar_year', period_label: '2025', quantity_basis: 'dry_weight', unit_code: 'metric_ton',
        inventory_scope: 'producer_stock', qty: '864', qty_state: 'valid_value', txt_state: 'valid_value',
      }]);
      const prep = await host.call('/r1/prepare', { requestId: 'req-st-good', planId: goodPlan, outputId: 'st_out', source: stSource, mapping: stMapping, target: stTarget }, 201);
      const sub = await host.call('/r1/requests/req-st-good/submit', { confirmationDigest: prep.documentSha256 }, 202);
      assert.equal((await host.settled(sub.jobId, 180000)).status, 'succeeded');
      const view = await host.call('/r1/requests/req-st-good');
      assert.equal(view.state, 'associated');
      const readback = await host.call('/r1/products/read', {
        snapshotId: view.local.receipt.snapshot_id, productId: view.local.receipt.product_id,
      });
      assert.equal(readback.result.rows.length, 1);
      assert.equal(readback.result.rows[0].values.qty.value, '864');
      assert.equal(readback.result.rows[0].values.region_id.value, 'AUS-WA');
    } finally { await host.close(); }
  });
