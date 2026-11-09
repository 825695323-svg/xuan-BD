import { Router } from 'express';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { BdService } from '../../modules/agent/service.js';
import { financialPublicError } from '../../modules/financial/contracts.js';

export function createBdRouter(service: BdService, onResume?: () => void): Router {
    const router = Router();
    router.get('/runtime/status', (_req, res) => res.json(service.status()));
    router.post('/runtime/stop', async (req, res) => {
      const body = object(req.body); keys(body, ['reason']);
      res.json(await service.options.tasks().stopControl(reason(body.reason)));
    });
    router.post('/runtime/resume', (req, res) => {
      const body = object(req.body); keys(body, ['reason', 'generation']);
      const state = service.options.tasks().resumeControl(integer(body.generation), reason(body.reason));
      onResume?.();
      res.json(state);
    });
    router.post('/jobs', (req, res) => {
      const body = object(req.body); keys(body, ['operation', 'args', 'requestId', 'parentJobId']);
      identifier(body.operation); identifier(body.requestId);
      if (body.parentJobId !== undefined) identifier(body.parentJobId);
      try {
        const task = service.submit(body.operation, body.args, body.requestId, body.parentJobId as string | undefined);
        res.status(202).json(service.taskView(task.id));
      } catch (error) {
        if (body.operation !== 'tools.call' || !body.args || typeof body.args !== 'object' || !('protocol_version' in body.args)) throw error;
        const rejected = financialPublicError(error, { requestId: body.requestId, stage: 'plan' });
        res.status(400).json({ protocol_version: '0.1', request_id: body.requestId, status: 'rejected', error: rejected });
      }
    });
    router.get('/jobs/:id', (req, res) => res.json(service.taskView(req.params.id)));
    router.get('/jobs', (_req, res) => res.json(service.options.tasks().list({ ownerRole: 'service', limit: 100 }).map(task => service.taskView(task.id))));
    router.get('/requests/:operation/:requestId', (req, res) => {
      const task = service.requestTask(req.params.operation, req.params.requestId);
      if (!task) throw new TaskError('TASK_NOT_FOUND', '没有找到此原请求。');
      res.json(service.taskView(task.id));
    });
    router.get('/jobs/:id/evidence', (req, res) => {
      const task = service.getTask(req.params.id), tasks = service.options.tasks();
      res.json({ task: service.taskView(task.id), runs: tasks.getRuns(task.id),
        attempts: tasks.getRuns(task.id).flatMap((run) => tasks.getAttempts(run.id)), events: tasks.events(task.id),
        ...(service.options.financial && task.runtimeId === service.options.financial.runtime.id ? { financial: service.options.financial.evidence(task.id) } : {}),
        ...(service.options.collection && task.runtimeId === service.options.collection.runtime.id
          ? { collection: service.options.collection.evidence(task.id) } : {}) });
    });
    router.post('/jobs/:id/resume', (req, res) => {
      const task = service.getTask(req.params.id), body = object(req.body); keys(body, ['version']);
      if (service.options.financial && task.runtimeId === service.options.financial.runtime.id) {
        service.options.financial.resume(task.id, integer(body.version)); res.json(service.taskView(task.id)); return;
      }
      if (service.options.materials && task.runtimeId === service.options.materials.runtime.id) {
        service.options.materials.resume(task.id, integer(body.version)); res.json(service.taskView(task.id)); return;
      }
      if (service.options.semantics && task.runtimeId === service.options.semantics.runtime.id) {
        service.options.semantics.resume(task.id, integer(body.version)); res.json(service.taskView(task.id)); return;
      }
      if (service.options.collection && task.runtimeId === service.options.collection.runtime.id) {
        service.options.collection.resume(task.id, integer(body.version)); res.json(service.taskView(task.id)); return;
      }
      service.assertVersion(task);
      service.assertDispatch();
      const version = integer(body.version);
      if (version !== task.version) throw new TaskError('TASK_VERSION_CONFLICT', '任务已变化，请按当前版本恢复。');
      if (service.options.collection && task.action === 'collection.run') {
        if (service.hasUnresolvedResult(task)) throw new TaskError('COLLECTION_RESULT_UNCONFIRMED', '请先按原加工任务核对数据库结果，再继续原编排任务。');
        const checkpoint = task.checkpoint && typeof task.checkpoint === 'object' && !Array.isArray(task.checkpoint) ? task.checkpoint : {};
        const childId = checkpoint.processingTaskId ?? checkpoint.collectionTaskId;
        if (typeof childId === 'string') {
          const child = service.getTask(childId);
          if (['ready', 'paused', 'interrupted', 'failed', 'cancelled'].includes(child.status)) service.options.collection.resume(child.id, child.version);
        }
      }
      if (task.status === 'ready') service.options.tasks().start(task.id, version);
      else if (task.action === 'collection.run' && ['failed', 'cancelled'].includes(task.status)) service.options.tasks().retry(task.id, version);
      else service.options.tasks().resume(task.id, version);
      res.json(service.taskView(task.id));
    });
    router.post('/jobs/:id/cancel', async (req, res) => {
      const task = service.getTask(req.params.id); keys(object(req.body), []);
      if (service.options.collection && task.runtimeId === service.options.collection.runtime.id) await service.options.collection.cancel(task.id);
      else {
        if (service.options.collection && task.action === 'collection.run' && task.status !== 'succeeded') {
          // 先阻断编排器继续派发；取消收集子任务的等待不能留下新建加工任务的窗口。
          const stopping = service.options.tasks().cancel(task.id);
          try {
            const current = service.getTask(task.id);
            const checkpoint = current.checkpoint && typeof current.checkpoint === 'object' && !Array.isArray(current.checkpoint) ? current.checkpoint : {};
            const childId = checkpoint.processingTaskId ?? checkpoint.collectionTaskId;
            if (typeof childId === 'string') {
              const child = await service.options.collection.cancel(childId);
              if (checkpoint.processingTaskId && child.status === 'succeeded') throw new TaskError('COLLECTION_ALREADY_COMPLETED', '加工子任务已完成；请读取原提交事实，不能宣称数据库已取消。');
            }
          } finally { await stopping; }
        } else {
          await service.options.tasks().cancel(task.id);
          }
      }
      res.json(service.taskView(task.id));
    });
    return router;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskError('INVALID_SERVICE_ARGS', '参数必须是对象。');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TaskError('INVALID_SERVICE_ARGS', '参数包含未允许的字段。');
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new TaskError('INVALID_SERVICE_ARGS', '请求、任务或操作编号无效。');
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TaskError('INVALID_SERVICE_ARGS', '需要当前非负整数版本。');
  return Number(value);
}
function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new TaskError('INVALID_SERVICE_ARGS', '请填写明确控制原因。');
  return value;
}
