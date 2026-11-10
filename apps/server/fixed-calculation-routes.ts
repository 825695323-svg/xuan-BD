import { Router } from 'express';
import type { FixedCalculationService } from '../../modules/collection/fixed-calculation-service.js';
/** 前端只读，派生计算与 WFD 写回通过 AGENTS 调用。 */
export function createFixedCalculationRouter(service: FixedCalculationService) {
  const router = Router();
  router.get('/capabilities', (_req, res) => res.json(service.capabilities()));
  router.get('/inputs', async (_req, res) => res.json(await service.inputs()));
  router.post('/records', async (req, res) => res.json(await service.records(req.body)));
  router.get('/tasks', (_req, res) => res.json({ items: service.list() }));
  router.get('/tasks/:id', (req, res) => res.json(service.get(String(req.params.id))));
  return router;
}
