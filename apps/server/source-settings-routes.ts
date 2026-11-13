import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Router } from 'express';
import type { ApplicationServices } from './services.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import { CoreError } from '../../platform/runtime/errors.js';
import { CAPTURE_SOURCE_ACTIONS } from '../../plugins/capture-sources/index.js';
import { CAPTURE_SOURCE_IDS, type CaptureSourceId } from '../../plugins/capture-sources/contracts.js';
import { SOURCE_ACTIONS } from '../../plugins/api-sources/runtime.js';

/** 设置、手动来源获取共用已保存配置和原TaskService，不另建运行记录。 */
export function createSourceSettingsRouter(services: ApplicationServices) {
  const router = Router(), { sourceSettings, tasks, direct } = services;
  const belongs = (action: string) => action === 'source.pipeline' || SOURCE_ACTIONS.includes(action as typeof SOURCE_ACTIONS[number]) || CAPTURE_SOURCE_ACTIONS.includes(action);
  router.use((req, _res, next) => {
    if (req.method !== 'GET' && !services.core.healthy) throw new CoreError('STORAGE_UNAVAILABLE', '当前状态存储尚未恢复，未保存来源设置或接收新任务。', 503);
    next();
  });
  router.get('/', async (_req, res) => res.json(await sourceSettings.view()));
  router.get('/operations/:requestId', (req, res) => {
    const operation = sourceSettings.operation(req.params.requestId);
    if (!operation) throw new CoreError('SOURCE_SETTINGS_OPERATION_NOT_FOUND', '未找到该请求编号对应的来源设置提交记录。', 404);
    res.json(operation);
  });
  router.put('/', async (req, res) => {
    // 旧调用不带请求编号时保持原行为；带编号时持久原操作可查询、可安全重放。
    const requestId = (req.get('idempotency-key') ?? req.get('x-request-id')) || undefined;
    sourceSettings.update(req.body, requestId);
    const view = await sourceSettings.view();
    res.json(requestId ? { ...view, operation: sourceSettings.operation(requestId) } : view);
  });
  router.post('/config/open', async (_req, res) => {
    const path = services.sourceSettings.path;
    if (!existsSync(path)) throw new CoreError('SOURCE_CONFIG_MISSING', '来源配置文件尚不存在。', 404);
    let executable: string;
    try {
      const runtime = services.options.processRuntime;
      if (!runtime) throw new Error('unbound runtime');
      executable = runtime.path('open');
    } catch { throw new CoreError('SOURCE_CONFIG_OPEN_UNAVAILABLE', '当前设备没有已登记可用的配置打开程序。', 503); }
    const child = spawn(executable, [path], { detached: true, stdio: 'ignore', env: {} });
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new CoreError('SOURCE_CONFIG_OPEN_FAILED', '配置打开程序未能启动。', 503)));
      child.once('spawn', resolve);
    });
    child.unref();
    res.json({ started: true, path });
  });
  router.post('/checks', async (req, res) => {
    const body = object(req.body);
    if (Object.keys(body).some(key => key !== 'id') || typeof body.id !== 'string') invalid();
    const check = CAPTURE_SOURCE_IDS.includes(body.id as CaptureSourceId)
      ? await sourceSettings.captureCheck(body.id as CaptureSourceId) : await direct.sourceChecks?.check(body.id);
    if (!check) throw new CoreError('SOURCE_CHECK_UNAVAILABLE', '来源检查尚未装配。', 503);
    res.json(check);
  });
  router.get('/runs', (_req, res) => res.json({ runs: tasks.list({ limit: 300 }).filter(task => belongs(task.action)) }));
  router.post('/runs', async (req, res) => {
    const body = object(req.body);
    if (typeof body.requestId !== 'string' || !body.requestId) invalid();
    let action: string, args: Record<string, JsonValue>, title: string;
    if (body.captureSourceId !== undefined) {
      if (Object.keys(body).some(key => !['captureSourceId', 'requestId'].includes(key)) || !CAPTURE_SOURCE_IDS.includes(body.captureSourceId as CaptureSourceId)) invalid();
      const setting = sourceSettings.get().capture.find(item => item.sourceId === body.captureSourceId)!;
      sourceSettings.assertCaptureEnabled(setting.sourceId);
      action = `capture.${setting.sourceId}.read`; args = { operation: setting.operation, ...setting.parameters }; title = `手动采集 · ${setting.sourceId}`;
    } else if (body.werssFeedId !== undefined) {
      if (Object.keys(body).some(key => !['requestId', 'connectionId', 'werssFeedId', 'limit', 'offset'].includes(key))) invalid();
      action = 'source.werss.read';
      args = { connectionId: body.connectionId as JsonValue, feedId: body.werssFeedId as JsonValue,
        limit: body.limit as JsonValue, offset: body.offset as JsonValue };
      title = '读取 WeRSS 本地缓存 feed';
    } else if (body.wechatUrl !== undefined) {
      if (Object.keys(body).some(key => !['requestId', 'wechatUrl'].includes(key)) || typeof body.wechatUrl !== 'string') invalid();
      action = 'source.wechat.extract'; args = { url: body.wechatUrl }; title = '提取微信公众号文章正文';
    } else {
      if (Object.keys(body).some(key => !['sourceId', 'requestId', 'scopeId', 'parameters', 'apiOperation', 'klineOperation', 'connectionId', 'operationId'].includes(key)) || typeof body.scopeId !== 'string' || !body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters)) invalid();
      const parameters = JSON.stringify(body.parameters);
      if (parameters.length > 16_000) invalid();
      if (body.connectionId !== undefined || body.operationId !== undefined) {
        // 运行描述来自来源目录；页面不再按供应商猜测执行器。旧请求形状仍保留。
        if (Object.keys(body).some(key => !['requestId', 'scopeId', 'parameters', 'connectionId', 'operationId'].includes(key))
          || typeof body.connectionId !== 'string' || typeof body.operationId !== 'string') invalid();
        const current = sourceSettings.get(), connection = current.connections.find(item => item.id === body.connectionId);
        if (!connection) throw new CoreError('SOURCE_CONNECTION_UNKNOWN', '未找到指定的来源连接。', 404);
        if (!connection.enabled || !current.plugins.find(item => item.id === connection.pluginId)?.enabled)
          throw new CoreError('SOURCE_DISABLED', '来源连接或插件已停用。', 409);
        if (!connection.scopes.includes(body.scopeId) && !connection.scopes.includes('global')) invalid();
        const plugin = (await sourceSettings.view()).apiPlugins.find(item => item.id === connection.pluginId);
        const operation = plugin?.operations.find(item => item.id === body.operationId);
        if (!operation) invalid();
        action = operation.run.action;
        args = { scopeId: body.scopeId, parameters,
          ...(operation.run.action === 'source.fetch' ? { sourceId: operation.run.sourceId } : { operation: operation.id }) };
        title = `读取接口类型 · ${operation.label} · 已配置组合`;
      } else if (body.klineOperation !== undefined) {
        if (body.sourceId !== undefined || !['minute_bars', 'daily_bars'].includes(String(body.klineOperation))) invalid();
        action = 'source.kline.read'; args = { operation: String(body.klineOperation), scopeId: body.scopeId, parameters }; title = '读取公开K线 · 已配置组合';
      } else if (body.apiOperation !== undefined) {
        if (body.sourceId !== undefined || !['index_constituents', 'daily_bars'].includes(String(body.apiOperation))) invalid();
        action = 'source.api.read'; args = { operation: String(body.apiOperation), scopeId: body.scopeId, parameters }; title = '读取接口源 · 已配置组合';
      } else {
        if (!['tdx', 'eastmoney', 'official_web'].includes(String(body.sourceId))) invalid();
        action = 'source.fetch'; args = { sourceId: String(body.sourceId), scopeId: body.scopeId, parameters }; title = `下载来源原件 · ${body.sourceId}`;
      }
    }
    const routed = direct.registry.route({ action, args });
    const task = tasks.create({ title, requestId: body.requestId, runtimeId: 'direct', action: routed.action, args: routed.args,
      versions: direct.registry.captureVersions(routed.action, routed.args) });
    res.status(202).json({ task: task.status === 'ready' ? tasks.start(task.id, task.version) : task });
  });
  router.get('/runs/:id', (req, res) => {
    const task = tasks.get(req.params.id);
    if (!belongs(task.action)) throw new CoreError('SOURCE_RUN_NOT_FOUND', '该任务不是来源运行。', 404);
    res.json({ task, events: tasks.events(task.id), artifacts: services.files.getRefs({ taskId: task.id, limit: 100 }) });
  });
  return router;
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function invalid(): never { throw new CoreError('SOURCE_REQUEST_INVALID', '来源设置请求参数无效，请重新读取当前设置。', 400); }
