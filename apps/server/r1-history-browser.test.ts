import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';

const program = process.env.XUAN_TEST_BROWSER, digest = process.env.XUAN_TEST_BROWSER_SHA256;
const webRoot = process.env.XUAN_TEST_WEB_ROOT;
const enabled = !!(program && digest && webRoot && process.env.WFD_PYTHON && process.env.XUAN_FULL_CHAIN_ROOT);
type Browser = Awaited<ReturnType<typeof openIsolatedBrowser>>;
const q = JSON.stringify, root = '.r1-read-panel';
const second = (at: string): WfdRecord => ({ status: 'known', precision: 'second', earliest_utc: at,
  latest_exclusive_utc: new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' });
function document(id: string, unknownDefinition = false, parent: string | null = null) {
  const namespace = 'full.chain.test', subject = { kind: 'entity', namespace, id: 'synthetic_history_browser' };
  const rows = Array.from({ length: 103 }, (_, index) => ({ business_key: 'row-' + String(index).padStart(3, '0'), subject,
    observation_time: { status: 'known', precision: 'day', earliest_utc: '2024-01-01T00:00:00Z',
      latest_exclusive_utc: '2025-01-01T00:00:00Z', source_timezone: 'UTC' },
    ...(index === 102 ? {} : { public_time: second('2025-01-02T00:00:00Z') }),
    values: { amount: { data_type: 'decimal', value_state: 'valid_value', value: String(index) } } }));
  return buildStructuredIngestDocument({ requestId: id, datasetId: 'synthetic_history_browser', namespace, producerNamespace: namespace,
    submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ id, rows })), expectedParentSnapshotId: parent,
    ...(!unknownDefinition ? { definitionPublicTime: second('2024-01-01T00:00:00Z') } : {}),
    outputKey: 'history', subject, definition: { semantic_code: 'synthetic.browser.' + id, measurement_nature: 'flow', unit_code: 'per_field',
      definition_authority: namespace, time_role: 'observation', semantic_context: { version: 'wfd.semantic-context/1.0',
        content_nature: 'observed_fact', time: { period_type: 'natural', frequency: 'year', interval: 'half_open', timezone: 'UTC' } },
      field_definitions: [{ field_code: 'amount', data_type: 'decimal', unit_code: 'count', measurement_nature: 'flow', time_role: 'observation' }] },
    inputMode: 'partial_observation', coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows } });
}
async function fill(browser: Browser, label: string, value: string) {
  await browser.evaluate(`(()=>{const root=document.querySelector(${q(root)});const e=root.querySelector('[aria-label='+${q(JSON.stringify(label))}+']')||[...root.querySelectorAll('label')].find(e=>{const copy=e.cloneNode(true);copy.querySelectorAll('input,select,textarea').forEach(control=>control.remove());return copy.textContent.trim()===${q(label)};})?.querySelector('input,select');if(!e||e.disabled)throw Error('Unavailable '+${q(label)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${q(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function click(browser: Browser, text: string, twice = false) {
  const expression = `[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.textContent.trim()===${q(text)}&&!e.disabled)`;
  await browser.until(`!!(${expression})`, 'Button unavailable ' + text);
  await browser.evaluate(`(()=>{const e=${expression};e.click();${twice ? 'e.click();' : ''}})()`);
  await browser.until(`document.querySelector(${q(root)})?.getAttribute('aria-busy')==='false'`, 'Read did not settle');
}
async function navigate(browser: Browser, host: FullChainHost) {
  await browser.page('Page.navigate', { url: host.base.replace('/api/bd', '/') });
  await browser.until(`(()=>{if(document.querySelector(${q(root)})&&document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;(document.querySelector('button[aria-label="数据库"]')||document.querySelector('button[aria-label="Database"]'))?.click();return false;})()`, 'Actual application reader unavailable');
}
async function select(browser: Browser, productId: string) {
  await click(browser, '取得当前固定快照');
  await click(browser, '发现快照中的产品');
  await fill(browser, '快照中的产品', productId);
}
async function pageResult(browser: Browser): Promise<any> {
  return browser.evaluate(`(()=>{const e=[...document.querySelector(${q(root)}).querySelectorAll('.r1-read-result details')].find(e=>e.querySelector('summary')?.textContent.includes('本页原始结果'));if(!e)throw Error('Missing actual result');return JSON.parse(e.querySelector('pre').textContent);})()`);
}

// Synthetic machine-submit source fixture, NOT an upload/processing or provider-data test.
// Holding facts are generated by actual publication. No test holding ledger writes.
test('actual React history reader preserves explicit modes, real holding stages and pagination boundaries',
  { skip: !enabled ? 'Requires explicit isolated Python, browser SHA and built Web root.' : false, timeout: 300_000 }, async () => {
    assert.equal(wfdSha256(readFileSync(program!)), digest);
    const fixture = createFullChainFixture({ name: 'history-browser', machine: true });
    const visualRoot = process.env.XUAN_HISTORY_VISUAL_ROOT ?? fixture.root;
    assert.ok(isAbsolute(visualRoot), 'Visual artifact root must be an explicit absolute path.');
    mkdirSync(visualRoot, { recursive: true });
    let host = await openFullChainHost(fixture, webRoot!);
    let browser: Browser | undefined;
    try {
      const publish = async (doc: WfdRecord) => {
        const reply = (await host.services.r1Runtime!.client.submit(doc)).result;
        assert.equal(reply.state, 'published_formal', JSON.stringify(reply));
        assert.equal(reply.formal_publication_verified, true);
        return { snapshotId: String(reply.snapshot_id), productId: String((reply.output_results as WfdRecord[])[0]!.product_id) };
      };
      const beforeHolding = new Date(Date.now() - 2000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
      const known = await publish(document('known'));
      const unknown = await publish(document('unknown', true, known.snapshotId));
      // Wait beyond the observed publication completion before choosing a whole UTC second.
      // This is explicit fixture input, never an application default or a fabricated holding fact.
      const publicationObservedAt = Date.now();
      await delay(1100);
      const cutoff = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
      assert.ok(Date.parse(cutoff) > publicationObservedAt);
      const status = await host.call('/r1/products/snapshot', {});
      assert.ok(status.holdingInstance?.instanceId);
      browser = await openIsolatedBrowser(program!, fixture.root);
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
      await navigate(browser, host); await select(browser, known.productId);
      await click(browser, '读取持久数据');
      assert.equal((await pageResult(browser)).page.total_rows, 103);
      await click(browser, '下一页'); assert.equal((await pageResult(browser)).rows.length, 3);
      await fill(browser, '历史视角', 'market_known_at');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      assert.equal(await browser.evaluate(`document.querySelector('[aria-label="截止时间（秒级 UTC）"]').value`), '');
      await fill(browser, '截止时间（秒级 UTC）', cutoff);
      const requests = browser.requests.filter(r => r.url.endsWith('/r1/products/read')).length;
      await click(browser, '读取持久数据', true);
      assert.equal(browser.requests.filter(r => r.url.endsWith('/r1/products/read')).length, requests + 1);
      let page = await pageResult(browser); assert.equal(page.history_mode, 'market_known_at'); assert.equal(page.page.total_rows, 102);
      await click(browser, '下一页'); assert.equal((await pageResult(browser)).rows.length, 2);
      await fill(browser, '截止时间（秒级 UTC）', '2025-01-01T00:00:00Z');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      await click(browser, '读取持久数据'); assert.equal((await pageResult(browser)).rows.length, 0);
      await fill(browser, '截止时间（秒级 UTC）', '2025-02-30T00:00:00Z');
      const beforeInvalid = browser.requests.filter(r => r.url.endsWith('/r1/products/read')).length;
      await click(browser, '读取持久数据');
      assert.equal(browser.requests.filter(r => r.url.endsWith('/r1/products/read')).length, beforeInvalid);
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      await fill(browser, '历史视角', 'system_held_at'); await fill(browser, '截止时间（秒级 UTC）', cutoff);
      assert.equal(await browser.evaluate(`document.querySelector('[aria-label="所需可用阶段"]').value`), '');
      assert.equal(await browser.evaluate(`document.querySelector('[aria-label="实际持有实例"]').value`), status.holdingInstance.instanceId);
      for (const stage of ['acquired', 'custodied', 'published_readable']) {
        await fill(browser, '所需可用阶段', stage); await click(browser, '读取持久数据');
        if (stage !== 'published_readable') {
          assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
          assert.match(await browser.evaluate<string>(`document.querySelector(${q(root)}).textContent`), /INSTANCE_HOLDING_UNKNOWN/u);
        } else {
          page = await pageResult(browser);
          assert.equal(page.history_mode, 'system_held_at'); assert.equal(page.usable_stage, stage);
          assert.equal(page.held_scope, status.holdingInstance.instanceId); assert.equal(page.page.total_rows, 103);
        }
      }
      await fill(browser, '截止时间（秒级 UTC）', beforeHolding); await click(browser, '读取持久数据');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      assert.match(await browser.evaluate<string>(`document.querySelector(${q(root)}).textContent`), /INSTANCE_HOLDING_NOT_YET_AVAILABLE/u);
      await fill(browser, '截止时间（秒级 UTC）', cutoff); await click(browser, '读取持久数据');
      for (const theme of ['light', 'dark']) {
        await browser.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await browser.page('Emulation.setDeviceMetricsOverride', { width: theme === 'light' ? 1440 : 390, height: 1100, deviceScaleFactor: 1, mobile: false });
        await browser.evaluate(`document.querySelector(${q(root)}).scrollIntoView({block:'start'})`);
        const geometry: Array<{ label: string; x: number; right: number; width: number; parentLeft: number; parentRight: number; viewport: number }> = await browser.evaluate<Array<{ label: string; x: number; right: number; width: number; parentLeft: number; parentRight: number; viewport: number }>>(`(()=>{const root=document.querySelector(${q(root)}),parent=root.getBoundingClientRect();return [...root.querySelectorAll('input[aria-label],select[aria-label]')].map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute('aria-label'),x:r.x,right:r.right,width:r.width,parentLeft:parent.left,parentRight:parent.right,viewport:innerWidth};});})()`);
        assert.ok(geometry.length >= 4);
        for (const control of geometry) {
          assert.ok(control.label && control.width > 0);
          assert.ok(control.x >= control.parentLeft - 2 && control.right <= control.parentRight + 2, JSON.stringify(control));
          assert.ok(control.x >= -2 && control.right <= control.viewport + 2, JSON.stringify(control));
        }
        writeFileSync(join(visualRoot, 'history-' + theme + '.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      }
      await fill(browser, '快照中的产品', unknown.productId); await fill(browser, '历史视角', 'market_known_at');
      await fill(browser, '截止时间（秒级 UTC）', cutoff);
      await click(browser, '读取持久数据');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      assert.match(await browser.evaluate<string>(`document.querySelector(${q(root)}).textContent`), /R1_READ_HISTORY_METADATA_UNSUPPORTED/u);
      await browser.close(); browser = undefined; await host.close(); host = await openFullChainHost(fixture, webRoot!);
      // Keep the isolated reopen path below Chromium's Unix socket path limit.
      const reopened = join(fixture.root, 'r'); mkdirSync(reopened); browser = await openIsolatedBrowser(program!, reopened);
      await navigate(browser, host); await select(browser, known.productId); await click(browser, '读取持久数据');
      assert.equal((await pageResult(browser)).page.total_rows, 103);
      // Browser transport fault injection only: delay a real read response, then change the
      // capabilities identity presented to the parent. This is NOT a real second WFD store.
      await browser.evaluate(`(()=>{const original=window.fetch.bind(window);window.__historyOriginalFetch=original;window.__historyReadWaiting=false;window.fetch=async(...args)=>{const url=String(args[0]);const response=await original(...args);if(url.endsWith('/r1/products/read')){window.__historyReadWaiting=true;await new Promise(resolve=>{window.__historyReleaseRead=resolve;});window.__historyReadReleased=true;}if(url.endsWith('/r1/capabilities')){const body=await response.json();body.connection={...body.connection,connectionId:body.connection.connectionId+'-synthetic-drift'};return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});}return response;};})()`);
      await browser.evaluate(`[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.textContent.trim()==='读取持久数据'&&!e.disabled).click()`);
      await browser.until('window.__historyReadWaiting===true', 'Actual read response did not reach the injection hold');
      await browser.click('刷新状态');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      await browser.evaluate('window.__historyReleaseRead()');
      await browser.until('window.__historyReadReleased===true', 'Delayed response was not released');
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false, 'Old identity read must not restore a result after parent remount');
      await browser.evaluate('window.fetch=window.__historyOriginalFetch');
      await browser.click('刷新状态');
      // Preference changes apply only to this disposable test host, not a user's settings.
      await browser.evaluate(`(async()=>{const session=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));if(!Number.isSafeInteger(session?.generation))throw Error('Missing verified local-data session');const headers={'x-local-data-generation':String(session.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const response=await fetch('/api/ui/preferences',{headers});if(!response.ok)throw Error('Isolated preference read failed: '+await response.text());const p=await response.json();const r=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en'})});if(!r.ok)throw Error('Isolated language change failed: '+await r.text());})()`);
      await navigate(browser, host);
      await browser.until(`!!document.querySelector('[aria-label="History perspective"]')`, 'English history label unavailable');
      await fill(browser, 'History perspective', 'system_held_at');
      for (const label of ['Cutoff (UTC seconds)', 'Actual holding instance', 'Required usable stage']) {
        assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label='+${q(JSON.stringify(label))}+']')`), true);
      }
      await browser.evaluate(`document.querySelector(${q(root)}).scrollIntoView({block:'start'})`);
      writeFileSync(join(visualRoot, 'history-en.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      assert.equal(browser.blockedRequests.length, 0);
    } finally { await browser?.close(); await host.close(); }
  });
