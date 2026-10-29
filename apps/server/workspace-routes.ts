import express, { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { lstat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { root } from '@openclaw/fs-safe';
import type { ApplicationServices } from './services.js';
import { acceptWorkspaceMaterial, MATERIAL_UPLOAD_LIMIT } from '../../modules/collection/accept-material.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { CoreError } from '../../platform/runtime/errors.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import type { OperatorContext } from '../../modules/collection/processing-plan.js';


/** 上传日志只追踪原件发布与任务绑定；执行、停止、恢复仍由唯一 TaskService 持有。 */
export function createWorkspaceRouter(services: ApplicationServices): Router {
  const router = Router(), { harness, materials, financial, database, tasks, files, permissions, processing } = services;
  if (!harness) throw new TaskError('SERVICE_ROLE_REQUIRED', '材料入口需要服务身份。');
  router.get('/workspace', (_req, res) => res.json({ mode: 'harness-workspace', version: harness.versions.harness,
    modules: { materials: !!materials, financialTools: !!financial, collection: !!(services.collection || services.candidates || services.materials || processing), processing: processing ? 'step_plans' : 'not_enabled' },
    status: harness.status(), uploadLimitBytes: MATERIAL_UPLOAD_LIMIT,
    materialCapabilities: materials?.catalog() ?? null }));
  if (financial) {
    router.get('/tools', (_req, res) => res.json(financial.list()));
    router.get('/tools/:id', (req, res) => res.json(financial.describe(req.params.id)));
    router.get('/plugins', (_req, res) => res.json(financial.status()));
    router.post('/plugins/:id/enabled', (req, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['enabled', 'version', 'requestId',
        'pluginVersion', 'contractVersion', 'implementationVersion', 'permissionVersion'].includes(k))
        || typeof body.enabled !== 'boolean') throw new TaskError('INVALID_PLUGIN_ARGS', '插件开关参数无效。');
      const status = financial.status();
      const binding = ['pluginVersion', 'contractVersion', 'implementationVersion', 'permissionVersion'] as const;
      if (binding.some(key => Object.hasOwn(body, key)) && binding.some(key => body[key] !== status[key])) {
        throw new TaskError('FINANCIAL_VERSION_CONFLICT', '插件、实现或权限版本已经变化；请刷新后重新确认此启停请求。');
      }
      const requestId = id(body.requestId);
      res.json({ ...financial.setEnabled(body.enabled, { pluginId: req.params.id,
        pluginVersion: body.pluginVersion ?? status.pluginVersion, expectedVersion: body.version }, requestId), requestId });
    });
  }
  if (services.candidates) {
    router.get('/candidates/capabilities', async (_req, res) => res.json({ local: services.candidates!.catalog(), database: await services.candidates!.capabilities() }));
    router.post('/candidates/prepare', (req, res) => { const body = req.body; if (!body || Object.keys(body).some(key => !['requestId','input'].includes(key))) throw new TaskError('INVALID_CANDIDATE_REQUEST', '需要原请求号与候选输入。'); const task = services.candidates!.prepare(body.input, id(body.requestId)); res.status(202).json(harness.taskView(task.id)); });
    router.post('/candidates/submit', (req, res) => { const body = req.body; if (!body || Object.keys(body).some(key => !['requestId','preparedTaskId','completion'].includes(key))) throw new TaskError('INVALID_CANDIDATE_REQUEST', '需要原请求号、已构造任务和完成条件。'); const task = services.candidates!.submit(id(body.preparedTaskId), body.completion, id(body.requestId)); res.status(202).json(harness.taskView(task.id)); });
    router.get('/candidates/:id', (req, res) => res.json(services.candidates!.get(req.params.id)));
    router.post('/candidates/:id/control', (req, res) => { const body = req.body; if (!body || Object.keys(body).some(key => !['requestId','action','detail'].includes(key))) throw new TaskError('INVALID_CANDIDATE_REQUEST', '需要原请求、续接动作和完成条件或原因。'); const task = services.candidates!.control(req.params.id, body.action, body.detail, id(body.requestId)); res.status(202).json(harness.taskView(task.id)); });
    router.post('/candidates/:id/reconcile', async (req, res) => res.json(await services.candidates!.reconcile(req.params.id)));
  }
  if (processing) {
    router.get('/processing/capabilities', (_req, res) => res.json(processing.catalog()));
    router.post('/processing/route', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      const task = processing.decideMaterial(body.input, operatorContext(req, body));
      res.status(202).json(harness.taskView(task.id));
    });
    router.get('/processing/materials/:id/routing', (req, res) => {
      const decision = processing.getDecision(req.params.id);
      if (!decision) throw new TaskError('PROCESSING_ROUTING_NOT_FOUND', '没有该材料的持久路由决定。');
      res.json(decision);
    });
    router.post('/processing/plans', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      const task = processing.preparePlan(body.input, operatorContext(req, body));
      res.status(202).json(harness.taskView(task.id));
    });
    router.post('/processing/plans/:id/revise', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      const task = processing.revisePlan(req.params.id, body.input, operatorContext(req, body));
      res.status(202).json(harness.taskView(task.id));
    });
    router.get('/processing/plans/by-request/:requestId', (req, res) => {
      const found = processing.findByRequest(req.params.requestId);
      if (!found) throw new TaskError('PROCESSING_REQUEST_NOT_FOUND', '没有该处理请求。');
      res.json(found);
    });
    router.get('/processing/plans/:id', (req, res) => res.json(processing.get(req.params.id)));
    router.get('/processing/plans/:id/steps/:stepId', (req, res) => {
      const artifact = processing.artifact(req.params.id, req.params.stepId);
      res.json({ step: artifact.step, ref: artifact.ref, byteLength: artifact.bytes.byteLength });
    });
    router.get('/processing/plans/:id/steps/:stepId/artifact', (req, res) => {
      const artifact = processing.artifact(req.params.id, req.params.stepId);
      res.type('application/json').send(artifact.bytes);
    });
    router.get('/processing/plans/:id/outputs/:outputId/artifact', (req, res) => {
      const artifact = processing.outputArtifact(req.params.id, req.params.outputId);
      res.type('application/json').send(artifact.bytes);
    });
    router.post('/processing/plans/:id/steps/:stepId/execute', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId']);
      const task = processing.executeStep(req.params.id, req.params.stepId, operatorContext(req, body));
      res.status(202).json(harness.taskView(task.id));
    });
    router.post('/processing/plans/:id/run', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId']);
      const task = processing.runPlan(req.params.id, operatorContext(req, body));
      res.status(202).json(harness.taskView(task.id));
    });
    router.post('/processing/plans/:id/recover', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId']);
      const task = processing.recoverPlan(req.params.id, operatorContext(req, body));
      res.status(202).json(harness.taskView(task.id));
    });
    router.get('/processing/tasks/:id', (req, res) => {
      const found = processing.getByTask(req.params.id);
      if (!found) throw new TaskError('PROCESSING_TASK_NOT_FOUND', '没有该处理任务。');
      res.json({ ...found, task: harness.taskView(req.params.id) });
    });
  }
  if (!materials) return router;
  router.get('/materials', (_req, res) => res.json(materials.list()));
  router.get('/materials/:id', (req, res) => res.json(materials.get(req.params.id)));
  if (services.semantics) {
    router.get('/materials/:id/semantics', (req, res) => res.json(services.semantics!.list(req.params.id)));
    router.get('/material-proposals/:id', (req, res) => res.json(services.semantics!.get(req.params.id)));
  }
  router.get('/materials/:id/original', (req, res) => {
    const material = materials.get(req.params.id), { bytes } = materials.readOriginal(req.params.id);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(material.envelope.filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`);
    res.type('application/octet-stream').send(bytes);
  });
  router.post('/materials/upload', (req, _res, next) => {
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new CoreError('INVALID_UPLOAD', '原件上传不接受压缩请求。', 400);
    if (Number(req.headers['content-length']) > MATERIAL_UPLOAD_LIMIT) throw new CoreError('UPLOAD_TOO_LARGE', '当前网页入口每份原件上限为 25 MiB；受控文件引用保管上限为 256 MiB。', 413);
    next();
  }, express.raw({ type: 'application/octet-stream', limit: MATERIAL_UPLOAD_LIMIT, inflate: false }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new CoreError('INVALID_UPLOAD', '请选择一个非空文件。', 400);
    const requestId = id(req.query.requestId), name = req.query.name, category = req.query.category;
    if (typeof name !== 'string' || !name.trim() || name.length > 512 || name !== basename(name) || ['.', '..'].includes(name)
      || /[\\\u0000-\u001f\u007f]/u.test(name)) throw new CoreError('INVALID_FILE_NAME', '文件名无效。', 400);
    if (category !== 'unclassified' && category !== 'data' && category !== 'tool') throw new CoreError('INVALID_CATEGORY', '材料接收类别无效。', 400);
    const taskId = await acceptWorkspaceMaterial(services, { bytes: req.body, name, category, requestId });
    res.status(202).json(harness.taskView(taskId));
  });
  return router;
}

function requestBody(req: express.Request, keys: string[]): { requestId: string; operatorId: string; input?: Record<string, unknown> } {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) {
    throw new TaskError('INVALID_PROCESSING_REQUEST', `处理请求只接受字段：${keys.join(', ')}。`);
  }
  // 兼容旧请求仍可携带 operatorId，但宿主只采用本机 OS 操作者记录，客户端自称 ID 不进入授权事实。
  return { requestId: id(body.requestId), operatorId: hostOperatorId(), ...(body.input !== undefined ? { input: body.input as Record<string, unknown> } : {}) };
}
/** 宿主构造的真实本机操作者身份；不从 HTTP 正文、模型或前端状态读取。 */
export function hostOperatorId(): string {
  const name = userInfo().username.replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 120) || 'local';
  return `host.${name}`;
}
function operatorContext(req: express.Request, body: { requestId: string }): OperatorContext {
  return { operatorId: hostOperatorId(), requestId: body.requestId, method: req.method,
    path: req.originalUrl.split('?')[0] ?? req.path, remoteAddress: req.socket.remoteAddress ?? null, observedAt: Date.now() };
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) throw new TaskError('INVALID_REQUEST_ID', '需要稳定的原请求编号。');
  return value;
}
