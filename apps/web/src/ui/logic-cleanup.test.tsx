import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { parseHTML } from 'linkedom';
import { useAlgorithmResult } from './useAlgorithmResult.js';
import { resolveObjectSelection, useObjectSelection } from './useStoredSelection.js';
import { readAlgorithmCall, listAlgorithmCalls } from '../algorithm-api.js';

function browser() {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const storage = new Map<string, string>();
  const values = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  const sessionStorage = { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: sessionStorage });
  return { document, storage, cleanup() {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}
function task(taskId: string, methodId: string) {
  return { taskId, methodId, requestId: 'request-' + taskId, status: 'succeeded', taskVersion: 1,
    result: null, error: null, requiresReview: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('统一对象选择在所有目录就绪前既不清除已存选择，也不默认选第一项', async () => {
  assert.deepEqual(resolveObjectSelection('fixed:macro_yoy', ['library:ma'], false, 'first'), { id: null, pending: true });
  assert.equal(resolveObjectSelection(null, ['library:ma'], false, 'first').id, null);
  assert.equal(resolveObjectSelection('fixed:macro_yoy', ['library:ma', 'fixed:macro_yoy'], true, 'first').id, 'fixed:macro_yoy');
  assert.equal(resolveObjectSelection('removed', ['library:ma'], true, 'first').id, 'library:ma');
  assert.equal(resolveObjectSelection('removed', ['library:ma'], true).id, null);
  const env = browser();
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(env.document.getElementById('root')!);
  const key = 'isolated.selection'; env.storage.set(key, 'fixed:macro_yoy');
  let selection!: ReturnType<typeof useObjectSelection>;
  function Harness({ ids, ready }: { ids: string[]; ready: boolean }) {
    selection = useObjectSelection(key, ids, ready, 'first');
    return <span>{selection.pending ? 'pending' : selection.id}</span>;
  }
  try {
    await act(() => root.render(<Harness ids={['library:ma']} ready={false} />));
    assert.equal(env.storage.get(key), 'fixed:macro_yoy');
    assert.equal(selection.pending, true);
    await act(() => root.render(<Harness ids={['library:ma', 'fixed:macro_yoy']} ready />));
    assert.equal(selection.id, 'fixed:macro_yoy');
    await act(() => root.render(<Harness ids={['library:ma']} ready />));
    assert.equal(selection.id, 'library:ma');
    assert.equal(env.storage.get(key), 'library:ma');
  } finally { await act(() => root.unmount()); env.cleanup(); }
});

test('两处算法详情共用的结果读取拒绝迟到成功、迟到错误及往返选择的旧回执', async () => {
  const env = browser(), previousFetch = globalThis.fetch;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(env.document.getElementById('root')!);
  const pending: Array<{ path: string; resolve(value: Response): void }> = [];
  globalThis.fetch = (input) => new Promise<Response>(resolve => pending.push({ path: String(input), resolve }));
  let result!: ReturnType<typeof useAlgorithmResult>;
  function Harness({ scope }: { scope: string }) { result = useAlgorithmResult(scope); return <span>{result.task?.taskId}</span>; }
  try {
    await act(() => root.render(<Harness scope="ma" />));
    let first!: Promise<void>, second!: Promise<void>;
    await act(() => { first = result.loadLatest('ma'); });
    assert.match(pending[0]!.path, /methodId=ma$/u);
    await act(() => root.render(<Harness scope="macd" />));
    await act(() => { second = result.loadLatest('macd'); });
    await act(async () => { pending[1]!.resolve(reply({ items: [task('macd-new', 'macd')] })); await second; });
    assert.equal(result.task?.taskId, 'macd-new');
    await act(async () => { pending[0]!.resolve(reply({ items: [task('ma-old', 'ma')] })); await first; });
    assert.equal(result.task?.taskId, 'macd-new');

    // Same-scope newer requests supersede older failures; task identity is checked in the shared API.
    await act(() => { first = result.loadTask('old-task', 'macd'); });
    await act(() => { second = result.loadTask('new-task', 'macd'); });
    await act(async () => { pending[3]!.resolve(reply(task('new-task', 'macd'))); await second; });
    await act(async () => { pending[2]!.resolve(new Response(JSON.stringify({ error: 'late failure' }), { status: 500 })); await first; });
    assert.equal(result.task?.taskId, 'new-task'); assert.equal(result.error, null);

    await act(() => { first = result.loadLatest('macd'); });
    await act(() => root.render(<Harness scope="ma" />));
    await act(() => root.render(<Harness scope="macd" />));
    assert.equal(result.task, null, 'A→B→A cannot revive an old selection generation');
    await act(async () => { pending[4]!.resolve(reply({ items: [task('stale-after-return', 'macd')] })); await first; });
    assert.equal(result.task, null);
    await act(() => { second = result.loadTask('expected', 'macd'); });
    await act(async () => { pending[5]!.resolve(reply(task('other-task', 'macd'))); await second; });
    assert.match(result.error ?? '', /身份不符/u);
    assert.equal(result.task, null);

    await act(() => { first = result.loadLatest('macd'); });
    await act(() => root.unmount());
    pending[6]!.resolve(reply({ items: [task('after-unmount', 'macd')] })); await first;
  } finally { globalThis.fetch = previousFetch; await act(() => root.unmount()); env.cleanup(); }
});

test('算法 API 同时核对列表方法和详情任务身份，不在客户端静默过滤伪装正确结果', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => reply({ items: [task('wrong-method', 'macd')] });
    await assert.rejects(listAlgorithmCalls('ma'), /其他方法/u);
    globalThis.fetch = async () => reply(task('unexpected', 'ma'));
    await assert.rejects(readAlgorithmCall('wanted', 'ma'), /身份不符/u);
    globalThis.fetch = async () => reply(task('wanted', 'macd'));
    await assert.rejects(readAlgorithmCall('wanted', 'ma'), /身份不符/u);
  } finally { globalThis.fetch = previousFetch; }
});
