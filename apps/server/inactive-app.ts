import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HealthResponse } from '../../contracts/contracts.js';
import type { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';
import { CoreError } from '../../platform/runtime/errors.js';
import { createLocalDataLifecycleRouter } from './local-data-routes.js';

/**
 * 停用/解绑后的最小宿主。
 *
 * 只提供资格读取、原控制记录、停止/重新加载保存入口和静态网页；不打开个人 Core、
 * 个人状态库、模型、浏览器、采集会话或数据库连接，也不自动重建缺失原资料。
 */

export interface InactiveLocalHostOptions {
  port?: number;
  webRoot?: string;
  lifecycle: LocalDataLifecycle;
  dataId: string;
  detail: string;
  /** 重新加载前的对象身份核对；返回原因即拒绝。 */
  reloadBlocker?: () => string | null;
  health?: HealthResponse;
}

export async function startInactiveLocalHost(options: InactiveLocalHostOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const hostname = req.hostname;
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      res.status(403).json({ error: '仅允许本机访问。' }); return;
    }
    const origin = req.headers.origin;
    const allowed = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', `http://${req.headers.host}`]);
    const crossSitePage = req.headers['sec-fetch-site'] === 'cross-site' && !req.path.startsWith('/api')
      && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if ((origin && !allowed.has(origin)) || (req.headers['sec-fetch-site'] === 'cross-site' && !crossSitePage)) {
      res.status(403).json({ error: '请求来源不受信任。' }); return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    if (req.path.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-mashiro-client'] !== 'web') {
      res.status(403).json({ error: '缺少本机客户端标识。' }); return;
    }
    next();
  });
  const health: HealthResponse = options.health ?? { name: 'xuan BD', backend: 'pi', configured: false,
    model: null, provider: null, notice: '当前本地资料未加载；仅提供资格核对与重新加载保存入口。' };
  app.get('/api/health', (_req, res) => res.json(health));
  app.use('/api/harness/local-data', express.json({ limit: '160kb' }), createLocalDataLifecycleRouter({
    lifecycle: options.lifecycle,
    dataId: options.dataId,
    qualification: () => ({ available: false, detail: options.detail }),
    assertReload: () => { const blocked = options.reloadBlocker?.(); if (blocked) throw new CoreError('LOCAL_DATA_IDENTITY_UNAVAILABLE', blocked, 409); },
  }));
  app.use('/api', (_req, res) => res.status(404).json({ code: 'LOCAL_DATA_NOT_LOADED', error: '当前本地资料未加载，私有接口不可用。' }));
  const webRoot = resolve(options.webRoot ?? resolve(import.meta.dirname, '../../dist/web'));
  app.use(express.static(webRoot));
  app.get('/', (_req, res) => {
    if (existsSync(resolve(webRoot, 'index.html'))) res.sendFile(resolve(webRoot, 'index.html'));
    else res.status(503).type('text').send('界面尚未构建。');
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof CoreError) res.status(error.status).json({ code: error.code, error: error.message });
    else res.status(500).json({ code: 'INACTIVE_HOST_ERROR', error: '最小宿主处理失败；个人资料仍保持未加载。' });
  };
  app.use(errors);
  const server = createServer(app);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4317, '127.0.0.1', () => { server.off('error', reject); resolveListen(); });
  });
  let stopping: Promise<void> | undefined;
  return {
    server,
    inactive: true as const,
    lifecycle: options.lifecycle,
    shutdown() {
      stopping ??= (async () => {
        await new Promise<void>((resolveClose, reject) => {
          server.close((error) => error ? reject(error) : resolveClose());
          server.closeAllConnections();
        });
        await options.lifecycle.close();
      })();
      return stopping;
    },
  };
}
