import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { checkCandidateTables, parseTableSource, structureCandidateTable } from '../../modules/collection/candidate-pipeline.js';
import { resolveSourceReportedEvidence } from '../../modules/collection/r1-evidence.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import { checkR1TabularRows } from '../../modules/collection/r1-tabular.js';
import { sourceReportedCode } from '../../modules/collection/source-reported-table.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';

const program = process.env.XUAN_TEST_BROWSER, digest = process.env.XUAN_TEST_BROWSER_SHA256;
const webRoot = process.env.XUAN_TEST_WEB_ROOT;
const enabled = !!(program && digest && webRoot && process.env.WFD_PYTHON && process.env.XUAN_FULL_CHAIN_ROOT);
type Browser = Awaited<ReturnType<typeof openIsolatedBrowser>>;
const q = JSON.stringify, root = '.r1-read-panel';
const valueHeader = root + ' .r1-read-result thead th:nth-child(2)';
const knownFields = ['amount', 'errors', 'reading', 'samples', 'warnings'];
const second = (at: string): WfdRecord => ({ status: 'known', precision: 'second', earliest_utc: at,
  latest_exclusive_utc: new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' });
function document(id: string, unknownDefinition = false, parent: string | null = null) {
  const namespace = 'full.chain.test', subject = { kind: 'entity', namespace, id: 'synthetic_history_browser' };
  const fields = unknownDefinition ? ['amount'] : knownFields;
  const rows = Array.from({ length: 103 }, (_, index) => ({ business_key: 'row-' + String(index).padStart(3, '0'), subject,
    observation_time: { status: 'known', precision: 'day', earliest_utc: '2024-01-01T00:00:00Z',
      latest_exclusive_utc: '2025-01-01T00:00:00Z', source_timezone: 'UTC' },
    ...(index === 102 ? {} : { public_time: second('2025-01-02T00:00:00Z') }),
    values: Object.fromEntries(fields.map((field, position) => [field,
      { data_type: 'decimal', value_state: 'valid_value', value: String(position * 100 + index) }])) }));
  return buildStructuredIngestDocument({ requestId: id, datasetId: 'synthetic_history_browser', namespace, producerNamespace: namespace,
    submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ id, rows })), expectedParentSnapshotId: parent,
    ...(!unknownDefinition ? { definitionPublicTime: second('2024-01-01T00:00:00Z') } : {}),
    outputKey: 'history', subject, definition: { semantic_code: 'synthetic.browser.' + id, measurement_nature: 'flow', unit_code: 'per_field',
      definition_authority: namespace, time_role: 'observation', semantic_context: { version: 'wfd.semantic-context/1.0',
        content_nature: 'observed_fact', time: { period_type: 'natural', frequency: 'year', interval: 'half_open', timezone: 'UTC' } },
      field_definitions: fields.map(field => ({ field_code: field, data_type: 'decimal', unit_code: 'count', measurement_nature: 'flow', time_role: 'observation' })) },
    inputMode: 'partial_observation', coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows } });
}
const field = (label: string) => `[...document.querySelector(${q(root)}).querySelectorAll('input,select')].find(e=>
  e.checkVisibility()&&!e.closest('details:not([open])')&&
  (e.getAttribute('aria-label')===${q(label)}||e.closest('label')?.querySelector('.ui-page-field-label')?.innerText===${q(label)}))`;
