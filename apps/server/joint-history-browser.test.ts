import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { assertR1JointEcho } from '../web/src/r1-joint-history.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const program = process.env.XUAN_TEST_BROWSER, digest = process.env.XUAN_TEST_BROWSER_SHA256, webRoot = process.env.XUAN_TEST_WEB_ROOT;
const browserEnabled = enabled && !!program && !!digest && !!webRoot;
type Browser = Awaited<ReturnType<typeof openIsolatedBrowser>>;
const dataset = 'synthetic_joint_history', early = '2025-02-01T00:00:00Z';
const second = (at: string) => ({ status: 'known', precision: 'second', earliest_utc: at,
  latest_exclusive_utc: new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' });
async function publish(host: FullChainHost, id: string, parent: string | null) {
  const subject = { kind: 'entity', namespace: 'full.chain.test', id: 'synthetic_joint_' + id };
  const source = { source_id: 'synthetic-joint', provider: 'isolated-fixture', requested_url: 'https://fixture.example.test/joint.json',
    requested_at_utc: '2025-01-01T00:00:00Z', acquired_at_utc: '2025-01-01T00:00:00Z', usage_scope: 'Explicit synthetic joint history acceptance',
    authorization: { status: 'authorized', basis: 'Operator supplied synthetic fixture; not production authority' } };
  const target = { datasetId: dataset, outputKey: 'amount', expectedParentSnapshotId: parent, subject,
    definitionPublicTime: second('2024-01-01T00:00:00Z'),
    definition: { semantic_code: 'synthetic.joint.amount', measurement_nature: 'flow', unit_code: 'per_field', definition_authority: 'full.chain.test', time_role: 'observation',
      semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim', time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' } },
      field_definitions: [{ field_code: 'amount', data_type: 'decimal', unit_code: 'count', measurement_nature: 'flow', time_role: 'observation' }] },
    inputMode: 'partial_observation', coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
  const mapping = { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end', precision: 'day', sourceTimezone: 'UTC',
    fields: [{ fieldCode: 'amount', value: 'amount', state: 'state' }],
    ...(id !== 'c' ? { publicTime: { earliestUtc: 'public_start', latestExclusiveUtc: 'public_end', precision: 'second', sourceTimezone: 'UTC' } } : {}) };
  const rows = [{ key: id, start: '2025-01-02T00:00:00Z', end: '2025-01-03T00:00:00Z', amount: '10', state: 'valid_value',
    public_start: '2025-01-02T00:00:00Z', public_end: '2025-01-02T00:00:01Z' }];
  const requestId = 'joint-' + id;
  const upload = await host.upload(id + '.json', 'data', Buffer.from(JSON.stringify(rows)), requestId + '-upload');
  assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
  const material = host.services.materials!.getByTask(upload.jobId)!, materialId = material.envelope.materialId;
  const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: key === 'informationNature' ? 'source_claim' : 'synthetic joint ' + key,
    evidence: [{ source: 'operator', field: key, quote: 'Explicit synthetic source with independent declared public time' }] }]));
  const accepted = await host.call('/processing/plans', { requestId: requestId + '-plan', input: {
    routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'amount', materialIds: [materialId], intendedAction: 'publish',
      stages: ['parse', 'structure', 'check'], tables: [{ materialId, format: 'json' }], target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: parent } }] } }, 202);
  const planned = await host.settled(accepted.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
  const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
  for (const kind of ['parse', 'structure', 'check']) {
    const step = host.services.processing!.get(planId).steps.find(step => step.kind === kind)!;
    if (step.state === 'succeeded') continue;
    const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: requestId + '-' + kind }, 202);
    const done = await host.settled(run.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  }
  const prepared = await host.call('/r1/prepare', { requestId, planId, outputId: 'amount', source, target, mapping }, 201);
  const submitted = await host.call(`/r1/requests/${requestId}/submit`, { confirmationDigest: prepared.documentSha256 }, 202);
  const done = await host.settled(submitted.jobId, 180000); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const view = await host.call(`/r1/requests/${requestId}`); assert.equal(view.state, 'associated');
  const ref = view.local.associations[0];
  const fixed = await host.call('/r1/products/read', { snapshotId: ref.snapshot_id, productId: ref.product_id });
  assert.equal(fixed.result.rows.length, 1);
  return { material, ref, subject };
}
async function documentFixture(host: FullChainHost, material: Awaited<ReturnType<typeof publish>>['material'], known: boolean) {
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
    eventTime: { state: 'not_applicable' }, disclosedAt: known ? { state: 'known', value: '2025-01-01T00:00:00Z' } : { state: 'unknown' } }, 202);
  const settled = await host.settled(received.jobId); assert.equal(settled.status, 'succeeded', JSON.stringify(settled.error));
}

