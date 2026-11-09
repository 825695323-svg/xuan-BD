import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { R1ProductDiscovery, R1SnapshotStatus } from '../../contracts/r1-contracts.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import type { R1AutoView } from '../../modules/collection/r1-auto.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';

const python = process.env.WFD_PYTHON, browserPath = process.env.XUAN_TEST_BROWSER;
const browserDigest = process.env.XUAN_TEST_BROWSER_SHA256, webRoot = process.env.XUAN_TEST_WEB_ROOT;
const auto = 'section[aria-label="文件自动交接"]';
const reader = 'section[aria-label="WFD 持久数据查询"]';
type Browser = Awaited<ReturnType<typeof openIsolatedBrowser>>;
type SourceRow = Record<string, string>;
const literal = JSON.stringify;
function save(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

async function fill(browser: Browser, scope: string, label: string, value: string) {
  await browser.evaluate(`(()=>{const root=document.querySelector(${literal(scope)});
    const label=[...root.querySelectorAll('label')].find(e=>e.firstChild?.textContent===${literal(label)});
    if(!label)throw new Error('Missing scoped label: '+${literal(label)});
    const e=label.querySelector('input,select,textarea');if(!e||e.disabled)throw new Error('Input unavailable');
    const type=e.tagName==='SELECT'?HTMLSelectElement:e.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;
    Object.getOwnPropertyDescriptor(type.prototype,'value').set.call(e,${literal(value)});
    e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function click(browser: Browser, scope: string, text: string) {
  const button = `[...document.querySelector(${literal(scope)}).querySelectorAll('button')].find(e=>e.textContent.trim()===${literal(text)}&&!e.disabled)`;
  await browser.until(`!!(${button})`, 'Scoped button unavailable: ' + text);
  await browser.evaluate(`(${button}).click()`);
}
async function screenshot(browser: Browser, path: string, scope = auto) {
  await browser.evaluate(`document.querySelector(${literal(scope)}).scrollIntoView({block:'start',behavior:'instant'})`);
  const result = await browser.page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path, Buffer.from(result.data, 'base64'), { flag: 'wx' });
}
async function navigate(browser: Browser, host: FullChainHost) {
  await browser.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await browser.page('Page.navigate', { url: host.base.replace('/api/bd', '/') });
  await browser.until(`(()=>{if(document.querySelector(${literal(auto)})&&document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;document.querySelector('button[aria-label="数据库"]')?.click();return false;})()`,
    'Real application did not expose automatic handoff through its local-data lifecycle');
}

function csv(semanticCode: string, subjectId: string, rows: SourceRow[], missingUnit = false, extra = false): Buffer {
  const dictionary: SourceRow = { 'bd.semantic_code': semanticCode, 'bd.subject_kind': 'physical_object',
    'bd.subject_id': subjectId, 'bd.period_type': 'natural', 'bd.frequency': 'day', 'bd.precision': 'day',
    'bd.timezone': 'UTC', 'bd.type.reading': 'decimal', 'bd.measurement.reading': 'stock',
    ...missingUnit ? {} : { 'bd.unit.reading': 'count' },
    ...extra ? { 'bd.type.extra': 'decimal', 'bd.unit.extra': 'count', 'bd.measurement.extra': 'stock' } : {} };
  const all = rows.map(row => ({ ...row, ...dictionary })), columns = Object.keys(all[0]!);
  const cell = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  return Buffer.from([columns.map(cell).join(','), ...all.map(row => columns.map(column => cell(row[column]!)).join(','))].join('\n') + '\n');
}
function row(key: string, reading: string, valueState = 'valid_value'): SourceRow {
  return { business_key: key, start_utc: '2026-01-02T00:00:00Z', end_utc: '2026-01-03T00:00:00Z', reading, value_state: valueState };
}

async function uploadAndStart(browser: Browser, host: FullChainHost, name: string, bytes: Buffer, dataset: string) {
  const path = join(host.fixture.root, name + '.csv'); writeFileSync(path, bytes, { flag: 'wx' });
  await fill(browser, auto, '上传接收类别', 'data');
  const dom = await browser.page('DOM.getDocument');
  const input = await browser.page('DOM.querySelector', { nodeId: dom.root.nodeId, selector: auto + ' input[type=file]' });
  assert.ok(input.nodeId, 'Automatic panel must expose its real upload control');
  await browser.page('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path] });
  const uploadedOption = `[...document.querySelector(${literal(auto)}).querySelectorAll('select option')].find(e=>e.textContent.startsWith(${literal(name + '.csv · ')}))`;
  await browser.until(`!!(${uploadedOption})`, 'Uploaded original did not appear in the stored-material selection');
  await fill(browser, auto, '已保管原件', await browser.evaluate<string>(`(${uploadedOption}).value`));
  await browser.until(`document.querySelector(${literal(auto)})?.getAttribute('aria-busy')==='false' && document.querySelector(${literal(auto)}+' .r1-material')?.textContent.includes(${literal(name + '.csv')})`,
    'Automatic panel did not show the actual stored original');
  const materialId = await browser.evaluate<string>(`[...document.querySelector(${literal(auto)}).querySelectorAll('label')].find(e=>e.firstChild?.textContent==='已保管原件').querySelector('select').value`);
  assert.ok(materialId);
  assert.deepEqual(host.services.materials!.readOriginal(materialId).bytes, bytes);
  for (const [label, value] of Object.entries({ '目标数据集编号': dataset, 来源身份: 'isolated-browser-original',
    提供者: 'synthetic-nonfinancial-fixture', '原始地址或 URI（资源标识）': 'test:' + name,
    '请求时间（UTC，协调世界时）': '2026-01-04T00:00:00Z', '取得时间（UTC，协调世界时）': '2026-01-04T00:01:00Z',
    本次获准用途: 'isolated synthetic observation test', 本次正式交接授权: 'authorized',
    本次授权依据: 'The operator generated this isolated synthetic sample and authorizes its test publication.' })) await fill(browser, auto, label, value);
  const consent = `${auto} .r1-confirm input[type=checkbox]`;
  assert.equal(await browser.evaluate(`document.querySelector(${literal(consent)}).checked`), false, 'Automatic publication consent must not be preselected');
  const point = await browser.evaluate<{ x: number; y: number }>(`(()=>{const e=document.querySelector(${literal(consent)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await browser.page('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await browser.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await browser.until(`document.querySelector(${literal(consent)})?.checked===true`, 'Explicit automatic-publication consent was not accepted');
  await click(browser, auto, '开始自动交接');
  const idExpression = `[...document.querySelector(${literal(auto)}).querySelectorAll('p')].find(e=>e.querySelector('strong')?.textContent==='自动交接编号')?.querySelector('code')?.textContent`;
  await browser.until(`!!(${idExpression})`, 'Automatic request identity was not rendered');
  return { materialId, requestId: await browser.evaluate<string>(idExpression), bytesSha256: wfdSha256(bytes) };
}
async function waitAuto(browser: Browser, host: FullChainHost, id: string, state: 'associated' | 'awaiting_answers'): Promise<R1AutoView> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const view = await host.call('/r1/auto/' + id) as R1AutoView;
    if (view.state === state) {
      const text = state === 'associated' ? '真实回执、固定读回及回链完成' : '等待逐项补答';
      await browser.until(`document.querySelector(${literal(auto)})?.textContent.includes(${literal(text)})`, 'Page did not display the actual automatic state');
      return view;
    }
    assert.ok(!['blocked', 'stopped'].includes(view.state), JSON.stringify({ state: view.state, error: view.error, localReturn: view.localReturn, wfdRejection: view.wfdRejection, questions: view.questions }));
    await delay(200);
  }
  throw new Error('Automatic workflow did not settle under its original identity: ' + id);
}

async function readFromPage(browser: Browser, host: FullChainHost, snapshotId: string, subjectId: string, expectedFields: string[], firstPageScreenshot?: string) {
  await fill(browser, reader, '固定快照编号', snapshotId);
  await click(browser, reader, '发现快照中的产品');
  await browser.until(`document.querySelector(${literal(reader)})?.getAttribute('aria-busy')==='false' && !!document.querySelector(${literal(reader)}+' select')`, 'Fixed snapshot discovery did not finish');
  const discovery = await host.call('/r1/products/discover', { snapshotId }) as R1ProductDiscovery;
  const selection = discovery.selections.find(item => item.subject.id === subjectId && expectedFields.every(field => item.fields.includes(field)));
  assert.ok(selection, JSON.stringify(discovery.selections));
  await fill(browser, reader, '快照中的产品', selection.productId);
  for (const field of selection.fields) {
    await browser.evaluate(`(()=>{const group=[...document.querySelector(${literal(reader)}).querySelectorAll('fieldset')].find(e=>e.querySelector('legend')?.textContent==='选择读取字段');
      const label=[...group.querySelectorAll('label')].find(e=>e.textContent.trim()===${literal(field)});const checkbox=label?.querySelector('input[type=checkbox]');
      if(!checkbox||checkbox.disabled)throw new Error('Discovered field is not selectable: '+${literal(field)});
      if(checkbox.checked!==${expectedFields.includes(field)})checkbox.click();})()`);
  }
  const projection = selection.fields.filter(field => expectedFields.includes(field));
  assert.deepEqual(await browser.evaluate<string[]>(`(()=>{const group=[...document.querySelector(${literal(reader)}).querySelectorAll('fieldset')].find(e=>e.querySelector('legend')?.textContent==='选择读取字段');return [...group.querySelectorAll('label')].filter(e=>e.querySelector('input').checked).map(e=>e.textContent.trim()).sort();})()`), projection);
  await click(browser, reader, '读取持久数据');
  await browser.until(`document.querySelector(${literal(reader)})?.getAttribute('aria-busy')==='false' && !!document.querySelector(${literal(reader)}+' [aria-label="WFD 实际读取结果"] table')`, 'Independent persisted-data read did not return real rows', 60_000);
  const pages: Record<string, any>[] = [];
  for (;;) {
    const page = await browser.evaluate<Record<string, any>>(`(()=>{const result=document.querySelector(${literal(reader)}+' [aria-label="WFD 实际读取结果"]');return JSON.parse(result.querySelector('details:last-child pre').textContent);})()`);
    assert.equal(page.snapshot_id, snapshotId); assert.equal(page.product_id, selection.productId);
    assert.equal(page.history_mode, 'snapshot_contents');
    assert.deepEqual(page.fields, projection);
    const rendered = await browser.evaluate<string[]>(`[...document.querySelector(${literal(reader)}+' table').querySelectorAll('tbody tr')].map(e=>e.innerText)`);
    assert.equal(rendered.length, page.rows.length);
    for (const row of page.rows) for (const field of expectedFields) {
      const cell = row.values[field];
      assert.ok(rendered.some(text => text.includes(String(cell.value)) && text.includes(cell.value_state)), 'Actual field value/state missing from visible table');
    }
    if (!pages.length && firstPageScreenshot) await screenshot(browser, firstPageScreenshot, reader);
    pages.push(page);
    if (!page.page.has_more) break;
    const pageIndex = pages.length + 1;
    await click(browser, reader, '下一页');
    await browser.until(`document.querySelector(${literal(reader)})?.getAttribute('aria-busy')==='false' && document.querySelector(${literal(reader)}+' [aria-label="WFD 实际读取结果"]')?.textContent.includes(${literal('第 ')}+${pageIndex}+' 页')`, 'Independent query did not advance the original cursor', 60_000);
  }
  return { discovery, selection, pages, rows: pages.flatMap(page => page.rows) as Record<string, any>[] };
}

test('real browser automatically adds an unknown observation family, asks only a missing unit, evolves fields and reopens independent fixed WFD reads',
  { skip: !(python && browserPath && browserDigest && webRoot && process.env.XUAN_FULL_CHAIN_ROOT)
    ? 'Requires explicit Python, browser and digest, isolated web build and dedicated full-chain root.' : false, timeout: 300_000 }, async () => {
    assert.equal(wfdSha256(readFileSync(browserPath!)), browserDigest);
    const fixture = createFullChainFixture({ name: 'automatic-browser', machine: true });
    const suffix = randomUUID().replaceAll('-', ''), semanticCode = 'test.observation.' + suffix;
    const dataset = 'browser_observation_' + suffix, subject = 'synthetic_device';
    const initialRows = Array.from({ length: 103 }, (_, index) => row('original-' + String(index).padStart(3, '0'),
      index === 0 ? '12.3456789' : index === 1 ? '0' : index === 2 ? '' : `${index}.125`,
      index === 1 ? 'reported_zero' : index === 2 ? 'unknown' : 'valid_value'));
    const firstBytes = csv(semanticCode, subject, initialRows);
    let host: FullChainHost | undefined = await openFullChainHost(fixture, webRoot!);
    let browser: Browser | undefined;
    const evidence: Record<string, unknown> = { syntheticInput: true, actualBrowser: true, actualPython: true,
      semanticCode, dataset, productionAccepted: false, applicationRuntimeAdoption: false };
    try {
      browser = await openIsolatedBrowser(browserPath!, fixture.root);
      await navigate(browser, host);
      await click(browser, reader, '取得当前固定快照');
      await browser.until(`document.querySelector(${literal(reader)})?.textContent.includes('合法初始化空库')`, 'Fresh WFD was not authoritatively confirmed empty');
      const first = await uploadAndStart(browser, host, 'new-observation-family', firstBytes, dataset);
      const firstView = await waitAuto(browser, host, first.requestId, 'associated');
      assert.equal(firstView.definitionReview?.code, 'FAMILY_DEFINITION_REQUIRED');
      assert.equal(firstView.definitionReview?.disposition, 'return_to_bd');
      assert.ok(firstView.definitionReview?.machineRequestId);
      assert.equal(firstView.definitionAction, 'create_from_evidence');
      assert.equal(firstView.currentRequest?.rowCount, initialRows.length);
      assert.equal(firstView.currentRequest?.state, 'associated');
      assert.deepEqual(firstView.questions, []);
      assert.equal(firstView.materialId, first.materialId);
      const firstSnapshot = (await host.call('/r1/products/snapshot', {}) as R1SnapshotStatus).snapshotId!;
      assert.ok(firstSnapshot);
      await screenshot(browser, join(fixture.root, '01-new-family-associated.png'));
      evidence.first = { ...first, snapshotId: firstSnapshot, view: firstView };

      await click(browser, auto, '另选原件开始新交接');
      const gapBytes = csv(semanticCode + '.unit_gap', 'unit_gap_device', [row('unit-gap-row', '5.75')], true);
      const gap = await uploadAndStart(browser, host, 'missing-reading-unit', gapBytes, dataset);
      const waiting = await waitAuto(browser, host, gap.requestId, 'awaiting_answers');
      assert.deepEqual(waiting.questions.map(question => question.key), ['unit.reading']);
      assert.deepEqual(waiting.planIds, []); assert.deepEqual(waiting.requestIds, []);
      await screenshot(browser, join(fixture.root, '02-only-unit-question.png'));
      await fill(browser, auto, waiting.questions[0]!.label, 'count');
      await click(browser, auto, '保存补答并继续');
      const answered = await waitAuto(browser, host, gap.requestId, 'associated');
      assert.equal(answered.materialId, waiting.materialId);
      assert.equal(answered.currentRequest?.rowCount, 1);
      assert.ok(answered.evidence.some(fact => fact.key === 'unit.reading' && fact.origin === 'operator' && fact.value === 'count'));
      assert.deepEqual(host.services.materials!.readOriginal(gap.materialId).bytes, gapBytes);
      evidence.unitGap = { ...gap, waiting, answered };

      await click(browser, auto, '另选原件开始新交接');
      const extraBytes = csv(semanticCode, subject, [{ ...row('expanded-row', '99.875'), extra: '7.5' }], false, true);
      const expanded = await uploadAndStart(browser, host, 'added-observation-field', extraBytes, dataset);
      const expandedView = await waitAuto(browser, host, expanded.requestId, 'associated');
      assert.equal(expandedView.definitionReview?.code, 'FIELD_DEFINITION_REQUIRED');
      assert.equal(expandedView.definitionReview?.disposition, 'return_to_bd');
      assert.deepEqual(expandedView.definitionReview?.missingFields, ['extra']);
      assert.equal(expandedView.definitionAction, 'evolve_additive_definition');
      assert.equal(expandedView.currentRequest?.state, 'associated');
      assert.deepEqual(expandedView.questions, []);
      const currentSnapshot = (await host.call('/r1/products/snapshot', {}) as R1SnapshotStatus).snapshotId!;
      assert.ok(currentSnapshot && currentSnapshot !== firstSnapshot);
      await screenshot(browser, join(fixture.root, '03-added-field-associated.png'));
      evidence.expanded = { ...expanded, snapshotId: currentSnapshot, view: expandedView };
      assert.equal(browser.requests.filter(request => new URL(request.url).pathname === '/api/bd/r1/auto/start').length, 3);
      assert.equal(browser.requests.filter(request => new URL(request.url).pathname.endsWith('/answers')).length, 1);
      assert.ok(!browser.requests.some(request => new URL(request.url).pathname.endsWith('/advance')), 'The UI must not manually drive automatic progression');
      assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedRequests, []);
      evidence.initialBrowserRequests = browser.requests;
      await browser.close(); browser = undefined;
      await host.close(); host = undefined;

      host = await openFullChainHost(fixture, webRoot!);
      const reopenedBrowser = join(fixture.root, 'reopened-browser'); mkdirSync(reopenedBrowser);
      browser = await openIsolatedBrowser(browserPath!, reopenedBrowser);
      await navigate(browser, host);
      assert.equal(await browser.evaluate(`!!document.querySelector(${literal(reader)}+' [aria-label="WFD 实际读取结果"]')`), false);
      await click(browser, reader, '取得当前固定快照');
      await browser.until(`document.querySelector(${literal(reader)})?.getAttribute('aria-busy')==='false' && [...document.querySelector(${literal(reader)}).querySelectorAll('label')].find(e=>e.firstChild?.textContent==='固定快照编号')?.querySelector('input').value===${literal(currentSnapshot)}`, 'Reopened host did not retrieve the current persisted snapshot');
      const historical = await readFromPage(browser, host, firstSnapshot, subject, ['reading'], join(fixture.root, '04-reopened-historical-value-states.png'));
      assert.deepEqual(historical.pages.map(page => page.rows.length), [100, 3]);
      assert.equal(historical.rows.length, 103);
      assert.deepEqual(historical.selection.fields, ['reading']);
      for (const expected of initialRows) {
        const actual = historical.rows.find(item => item.record_ref.logical_key === expected.business_key || item.record_ref.record_id === expected.business_key);
        assert.ok(actual, 'Original business row missing from the fixed historical snapshot: ' + expected.business_key);
        assert.equal(actual.values.reading.value, expected.value_state === 'unknown' ? null : expected.reading);
        assert.equal(actual.values.reading.value_state, expected.value_state);
      }
      await screenshot(browser, join(fixture.root, '04-reopened-historical-page-two.png'), reader);
      const current = await readFromPage(browser, host, currentSnapshot, subject, ['reading'], join(fixture.root, '05-current-reading-value-states.png'));
      assert.deepEqual(current.pages.map(page => page.rows.length), [100, 4]);
      assert.equal(current.rows.length, initialRows.length + 1);
      for (const expected of initialRows) {
        const actual = current.rows.find(item => item.record_ref.logical_key === expected.business_key || item.record_ref.record_id === expected.business_key);
        assert.ok(actual, 'Old row missing when projecting a shared field in the latest snapshot: ' + expected.business_key);
        assert.equal(actual.values.reading.value, expected.value_state === 'unknown' ? null : expected.reading);
        assert.equal(actual.values.reading.value_state, expected.value_state);
      }
      const added = current.rows.find(item => item.record_ref.logical_key === 'expanded-row' || item.record_ref.record_id === 'expanded-row');
      assert.ok(added); assert.equal(added.values.reading.value, '99.875');
      await screenshot(browser, join(fixture.root, '05-current-reading-page-two.png'), reader);
      const cursorMismatch = await host.call('/r1/products/read', { snapshotId: currentSnapshot,
        productId: current.selection.productId, fields: ['extra'], cursor: current.pages[0]!.page.next_cursor }, 409);
      assert.equal(cursorMismatch.code, 'CURSOR_QUERY_MISMATCH');
      const extraProjection = await readFromPage(browser, host, currentSnapshot, subject, ['extra'], join(fixture.root, '05-current-extra-historical-gaps.png'));
      assert.equal(extraProjection.rows.length, 1);
      assert.equal(extraProjection.rows[0]!.values.extra.value, '7.5');
      const missingFieldDiagnostics = extraProjection.pages.flatMap(page => page.diagnostics)
        .filter(item => item.code === 'FIELD_NOT_DEFINED_IN_ROW_CONTRACT');
      assert.equal(missingFieldDiagnostics.length, initialRows.length, 'Old row contracts must report the missing new field, never invent values');
      const historyAgain = await readFromPage(browser, host, firstSnapshot, subject, ['reading']);
      assert.deepEqual(historyAgain.rows, historical.rows, 'Adding a field must preserve the original fixed snapshot');
      evidence.reads = { historical, current, extraProjection, cursorMismatch, historicalSnapshotPreserved: true };
      await fill(browser, reader, '固定快照编号', 's_absent_' + suffix);
      await click(browser, reader, '发现快照中的产品');
      await browser.until(`document.querySelector(${literal(reader)})?.getAttribute('aria-busy')==='false' && !!document.querySelector(${literal(reader)}+' .error-note')`, 'Unknown fixed snapshot was not reported as an error');
      assert.equal(await browser.evaluate(`!!document.querySelector(${literal(reader)}+' [aria-label="WFD 实际读取结果"]')`), false);
      evidence.badSnapshotError = await browser.evaluate(`document.querySelector(${literal(reader)}+' .error-note').innerText`);
      await screenshot(browser, join(fixture.root, '06-bad-snapshot-is-error.png'), reader);
      assert.deepEqual(browser.exceptions, []); assert.deepEqual(browser.blockedRequests, []);
      assert.ok(browser.requests.some(request => new URL(request.url).pathname === '/api/bd/r1/products/read'));
      assert.ok(!browser.requests.some(request => /\/r1\/(?:prepare|auto\/start|requests\/[^/]+\/(?:submit|recover))$/u.test(new URL(request.url).pathname)), 'Independent reads after reopening must not submit or recover handoffs');
      evidence.reopenedBrowserRequests = browser.requests;
      evidence.pageExceptions = browser.exceptions; evidence.applicationExternalRequests = browser.blockedRequests;
      save(join(fixture.root, 'automatic-browser-result.json'), evidence);
      console.log('R1_AUTO_BROWSER_EVIDENCE_ROOT=' + fixture.root);
    } catch (error) {
      if (browser) {
        await screenshot(browser, join(fixture.root, 'failure.png')).catch(() => {});
        save(join(fixture.root, 'automatic-browser-failure.json'), { ...evidence, error: String(error),
          workflowRecords: host ? await host.call('/r1/auto').catch(String) : null,
          pageText: await browser.evaluate('document.body.innerText').catch(String), exceptions: browser.exceptions,
          blockedRequests: browser.blockedRequests, requests: browser.requests });
      }
      console.log('R1_AUTO_BROWSER_FAILURE_ROOT=' + fixture.root);
      throw error;
    } finally { await browser?.close(); await host?.close(); }
  });
