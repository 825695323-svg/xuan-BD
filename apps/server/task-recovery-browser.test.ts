import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
  writeFileSync(join(root, 'never-authorized.txt'), 'Synthetic permission fixture, no grant.');
  const database = new CoreDatabase(join(root, 'personal.sqlite'));
  const core = new PersonalCore(backend, { database });
  const releases = new Map<string, () => void>();
  const executions = new Map<string, number>();
  let reconcile = false;
  const runtime: TaskRuntime = { id: 'synthetic.taskcenter', execute: async context => {
    executions.set(context.task.id, (executions.get(context.task.id) ?? 0) + 1);
    if (context.task.action === 'synthetic.retry' && executions.get(context.task.id) === 1) throw new TaskError('SYNTHETIC_FIRST_FAILURE', 'Explicit first attempt failure');
    if (context.task.action === 'synthetic.denied') {
      const target = { kind: 'file' as const, path: join(root, 'never-authorized.txt') };
      context.assertAuthorized({ operationId: 'synthetic-read', operationVersion: 1, argsDigest: createHash('sha256').update('synthetic').digest('hex'), targets: [target] }, [{ action: 'read', target }]);
    }
    if (context.task.action === 'synthetic.unknown') {
      await context.emit({ type: 'side_effect_started', effectId: 'synthetic-original-effect', description: 'Synthetic identity only, no external call' });
      throw new TaskError('SYNTHETIC_UNKNOWN', 'Synthetic effect requires reconciliation');
    }
    await context.emit({ type: 'progress', message: 'Synthetic isolated task entered its actual runtime', evidenceKey: 'synthetic-runtime-entered' });
    if (context.task.action === 'synthetic.fail') throw new TaskError('SYNTHETIC_FAILURE', 'Explicit synthetic failure, no supplier or model invocation');
    if (context.task.action === 'synthetic.hold') await new Promise<void>((done, reject) => {
      const abort = () => { releases.delete(context.task.id); reject(new Error('Synthetic runtime observed actual abort')); };
      context.signal.addEventListener('abort', abort, { once: true });
      releases.set(context.task.id, () => { context.signal.removeEventListener('abort', abort); releases.delete(context.task.id); done(); });
      if (context.signal.aborted) abort();
    });
    return { summary: 'Synthetic task result; no business operation occurred', data: { synthetic: true } };
  }, recover: async ({ effects }) => reconcile
    ? { outcome: 'succeeded', evidence: 'Synthetic lookup of original identities', effects: effects.map(effect => ({ attemptId: effect.attemptId, effectId: effect.effectId, outcome: 'succeeded', evidence: 'Synthetic original identity resolved' })), result: { summary: 'Synthetic reconciliation only' } }
    : { outcome: 'pending', evidence: 'Synthetic original outcome remains unknown', effects: [] } };
  const unsupported: TaskRuntime = { id: 'synthetic.unsupported', execute: async () => { throw new TaskError('SYNTHETIC_FAILURE', 'No recovery implementation'); } };
  const lifecycle = new LocalDataLifecycle({ controlDatabasePath: join(root, 'lifecycle.sqlite'), dataIdFromTask: () => 'selection-data' });
  lifecycle.register('selection-data'); lifecycle.bindIdentity('selection-data', database.path);
  const workspaceDatabase = new CoreDatabase(join(root, 'workspace.sqlite'));
  const workspaceCore = new PersonalCore(backend, { database: workspaceDatabase });
  const workspaceServices = createApplicationServices(workspaceCore, workspaceDatabase, { role: 'service', health,
    projectRoot: root, codeRoot: resolve(import.meta.dirname, '../..'), privateRoot: join(root, 'workspace-private') });
  const services = createApplicationServices(core, database, { health, projectRoot: root, codeRoot: resolve(import.meta.dirname, '../..'),
    privateRoot: join(root, 'private'), workspaceServices, taskRuntimes: [runtime, unsupported], localData: { lifecycle, dataId: 'selection-data', verify: async () => { throw new Error('No lifecycle changes in selection fixture'); } } });
  services.permissions.grant({ capabilities: [{ action: 'read', target: { kind: 'file', path: join(root, 'never-authorized.txt') } }], effect: 'deny', label: 'Explicit synthetic fixture denial' });
  const server = createApp(core, health, services, { webRoot: webRoot! }).listen(0, '127.0.0.1');
  const streams = new Set<ServerResponse>();
  server.on('request', (req, res) => { if (req.url?.startsWith('/api/tasks/events')) { streams.add(res); res.on('close', () => streams.delete(res)); } });
  await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address === 'object');
  return { core, services, workspaceServices, releases, executions, invalidateTaskStreams() {
    // Explicit host lifecycle-notification fault, not a real user deactivation command.
    for (const stream of streams) stream.write('event: lifecycle\ndata: {"status":"unavailable"}\n\n');
  }, resolveEffects() { reconcile = true; }, url: `http://127.0.0.1:${address.port}/`, async close() {
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
async function seedRecovery(host: Awaited<ReturnType<typeof hostFixture>>) {
  const state = host.core.getState(), tasks = host.services.tasks;
  const create = (name: string, runtimeId = 'synthetic.taskcenter') => tasks.create({ title: 'Synthetic ' + name,
    conversationId: state.conversationId, runtimeId, action: 'synthetic.' + name, args: { synthetic: true }, requestId: name });
  const denied = create('denied');
  const retry = create('retry'), paused = create('hold'), unknown = create('unknown'), unsupported = create('unsupported', 'synthetic.unsupported');
  for (const item of [retry, unknown, unsupported, denied]) tasks.start(item.id);
  await settle(host, denied.id, 'failed'); await settle(host, retry.id, 'failed'); await settle(host, unknown.id, 'needs_review'); await settle(host, unsupported.id, 'failed');
  tasks.start(paused.id); await settle(host, paused.id, 'running');
  while (!host.releases.has(paused.id)) await delay(10);
  await tasks.pause(paused.id); await settle(host, paused.id, 'paused');
  return { state, retry, paused, unknown, unsupported, denied };
}
async function request(host: Awaited<ReturnType<typeof hostFixture>>, path: string, body?: unknown) {
  const response = await fetch(host.url + 'api/' + path, { method: body ? 'POST' : 'GET',
    headers: { 'x-local-data-generation': '1', 'x-mashiro-client': 'web', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
test('task recovery HTTP uses actual original runs, versions and unknown-effect identities',
  { skip: !parent || !webRoot, timeout: 30000 }, async () => {
    const root = realpathSync(mkdtempSync(join(parent!, 'recovery-http-'))), host = await hostFixture(root);
    try {
      const s = await seedRecovery(host), tasks = host.services.tasks, ids = tasks.list().map(t => t.id).sort();
      for (const [item, supported] of [[s.retry, true], [s.unsupported, false]] as const) {
        const detail = await request(host, 'tasks/' + item.id); assert.equal(detail.status, 200); assert.equal(detail.body.recoverySupported, supported);
      }
      const denied = await request(host, 'tasks/' + s.denied.id + '/command', { command: 'retry', version: tasks.get(s.denied.id).version });
      assert.equal(denied.status, 200); await settle(host, s.denied.id, 'failed');
      assert.equal(tasks.get(s.denied.id).error!.code, 'POLICY_DENIED');
      const version = tasks.get(s.retry.id).version;
      const retried = await request(host, 'tasks/' + s.retry.id + '/command', { command: 'retry', version });
      assert.equal(retried.status, 200); await settle(host, s.retry.id, 'succeeded'); assert.equal(host.executions.get(s.retry.id), 2);
      const duplicate = await request(host, 'tasks/' + s.retry.id + '/command', { command: 'retry', version });
      assert.notEqual(duplicate.status, 200); assert.match(JSON.stringify(duplicate.body), /TASK_VERSION_CONFLICT/u);
      const resumed = await request(host, 'tasks/' + s.paused.id + '/command', { command: 'resume', version: tasks.get(s.paused.id).version });
      assert.equal(resumed.status, 200); await settle(host, s.paused.id, 'running');
      while (!host.releases.has(s.paused.id)) await delay(10);
      host.releases.get(s.paused.id)!(); await settle(host, s.paused.id, 'succeeded'); assert.equal(host.executions.get(s.paused.id), 2);
      for (const command of ['resume', 'retry']) {
        const rejected = await request(host, 'tasks/' + s.unknown.id + '/command', { command, version: tasks.get(s.unknown.id).version });
        assert.notEqual(rejected.status, 200); assert.match(JSON.stringify(rejected.body), /UNKNOWN_RESULT/u);
      }
      const pending = await request(host, 'tasks/' + s.unknown.id + '/recover', { version: tasks.get(s.unknown.id).version });
      assert.equal(pending.status, 200); assert.equal(tasks.get(s.unknown.id).status, 'needs_review');
      host.resolveEffects();
      const recovered = await request(host, 'tasks/' + s.unknown.id + '/recover', { version: tasks.get(s.unknown.id).version });
      assert.equal(recovered.status, 200); assert.equal(tasks.get(s.unknown.id).status, 'succeeded');
      assert.equal(host.executions.get(s.unknown.id), 1, 'Lookup never redispatches original effect');
      const unsupported = await request(host, 'tasks/' + s.unsupported.id + '/recover', { version: tasks.get(s.unsupported.id).version });
      assert.notEqual(unsupported.status, 200); assert.match(JSON.stringify(unsupported.body), /RECOVERY_NOT_SUPPORTED/u);
      assert.deepEqual(tasks.list().map(t => t.id).sort(), ids); assert.deepEqual(host.core.getState().messages, s.state.messages);
    } finally { await host.close(); }
  });

async function button(browser: Browser, text: string, scope = 'document') {
  // SSE may render between two CDP calls. Resolve and click the actual enabled
  // control in one browser turn; no forced click and no relaxed disabled gate.
  await browser.until(`(()=>{const root=${scope};if(!root)return false;const b=[...root.querySelectorAll('button')].find(e=>e.textContent.trim()===${q(text)}&&!e.disabled);if(!b)return false;b.click();return true;})()`, 'Missing actual enabled button ' + text);
}
async function inspect(browser: Browser, id: string, english = false) {
  const scope = `document.querySelector('[data-task-id='+${q(JSON.stringify(id))}+']')`;
  await browser.evaluate(`(()=>{const d=${scope}.querySelector('.agent-task-details');if(!d.open)d.querySelector('summary').click();})()`);
  await button(browser, english ? 'Review recovery actions' : '查看恢复操作', scope);
  await browser.until(`!!document.querySelector('dialog[open]')`, 'Recovery preview missing');
}
async function capturePreview(browser: Browser, root: string, name: string, scheme: string) {
  await browser.page('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
  await browser.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const geometry = await browser.evaluate<boolean>(`(()=>{const d=document.querySelector('dialog[open]');if(!d)return false;
    return [d,...d.querySelectorAll('button')].every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;});})()`);
  assert.equal(geometry, true, 'Actual confirmation and every action must be visible, not clipped');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, name + '.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}
async function show(browser: Browser, page: string) {
  await browser.until(`!!document.querySelector('button[aria-label='+${q(JSON.stringify(page))}+']')`, 'Navigation missing');
  await browser.evaluate(`document.querySelector('button[aria-label="收起 Agent 工作台"]')?.click();document.querySelector('button[aria-label='+${q(JSON.stringify(page))}+']').click()`);
  if (page === '会话') {
    await browser.until("!!document.querySelector('details.conversation-task-center')", 'Standalone task center missing');
    await browser.evaluate("(()=>{const d=document.querySelector('details.conversation-task-center');if(!d.open)d.querySelector('summary').click();})()");
  } else await browser.evaluate(`document.querySelector('button[aria-label="展开 Agent 工作台"]')?.click();document.querySelector('button[aria-label="展开任务中心"]')?.click()`);
  await browser.until("document.querySelector('.agent-tasks-list')?.dataset.feedStatus==='ready'", 'Actual task feed missing');
}
test('actual recovery UI searches current tasks and confirms one original-task action without automatic dispatch',
  { skip: !program || !digest || !webRoot || !parent, timeout: 180000 }, async () => {
    assert.equal(createHash('sha256').update(readFileSync(program!)).digest('hex'), digest);
    const root = realpathSync(mkdtempSync(join(parent!, 'recovery-ui-'))), host = await hostFixture(root);
    let browser: Browser | undefined;
    try {
      const s = await seedRecovery(host), ids = host.services.tasks.list().map(t => t.id).sort();
      const draft = host.core.getDraft(s.state.conversationId, 'main', '', s.state.branchId);
      host.core.saveDraft(s.state.conversationId, 'Synthetic recovery draft, never sent.', draft.revision, draft.key, []);
      browser = await openIsolatedBrowser(program!, root);
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await browser.page('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const original=fetch.bind(window);window.fetch=async(...args)=>{const response=await original(...args);const path=new URL(String(args[0]),location.href).pathname;if(window.__holdTaskDetail&&/^\\/api\\/tasks\\/[^/]+$/.test(path)){window.__detailWaiting=true;await new Promise(resolve=>window.__detailRelease=resolve);}return response;};})()` });
      await browser.page('Page.navigate', { url: host.url });
      await show(browser, '采集源');
      const search = '查找当前会话任务：标题、编号、动作或状态';
      for (const page of ['采集源', '接口源', '算法', '会话']) {
        await show(browser, page);
        await browser.evaluate(`(()=>{const e=document.querySelector('input[aria-label='+${q(JSON.stringify(search))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${q(s.retry.id)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await browser.until("document.querySelectorAll('.agent-task-row').length===1", 'Search must filter current actual tasks');
        assert.equal(await browser.evaluate("document.querySelector('.agent-task-row').dataset.taskId"), s.retry.id);
        await browser.evaluate(`(()=>{const e=document.querySelector('input[aria-label='+${q(JSON.stringify(search))}+']');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      }
      await inspect(browser, s.retry.id);
      await capturePreview(browser, process.env.XUAN_TASK_VISUAL_ROOT ?? root, 'task-recovery-zh-light', 'light');
      await capturePreview(browser, process.env.XUAN_TASK_VISUAL_ROOT ?? root, 'task-recovery-zh-dark', 'dark');
      await button(browser, '取消');
      await browser.page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      assert.equal(host.executions.get(s.retry.id), 1);
      await inspect(browser, s.retry.id);
      await browser.evaluate("(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent==='重试原任务');b.click();b.click();})()");
      await settle(host, s.retry.id, 'succeeded');
      await browser.until(`document.querySelector('[data-task-id='+${q(JSON.stringify(s.retry.id))}+']')?.dataset.state==='succeeded'`, 'Original task update missing');
      assert.equal(host.executions.get(s.retry.id), 2);
      assert.equal(browser.requests.filter(r => r.method === 'POST' && r.url.endsWith('/tasks/' + s.retry.id + '/command')).length, 1);
      await inspect(browser, s.unknown.id);
      assert.equal(await browser.evaluate("[...document.querySelectorAll('[aria-label=\"确认原任务操作\"] button')].some(e=>e.textContent==='重试原任务'||e.textContent==='继续原任务')"), false);
      await button(browser, '核对原外部结果');
      await browser.until(`!document.querySelector('[aria-label="确认原任务操作"]')`, 'Preview must close');
      assert.equal(host.services.tasks.get(s.unknown.id).status, 'needs_review'); assert.equal(host.executions.get(s.unknown.id), 1);
      await browser.until(`!!document.querySelector('[data-task-id='+${q(JSON.stringify(s.unknown.id))}+'] [role=status]')&&document.querySelector('.agent-tasks-list')?.getAttribute('aria-busy')==='false'`, 'Original lookup response and follow-up refresh must finish before the next task action');
      await inspect(browser, s.paused.id);
      // Actual service change invalidates the frozen preview; no synthetic task payload.
      await host.services.tasks.cancel(s.paused.id);
      await browser.until("[...document.querySelectorAll('button')].some(e=>e.textContent==='继续原任务'&&e.disabled)", 'Changed version must disable frozen confirmation');
      await button(browser, '取消');
      // Delay a genuine detail response, then switch via the actual new-conversation UI.
      await browser.evaluate('window.__holdTaskDetail=true');
      const unsupportedScope = `document.querySelector('[data-task-id='+${q(JSON.stringify(s.unsupported.id))}+']')`;
      await browser.evaluate(`(()=>{const d=${unsupportedScope}.querySelector('details');if(!d.open)d.querySelector('summary').click();})()`);
      await button(browser, '查看恢复操作', unsupportedScope);
      await browser.until('window.__detailWaiting===true', 'Actual detail response was not held');
      await browser.evaluate(`document.querySelector('button[aria-label="新建会话"]').click()`);
      await browser.until(`document.querySelector('.conversation-row[data-active=true]')?.dataset.conversationId!==${q(s.state.conversationId)}`, 'New actual conversation must be selected');
      await browser.evaluate('window.__holdTaskDetail=false;window.__detailRelease()');
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await browser.evaluate(`!!document.querySelector('[aria-label="确认原任务操作"]')`), false, 'Late previous-scope detail cannot create a new preview');
      assert.deepEqual(host.services.tasks.list().map(t => t.id).sort(), ids);
      assert.deepEqual(host.core.getState(s.state.conversationId).messages, s.state.messages);
      assert.equal(host.core.getDraft(s.state.conversationId, 'main', '', s.state.branchId).text, 'Synthetic recovery draft, never sent.');
      // Use the real preferences endpoint and original conversation for English confirmation.
      await browser.evaluate(`(async()=>{const s=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));const headers={'x-local-data-generation':String(s.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const p=await(await fetch('/api/ui/preferences',{headers})).json();const r=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en'})});if(!r.ok)throw Error('Preference save failed');})()`);
      await browser.page('Page.reload');
      await browser.until(`!!document.querySelector('.conversation-row[data-conversation-id='+${q(JSON.stringify(s.state.conversationId))}+']')`, 'Original conversation unavailable');
      await browser.evaluate(`document.querySelector('.conversation-row[data-conversation-id='+${q(JSON.stringify(s.state.conversationId))}+'] .conversation-item').click()`);
      await browser.until("!!document.querySelector('.conversation-task-center')", 'Standalone shared center missing');
      await browser.evaluate("document.querySelector('.conversation-task-center:not([open]) > summary')?.click()");
      await browser.until("document.querySelector('.agent-tasks-list')?.dataset.feedStatus==='ready'", 'English task feed missing');
      await browser.until(`document.querySelector('.conversation-row[data-active=true]')?.dataset.conversationId===${q(s.state.conversationId)}&&!!document.querySelector('[data-task-id='+${q(JSON.stringify(s.paused.id))}+']')`, 'Original conversation task must actually be selected');
      await inspect(browser, s.paused.id, true);
      await capturePreview(browser, process.env.XUAN_TASK_VISUAL_ROOT ?? root, 'task-recovery-en-light', 'light');
      await capturePreview(browser, process.env.XUAN_TASK_VISUAL_ROOT ?? root, 'task-recovery-en-dark', 'dark');
      await button(browser, 'Cancel');
      assert.equal(host.services.tasks.get(s.paused.id).status, 'cancelled', 'English preview must not retry');
      await inspect(browser, s.paused.id, true);
      const writesBeforeInvalidation = browser.requests.filter(r => r.method === 'POST' && /\/tasks\/.*\/(?:command|recover)$/.test(r.url)).length;
      host.invalidateTaskStreams();
      await browser.until("!document.querySelector('dialog[aria-label=\"Confirm original task action\"]')", 'Qualification notification must remove the old confirmation');
      assert.equal(browser.requests.filter(r => r.method === 'POST' && /\/tasks\/.*\/(?:command|recover)$/.test(r.url)).length, writesBeforeInvalidation, 'Revoked preview cannot dispatch');
      assert.equal(host.services.tasks.get(s.paused.id).status, 'cancelled');
      assert.deepEqual(browser.blockedRequests, []); assert.deepEqual(browser.exceptions, []);
    } finally { await browser?.close(); await host.close(); }
  });
