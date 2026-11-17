import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { assertR1FilterEcho } from '../web/src/r1-filter-history.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const program = process.env.XUAN_TEST_BROWSER, digest = process.env.XUAN_TEST_BROWSER_SHA256, webRoot = process.env.XUAN_TEST_WEB_ROOT;
const browserEnabled = enabled && !!program && !!digest && !!webRoot;
type Browser = Awaited<ReturnType<typeof openIsolatedBrowser>>;
const namespace = 'full.chain.test', dataset = 'synthetic_filter_history', unknownDataset = 'synthetic_filter_unknown';
const early = '2025-02-01T00:00:00Z', late = '2025-04-02T00:00:00Z';
const second = (at: string): WfdRecord => ({ status: 'known', precision: 'second', earliest_utc: at,
  latest_exclusive_utc: new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' });
const subject = (id: string) => ({ kind: 'entity', namespace, id: 'synthetic_filter_' + id });
function document(id: string, parent: string | null, publicTime?: WfdRecord, unknownDefinition = false) {
  return buildStructuredIngestDocument({ requestId: 'filter-' + id, datasetId: unknownDefinition ? unknownDataset : dataset,
    namespace, producerNamespace: namespace, submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ id, parent, publicTime: publicTime ?? null })),
    expectedParentSnapshotId: parent, outputKey: 'amount', subject: subject(id),
    ...(!unknownDefinition ? { definitionPublicTime: second('2024-01-01T00:00:00Z') } : {}),
    definition: { semantic_code: unknownDefinition ? 'synthetic.filter.unknown' : 'synthetic.filter.amount',
      measurement_nature: 'flow', unit_code: 'per_field', definition_authority: namespace, time_role: 'observation',
      semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
        time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'UTC' } },
      field_definitions: [{ field_code: 'amount', data_type: 'decimal', unit_code: 'count', measurement_nature: 'flow', time_role: 'observation' }] },
    inputMode: 'partial_observation', coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows: [{ business_key: id, subject: subject(id),
      observation_time: { status: 'known', precision: 'day', earliest_utc: '2025-01-02T00:00:00Z', latest_exclusive_utc: '2025-01-03T00:00:00Z', source_timezone: 'UTC' },
      ...(publicTime ? { public_time: publicTime } : {}), values: { amount: { data_type: 'decimal', value_state: 'valid_value', value: '10' } } }] } });
}
async function seed(host: FullChainHost) {
  let snapshotId: string | null = null;
  const products: Array<{ subject: WfdRecord; product_id: string }> = []; let unknownProduct = '';
  const beforeHolding = new Date(Date.now() - 2000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  for (const id of ['a', 'b', 'c', 'unknown']) {
    const result: WfdRecord = (await host.services.r1Runtime!.client.submit(document(id, snapshotId,
      id === 'c' ? undefined : second(id === 'b' ? '2025-04-01T00:00:00Z' : '2025-01-02T00:00:00Z'), id === 'unknown'))).result;
    assert.equal(result.state, 'published_formal', JSON.stringify(result)); assert.equal(result.formal_publication_verified, true);
    snapshotId = String(result.snapshot_id); const product_id = String((result.output_results as WfdRecord[])[0]!.product_id);
    if (id === 'unknown') unknownProduct = product_id; else products.push({ subject: subject(id), product_id });
  }
  const observed = Date.now(); await delay(1100);
  const cutoff = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z'); assert.ok(Date.parse(cutoff) > observed);
  const status = await host.call('/r1/products/snapshot', {}); assert.ok(status.holdingInstance?.instanceId);
  return { snapshotId: snapshotId!, products, unknownProduct, instance: status.holdingInstance.instanceId as string, cutoff, beforeHolding };
}
type Seed = Awaited<ReturnType<typeof seed>>;
function plan(state: Seed, mode = 'snapshot_contents', at = early, stage: string | null = null): Record<string, any> {
  return { dataset_id: dataset, snapshot_id: state.snapshotId, history_mode: mode,
    knowledge_cutoff: mode === 'snapshot_contents' ? null : second(at), held_scope: mode === 'system_held_at' ? state.instance : null,
    usable_stage: stage, universe: { kind: 'explicit_subjects', subjects: state.products.map(p => p.subject) },
    metrics: [{ metric: 'field_0', field: 'amount', bindings: state.products }],
    business_time_range: { role: 'observation', start: '2025-01-02', end: '2025-01-02', timezone: 'UTC' },
    predicate: { compare: { metric: 'field_0', op: '>=', value: { data_type: 'decimal', value: '0', unit_code: 'count' } } },
    order_by: [{ kind: 'subject', direction: 'asc' }], page_size: 1, cursor: null };
}
async function verifyHost(host: FullChainHost, state: Seed) {
  const discovery = await host.call('/r1/products/discover', { snapshotId: state.snapshotId });
  const input = plan(state), first = await host.call('/r1/query/filter', input);
  assertR1FilterEcho(input, first, discovery);
  assert.equal(first.page.total_objects, 3); assert.equal(first.objects[0].subject.id, 'synthetic_filter_a');
  const next = await host.call('/r1/query/filter', { ...input, cursor: first.page.next_cursor });
  assertR1FilterEcho({ ...input, cursor: first.page.next_cursor }, next, discovery, first.query_hash);
  assert.throws(() => assertR1FilterEcho(input, next, discovery, 'sha256:' + '0'.repeat(64)));
  assert.equal(next.objects[0].subject.id, 'synthetic_filter_b'); assert.equal(next.query_hash, first.query_hash);
  const publicEarly = await host.call('/r1/query/filter', plan(state, 'market_known_at'));
  assertR1FilterEcho(plan(state, 'market_known_at'), publicEarly, discovery);
  assert.equal(publicEarly.page.total_objects, 1); assert.equal(publicEarly.indeterminate.length, 2);
  const publicLate = await host.call('/r1/query/filter', plan(state, 'market_known_at', late));
  assertR1FilterEcho(plan(state, 'market_known_at', late), publicLate, discovery);
  assert.equal(publicLate.page.total_objects, 2); assert.equal(publicLate.indeterminate.length, 1);
  const readable = await host.call('/r1/query/filter', plan(state, 'system_held_at', state.cutoff, 'published_readable'));
  assertR1FilterEcho(plan(state, 'system_held_at', state.cutoff, 'published_readable'), readable, discovery);
  assert.equal(readable.page.total_objects, 3);
  // Faults mutate copies of actual native results; no successful evidence is fabricated.
  const cutoffDrift = structuredClone(publicLate); cutoffDrift.knowledge_cutoff.earliest_utc = early;
  assert.throws(() => assertR1FilterEcho(plan(state, 'market_known_at', late), cutoffDrift, discovery));
  const wrongField = structuredClone(first); wrongField.bindings[0].field = 'undeclared';
  assert.throws(() => assertR1FilterEcho(input, wrongField, discovery));
  const wrongDefinition = structuredClone(first); wrongDefinition.bindings[0].definition_ref.digest = 'sha256:' + '0'.repeat(64);
  assert.throws(() => assertR1FilterEcho(input, wrongDefinition, discovery));
  const wrongRecord = structuredClone(first); wrongRecord.objects[0].record_refs.field_0.record_ref.record_version = 'wrong';
  assert.throws(() => assertR1FilterEcho(input, wrongRecord, discovery));
  for (const stage of ['acquired', 'custodied']) {
    const rejected = await host.call('/r1/query/filter', plan(state, 'system_held_at', state.cutoff, stage), 409);
    assert.equal(rejected.code, 'INSTANCE_HOLDING_UNKNOWN');
  }
  assert.equal((await host.call('/r1/query/filter', plan(state, 'system_held_at', state.beforeHolding, 'published_readable'), 409)).code,
    'INSTANCE_HOLDING_NOT_YET_AVAILABLE');
  const unknown = plan(state, 'market_known_at', late);
  unknown.dataset_id = unknownDataset; unknown.universe.subjects = [subject('unknown')];
  unknown.metrics[0].bindings = [{ subject: subject('unknown'), product_id: state.unknownProduct }];
  const rejected = await host.call('/r1/query/filter', unknown, 409);
  assert.match(rejected.code, /HISTORY.*DEFINITION|HISTORY_METADATA/u);
  return first;
}
// Synthetic native WFD submit, not upload/processing; real publication supplies the only holding evidence.
test('filter history HTTP uses real public qualification and actual published-readable holding without invented stages',
  { skip: !enabled, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'filter-ui-host', machine: true });
    const host = await openFullChainHost(fixture);
    try { await verifyHost(host, await seed(host)); } finally { await host.close(); }
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
  for (const id of ['a', 'b', 'c']) await browser.evaluate(`(()=>{const e=[...document.querySelector(${q(root)}).querySelectorAll('label')].find(e=>e.textContent.startsWith(${q('synthetic_filter_' + id + ' ·')}))?.querySelector('input[type=checkbox]');if(!e)throw Error('Missing synthetic product');e.click();})()`);
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

test('actual React filter history keeps three perspectives explicit through pagination, changes and reopen',
  { skip: !browserEnabled ? 'Requires explicit verified browser, built Web assets and isolated WFD; HTTP is not browser acceptance.' : false, timeout: 300_000 }, async () => {
    assert.equal(wfdSha256(readFileSync(program!)), digest);
    const fixture = createFullChainFixture({ name: 'filter-ui', machine: true });
    const visualRoot = process.env.XUAN_FILTER_VISUAL_ROOT ?? fixture.root;
    assert.ok(isAbsolute(visualRoot)); mkdirSync(visualRoot, { recursive: true });
    let host = await openFullChainHost(fixture, webRoot!); let browser: Browser | undefined;
    try {
      const state = await seed(host); const baseline = await verifyHost(host, state);
      browser = await openIsolatedBrowser(program!, fixture.root); await navigate(browser, host); await setup(browser);
      const count = browser.requests.filter(r => r.url.endsWith('/r1/query/filter')).length;
      await click(browser, '执行固定筛选', true);
      assert.equal(browser.requests.filter(r => r.url.endsWith('/r1/query/filter')).length, count + 1);
      assert.equal((await result(browser)).page.total_objects, 3);
      await click(browser, '继续下一页'); assert.equal((await result(browser)).objects[0].subject.id, 'synthetic_filter_b');
      await fill(browser, '时间资格', 'market_known_at'); assert.equal(await noResult(browser), true);
      await fill(browser, '知识截止（UTC，协调世界时）', early); await click(browser, '执行固定筛选');
      assert.equal((await result(browser)).page.total_objects, 1);
      await fill(browser, '知识截止（UTC，协调世界时）', late); assert.equal(await noResult(browser), true);
      await click(browser, '执行固定筛选'); assert.equal((await result(browser)).page.total_objects, 2);
      await click(browser, '继续下一页');
      await fill(browser, '业务日期终点（含当天）', '2025-01-03'); assert.equal(await noResult(browser), true);
      await fill(browser, '业务日期终点（含当天）', '2025-01-02');
      await fill(browser, '时间资格', 'system_held_at'); await fill(browser, '知识截止（UTC，协调世界时）', state.cutoff);
      for (const stage of ['acquired', 'custodied', 'published_readable']) {
        await fill(browser, '持有阶段', stage); await click(browser, '执行固定筛选');
        if (stage === 'published_readable') { assert.equal((await result(browser)).page.total_objects, 3); assert.equal((await result(browser)).held_scope, state.instance); }
        else { assert.equal(await noResult(browser), true); assert.match(await browser.evaluate<string>(`document.querySelector(${q(root)}).textContent`), /INSTANCE_HOLDING_UNKNOWN|持有|holding/iu); }
      }
      await fill(browser, '知识截止（UTC，协调世界时）', state.beforeHolding); await click(browser, '执行固定筛选');
      assert.equal(await noResult(browser), true);
      await fill(browser, '知识截止（UTC，协调世界时）', state.cutoff); await click(browser, '执行固定筛选');
      const requestsBeforeInvalid = browser.requests.filter(r => r.url.endsWith('/r1/query/filter')).length;
      await fill(browser, '知识截止（UTC，协调世界时）', '2025-02-30T00:00:00Z'); await click(browser, '执行固定筛选');
      assert.equal(await noResult(browser), true);
      assert.equal(browser.requests.filter(r => r.url.endsWith('/r1/query/filter')).length, requestsBeforeInvalid);
      await fill(browser, '知识截止（UTC，协调世界时）', state.cutoff); await click(browser, '执行固定筛选');
      await capture(browser, visualRoot, 'filter-light-zh', 1440, 'light'); await capture(browser, visualRoot, 'filter-dark-zh-narrow', 390, 'dark');
      // Select the actual separate unknown-definition product, not a fabricated response.
      for (const id of ['a', 'b', 'c', 'unknown']) await browser.evaluate(`(()=>{const e=[...document.querySelector(${q(root)}).querySelectorAll('label')].find(e=>e.textContent.startsWith(${q('synthetic_filter_' + id + ' ·')}))?.querySelector('input[type=checkbox]');if(!e)throw Error('Missing synthetic product');e.click();})()`);
      const unknownField = await browser.evaluate<string>(`[...document.querySelector(${q(root)}).querySelectorAll('label')].find(e=>e.textContent.startsWith('条件1字段')).querySelector('select option[value]:not([value=""])').value`);
      await fill(browser, '条件1字段', unknownField); await fill(browser, '时间资格', 'market_known_at');
      await fill(browser, '知识截止（UTC，协调世界时）', late); await click(browser, '执行固定筛选');
      assert.equal(await noResult(browser), true);
      assert.match(await browser.evaluate<string>(`document.querySelector(${q(root)}).textContent`), /历史.*定义|定义.*历史|HISTORY.*DEFINITION|history.*definition/iu);
      await browser.close(); browser = undefined; await host.close(); host = await openFullChainHost(fixture, webRoot!);
      const reopened = join(fixture.root, 'r'); mkdirSync(reopened); browser = await openIsolatedBrowser(program!, reopened);
      await navigate(browser, host); await setup(browser); await click(browser, '执行固定筛选');
      assert.deepEqual((await result(browser)).objects, baseline.objects);
      // Browser transport fault injection only: delay a real read response, then change the
      // capabilities identity presented to the parent. This is NOT a real second WFD store.
      await browser.evaluate(`(()=>{const original=window.fetch.bind(window);window.__historyOriginalFetch=original;window.__historyReadWaiting=false;window.fetch=async(...args)=>{const url=String(args[0]);const response=await original(...args);if(url.endsWith('/r1/query/filter')){window.__historyReadWaiting=true;await new Promise(resolve=>{window.__historyReleaseRead=resolve;});window.__historyReadReleased=true;}if(url.endsWith('/r1/capabilities')){const body=await response.json();body.connection={...body.connection,connectionId:body.connection.connectionId+'-synthetic-drift'};return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});}return response;};})()`);
      await browser.evaluate(`[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.textContent.trim()==='执行固定筛选'&&!e.disabled).click()`);
      await browser.until('window.__historyReadWaiting===true', 'Actual read response did not reach the injection hold');
      await browser.click('刷新状态');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      await browser.evaluate('window.__historyReleaseRead()');
      await browser.until('window.__historyReadReleased===true', 'Delayed response was not released');
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false, 'Old identity read must not restore a result after parent remount');
      await browser.evaluate('window.fetch=window.__historyOriginalFetch');
      await browser.click('刷新状态');
      // Only the disposable host preferences are changed; session headers come from its real UI session.
      await browser.evaluate(`(async()=>{const session=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));if(!Number.isSafeInteger(session?.generation))throw Error('Missing local session');const headers={'x-local-data-generation':String(session.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const r=await fetch('/api/ui/preferences',{headers});if(!r.ok)throw Error('Preference read failed');const p=await r.json();const saved=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en'})});if(!saved.ok)throw Error('Preference update failed');})()`);
      await navigate(browser, host);
      await setup(browser, true);
      await click(browser, 'Run fixed filter');
      assert.equal((await result(browser)).page.total_objects, 3);
      assert.match(await browser.evaluate<string>(`document.querySelector(${q(root + ' .r1-read-result')}).textContent`), /Matching subjects found/u);
      await fill(browser, 'Condition 1 value', 'not-a-decimal'); await click(browser, 'Run fixed filter');
      assert.equal(await noResult(browser), true);
      assert.match(await browser.evaluate<string>(`document.querySelector(${q(root)}).textContent`), /Enter an exact decimal threshold without thousands separators/u);
      await capture(browser, visualRoot, 'filter-error-en', 1440, 'light');
      await fill(browser, 'Condition 1 value', '0');
      await fill(browser, 'Time qualification', 'system_held_at');
      await fill(browser, 'Knowledge cutoff (UTC)', state.cutoff); await fill(browser, 'Holding stage', 'published_readable');
      await click(browser, 'Run fixed filter'); assert.equal((await result(browser)).page.total_objects, 3);
      await capture(browser, visualRoot, 'filter-light-en', 1440, 'light');
      assert.equal(browser.blockedRequests.length, 0);
    } finally { await browser?.close(); await host.close(); }
  });
