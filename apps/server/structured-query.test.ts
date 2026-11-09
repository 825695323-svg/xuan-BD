import { spawnSync } from 'node:child_process';
import { isolatedPythonArgs } from '../../platform/resources/native-check.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const source = { source_id: 'r07-http-synthetic', provider: 'isolated-synthetic-fixture',
  requested_url: 'https://fixture.example.test/r07.csv', requested_at_utc: '2026-01-01T00:00:00Z',
  acquired_at_utc: '2026-01-04T00:00:00Z', usage_scope: 'isolated structured query and evidence association acceptance',
  authorization: { status: 'authorized', basis: 'Operator selected generated fixture data for this isolated query acceptance.' } };

function csv(subject: string, value: string): Buffer {
  const header = ['business_key', 'start_utc', 'end_utc', 'value_state', 'reading', 'other',
    'bd.semantic_code', 'bd.subject_kind', 'bd.subject_id', 'bd.frequency', 'bd.precision', 'bd.timezone', 'bd.period_type',
    'bd.type.reading', 'bd.unit.reading', 'bd.measurement.reading', 'bd.type.other', 'bd.unit.other', 'bd.measurement.other'];
  const row = [subject + '-day1', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', 'valid_value', value, '20',
    'r07.synthetic.region', 'region', subject, 'day', 'day', 'UTC', 'natural', 'decimal', 'count', 'stock', 'decimal', 'count', 'stock'];
  return Buffer.from(header.join(',') + '\n' + row.join(',') + '\n');
}

async function publish(host: FullChainHost, subject: string, value: string) {
  const uploaded = await host.upload(subject + '.csv', 'data', csv(subject, value), 'upload-' + subject);
  const task = await host.settled(uploaded.jobId); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  const material = host.services.materials!.getByTask(task.id)!;
  await host.call('/r1/auto/start', { requestId: 'r07-' + subject, materialId: material.envelope.materialId,
    datasetId: 'r07_http', source }, 202);
  for (let index = 0; index < 1800; index++) {
    const view = await host.call('/r1/auto/r07-' + subject);
    if (view.state === 'associated') return { material, view };
    if (['awaiting_answers', 'blocked', 'stopped'].includes(view.state)) assert.fail(JSON.stringify(view));
    await delay(25);
  }
  throw new Error('Automatic fixture publication did not settle.');
}

async function documentFixture(host: FullChainHost, material: Awaited<ReturnType<typeof publish>>['material']) {
  // Synthetic conversion geometry is explicit. This tests the actual registered
  // artifact -> SegmentService -> persisted index association, not a PDF parser.
  const text = '联合检索证据 ' + material.envelope.filename;
  const envelope = { schemaVersion: '1.0', implementation: { name: 'synthetic-conversion-fixture', version: '1' },
    operation: 'conversion.document', source: { sha256: material.envelope.sha256, fileRefId: material.envelope.fileRefId,
      declaredName: material.envelope.filename }, status: 'complete', issues: [], text,
    content: { format: 'synthetic-test-pages', pageCount: 1, pages: [{ page: 1, pageLabel: '1', width: 595, height: 842,
      originalItems: [{ index: 0, str: text, transform: [1, 0, 0, 1, 72, 800], width: 220, height: 12, hasEOL: true }], tableCandidates: [] }] } };
  const path = join(host.fixture.root, material.envelope.materialId + '-synthetic-artifact.json');
  writeFileSync(path, JSON.stringify(envelope));
  const file = host.services.files.register({ path, source: 'generated', displayName: 'synthetic registered geometry' });
  host.services.permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path: file.invocationPath } }],
    label: 'r07-test-conversion-fixture', scope: { kind: 'persistent' } });
  const received = await host.call('/retrieval/artifacts', { requestId: 'r07-artifact-' + material.envelope.materialId,
    materialId: material.envelope.materialId, artifactRef: file.id,
    eventTime: { state: 'not_applicable' }, disclosedAt: { state: 'known', value: '2026-01-01T00:00:00Z' } }, 202);
  const settled = await host.settled(received.jobId); assert.equal(settled.status, 'succeeded', JSON.stringify(settled.error));
}

