import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Backend } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
import { TaskError, type TaskRuntime } from '../../platform/jobs/tasks.js';
import { createApp } from './app.js';
import { createApplicationServices } from './services.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';

const program = process.env.XUAN_TEST_BROWSER, digest = process.env.XUAN_TEST_BROWSER_SHA256;
const webRoot = process.env.XUAN_TEST_WEB_ROOT, parent = process.env.XUAN_FULL_CHAIN_ROOT;
const health: HealthResponse = { name: 'xuan BD', backend: 'demo', configured: false, model: null, provider: null, notice: 'No model or supplier credentials' };
const backend: Backend = { id: 'isolated-selection', createSession: async () => { throw new Error('This selection fixture never calls a model'); } };
type Browser = Awaited<ReturnType<typeof openIsolatedBrowser>>;
const q = JSON.stringify;
async function hostFixture(root: string) {
  const database = new CoreDatabase(join(root, 'personal.sqlite'));
  const core = new PersonalCore(backend, { database });
  const releases = new Map<string, () => void>();
  const runtime: TaskRuntime = { id: 'synthetic.taskcenter', execute: async context => {
    await context.emit({ type: 'progress', message: 'Synthetic isolated task entered its actual runtime', evidenceKey: 'synthetic-runtime-entered' });
    if (context.task.action === 'synthetic.fail') throw new TaskError('SYNTHETIC_FAILURE', 'Explicit synthetic failure, no supplier or model invocation');
    if (context.task.action === 'synthetic.hold') await new Promise<void>((done, reject) => {
      const abort = () => { releases.delete(context.task.id); reject(new Error('Synthetic runtime observed actual abort')); };
      context.signal.addEventListener('abort', abort, { once: true });
      releases.set(context.task.id, () => { context.signal.removeEventListener('abort', abort); releases.delete(context.task.id); done(); });
      if (context.signal.aborted) abort();
    });
    return { summary: 'Synthetic task result; no business operation occurred', data: { synthetic: true } };
  } };
  const lifecycle = new LocalDataLifecycle({ controlDatabasePath: join(root, 'lifecycle.sqlite'), dataIdFromTask: () => 'selection-data' });
  lifecycle.register('selection-data'); lifecycle.bindIdentity('selection-data', database.path);
  const workspaceDatabase = new CoreDatabase(join(root, 'workspace.sqlite'));
  const workspaceCore = new PersonalCore(backend, { database: workspaceDatabase });
  const workspaceServices = createApplicationServices(workspaceCore, workspaceDatabase, { role: 'service', health,
    projectRoot: root, codeRoot: resolve(import.meta.dirname, '../..'), privateRoot: join(root, 'workspace-private') });
  const services = createApplicationServices(core, database, { health, projectRoot: root, codeRoot: resolve(import.meta.dirname, '../..'),
    privateRoot: join(root, 'private'), workspaceServices, taskRuntimes: [runtime], localData: { lifecycle, dataId: 'selection-data', verify: async () => { throw new Error('No lifecycle changes in selection fixture'); } } });
  const server = createApp(core, health, services, { webRoot: webRoot! }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address === 'object');
  return { core, services, workspaceServices, releases, url: `http://127.0.0.1:${address.port}/`, async close() {
    server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    services.segments?.close(); services.files.closeTemporaryRetention(); await services.r1Batches?.dispose(); await services.r1Auto?.dispose();
    await services.tasks.dispose(); await core.dispose(); database.close();
    workspaceServices.segments?.close(); workspaceServices.files.closeTemporaryRetention();
    workspaceServices.options.processRuntime?.closeTemporaryRetention();
    await workspaceServices.r1Batches?.dispose(); await workspaceServices.r1Auto?.dispose();
    await workspaceServices.tasks.dispose(); await workspaceCore.dispose(); workspaceDatabase.close();
    await lifecycle.close();
  } };
}
async function settle(host: Awaited<ReturnType<typeof hostFixture>>, id: string, status: string) {
  for (let i = 0; i < 300; i++) { const task = host.services.tasks.get(id); if (task.status === status) return task; await delay(20); }
  assert.fail('Actual task did not reach ' + status + ': ' + JSON.stringify(host.services.tasks.get(id)));
}
async function seed(host: Awaited<ReturnType<typeof hostFixture>>) {
  const state = host.core.getState(), tasks = host.services.tasks;
  const create = (name: string, action = 'synthetic.done', options: { reviewRequired?: boolean; dependencies?: string[] } = {}) => tasks.create({
    title: 'Synthetic ' + name, conversationId: state.conversationId, runtimeId: 'synthetic.taskcenter', action, args: { synthetic: true }, requestId: 'synthetic-' + name, ...options });
  const ready = create('ready'), running = create('running', 'synthetic.hold'); tasks.start(running.id); await settle(host, running.id, 'running');
  const failed = create('failed', 'synthetic.fail'); tasks.start(failed.id); await settle(host, failed.id, 'failed');
  const succeeded = create('succeeded'); tasks.start(succeeded.id); await settle(host, succeeded.id, 'succeeded');
  const review = create('review', 'synthetic.done', { reviewRequired: true }); tasks.start(review.id); await settle(host, review.id, 'awaiting_review');
  const blocked = create('blocked', 'synthetic.done', { dependencies: [ready.id] }); assert.equal(blocked.status, 'blocked');
  const paused = create('paused', 'synthetic.hold'); tasks.start(paused.id); await settle(host, paused.id, 'running'); await tasks.pause(paused.id); await settle(host, paused.id, 'paused');
  const cancelled = create('cancelled'); await tasks.cancel(cancelled.id); await settle(host, cancelled.id, 'cancelled');
  return { state, ready, running, failed, succeeded, review, blocked, paused, cancelled };
}

