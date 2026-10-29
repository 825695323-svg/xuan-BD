import { Router } from 'express';
import { CoreError } from '../../platform/runtime/errors.js';
import type { PersonalCore } from '../../modules/agent/runtime/core.js';

export function createConversationDisplayMetadataRouter(core: PersonalCore) {
  const router = Router();
  router.put('/:id/display-metadata', (req, res) => {
    if (!core.healthy) throw new CoreError('STORAGE_UNAVAILABLE', '会话展示设置尚未保存，请先核对存储状态。', 503);
    if (Object.keys(req.query).some(key => key !== 'pluginId') || (req.query.pluginId !== 'pi' && req.query.pluginId !== 'direct')) {
      throw new CoreError('INVALID_PLUGIN', '请指定当前会话列表。', 400);
    }
    const displayMetadata = core.store.displayMetadata.update(req.params.id, req.query.pluginId, req.body);
    res.json({ conversationId: req.params.id, displayMetadata });
  });
  return router;
}
