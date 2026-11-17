import assert from 'node:assert/strict';
import test from 'node:test';
import type { R1RelationMapping } from '../../contracts/r1-contracts.js';
import type { WfdRecord } from '../../adapters/database/wfd-transport.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
const subject = { kind: 'entity', namespace: 'full.chain.test', id: 'synthetic_company' };
const datasetId = 'synthetic_relation_ingest';
const mapping: R1RelationMapping = { kind: 'relation_edges', businessKey: 'key', relationType: 'relation', object: { kind: 'object_kind', namespace: 'object_namespace', id: 'object_id' },
  effectivePeriod: { status: 'known', earliestUtc: 'effective_start', latestExclusiveUtc: 'effective_end', precision: 'second', sourceTimezone: 'UTC' },
  publicTime: { status: 'unknown', sourceTimezone: 'UTC' }, fields: [{ fieldCode: 'label', value: 'label', state: 'state' }] };
const rows = [{ key: 'listed-as', relation: 'listed_as', object_kind: 'instrument', object_namespace: 'full.chain.test', object_id: 'synthetic_instrument',
  effective_start: '2026-06-01T00:00:00Z', effective_end: '2027-01-01T00:00:00Z', label: 'Synthetic declared listing relation, not verified', state: 'valid_value' }];
async function prepare(host: FullChainHost, requestId: string, parent: string | null, inputRows: WfdRecord[] = rows, selectedMapping = mapping, definitionPublicTime?: WfdRecord) {
  const source = { source_id: 'synthetic-relations', provider: 'isolated-fixture', requested_url: 'https://fixture.example.test/relations.json',
    requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-01T00:00:00Z', usage_scope: 'Synthetic isolated relation mapping test',
    authorization: { status: 'authorized', basis: 'Explicit synthetic test original; not production authority' } };
  const target = { datasetId, outputKey: 'relations', expectedParentSnapshotId: parent, subject, ...(definitionPublicTime === undefined ? {} : { definitionPublicTime }),
    definition: { semantic_code: 'synthetic.relation.declared', measurement_nature: 'relation', time_role: 'validity', unit_code: 'not_applicable', definition_authority: 'full.chain.test',
      semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim' },
      field_definitions: [{ field_code: 'label', data_type: 'text', unit_code: 'text', measurement_nature: 'relation', time_role: 'validity' }] },
    inputMode: 'partial_observation', coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
  const upload = await host.upload(requestId + '.json', 'data', Buffer.from(JSON.stringify(inputRows)), requestId + '-upload');
  assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
  const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: key === 'informationNature' ? 'source_claim' : 'synthetic relation ' + key,
    evidence: [{ source: 'operator', field: key, quote: 'Explicit synthetic relationship declaration; no identity or historical-time inference' }] }]));
  const accepted = await host.call('/processing/plans', { requestId: requestId + '-plan', input: {
    routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'relations', materialIds: [materialId], intendedAction: 'publish',
      stages: ['parse', 'structure', 'check'], tables: [{ materialId, format: 'json' }],
      target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping: selectedMapping }, expectedSnapshotId: parent } }] } }, 202);
  const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
  for (const kind of ['parse', 'structure', 'check']) {
    const step = host.services.processing!.get(planId).steps.find(step => step.kind === kind)!;
    if (step.state === 'succeeded') continue;
    const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: requestId + '-' + kind }, 202);
    const done = await host.settled(run.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  }
  return { requestId, planId, outputId: 'relations', source, target, mapping: selectedMapping };
}
async function publish(host: FullChainHost, input: Awaited<ReturnType<typeof prepare>>) {
  const prepared = await host.call('/r1/prepare', input, 201);
  const client = host.services.r1Runtime!.client, fixedRead = client.fixedRead.bind(client);
  let tampered = 0;
  if (input.requestId === 'relation-first') client.fixedRead = async (...args) => {
    const reply = await fixedRead(...args), result = structuredClone(reply.result);
    if (Array.isArray(result.products) && result.products.length) { result.products = []; tampered++; }
    return { ...reply, result };
  };
  const accepted = await host.call(`/r1/requests/${input.requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
  let done = await host.settled(accepted.jobId, 180000);
  if (input.requestId === 'relation-first') {
    assert.equal(done.status, 'needs_review'); assert.ok(tampered > 0);
    assert.notEqual((await host.call(`/r1/requests/${input.requestId}`)).state, 'associated');
    client.fixedRead = fixedRead;
    const retry = await host.call(`/r1/requests/${input.requestId}/recover`, { lookupId: 'relation-contract-recover' }, 202);
    done = await host.settled(retry.jobId, 180000);
  }
  const view = await host.call(`/r1/requests/${input.requestId}`);
  assert.equal(done.status, 'succeeded', JSON.stringify({ error: done.error, view }));
  return view;
}
test('actual relation upload-to-WFD preserves explicit identities, independent validity and unknown public time',
  { skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 300000 }, async () => {
    const fixture = createFullChainFixture({ name: 'relation-ingest-r1', machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    try {
      assert.ok((await host.call('/r1/capabilities')).limits.supportedPayloads.includes('relation_edges'));
      const input = await prepare(host, 'relation-first', null);
      const tampered = structuredClone(input); tampered.mapping.object.id = 'other_column';
      assert.equal((await host.call('/r1/prepare', tampered, 409)).code, 'R1_TARGET_CHANGED');
      const initial = await publish(host, input); assert.equal(initial.state, 'associated');
      const ref = initial.local.associations[0];
      const read = () => host.call('/r1/products/read', { snapshotId: ref.snapshot_id, productId: ref.product_id });
      const fixed = await read(); assert.equal(fixed.result.rows.length, 1);
      const row = fixed.result.rows[0];
      const raw = (await host.services.r1Runtime!.client.fixedRead(ref.snapshot_id, ref.product_id)).result as any;
      assert.equal(raw.rows[0].row.object.id, 'synthetic_instrument');
      assert.equal(raw.products[0].logical_domain, 'foundation');
      assert.equal(row.times.public_time.status, 'unknown'); assert.equal(row.times.effective_period.earliest_utc, rows[0]!.effective_start);
      const graph = (date: string) => host.call('/r1/query/context', { operation: 'read_relation_graph', datasetId, snapshotId: ref.snapshot_id, subject, maxDepth: 1,
        businessTimeRange: { role: 'validity', start: date, end: date, timezone: 'UTC' } });
      assert.equal((await graph('2026-05-01')).result.nodes.length, 1);
      assert.equal((await graph('2026-07-01')).result.nodes.length, 2);
      assert.equal((await host.call('/r1/products/read', { snapshotId: ref.snapshot_id, productId: ref.product_id, historyMode: 'market_known_at', at: '2026-07-01T00:00:00Z' }, 409)).code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
      const duplicate = await publish(host, await prepare(host, 'relation-duplicate', ref.snapshot_id));
      assert.equal(duplicate.rowSummary.duplicate_skipped, 1);
      const conflict = await publish(host, await prepare(host, 'relation-conflict', ref.snapshot_id, [{ ...rows[0]!, object_id: 'different_instrument' }]));
      assert.equal(conflict.rowSummary.conflict_pending, 1);
      assert.deepEqual((await read()).result.rows, fixed.result.rows);
      const publicOnly = await publish(host, await prepare(host, 'relation-public-only', ref.snapshot_id,
        [{ ...rows[0]!, key: 'unknown-effective', object_id: 'synthetic_unknown_effective', public_start: '2026-01-02T08:00:00Z', public_end: '2026-01-02T08:00:01Z' }],
        { ...mapping, effectivePeriod: { status: 'unknown', sourceTimezone: 'UTC' }, publicTime: { status: 'known', earliestUtc: 'public_start', latestExclusiveUtc: 'public_end', precision: 'second', sourceTimezone: 'UTC' } }));
      const publicRef = publicOnly.local.associations[0];
      const both = await host.call('/r1/products/read', { snapshotId: publicRef.snapshot_id, productId: publicRef.product_id });
      const unknown = both.result.rows.find((r: any) => r.record_ref.logical_key === 'unknown-effective');
      assert.equal(unknown.times.effective_period.status, 'unknown'); assert.equal(unknown.times.public_time.earliest_utc, '2026-01-02T08:00:00Z');
      const unresolved = await host.call('/r1/query/context', { operation: 'read_relation_graph', datasetId, snapshotId: publicRef.snapshot_id, subject, maxDepth: 1,
        businessTimeRange: { role: 'validity', start: '2026-07-01', end: '2026-07-01', timezone: 'UTC' } });
      assert.equal(unresolved.result.nodes.length, 2, 'Public announcement does not fill unknown validity or add a traversable edge');
      const edge = unresolved.result.edges.find((e: any) => e.object.id === 'synthetic_unknown_effective');
      assert.equal(edge.connectivity, 'indeterminate'); assert.equal(edge.traversed, false);
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual((await read()).result.rows, fixed.result.rows);
    } finally { await host.close(); }
  });

test('actual relation handoff retains explicit independent definition and row publication times for market graph',
  { skip: !process.env.WFD_PYTHON || !process.env.XUAN_FULL_CHAIN_ROOT, timeout: 180000 }, async () => {
    const fixture = createFullChainFixture({ name: 'relation-ingest-market', machine: true, units: { text: { dimension: 'text' } } });
    let host = await openFullChainHost(fixture);
    try {
      const definitionTime = { status: 'known', precision: 'second', earliest_utc: '2026-01-01T08:00:00Z', latest_exclusive_utc: '2026-01-01T08:00:01Z', source_timezone: 'UTC' };
      const input = await prepare(host, 'market-relation', null, [{ ...rows[0]!, public_start: '2026-01-02T08:00:00Z', public_end: '2026-01-02T08:00:01Z' }],
        { ...mapping, publicTime: { status: 'known', earliestUtc: 'public_start', latestExclusiveUtc: 'public_end', precision: 'second', sourceTimezone: 'UTC' } }, definitionTime);
      const changed = structuredClone(input); changed.target.definitionPublicTime = { ...definitionTime, earliest_utc: '2025-01-01T08:00:00Z' };
      assert.equal((await host.call('/r1/prepare', changed, 409)).code, 'R1_TARGET_CHANGED');
      const published = await publish(host, input), ref = published.local.associations[0];
      const read = (at: string) => host.call('/r1/products/read', { snapshotId: ref.snapshot_id, productId: ref.product_id, historyMode: 'market_known_at', at });
      assert.equal((await read('2026-01-02T07:00:00Z')).result.rows.length, 0);
      const knownBeforeEffective = await read('2026-02-01T00:00:00Z'); assert.equal(knownBeforeEffective.result.rows.length, 1);
      assert.equal(knownBeforeEffective.result.rows[0].times.effective_period.earliest_utc, '2026-06-01T00:00:00Z');
      const graph = (at: string, date: string) => host.call('/r1/query/context', { operation: 'read_relation_graph', datasetId, snapshotId: ref.snapshot_id, subject,
        historyMode: 'market_known_at', at, businessTimeRange: { role: 'validity', start: date, end: date, timezone: 'UTC' }, maxDepth: 1 });
      assert.equal((await graph('2026-01-02T07:00:00Z', '2026-07-01')).result.nodes.length, 1);
      assert.equal((await graph('2026-02-01T00:00:00Z', '2026-02-01')).result.nodes.length, 1);
      const active = await graph('2026-07-01T00:00:00Z', '2026-07-01'); assert.equal(active.result.nodes.length, 2);
      await host.close(); host = await openFullChainHost(fixture);
      assert.deepEqual((await graph('2026-07-01T00:00:00Z', '2026-07-01')).result, active.result);
    } finally { await host.close(); }
  });