test('HTTP real Python publication, multi-object filter and persisted exact evidence join survive restart', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r07-r08-http', machine: true });
  writeFileSync(join(fixture.root, 'fixture.json'), JSON.stringify(fixture, null, 2));
  let host = await openFullChainHost(fixture);
  const transcript: unknown[] = [];
  try {
    const published = [];
    for (const [subject, value] of [['region_a', '10'], ['region_b', '10'], ['region_c', '0']]) {
      const item = await publish(host, subject!, value!); published.push(item);
      await documentFixture(host, item.material);
      transcript.push({ publication: item.view });
    }
    const snapshot = await host.call('/r1/products/snapshot', {});
    const discovered = await host.call('/r1/products/discover', { snapshotId: snapshot.snapshotId });
    const selections = discovered.selections;
    assert.equal(selections.length, 3);
    const plan = { dataset_id: 'r07_http', snapshot_id: snapshot.snapshotId, history_mode: 'snapshot_contents',
      knowledge_cutoff: null, held_scope: null, usable_stage: null,
      universe: { kind: 'explicit_subjects', subjects: selections.map((item: any) => item.subject) },
      metrics: ['reading', 'other'].map(field => ({ metric: field, field,
        bindings: selections.map((item: any) => ({ subject: item.subject, product_id: item.productId })) })),
      business_time_range: { role: 'observation', start: '2026-01-02', end: '2026-01-02', timezone: 'UTC' },
      predicate: { and: [{ compare: { metric: 'reading', op: '>=', value: { data_type: 'decimal', value: '0', unit_code: 'count' } } },
        { compare_metrics: { left: 'reading', right: 'other', op: '<' } }] },
      order_by: [{ kind: 'metric', metric: 'reading', direction: 'desc', nulls: 'last' }], page_size: 1 };
    const first = await host.call('/r1/query/filter', plan);
    assert.equal(first.status, 'matched'); assert.equal(first.page.total_objects, 3);
    assert.equal(first.objects[0].subject.id, 'region_a'); assert.equal(first.page.has_more, true);
    const second = await host.call('/r1/query/filter', { ...plan, cursor: first.page.next_cursor });
    assert.equal(second.objects[0].subject.id, 'region_b');
    const indexes = await host.call('/retrieval/index-versions');
    const documentContext = { method: 'keyword', query: '联合检索证据', limit: 1,
      indexVersion: indexes.items.sort((a: any, b: any) => b.built_at - a.built_at)[0].index_version, mode: null, asOf: null };
    const joint = await host.call('/retrieval/joint', { structured: plan, documents: documentContext });
    assert.equal(joint.status, 'matched', JSON.stringify(joint));
    assert.equal(joint.qualification.historical_claim, false);
    assert.equal(joint.objects[0].documents.citations.length, 1);
    assert.equal(joint.objects[0].documents.citations[0].document_id, published[0]!.material.envelope.materialId);
    const jointSecond = await host.call('/retrieval/joint', { structured: { ...plan, cursor: joint.page.next_cursor }, documents: documentContext });
    assert.equal(jointSecond.status, 'matched', JSON.stringify(jointSecond));
    assert.equal(jointSecond.objects[0].documents.citations[0].document_id, published[1]!.material.envelope.materialId,
      'Document scope is applied before LIMIT, so an unrelated earlier hit cannot hide this object evidence');
    const drift = await host.call('/retrieval/joint', { structured: { ...plan, cursor: joint.page.next_cursor },
      documents: { ...documentContext, query: 'changed' } }, 409);
    assert.equal(drift.code, 'CURSOR_QUERY_MISMATCH');
    const wrongHistory = await host.call('/retrieval/joint', { structured: plan,
      documents: { ...documentContext, mode: 'market_known_at', asOf: '2026-01-02T00:00:00Z' } }, 409);
    assert.equal(wrongHistory.code, 'JOINT_SNAPSHOT_HISTORY_UNSUPPORTED');
    const illegal = await host.call('/r1/query/filter', { ...plan, caller_roles: ['read'] }, 409);
    assert.equal(illegal.code, 'R1_READ_INPUT');
    transcript.push({ snapshot, discovered, plan, first, second, documentContext, joint, jointSecond, drift, wrongHistory, illegal });
    await host.close(); host = await openFullChainHost(fixture);
    const restored = await host.call('/retrieval/joint', { structured: { ...plan, cursor: joint.page.next_cursor }, documents: documentContext });
    assert.deepEqual(restored.objects, jointSecond.objects);
    const restoredFilter = await host.call('/r1/query/filter', { ...plan, cursor: first.page.next_cursor });
    assert.deepEqual(restoredFilter.objects, second.objects);
    transcript.push({ restored, restoredFilter });
    writeFileSync(join(fixture.root, 'query-verification.json'), JSON.stringify({ fixture: 'synthetic source data and conversion geometry; real Python and persisted services', transcript }, null, 2));
    writeFileSync(join(fixture.root, 'ui-seed.json'), JSON.stringify({ snapshotId: snapshot.snapshotId, plan, documentContext }, null, 2));
  } finally { await host.close(); }
});

