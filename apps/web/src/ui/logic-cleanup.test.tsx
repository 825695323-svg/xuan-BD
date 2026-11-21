import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { act } from 'react';
import { parseHTML } from 'linkedom';
import { resolveObjectSelection, useObjectSelection } from './useStoredSelection.js';

function browser() {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const storage = new Map<string, string>();
  const values = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: sessionStorage });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  }) });
  return { document, storage, cleanup() {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const preferences = { revision: 1, theme: 'light', language: 'zh-CN', fontScale: 1,
  sendShortcut: 'enter', modelId: null, thinkingLevel: 'high', updatedAt: '' };

async function loadPageComponents() {
  const hooks = registerHooks({ load(url, context, nextLoad) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  } });
  try {
    const { PreferencesProvider } = await import('./Preferences.js');
    const { ToolsPage } = await import('./ToolsPage.js');
    const { CaptureSourcesPage } = await import('./CaptureSourcesPage.js');
    return { PreferencesProvider, ToolsPage, CaptureSourcesPage };
  } finally { hooks.deregister(); }
}

test('算法目录读取失败后保留原选择，重试后定位到唯一已登记算法', async () => {
  const { PreferencesProvider, ToolsPage } = await loadPageComponents();
  const env = browser(), previousFetch = globalThis.fetch;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(env.document.getElementById('root')!);
  const key = 'xuan.tools.object';
  env.storage.set(key, 'removed');
  let catalogAvailable = false;
  const requests: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requests.push(url);
    if (url === '/api/ui/preferences') return reply(preferences);
    if (url !== '/api/ui/tool-library') throw new Error(`Unexpected request ${url}`);
    if (!catalogAvailable) return new Response(JSON.stringify({ error: '暂时无法读取' }), { status: 503 });
    return reply({ status: 'unavailable', reason: '受控实现未装配', tools: [{ id: 'macd', title: 'MACD · 固定 12/26/9',
      description: '本页显示后端登记的 MACD 方法。', status: 'blocked', reason: '受控实现未装配',
      parameters: [], outputFields: [], limitations: [] }] });
  };
  try {
    await act(() => root.render(<PreferencesProvider><ToolsPage /></PreferencesProvider>));
    assert.match(env.document.querySelector('[role="alert"]')?.textContent ?? '', /算法目录读取失败/u);
    assert.equal(env.storage.get(key), 'removed');
    assert.equal(env.document.querySelector('.object-card'), null);
    const refresh = env.document.querySelector<HTMLButtonElement>('.object-detail-head button');
    assert.ok(refresh);
    catalogAvailable = true;
    await act(() => refresh.click());
    assert.equal(env.document.querySelectorAll('.object-card').length, 1);
    assert.match(env.document.querySelector('.object-card[aria-current="true"]')?.textContent ?? '', /MACD.*受阻/u);
    assert.match(env.document.querySelector('.object-detail-content')?.textContent ?? '', /受控实现未装配/u);
    assert.equal(env.storage.get(key), 'macd');
    assert.deepEqual(requests.filter(url => url !== '/api/ui/preferences'), ['/api/ui/tool-library', '/api/ui/tool-library']);
  } finally { await act(() => root.unmount()); globalThis.fetch = previousFetch; env.cleanup(); }
});

test('统一对象选择在所有目录就绪前既不清除已存选择，也不默认选第一项', async () => {
  assert.deepEqual(resolveObjectSelection('source:b', ['source:a'], false, 'first'), { id: null, pending: true });
  assert.equal(resolveObjectSelection(null, ['source:a'], false, 'first').id, null);
  assert.equal(resolveObjectSelection('source:b', ['source:a', 'source:b'], true, 'first').id, 'source:b');
  assert.equal(resolveObjectSelection('removed', ['source:a'], true, 'first').id, 'source:a');
  assert.equal(resolveObjectSelection('removed', ['source:a'], true).id, null);
  const env = browser();
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(env.document.getElementById('root')!);
  const key = 'isolated.selection'; env.storage.set(key, 'source:b');
  let selection!: ReturnType<typeof useObjectSelection>;
  function Harness({ ids, ready }: { ids: string[]; ready: boolean }) {
    selection = useObjectSelection(key, ids, ready, 'first');
    return <span>{selection.pending ? 'pending' : selection.id}</span>;
  }
  try {
    await act(() => root.render(<Harness ids={['source:a']} ready={false} />));
    assert.equal(env.storage.get(key), 'source:b');
    assert.equal(selection.pending, true);
    await act(() => root.render(<Harness ids={['source:a', 'source:b']} ready />));
    assert.equal(selection.id, 'source:b');
    await act(() => root.render(<Harness ids={['source:a']} ready />));
    assert.equal(selection.id, 'source:a');
    assert.equal(env.storage.get(key), 'source:a');
  } finally { await act(() => root.unmount()); env.cleanup(); }
});


