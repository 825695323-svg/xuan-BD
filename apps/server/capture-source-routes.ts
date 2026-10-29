import { Router } from 'express';
import { CAPTURE_SOURCES, CAPTURE_SOURCE_IDS } from '../../plugins/capture-sources/contracts.js';
import type { CaptureSessionService } from '../../plugins/capture-sources/session.js';

/** 仅提供采集来源状态读取；登录态控制入口已撤除。 */
export function createCaptureSourceRouter(service?: CaptureSessionService, unavailableReason?: string) {
  const router = Router();
  router.get('/', async (_req, res) => {
    res.json({ sources: service ? await service.list() : CAPTURE_SOURCE_IDS.map(sourceId => ({
      sourceId, label: CAPTURE_SOURCES[sourceId].label, state: 'unavailable', mode: 'unselected',
      needsAttention: true, loginOpened: false, busy: false,
      message: unavailableReason ?? '采集源独立会话尚未绑定当前运行环境。',
    })) });
  });
  router.post('/:id/login', async (req, res) => {
    if (!service) throw new Error('采集源会话服务未装配。');
    const body: unknown = req.body;
    const action = body && typeof body === 'object' && 'action' in body ? (body as { action?: unknown }).action : undefined;
    if (Object.keys(body ?? {}).some(key => key !== 'action') || !['open', 'save', 'cancel'].includes(String(action))) {
      res.status(400).json({ error: '登录操作无效。' }); return;
    }
    const id = req.params.id;
    res.json(action === 'open' ? await service.openLogin(id) : action === 'save' ? await service.saveLogin(id) : await service.cancelLogin(id));
  });
  return router;
}