test('four context HTTP reads use six synthetic WFD rows and fixed snapshot bounds', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'context-six-http', machine: true, units: {
    count: { dimension: 'quantity' }, text: { dimension: 'text' }, identifier: { dimension: 'identifier' },
    cny: { dimension: 'money' }, cny_per_share: { dimension: 'money_per_share' },
  } });
  const productRoot = join(import.meta.dirname, '../../wfd/product');
  const generated = spawnSync(process.env.WFD_PYTHON!, isolatedPythonArgs(join(fixture.root, 'fixture-python-cache'), ['-c',
    'import sys,json;sys.path.insert(0,sys.argv[1]);sys.path.insert(0,sys.argv[1]+"/tests");from test_p4a1_data_only_public_read import fixture_document;d=fixture_document();d["outputs"]=[x for x in d["outputs"] if x["output_key"]!="quote" and x["output_key"]!="rule_decoy"];next(x for x in d["outputs"] if x["output_key"]=="relations")["payload"]["rows"]=next(x for x in d["outputs"] if x["output_key"]=="relations")["payload"]["rows"][:1];d["request_identity"]["trusted_actor_namespace"]="full.chain.test";d["producer_namespace"]="full.chain.test";print(json.dumps(d))', productRoot]),
    { cwd: fixture.root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(generated.status, 0, generated.stderr);
  const document = JSON.parse(generated.stdout);
  assert.equal(document.outputs.reduce((sum: number, item: any) => sum + item.payload.rows.length, 0), 6);
  let host = await openFullChainHost(fixture);
  const transcript: Record<string, unknown> = {};
  try {
    const machine = host.services.r1Runtime!.connection.client;
    const initial = structuredClone(document); initial.outputs = initial.outputs.filter((item: any) => item.output_key === 'fin');
    const first = await machine.submit(initial);
    assert.equal(first.result.state, 'published_formal', JSON.stringify(first.result));
    const remaining = structuredClone(document); remaining.outputs = remaining.outputs.filter((item: any) => item.output_key !== 'fin');
    remaining.request_identity.request_id = 'p4a1-context-six-second'; remaining.request_identity.submission_digest = 'sha256:' + '1'.repeat(64);
    remaining.expected_parent_snapshot_id = first.result.snapshot_id;
    const second = await machine.submit(remaining);
    assert.equal(second.result.state, 'published_formal', JSON.stringify(second.result));
    const snapshotId = second.result.snapshot_id;
    const base = { datasetId: document.request_identity.dataset_id, snapshotId,
      subject: { kind: 'entity', namespace: 'wfd.p4a1.synthetic', id: 'company_synthetic' }, pageSize: 1 };
    const call = (operation: string, extra: Record<string, unknown> = {}, status = 200) => host.call('/r1/query/context', { ...base, operation, ...extra }, status);
    const companyZero = await call('read_company_context', { maxDepth: 0, pageSize: 10 });
    assert.deepEqual(companyZero.result.identities, [base.subject]); assert.equal(companyZero.result.edges.length, 0);
    const company = await call('read_company_context', { maxDepth: 1 });
    assert.equal(company.historyMode, 'snapshot_contents'); assert.equal(company.result.identities.length, 2);
    assert.equal(company.result.page.has_more, true); assert.equal(company.result.rows.length, 1);
    const companyNext = await call('read_company_context', { maxDepth: 1, cursor: company.result.page.next_cursor });
    assert.notDeepEqual(companyNext.result.rows, company.result.rows);
    const graph = await call('read_relation_graph', { maxDepth: 1 });
    assert.equal(graph.result.nodes.length, 2); assert.equal(graph.result.edges.length, 1);
    const rules = await call('read_applicable_rules');
    assert.equal(rules.result.rows.length, 1); assert.equal(rules.result.rule_conflicts.length, 1);
    assert.equal(rules.result.rows[0].rule.conflict, true); assert.equal(rules.result.rows[0].rule.conflict_basis_count, 2);
    const rulesNext = await call('read_applicable_rules', { cursor: rules.result.page.next_cursor });
    assert.equal(rulesNext.result.rows[0].rule.conflict, true); assert.equal(rulesNext.result.page.has_more, false);
    const noRules = await call('read_applicable_rules', { snapshotId: first.result.snapshot_id });
    assert.equal(noRules.result.status, 'no_rule_products'); assert.ok(noRules.result.gaps.some((gap: any) => gap.code === 'NO_RULE_PRODUCTS'));
    const events = await call('read_event_timeline');
    assert.equal(events.result.rows[0].event.content_nature, 'plan');
    const eventsNext = await call('read_event_timeline', { cursor: events.result.page.next_cursor });
    assert.equal(eventsNext.result.rows[0].event.content_nature, 'outcome'); assert.equal(eventsNext.result.rows[0].event.status, 'completed');
    const invalid = [];
    for (const extra of [{ history_mode: 'market_known_at' }, { caller_roles: ['read', 'publish'] }, { store: fixture.store }]) {
      const found = await call('read_company_context', extra, 409); assert.equal(found.code, 'R1_READ_INPUT'); invalid.push(found);
    }
    const arbitrary = await call('trace_evidence', {}, 409); assert.equal(arbitrary.code, 'R1_CONTEXT_INPUT');
    const cursorDrift = await call('read_event_timeline', { cursor: company.result.page.next_cursor }, 409);
    assert.equal(cursorDrift.code, 'CURSOR_QUERY_MISMATCH');
    const changedIdentity = await call('read_company_context', { maxDepth: 1, cursor: company.result.page.next_cursor,
      subject: { ...base.subject, namespace: 'different_namespace' } }, 409);
    assert.equal(changedIdentity.code, 'CURSOR_QUERY_MISMATCH');
    transcript.firstPublication = first.result; transcript.finalPublication = second.result;
    Object.assign(transcript, { companyZero, company, companyNext, graph, rules, rulesNext, noRules, events, eventsNext, invalid, arbitrary, cursorDrift, changedIdentity });
    await host.close(); host = await openFullChainHost(fixture);
    const restored = await call('read_company_context', { maxDepth: 1, cursor: company.result.page.next_cursor });
    assert.deepEqual(restored.result, companyNext.result);
    transcript.restored = restored;
    const sourceKeys = new Set(['source_binding', 'evidence_refs', 'source_url', 'storage_path', 'file_path', 'local_path', 'processing']);
    const noPrivateKeys = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(noPrivateKeys);
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
        assert.equal(sourceKeys.has(key), false, key); noPrivateKeys(child);
      }
    };
    for (const found of [company, graph, rules, events]) noPrivateKeys(found.result);
    writeFileSync(join(fixture.root, 'context-six-verification.json'), JSON.stringify({ fixture: 'six generated rows; actual Python, WFD publication and ordinary HTTP reads; no real business database or model', snapshotId, base, transcript }, null, 2));
    writeFileSync(join(fixture.root, 'fixture.json'), JSON.stringify(fixture, null, 2));
  } finally { await host.close(); }
});
