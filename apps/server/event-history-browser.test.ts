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
const datasetId = 'synthetic_event_ui', unknownDataset = 'synthetic_event_unknown_ui', namespace = 'full.chain.test';
const subject = { kind: 'entity', namespace, id: 'synthetic_company' };
const early = '2025-02-01T00:00:00Z', late = '2025-08-01T00:00:00Z';
const second = (at: string): WfdRecord => ({ status: 'known', precision: 'second', earliest_utc: at,
  latest_exclusive_utc: new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' });
const unknown = (): WfdRecord => ({ status: 'unknown', precision: 'unknown', earliest_utc: null, latest_exclusive_utc: null, source_timezone: 'UTC' });
async function seed(host: FullChainHost) {
  let parent: string | null = null;
  for (const [dataset, definitionTime] of [[datasetId, second('2025-01-01T00:00:00Z')], [unknownDataset, unknown()]] as const) {
    const rows = [
      { event_id: 'plan', content_nature: 'plan', status: 'planned', event_time: unknown(), expected_time: second('2025-06-01T00:00:00Z'), public_time: second('2025-01-02T00:00:00Z') },
      { event_id: 'later', content_nature: 'plan', status: 'planned', event_time: unknown(), expected_time: second('2025-07-01T00:00:00Z'), public_time: second('2025-03-01T00:00:00Z') },
      { event_id: 'unknown-announcement', content_nature: 'plan', status: 'planned', event_time: unknown(), expected_time: second('2025-04-01T00:00:00Z'), public_time: unknown() },
    ].map(row => ({ ...row, subject, event_type: 'synthetic-plan', values: { statement: { data_type: 'text', value_state: 'valid_value', value: row.event_id } } }));
    const doc = buildStructuredIngestDocument({ requestId: dataset, datasetId: dataset, namespace, producerNamespace: namespace,
      submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson(rows)), expectedParentSnapshotId: parent, outputKey: 'event', subject, definitionPublicTime: definitionTime,
      definition: { semantic_code: 'synthetic.event.' + dataset, measurement_nature: 'event', unit_code: 'not_applicable', definition_authority: namespace, time_role: 'event',
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'plan' }, field_definitions: [{ field_code: 'statement', data_type: 'text', unit_code: 'text', measurement_nature: 'event', time_role: 'event' }] },
      inputMode: 'partial_observation', coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' }, payload: { kind: 'event_records', rows } });
    const result = (await host.services.r1Runtime!.client.submit(doc)).result;
    assert.equal(result.state, 'published_formal', JSON.stringify(result)); assert.equal(result.formal_publication_verified, true); parent = String(result.snapshot_id);
  }
  return parent!;
}
function input(snapshotId: string, at = early, dataset = datasetId) { return { operation: 'read_event_timeline' as const, snapshotId, datasetId: dataset, subject, pageSize: 1,
  ...buildR1ContextHistory({ operation: 'read_event_timeline', historyMode: 'market_known_at', at }) }; }
async function verify(host: FullChainHost, snapshotId: string) {
  const request = input(snapshotId), view = await host.call('/r1/query/context', request); assertR1ContextHistoryEcho(request, view);
  assert.equal(view.result.rows.length, 1); assert.equal(view.result.rows[0].event.event_id, 'plan');
  assert.equal(view.result.rows[0].times.event_time.status, 'unknown'); assert.equal(view.result.rows[0].times.expected_time.earliest_utc, '2025-06-01T00:00:00Z');
  assert.ok(view.result.eligibility_diagnostics.some((gap: any) => gap.decision === 'indeterminate'));
  assert.equal((await host.call('/r1/query/context', input(snapshotId, early, unknownDataset), 409)).code, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
  return view;
}
test('event UI transport keeps market cutoff distinct from expected time over real WFD HTTP', { skip: !enabled, timeout: 180000 }, async () => {
  const fixture = createFullChainFixture({ name: 'event-ui-http', machine: true, units: { text: { dimension: 'text' } } });
  const host = await openFullChainHost(fixture); try { await verify(host, await seed(host)); } finally { await host.close(); }
});
async function fill(browser: Browser, label: string, value: string) {
  await browser.evaluate(`(()=>{const e=document.querySelector('[aria-label='+${q(JSON.stringify(label))}+']');if(!e||e.disabled)throw Error('Unavailable '+${q(label)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${q(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function click(browser: Browser, text: string, twice = false) {
  const button = `[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.textContent.trim()===${q(text)}&&!e.disabled)`;
  await browser.until(`(()=>{const e=${button};if(!e)return false;e.click();${twice ? 'e.click();' : ''}return true;})()`, 'Button unavailable ' + text);
  await browser.until(`document.querySelector(${q(root)})?.getAttribute('aria-busy')==='false'`, 'Context read did not settle');
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

async function navigate(browser: Browser, host: FullChainHost, english = false) {
  await browser.page('Page.navigate', { url: host.base.replace('/api/bd', '/') });
  await browser.until(`(()=>{if(document.querySelector('[aria-label="${english ? 'Query kind' : '查询种类'}"]')&&document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;(document.querySelector('button[aria-label="数据库"]')||document.querySelector('button[aria-label="Database"]'))?.click();return false;})()`, 'Query panel unavailable');
  await fill(browser, english ? 'Query kind' : '查询种类', 'read_event_timeline');
}
async function select(browser: Browser, dataset = datasetId, english = false) {
  await click(browser, english ? 'Load current snapshot subjects' : '载入当前快照主体');
  const label = english ? 'Dataset and full subject' : '数据集与完整主体';
  const value = await browser.evaluate<string>(`[...document.querySelector('[aria-label='+${q(JSON.stringify(label))}+']').options].find(e=>e.textContent.startsWith(${q(dataset + ' ·')})).value`);
  await fill(browser, label, value);
}

test('actual React event history isolates cutoff, pages, unknown definitions and delayed identities',
  { skip: !browserEnabled, timeout: 300000 }, async () => {
    assert.equal(wfdSha256(readFileSync(program!)), digest);
    const fixture = createFullChainFixture({ name: 'event-ui', machine: true, units: { text: { dimension: 'text' } } });
    const visualRoot = process.env.XUAN_EVENT_VISUAL_ROOT ?? fixture.root;
    assert.ok(isAbsolute(visualRoot)); mkdirSync(visualRoot, { recursive: true });
    let host = await openFullChainHost(fixture, webRoot!); let browser: Browser | undefined;
    try {
      const snapshotId = await seed(host), baseline = await verify(host, snapshotId);
      const tasks = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get();
      browser = await openIsolatedBrowser(program!, fixture.root);
      await navigate(browser, host); await select(browser);
      await click(browser, '读取固定快照上下文'); assert.equal((await result(browser)).historyMode, 'snapshot_contents');
      await fill(browser, '事件时间线视角', 'market_known_at'); assert.equal(await noResult(browser), true);
      assert.equal(await browser.evaluate(`document.querySelector('[aria-label="公开知识截止（秒级 UTC）"]').value`), '');
      assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label="有效期起点（秒级 UTC）"]')`), false);
      assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label="事件时间线视角"] option[value="system_held_at"]')`), false);
      await fill(browser, '公开知识截止（秒级 UTC）', early); await fill(browser, '每页条数', '1');
      const before = browser.requests.filter(r => r.url.endsWith('/r1/query/context')).length;
      await click(browser, '读取固定快照上下文', true);
      assert.equal(browser.requests.filter(r => r.url.endsWith('/r1/query/context')).length, before + 1);
      assert.deepEqual((await result(browser)).result, baseline.result);
      await capture(browser, visualRoot, 'event-light-zh', 1440, 'light');
      await capture(browser, visualRoot, 'event-dark-zh-narrow', 390, 'dark');
      await fill(browser, '公开知识截止（秒级 UTC）', late); assert.equal(await noResult(browser), true);
      await click(browser, '读取固定快照上下文'); assert.equal((await result(browser)).result.page.has_more, true);
      await click(browser, '继续下一页上下文'); assert.equal((await result(browser)).result.page.has_more, false);
      await fill(browser, '公开知识截止（秒级 UTC）', '2025-02-30T00:00:00Z');
      const invalidBefore = browser.requests.filter(r => r.url.endsWith('/r1/query/context')).length;
      await click(browser, '读取固定快照上下文'); assert.equal(await noResult(browser), true);
      assert.equal(browser.requests.filter(r => r.url.endsWith('/r1/query/context')).length, invalidBefore);
      await select(browser, unknownDataset); await fill(browser, '公开知识截止（秒级 UTC）', early);
      await click(browser, '读取固定快照上下文'); assert.equal(await noResult(browser), true);
      assert.match(await browser.evaluate<string>(`document.querySelector(${q(root)}).textContent`), /历史定义资格不足，未以当前元数据替代。/u);
      await select(browser); await fill(browser, '公开知识截止（秒级 UTC）', early); await click(browser, '读取固定快照上下文');
      // A held real response plus capabilities transport drift, not a real second store.
      await browser.evaluate(`(()=>{const original=window.fetch.bind(window);window.__eventOriginal=original;window.fetch=async(...args)=>{const url=String(args[0]);const response=await original(...args);if(url.endsWith('/r1/query/context')){window.__eventWaiting=true;await new Promise(resolve=>window.__eventRelease=resolve);window.__eventReleased=true;}if(url.endsWith('/r1/capabilities')){const body=await response.json();body.connection={...body.connection,connectionId:body.connection.connectionId+'-event-drift'};return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});}return response;};})()`);
      await browser.evaluate(`[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.textContent.trim()==='读取固定快照上下文'&&!e.disabled).click()`);
      await browser.until('window.__eventWaiting===true', 'Read did not reach hold'); await browser.click('刷新状态');
      await browser.evaluate('window.__eventRelease()'); await browser.until('window.__eventReleased===true', 'Read not released');
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); assert.equal(await noResult(browser), true);
      await browser.evaluate('window.fetch=window.__eventOriginal'); await browser.click('刷新状态');
      await browser.close(); browser = undefined; await host.close(); host = await openFullChainHost(fixture, webRoot!);
      const reopened = join(fixture.root, 'r'); mkdirSync(reopened); browser = await openIsolatedBrowser(program!, reopened);
      await navigate(browser, host); await select(browser); await fill(browser, '事件时间线视角', 'market_known_at');
      await fill(browser, '公开知识截止（秒级 UTC）', early); await fill(browser, '每页条数', '1');
      await click(browser, '读取固定快照上下文'); assert.deepEqual((await result(browser)).result, baseline.result);
      await browser.evaluate(`(async()=>{const session=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));const headers={'x-local-data-generation':String(session.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const p=await (await fetch('/api/ui/preferences',{headers})).json();const r=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en'})});if(!r.ok)throw Error('Preference update failed');})()`);
      await navigate(browser, host, true); await select(browser, datasetId, true);
      await fill(browser, 'Event timeline perspective', 'market_known_at'); await fill(browser, 'Knowledge cutoff (UTC seconds)', early);
      await fill(browser, 'Page size', '1'); await click(browser, 'Read fixed snapshot context'); assert.deepEqual((await result(browser)).result, baseline.result);
      await capture(browser, visualRoot, 'event-light-en-narrow', 390, 'light');
      await fill(browser, 'Event timeline perspective', 'snapshot_contents'); assert.equal(await noResult(browser), true);
      assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label="Knowledge cutoff (UTC seconds)"]')`), false);
      await click(browser, 'Read fixed snapshot context'); assert.equal((await result(browser)).historyMode, 'snapshot_contents');
      await fill(browser, 'Event timeline perspective', 'market_known_at'); assert.equal(await noResult(browser), true);
      assert.equal(await browser.evaluate(`document.querySelector('[aria-label="Knowledge cutoff (UTC seconds)"]').value`), '');
      for (const operation of ['read_company_context', 'read_applicable_rules']) {
        await fill(browser, 'Query kind', operation); assert.equal(await noResult(browser), true);
        assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label="Event timeline perspective"]')`), false);
      }
      assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get(), tasks);
      assert.equal(browser.blockedRequests.length, 0);
    } finally { await browser?.close(); await host.close(); }
  });