test('采集源自定义目录临时失败不是删除，恢复后仅完整成功目录可清选择', async () => {
  const { PreferencesProvider, CaptureSourcesPage } = await loadPageComponents();
  const env = browser(), previousFetch = globalThis.fetch;
  const originalInterval = window.setInterval, originalClear = window.clearInterval;
  let refresh: (() => void) | undefined;
  window.setInterval = ((callback: () => void) => { refresh = callback; return 1; }) as typeof window.setInterval;
  window.clearInterval = (() => {}) as typeof window.clearInterval;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(env.document.getElementById('root')!);
  const key = 'xuan.capture.object'; env.storage.set(key, 'custom:fixture');
  let mode: 'failure' | 'present' | 'deleted' | 'delayed' | 'invalid' = 'failure';
  let finishDelayed: ((response: Response) => void) | undefined;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url === '/api/ui/preferences') return reply(preferences);
    if (url === '/api/ui/source-settings') return reply({ capturePlugins: [{ sourceId: 'builtin', label: 'Builtin fixture', available: false }], capture: [], checks: [] });
    if (url === '/api/capture-sources') return reply({ sources: [] });
    if (url === '/api/skills') return reply([]);
    assert.equal(url, '/api/ui/custom-sources');
    if (mode === 'delayed') return new Promise<Response>(resolve => { finishDelayed = resolve; });
    if (mode === 'invalid') return reply({});
    return mode === 'failure' ? new Response('{}', { status: 503 }) : reply({ sources: mode === 'deleted' ? [] : [{ id: 'custom:fixture', label: 'Custom fixture', domain: 'example.invalid', operations: [], cookieNames: [] }] });
  };
  try {
    await act(() => root.render(<PreferencesProvider><CaptureSourcesPage /></PreferencesProvider>));
    assert.equal(env.storage.get(key), 'custom:fixture', '503 must not erase the stored source');
    assert.match(env.document.querySelector('.object-detail-head')?.textContent ?? '', /正在读取/u);
    mode = 'present'; await act(() => refresh!());
    assert.match(env.document.querySelector('.object-detail-head')?.textContent ?? '', /Custom fixture/u);
    mode = 'failure'; await act(() => refresh!());
    assert.equal(env.storage.get(key), 'custom:fixture');
    mode = 'present'; await act(() => refresh!());
    assert.match(env.document.querySelector('.object-card[aria-current="true"]')?.textContent ?? '', /Custom fixture/u);
    mode = 'delayed'; await act(() => refresh!());
    mode = 'present'; await act(() => refresh!());
    await act(() => finishDelayed!(reply({ sources: [] })));
    assert.equal(env.storage.get(key), 'custom:fixture', 'Older empty response cannot erase the newer confirmed object');
    mode = 'invalid'; await act(() => refresh!());
    assert.equal(env.storage.get(key), 'custom:fixture', 'Malformed success is not a complete empty catalog');
    assert.match(env.document.querySelector('[role="alert"]')?.textContent ?? '', /自定义来源目录暂时无法读取/u);
    mode = 'deleted'; await act(() => refresh!());
    assert.equal(env.storage.has(key), false);
    assert.match(env.document.querySelector('.object-detail-head')?.textContent ?? '', /未选择来源/u);
  } finally {
    await act(() => root.unmount()); globalThis.fetch = previousFetch;
    window.setInterval = originalInterval; window.clearInterval = originalClear; env.cleanup();
  }
});