test('task center HTTP fixture exposes actual TaskService states without model or supplier calls', { skip: !parent || !webRoot, timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(parent!, 'task-http-'))), host = await hostFixture(root);
  try {
    const seeded = await seed(host);
    const response = await fetch(host.url + 'api/tasks?conversationId=' + seeded.state.conversationId, { headers: { 'x-local-data-generation': '1' } });
    assert.equal(response.status, 200); const actual = await response.json();
    assert.deepEqual(actual.map((task: { status: string }) => task.status).sort(), ['ready', 'running', 'failed', 'succeeded', 'awaiting_review', 'blocked', 'paused', 'cancelled'].sort());
    const detail = await fetch(host.url + 'api/tasks/' + seeded.failed.id, { headers: { 'x-local-data-generation': '1' } });
    assert.equal(detail.status, 200); const receipt = await detail.json(); assert.equal(receipt.task.error.code, 'SYNTHETIC_FAILURE'); assert.ok(receipt.runs.length);
    assert.deepEqual(host.core.getState().messages, seeded.state.messages);
  } finally { await host.close(); }
});

async function navigateTasks(browser: Browser, url: string, english = false) {
  await browser.page('Page.navigate', { url });
  const capture = english ? 'Capture sources' : '采集源';
  await browser.until(`!!document.querySelector('button[aria-label='+${q(JSON.stringify(capture))}+']')`, 'Actual app navigation unavailable');
  await browser.evaluate(`document.querySelector('button[aria-label='+${q(JSON.stringify(capture))}+']').click()`);
  await showTasks(browser, english);
}
async function showTasks(browser: Browser, english = false) {
  const agent = english ? 'Show agent workspace' : '展开 Agent 工作台', center = english ? 'Show task center' : '展开任务中心';
  await browser.evaluate(`document.querySelector('button[aria-label='+${q(JSON.stringify(agent))}+']')?.click()`);
  await browser.until("!!document.querySelector('.workspace-agent')", 'Actual agent workspace unavailable');
  await browser.evaluate(`document.querySelector('button[aria-label='+${q(JSON.stringify(center))}+']')?.click()`);
  await browser.until("!!document.querySelector('.agent-tasks-list')", 'Task center unavailable');
}
async function refresh(browser: Browser, english = false) {
  const label = english ? 'Refresh tasks' : '刷新任务';
  await browser.until(`[...document.querySelectorAll('.workspace-agent button')].some(e=>e.textContent===${q(label)}&&!e.disabled)`, 'Read-only refresh unavailable');
  await browser.evaluate(`[...document.querySelectorAll('.workspace-agent button')].find(e=>e.textContent===${q(label)}&&!e.disabled).click()`);
}
async function screenshot(browser: Browser, root: string, name: string, scheme: string, detailId?: string) {
  await browser.page('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
  await browser.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  // Responsive media effects can close the drawer. Let those effects settle
  // before using the real toggle, then verify the live rendered state again.
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await showTasks(browser, name.includes('-en'));
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await browser.until("document.querySelector('.workspace-agent')?.dataset.open==='true'&&document.querySelector('.workspace-agent')?.getAttribute('aria-hidden')==='false'", 'Screenshot requires an actually open Agent drawer');
  const target = detailId ? '[data-task-id=' + JSON.stringify(detailId) + '] .agent-task-details' : '.agent-tasks-list';
  if (detailId) {
    const splitter = name.includes('-en') ? 'Resize conversation and task center' : '调整会话与任务中心高度';
    await browser.page('Page.bringToFront');
    await browser.evaluate(`document.querySelector('[aria-label='+${q(JSON.stringify(splitter))}+']').focus()`);
    assert.equal(await browser.evaluate(`document.hasFocus() && document.activeElement?.getAttribute('aria-label')===${q(splitter)}`), true, 'Task splitter must hold real keyboard focus');
    for (let i = 0; i < 12; i++) {
      await browser.page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, modifiers: 8 });
      await browser.page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, modifiers: 8 });
    }
    await browser.evaluate(`(()=>{const d=document.querySelector(${q(target)});if(!d.open)d.querySelector('summary').click();})()`);
    assert.equal(await browser.evaluate(`document.querySelector(${q(target)}).open`), true);
  } else await browser.evaluate("document.querySelector('.agent-tasks-list').scrollTop=0");
  const scrollTarget = detailId ? '[data-task-id=' + JSON.stringify(detailId) + ']' : target;
  await browser.evaluate(`document.querySelector(${q(scrollTarget)}).scrollIntoView({block:'start',inline:'nearest'})`);
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  for (const selector of ['.agent-tasks-list', target, ...(detailId ? [scrollTarget + ' [role=note]'] : [])]) {
    const visible = await browser.evaluate<boolean>(`(()=>{const e=document.querySelector(${q(selector)});if(!e||!e.getClientRects().length)return false;
      const r=e.getBoundingClientRect();let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
      for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0||p.getAttribute('aria-hidden')==='true')return false;
        if(p!==e){const b=p.getBoundingClientRect();if(['auto','scroll','hidden','clip'].includes(s.overflowX)){left=Math.max(left,b.left+p.clientLeft);right=Math.min(right,b.left+p.clientLeft+p.clientWidth);}if(['auto','scroll','hidden','clip'].includes(s.overflowY)){top=Math.max(top,b.top+p.clientTop);bottom=Math.min(bottom,b.top+p.clientTop+p.clientHeight);}}}
      return right>left&&bottom>top;})()`);
    assert.equal(visible, true, 'Screenshot target must intersect viewport and all clipping ancestors: ' + selector);
  }
  const snapshot = await browser.evaluate<{ state: string; count: number; empty: boolean; alert: boolean }>("(()=>{const list=document.querySelector('.agent-tasks-list');return {state:list.dataset.feedStatus,count:list.querySelectorAll('.agent-task-row').length,empty:!!list.querySelector('.workspace-empty'),alert:!!list.querySelector('[role=alert]')};})()");
  if (name.includes('error')) { assert.ok(['stale', 'error'].includes(snapshot.state)); assert.equal(snapshot.alert, true); assert.equal(snapshot.empty, false); }
  else if (name.includes('empty')) { assert.equal(snapshot.state, 'ready'); assert.equal(snapshot.count, 0); assert.equal(snapshot.empty, true); }
  else { assert.equal(snapshot.state, 'ready'); assert.equal(snapshot.count, 8); }
  const boxes = await browser.evaluate<Array<{ left: number; right: number; width: number }>>("[...document.querySelectorAll('.agent-task-row')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};})");
  for (const box of boxes) assert.ok(box.width > 0 && box.left >= -2 && box.right <= 392, 'Unclipped task row overflow: ' + JSON.stringify(box));
  writeFileSync(join(root, name + '.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}

test('actual task center shares real task feed, rejects stale replies and never dispatches from viewing',
  { skip: !program || !digest || !webRoot || !parent ? 'Requires actual verified browser and built assets; HTTP is not browser evidence.' : false, timeout: 180000 }, async () => {
    assert.equal(createHash('sha256').update(readFileSync(program!)).digest('hex'), digest);
    const root = realpathSync(mkdtempSync(join(parent!, 'task-ui-'))), visual = process.env.XUAN_TASK_VISUAL_ROOT ?? root;
    assert.ok(isAbsolute(visual)); mkdirSync(visual, { recursive: true });
    const host = await hostFixture(root); let browser: Browser | undefined;
    try {
      const seeded = await seed(host), initial = seeded.state, draftText = 'Synthetic task-center draft; no dispatch.';
      const draft = host.core.getDraft(initial.conversationId, 'main', '', initial.branchId);
      host.core.saveDraft(initial.conversationId, draftText, draft.revision, draft.key, []);
      const taskIds = host.services.tasks.list().map(t => t.id).sort(), settings = host.services.sourceSettings.get();
      browser = await openIsolatedBrowser(program!, root);
      // Fault instrumentation retains native EventSource and actual HTTP bodies.
      // Closing a transport or delaying a response is not a fabricated task event.
      await browser.page('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
        const Native=window.EventSource;window.__taskStreams=[];
        window.EventSource=class extends Native{constructor(...args){super(...args);if(String(args[0]).includes('/api/tasks/events')){window.__taskStreams.push(this);if(window.__taskStreamFail)queueMicrotask(()=>{this.close();this.dispatchEvent(new Event('error'));});}}};
        const original=window.fetch.bind(window);window.__taskGetMode='normal';window.fetch=async(...args)=>{
          const u=new URL(String(args[0]),location.href);if(u.pathname!=='/api/tasks')return original(...args);
          if(window.__taskGetMode==='fail')return new Response(JSON.stringify({error:'synthetic task GET interruption'}),{status:503,headers:{'Content-Type':'application/json'}});
          const response=await original(...args);if(window.__taskGetMode==='hold'){window.__taskGetWaiting=true;await new Promise(resolve=>window.__taskGetRelease=resolve);window.__taskGetReleased=true;}return response;};
      })()` });
      await navigateTasks(browser, host.url);
      await browser.until("document.querySelector('.agent-tasks-list')?.dataset.feedStatus==='ready'&&document.querySelectorAll('.agent-task-row').length===8", 'Actual task statuses not ready');
      assert.equal(await browser.evaluate('window.__taskStreams.filter(s=>s.readyState!==EventSource.CLOSED).length'), 1, 'Conversation and center share one live task stream');
      for (const item of host.services.tasks.list()) assert.equal(await browser.evaluate(`document.querySelector('[data-task-id='+${q(JSON.stringify(item.id))}+']')?.getAttribute('data-state')`), item.status);
      for (const group of ['active', 'attention', 'finished']) assert.ok(await browser.evaluate(`!!document.querySelector('[data-task-group='+${q(JSON.stringify(group))}+']')`));
      const failedSelector = `[data-task-id=${JSON.stringify(seeded.failed.id)}]`;
      await browser.evaluate(`document.querySelector(${q(failedSelector + ' summary')}).click()`);
      assert.match(await browser.evaluate<string>(`document.querySelector(${q(failedSelector)}).textContent`), /SYNTHETIC_FAILURE|Explicit synthetic failure/u);
      assert.equal(await browser.evaluate(`document.querySelectorAll(${q(failedSelector + ' button')}).length`), 0, 'Record viewing has no dispatch controls');
      await screenshot(browser, visual, 'task-center-zh-light', 'light');
      await screenshot(browser, visual, 'task-center-zh-dark', 'dark');
      await screenshot(browser, visual, 'task-center-failure-zh-light', 'light', seeded.failed.id);
      // Hold an actual GET snapshot of running, then complete the actual runtime via SSE.
      await browser.evaluate("window.__taskGetMode='hold';window.__taskGetWaiting=false;window.__taskGetReleased=false"); await refresh(browser);
      await browser.until('window.__taskGetWaiting===true', 'Actual GET did not reach delay');
      assert.ok(host.releases.has(seeded.running.id)); host.releases.get(seeded.running.id)!(); await settle(host, seeded.running.id, 'succeeded');
      await browser.until(`document.querySelector('[data-task-id='+${q(JSON.stringify(seeded.running.id))}+']')?.dataset.state==='succeeded'`, 'Real SSE completion missing');
      await browser.evaluate("window.__taskGetMode='normal';window.__taskGetRelease()");
      await browser.until('window.__taskGetReleased===true', 'Old GET not released');
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await browser.evaluate(`document.querySelector('[data-task-id='+${q(JSON.stringify(seeded.running.id))}+']')?.dataset.state`), 'succeeded');
      // Explicit transport faults close actual native streams, including retry attempts.
      await browser.evaluate("window.__taskStreamFail=true;window.__taskStreams.at(-1).close();window.__taskStreams.at(-1).dispatchEvent(new Event('error'));window.__taskGetMode='fail'"); await refresh(browser);
      await browser.until("['stale','error'].includes(document.querySelector('.agent-tasks-list')?.dataset.feedStatus)", 'Disconnected/error feed must not appear ready');
      assert.equal(await browser.evaluate("document.querySelectorAll('.agent-task-row').length"), 8, 'Failure keeps last actual records rather than claiming empty');
      const beforeReconnect = await browser.evaluate<number>('window.__taskStreams.length');
      await browser.evaluate("window.__taskGetMode='normal';window.__taskStreamFail=false"); await refresh(browser);
      await browser.until("document.querySelector('.agent-tasks-list')?.dataset.feedStatus==='ready'", 'New actual SSE snapshot must establish recovery');
      assert.ok(await browser.evaluate<number>('window.__taskStreams.length') > beforeReconnect, 'Disconnected refresh must open an actual native connection');
      await navigateTasks(browser, host.url);
      await browser.until("document.querySelector('.agent-tasks-list')?.dataset.feedStatus==='ready'", 'New actual SSE snapshot must restore ready');
      // A previous conversation's actual delayed response must never populate a new one.
      await browser.evaluate("window.__taskGetMode='hold';window.__taskGetWaiting=false;window.__taskGetReleased=false"); await refresh(browser);
      await browser.until('window.__taskGetWaiting===true', 'Old-scope GET did not reach delay');
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await browser.evaluate("document.querySelector('button[aria-label=\"收起 Agent 工作台\"]')?.click();document.querySelector('button[aria-label=\"会话\"]').click()");
      await browser.until("!!document.querySelector('button[aria-label=\"新建会话\"]:not([disabled])')", 'Explicit new conversation unavailable');
      await browser.evaluate("window.__taskGetMode='normal';document.querySelector('button[aria-label=\"新建会话\"]').click()");
      await browser.until(`(()=>{const e=document.querySelector('.conversation-row[data-active=true]');return !!e&&e.dataset.conversationId!==${q(initial.conversationId)};})()`, 'New real scope missing');
      const secondId = await browser.evaluate<string>("document.querySelector('.conversation-row[data-active=true]').dataset.conversationId");
      await browser.evaluate("document.querySelector('button[aria-label=\"采集源\"]').click()"); await showTasks(browser);
      await browser.until("document.querySelector('.agent-tasks-list')?.dataset.feedStatus==='ready'&&document.querySelectorAll('.agent-task-row').length===0", 'New scope genuine empty snapshot missing');
      await browser.evaluate('window.__taskGetRelease()'); await browser.until('window.__taskGetReleased===true', 'Old-scope reply not released');
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await browser.evaluate("document.querySelectorAll('.agent-task-row').length"), 0);
      assert.equal(host.services.tasks.list({ conversationId: secondId }).length, 0);
      await browser.evaluate(`(async()=>{const s=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));const headers={'x-local-data-generation':String(s.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const p=await(await fetch('/api/ui/preferences',{headers})).json();const r=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en'})});if(!r.ok)throw Error('Preference save failed');})()`);
      await navigateTasks(browser, host.url, true); await browser.until("document.querySelector('.agent-tasks-list')?.dataset.feedStatus==='ready'", 'English real feed missing');
      await screenshot(browser, visual, 'task-center-empty-en-light', 'light');
      await browser.evaluate("window.__taskStreamFail=true;window.__taskStreams.at(-1).close();window.__taskStreams.at(-1).dispatchEvent(new Event('error'));window.__taskGetMode='fail'"); await refresh(browser, true);
      await browser.until("['stale','error'].includes(document.querySelector('.agent-tasks-list')?.dataset.feedStatus)", 'English empty scope read failure missing');
      await screenshot(browser, visual, 'task-center-error-en-dark', 'dark');
      await browser.evaluate("window.__taskStreamFail=false;window.__taskGetMode='normal';document.querySelector('button[aria-label=\"Hide agent workspace\"]')?.click()");
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await browser.evaluate("document.querySelector('button[aria-label=\"Conversations\"]').click()");
      const originalRow = '.conversation-row[data-conversation-id=' + JSON.stringify(initial.conversationId) + '] .conversation-item';
      await browser.until(`!!document.querySelector(${q(originalRow)})`, 'Original real conversation row missing');
      await browser.evaluate(`document.querySelector(${q(originalRow)}).click()`);
      await browser.evaluate("document.querySelector('button[aria-label=\"Capture sources\"]').click()"); await showTasks(browser, true);
      await browser.until("document.querySelector('.agent-tasks-list')?.dataset.feedStatus==='ready'&&document.querySelectorAll('.agent-task-row').length===8", 'Original task scope must recover on actual selection');
      await screenshot(browser, visual, 'task-center-en-light', 'light');
      await screenshot(browser, visual, 'task-center-en-dark', 'dark');
      await screenshot(browser, visual, 'task-center-failure-en-light', 'light', seeded.failed.id);
      assert.deepEqual(host.services.tasks.list().map(t => t.id).sort(), taskIds);
      assert.equal(host.core.getDraft(initial.conversationId, 'main', '', initial.branchId).text, draftText);
      assert.deepEqual(host.core.getState(initial.conversationId).messages, initial.messages);
      assert.deepEqual(host.core.getState(secondId).messages, []); assert.deepEqual(host.services.sourceSettings.get(), settings);
      assert.equal(browser.requests.filter(r => r.method === 'POST' && /\/api\/tasks(?:\/|$)/u.test(new URL(r.url).pathname)).length, 0);
      assert.equal(browser.blockedRequests.length, 0);
    } finally { await browser?.close(); await host.close(); }
  });
