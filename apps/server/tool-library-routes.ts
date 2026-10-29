import { Router } from 'express';
import { CoreError } from '../../platform/runtime/errors.js';
import type { ApplicationServices } from './services.js';

export function createToolLibraryRouter(services: ApplicationServices) {
  const router = Router(), workspace = services.options.workspaceServices ?? services;
  const library = () => {
    if (!workspace.toolLibrary) throw new CoreError('TOOL_LIBRARY_UNAVAILABLE', '工具库服务尚未装配。', 503);
    return workspace.toolLibrary;
  };
  router.get('/', (_req, res) => res.json(library().view()));
  return router;
}
