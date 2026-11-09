import { Router } from 'express';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { FixedCalculationService } from '../../modules/collection/fixed-calculation-service.js';

/** Mounted by the existing workspace router; its authorization and error handling remain authoritative. */
export function createFixedCalculationRouter(service: FixedCalculationService) {
  const router = Router();
  router.get('/capabilities', (_req, res) => res.json(service.capabilities()));
  router.get('/inputs', async (_req, res) => res.json(await service.inputs()));
  router.post('/records', async (req, res) => res.json(await service.records(req.body)));
  router.get('/tasks', (_req, res) => res.json({ items: service.list() }));
  router.post('/tasks', async (req, res) => res.status(202).json(await service.create(req.body)));
  router.get('/tasks/:id', (req, res) => res.json(service.get(String(req.params.id))));
  router.post('/tasks/:id/stage', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) {
      throw new TaskError('FIXED_CALCULATION_INPUT', '候选保管只接受原任务编号，不接受覆盖内容。');
    }
    res.status(202).json(await service.stage(String(req.params.id)));
  });
  router.post('/tasks/:id/prepare', async (req, res) => res.status(201).json(await service.prepare(String(req.params.id), req.body)));
  return router;
}
