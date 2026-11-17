import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { act } from 'react';
import { parseHTML } from 'linkedom';
import { useConversationTasks, type ConversationTaskFeed } from './useConversationTasks.js';
import { clearLocalDataSession, setLocalDataSession } from './local-data-context.js';

// Explicit transport fault fixture; actual TaskService/HTTP/browser is tested separately.
test('task feed distinguishes failure/empty/stale and fences old GET, connections and revoked scopes', async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  class Source extends EventTarget {
    static all: Source[] = []; closed = false;
    constructor(readonly url: string) { super(); Source.all.push(this); }
    close() { this.closed = true; }
    emit(value: unknown) { this.dispatchEvent(new MessageEvent('tasks', { data: JSON.stringify(value) })); }
  }
  const pending: ((value: Response) => void)[] = [];
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true, EventSource: Source,
    fetch: () => new Promise<Response>(resolve => pending.push(resolve)) })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const response = (tasks: unknown, status = 200) => new Response(JSON.stringify(tasks), { status, headers: { 'Content-Type': 'application/json' } });
  const record = (sequence: number, conversationId = 'a') => ({ id: 'task', title: 'synthetic', conversationId, runtimeId: 'synthetic',
    status: sequence === 1 ? 'running' : 'succeeded', sequence, version: sequence, createdAt: 1 });
  let feed!: ConversationTaskFeed;
  const current = () => feed;
  function Probe({ id }: { id: string }) { feed = useConversationTasks(id); return <div>{current().status}</div>; }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    setLocalDataSession('synthetic', 1);
    await act(() => root.render(<Probe id="a" />));
    assert.equal(current().status, 'loading'); assert.equal(pending.length, 1);
    await act(async () => { pending.shift()!(response({ error: 'synthetic outage' }, 503)); });
    assert.equal(current().status, 'error'); assert.deepEqual(current().tasks, []);
    await act(() => Source.all[0].emit({ tasks: [] }));
    assert.equal(current().status, 'ready'); assert.deepEqual(current().tasks, []);
    await act(() => current().refresh());
    await act(() => Source.all[0].emit({ task: record(2) }));
    await act(async () => { pending.shift()!(response([record(1)])); });
    assert.equal(current().tasks[0].sequence, 2); assert.equal(current().status, 'ready');
    await act(() => Source.all[0].dispatchEvent(new Event('error')));
    assert.equal(current().status, 'stale'); assert.equal(current().tasks[0].sequence, 2);
    await act(() => current().refresh()); assert.equal(Source.all.length, 2); assert.ok(Source.all[0].closed);
    await act(() => Source.all[0].emit({ task: record(99) }));
    assert.equal(current().tasks[0].sequence, 2);
    await act(async () => { pending.shift()!(response([record(2)])); });
    assert.equal(current().status, 'stale'); // A GET is not proof that live updates resumed.
    await act(() => Source.all[1].emit({ tasks: [record(3)] }));
    assert.equal(current().status, 'ready'); assert.equal(current().tasks[0].sequence, 3);
    await act(() => Source.all[1].dispatchEvent(new MessageEvent('tasks', { data: '{invalid' })));
    assert.equal(current().status, 'stale');
    await act(() => Source.all[1].emit({ task: record(4) }));
    assert.equal(current().status, 'stale'); assert.equal(current().tasks[0].sequence, 4);
    await act(() => Source.all[1].emit({ tasks: [record(4)] }));
    assert.equal(current().status, 'ready');

    await act(() => current().refresh());
    await act(() => root.render(<Probe id="b" />));
    assert.deepEqual(current().tasks, []); assert.equal(current().status, 'loading');
    await act(async () => { pending.shift()!(response([record(100)])); });
    await act(() => Source.all[1].emit({ tasks: [record(101)] }));
    assert.deepEqual(current().tasks, []);
    await act(() => Source.all[2].emit({ tasks: [record(1, 'b')] }));
    assert.equal(current().tasks[0].conversationId, 'b');
    await act(() => clearLocalDataSession('synthetic revoke'));
    assert.deepEqual(current().tasks, []); assert.equal(current().status, 'idle'); assert.ok(Source.all[2].closed);
    await act(async () => { pending.shift()!(response([record(101, 'b')])); });
    assert.deepEqual(current().tasks, []);
    setLocalDataSession('synthetic', 2); await act(() => root.render(<Probe id="b" />));
    assert.equal(current().status, 'loading'); assert.deepEqual(current().tasks, []);
    await act(() => Source.all.at(-1)!.emit({ tasks: [] }));
    await act(async () => { pending.shift()!(response({ error: 'late failure' }, 503)); });
    assert.equal(current().status, 'ready');
  } finally {
    await act(() => root.unmount()); clearLocalDataSession('done');
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('task center groups recorded waiting, paused and interrupted states without claiming completion', async () => {
  const hooks = registerHooks({ load(url, context, nextLoad) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  } });
  const { taskCenterGroup } = await import('./ui/TaskCenter.js').finally(() => hooks.deregister());
  for (const status of ['ready', 'running', 'pausing', 'cancelling'] as const) assert.equal(taskCenterGroup(status), 'active');
  for (const status of ['waiting_approval', 'paused', 'interrupted', 'needs_review', 'blocked', 'awaiting_review'] as const) assert.equal(taskCenterGroup(status), 'attention');
  for (const status of ['succeeded', 'failed', 'cancelled'] as const) assert.equal(taskCenterGroup(status), 'finished');
});
