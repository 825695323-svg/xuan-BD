import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Vite 仅服务视觉夹具；Chrome 截图、几何核对和原始报告均写临时目录，不进入源码仓库。 */
const port = 4329, host = '127.0.0.1', origin = `http://${host}:${port}`;
const out = join(process.env.RUNNER_TEMP ?? tmpdir(), 'xuan-bd-ui-visual');
mkdirSync(out, { recursive: true });
const chrome = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/opt/google/chrome/chrome'].find(path => path && existsSync(path));
if (!chrome) throw new Error('VISUAL_BROWSER_MISSING: 找不到可执行的 Chrome/Chromium；不得把截图检查跳过视为通过。');

const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.config.ts',
  '--configLoader', 'runner', '--host', host, '--port', String(port), '--strictPort'],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
let viteLog = '';
for (const pipe of [vite.stdout, vite.stderr]) pipe.on('data', chunk => { viteLog += String(chunk).slice(-2000); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready() {
  for (let i = 0; i < 80; i++) {
    if (vite.exitCode !== null) throw new Error('Vite fixture server failed: ' + viteLog);
    try {
      const response = await fetch(origin + '/visual-audit.html');
      if (response.ok) return;
    } catch { /* 初始化中，继续本机连接核对。 */ }
    await sleep(250);
  }
  throw new Error('Vite fixture server did not become ready: ' + viteLog);
}
const visible = rect => !!rect && rect.display !== 'none' && rect.width >= 1 && rect.height >= 1;
const within = (child, parent, name, slack = 4) => {
  assert.ok(child.x >= parent.x - slack && child.right <= parent.right + slack,
    `${name} 水平越界：${JSON.stringify({ child, parent })}`);
};
const inViewport = (rect, width, height, name) => {
  assert.ok(rect.x >= -3 && rect.y >= -3 && rect.right <= width + 3 && rect.bottom <= height + 3,
    `${name} 浮层超出视口：${JSON.stringify(rect)} viewport=${width}x${height}`);
};
function verify(data) {
  const { nodes: n, viewport, view } = data, requireNode = (key) => {
    assert.ok(visible(n[key]), `${key} 位置不可见 ${JSON.stringify(n[key])}`); return n[key];
  };
  const main = requireNode('main'), nav = requireNode('nav'), cards = requireNode('cards'),
    detail = requireNode('detail');
  for (const [key, rect] of [['nav', nav], ['cards', cards], ['detail', detail]]) within(rect, main, key);
  if (main.width <= 810) {
    assert.ok(nav.bottom <= cards.y + 4 && cards.bottom <= detail.y + 4,
      '窄内容区须按目录→列表→详情纵向排布');
  } else {
    assert.ok(nav.right <= cards.x + 4 && cards.right <= detail.x + 4,
      '桌面内容区须按三栏顺序排布');
  }
  assert.ok(n.metadata.font >= 12 && n.state.font >= 12 && n.hint.font >= 12,
    `信息字号不足 12px：${JSON.stringify({ meta: n.metadata.font, state: n.state.font, hint: n.hint.font })}`);
  assert.ok(n.heading.font >= 15 && n.action.height >= 34, '标题或主要按钮尺寸低于共用规范');
  assert.equal(data.rootFont, 15, '默认视觉字体须与应用运行时基线一致');
  if (viewport.width <= 1180) {
    const button = requireNode('agentFloat');
    inViewport(button, viewport.width, viewport.height, 'Agent 停靠入口');
    assert.ok(button.width >= 36 && button.height >= 36, 'Agent 入口触控尺寸不足');
    assert.ok(button.x >= main.right - 2, 'Agent 入口不应遮盖业务内容区');
    const search = requireNode('search');
    const overlaps = button.x < search.right && button.right > search.x
      && button.y < search.bottom && button.bottom > search.y;
    assert.ok(!overlaps, 'Agent 入口遮挡搜索框');
  } else requireNode('agent');
  if (view === 'modal') {
    const dialog = requireNode('dialog');
    inViewport(dialog, viewport.width, viewport.height, '运行对话框');
    assert.ok(dialog.scrollHeight > dialog.clientHeight, '长对话框应自身滚动而非裁切底部操作');
  } else {
    const dropdown = requireNode('dropdown');
    inViewport(dropdown, viewport.width, viewport.height, '来源筛选弹层');
    assert.ok(dropdown.width >= 150, '来源筛选弹层宽度不足');
  }
  return { theme: data.theme, view, viewport: viewport.width + 'x' + viewport.height,
    layout: main.width <= 810 ? 'vertical' : 'columns', font: n.metadata.font,
    overlay: view === 'modal' ? n.dialog : n.dropdown };
}
class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.counter = 0;
    socket.addEventListener('message', event => {
      let data;
      try { data = JSON.parse(String(event.data)); } catch { return; }
      const waiter = this.pending.get(data.id);
      if (!waiter) return;
      this.pending.delete(data.id);
      if (data.error) waiter.reject(new Error(JSON.stringify(data.error)));
      else waiter.resolve(data.result);
    });
  }
  async command(method, params = {}) {
    const id = ++this.counter;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}
async function connectDevTools(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome DevTools WebSocket connection timed out')), 10_000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Chrome DevTools WebSocket rejected')); }, { once: true });
  });
  return new DevTools(socket);
}
async function waitChrome(profile, process, diagnostic) {
  for (let i = 0; i < 80; i++) {
    if (process.exitCode !== null) throw new Error('Chrome stopped before DevTools started: ' + diagnostic());
    const portFile = join(profile, 'DevToolsActivePort');
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      if (port > 0) return port;
    }
    await sleep(250);
  }
  throw new Error('DevToolsActivePort not available: ' + diagnostic());
}
async function capture(devtools, width, height, theme, view) {
  const image = join(out, view + '-' + theme + '-' + width + '.png');
  const url = origin + '/visual-audit.html?theme=' + theme + '&view=' + view;
  await devtools.command('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 600, screenWidth: width, screenHeight: height,
  });
  await devtools.command('Page.navigate', { url });
  await sleep(500);
  let raw = '';
  for (let attempt = 0; attempt < 35; attempt++) {
    try {
      const response = await devtools.command('Runtime.evaluate', {
        expression: "document.getElementById('visual-report')?.textContent ?? ''",
        returnByValue: true,
      });
      raw = response?.result?.value ?? '';
      if (raw.startsWith('{')) break;
    } catch { /* Page navigation may have replaced the JS execution context. */ }
    await sleep(200);
  }
  assert.ok(raw.startsWith('{'), 'Browser fixture did not report geometry for ' + url);
  const data = JSON.parse(raw);
  assert.equal(data.viewport.width, width, 'Requested CSS viewport width was not used');
  assert.equal(data.viewport.height, height, 'Requested CSS viewport height was not used');
  const screenshot = await devtools.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  writeFileSync(image, Buffer.from(screenshot.data, 'base64'));
  writeFileSync(image.replace(/\.png$/u, '.json'), JSON.stringify(data, null, 2));
  const summary = verify(data);
  console.log('VISUAL_AUDIT_OK', JSON.stringify({ ...summary, screenshot: image }));
  return summary;
}

