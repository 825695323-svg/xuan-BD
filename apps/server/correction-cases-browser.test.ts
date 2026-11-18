import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1BatchStartInput, R1BatchView } from '../../modules/collection/r1-auto-batch.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';

const program = process.env.XUAN_TEST_BROWSER, digest = process.env.XUAN_TEST_BROWSER_SHA256;
const webRoot = process.env.XUAN_TEST_WEB_ROOT;
const enabled = !!(process.env.WFD_PYTHON && process.env.XUAN_FULL_CHAIN_ROOT);
type Browser = Awaited<ReturnType<typeof openIsolatedBrowser>>;
const q = JSON.stringify, panel = '.correction-cases-panel';
async function wait<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 2400; i++) { const value = await read(); if (done(value)) return value; await delay(50); }
  assert.fail('Actual correction fixture did not settle: ' + JSON.stringify(await read()));
}
// Synthetic CSV, real BD upload/processing/R1 publication and real correction registration.
// No seeded associations, tasks, or correction rows; no approval granted by this test.
async function createCases(host: FullChainHost) {
  const bytes = Buffer.from('交易日期,股票代码,股票名称,收盘价（元）\n20260101,000001,10,1\n20260102,000001,20,2\n');
  const input: R1BatchStartInput = { batchId: 'correction-ui-original', datasetId: 'series', datePolicy: 'a_share_calendar_day_asia_shanghai',
    source: { source_id: 'correction-ui-fixture', provider: 'explicit synthetic fixture', requested_url: 'file:///synthetic-selected-observations',
      requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-10T00:00:00Z', usage_scope: 'isolated read-only correction UI test',
      authorization: { status: 'authorized', basis: 'explicit isolated test input' } },
    files: [{ name: 'synthetic.csv', relativePath: 'synthetic.csv', byteLength: bytes.length, sha256: wfdSha256(bytes) }] };
  await host.call('/r1/batches/start', input, 202);
  const uploaded = await fetch(host.base + '/r1/batches/correction-ui-original/items/item-1/upload', { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web', 'x-local-data-generation': '1' }, body: new Uint8Array(bytes) });
  assert.equal(uploaded.status, 202, await uploaded.text());
  const batch = await wait(() => host.call('/r1/batches/correction-ui-original') as Promise<R1BatchView>, value => {
    assert.equal(value.error, null, JSON.stringify(value)); assert.ok(value.items.every(item => item.state !== 'blocked'), JSON.stringify(value));
    return value.state === 'completed';
  });
  const item = batch.items[0]!, planId = String(item.auto!.planIds![0]), outputId = String(item.auto!.currentRequest!.outputId);
  const association = (item.auto!.currentRequest!.local.associations as WfdRecord[])[0]!;
  const original = JSON.parse(String(host.database.connection.prepare('SELECT plan_json FROM processing_plans WHERE plan_id=?').get(planId)!.plan_json));
  const originalOutput = original.outputs.find((output: WfdRecord) => output.outputId === outputId);
  const target = structuredClone(originalOutput.target), materialId = String(item.materialId);
  const mapping = target.declaration.mapping.fields as WfdRecord[];
  const decimal = (target.declaration.target.definition.field_definitions as WfdRecord[]).find(field => field.data_type === 'decimal')!;
  mapping.find(field => field.fieldCode === decimal.field_code)!.value = mapping.find(field => String(field.value).includes('名称'))!.value;
  const quote = '交易日期,股票代码,股票名称,收盘价（元）';
  const known = { status: 'known', value: '明确合成表格，本次只核结构', evidence: [{ source: 'material', materialId, quote, start: 0, end: quote.length }] };
  const unknown = { status: 'unknown', gap: '不代表供应商事实或业务含义已核实。' };
  const planned = await host.call('/processing/plans', { requestId: 'correction-ui-repair-plan', input: {
    routing: { materials: [{ materialId, intendedAction: 'inspect', dimensions: { role: known, informationNature: unknown,
      businessObject: known, objectTime: unknown, purpose: unknown, structureGranularity: known } }] },
    outputs: [{ outputId: 'observations', materialIds: [materialId], intendedAction: 'inspect', stages: ['parse', 'clean', 'structure', 'annotate', 'check'],
      tables: [{ ...originalOutput.tables[0], materialId }], target }] } }, 202);
  const plannedTask = await host.settled(planned.jobId); assert.equal(plannedTask.status, 'succeeded', JSON.stringify(plannedTask.error));
  const repairPlan = host.services.processing!.getByTask(plannedTask.id)!.plan!;
  for (const step of repairPlan.steps) {
    if (step.state === 'succeeded') continue; // Reuse verified prior artifacts; never rerun completed steps.
    const run = await host.call(`/processing/plans/${repairPlan.planId}/steps/${step.stepId}/execute`, { requestId: 'correction-ui-' + step.stepId }, 202);
    const task = await host.settled(run.jobId); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  }
  const capabilities = await host.call('/corrections/capabilities');
  const register = (caseId: string) => host.call('/corrections/cases', { requestId: caseId + '-register', input: {
    caseId, kind: 'processing_repair', errorType: 'mapping_error', discoveredAt: '2026-11-08T08:00:00Z',
    evidence: 'PRIVATE_EVIDENCE_SENTINEL file:///private/not-for-display: Explicit synthetic wrong column mapping, no supplier claim.',
    binding: { planOutput: { planId, outputId } }, connectionSha256: capabilities.connectionSha256 } }, 201);
  await register('case-readonly-pending');
  const impact = await host.call('/corrections/cases/case-readonly-pending/impact', { requestId: 'ui-impact' });
  assert.equal(impact.state, 'impact_frozen'); assert.equal(impact.coverage, 'proven_subset_only'); assert.equal(impact.itemCount, 2);
  await host.call('/corrections/cases/case-readonly-pending/suspend', { requestId: 'ui-suspend' });
  const prepared = await host.call('/corrections/cases/case-readonly-pending/prepare', { requestId: 'ui-prepare', input: {
    planId: repairPlan.planId, outputId: 'observations', originalSha256: host.services.materials!.readOriginal(materialId).sha256,
    expectedParentSnapshotId: String(association.snapshot_id), reason: 'Explicit synthetic same-original column repair; no supplier validation.' } });
  const authorization = await host.call('/corrections/cases/case-readonly-pending/authorize', { requestId: 'ui-authorization',
    input: { frozenSha256: prepared.frozenSha256, confirmationDigest: prepared.documentSha256 } }, 202);
  await wait(async () => host.services.tasks.get(authorization.id), task => task.status === 'waiting_approval');
  await register('case-readonly-registered');
  return { authorizationTaskId: String(authorization.id), originalRequestId: String(item.auto!.currentRequest!.requestId), association };
}
async function facts(host: FullChainHost) {
  const db = host.database.connection;
  return { tasks: db.prepare('SELECT id,status,version FROM tasks ORDER BY id').all(),
    cases: db.prepare('SELECT * FROM correction_cases ORDER BY case_id').all(),
    attempts: db.prepare('SELECT request_id,state,document_sha256,receipt_json FROM r1_handoff_attempts ORDER BY request_id').all(),
    snapshot: (await host.services.r1Runtime!.connection.client.snapshotStatus()).result };
}

test('correction case HTTP fixture uses actual publication, frozen impact and unapproved TaskService identity',
  { skip: !enabled, timeout: 180_000 }, async () => {
    const fixture = createFullChainFixture({ name: 'correction-cases-http', machine: true,
      units: { date: { dimension: 'date' }, cny_per_share: { dimension: 'money_per_share' } } });
    const host = await openFullChainHost(fixture);
    try {
      assert.deepEqual((await host.call('/corrections/cases')).items, []);
      const seeded = await createCases(host), before = await facts(host);
      const list = await host.call('/corrections/cases'); assert.equal(list.items.length, 2);
      const view = await host.call('/corrections/cases/case-readonly-pending');
      assert.equal(view.state, 'authorization_pending'); assert.equal(view.authorizationTaskId, seeded.authorizationTaskId);
      assert.equal(view.coverage, 'proven_subset_only'); assert.equal(view.suspension.state, 'active');
      const task = await host.call('/jobs/' + seeded.authorizationTaskId); assert.equal(task.status, 'waiting_approval');
      assert.equal(task.jobId, seeded.authorizationTaskId);
      assert.deepEqual(await facts(host), before, 'GET must not approve, submit, suspend, recover or rewrite cases');
    } finally { await host.close(); }
  });

async function click(browser: Browser, label: string) {
  await browser.until(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${q(label)}&&!e.disabled);if(!e)return false;e.click();return true;})()`, 'Unavailable control ' + label);
}
async function navigate(browser: Browser, host: FullChainHost, english = false) {
  await browser.page('Page.navigate', { url: host.base.replace('/api/bd', '/') });
  const database = english ? 'Database' : '数据库';
  await browser.until(`!!document.querySelector('button[aria-label='+${q(JSON.stringify(database))}+']')`, 'Actual navigation unavailable');
  await browser.evaluate(`document.querySelector('button[aria-label='+${q(JSON.stringify(database))}+']').click()`);
  await click(browser, english ? 'Correction cases' : '更正事项');
  await browser.until(`!!document.querySelector(${q(panel)})`, 'Correction panel unavailable');
}
async function settled(browser: Browser) {
  await browser.until(`document.querySelector(${q(panel)})?.getAttribute('aria-busy')==='false'`, 'Read did not settle');
}
async function capture(browser: Browser, root: string, name: string, selector: string) {
  await browser.evaluate(`document.querySelector(${q(selector)}).scrollIntoView({block:'start',inline:'nearest'})`);
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const boxes = await browser.evaluate<Array<{ left: number; right: number; top: number; bottom: number; width: number; height: number }>>(`(()=>{const e=document.querySelector(${q(selector)});if(!e||!e.getClientRects().length)throw Error('Missing screenshot evidence');return [e,...e.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}})})()`);
  assert.ok(boxes[0]!.width > 0 && boxes[0]!.height > 0);
  assert.ok(Math.min(boxes[0]!.bottom, 1100) > Math.max(boxes[0]!.top, 0), 'Screenshot target intersects viewport');
  for (const box of boxes) assert.ok(box.width > 0 && box.left >= -2 && box.right <= 392, 'Correction control horizontal overflow: ' + JSON.stringify(box));
  writeFileSync(join(root, name + '.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}

test('actual correction maintenance UI reads cases and original tasks without corrective commands',
  { skip: !(enabled && program && digest && webRoot) ? 'Requires explicit verified browser, built Web root and real WFD.' : false, timeout: 240_000 }, async () => {
    assert.equal(wfdSha256(readFileSync(program!)), digest);
    const fixture = createFullChainFixture({ name: 'correction-cases-ui', machine: true,
      units: { date: { dimension: 'date' }, cny_per_share: { dimension: 'money_per_share' } } });
    const visual = process.env.XUAN_CORRECTION_VISUAL_ROOT ?? fixture.root;
    assert.ok(isAbsolute(visual)); mkdirSync(visual, { recursive: true });
    const host = await openFullChainHost(fixture, webRoot!); let browser: Browser | undefined;
    try {
      browser = await openIsolatedBrowser(program!, fixture.root);
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 390, height: 1100, deviceScaleFactor: 1, mobile: false });
      // Only deliberate transport/echo faults. Normal bodies come from the actual bound server.
      await browser.page('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const native=window.fetch.bind(window);window.__correctionMode='normal';window.__correctionCaps=0;
        window.fetch=async(...args)=>{const url=new URL(String(args[0]),location.href);
          if(!url.pathname.startsWith('/api/bd/corrections/'))return native(...args);
          if(window.__correctionMode==='fail'&&url.pathname.endsWith('/cases'))return new Response(JSON.stringify({error:'Explicit synthetic 503'}),{status:503,headers:{'Content-Type':'application/json'}});
          const response=await native(...args);
          if(window.__correctionMode==='delay'&&url.pathname.endsWith('/case-readonly-pending')){window.__correctionWaiting=true;await new Promise(resolve=>window.__correctionRelease=resolve);}
          if(window.__correctionMode==='drift'&&url.pathname.endsWith('/capabilities')&&++window.__correctionCaps>1){const body=await response.json();body.connectionSha256='sha256:'+'f'.repeat(64);return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});}
          return response;};})()` });
      await navigate(browser, host);
      assert.equal(browser.requests.filter(item => new URL(item.url).pathname.startsWith('/api/bd/corrections/')).length, 0, 'Opening the view does not automatically query cases');
      await click(browser, '读取更正事项'); await settled(browser);
      await browser.until(`document.querySelector(${q(panel)}).innerText.includes('当前已读列表中没有匹配事项')`, 'Real empty list unavailable');
      await capture(browser, visual, 'correction-empty-zh-light', panel);
      const seeded = await createCases(host), before = await facts(host);
      await click(browser, '读取更正事项'); await settled(browser);
      await click(browser, '查看事项 case-readonly-pending'); await settled(browser);
      await browser.until(`document.querySelector('[data-testid="correction-detail"]')?.textContent.includes('审批办理中')`, 'Actual pending approval not displayed');
      assert.equal(await browser.evaluate(`document.querySelector(${q(panel)}).textContent.includes('PRIVATE_EVIDENCE_SENTINEL')`), false, 'Raw evidence must not be rendered');
      await click(browser, '查看原任务 ' + seeded.authorizationTaskId); await settled(browser);
      await browser.until(`document.querySelector('[data-testid="correction-task"]')?.textContent.includes(${q(seeded.authorizationTaskId)})`, 'Actual original task reference not reachable');
      assert.ok(browser.requests.some(item => new URL(item.url).pathname === '/api/bd/jobs/' + seeded.authorizationTaskId && item.method === 'GET'));
      await capture(browser, visual, 'correction-task-zh-light', '[data-testid="correction-task"]');
      await capture(browser, visual, 'correction-detail-zh-light', '[data-testid="correction-detail"]');
      // Late response from an unmounted panel must not restore its old selected case.
      await browser.evaluate("window.__correctionMode='delay';window.__correctionWaiting=false");
      await click(browser, '查看事项 case-readonly-pending');
      await browser.until('window.__correctionWaiting===true', 'Real detail response not delayed');
      await click(browser, '工作台任务'); await click(browser, '更正事项');
      await browser.evaluate("window.__correctionMode='normal';window.__correctionRelease()"); await delay(250);
      assert.equal(await browser.evaluate("!!document.querySelector('[data-testid=correction-detail]')"), false);
      await click(browser, '读取更正事项'); await settled(browser);
      await click(browser, '查看事项 case-readonly-registered'); await settled(browser);
      assert.equal(await browser.evaluate("document.querySelector('[data-testid=correction-detail]').textContent.includes('case-readonly-pending')"), false);
      // Connection echo changes during the read: old details must be cleared, never treated as empty success.
      await browser.evaluate("window.__correctionMode='drift';window.__correctionCaps=0");
      await click(browser, '查看事项 case-readonly-pending'); await settled(browser);
      await browser.until(`!!document.querySelector(${q(panel)}+' [role=alert]')&&!document.querySelector('[data-testid=correction-detail]')`, 'Connection drift did not clear private result');
      await browser.evaluate("window.__correctionMode='fail'"); await click(browser, '读取更正事项'); await settled(browser);
      await browser.until(`document.querySelector(${q(panel)}).textContent.includes('读取失败或范围已变化')`, '503 must remain failure, not empty');
      await capture(browser, visual, 'correction-error-zh-light', panel);
      await browser.evaluate(`(async()=>{const s=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));const headers={'x-local-data-generation':String(s.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const p=await(await fetch('/api/ui/preferences',{headers})).json();const r=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en',theme:'dark'})});if(!r.ok)throw Error('Preference update failed');})()`);
      await navigate(browser, host, true); await click(browser, 'Read correction cases'); await settled(browser);
      await click(browser, 'View case case-readonly-pending'); await settled(browser);
      await browser.until("document.querySelector('[data-testid=correction-detail]')?.textContent.includes('Authorization pending')", 'English pending status unavailable');
      await capture(browser, visual, 'correction-detail-en-dark', '[data-testid="correction-detail"]');
      await click(browser, 'Read original task ' + seeded.authorizationTaskId); await settled(browser);
      await capture(browser, visual, 'correction-task-en-dark', '[data-testid="correction-task"]');
      assert.deepEqual(await facts(host), before, 'Read-only UI must leave actual task versions, cases and formal publication unchanged');
      // Isolated lifecycle storage fault, not a user deactivation operation or new permission grant.
      const lifecycle = new DatabaseSync(join(fixture.root, 'lifecycle.sqlite'));
      try { lifecycle.exec('UPDATE local_data_lifecycle SET generation=2'); } finally { lifecycle.close(); }
      await click(browser, 'Read correction cases');
      await browser.until("!document.querySelector('[data-testid=correction-detail]')&&!document.querySelector('[data-testid=correction-task]')&&!document.body.textContent.includes('case-readonly-pending')", 'Old private case content survived generation invalidation');
      const denied = await fetch(host.base + '/corrections/cases', { headers: { 'x-local-data-generation': '1' } });
      assert.equal(denied.status, 409); assert.equal((await denied.json()).code, 'STALE_LOCAL_DATA_GENERATION');
      assert.equal(browser.requests.filter(item => new URL(item.url).pathname.startsWith('/api/bd/corrections/') && item.method !== 'GET').length, 0, 'No correction registration, authorization, suspension, prepare or recover command');
      assert.equal(browser.requests.filter(item => new URL(item.url).pathname.startsWith('/api/bd/jobs/') && item.method !== 'GET').length, 0, 'Task inspection never dispatches/cancels work');
      assert.equal(browser.blockedRequests.length, 0); assert.equal(browser.exceptions.length, 0);
    } finally { await browser?.close(); await host.close(); }
  });