test('算法紧凑详情区分登记参数、关联定义与真实执行，当前阻断不折叠', async () => {
  const { PreferencesProvider, ToolsPage } = await loadPageComponents();
  const env = browser(), previousFetch = globalThis.fetch;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(env.document.getElementById('root')!);
  const { ALGORITHM_REGISTRY } = await import('../../../../modules/financial/algorithm-registry.js');
  const { definitionFor } = await import('../../../../modules/financial/algorithm-definitions.js');
  let invalid = false;
  globalThis.fetch = async input => {
    if (String(input) === '/api/ui/preferences') return reply(preferences);
    assert.equal(String(input), '/api/ui/tool-library');
    return reply({ status: 'ready', reason: null, tools: [{ ...ALGORITHM_REGISTRY[0], status: 'blocked',
      reason: 'Synthetic missing input', missing: ['Synthetic fixed snapshot required'],
      parameters: invalid ? [{ key: 'short_period', label: '短周期', defaultValue: '12' }] : ALGORITHM_REGISTRY[0]!.parameters,
      definition: definitionFor('macd') }] });
  };
  try {
    await act(() => root.render(<PreferencesProvider><ToolsPage /></PreferencesProvider>));
    assert.deepEqual([...env.document.querySelectorAll('.object-detail-content > .object-detail-section h3')].map(e => e.textContent),
      ['算法定义', '计算配置', '关联产物', '准入与执行状态']);
    const diagnostics = env.document.querySelector('details.object-detail-diagnostics')!;
    assert.equal(diagnostics.hasAttribute('open'), false);
    assert.match(diagnostics.textContent ?? '', /DIFF_t/u);
    assert.match(env.document.querySelector('.object-detail-content')?.textContent ?? '', /固定 12.*固定 26.*固定 9/u);
    assert.match(env.document.querySelector('.object-detail-content')?.textContent ?? '', /本页未读取执行回执/u);
    assert.equal(env.document.querySelector('.object-detail-blockers')?.closest('details'), null);
    assert.match(env.document.querySelector('.object-detail-blockers')?.textContent ?? '', /Synthetic fixed snapshot required/u);
    assert.match(env.document.querySelector('.object-detail-content')?.textContent ?? '', /Synthetic missing input/u);
    invalid = true;
    await act(() => env.document.querySelector<HTMLButtonElement>('.object-detail-head button')!.click());
    assert.match(env.document.querySelector('[role="alert"]')?.textContent ?? '', /算法目录读取失败/u);
    assert.equal(env.document.querySelector('.object-detail-content > .object-detail-section'), null);
  } finally { await act(() => root.unmount()); globalThis.fetch = previousFetch; env.cleanup(); }
});

test('统一算法目录展示 20 项并按三类筛选，查看详情与刷新只发送 GET', async () => {
  const { PreferencesProvider, ToolsPage } = await loadPageComponents();
  const { ToolLibraryService } = await import('../../../../modules/financial/tool-library.js');
  const { createRoot } = await import('react-dom/client');
  const full = new ToolLibraryService({ hasWfdReader: () => true }).view();
  for (const [language, theme, labels] of [
    ['zh-CN', 'light', ['全部算法', '行情', '财务', '复权']],
    ['en', 'dark', ['All algorithms', 'Market', 'Financial', 'Adjustment']],
  ] as const) {
    const env = browser(), previous = globalThis.fetch, calls: string[] = [];
    const root = createRoot(env.document.getElementById('root')!);
    globalThis.fetch = async (input, init) => {
      assert.equal(init?.method ?? 'GET', 'GET');
      const url = String(input); calls.push(url);
      if (url === '/api/ui/preferences') return reply({ ...preferences, language, theme });
      assert.equal(url, '/api/ui/tool-library');
      return reply(full);
    };
    try {
      await act(() => root.render(<PreferencesProvider><ToolsPage /></PreferencesProvider>));
      assert.equal(env.document.documentElement.dataset.theme, theme);
      const cards = () => [...env.document.querySelectorAll<HTMLButtonElement>('.object-card')];
      const filters = [...env.document.querySelectorAll<HTMLButtonElement>('.data-nav-item')];
      assert.deepEqual(filters.map(el => el.textContent), labels);
      assert.equal(cards().length, 20); assert.equal(env.document.querySelector('[role="alert"]'), null);
      for (const [index, count] of [[1, 15], [2, 4], [3, 1], [0, 20]]) {
        await act(() => filters[index]!.click());
        assert.equal(filters[index].getAttribute('aria-current'), 'true');
        assert.equal(cards().length, count);
        assert.ok(index === 0 || cards().every(el => el.textContent?.includes(labels[index])));
        await act(() => cards()[0].click());
        assert.equal(cards()[0].getAttribute('aria-current'), 'true');
        const detail = env.document.querySelector('.object-detail-content')!.textContent ?? '';
        assert.match(detail, /algorithms\.capabilities/u); assert.match(detail, /algorithms\.calculate/u);
        if (index === 3) {
          assert.match(detail, /forward_qfq/u);
          assert.match(env.document.querySelector('details')?.textContent ?? '', /adj_factor/u);
          assert.match(env.document.body.textContent ?? '', /TypeScript/u);
        }
      }
      assert.doesNotMatch(env.document.body.textContent ?? '', /Invalid tool-library response/u);
      await act(() => env.document.querySelector<HTMLButtonElement>('.object-detail-head button')!.click());
      assert.deepEqual(calls.filter(url => url !== '/api/ui/preferences'), ['/api/ui/tool-library', '/api/ui/tool-library']);
    } finally { await act(() => root.unmount()); globalThis.fetch = previous; env.cleanup(); }
  }
});
