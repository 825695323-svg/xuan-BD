import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type ErrorRequestHandler, type Router } from 'express';
import { CoreDatabase } from '../../platform/state/database.js';
import { CoreError } from '../../platform/runtime/errors.js';
import { SourceSettingsService } from '../../platform/config/source-settings.js';
import { createSourceSettingsRouter } from './source-settings-routes.js';
import { sourceOperations, sourceOperationsForAction } from '../../plugins/api-sources/operations.js';
import { createSourceRuntime } from '../../plugins/api-sources/runtime.js';
import type { ApplicationServices } from './services.js';

async function serve(router: Router) {
  const app = express(); app.use(express.json()); app.use(router);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => res.status(error instanceof CoreError ? error.status : 500)
    .json({ code: error.code, error: error.message });
  app.use(errors);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { async call(path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  }, async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test('新旧来源请求仅格式不同，执行器、参数与工具选项均来自唯一目录', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'logic-source-routing-')), database = new CoreDatabase(':memory:');
  const settings = new SourceSettingsService(join(directory, 'sources.json'), database);
  const current = settings.get();
  settings.update({ ...current, connections: current.connections.map(item => item.pluginId === 'tdx' ? { ...item, enabled: true } : item) });
  const routed: Array<{ action: string; args: Record<string, unknown> }> = [];
  const accepted: Array<{ title: string; requestId: string }> = [];
  const services = { core: { healthy: true }, sourceSettings: settings,
    tasks: { create: (input: { title: string; requestId: string }) => {
      accepted.push(input); return { ...input, status: 'paused', id: 'isolated-receipt' }; } },
    direct: { registry: { route: (input: { action: string; args: Record<string, unknown> }) => { routed.push(input); return input; },
      captureVersions: () => ({}) } } } as unknown as ApplicationServices;
  const host = await serve(createSourceSettingsRouter(services));
  try {
    const base = { requestId: 'explicit-read-only-test', scopeId: 'CN/A_STOCK', parameters: { symbol: '600519.SH' } };
    for (const [pluginId, operationId, legacy] of [
      ['ths', 'index_constituents', { apiOperation: 'index_constituents' }],
      ['ths', 'daily_bars', { apiOperation: 'daily_bars' }],
      ['eastmoney', 'minute_bars', { klineOperation: 'minute_bars' }],
      ['tencent', 'daily_bars', { klineOperation: 'daily_bars' }],
      ['tdx', 'minute_bars', { sourceId: 'tdx' }],
    ] as const) {
      const connectionId = settings.get().connections.find(item => item.pluginId === pluginId)!.id;
      const response = await host.call('/runs', { ...base, requestId: `${pluginId}-${operationId}-canonical`, connectionId, operationId });
      assert.equal(response.status, 202);
      const canonical = routed.at(-1)!;
      assert.equal(canonical.action, sourceOperations(pluginId).find(item => item.id === operationId)!.run.action);
      assert.equal((await host.call('/runs', { ...base, requestId: `${pluginId}-${operationId}-legacy`, ...legacy })).status, 202);
      const expectedTitle = 'apiOperation' in legacy ? '读取接口源 · 已配置组合'
        : 'klineOperation' in legacy ? '读取公开K线 · 已配置组合' : '下载来源原件 · tdx';
      assert.equal(accepted.at(-1)!.title, expectedTitle, 'historical request title is part of the persisted idempotency digest');
      assert.deepEqual(routed.at(-1), canonical);
    }
    const before = routed.length;
    for (const invalid of [{ apiOperation: 'daily_bars', klineOperation: 'daily_bars' },
      { apiOperation: 'daily_bars', sourceId: 'tdx' }, { klineOperation: 'index_constituents' },
      { connectionId: 'tdx-main', operationId: 'daily_bars' }]) {
      const response = await host.call('/runs', { ...base, ...invalid });
      assert.equal(response.status, 400); assert.equal(response.value.code, 'SOURCE_REQUEST_INVALID');
    }
    assert.equal(routed.length, before, 'ambiguous requests cannot reach dispatch');
    const runtime = createSourceRuntime({ settings, files: {} as never, artifactRoot: directory });
    for (const action of ['source.api.read', 'source.kline.read'] as const) {
      const field = runtime.registrations.find(item => item.action === action)!.fields.find(item => item.key === 'operation')!;
      assert.deepEqual(field.options?.map(item => item.value), sourceOperationsForAction(action).map(item => item.id));
    }
  } finally { await host.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});
