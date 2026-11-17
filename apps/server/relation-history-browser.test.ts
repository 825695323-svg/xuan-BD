import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { assertR1ContextHistoryEcho, buildR1ContextHistory } from '../web/src/r1-context-history.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';
const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const program = process.env.XUAN_TEST_BROWSER, digest = process.env.XUAN_TEST_BROWSER_SHA256, webRoot = process.env.XUAN_TEST_WEB_ROOT;
const browserEnabled = enabled && !!program && !!digest && !!webRoot;
type Browser = Awaited<ReturnType<typeof openIsolatedBrowser>>;
const q = JSON.stringify, root = '.r1-context-panel';
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
function document(id: string, rows: WfdRecord[], definitionTime: WfdRecord, selectedDataset = datasetId, parent: string | null = null) {
  const doc = buildStructuredIngestDocument({ requestId: id, datasetId: selectedDataset, namespace, producerNamespace: namespace,
    submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ id, rows, definitionTime })), expectedParentSnapshotId: parent,
    outputKey: 'relations', subject, definitionPublicTime: definitionTime,
    definition: { semantic_code: 'synthetic.relation.' + selectedDataset, measurement_nature: 'relation', unit_code: 'not_applicable',
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
const early = '2025-02-01T00:00:00Z', late = '2025-04-02T00:00:00Z', valid = '2025-05-01T00:00:00Z';
const unknownDataset = 'synthetic_unknown_relation_history';
async function seed(host: FullChainHost) {
  const effective = interval('2025-03-01T00:00:00Z', '2026-01-01T00:00:00Z');
  const rows = [edge('entity-link', identity('synthetic_instrument', 'instrument'), 'listed_as', effective, second('2025-01-02T08:00:00Z')),
    edge('theme-link', identity('synthetic_theme_group'), 'declared_theme_member', effective, second('2025-04-01T08:00:00Z')),
    edge('unknown-effective', identity('synthetic_unknown_effective'), 'related_to', unknown(), second('2025-01-02T08:00:00Z')),
    edge('unknown-public', identity('synthetic_unknown_public'), 'related_to', effective, unknown())];
  const known = await publish(host, document('browser-known', rows, second('2025-01-01T00:00:00Z')));
  const unavailable = await publish(host, document('browser-unknown', [rows[0]!], unknown(), unknownDataset, known.snapshotId));
  return { known, snapshotId: unavailable.snapshotId };
}
function graphInput(snapshotId: string, at = early, start = valid, dataset = datasetId) {
  return { operation: 'read_relation_graph' as const, datasetId: dataset, snapshotId, subject, maxDepth: 1, pageSize: 1,
    ...buildR1ContextHistory({ historyMode: 'market_known_at', at, start, end: start }) };
}
async function verifyHost(host: FullChainHost, snapshotId: string) {
  const earlyInput = graphInput(snapshotId), first = await host.call('/r1/query/context', earlyInput);
  assert.equal(first.result.page.has_more, true);
  assert.ok(first.result.nodes.some((node: any) => node.identity.id === 'synthetic_instrument'));
  assert.ok(!first.result.nodes.some((node: any) => ['synthetic_theme_group', 'synthetic_unknown_effective', 'synthetic_unknown_public'].includes(node.identity.id)));
  assert.deepEqual(first.result.business_time_range, earlyInput.businessTimeRange);
  const next = await host.call('/r1/query/context', { ...earlyInput, cursor: first.result.page.next_cursor });
  assert.equal(next.result.page.has_more, false);
  const uncertain = [...first.result.edges, ...next.result.edges].find((edge: any) => edge.object.id === 'synthetic_unknown_effective');
  assert.equal(uncertain.connectivity, 'indeterminate'); assert.equal(uncertain.traversed, false);
  const later = await host.call('/r1/query/context', { ...graphInput(snapshotId, late), pageSize: 100 });
  assert.ok(later.result.nodes.some((node: any) => node.identity.id === 'synthetic_theme_group'));
  assert.ok(!later.result.nodes.some((node: any) => node.identity.id === 'synthetic_unknown_public'));
  assert.ok(later.result.edges.every((edge: any) => edge.content_nature === 'source_claim'));
  const beforeEffective = await host.call('/r1/query/context', graphInput(snapshotId, late, early));
  assert.equal(beforeEffective.result.nodes.length, 1);
  const denied = await host.call('/r1/query/context', graphInput(snapshotId, late, valid, unknownDataset), 409);
  assert.equal(denied.code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
  assert.deepEqual((await host.call('/r1/query/context', earlyInput)).result, first.result,
    'The fixed graph result includes deterministic budget accounting, not elapsed wall-clock time');
  for (const operation of ['read_company_context', 'read_applicable_rules', 'read_event_timeline'] as const) {
    const request = { operation, datasetId, snapshotId, subject, pageSize: 20 };
    const snapshot = await host.call('/r1/query/context', request);
    assertR1ContextHistoryEcho(request, snapshot);
    assert.equal(snapshot.operation, operation); assert.equal(snapshot.historyMode, 'snapshot_contents');
    assert.deepEqual(snapshot.subject, subject); assert.ok(Array.isArray(snapshot.result.rows));
  }
  return first;
}

// Native synthetic WFD submission and HTTP qualification, not an upload/processing test.
test('relation UI transport UTC inputs exercise actual WFD public and inclusive validity boundaries',
  { skip: !enabled, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'relation-ui-host', machine: true, units: { text: { dimension: 'text' } } });
    const host = await openFullChainHost(fixture);
    try { const { snapshotId } = await seed(host); await verifyHost(host, snapshotId); }
    finally { await host.close(); }
  });

