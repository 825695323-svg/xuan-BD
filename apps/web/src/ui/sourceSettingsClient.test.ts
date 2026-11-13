import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forgetLocalDataSession, localDataGeneration, setLocalDataSession } from '../local-data-context.js';
import { loadSourceSettings, sourceSettingsOperation } from './sourceSettingsClient.js';

/** 用本地内存模拟网络；没有服务端、浏览器账号或实际资料可被触及。 */
function withSession(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  } });
  setLocalDataSession('test-data', 1);
  return () => {
    forgetLocalDataSession();
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  };
}

test('来源设置拒绝使用旧请求错误撤销新代次', async () => {
  const cleanup = withSession(), previousFetch = globalThis.fetch;
  try {
    let resolveResponse!: (value: Response) => void;
    globalThis.fetch = async () => await new Promise<Response>(resolve => { resolveResponse = resolve; });
    const pending = loadSourceSettings();
    setLocalDataSession('new-data', 2);
    resolveResponse(new Response(JSON.stringify({ code: 'STALE_LOCAL_DATA_GENERATION', error: '旧代次' }), { status: 409 }));
    await assert.rejects(pending, (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'STALE_LOCAL_DATA_GENERATION');
    assert.equal(localDataGeneration(), 2, '迟到回执不能清空新资料会话');
  } finally { globalThis.fetch = previousFetch; cleanup(); }
});

test('来源设置通过统一请求发送代次，回执404视为原操作不存在', async () => {
  const cleanup = withSession(), previousFetch = globalThis.fetch;
  try {
    const paths: string[] = [], generations: string[] = [];
    globalThis.fetch = async (input, init) => {
      paths.push(String(input));
      generations.push(new Headers(init?.headers).get('x-local-data-generation') ?? '');
      return new Response(JSON.stringify(paths.length === 1
        ? { revision: 1, operationPolicies: [], connections: [], policies: [], plugins: [], capture: [] }
        : { code: 'SOURCE_SETTINGS_OPERATION_NOT_FOUND', error: '不存在' }),
      { status: paths.length === 1 ? 200 : 404 });
    };
    const current = await loadSourceSettings();
    assert.equal(current.revision, 1);
    assert.equal(await sourceSettingsOperation('missing-operation'), null);
    assert.deepEqual(generations, ['1', '1']);
    assert.deepEqual(paths, ['/api/ui/source-settings', '/api/ui/source-settings/operations/missing-operation']);
  } finally { globalThis.fetch = previousFetch; cleanup(); }
});
