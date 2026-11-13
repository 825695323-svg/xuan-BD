import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  if (main.width <= 860) {
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
    inViewport(button, viewport.width, viewport.height, 'Agent 浮动入口');
    assert.ok(button.width >= 36 && button.height >= 36, 'Agent 浮动入口触控尺寸不足');
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
    layout: main.width <= 860 ? 'vertical' : 'columns', font: n.metadata.font,
    overlay: view === 'modal' ? n.dialog : n.dropdown };
}
function capture(width, height, theme, view) {
  const image = join(out, `${view}-${theme}-${width}.png`);
  const url = origin + `/visual-audit.html?theme=${theme}&view=${view}`;
  const args = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    '--virtual-time-budget=4800', '--run-all-compositor-stages-before-draw',
    `--screenshot=${image}`, '--dump-dom', url];
  const response = spawnSync(chrome, args, { encoding: 'utf8', timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(response.status, 0, `Chrome 运行失败：${response.error ?? response.stderr?.slice(-1000)}`);
  const match = /<pre id="visual-report"[^>]*>([^<]+)<\/pre>/u.exec(response.stdout);
  assert.ok(match, 'React 视觉夹具未生成浏览器几何报告：' + response.stdout.slice(-1200));
  const data = JSON.parse(match[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>'));
  const summary = verify(data);
  writeFileSync(image.replace(/\.png$/u, '.json'), JSON.stringify(data, null, 2));
  console.log('VISUAL_AUDIT_OK', JSON.stringify({ ...summary, screenshot: image }));
  return summary;
}
try {
  await ready();
  const results = [];
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 1280, 1024, 820, 390])
      results.push(capture(width, width === 390 ? 844 : 900, theme, 'layout'));
    results.push(capture(390, 844, theme, 'modal'));
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('VISUAL_AUDIT_COMPLETE', results.length, 'screenshots and reports');
} finally {
  vite.kill('SIGTERM');
}
