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
    return { PreferencesProvider, ToolsPage };
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
