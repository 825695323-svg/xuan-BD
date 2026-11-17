import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';
import type { Backend } from '../../contracts/backend.js';
import type { HealthResponse } from '../../contracts/contracts.js';
import { PersonalCore } from '../../modules/agent/runtime/core.js';
import { CoreDatabase } from '../../platform/state/database.js';
import { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
import { CustomSourceRegistry } from '../../plugins/capture-sources/custom-register.js';
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
  const registry = new CustomSourceRegistry(join(root, 'custom-sources.json'));
  await registry.register({ id: 'synthetic-selection-a', label: 'Synthetic selection A', domain: 'fixture.example.test', cookieNames: '', operations: 'read-page' });
  await registry.register({ id: 'synthetic-selection-b', label: 'Synthetic selection B', domain: 'fixture.example.test', cookieNames: '', operations: 'read-page' });
  const lifecycle = new LocalDataLifecycle({ controlDatabasePath: join(root, 'lifecycle.sqlite'), dataIdFromTask: () => 'selection-data' });
  lifecycle.register('selection-data'); lifecycle.bindIdentity('selection-data', database.path);
  const workspaceDatabase = new CoreDatabase(join(root, 'workspace.sqlite'));
  const workspaceCore = new PersonalCore(backend, { database: workspaceDatabase });
  const workspaceServices = createApplicationServices(workspaceCore, workspaceDatabase, { role: 'service', health,
    projectRoot: root, codeRoot: resolve(import.meta.dirname, '../..'), privateRoot: join(root, 'workspace-private') });
  const services = createApplicationServices(core, database, { health, projectRoot: root, codeRoot: resolve(import.meta.dirname, '../..'),
    privateRoot: join(root, 'private'), workspaceServices, customSources: registry, localData: { lifecycle, dataId: 'selection-data', verify: async () => { throw new Error('No lifecycle changes in selection fixture'); } } });
  const server = createApp(core, health, services, { webRoot: webRoot! }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address === 'object');
  return { core, services, workspaceServices, registry, url: `http://127.0.0.1:${address.port}/`, async close() {
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
async function nav(browser: Browser, name: string) {
  await browser.until(`!!document.querySelector('button[aria-label='+${q(JSON.stringify(name))}+']')`, 'Navigation unavailable ' + name);
  await browser.evaluate(`document.querySelector('button[aria-label='+${q(JSON.stringify(name))}+']').click()`);
}
async function card(browser: Browser, label: string) {
  const selector = `[...document.querySelectorAll('.object-card')].find(e=>e.querySelector('.object-card-title')?.textContent===${q(label)})`;
  await browser.until(`!!(${selector})`, 'Missing real catalogue card ' + label);
  await browser.evaluate(`(${selector}).click()`);
  await browser.until(`(${selector})?.getAttribute('aria-current')==='true'`, 'Selection did not settle');
}
async function fill(browser: Browser, selector: string, value: string) {
  await browser.until(`!!document.querySelector(${q(selector)})`, 'Input unavailable');
  await browser.evaluate(`(()=>{const e=document.querySelector(${q(selector)});const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${q(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();})()`);
}
const stored = (browser: Browser) => browser.evaluate<string | null>("sessionStorage.getItem('xuan.capture.object')");
async function capture(browser: Browser, root: string, name: string, width: number, scheme: string, diagnostics = false) {
  await browser.page('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
  await browser.page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  const geometry = await browser.evaluate<Array<{ label: string; left: number; right: number; top: number; bottom: number;
    visibleLeft: number; visibleRight: number; visibleTop: number; visibleBottom: number }>>(`(async()=>{
    const results=[];
    const controls=[...document.querySelectorAll('.data-nav input[type=search],.object-detail button,.object-detail input,.object-detail select,.object-detail summary')]
      .filter(e=>e.getClientRects().length>0);
    for(const e of controls){
      e.scrollIntoView({block:'center',inline:'nearest'});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const box=e.getBoundingClientRect();let left=0,right=innerWidth,top=0,bottom=innerHeight;
      for(let p=e.parentElement;p;p=p.parentElement){const style=getComputedStyle(p),r=p.getBoundingClientRect();
        if(['auto','scroll','hidden','clip'].includes(style.overflowX)){left=Math.max(left,r.left+p.clientLeft);right=Math.min(right,r.left+p.clientLeft+p.clientWidth);}
        if(['auto','scroll','hidden','clip'].includes(style.overflowY)){top=Math.max(top,r.top+p.clientTop);bottom=Math.min(bottom,r.top+p.clientTop+p.clientHeight);}}
      results.push({label:e.getAttribute('aria-label')||e.textContent,left:box.left,right:box.right,top:box.top,bottom:box.bottom,
        visibleLeft:left,visibleRight:right,visibleTop:top,visibleBottom:bottom});
    }return results;})()`);
  assert.ok(geometry.length > 0, 'Actual page must expose a visible search or detail control');
  for (const box of geometry) {
    assert.ok(box.right > box.left && box.bottom > box.top, 'Control must have real positive dimensions: ' + JSON.stringify(box));
    assert.ok(Math.min(box.right, box.visibleRight) > Math.max(box.left, box.visibleLeft)
      && Math.min(box.bottom, box.visibleBottom) > Math.max(box.top, box.visibleTop),
    'Scrolled control must actually intersect viewport and all clipping ancestors: ' + JSON.stringify(box));
    assert.ok(box.left >= box.visibleLeft - 2 && box.right <= box.visibleRight + 2,
      'Unclipped control rect must fit horizontally; overflow is not concealed: ' + JSON.stringify(box));
  }
  await browser.evaluate(`(()=>{const scroll=document.querySelector('.object-detail-scroll');if(scroll)scroll.scrollTop=0;document.querySelector('.object-detail')?.scrollIntoView({block:'start',inline:'nearest'});${diagnostics ? "document.querySelector('.object-detail-diagnostics > summary')?.scrollIntoView({block:'center',inline:'nearest'});" : ''}})()`);
  await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  writeFileSync(join(root, name + '.png'), Buffer.from((await browser.page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
}

async function verifyCompactDetails(browser: Browser, kind: 'capture' | 'api' | 'tools', english = false) {
  const headings = kind === 'tools'
    ? (english ? ['Algorithm definition', 'Calculation configuration', 'Related products', 'Eligibility and execution'] : ['算法定义', '计算配置', '关联产物', '准入与执行状态'])
    : kind === 'capture' ? (english ? ['Capture capabilities', 'Latest check and run'] : ['采集能力', '最近检查与运行']) : [];
  await browser.until("!!document.querySelector('.object-detail-diagnostics')", 'Selected object diagnostics unavailable');
  for (const heading of headings) {
    assert.equal(await browser.evaluate(`(()=>{const h=[...document.querySelectorAll('.object-detail-content h3')].find(e=>e.textContent===${q(heading)});return !!h&&!h.closest('details:not([open])')&&h.getClientRects().length>0;})()`), true,
      'Professional content must remain expanded: ' + heading);
  }
  const text = await browser.evaluate<string>("document.querySelector('.object-detail').textContent");
  if (kind === 'capture') {
    assert.match(text, english ? /no task execution receipt/u : /没有任务运行回执/u);
    assert.equal(await browser.evaluate("document.querySelector('.object-detail-status').textContent"), english ? 'Unavailable' : '不可用');
    const labels = await browser.evaluate<string[]>("[...document.querySelectorAll('.object-detail-summary dt')].map(e=>e.textContent)");
    assert.deepEqual(labels, english ? ['Capture configuration', 'Channel / language', 'Login'] : ['采集配置', '渠道 / 语言', '登录态']);
  } else if (kind === 'tools') {
    assert.match(text, english ? /Registered parameters, not saved run configuration/u : /登记参数，非已保存的运行配置/u);
    assert.match(text, english ? /Definition links, not actual product receipts/u : /定义关联，不是实际产物回执/u);
    assert.match(text, english ? /cannot establish that a run occurred or succeeded/u : /不能据此判定已运行或成功/u);
  } else {
    const labels = await browser.evaluate<string[]>("[...document.querySelectorAll('.object-detail-summary dt')].map(e=>e.textContent)");
    assert.deepEqual(labels, english ? ['Capabilities', 'Routing', 'Latest check'] : ['数据能力', '来源路由', '最近检查']);
    assert.match(text, english ? /configuration, not proof of a successful check or run/u : /配置，不代表检查或实际运行成功/u);
  }
  assert.equal(await browser.evaluate("document.querySelector('.object-detail-diagnostics').open"), false, 'Diagnostics start collapsed');
  assert.equal(await browser.evaluate("!!document.querySelector('.object-detail-scroll .object-detail-diagnostics')"), true);
  await browser.evaluate("document.querySelector('.object-detail-diagnostics > summary').scrollIntoView({block:'center'});document.querySelector('.object-detail-diagnostics > summary').focus()");
  await browser.page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await browser.page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await browser.until("document.querySelector('.object-detail-diagnostics').open===true", 'Keyboard must expand native diagnostics');
  assert.ok((await browser.evaluate<string>("document.querySelector('.object-detail-diagnostics-body').textContent")).trim());
  await browser.page('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await browser.page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await browser.until("document.querySelector('.object-detail-diagnostics').open===false", 'Keyboard must close diagnostics');
}

test('actual three-page selections preserve shared conversation and survive real catalogue read faults',
  { skip: !program || !digest || !webRoot || !parent ? 'Requires verified browser, built Web assets and isolated root; no mock browser substitute.' : false, timeout: 180000 }, async () => {
    assert.ok(isAbsolute(parent!)); assert.equal(createHash('sha256').update(readFileSync(program!)).digest('hex'), digest);
    const root = realpathSync(mkdtempSync(join(parent!, 'sel-'))), visuals = process.env.XUAN_OBJECT_VISUAL_ROOT ?? root;
    assert.ok(isAbsolute(visuals)); mkdirSync(visuals, { recursive: true });
    const host = await hostFixture(root); let browser: Browser | undefined;
    try {
      const initial = host.core.getState(), draftText = 'Synthetic shared draft: do not send or execute.';
      const draft = host.core.getDraft(initial.conversationId, 'main', '', initial.branchId);
      host.core.saveDraft(initial.conversationId, draftText, draft.revision, draft.key, []);
      const settings = host.services.sourceSettings.get(), tasks = host.services.tasks.list();
      const workspaceTasks = host.workspaceServices.tasks.list(), workspaceSettings = host.workspaceServices.sourceSettings.get();
      browser = await openIsolatedBrowser(program!, root); await browser.page('Page.navigate', { url: host.url });
      await nav(browser, '采集源'); await card(browser, 'Synthetic selection A');
      assert.equal(await stored(browser), 'synthetic-selection-a');
      await fill(browser, '.data-nav input[type=search]', 'no-such-synthetic-source');
      assert.equal(await stored(browser), 'synthetic-selection-a');
      assert.match(await browser.evaluate<string>("document.querySelector('.object-detail')?.textContent ?? document.body.textContent"), /Synthetic selection A/u);
      await fill(browser, '.data-nav input[type=search]', '');
      // Only the custom catalogue transport is fault-injected. All other HTTP endpoints,
      // source records, settings, tasks and shared conversation use the actual server.
      await browser.evaluate(`(()=>{const original=window.fetch.bind(window);window.__selectionFetch=original;window.__catalogMode='fail';window.__catalogFailures=0;window.fetch=async(...args)=>{const url=String(args[0]);if(!url.includes('/api/ui/custom-sources'))return original(...args);if(window.__catalogMode==='fail'){window.__catalogFailures++;return new Response(JSON.stringify({error:'synthetic 503 catalogue interruption'}),{status:503,headers:{'Content-Type':'application/json'}});}const response=await original(...args);if(window.__catalogMode==='hold'){window.__catalogWaiting=true;await new Promise(resolve=>window.__catalogRelease=resolve);window.__catalogReleased=true;}return response;};})()`);
      await nav(browser, '算法'); await nav(browser, '采集源');
      await browser.until('window.__catalogFailures>0', '503 injection was not reached');
      await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await stored(browser), 'synthetic-selection-a');
      assert.equal(await browser.evaluate("!!document.querySelector('.object-card[aria-current=true]')"), false, 'Incomplete catalogue must not select another object');
      assert.match(await browser.evaluate<string>("document.querySelector('.object-detail-title').textContent"), /正在读取/u);
      assert.match(await browser.evaluate<string>("document.querySelector('.object-detail-notices').textContent"), /自定义来源目录暂时无法读取/u);
      await browser.evaluate("window.__catalogMode='normal'"); await nav(browser, '算法'); await nav(browser, '采集源');
      await browser.until("[...document.querySelectorAll('.object-card[aria-current=true]')].some(e=>e.textContent.includes('Synthetic selection A'))", 'Recovery lost stored selection');
      await verifyCompactDetails(browser, 'capture');
      await browser.evaluate("document.querySelector('.object-detail-diagnostics > summary').click()");
      await browser.until("document.querySelector('.object-detail-diagnostics').open===true", 'Diagnostics must open before object switch');
      await capture(browser, visuals, 'compact-capture-diagnostics-zh', 390, 'light', true);
      await card(browser, 'Synthetic selection B');
      assert.equal(await browser.evaluate("document.querySelector('.object-detail-diagnostics').open"), false, 'New selected object resets native diagnostics');
      await card(browser, 'Synthetic selection A');
      await capture(browser, visuals, 'selection-capture-light', 1440, 'light');
      await capture(browser, visuals, 'compact-capture-zh-dark', 390, 'dark');
      await browser.evaluate("window.__catalogMode='hold'"); await nav(browser, '算法'); await nav(browser, '采集源');
      await browser.until('window.__catalogWaiting===true', 'Delayed real catalogue reply not reached');
      assert.equal(await stored(browser), 'synthetic-selection-a');
      await nav(browser, '算法'); await browser.evaluate("window.__catalogMode='normal'"); await nav(browser, '采集源');
      await card(browser, 'Synthetic selection B'); await browser.evaluate('window.__catalogRelease()');
      await browser.until('window.__catalogReleased===true', 'Delayed catalogue not released');
      assert.equal(await stored(browser), 'synthetic-selection-b', 'Unmounted late reply cannot restore earlier selection');
      // Actual isolated registry-file deletion models an external catalogue update.
      // There is no production delete API; this does not claim a user-facing delete action.
      const document = JSON.parse(readFileSync(host.registry.path, 'utf8'));
      document.sources = document.sources.filter((item: { id: string }) => item.id !== 'synthetic-selection-b'); document.revision++;
      writeFileSync(host.registry.path, JSON.stringify(document));
      await nav(browser, '算法'); await nav(browser, '采集源');
      await browser.until("sessionStorage.getItem('xuan.capture.object')===null", 'Successful complete catalogue must clear actually missing object');
      await card(browser, 'Synthetic selection A');
      await nav(browser, '算法');
      await browser.until("document.querySelectorAll('.object-card').length>0", 'Real tools catalogue unavailable');
      const toolTitle = await browser.evaluate<string>("[...document.querySelectorAll('.object-card-title')].at(-1).textContent");
      await card(browser, toolTitle); const toolId = await browser.evaluate<string>("sessionStorage.getItem('xuan.tools.object')"); assert.ok(toolId);
      await verifyCompactDetails(browser, 'tools');
      await capture(browser, visuals, 'compact-tools-zh-light', 390, 'light');
      await fill(browser, '.data-nav input[type=search]', 'unmatched-synthetic-algorithm');
      assert.equal(await browser.evaluate("sessionStorage.getItem('xuan.tools.object')"), toolId);
      await nav(browser, '接口源');
      await browser.until("document.querySelectorAll('.object-card').length>1", 'Actual API source catalogue unavailable');
      const apiTitle = await browser.evaluate<string>("[...document.querySelectorAll('.object-card-title')].at(-1).textContent"); await card(browser, apiTitle);
      await verifyCompactDetails(browser, 'api');
      await capture(browser, visuals, 'compact-api-zh-light', 390, 'light');
      const apiSelections = await browser.evaluate<Record<string, string>>("Object.fromEntries(Object.keys(sessionStorage).filter(k=>k.startsWith('xuan.api-sources.object:')).map(k=>[k,sessionStorage.getItem(k)]))");
      assert.ok(Object.keys(apiSelections).length);
      await fill(browser, '.data-nav input[type=search]', 'unmatched-synthetic-market');
      assert.match(await browser.evaluate<string>("document.body.textContent"), new RegExp(apiTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await fill(browser, '.data-nav input[type=search]', '');
      const currentMarket = await browser.evaluate<string>("document.querySelector('.data-nav .data-nav-item[aria-current=true]').textContent");
      const otherMarket = await browser.evaluate<string>("[...document.querySelectorAll('.data-nav .data-nav-item:not(.is-group)')].find(e=>e.getAttribute('aria-current')!=='true').textContent");
      await browser.evaluate(`([...document.querySelectorAll('.data-nav .data-nav-item')].find(e=>e.textContent===${q(otherMarket)})).click()`);
      await card(browser, '当前市场总览');
      await browser.evaluate(`([...document.querySelectorAll('.data-nav .data-nav-item')].find(e=>e.textContent===${q(currentMarket)})).click()`);
      await browser.until(`[...document.querySelectorAll('.object-card[aria-current=true]')].some(e=>e.querySelector('.object-card-title')?.textContent===${q(apiTitle)})`, 'Market switch lost per-market source selection');
      await nav(browser, '采集源'); assert.equal(await stored(browser), 'synthetic-selection-a');
      await nav(browser, '算法'); assert.equal(await browser.evaluate("sessionStorage.getItem('xuan.tools.object')"), toolId);
      await nav(browser, '接口源');
      for (const [key, value] of Object.entries(apiSelections)) assert.equal(await browser.evaluate(`sessionStorage.getItem(${q(key)})`), value);
      await capture(browser, visuals, 'selection-api-dark-narrow', 390, 'dark');
      await browser.page('Page.reload'); await nav(browser, '采集源');
      await browser.until("[...document.querySelectorAll('.object-card[aria-current=true]')].some(e=>e.textContent.includes('Synthetic selection A'))", 'Refresh did not restore selected source');
      await nav(browser, '会话');
      await browser.until(`document.querySelector('textarea.composer-input')?.value===${q(draftText)}`, 'Shared conversation draft was not restored in the actual UI');
      const current = host.core.getState(); assert.equal(current.conversationId, initial.conversationId); assert.equal(current.branchId, initial.branchId);
      assert.deepEqual(current.messages, initial.messages, 'Selection does not create or replace history');
      assert.equal(host.core.getDraft(initial.conversationId, 'main', '', initial.branchId).text, draftText);
      assert.deepEqual(host.workspaceServices.tasks.list(), workspaceTasks);
      assert.deepEqual(host.workspaceServices.sourceSettings.get(), workspaceSettings);
      assert.deepEqual(host.services.tasks.list(), tasks); assert.deepEqual(host.services.sourceSettings.get(), settings);
      assert.equal(browser.requests.filter(r => r.method !== 'GET' && /\/api\/(tasks|ui\/source-settings|capture-sources)/u.test(new URL(r.url).pathname)).length, 0);
      writeFileSync(join(root, 'selection-verification.json'), JSON.stringify({ conversationId: current.conversationId, branchId: current.branchId,
        draft: draftText, historyCount: current.messages.length, taskCount: tasks.length, scope: 'Real isolated registry and host; 503/delay transport faults; external fixture-only deletion; no credentials or model calls.' }, null, 2));
      await browser.evaluate(`(async()=>{const session=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));if(!Number.isSafeInteger(session?.generation))throw Error('Missing actual local session');const headers={'x-local-data-generation':String(session.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const p=await (await fetch('/api/ui/preferences',{headers})).json();const r=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en'})});if(!r.ok)throw Error('Preference update failed');})()`);
      await browser.page('Page.reload'); await nav(browser, 'Capture sources');
      await browser.until("[...document.querySelectorAll('.object-card[aria-current=true]')].some(e=>e.textContent.includes('Synthetic selection A'))", 'English refresh lost selection');
      await verifyCompactDetails(browser, 'capture', true);
      await capture(browser, visuals, 'selection-capture-en', 1440, 'light');
      await capture(browser, visuals, 'compact-capture-en-light', 390, 'light');
      await nav(browser, 'Algorithms');
      await browser.until("!!document.querySelector('.object-card[aria-current=true]')", 'Selected algorithm not restored');
      await verifyCompactDetails(browser, 'tools', true);
      await capture(browser, visuals, 'compact-tools-en-dark', 390, 'dark');
      await nav(browser, 'API sources');
      await browser.until("!!document.querySelector('.object-card[aria-current=true]')", 'Selected API source not restored');
      await verifyCompactDetails(browser, 'api', true);
      await capture(browser, visuals, 'compact-api-en-dark', 390, 'dark');
      assert.equal(host.core.getState().conversationId, initial.conversationId);
      assert.equal(host.core.getState().branchId, initial.branchId);
      assert.deepEqual(host.services.tasks.list(), tasks);
      assert.deepEqual(host.workspaceServices.tasks.list(), workspaceTasks);
      assert.equal(browser.blockedRequests.length, 0);
    } finally { await browser?.close(); await host.close(); }
  });

test('object selection HTTP fixture uses real registered catalogue and private conversation storage',
  { skip: !parent || !webRoot, timeout: 30000 }, async () => {
    const root = realpathSync(mkdtempSync(join(parent!, 'sel-http-'))), host = await hostFixture(root);
    try {
      const headers = { 'x-local-data-generation': '1', 'x-mashiro-client': 'web' };
      const response = await fetch(host.url + 'api/ui/custom-sources', { headers }); assert.equal(response.status, 200);
      const value = await response.json(); assert.deepEqual(value.sources.map((s: { id: string }) => s.id), ['synthetic-selection-a', 'synthetic-selection-b']);
      const toolsResponse = await fetch(host.url + 'api/ui/tool-library', { headers }); assert.equal(toolsResponse.status, 200);
      const tools = await toolsResponse.json(); assert.ok(Array.isArray(tools.tools) && tools.tools.length > 0);
      assert.ok(tools.tools.every((tool: { id?: string; title?: string }) => typeof tool.id === 'string' && typeof tool.title === 'string'));
      const sourcesResponse = await fetch(host.url + 'api/ui/source-settings', { headers }); assert.equal(sourcesResponse.status, 200);
      const sources = await sourcesResponse.json(); assert.ok(Array.isArray(sources.connections) && sources.connections.length > 0);
      assert.ok(Array.isArray(sources.apiPlugins)); assert.ok(Array.isArray(sources.capturePlugins));
      assert.equal(host.workspaceServices.tasks.list().length, 0);
      const stateResponse = await fetch(host.url + 'api/conversation', { headers }); assert.equal(stateResponse.status, 200);
      const state = await stateResponse.json(); assert.equal(state.conversationId, host.core.getState().conversationId);
      const draftResponse = await fetch(host.url + `api/conversations/${state.conversationId}/draft`, { headers }); assert.equal(draftResponse.status, 200);
      assert.equal(host.services.tasks.list().length, 0);
    } finally { await host.close(); }
  });
