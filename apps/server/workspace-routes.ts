import express, { Router } from 'express';
import { userInfo } from 'node:os';
import { basename } from 'node:path';
import type { ApplicationServices } from './services.js';
import { acceptWorkspaceMaterial, MATERIAL_UPLOAD_LIMIT } from '../../modules/collection/accept-material.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { CoreError } from '../../platform/runtime/errors.js';
import type { OperatorContext } from '../../modules/collection/processing-plan.js';
import { officeNative } from '../../platform/capabilities/conversion/office.js';
import { xlsxModelPreview } from '../../platform/capabilities/conversion/index.js';
import { MAX_SOURCE } from '../../platform/capabilities/conversion/formats.js';
import { R1_CHUNKED_CSV_LIMITS } from '../../modules/collection/r1-chunked-csv.js';


/** 上传日志只追踪原件发布与任务绑定；执行、停止、恢复仍由唯一 TaskService 持有。 */
export function createWorkspaceRouter(services: ApplicationServices): Router {
  const router = Router(), { bd, materials, tasks, files, processing } = services;
  if (!bd) throw new TaskError('SERVICE_ROLE_REQUIRED', '材料入口需要服务身份。');
  router.get('/workspace', (_req, res) => res.json({ mode: 'bd-workspace', version: bd.versions.bd,
    modules: { materials: !!materials, collection: !!(services.collection || services.candidates || services.materials || processing), processing: processing ? 'step_plans' : 'not_enabled' },
    status: bd.status(), uploadLimitBytes: MATERIAL_UPLOAD_LIMIT,
    materialCapabilities: materials?.catalog() ?? null }));
  router.get('/workspace/storage-retention', (_req, res) => res.json(files.temporaryRetentionStatus()));
  if (services.cloudCustody) {
    const custody = services.cloudCustody;
    router.get('/cloud-custody/capabilities', (_req, res) => res.json(custody.capabilities()));
    router.post('/cloud-custody/runs', (req, res) => {
      const body = requestBody(req, ['requestId', 'input']);
      const task = custody.submit(body.input, id(body.requestId));
      res.status(202).json(custody.view(task.id));
    });
    router.get('/cloud-custody/materials/:id', (req, res) => res.json(custody.listForMaterial(req.params.id)));
    router.get('/cloud-custody/tasks/:id', (req, res) => res.json(custody.view(req.params.id)));
    router.get('/cloud-custody/tasks/:id/audit', (req, res) => res.json({ items: custody.audit(req.params.id) }));
    router.post('/cloud-custody/tasks/:id/recover', (req, res) => {
      const body = requestBody(req, ['requestId', 'expectedVersion']);
      const task = custody.recover(req.params.id, req.body.expectedVersion, id(body.requestId));
      res.status(202).json(custody.view(task.id));
    });
    router.get('/cloud-custody/tasks/:id/original', (req, res) => {
      const original = custody.readRestored(req.params.id);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(original.filename)}`);
      res.type('application/octet-stream').send(original.bytes);
    });
  }
  if (processing) {
    router.get('/processing/capabilities', (_req, res) => res.json(processing.catalog()));
    router.post('/processing/route', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      const task = processing.decideMaterial(body.input, operatorContext(req, body));
      res.status(202).json(bd.taskView(task.id));
    });
    router.get('/processing/materials/:id/routing', (req, res) => {
      const decision = processing.getDecision(req.params.id);
      if (!decision) throw new TaskError('PROCESSING_ROUTING_NOT_FOUND', '没有该材料的持久路由决定。');
      res.json(decision);
    });
    router.post('/processing/plans', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      const task = processing.preparePlan(body.input, operatorContext(req, body));
      res.status(202).json(bd.taskView(task.id));
    });
    router.post('/processing/plans/:id/revise', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      const task = processing.revisePlan(req.params.id, body.input, operatorContext(req, body));
      res.status(202).json(bd.taskView(task.id));
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
      res.status(202).json(bd.taskView(task.id));
    });
    router.post('/processing/plans/:id/run', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId']);
      const task = processing.runPlan(req.params.id, operatorContext(req, body));
      res.status(202).json(bd.taskView(task.id));
    });
    router.post('/processing/plans/:id/recover', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId']);
      const task = processing.recoverPlan(req.params.id, operatorContext(req, body));
      res.status(202).json(bd.taskView(task.id));
    });
    router.get('/processing/tasks/:id', (req, res) => {
      const found = processing.getByTask(req.params.id);
      if (!found) throw new TaskError('PROCESSING_TASK_NOT_FOUND', '没有该处理任务。');
      res.json({ ...found, task: bd.taskView(req.params.id) });
    });
  }
  if (services.endpointAdapters) {
    const adapters = services.endpointAdapters;
    router.get('/processing/adapters', (_req, res) => res.json(adapters.catalog()));
    router.get('/processing/adapters/versions', (req, res) => res.json({ items: adapters.list(typeof req.query.adapterId === 'string' ? id(req.query.adapterId) : undefined) }));
    router.get('/processing/adapters/exceptions', (req, res) => {
      const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) throw new TaskError('ADAPTER_LIMIT', '异常查看条数须为 1 至 200 的整数。');
      res.json(adapters.exceptions(limit));
    });
    // 自动发现只返回候选；不落库、不采用，也不改变任何既有计划。
    router.post('/processing/adapters/discover', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      res.json(adapters.discover(body.input));
    });
    router.post('/processing/adapters/candidates', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      res.status(201).json(adapters.propose(body.input, operatorContext(req, body)));
    });
    router.post('/processing/adapters/:adapterId/:version/replay', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      const input = body.input ?? {};
      if (!input || typeof input !== 'object' || Array.isArray(input) || input.adapterId !== req.params.adapterId || input.version !== req.params.version)
        throw new TaskError('ADAPTER_REPLAY', '重放路径与请求内的适配身份不一致。');
      res.json(adapters.replay(input, operatorContext(req, body)));
    });
    // 采用只接受本机受信入口的明确确认；会话模型或请求正文自报授权不构成采用依据。
    router.post('/processing/adapters/:adapterId/:version/adopt', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      const input = body.input ?? {};
      if (!input || typeof input !== 'object' || Array.isArray(input) || input.adapterId !== req.params.adapterId || input.version !== req.params.version)
        throw new TaskError('ADAPTER_ADOPT', '采用路径与请求内的适配身份不一致。');
      res.json(adapters.adopt(input, operatorContext(req, body)));
    });
    router.post('/processing/adapters/:adapterId/:version/retire', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId']);
      res.json(adapters.retire(id(req.params.adapterId), id(req.params.version), operatorContext(req, body)));
    });
  }
  if (services.corrections) {
    const corrections = services.corrections;
    const operator = (req: express.Request, body: { requestId: string }) => operatorContext(req, body);
    router.get('/corrections/capabilities', (_req, res) => res.json(corrections.capabilities()));
    router.get('/corrections/cases', (_req, res) => res.json({ items: corrections.list() }));
    router.get('/corrections/cases/:caseId', (req, res) => res.json(corrections.view(id(req.params.caseId))));
    router.post('/corrections/cases', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      res.status(201).json(corrections.register(body.input, operator(req, body)));
    });
    router.post('/corrections/cases/:caseId/impact', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId']);
      res.json(corrections.freezeImpact(id(req.params.caseId), operator(req, body)));
    });
    router.post('/corrections/cases/:caseId/suspend', async (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId']);
      res.json(await corrections.suspend(id(req.params.caseId), operator(req, body)));
    });
    router.get('/corrections/cases/:caseId/audit', async (req, res) => {
      const snapshotId = typeof req.query.snapshotId === 'string' ? id(req.query.snapshotId) : '';
      const productId = typeof req.query.productId === 'string' ? id(req.query.productId) : undefined;
      if (!snapshotId) throw new TaskError('CORRECTION_AUDIT_INPUT', '审计复现需要明确固定快照编号。');
      res.json(await corrections.audit(id(req.params.caseId), snapshotId, productId));
    });
    router.post('/corrections/cases/:caseId/prepare', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      res.json(corrections.prepareRepair(id(req.params.caseId), body.input, operator(req, body)));
    });
    // 授权是权限动作：任务走真实 TaskService/PermissionService 审批，正文自报授权无效。
    router.post('/corrections/cases/:caseId/authorize', (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId', 'input']);
      const input = body.input ?? {};
      if (typeof input.frozenSha256 !== 'string' || typeof input.confirmationDigest !== 'string')
        throw new TaskError('CORRECTION_AUTHORIZE_INPUT', '需要冻结清单摘要与确认摘要。');
      res.status(202).json(corrections.authorize(id(req.params.caseId), input.frozenSha256,
        input.confirmationDigest, operator(req, body)));
    });
    // 重开后只沿原请求身份恢复，不新建授权或请求号。
    router.post('/corrections/cases/:caseId/recover', async (req, res) => {
      const body = requestBody(req, ['requestId', 'operatorId']);
      res.json(await corrections.recoverRepair(id(req.params.caseId), operator(req, body)));
    });
  }
  if (services.r1Workspace) {
    const r1 = services.r1Workspace;
    router.get('/r1/capabilities', (_req, res) => res.json(r1.capabilities()));
    router.post('/r1/check', async (req, res) => {
      r1Body(req.body, []);
      res.json(await r1.checkProfile());
    });
    router.post('/r1/products/snapshot', async (req, res) => {
      r1Body(req.body, []);
      res.json(await r1.snapshotStatus());
    });
    router.post('/r1/products/discover', async (req, res) => res.json(await r1.discoverProducts(req.body)));
    router.post('/r1/query/filter', async (req, res) => res.json(await r1.filterObjects(req.body)));
    router.post('/r1/query/context', async (req, res) => res.json(await r1.readContext(req.body)));
    router.post('/r1/products/read', async (req, res) => res.json(await r1.readProduct(req.body)));
    router.get('/r1/requests', (_req, res) => res.json({ items: r1.list(), limit: 20, scope: 'recent_new_profile_requests_only' }));
    router.get('/r1/requests/:id', (req, res) => res.json(r1.get(id(req.params.id))));
    router.post('/r1/prepare', async (req, res) => res.status(201).json(await r1.prepareWithRestriction(req.body)));
    router.post('/r1/requests/:id/submit', (req, res) => {
      const body = r1Body(req.body, ['confirmationDigest']);
      if (typeof body.confirmationDigest !== 'string') throw new TaskError('R1_CONFIRMATION_REQUIRED', '须明确确认已展示文档的准确摘要。');
      const task = r1.submit(id(req.params.id), body.confirmationDigest);
      res.status(202).json(bd.taskView(task.id));
    });
    router.post('/r1/requests/:id/recover', async (req, res) => {
      const body = r1Body(req.body, ['lookupId']);
      const task = await r1.recover(id(req.params.id), id(body.lookupId));
      res.status(202).json(bd.taskView(task.id));
    });
  }
  if (services.r1Auto) {
    const auto = services.r1Auto;
    router.get('/r1/auto', (_req, res) => res.json({ items: auto.list(), limit: 20 }));
    router.get('/r1/auto/:id', (req, res) => res.json(auto.get(id(req.params.id))));
    router.post('/r1/auto/start', (req, res) => res.status(202).json(auto.start(req.body,
      operatorContext(req, { requestId: id(req.body?.requestId) }))));
    router.post('/r1/auto/:id/answers', (req, res) => res.status(202).json(auto.answer(id(req.params.id), req.body,
      operatorContext(req, { requestId: id(req.params.id) }))));
    router.post('/r1/auto/:id/advance', async (req, res) => {
      r1Body(req.body, []); res.json(await auto.advance(id(req.params.id)));
    });
  }
  if (services.r1Batches) {
    const batches = services.r1Batches;
    router.get('/r1/batches/chunked', (_req, res) => res.json({ items: batches.chunked.list() }));
    router.post('/r1/batches/chunked/start', async (req, res) => res.status(202).json(await batches.chunked.startAny(req.body,
      operatorContext(req, { requestId: id(req.body?.intakeId) }))));
    router.get('/r1/batches/chunked/:intakeId', (req, res) => res.json(batches.chunked.get(id(req.params.intakeId))));
    router.post('/r1/batches/chunked/:intakeId/advance', async (req, res) => {
      r1Body(req.body, []); res.status(202).json(await batches.chunked.advance(id(req.params.intakeId)));
    });
    router.post('/r1/batches/chunked/:intakeId/commit', async (req, res) => {
      const body = r1Body(req.body, ['manifestDigest']);
      res.status(202).json(await batches.chunked.commit(id(req.params.intakeId), body.manifestDigest));
    });
    router.post('/r1/batches/chunked/:intakeId/fixed-read', async (req, res) => {
      res.json(await batches.chunked.readBulkPage(id(req.params.intakeId), r1Body(req.body, ['pageSize', 'cursor'])));
    });
    router.post('/r1/batches/chunked/:intakeId/reclaim', async (req, res) => {
      r1Body(req.body, []); res.json(await batches.chunked.reclaim(id(req.params.intakeId)));
    });
    router.post('/r1/batches/chunked/:intakeId/resume-original', (req,res)=>{
      const body=r1Body(req.body,['confirmationDigest']);
      res.status(202).json(batches.chunked.resumeAccepted(id(req.params.intakeId),String(body.confirmationDigest)));
    });
    router.get('/r1/batches/chunked/:intakeId/pages/:ordinal', (req, res) => {
      res.json(batches.chunked.page(id(req.params.intakeId), Number(req.params.ordinal)));
    });
    router.post('/r1/batches/chunked/:intakeId/chunks/:offset', (req, _res, next) => {
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new CoreError('INVALID_UPLOAD', '原字节分块不接受压缩请求。', 400);
      if (Number(req.headers['content-length']) > R1_CHUNKED_CSV_LIMITS.chunkBytes) throw new CoreError('UPLOAD_TOO_LARGE', '每个原字节分块上限为 2 MiB。', 413);
      next();
    }, express.raw({ type: 'application/octet-stream', limit: R1_CHUNKED_CSV_LIMITS.chunkBytes, inflate: false }), (req, res) => {
      res.status(202).json(batches.chunked.upload(id(req.params.intakeId), Number(req.params.offset), req.body, req.get('x-bd-chunk-sha256')));
    });
    router.get('/r1/batches', (_req, res) => res.json({ items: batches.list(), limit: 20 }));
    router.get('/r1/batches/:id', (req, res) => res.json(batches.get(id(req.params.id))));
    router.post('/r1/batches/start', (req, res) => res.status(202).json(batches.start(req.body,
      operatorContext(req, { requestId: id(req.body?.batchId) }))));
    router.post('/r1/batches/:id/advance', async (req, res) => {
      r1Body(req.body, []); res.json(await batches.advance(id(req.params.id)));
    });
    router.post('/r1/batches/:id/items/:itemId/upload', (req, _res, next) => {
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new CoreError('INVALID_UPLOAD', '原件上传不接受压缩请求。', 400);
      if (Number(req.headers['content-length']) > MATERIAL_UPLOAD_LIMIT) throw new CoreError('UPLOAD_TOO_LARGE', '批量交接每份原件保管上限为 25 MiB。', 413);
      next();
    }, express.raw({ type: 'application/octet-stream', limit: MATERIAL_UPLOAD_LIMIT, inflate: false }), async (req, res) => {
      res.status(202).json(await batches.upload(id(req.params.id), id(req.params.itemId), req.body));
    });
  }
  // HB-03 文档侧检索（4.3 §8、4.8 §8）：产物先进证据账本，合格类型再片段化与建索引。
  if (services.structuredRetrieval) {
    router.get('/retrieval/joint/capabilities', (_req, res) => res.json(services.structuredRetrieval!.capabilities()));
    router.post('/retrieval/joint', async (req, res) => res.json(await services.structuredRetrieval!.search(req.body)));
  }
  if (services.segments) {
    const segments = services.segments;
    router.get('/retrieval/capabilities', (_req, res) => res.json(segments.capabilities()));
    router.get('/retrieval/settings', (_req, res) => res.json(segments.settings()));
    router.post('/retrieval/settings', (req, res) => {
      const body = r1Body(req.body, ['requestId', 'autoRegister', 'autoSegment', 'autoIndex']);
      res.json(segments.updateSettings({
        ...(body.autoRegister !== undefined ? { autoRegister: body.autoRegister as 'enabled' | 'disabled' } : {}),
        ...(body.autoSegment !== undefined ? { autoSegment: body.autoSegment as 'enabled' | 'disabled' } : {}),
        ...(body.autoIndex !== undefined ? { autoIndex: body.autoIndex as 'enabled' | 'disabled' } : {}) },
      id(body.requestId)));
    });
    router.post('/retrieval/artifacts', (req, res) => {
      const body = r1Body(req.body, ['requestId', 'materialId', 'artifactRef', 'documentVersion', 'eventTime', 'disclosedAt', 'conversionTaskId']);
      const task = segments.requestArtifact({ materialId: body.materialId as string, artifactRef: body.artifactRef as string,
        ...(body.documentVersion !== undefined ? { documentVersion: body.documentVersion as string } : {}),
        ...(body.eventTime !== undefined ? { eventTime: body.eventTime as never } : {}),
        ...(body.disclosedAt !== undefined ? { disclosedAt: body.disclosedAt as never } : {}),
        ...(body.conversionTaskId !== undefined ? { conversionTaskId: body.conversionTaskId as string } : {}) },
      id(body.requestId));
      res.status(202).json(bd.taskView(task.id));
    });
    router.get('/retrieval/documents', (_req, res) => res.json({ items: segments.documents() }));
    router.post('/retrieval/documents/:id/convert', (req, res) => {
      const body = r1Body(req.body, ['requestId']);
      if (!materials) throw new TaskError('MATERIAL_NOT_FOUND', '本实例未装配材料保管。');
      const material = materials.get(id(req.params.id)).envelope;
      bd.assertDispatch();
      const routed = services.direct.registry.route({ action: 'conversion.document', args: { fileRefId: material.fileRefId } });
      const task = tasks.create({ title: '转换已保管文档', ownerRole: 'service', runtimeId: routed.runtimeId,
        action: routed.action, args: routed.args, requestId: 'document-conversion:' + id(body.requestId),
        parentTaskId: material.taskId, versions: services.direct.registry.captureVersions(routed.action, routed.args) });
      if (task.status === 'ready') tasks.start(task.id, task.version);
      res.status(202).json(bd.taskView(task.id));
    });
    router.get('/retrieval/documents/:id/artifacts', (req, res) => {
      const version = typeof req.query.version === 'string' ? req.query.version : undefined;
      res.json({ materialId: req.params.id, items: segments.artifacts(req.params.id, version), automatic: segments.automatic(req.params.id) });
    });
    router.get('/retrieval/documents/:id/segments', (req, res) => {
      const version = typeof req.query.version === 'string' ? req.query.version : undefined;
      res.json({ documentId: req.params.id, items: segments.segments(req.params.id, version) });
    });
    router.get('/retrieval/segments/:id', (req, res) => res.json(segments.segment(req.params.id)));
    router.get('/retrieval/index-versions', (_req, res) => res.json({ items: segments.indexVersions() }));
    router.get('/retrieval/storage', (_req, res) => res.json(segments.storage()));
    router.post('/retrieval/index', (req, res) => {
      const body = r1Body(req.body, ['note']);
      res.status(201).json(segments.buildIndex(typeof body.note === 'string' ? body.note : undefined));
    });
    router.post('/retrieval/search', (req, res) => {
      const body = r1Body(req.body, ['method', 'query', 'limit', 'indexVersion', 'asOf', 'mode']);
      res.json(segments.search({ method: body.method === 'exact' ? 'exact' : 'keyword',
        query: typeof body.query === 'string' ? body.query : '',
        ...(body.limit !== undefined ? { limit: Number(body.limit) } : {}),
        ...(body.indexVersion !== undefined ? { indexVersion: body.indexVersion as string } : {}),
        ...(body.asOf !== undefined ? { asOf: body.asOf as string | null } : {}),
        ...(body.mode !== undefined ? { mode: body.mode as never } : {}) }));
    });
  }
  if (!materials) return router;
  router.get('/materials', (_req, res) => res.json(materials.list()));
  router.get('/materials/:id', (req, res) => res.json(materials.get(req.params.id)));
  router.get('/materials/:id/xlsx-preview', (req, res) => {
    const material = materials.get(req.params.id), original = materials.readOriginal(req.params.id);
    if (material.preview.format !== 'excel' || !/\.xlsx$/iu.test(material.envelope.filename)) throw new TaskError('XLSX_FORMAT', '此原件不是已识别的 XLSX 工作簿。');
    if (original.bytes.byteLength > MAX_SOURCE) throw new TaskError('XLSX_SOURCE_BUDGET', '工作簿超过原生转换预算，未扩大保护。');
    const payload = officeNative(original.bytes, 'xlsx', new AbortController().signal);
    res.json({ materialId: material.envelope.materialId, sha256: original.sha256, preview: xlsxModelPreview(payload) });
  });
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
    res.status(202).json(bd.taskView(taskId));
  });
  return router;
}

function r1Body(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new TaskError('R1_WEB_INPUT', 'R1 动作只接受已声明字段，不允许连接、路径或权限覆盖。');
  }
  return value as Record<string, unknown>;
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