async function fill(browser: Browser, label: string, value: string) {
  await browser.evaluate(`(()=>{const e=${field(label)};if(!e||e.disabled)throw Error('Unavailable '+${q(label)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${q(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
const button = (text: string) => `[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.innerText.trim()===${q(text)}&&!e.disabled&&e.checkVisibility()&&!e.closest('details:not([open])'))`;
async function click(browser: Browser, text: string, twice = false) {
  const expression = button(text);
  await browser.until(`!!(${expression})`, 'Button unavailable ' + text);
  await browser.evaluate(`(()=>{const e=${expression};e.click();${twice ? 'e.click();' : ''}})()`);
  await browser.until(`document.querySelector(${q(root)})?.getAttribute('aria-busy')==='false'`, 'Read did not settle');
}
async function disclosure(browser: Browser, label: string, open: boolean) {
  await browser.evaluate(`(()=>{
    const summary=[...document.querySelector(${q(root)}).querySelectorAll('details > summary')].find(e=>
      (e.firstElementChild?.innerText||e.innerText.trim())===${q(label)}&&e.checkVisibility()&&!e.parentElement.parentElement.closest('details:not([open])'));
    if(!summary)throw Error('Unavailable disclosure '+${q(label)});
    if(summary.parentElement.open!==${open})summary.click();
    if(summary.parentElement.open!==${open})throw Error('Disclosure did not change '+${q(label)});
  })()`);
}
async function navigate(browser: Browser, host: FullChainHost) {
  await browser.page('Page.navigate', { url: host.base.replace('/api/bd', '/') });
  await browser.until(`(()=>{if(document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;(document.querySelector('button[aria-label="数据库"]')||document.querySelector('button[aria-label="Database"]'))?.click();return false;})()`, 'Actual application reader unavailable');
}
async function openFixedReader(browser: Browser, label: string) {
  const before = browser.requests.length;
  await browser.click(label);
  await browser.until(`(()=>{
    const reader = document.querySelector(${q(root)}), panel = reader?.closest('.database-panel');
    if(!reader||!panel||!reader.checkVisibility())return false;
    const box = reader.getBoundingClientRect(), viewport = panel.getBoundingClientRect();
    return document.activeElement === reader
      && Math.min(box.bottom, viewport.bottom, innerHeight) > Math.max(box.top, viewport.top, 0)
      && Math.min(box.right, viewport.right, innerWidth) > Math.max(box.left, viewport.left, 0);
  })()`, 'Opening the fixed reader did not focus and reveal it');
  assert.equal(await browser.evaluate(`document.querySelectorAll(${q(root)}).length`), 1, 'The product reader must not share a sibling reconciliation key');
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('.r1-panel .structured-query-panel, .r1-panel section[aria-label="文件自动交接"], .r1-panel section[aria-label="Automatic file handoff"], .r1-panel .database-line-card')].some(e=>e.checkVisibility())`), false, 'Handoff and structured filtering must be hidden in the fixed reader');
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.deepEqual(browser.requests.slice(before).filter(({ url, method }) => {
    const { pathname } = new URL(url);
    return pathname.startsWith('/api/bd/r1/products/') || (pathname.startsWith('/api/') && method !== 'GET');
  }), [], 'Opening the fixed reader must not query products or write');
}
async function returnToEditor(browser: Browser) {
  await browser.click('原件与单输出编辑');
  await browser.until(`!document.querySelector(${q(root)})?.checkVisibility()&&!!document.querySelector('section[aria-label="文件自动交接"]')?.checkVisibility()`, 'The original and single-output editor was not restored');
}
async function select(browser: Browser, productId: string, english = false) {
  const before = browser.requests.length;
  await click(browser, english ? 'View current data' : '查看当前数据');
  assert.deepEqual(browser.requests.slice(before).map(({ url }) => new URL(url).pathname)
    .filter(path => path.startsWith('/api/bd/r1/products/')), ['/api/bd/r1/products/snapshot', '/api/bd/r1/products/discover']);
  await fill(browser, english ? 'Product' : '产品', productId);
}
async function capture(browser: Browser, directory: string, name: string, scope = root) {
  await browser.evaluate(`document.querySelector(${q(scope)}).scrollIntoView({block:'start',behavior:'instant'})`);
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  writeFileSync(join(directory, name + '.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}
async function assertDefaultReader(browser: Browser, identifiers: string[]) {
  const visible = await browser.evaluate<string>(`(()=>{
    const panel=document.querySelector(${q(root)});
    if(panel.querySelector('details[open]'))throw Error('Default reader details must start collapsed');
    const options=[...panel.querySelectorAll('select')].filter(e=>e.checkVisibility()&&!e.closest('details:not([open])'))
      .flatMap(e=>[...e.options].map(option=>option.label));
    return [panel.innerText,...options].join('\\n');
  })()`);
  assert.match(visible, /查看当前数据|View current data/u);
  for (const identity of identifiers) assert.ok(identity.length && !visible.includes(identity), 'Default reader exposes ' + identity);
  assert.doesNotMatch(visible, /snapshot_contents|valid_value|reported_zero|value_state|record_ref|next_cursor|data_only/u);
}
async function checkReadError(browser: Browser, code: string) {
  const selector = root + ' .error-note[role=alert]';
  const visible = await browser.evaluate<string>(`document.querySelector(${q(selector)}).innerText`);
  assert.ok(visible.trim() && !visible.includes(code), 'Default error must use readable text');
  await disclosure(browser, '查看错误详情', true);
  assert.ok((await browser.evaluate<string>(`document.querySelector(${q(selector + ' details[open]')}).innerText`)).includes(code));
  await disclosure(browser, '查看错误详情', false);
}
async function checkResultRegion(browser: Browser, name: string, narrow: boolean) {
  const selector = q(`${root} .r1-read-result [role="region"]`);
  const region = await browser.evaluate<{ name: string; tabIndex: number; left: number; right: number;
    panelLeft: number; panelRight: number; viewportWidth: number; scrollWidth: number; clientWidth: number }>(`(()=>{
    const region = document.querySelector(${selector});
    const box = region.getBoundingClientRect(), panel = region.closest(${q(root)}).getBoundingClientRect();
    const label = region.getAttribute('aria-labelledby')?.split(/\\s+/).map(id => document.getElementById(id)?.textContent).join(' ');
    return { name: label || region.getAttribute('aria-label'), tabIndex: region.tabIndex, left: box.left, right: box.right,
      panelLeft: panel.left, panelRight: panel.right, viewportWidth: innerWidth, scrollWidth: region.scrollWidth, clientWidth: region.clientWidth };
  })()`);
  assert.equal(region.name, name);
  assert.equal(region.tabIndex, 0);
  if (!narrow) return;
  assert.ok(region.clientWidth > 0 && region.left >= Math.max(0, region.panelLeft) - 2
    && region.right <= Math.min(region.viewportWidth, region.panelRight) + 2, JSON.stringify(region));
  await browser.evaluate(`(()=>{
    const region = document.querySelector(${selector});
    const previous = [...region.closest(${q(root)}).querySelectorAll('button,select,input,summary')].findLast(control =>
      !control.disabled && control.checkVisibility() && !control.closest('details:not([open])')
      && (control.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING));
    previous.focus();
  })()`);
  const press = async (key: string, code: number) => {
    const event = { key, code: key, windowsVirtualKeyCode: code };
    await browser.page('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
    await browser.page('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  };
  await press('Tab', 9);
  await browser.until(`document.activeElement === document.querySelector(${selector})`, 'Tab did not reach the read result region');
  if (region.scrollWidth > region.clientWidth) {
    await browser.evaluate(`document.querySelector(${selector}).scrollLeft = 0`);
    await press('ArrowRight', 39);
    await browser.until(`document.querySelector(${selector}).scrollLeft > 0`, 'ArrowRight did not scroll the read result region');
    const firstColumnScrolls = await browser.evaluate<boolean>(`(()=>{
      const region = document.querySelector(${selector});
      const firstCell = region.querySelector('tbody td');
      region.scrollLeft = 0;
      const left = firstCell.getBoundingClientRect().left;
      region.scrollLeft = region.scrollWidth;
      return Math.abs(left - firstCell.getBoundingClientRect().left - region.scrollLeft) <= 2;
    })()`);
    assert.ok(firstColumnScrolls, 'The first column must yield room for field values when scrolling on a phone');
  }
}
async function pageResult(browser: Browser): Promise<any> {
  await disclosure(browser, '读取详情', true);
  await disclosure(browser, '本页原始结果', true);
  const data = await browser.evaluate(`JSON.parse(document.querySelector(${q(root + ' .r1-read-details[open] details[open] > pre')}).innerText)`);
  await disclosure(browser, '本页原始结果', false);
  await disclosure(browser, '读取详情', false);
  return data;
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
      await navigate(browser, host); await openFixedReader(browser, '查询固定快照');
      const readerIdentities = [unknown.snapshotId, known.snapshotId, known.productId, unknown.productId, status.connection.connectionId, status.holdingInstance.instanceId];
      await assertDefaultReader(browser, readerIdentities);
      await capture(browser, visualRoot, 'fixed-reader-default-desktop');
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 390, height: 1100, deviceScaleFactor: 1, mobile: false });
      await capture(browser, visualRoot, 'fixed-reader-default-narrow');
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
      await select(browser, known.productId);
      await click(browser, '查看数据');
      await assertDefaultReader(browser, readerIdentities);
      const chineseHeader = await browser.evaluate<string>(`document.querySelector(${q(valueHeader)}).innerText`);
      assert.equal(chineseHeader.split('\n')[0], '数值');
      await capture(browser, visualRoot, 'fixed-result-default-desktop', root + ' .r1-read-result');
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 390, height: 1100, deviceScaleFactor: 1, mobile: false });
      await capture(browser, visualRoot, 'fixed-result-default-narrow', root + ' .r1-read-result');
      await checkResultRegion(browser, '数据表', true);
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
      const initialPage = await pageResult(browser);
      assert.equal(initialPage.page.total_rows, 103);
      assert.equal(initialPage.snapshot_id, unknown.snapshotId);
      assert.equal(initialPage.product_id, known.productId);
      assert.deepEqual(initialPage.fields, knownFields.slice(0, 4));
      assert.equal(initialPage.rows[0].values.warnings, undefined);
      await assertDefaultReader(browser, [...readerIdentities, initialPage.page.next_cursor, initialPage.rows[0].record_ref.revision_id]);
      // Change one browser response to exercise an unresolved unit on a text value.
      await browser.evaluate(`(()=>{
        const original=window.fetch;
        window.fetch=async(...args)=>{
          const response=await original.apply(window,args);
          if(!String(args[0]).endsWith('/r1/products/read')||!response.ok)return response;
          window.fetch=original;
          const body=await response.json();
          body.result.rows[0].values.amount={data_type:'text',value_state:'valid_value',value:'单位样本',
            unit:{unit_code:'cny',resolved:false}};
          return Response.json(body,{status:response.status});
        };
      })()`);
      await click(browser, '查看数据');
      const affectedCell = await browser.evaluate<string>(`document.querySelector(${q(root + ' .r1-read-result tbody tr td:nth-child(2)')}).innerText`);
      assert.match(affectedCell, /单位样本/u);
      assert.match(affectedCell, /单位未核实/u);
      assert.doesNotMatch(await browser.evaluate<string>(`document.querySelector(${q(root + ' .r1-read-result')}).innerText`), /人民币元/u);
      await click(browser, '查看数据');
      assert.equal(await browser.evaluate<string>(`document.querySelector(${q(valueHeader)}).innerText`), chineseHeader);
      assert.doesNotMatch(await browser.evaluate<string>(`document.querySelector(${q(root + ' .r1-read-result')}).innerText`), /单位样本|单位未核实/u);
      await disclosure(browser, '选择显示字段', true);
      await browser.evaluate(`(()=>{
        const fields=document.querySelector(${q(root + ' details[open] fieldset[aria-label="选择显示字段"]')});
        const label=[...fields.querySelectorAll('label')].find(e=>e.innerText.trim()==='warnings');
        const checkbox=label?.querySelector('input[type=checkbox]');
        if(!checkbox?.checkVisibility()||checkbox.disabled||checkbox.checked)throw Error('The fifth field must start unchecked and be selectable');
        checkbox.click();
      })()`);
      await disclosure(browser, '选择显示字段', false);
      await click(browser, '查看数据');
      const expandedPage = await pageResult(browser);
      assert.deepEqual(expandedPage.fields, knownFields);
      const firstRow = expandedPage.rows[0].values;
      assert.equal(firstRow.warnings.value, String(400 + Number(firstRow.amount.value)));
      const warningsColumn = q(root + ' .r1-read-result thead th:nth-child(6)');
      assert.match(await browser.evaluate<string>(`document.querySelector(${warningsColumn}).innerText`), /^warnings\b/u);
      await click(browser, '下一页'); assert.equal((await pageResult(browser)).rows.length, 3);
      await disclosure(browser, '历史视角', true);
      await fill(browser, '历史视角', 'market_known_at');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      assert.equal(await browser.evaluate(`(${field('截止时间（UTC，精确到秒）')}).value`), '');
      await fill(browser, '截止时间（UTC，精确到秒）', cutoff);
      const requests = browser.requests.filter(r => r.url.endsWith('/r1/products/read')).length;
      await click(browser, '查看数据', true);
      assert.equal(browser.requests.filter(r => r.url.endsWith('/r1/products/read')).length, requests + 1);
      let page = await pageResult(browser); assert.equal(page.history_mode, 'market_known_at'); assert.equal(page.page.total_rows, 102);
      await click(browser, '下一页'); assert.equal((await pageResult(browser)).rows.length, 2);
      await fill(browser, '截止时间（UTC，精确到秒）', '2025-01-01T00:00:00Z');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      await click(browser, '查看数据'); assert.equal((await pageResult(browser)).rows.length, 0);
      await fill(browser, '截止时间（UTC，精确到秒）', '2025-02-30T00:00:00Z');
      const beforeInvalid = browser.requests.filter(r => r.url.endsWith('/r1/products/read')).length;
      await click(browser, '查看数据');
      assert.equal(browser.requests.filter(r => r.url.endsWith('/r1/products/read')).length, beforeInvalid);
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      await fill(browser, '历史视角', 'system_held_at'); await fill(browser, '截止时间（UTC，精确到秒）', cutoff);
      assert.equal(await browser.evaluate(`(${field('持有阶段')}).value`), '');
      assert.ok(!(await browser.evaluate<string>(`document.querySelector(${q(root)}).innerText`)).includes(status.holdingInstance.instanceId));
      await disclosure(browser, '读取详情', true);
      assert.ok((await browser.evaluate<string>(`document.querySelector(${q(root + ' .r1-read-details[open]')}).innerText`)).includes(status.holdingInstance.instanceId));
      await disclosure(browser, '读取详情', false);
      for (const stage of ['acquired', 'custodied', 'published_readable']) {
        await fill(browser, '持有阶段', stage); await click(browser, '查看数据');
        if (stage !== 'published_readable') {
          assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
          await checkReadError(browser, 'INSTANCE_HOLDING_UNKNOWN');
        } else {
          page = await pageResult(browser);
          assert.equal(page.history_mode, 'system_held_at'); assert.equal(page.usable_stage, stage);
          assert.equal(page.held_scope, status.holdingInstance.instanceId); assert.equal(page.page.total_rows, 103);
        }
      }
      await fill(browser, '截止时间（UTC，精确到秒）', beforeHolding); await click(browser, '查看数据');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      await checkReadError(browser, 'INSTANCE_HOLDING_NOT_YET_AVAILABLE');
      await fill(browser, '截止时间（UTC，精确到秒）', cutoff); await click(browser, '查看数据');
      for (const theme of ['light', 'dark']) {
        await browser.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
        await browser.page('Emulation.setDeviceMetricsOverride', { width: theme === 'light' ? 1440 : 390, height: 1100, deviceScaleFactor: 1, mobile: false });
        await browser.evaluate(`document.querySelector(${q(root)}).scrollIntoView({block:'start'})`);
        type ControlGeometry = { label: string; x: number; right: number; width: number; parentLeft: number; parentRight: number; viewport: number };
        const geometry: ControlGeometry[] = await browser.evaluate<ControlGeometry[]>(`(()=>{
          const panel=document.querySelector(${q(root)}),parent=panel.getBoundingClientRect();
          return [...panel.querySelectorAll('input,select')].filter(e=>e.checkVisibility()&&!e.closest('details:not([open])')).map(e=>{
            const r=e.getBoundingClientRect();
            return {label:e.getAttribute('aria-label')??e.closest('label')?.querySelector('.ui-page-field-label')?.innerText,
              x:r.x,right:r.right,width:r.width,parentLeft:parent.left,parentRight:parent.right,viewport:innerWidth};
          });
        })()`);
        assert.ok(geometry.length >= 4);
        for (const control of geometry) {
          assert.ok(control.label && control.width > 0);
          assert.ok(control.x >= control.parentLeft - 2 && control.right <= control.parentRight + 2, JSON.stringify(control));
          assert.ok(control.x >= -2 && control.right <= control.viewport + 2, JSON.stringify(control));
        }
        writeFileSync(join(visualRoot, 'history-' + theme + '.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        await checkResultRegion(browser, '数据表', theme === 'dark');
        await browser.evaluate(`document.querySelector(${q(root + ' .r1-read-result')}).scrollIntoView({block:'start'})`);
        writeFileSync(join(visualRoot, 'result-' + theme + '.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      }
      await fill(browser, '产品', unknown.productId); await fill(browser, '历史视角', 'market_known_at');
      await fill(browser, '截止时间（UTC，精确到秒）', cutoff);
      await click(browser, '查看数据');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      await checkReadError(browser, 'R1_READ_HISTORY_METADATA_UNSUPPORTED');
      await browser.close(); browser = undefined; await host.close(); host = await openFullChainHost(fixture, webRoot!);
      // Keep the isolated reopen path below Chromium's Unix socket path limit.
      const reopened = join(fixture.root, 'r'); mkdirSync(reopened); browser = await openIsolatedBrowser(program!, reopened);
      await navigate(browser, host); await openFixedReader(browser, '查询固定快照'); await select(browser, known.productId); await click(browser, '查看数据');
      assert.equal((await pageResult(browser)).page.total_rows, 103);
      // Browser transport fault injection only: delay a real read response, then change the
      // capabilities identity presented to the parent. This is NOT a real second WFD store.
      await browser.evaluate(`(()=>{const original=window.fetch.bind(window);window.__historyOriginalFetch=original;window.__historyReadWaiting=false;window.fetch=async(...args)=>{const url=String(args[0]);const response=await original(...args);if(url.endsWith('/r1/products/read')){window.__historyReadWaiting=true;await new Promise(resolve=>{window.__historyReleaseRead=resolve;});window.__historyReadReleased=true;}if(url.endsWith('/r1/capabilities')){const body=await response.json();body.connection={...body.connection,connectionId:body.connection.connectionId+'-synthetic-drift'};return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});}return response;};})()`);
      await browser.evaluate(`(${button('查看数据')}).click()`);
      await browser.until('window.__historyReadWaiting===true', 'Actual read response did not reach the injection hold');
      await returnToEditor(browser);
      await browser.click('刷新状态');
      await openFixedReader(browser, '查询固定快照');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false);
      await browser.evaluate('window.__historyReleaseRead()');
      await browser.until('window.__historyReadReleased===true', 'Delayed response was not released');
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await browser.evaluate(`!!document.querySelector(${q(root + ' .r1-read-result')})`), false, 'Old identity read must not restore a result after parent remount');
      await browser.evaluate('window.fetch=window.__historyOriginalFetch');
      await returnToEditor(browser);
      await browser.click('刷新状态');
      // Preference changes apply only to this disposable test host, not a user's settings.
      await browser.evaluate(`(async()=>{const session=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));if(!Number.isSafeInteger(session?.generation))throw Error('Missing verified local-data session');const headers={'x-local-data-generation':String(session.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const response=await fetch('/api/ui/preferences',{headers});if(!response.ok)throw Error('Isolated preference read failed: '+await response.text());const p=await response.json();const r=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en'})});if(!r.ok)throw Error('Isolated language change failed: '+await r.text());})()`);
      await navigate(browser, host);
      await openFixedReader(browser, 'Query fixed snapshot');
      await assertDefaultReader(browser, readerIdentities);
      await disclosure(browser, 'Query by snapshot ID', true);
      const snapshotInputWidths: Array<{ viewport: number; inputWidth: number }> = [];
      for (const width of [820, 960]) {
        await browser.page('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
        const inputWidth: number = await browser.evaluate<number>(`(${field('Snapshot ID')}).getBoundingClientRect().width`);
        snapshotInputWidths.push({ viewport: width, inputWidth });
        assert.ok(inputWidth >= 160, `Fixed snapshot input squeezed to ${inputWidth}px at ${width}px`);
      }
      writeFileSync(join(visualRoot, 'snapshot-input-widths.json'), JSON.stringify(snapshotInputWidths));
      await disclosure(browser, 'Query by snapshot ID', false);
      await select(browser, known.productId, true);
      await disclosure(browser, 'Historical view', true);
      await fill(browser, 'Historical view', 'system_held_at');
      for (const label of ['Cutoff (UTC, to the second)', 'Holding stage']) {
        assert.equal(await browser.evaluate(`!!(${field(label)})`), true);
      }
      await browser.evaluate(`document.querySelector(${q(root)}).scrollIntoView({block:'start'})`);
      writeFileSync(join(visualRoot, 'history-en.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      await fill(browser, 'Historical view', 'snapshot_contents');
      await disclosure(browser, 'Historical view', false);
      await click(browser, 'View data');
      await checkResultRegion(browser, 'Data table', false);
      const amounts = await browser.evaluate<string[]>(`[...document.querySelectorAll(${q(`${root} .r1-read-result tbody tr td:nth-child(2)`)})].map(e=>e.innerText)`);
      const amountColumn = await browser.evaluate<string>(`document.querySelector(${q(valueHeader)}).innerText`);
      assert.equal(amountColumn.split('\n')[0], 'amount');
      assert.ok(amounts.some(amount => /\b0\b/u.test(amount) && /Count/u.test(amount + amountColumn)));
      assert.doesNotMatch([amountColumn, ...amounts].join('\n'), /valid_value|有效值|计数/u);
      await assertDefaultReader(browser, readerIdentities);
      assert.equal(browser.blockedRequests.length, 0);
    } finally { await browser?.close(); await host.close(); }
  });

// Synthetic CSV, real source-report declaration and isolated WFD publication/readback.
test('fixed reader displays the original Chinese report title, field and unit',
  { skip: !enabled ? 'Requires explicit isolated Python, browser SHA and built Web root.' : false, timeout: 60_000 }, async () => {
    assert.equal(wfdSha256(readFileSync(program!)), digest);
    const requestId = 'source-report-browser', namespace = 'full.chain.test', datasetId = 'synthetic_water_report';
    const title = '用水量月报', header = '合计用水量（吨）', unit = '吨';
    const unitCode = sourceReportedCode('srcunit_', unit), fieldCode = sourceReportedCode('src_', header);
    assert.ok(unitCode && fieldCode);
    const csv = Buffer.from(`日期,${header}\n2025-01-31,128.5\n2025-02-28,96.25\n`);
    const plan = { materialId: requestId, format: 'csv' as const };
    const source = { source_id: 'synthetic-water', provider: 'synthetic-fixture', requested_url: 'file:///用水量月报/report.csv',
      requested_at_utc: '2025-03-01T00:00:00Z', acquired_at_utc: '2025-03-01T00:00:00Z', usage_scope: 'synthetic isolated test' };
    const report = resolveSourceReportedEvidence({ source, namespace, datasetId, parentSnapshotId: null,
      answers: { source_date_timezone: 'UTC', source_key_columns: '["日期"]' } }, parseTableSource(csv, plan), 'csv');
    assert.deepEqual(report.questions, []);
    const proposal = report.proposal;
    assert.ok(proposal);
    const { target, mapping, sourceProjection, types } = proposal;
    const projected = parseTableSource(csv, { ...plan, sourceProjection });
    const { rows: values } = checkCandidateTables([structureCandidateTable(projected, types)]);
    const { rows } = checkR1TabularRows(values, { protocol: 'wfd.structured-ingest/1.0', mapping, target, source });
    const document = buildStructuredIngestDocument({ ...target, requestId, namespace, producerNamespace: namespace,
      submissionDigest: 'sha256:' + wfdSha256(csv), payload: { kind: 'tabular_rows', rows } });
    const fixture = createFullChainFixture({ name: 'source-report', machine: true,
      units: { date: { dimension: 'date' }, [unitCode]: { dimension: 'quantity' } } });
    const visualRoot = process.env.XUAN_HISTORY_VISUAL_ROOT ?? fixture.root;
    assert.ok(isAbsolute(visualRoot));
    mkdirSync(visualRoot, { recursive: true });
    const host = await openFullChainHost(fixture, webRoot!);
    let browser: Browser | undefined;
    try {
      const published = (await host.services.r1Runtime!.client.submit(document)).result;
      assert.equal(published.formal_publication_verified, true, JSON.stringify(published));
      const productId = String((published.output_results as WfdRecord[])[0]!.product_id);
      browser = await openIsolatedBrowser(program!, fixture.root);
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 1360, height: 960, deviceScaleFactor: 1, mobile: false });
      await navigate(browser, host); await openFixedReader(browser, '查询固定快照');
      await select(browser, productId); await click(browser, '查看数据');
      assert.equal(await browser.evaluate(`(${field('产品')}).selectedOptions[0].label`), title);
      const columns = await browser.evaluate<string[]>(`[...document.querySelectorAll(${q(root + ' thead th')})].map(cell=>cell.innerText)`);
      assert.ok(columns.includes(header), JSON.stringify(columns));
      const table = await browser.evaluate<string>(`document.querySelector(${q(root + ' table')}).innerText`);
      for (const original of ['日期', '2025-01-31', '2025-02-28', '128.5', '96.25']) assert.ok(table.includes(original), table);
      assert.doesNotMatch(table, /单位见读取详情/u);
      await assertDefaultReader(browser, [datasetId, productId, String(published.snapshot_id), fieldCode, unitCode]);
      await capture(browser, visualRoot, 'fixed-source-report');
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
      await capture(browser, visualRoot, 'fixed-source-report-narrow', root + ' .r1-read-result');
      const page = await pageResult(browser);
      assert.equal(page.snapshot_id, published.snapshot_id);
      assert.equal(page.product_id, productId);
      assert.equal(page.rows.length, 2);
      assert.equal(page.rows[0].values[fieldCode].unit.unit_code, unitCode);
      assert.equal(page.rows[0].values[fieldCode].unit.resolved, true);
      assert.equal(browser.blockedRequests.length, 0);
    } finally { await browser?.close(); await host.close(); }
  });