async function seed(host: FullChainHost) {
  let snapshotId: string | null = null;
  const products: Array<{ subject: WfdRecord; product_id: string }> = [];
  const materials: string[] = [];
  for (const id of ['a', 'b', 'c']) {
    const item = await publish(host, id, snapshotId); snapshotId = item.ref.snapshot_id;
    products.push({ subject: item.subject, product_id: item.ref.product_id }); materials.push(item.material.envelope.materialId);
    await documentFixture(host, item.material, id !== 'b');
  }
  const indexes = await host.call('/retrieval/index-versions');
  const indexVersion = indexes.items.sort((a: any, b: any) => b.built_at - a.built_at)[0].index_version as string;
  return { snapshotId: snapshotId!, products, materials, indexVersion };
}
type Seed = Awaited<ReturnType<typeof seed>>;
function input(state: Seed, historical = false): { structured: Record<string, any>; documents: Record<string, any> } {
  return { structured: { dataset_id: dataset, snapshot_id: state.snapshotId, history_mode: historical ? 'market_known_at' : 'snapshot_contents',
    knowledge_cutoff: historical ? second(early) : null, held_scope: null, usable_stage: null,
    universe: { kind: 'explicit_subjects', subjects: state.products.map(p => p.subject) },
    metrics: [{ metric: 'field_0', field: 'amount', bindings: state.products }],
    business_time_range: { role: 'observation', start: '2025-01-02', end: '2025-01-02', timezone: 'UTC' },
    predicate: { compare: { metric: 'field_0', op: '>=', value: { data_type: 'decimal', value: '0', unit_code: 'count' } } },
    order_by: [{ kind: 'subject', direction: 'asc' }], page_size: 1, cursor: null },
    documents: { method: 'keyword', query: '联合检索证据', limit: 1, indexVersion: state.indexVersion, mode: historical ? 'market_known_at' : null, asOf: historical ? early : null } };
}
async function verifyHost(host: FullChainHost, state: Seed) {
  const discovery = await host.call('/r1/products/discover', { snapshotId: state.snapshotId });
  const base = input(state), first = await host.call('/retrieval/joint', base);
  await assertR1JointEcho(base, first, discovery); assert.equal(first.status, 'matched'); assert.equal(first.page.total_objects, 3);
  assert.equal(first.objects[0].documents.citations[0].document_id, state.materials[0]);
  const nextInput = { ...base, structured: { ...base.structured, cursor: first.page.next_cursor } };
  const next = await host.call('/retrieval/joint', nextInput);
  await assertR1JointEcho(nextInput, next, discovery, first.structured.query_hash);
  assert.equal(next.objects[0].documents.citations[0].document_id, state.materials[1]);
  const marketInput = input(state, true), market = await host.call('/retrieval/joint', marketInput);
  await assertR1JointEcho(marketInput, market, discovery); assert.equal(market.status, 'coverage_insufficient'); assert.equal(market.objects[0].documents.citations.length, 1); assert.equal(market.page.total_objects, 2);
  assert.equal(market.structured.indeterminate.length, 1);
  const unknownInput = { ...marketInput, structured: { ...marketInput.structured, cursor: market.page.next_cursor } };
  const unknown = await host.call('/retrieval/joint', unknownInput);
  await assertR1JointEcho(unknownInput, unknown, discovery, market.structured.query_hash);
  assert.equal(unknown.objects[0].documents.citations.length, 0);
  assert.ok(unknown.objects[0].gaps.some((g: any) => g.code === 'DOCUMENT_HISTORY_UNAVAILABLE'));
  // Isolate b so native structured coverage is complete. The document's unknown
  // disclosure alone must prevent a paired removal of gaps plus status promotion.
  const bOnly = structuredClone(marketInput);
  bOnly.structured.universe.subjects = [state.products[1]!.subject];
  bOnly.structured.metrics[0].bindings = [state.products[1]!];
  const bUnknown = await host.call('/retrieval/joint', bOnly);
  await assertR1JointEcho(bOnly, bUnknown, discovery);
  assert.equal(bUnknown.structured.status, 'matched');
  assert.equal(bUnknown.structured.indeterminate.length, 0);
  assert.equal(bUnknown.status, 'coverage_insufficient');
  assert.equal(bUnknown.objects[0].documents.status, 'history_unavailable');
  const concealedUnknown = structuredClone(bUnknown);
  concealedUnknown.objects[0].gaps = []; concealedUnknown.status = 'matched';
  await assert.rejects(assertR1JointEcho(bOnly, concealedUnknown, discovery));
  for (const [documents, expectedStatus] of [
    [{ ...base.documents, indexVersion: 'unknown-index' }, 'index_missing'],
    [{ ...base.documents, query: 'synthetic_unmatched_needle_987654321' }, 'no_match'],
  ] as const) {
    const gapInput = { ...base, documents };
    const actualGap = await host.call('/retrieval/joint', gapInput);
    await assertR1JointEcho(gapInput, actualGap, discovery);
    assert.equal(actualGap.structured.status, 'matched');
    assert.equal(actualGap.status, 'coverage_insufficient');
    assert.equal(actualGap.objects[0].documents.status, expectedStatus);
    const concealed = structuredClone(actualGap);
    concealed.objects[0].gaps = []; concealed.status = 'matched';
    await assert.rejects(assertR1JointEcho(gapInput, concealed, discovery));
  }
  const promoted = structuredClone(unknown); promoted.status = 'matched';
  await assert.rejects(assertR1JointEcho(unknownInput, promoted, discovery));
  const noSnapshotGap = structuredClone(first); noSnapshotGap.gaps = [];
  await assert.rejects(assertR1JointEcho(base, noSnapshotGap, discovery));
  const mutations: Array<(r: any) => void> = [
    r => { r.objects[0].documents.status = 'no_match'; },
    r => { r.objects[0].documents.gaps = []; },
    r => { r.structured.knowledge_cutoff.earliest_utc = '2025-01-01T00:00:00Z'; },
    r => { r.structured.bindings[0].field = 'wrong'; },
    r => { r.structured.objects[0].record_refs.field_0.record_ref.logical_key = 'wrong'; },
    r => { r.qualification.as_of = null; }, r => { r.qualification.document_index_version = 'wrong'; },
    r => { r.objects[0].subject.id = 'wrong'; }, r => { r.objects[0].values = {}; }, r => { r.objects[0].record_refs = {}; },
    r => { r.objects[0].associations[0].recordVersion = 'wrong'; }, r => { r.objects[0].associations[0].materialIds = ['wrong']; },
    r => { r.objects[0].documents.citations[0].index_version = 'wrong'; }, r => { r.objects[0].documents.citations[0].document_id = 'wrong'; },
    r => { r.objects[0].documents.citations[0].excerpt_truncated = true; },
    r => { r.objects[0].documents.citations[0].char_end += 1; },
    r => { r.objects[0].documents.citations[0].excerpt += 'tampered'; }, r => { r.context_digest = 'sha256:' + '0'.repeat(64); },
  ];
  for (const mutate of mutations) { const changed = structuredClone(market); mutate(changed); await assert.rejects(assertR1JointEcho(marketInput, changed, discovery)); }
  await assert.rejects(assertR1JointEcho(nextInput, next, discovery, 'sha256:' + '0'.repeat(64)));
  assert.equal((await host.call('/retrieval/joint', { ...nextInput, documents: { ...base.documents, query: 'changed' } }, 409)).code, 'CURSOR_QUERY_MISMATCH');
  assert.equal((await host.call('/retrieval/joint', { ...nextInput, documents: { ...base.documents, indexVersion: 'unknown-index' } }, 409)).code, 'CURSOR_QUERY_MISMATCH');
  const missing = await host.call('/retrieval/joint', { ...base, documents: { ...base.documents, indexVersion: 'unknown-index' } });
  assert.equal(missing.objects[0].documents.citations.length, 0);
  const runtime = host.services.r1Runtime!, originalIdentity = runtime.currentIdentity.bind(runtime);
  runtime.currentIdentity = () => ({ ...originalIdentity(), connectionId: 'synthetic-injected-drift' });
  try { const refused = await host.call('/retrieval/joint', base, 409); assert.equal(refused.code, 'R1_CONNECTION_BINDING_CHANGED'); assert.ok(!JSON.stringify(refused).includes(state.materials[0]!)); }
  finally { runtime.currentIdentity = originalIdentity; }
  const control = host.services.tasks.getControl.bind(host.services.tasks), machineFilter = runtime.client.filterObjects.bind(runtime.client);
  // Controlled generation/identity faults around a real native read, not fake successful evidence.
  for (const fault of ['identity', 'generation']) {
    runtime.client.filterObjects = async (...args) => {
      const reply = await machineFilter(...args);
      if (fault === 'identity') runtime.currentIdentity = () => ({ ...originalIdentity(), connectionId: 'synthetic-late-drift' });
      else { const fixed = control(); host.services.tasks.getControl = () => ({ ...fixed, generation: fixed.generation + 1 }); }
      return reply;
    };
    try { const rejected = await host.call('/retrieval/joint', base, 409); assert.equal(rejected.code, fault === 'identity' ? 'R1_CONNECTION_BINDING_CHANGED' : 'BD_STOPPED'); assert.ok(!JSON.stringify(rejected).includes(state.materials[0]!)); }
    finally { runtime.client.filterObjects = machineFilter; runtime.currentIdentity = originalIdentity; host.services.tasks.getControl = control; }
  }
  const associations = host.services.r1!.recordMaterials.bind(host.services.r1!);
  host.services.r1!.recordMaterials = () => null;
  try {
    const absent = await host.call('/retrieval/joint', base); assert.equal(absent.objects[0].documents, null);
    assert.ok(absent.objects[0].gaps.some((gap: any) => gap.code === 'BD_RECORD_ASSOCIATION_MISSING'));
    await assertR1JointEcho(base, absent, discovery);
  } finally { host.services.r1!.recordMaterials = associations; }
  return first;
}
test('joint history HTTP uses real upload processing publication and registered synthetic document geometry', { skip: !enabled, timeout: 300000 }, async () => {
  const fixture = createFullChainFixture({ name: 'joint-history-http', machine: true });
  let host = await openFullChainHost(fixture);
  try {
    const state = await seed(host), baseline = await verifyHost(host, state);
    writeFileSync(join(fixture.root, 'joint-verification.json'), JSON.stringify({ state, baseline, scope: 'Real upload and R1 publication; explicitly synthetic conversion geometry, not PDF parsing.' }, null, 2));
    await host.close(); host = await openFullChainHost(fixture);
    assert.deepEqual((await host.call('/retrieval/joint', input(state))).objects, baseline.objects);
  } finally { await host.close(); }
});
const root = '.structured-query-panel:not(.r1-context-panel)', q = JSON.stringify;
async function fill(browser: Browser, label: string, value: string) {
  await browser.evaluate(`(()=>{const r=document.querySelector(${q(root)});const e=r.querySelector('[aria-label='+${q(JSON.stringify(label))}+']')||[...r.querySelectorAll('label')].find(e=>{const c=e.cloneNode(true);c.querySelectorAll('input,select,textarea').forEach(x=>x.remove());return c.textContent.trim()===${q(label)}})?.querySelector('input,select');if(!e||e.disabled)throw Error('Unavailable '+${q(label)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${q(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function click(browser: Browser, text: string, twice = false) {
  const button = `[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.textContent.trim()===${q(text)}&&!e.disabled)`;
  await browser.until(`!!(${button})`, 'Button unavailable ' + text);
  await browser.evaluate(`(()=>{const e=${button};e.click();${twice ? 'e.click();' : ''}})()`);
  await browser.until(`document.querySelector(${q(root)})?.getAttribute('aria-busy')==='false'`, 'Filter read did not settle');
}
async function navigate(browser: Browser, host: FullChainHost) {
  await browser.page('Page.navigate', { url: host.base.replace('/api/bd', '/') });
  await browser.until(`(()=>{if(document.querySelector(${q(root)})&&document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;(document.querySelector('button[aria-label="数据库"]')||document.querySelector('button[aria-label="Database"]'))?.click();return false;})()`, 'Actual filter panel unavailable');
}
async function setup(browser: Browser, english = false) {
  await click(browser, english ? 'Load current snapshot products' : '载入当前快照产品');
  for (const id of ['a', 'b', 'c']) await browser.evaluate(`(()=>{const e=[...document.querySelector(${q(root)}).querySelectorAll('label')].find(e=>e.textContent.startsWith(${q('synthetic_joint_' + id + ' ·')}))?.querySelector('input[type=checkbox]');if(!e)throw Error('Missing synthetic product');e.click();})()`);
  const entries = english ? { 'Business date start': '2025-01-02', 'Business date end (inclusive)': '2025-01-02', 'Business timezone': 'UTC', 'Condition 1 value': '0', 'Objects per page': '1' }
    : { '业务日期起点': '2025-01-02', '业务日期终点（含当天）': '2025-01-02', '业务时区': 'UTC', '条件1原值': '0', '每页对象数': '1' };
  for (const [label, value] of Object.entries(entries)) await fill(browser, label, value!);
  const fieldLabel = english ? 'Condition 1 field' : '条件1字段';
  const field = await browser.evaluate<string>(`[...document.querySelector(${q(root)}).querySelectorAll('label')].find(e=>e.textContent.startsWith(${q(fieldLabel)})).querySelector('select option[value]:not([value=""])').value`);
  await fill(browser, fieldLabel, field);
}
async function result(browser: Browser): Promise<any> {
  return browser.evaluate(`JSON.parse([...document.querySelector(${q(root)}).querySelectorAll('.r1-read-result details')].at(-1).querySelector('pre').textContent)`);
}
const noResult = (browser: Browser) => browser.evaluate<boolean>(`!document.querySelector(${q(root + ' .r1-read-result')})`);
async function capture(browser: Browser, visualRoot: string, name: string, width: number, theme: string) {
  await browser.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await browser.page('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
  await browser.evaluate(`document.querySelector(${q(root)}).scrollIntoView({block:'start'})`);
  const boxes: Array<{ left: number; right: number; width: number; parentLeft: number; parentRight: number; viewport: number }> = await browser.evaluate(`(()=>{const r=document.querySelector(${q(root)}),p=r.getBoundingClientRect();return [...r.querySelectorAll('input,select')].map(e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,width:b.width,parentLeft:p.left,parentRight:p.right,viewport:innerWidth};});})()`);
  assert.ok(boxes.length > 4);
  for (const box of boxes) assert.ok(box.width > 0 && box.left >= Math.max(-2, box.parentLeft - 2) && box.right <= Math.min(box.viewport + 2, box.parentRight + 2), JSON.stringify(box));
  writeFileSync(join(visualRoot, name + '.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}

async function jointSetup(browser: Browser, state: Seed, english = false) {
  await setup(browser, english);
  await fill(browser, english ? 'Related document query (optional)' : '关联资料检索词（可选）', '联合检索证据');
  await fill(browser, english ? 'Fixed document index' : '固定文档索引', state.indexVersion);
}
test('actual React joint history retains fixed document scope and rejects invented holding eligibility',
  { skip: !browserEnabled ? 'Requires verified browser and built assets; HTTP is not browser acceptance.' : false, timeout: 300000 }, async () => {
    assert.equal(wfdSha256(readFileSync(program!)), digest);
    const fixture = createFullChainFixture({ name: 'joint-history-ui', machine: true });
    const visualRoot = process.env.XUAN_JOINT_VISUAL_ROOT ?? fixture.root;
    assert.ok(isAbsolute(visualRoot)); mkdirSync(visualRoot, { recursive: true });
    let host = await openFullChainHost(fixture, webRoot!); let browser: Browser | undefined;
    try {
      const state = await seed(host), baseline = await verifyHost(host, state);
      browser = await openIsolatedBrowser(program!, fixture.root); await navigate(browser, host); await jointSetup(browser, state);
      const count = browser.requests.filter(r => r.url.endsWith('/retrieval/joint')).length;
      await click(browser, '执行固定筛选', true);
      assert.equal(browser.requests.filter(r => r.url.endsWith('/retrieval/joint')).length, count + 1);
      assert.equal((await result(browser)).objects[0].documents.citations[0].document_id, state.materials[0]);
      await click(browser, '继续下一页'); assert.equal((await result(browser)).objects[0].documents.citations[0].document_id, state.materials[1]);
      await fill(browser, '时间资格', 'market_known_at'); assert.equal(await noResult(browser), true);
      await fill(browser, '知识截止（UTC，协调世界时）', early); await click(browser, '执行固定筛选');
      assert.equal((await result(browser)).qualification.historical_claim, true);
      await click(browser, '继续下一页'); assert.equal((await result(browser)).objects[0].documents.citations.length, 0);
      await fill(browser, '知识截止（UTC，协调世界时）', '2025-03-01T00:00:00Z'); assert.equal(await noResult(browser), true);
      await click(browser, '执行固定筛选'); assert.equal((await result(browser)).objects[0].subject.id, 'synthetic_joint_a');
      await fill(browser, '关联资料检索词（可选）', 'changed'); assert.equal(await noResult(browser), true);
      await fill(browser, '关联资料检索词（可选）', '联合检索证据');
      await fill(browser, '固定文档索引', ''); await click(browser, '执行固定筛选'); assert.equal(await noResult(browser), true);
      await fill(browser, '固定文档索引', state.indexVersion);
      await fill(browser, '时间资格', 'system_held_at');
      await fill(browser, '知识截止（UTC，协调世界时）', early); await fill(browser, '持有阶段', 'published_readable');
      const before = browser.requests.filter(r => r.url.endsWith('/retrieval/joint')).length;
      await click(browser, '执行固定筛选'); assert.equal(await noResult(browser), true);
      assert.equal(browser.requests.filter(r => r.url.endsWith('/retrieval/joint')).length, before);
      await fill(browser, '时间资格', 'market_known_at'); await click(browser, '执行固定筛选');
      await capture(browser, visualRoot, 'joint-light-zh', 1440, 'light'); await capture(browser, visualRoot, 'joint-dark-zh-narrow', 390, 'dark');
      await browser.close(); browser = undefined; await host.close(); host = await openFullChainHost(fixture, webRoot!);
      const reopened = join(fixture.root, 'r'); mkdirSync(reopened); browser = await openIsolatedBrowser(program!, reopened);
      await navigate(browser, host); await jointSetup(browser, state); await click(browser, '执行固定筛选');
      assert.deepEqual((await result(browser)).objects, baseline.objects);
      // Transport fault injection: a real reply is delayed while the parent's presented identity changes.
      // This is not a claim of switching between two actual WFD stores.
      await browser.evaluate(`(()=>{const original=window.fetch.bind(window);window.__jointFetch=original;window.fetch=async(...args)=>{const url=String(args[0]);const response=await original(...args);if(url.endsWith('/retrieval/joint')){window.__jointWaiting=true;await new Promise(resolve=>{window.__jointRelease=resolve;});window.__jointReleased=true;}if(url.endsWith('/r1/capabilities')){const body=await response.json();body.connection={...body.connection,connectionId:body.connection.connectionId+'-synthetic-drift'};return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});}return response;};})()`);
      await browser.evaluate(`[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.textContent.trim()==='执行固定筛选'&&!e.disabled).click()`);
      await browser.until('window.__jointWaiting===true', 'Actual joint response did not reach hold'); await browser.click('刷新状态');
      assert.equal(await noResult(browser), true); await browser.evaluate('window.__jointRelease()');
      await browser.until('window.__jointReleased===true', 'Joint reply not released');
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); assert.equal(await noResult(browser), true);
      await browser.evaluate('window.fetch=window.__jointFetch'); await browser.click('刷新状态');
      await browser.evaluate(`(async()=>{const session=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));if(!Number.isSafeInteger(session?.generation))throw Error('Missing local session');const headers={'x-local-data-generation':String(session.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const r=await fetch('/api/ui/preferences',{headers});if(!r.ok)throw Error('Preference read failed');const p=await r.json();const saved=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en'})});if(!saved.ok)throw Error('Preference update failed');})()`);
      await navigate(browser, host); await jointSetup(browser, state, true); await click(browser, 'Run fixed filter');
      assert.equal((await result(browser)).objects[0].documents.citations[0].document_id, state.materials[0]);
      await capture(browser, visualRoot, 'joint-light-en', 1440, 'light');
      await fill(browser, 'Fixed document index', ''); await click(browser, 'Run fixed filter'); assert.equal(await noResult(browser), true);
      assert.match(await browser.evaluate<string>(`document.querySelector(${q(root)}).textContent`), /index/iu);
      await capture(browser, visualRoot, 'joint-error-en', 1440, 'light');
      assert.equal(browser.blockedRequests.length, 0);
    } finally { await browser?.close(); await host.close(); }
  });
