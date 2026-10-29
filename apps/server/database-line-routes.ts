import { Router } from 'express';
import type { DatabaseLineService } from '../../adapters/database/line-selection.js';
import { CoreError } from '../../platform/runtime/errors.js';

/** Mounted behind the existing local-origin/client checks, never exposed as a model tool. */
export function createDatabaseLineRouter(lines: DatabaseLineService, host?: { runtimeRoot: string; runtimeIdentity: string }) {
  const router = Router();
  router.get('/', (_req, res) => res.json(lines.status()));
  router.post('/verify', async (req, res) => {
    const body = object(req.body, ['expectedRevision']);
    res.json({ host: host ?? null, ...await lines.verifySelected({ expectedRevision: revision(body.expectedRevision) }) });
  });
  router.post('/preview', (req, res) => {
    const body = object(req.body, ['connectionId', 'expectedRevision']);
    res.json(lines.preview({ connectionId: id(body.connectionId), expectedRevision: revision(body.expectedRevision) }));
  });
  router.post('/select', async (req, res) => {
    const body = object(req.body, ['connectionId', 'expectedRevision']);
    res.json(await lines.switch({ connectionId: id(body.connectionId), expectedRevision: revision(body.expectedRevision) }));
  });
  router.post('/rollback', async (req, res) => {
    const body = object(req.body, ['expectedRevision']);
    res.json(await lines.rollback({ expectedRevision: revision(body.expectedRevision) }));
  });
  router.post('/recover', async (req, res) => {
    const body = object(req.body, ['changeId', 'action']);
    if (body.action !== 'complete' && body.action !== 'abort') throw new CoreError('INVALID_LINE_MAINTENANCE', '恢复方式无效。', 400);
    res.json(await lines.recover({ changeId: id(body.changeId), action: body.action }));
  });
  router.post('/maintenance/begin', async (req, res) => {
    const body = object(req.body, ['connectionId', 'expectedRevision']);
    res.json(await lines.beginMaintenance({ connectionId: id(body.connectionId), expectedRevision: revision(body.expectedRevision) }));
  });
  return router;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new CoreError('INVALID_LINE_MAINTENANCE', '线路维护只接受明确的连接和当前修订。', 400);
  }
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw new CoreError('INVALID_LINE_MAINTENANCE', '线路或维护身份无效。', 400);
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new CoreError('INVALID_LINE_MAINTENANCE', '请先读取当前线路修订。', 400);
  return value;
}