async function fill(browser: Browser, label: string, value: string) {
  await browser.evaluate(`(()=>{const e=document.querySelector('[aria-label='+${q(JSON.stringify(label))}+']');if(!e||e.disabled)throw Error('Unavailable '+${q(label)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${q(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function click(browser: Browser, text: string, twice = false) {
  const button = `[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.textContent.trim()===${q(text)}&&!e.disabled)`;
  await browser.until(`!!(${button})`, 'Button unavailable ' + text);
  await browser.evaluate(`(()=>{const e=${button};e.click();${twice ? 'e.click();' : ''}})()`);
  await browser.until(`document.querySelector(${q(root)})?.getAttribute('aria-busy')==='false'`, 'Context read did not settle');
}
async function navigate(browser: Browser, host: FullChainHost, english = false) {
  await browser.page('Page.navigate', { url: host.base.replace('/api/bd', '/') });
  await browser.until(`(()=>{if(document.querySelector('[aria-label="${english ? 'Query kind' : '查询种类'}"]')&&document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;(document.querySelector('button[aria-label="数据库"]')||document.querySelector('button[aria-label="Database"]'))?.click();return false;})()`, 'Actual application query selector unavailable');
  await fill(browser, english ? 'Query kind' : '查询种类', 'read_relation_graph');
  assert.equal(await browser.evaluate(`document.querySelectorAll('.r1-read-panel').length`), 1, 'The product reader remains unique beside context queries');
  assert.equal(await browser.evaluate(`document.querySelectorAll(${q(root)}).length`), 1, 'The context reader remains unique');
}
async function select(browser: Browser, dataset = datasetId) {
  await click(browser, '载入当前快照主体');
  const value = await browser.evaluate<string>(`[...document.querySelector('[aria-label="数据集与完整主体"]').options].find(e=>e.textContent.startsWith(${q(dataset + ' ·')})).value`);
  await fill(browser, '数据集与完整主体', value);
}
async function history(browser: Browser, at = early, start = valid) {
  await fill(browser, '关系图时间视角', 'market_known_at');
  await fill(browser, '公开知识截止（秒级 UTC）', at);
  await fill(browser, '有效期起点（秒级 UTC）', start);
  await fill(browser, '有效期终点（含该秒，UTC）', start);
}
async function result(browser: Browser): Promise<any> {
  return browser.evaluate(`(()=>{const details=[...document.querySelector(${q(root)}).querySelectorAll('.r1-read-result details')];return JSON.parse(details.at(-1).querySelector('pre').textContent);})()`);
}
const noResult = (browser: Browser) => browser.evaluate<boolean>(`!document.querySelector(${q(root + ' .r1-read-result')})`);
async function capture(browser: Browser, visualRoot: string, name: string, width: number, theme: string) {
  await browser.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await browser.page('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
  await browser.evaluate(`document.querySelector(${q(root)}).scrollIntoView({block:'start'})`);
  const boxes: Array<{ label: string; left: number; right: number; width: number; parentLeft: number; parentRight: number; viewport: number }> = await browser.evaluate(`(()=>{const r=document.querySelector(${q(root)}),p=r.getBoundingClientRect();return [...r.querySelectorAll('input[aria-label],select[aria-label]')].map(e=>{const b=e.getBoundingClientRect();return {label:e.getAttribute('aria-label'),left:b.left,right:b.right,width:b.width,parentLeft:p.left,parentRight:p.right,viewport:innerWidth};});})()`);
  assert.ok(boxes.length >= 4);
  for (const box of boxes) assert.ok(box.label && box.width > 0 && box.left >= Math.max(-2, box.parentLeft - 2)
    && box.right <= Math.min(box.viewport + 2, box.parentRight + 2), JSON.stringify(box));
  writeFileSync(join(visualRoot, name + '.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}

test('actual React relation history keeps public knowledge and validity independent across pages and reloads',
  { skip: !browserEnabled ? 'Requires explicit browser SHA, web build, Python and isolated root; host test is not browser acceptance.' : false, timeout: 300_000 }, async () => {
    assert.equal(wfdSha256(readFileSync(program!)), digest);
    const fixture = createFullChainFixture({ name: 'relation-ui', machine: true, units: { text: { dimension: 'text' } } });
    const visualRoot = process.env.XUAN_RELATION_VISUAL_ROOT ?? fixture.root;
    assert.ok(isAbsolute(visualRoot)); mkdirSync(visualRoot, { recursive: true });
    let host = await openFullChainHost(fixture, webRoot!); let browser: Browser | undefined;
    try {
      const { snapshotId } = await seed(host); const baseline = await verifyHost(host, snapshotId);
      browser = await openIsolatedBrowser(program!, fixture.root);
      await navigate(browser, host); await select(browser);
      await click(browser, '读取固定快照上下文'); assert.equal((await result(browser)).historyMode, 'snapshot_contents');
      await fill(browser, '关系图时间视角', 'market_known_at'); assert.equal(await noResult(browser), true);
      for (const label of ['公开知识截止（秒级 UTC）', '有效期起点（秒级 UTC）', '有效期终点（含该秒，UTC）'])
        assert.equal(await browser.evaluate(`document.querySelector('[aria-label='+${q(JSON.stringify(label))}+']').value`), '');
      await history(browser); await fill(browser, '每页条数', '1');
      const before = browser.requests.filter(r => r.url.endsWith('/r1/query/context')).length;
      await click(browser, '读取固定快照上下文', true);
      assert.equal(browser.requests.filter(r => r.url.endsWith('/r1/query/context')).length, before + 1);
      assert.deepEqual((await result(browser)).result, baseline.result);
      await click(browser, '继续下一页上下文'); assert.equal((await result(browser)).result.page.has_more, false);
      await fill(browser, '公开知识截止（秒级 UTC）', late); assert.equal(await noResult(browser), true);
      await fill(browser, '每页条数', '100'); await click(browser, '读取固定快照上下文');
      let view = await result(browser);
      assert.ok(view.result.nodes.some((node: any) => node.identity.id === 'synthetic_theme_group'));
      assert.ok(!view.result.nodes.some((node: any) => node.identity.id === 'synthetic_unknown_public'));
      await fill(browser, '有效期起点（秒级 UTC）', early); assert.equal(await noResult(browser), true);
      await fill(browser, '有效期终点（含该秒，UTC）', early); await click(browser, '读取固定快照上下文');
      assert.equal((await result(browser)).result.nodes.length, 1);
      await history(browser, late); await click(browser, '读取固定快照上下文');
      const invalidBefore = browser.requests.filter(r => r.url.endsWith('/r1/query/context')).length;
      await fill(browser, '有效期终点（含该秒，UTC）', '2025-02-30T00:00:00Z'); await click(browser, '读取固定快照上下文');
      assert.equal(await noResult(browser), true);
      assert.equal(browser.requests.filter(r => r.url.endsWith('/r1/query/context')).length, invalidBefore);
      await history(browser, late); await click(browser, '读取固定快照上下文');
      await capture(browser, visualRoot, 'relation-light-zh', 1440, 'light');
      await capture(browser, visualRoot, 'relation-dark-zh-narrow', 390, 'dark');
      await select(browser, unknownDataset); await history(browser, late); await click(browser, '读取固定快照上下文');
      assert.equal(await noResult(browser), true);
      assert.match(await browser.evaluate<string>(`document.querySelector(${q(root)}).textContent`), /历史定义资格|历史.*定义|history.*definition/iu);
      await browser.close(); browser = undefined; await host.close(); host = await openFullChainHost(fixture, webRoot!);
      const reopened = join(fixture.root, 'r'); mkdirSync(reopened); browser = await openIsolatedBrowser(program!, reopened);
      await navigate(browser, host); await select(browser); await history(browser); await fill(browser, '每页条数', '1');
      await click(browser, '读取固定快照上下文'); assert.deepEqual((await result(browser)).result, baseline.result);
      // Browser transport fault injection only: delay a real read response, then change the
      // capabilities identity presented to the parent. This is NOT a real second WFD store.
      await browser.evaluate(`(()=>{const original=window.fetch.bind(window);window.__historyOriginalFetch=original;window.__historyReadWaiting=false;window.fetch=async(...args)=>{const url=String(args[0]);const response=await original(...args);if(url.endsWith('/r1/query/context')){window.__historyReadWaiting=true;await new Promise(resolve=>{window.__historyReleaseRead=resolve;});window.__historyReadReleased=true;}if(url.endsWith('/r1/capabilities')){const body=await response.json();body.connection={...body.connection,connectionId:body.connection.connectionId+'-synthetic-drift'};return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});}return response;};})()`);
      await browser.evaluate(`[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.textContent.trim()==='读取固定快照上下文'&&!e.disabled).click()`);
      await browser.until('window.__historyReadWaiting===true', 'Actual read response did not reach the injection hold');
      await browser.click('刷新状态');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      await browser.evaluate('window.__historyReleaseRead()');
      await browser.until('window.__historyReadReleased===true', 'Delayed response was not released');
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false, 'Old identity read must not restore a result after parent remount');
      await browser.evaluate('window.fetch=window.__historyOriginalFetch');
      await browser.click('刷新状态');
      // Change only the disposable host's preferences using its real current session headers.
      await browser.evaluate(`(async()=>{const session=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));if(!Number.isSafeInteger(session?.generation))throw Error('Missing verified local-data session');const headers={'x-local-data-generation':String(session.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const response=await fetch('/api/ui/preferences',{headers});if(!response.ok)throw Error('Isolated preference read failed');const p=await response.json();const r=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en'})});if(!r.ok)throw Error('Isolated language change failed');})()`);
      await navigate(browser, host, true);
      await fill(browser, 'Relation graph perspective', 'market_known_at');
      for (const label of ['Knowledge cutoff (UTC seconds)', 'Validity start (UTC seconds)', 'Validity end (inclusive UTC second)'])
        assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label='+${q(JSON.stringify(label))}+']')`), true);
      await capture(browser, visualRoot, 'relation-light-en', 1440, 'light');
      for (const operation of ['read_company_context', 'read_applicable_rules', 'read_event_timeline'] as const) {
        await fill(browser, 'Query kind', operation);
        assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label="Relation graph perspective"]')`), false);
        await click(browser, 'Load current snapshot subjects');
        const option = await browser.evaluate<string>(`[...document.querySelector('[aria-label="Dataset and full subject"]').options].find(e=>e.textContent.startsWith(${q(datasetId + ' ·')})).value`);
        await fill(browser, 'Dataset and full subject', option);
        await click(browser, 'Read fixed snapshot context');
        const snapshot = await result(browser);
        assert.equal(snapshot.operation, operation); assert.equal(snapshot.result.operation, operation);
        assert.equal(snapshot.historyMode, 'snapshot_contents'); assert.equal(snapshot.result.history_mode, 'snapshot_contents');
        assert.equal(snapshot.snapshotId, snapshotId); assert.equal(snapshot.result.snapshot_id, snapshotId);
        assert.equal(snapshot.datasetId, datasetId); assert.deepEqual(snapshot.subject, subject);
        assert.deepEqual(snapshot.result.subject, subject); assert.ok(Array.isArray(snapshot.result.rows));
        for (const label of ['Relation graph perspective', 'Knowledge cutoff (UTC seconds)', 'Validity start (UTC seconds)', 'Validity end (inclusive UTC second)'])
          assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label='+${q(JSON.stringify(label))}+']')`), false);
      }
      assert.equal(browser.blockedRequests.length, 0);
    } finally { await browser?.close(); await host.close(); }
  });
