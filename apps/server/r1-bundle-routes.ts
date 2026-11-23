import { Router, type Request, type ErrorRequestHandler } from 'express';
import { WfdProductMachineError, type WfdBundleOperation } from '../../adapters/database/wfd-product-machine.js';
import { CoreError } from '../../platform/runtime/errors.js';
import type { R1BundleService } from '../../modules/collection/r1-bundle.js';

/** Mount under the workspace API. The host supplies its local access guard. */
export function createR1BundleRouter(service: R1BundleService, assertAccess: (req: Request, action: 'read' | WfdBundleOperation) => void | Promise<void>) {
  const router = Router();
  async function admit(req: Request, action: 'read' | WfdBundleOperation) {
    await assertAccess(req, action);
    if (Object.keys(req.query).length || (req.method === 'GET' && req.body && Object.keys(req.body).length))
      throw new CoreError('R1_BUNDLE_INPUT', '分包端点只接受该操作声明的参数。', 400);
  }
  router.get('/r1/bundles/capabilities', async (req, res) => {
    await admit(req, 'read');
    res.json(await service.capabilities());
  });
  router.get('/r1/bundles/requests/:requestId', async (req, res) => {
    await admit(req, 'read');
    res.json(service.requestStatus(req.params.requestId));
  });
  const routes = {
    'full/export': 'bundle_export_full', 'full/import': 'bundle_import_full',
    'delta/export': 'bundle_export_delta', 'delta/apply': 'bundle_apply_delta',
    'reference/export': 'bundle_export_reference', 'reference/register': 'bundle_register_reference',
  } as const;
  for (const [route, operation] of Object.entries(routes)) {
    router.post('/r1/bundles/' + route, async (req, res) => {
      await admit(req, operation);
      res.json(await service.dispatch(operation, req.body));
    });
  }
  const machineErrors: ErrorRequestHandler = (error, _req, res, next) => {
    if (!(error instanceof WfdProductMachineError)) return next(error);
    const denied = /^(CALLER_PERMISSION_DENIED|SOURCE_.*(?:MISSING|ADMITTED)|WRITE_AUTHORITY_REQUIRED|BUNDLE_OPERATION_NOT_CONFIGURED)$/u.test(error.code);
    res.status(denied ? 403 : 409).json({ code: error.code, error: error.message, mayHaveBeenAccepted: error.mayHaveBeenAccepted });
  };
  router.use(machineErrors);
  return router;
}