let devtools = null, browserProcess = null, browserProfile = null;
try {
  await ready();
  browserProfile = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'xuan-chrome-'));
  let browserLog = '';
  browserProcess = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--remote-allow-origins=*', '--disable-background-networking', '--no-first-run',
    '--user-data-dir=' + browserProfile, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [browserProcess.stdout, browserProcess.stderr])
    stream.on('data', chunk => { browserLog += String(chunk).slice(-2000); });
  const port = await waitChrome(browserProfile, browserProcess, () => browserLog.slice(-2000));
  const browserOrigin = 'http://127.0.0.1:' + port;
  const targetResponse = await fetch(browserOrigin + '/json/new?about:blank', { method: 'PUT' });
  assert.ok(targetResponse.ok, 'Cannot create Chrome DevTools page');
  const target = await targetResponse.json();
  devtools = await connectDevTools(target.webSocketDebuggerUrl);
  await devtools.command('Page.enable');
  await devtools.command('Runtime.enable');
  const results = [];
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 1280, 1024, 820, 390])
      results.push(await capture(devtools, width, width === 390 ? 844 : 900, theme, 'layout'));
    results.push(await capture(devtools, 390, 844, theme, 'modal'));
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('VISUAL_AUDIT_COMPLETE', results.length, 'real viewport screenshots and reports');
} finally {
  devtools?.close();
  browserProcess?.kill('SIGTERM');
  vite.kill('SIGTERM');
  if (browserProfile) try { rmSync(browserProfile, { recursive: true, force: true }); } catch { /* Chrome resources release on exit. */ }
}
