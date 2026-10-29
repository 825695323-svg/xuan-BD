import { createHarnessRouter } from './harness-routes.js';
import express, { type ErrorRequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FILE_TRANSFER_LIMIT } from '../../platform/resources/pinned-read.js';
import { resolve } from 'node:path';
import { CoreError } from '../../platform/runtime/errors.js';
import type { PersonalCore } from '../../modules/agent/runtime/core.js';
import { normalizeAttachmentRefs } from '../../modules/agent/state/store.js';
import type { ConversationPlugin, ConversationState, ConversationVisibility, HealthResponse, SendRequestMode, SendRequestRoute, StateEnvelope } from '../../contracts/contracts.js';
import { ContextLedgerError } from '../../modules/agent/context-ledger.js';
import { PersonalResourceError } from '../../modules/agent/personal-resources.js';
import { MemoryError } from '../../modules/agent/memory.js';
import { FileReferenceError } from '../../platform/resources/files.js';
import { PermissionError } from '../../platform/security/permissions.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import { SkillError } from '../../platform/plugins/registry.js';
import type { ApplicationServices } from './services.js';
import { createPlatformRouter, createApprovalRouter } from './platform-routes.js';
import { piTaskRequestId } from '../../modules/agent/runtime/pi-task-runtime.js';
import { createWorkspaceRouter } from './workspace-routes.js';
import { MaterialError } from '../../modules/collection/data-processing/material-inspector/index.js';
import { createUiRouter } from './ui-routes.js';
import { createConversationDisplayMetadataRouter } from './conversation-display-metadata-routes.js';
import { createDataBrowserRouter } from './data-browser-routes.js';
import { createDatabaseLineRouter } from './database-line-routes.js';
import { createCaptureSourceRouter } from './capture-source-routes.js';
import { createSourceSettingsRouter } from './source-settings-routes.js';
import { createToolLibraryRouter } from './tool-library-routes.js';
import { createAlgorithmRouter } from './algorithm-routes.js';
import { createLocalDataLifecycleRouter } from './local-data-routes.js';
import type { LocalDataLifecycle } from '../../platform/runtime/local-data-lifecycle.js';

const modelSendRoute: SendRequestRoute = { kind: 'model', ruleId: null, ruleRevision: null, action: null, subjectDigest: null, versionsDigest: null };

/** 可由受信宿主挂载；本工厂不监听端口。API 前缀挂载不等于内置网页支持该前缀。 */
export function createApp(core: PersonalCore, health: HealthResponse, services?: ApplicationServices, options: { webRoot?: string; serveWeb?: boolean } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const hostname = req.hostname;
    if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
      res.status(403).json({ error: '仅允许本机访问。' }); return;
    }
    const origin = req.headers.origin;
    const allowed = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', `http://${req.headers.host}`]);
    // 顶层文档导航来自地址栏、书签或他站链接时不带 Origin；他站链接会带 Sec-Fetch-Site: cross-site。
    // 网页本身允许这样打开，否则用户从别的页面点本地入口只会得到一段 JSON。接口、子资源和内嵌仍按原规则拒绝。
    const crossSitePage = req.headers['sec-fetch-site'] === 'cross-site' && !req.path.startsWith('/api')
      && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if ((origin && !allowed.has(origin)) || (req.headers['sec-fetch-site'] === 'cross-site' && !crossSitePage)) {
      res.status(403).json({ error: '请求来源不受信任。' }); return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    if (req.path.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-mashiro-client'] !== 'web') {
      res.status(403).json({ error: '缺少本机客户端标识。' }); return;
    }
    next();
  });
  // 控制入口先于私有门禁挂载：停用后仍需能读取资格、停止和原控制记录。
  if (services?.localData && services.localDataId && !services.harness) app.use('/api/harness/local-data', express.json({ limit: '160kb' }), createLocalDataLifecycleRouter({
    lifecycle: services.localData, dataId: services.localDataId, verify: services.localDataVerify,
    assertReload: services.database?.path && services.database.path !== ':memory:' ? ({ dataId }) => {
      if (services.localData!.identityStatus(dataId, services.database.path) !== 'matched') {
        throw new CoreError('LOCAL_DATA_IDENTITY_UNAVAILABLE', '原个人资料身份未核对，不能保存重新加载。', 409);
      }
    } : undefined }));
  // 私有读取/写/流统一代次门禁；静态网页与健康检查不受影响。
  const privateLifecycle = services?.localData;
  const privateRequestContext = new AsyncLocalStorage<{ generation: number }>();
  const generationOf = (req: express.Request): number | null => {
    const raw = req.get('x-local-data-generation') ?? (typeof req.query.localDataGeneration === 'string' ? req.query.localDataGeneration : undefined);
    return raw !== undefined && /^\d{1,16}$/u.test(raw) ? Number(raw) : null;
  };
  // 解析请求正文后、进入真正写文件/写库 handler 前，用同一代次再核一次。
  const privateRecheck: express.RequestHandler = (req, _res, next) => {
    if (!privateLifecycle || req.path === '/health') { next(); return; }
    try { privateLifecycle.assertPrivateAccess(generationOf(req)); next(); }
    catch (error) { next(error); }
  };
  if (privateLifecycle && services?.files && !(services.files as unknown as { __localDataGuarded?: boolean }).__localDataGuarded) {
    const files = services.files as unknown as { __localDataGuarded?: boolean; register: (input: unknown) => unknown };
    const register = files.register.bind(services.files);
    files.register = ((input: unknown) => {
      const current = privateRequestContext.getStore();
      if (current) privateLifecycle.assertPrivateAccess(current.generation);
      else privateLifecycle.assertActive();
      return register(input as never);
    }) as typeof files.register;
    files.__localDataGuarded = true;
  }
  if (privateLifecycle && services?.direct && !(services.direct as unknown as { __localDataGuarded?: boolean }).__localDataGuarded) {
    const direct = services.direct as unknown as { __localDataGuarded?: boolean; assertPublicPath: (path: string, allowMissing?: boolean) => void };
    const assertPath = direct.assertPublicPath.bind(services.direct);
    direct.assertPublicPath = ((path: string, allowMissing?: boolean) => {
      const current = privateRequestContext.getStore();
      if (current) privateLifecycle.assertPrivateAccess(current.generation);
      else privateLifecycle.assertActive();
      return assertPath(path, allowMissing);
    }) as typeof direct.assertPublicPath;
    direct.__localDataGuarded = true;
  }
  const privateStreams = new Set<express.Response>();
  const closePrivateStreams = () => {
    for (const stream of [...privateStreams]) {
      try {
        stream.write('event: lifecycle\ndata: {"status":"unavailable"}\n\n');
        stream.end();
      } catch { /* 已关闭的连接无需再次通知。 */ }
      privateStreams.delete(stream);
    }
  };
  const unsubscribePrivate = privateLifecycle?.subscribeChanges(closePrivateStreams);
  const privateGuard: express.RequestHandler = (req, res, next) => {
    if (!privateLifecycle || req.path === '/health') { next(); return; }
    const generation = generationOf(req);
    let record;
    try { record = privateLifecycle.assertPrivateAccess(generation); }
    catch (error) { next(error); return; }
    res.setHeader('X-Local-Data-Generation', String(record.generation));
    const originalJson = res.json.bind(res), originalSend = res.send.bind(res);
    let sent = false;
    const rejectBody = (error: unknown): void => {
      const status = error instanceof CoreError ? error.status : 409;
      const code = error instanceof CoreError ? error.code : 'LOCAL_DATA_DEACTIVATED';
      res.status(status).set('Content-Type', 'application/json');
      res.end(JSON.stringify({ code, error: error instanceof Error ? error.message : '本地资料资格已经失效。' }));
    };
    res.json = ((body: unknown) => {
      if (sent) return res;
      try { privateLifecycle.assertPrivateAccess(generation); }
      catch (error) { sent = true; rejectBody(error); return res; }
      sent = true;
      return originalJson(body);
    }) as express.Response['json'];
    // 文件下载等非 JSON 响应在真正发送字节前也核同一代次；已发送的字节不冒充撤回。
    res.send = ((body: unknown) => {
      const structured = !!body && typeof body === 'object' && !Buffer.isBuffer(body);
      if (!sent && (Buffer.isBuffer(body) || typeof body === 'string' || structured)) {
        try { privateLifecycle.assertPrivateAccess(generation); }
        catch (error) { sent = true; rejectBody(error); return res; }
      }
      sent = true;
      return structured ? originalJson(body) : originalSend(body as never);
    }) as express.Response['send'];
    if (req.path.endsWith('/events') && req.method === 'GET') {
      privateStreams.add(res);
      res.on('close', () => { privateStreams.delete(res); });
    }
    privateRequestContext.run({ generation: generation! }, next);
  };
  app.use('/api', privateGuard);
  const harnessServices = services?.harness ? services : services?.options.workspaceServices;
  app.use('/api/harness', createHarnessApiRouter(harnessServices, privateRecheck));
  if (services?.harness) {
    // 服务角色只保留自己的窄路由，不挂载个人会话、文件、权限或网页入口。
    app.use(serviceRouteUnavailable);
    app.use(serviceErrors);
    return app;
  }
  app.use(express.json({ limit: '160kb' }));
  // 正文解析完成后、任何个人 handler 执行前再核同一代次。
  app.use('/api', privateRecheck);
  app.use((req, _res, next) => { historyLimit(req.query.historyLimit); next(); });
  const viewState = (query: unknown, state: ConversationState) => {
    const limit = historyLimit(query);
    return limit === undefined ? state : core.projectStateWindow(state, limit);
  };
  app.get('/api/health', (_req, res) => res.json(health));
  if (services) {
    app.get('/api/questions', (req, res) => {
      const { conversationId, branchId } = req.query;
      if (typeof conversationId !== 'string' || (branchId !== undefined && typeof branchId !== 'string')) throw new CoreError('INVALID_QUERY', '读取问题需要当前会话和分支。', 400);
      res.json({ questions: services.questions.list(conversationId, branchId) });
    });
    app.post('/api/questions/:id/answer', (req, res) => {
      const body = objectBody(req.body);
      if (Object.keys(body).some(key => !['answer', 'requestId'].includes(key))) throw new CoreError('INVALID_BODY', '回答只接受正文和请求编号。', 400);
      res.status(202).json(services.questions.answer(req.params.id, stringField(body, 'answer'), stringField(body, 'requestId')));
    });
    app.post('/api/questions/:id/dismiss', (req, res) => {
      if (Object.keys(objectBody(req.body)).length) throw new CoreError('INVALID_BODY', '忽略问题不接受额外参数。', 400);
      res.json({ question: services.questions.dismiss(req.params.id) });
    });
  }
  if (services) app.use('/api/capture-sources', createCaptureSourceRouter(services.captureSessions, services.options.captureUnavailableReason));
  if (services) app.use('/api/ui/source-settings', createSourceSettingsRouter(services));
  if (services) app.use('/api/ui/tool-library', createToolLibraryRouter(services));
  // 个人宿主只读使用已装配工作台 companion 的算法服务；不在这里另建服务或自动采用。
  if (services) app.use('/api/ui/algorithms', createAlgorithmRouter({ algorithms: services.algorithms ?? services.options.workspaceServices?.algorithms }));
  app.use('/api/conversations', createConversationDisplayMetadataRouter(core));
  if (services) app.use('/api/ui/data-browser', createDataBrowserRouter(services));
  if (services) app.use('/api/ui', createUiRouter(services));
  app.get('/api/conversation', (_req, res) => res.json(core.getState()));
  app.get('/api/conversations', (req, res) => {
    const view = req.query.view ?? 'active', query = req.query.q;
    if (typeof view !== 'string' || !['active', 'archived', 'trashed'].includes(view)
      || (query !== undefined && typeof query !== 'string')) {
      throw new CoreError('INVALID_QUERY', '会话列表和搜索条件无效。', 400);
    }
    res.json(core.listConversations(view as ConversationVisibility, query, conversationPlugin(req.query.pluginId)));
  });
  app.post('/api/conversations', (req, res) => {
    const body = objectBody(req.body);
    if (Object.keys(body).some((key) => key !== 'title' && key !== 'pluginId')) {
      throw new CoreError('INVALID_BODY', '新建会话只接受名称和插件归属。', 400);
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120)) {
      throw new CoreError('INVALID_TITLE', '会话名称需为1到120个字符。', 400);
    }
    res.status(201).json(viewState(req.query.historyLimit, core.createConversation(body.title as string | undefined, undefined, conversationPlugin(body.pluginId))));
  });
  app.get('/api/conversations/:id', (req, res) => {
    const limit = historyLimit(req.query.historyLimit);
    res.json(limit === undefined ? core.getState(req.params.id) : core.getStateWindow(req.params.id, limit));
  });
  app.get('/api/conversations/:id/history', (req, res) => {
    const { branchId, before, limit } = req.query;
    if (typeof branchId !== 'string' || typeof before !== 'string') throw new CoreError('INVALID_CURSOR', '读取较早消息需要当前分支和历史游标。', 400);
    res.json(core.getHistoryPage(req.params.id, branchId, before, historyLimit(limit) ?? 40));
  });
  app.patch('/api/conversations/:id', (req, res) => {
    const body = objectBody(req.body);
    if (Object.keys(body).some((key) => key !== 'title')) {
      throw new CoreError('INVALID_BODY', '修改会话只接受名称；插件归属在创建后保持不变。', 400);
    }
    res.json(viewState(req.query.historyLimit, core.renameConversation(req.params.id, stringField(body, 'title'))));
  });
  app.post('/api/conversations/:id/visibility', (req, res) => {
    const body = objectBody(req.body);
    if (Object.keys(body).some((key) => key !== 'visibility' && key !== 'sequence')
      || typeof body.visibility !== 'string' || !['active', 'archived', 'trashed'].includes(body.visibility)) {
      throw new CoreError('INVALID_VISIBILITY', '会话状态操作只接受可见状态和当前会话版本。', 400);
    }
    res.json(viewState(req.query.historyLimit, core.setConversationVisibility(req.params.id, body.visibility as ConversationVisibility, integerField(body, 'sequence'))));
  });
  app.patch('/api/conversations/:id/project', (req, res) => {
    const body = objectBody(req.body);
    if (body.projectId !== null && typeof body.projectId !== 'string') throw new CoreError('INVALID_PROJECT', '项目名称必须是文本，清除时使用空值。', 400);
    res.json(viewState(req.query.historyLimit, core.setConversationProject(req.params.id, body.projectId)));
  });
  app.patch('/api/conversations/:id/thinking', (req, res) => {
    const body = objectBody(req.body);
    if (Object.keys(body).some((key) => key !== 'level')) throw new CoreError('INVALID_BODY', '思考设置只接受档位。', 400);
    res.json(viewState(req.query.historyLimit, core.setThinkingLevel(req.params.id, body.level)));
  });
  app.get('/api/conversations/:id/draft', (req, res) => {
    const kind = req.query.kind ?? 'main', messageId = req.query.messageId ?? '';
    const branchId = req.query.branchId;
    if (typeof kind !== 'string' || typeof messageId !== 'string' || (branchId !== undefined && typeof branchId !== 'string')) {
      throw new CoreError('INVALID_DRAFT', '草稿标识无效。', 400);
    }
    res.json(core.getDraft(req.params.id, kind, messageId, branchId));
  });
  app.put('/api/conversations/:id/draft', (req, res) => {
    const body = objectBody(req.body);
    if (body.key !== undefined && typeof body.key !== 'string') throw new CoreError('INVALID_DRAFT', '草稿标识无效。', 400);
    res.json(core.saveDraft(req.params.id, stringField(body, 'text'), integerField(body, 'revision'), body.key as string | undefined, normalizeAttachmentRefs(body.attachmentRefs)));
  });
  app.post('/api/conversations/:id/send-requests', (req, res) => {
    const body = objectBody(req.body);
    if (Object.keys(body).some((key) => !['requestId', 'branchId', 'mode', 'text', 'draft', 'attachmentRefs', 'expectedRunId'].includes(key))
      || (body.expectedRunId !== undefined && body.expectedRunId !== null && typeof body.expectedRunId !== 'string')) {
      throw new CoreError('INVALID_BODY', '冻结发送只接受请求编号、分支、方式、正文、草稿修订、附件和原运行。', 400);
    }
    const draft = draftReference(body.draft);
    if (!draft) throw new CoreError('INVALID_DRAFT', '冻结发送需要当前草稿修订。', 400);
    const text = stringField(body, 'text'), mode = sendRequestMode(body.mode);
    const attachmentRefs = normalizeAttachmentRefs(body.attachmentRefs);
    // 实际路由由受信宿主选择并随请求冻结；客户端不能自行声明模型或本机动作。
    const route = services ? services.inputRouter.routeFor(req.params.id, text, mode, attachmentRefs.length) : modelSendRoute;
    const request = core.freezeSendRequest(req.params.id, {
      requestId: stringField(body, 'requestId'), branchId: stringField(body, 'branchId'), mode,
      text, attachmentRefs, draft,
      expectedRunId: body.expectedRunId as string | null | undefined,
    }, { permissionPolicyVersion: services?.permissions.policyVersion ?? null, route });
    res.status(201).json(request);
  });
  app.get('/api/conversations/:id/send-requests', (req, res) => res.json(core.listSendRequests(req.params.id)));
  app.get('/api/conversations/:id/send-requests/:requestId', (req, res) => res.json(core.getSendRequest(req.params.id, req.params.requestId)));
  app.post('/api/conversations/:id/send-requests/:requestId/abandon', (req, res) => {
    if (Object.keys(objectBody(req.body)).length) throw new CoreError('INVALID_BODY', '放弃原发送请求不接受额外参数。', 400);
    res.json(core.abandonSendRequest(req.params.id, req.params.requestId));
  });
  app.post('/api/conversations/:id/messages', (req, res) => {
    const body = objectBody(req.body);
    const attachmentRefs = normalizeAttachmentRefs(body.attachmentRefs);
    const pluginId = core.store.conversation(req.params.id).plugin_id;
    if (pluginId === 'direct' && attachmentRefs.length) {
      throw new CoreError('DIRECT_ATTACHMENTS_UNSUPPORTED', '本机直接执行暂不接受会话附件，请在智能对话中提交附件和加工要求。', 400);
    }
    if (body.mode !== undefined && !['send', 'queue', 'steer'].includes(body.mode as string)) throw new CoreError('INVALID_MODE', '输入方式无效。', 400);
    const text = stringField(body, 'text');
    const mode = (body.mode === undefined ? 'send' : body.mode) as SendRequestMode;
    const route = services ? services.inputRouter.routeFor(req.params.id, text, mode, attachmentRefs.length) : modelSendRoute;
    // 模型发送与本机直接执行都必须先核对同一个冻结请求身份和实际路由。
    core.assertSendRequest(req.params.id, stringField(body, 'requestId'), { mode, text, attachmentRefs, draft: draftReference(body.draft), route });
    if (!attachmentRefs.length && services && body.mode !== undefined && body.mode !== 'send'
      && pluginId === 'pi' && services.inputRules.match(stringField(body, 'text'))) {
      throw new CoreError('DIRECT_REQUIRES_IDLE', '这条输入匹配本机动作规则，请先停止当前运行，再发送；草稿已保留。', 409);
    }
    if (!attachmentRefs.length && (body.mode === undefined || body.mode === 'send') && services) {
      const receipt = services.inputRouter.route(req.params.id, stringField(body, 'text'), stringField(body, 'requestId'), draftReference(body.draft));
      if (receipt) {
        core.noteSendRequestReceipt(req.params.id, stringField(body, 'requestId'), receipt);
        res.status(202).json(receipt); return;
      }
    }
    res.status(202).json(core.sendMessage(req.params.id, stringField(body, 'text'), stringField(body, 'requestId'), {
      mode: body.mode as 'send' | 'queue' | 'steer' | undefined, draft: draftReference(body.draft),
      attachmentRefs, sendRequest: pluginId === 'pi',
      permissionPolicyVersion: services?.permissions.policyVersion ?? null,
    }));
  });
  app.post('/api/conversations/:id/interrupt-send', async (req, res) => {
    const body = objectBody(req.body), id = req.params.id;
    if (Object.keys(body).some((key) => !['text', 'requestId', 'draft', 'expectedRunId', 'attachmentRefs'].includes(key))
      || (body.expectedRunId !== undefined && typeof body.expectedRunId !== 'string')) {
      throw new CoreError('INVALID_BODY', '打断并发送只接受新输入、附件引用、请求编号、草稿版本和原运行编号。', 400);
    }
    const attachmentRefs = normalizeAttachmentRefs(body.attachmentRefs);
    if (!attachmentRefs.length && core.store.conversation(id).plugin_id === 'pi' && services?.inputRules.match(stringField(body, 'text'))) {
      throw new CoreError('DIRECT_REQUIRES_IDLE', '请先停止当前运行，再发送这条本机动作；输入草稿仍保留。');
    }
    const receipt = await core.interruptAndSend(id, stringField(body, 'text'), stringField(body, 'requestId'), {
      draft: draftReference(body.draft), expectedRunId: body.expectedRunId as string | undefined,
      attachmentRefs, sendRequest: true, permissionPolicyVersion: services?.permissions.policyVersion ?? null,
      ...(services ? { settleRelatedRun: async (runId: string, taskId: string) => {
        const run = core.store.run(runId), task = services.tasks.get(taskId);
        if (run.task_id !== task.id || task.conversationId !== id || task.runtimeId !== 'pi' || !task.currentAttemptId
          || core.store.command(run.command_id).request_id !== piTaskRequestId(task.id, task.currentAttemptId)) {
          throw new CoreError('STALE_TASK', '原运行所属的任务尝试已变化，新输入已保留，请核对后继续。');
        }
        await services.tasks.cancel(task.id);
      } } : {}),
    });
    res.status(202).json(receipt);
  });
  app.post('/api/conversations/:id/edit', (req, res) => {
    const body = objectBody(req.body);
    res.status(202).json(core.editMessage(req.params.id, stringField(body, 'messageId'), stringField(body, 'text'),
      stringField(body, 'requestId'), integerField(body, 'treeRevision'), draftReference(body.draft),
      body.attachmentRefs === undefined ? undefined : normalizeAttachmentRefs(body.attachmentRefs)));
  });
  app.post('/api/conversations/:id/retry', (req, res) => {
    const body = objectBody(req.body);
    res.status(202).json(core.retryMessage(req.params.id, stringField(body, 'messageId'), stringField(body, 'requestId'), integerField(body, 'treeRevision')));
  });
  app.post('/api/conversations/:id/compact', (req, res) => {
    const body = objectBody(req.body);
    if (Object.keys(body).some((key) => key !== 'requestId' && key !== 'treeRevision')) throw new CoreError('INVALID_BODY', '整理上下文只接受请求编号和当前历史版本。', 400);
    res.status(202).json(core.compactConversation(req.params.id, stringField(body, 'requestId'), integerField(body, 'treeRevision')));
  });
  app.post('/api/conversations/:id/branch', (req, res) => {
    const body = objectBody(req.body);
    if (body.branchId !== undefined && body.headId !== undefined) throw new CoreError('INVALID_BODY', '切换分支只能指定一个目标。', 400);
    const state = body.branchId === undefined
      ? core.selectBranch(req.params.id, stringField(body, 'headId'), integerField(body, 'treeRevision'))
      : core.selectBranchById(req.params.id, stringField(body, 'branchId'), integerField(body, 'treeRevision'));
    res.json(viewState(req.query.historyLimit, state));
  });
  app.post('/api/conversations/:id/branches', (req, res) => {
    const body = objectBody(req.body);
    res.json(viewState(req.query.historyLimit, core.createBranch(req.params.id, integerField(body, 'treeRevision'))));
  });
  app.post('/api/conversations/:id/fork', (req, res) => {
    const body = objectBody(req.body);
    if (Object.keys(body).some(key => !['treeRevision', 'requestId'].includes(key))) throw new CoreError('INVALID_BODY', '分支会话只接受当前历史版本和请求编号。', 400);
    res.status(201).json(viewState(req.query.historyLimit, core.forkConversation(req.params.id, integerField(body, 'treeRevision'), stringField(body, 'requestId'))));
  });
  app.post('/api/conversations/:id/abort', async (req, res) => {
    res.json(viewState(req.query.historyLimit, await core.abort(stringField(objectBody(req.body), 'runId'), req.params.id)));
  });
  app.post('/api/conversations/:id/queue/:commandId/cancel', (req, res) => res.json(viewState(req.query.historyLimit, core.cancelQueued(req.params.id, req.params.commandId))));
  app.post('/api/conversations/:id/queue/:commandId/edit', (req, res) => {
    const body = objectBody(req.body);
    if (Object.keys(body).some(key => !['requestId', 'text', 'expectedText'].includes(key))) throw new CoreError('INVALID_BODY', '修改待发消息只接受原正文、新正文和请求编号。', 400);
    res.json(viewState(req.query.historyLimit, core.editQueued(req.params.id, req.params.commandId, stringField(body, 'text'), stringField(body, 'requestId'), stringField(body, 'expectedText'))));
  });
  app.post('/api/conversations/:id/queue/:commandId/steer', (req, res) => {
    const body = objectBody(req.body);
    if (Object.keys(body).some(key => !['requestId', 'expectedRunId'].includes(key))) throw new CoreError('INVALID_BODY', '引导待发消息只接受当前运行和请求编号。', 400);
    res.json(viewState(req.query.historyLimit, core.steerQueued(req.params.id, req.params.commandId, stringField(body, 'requestId'), stringField(body, 'expectedRunId'))));
  });
  app.post('/api/conversations/:id/queue/resume', (req, res) => res.json(viewState(req.query.historyLimit, core.resumeQueue(req.params.id))));
  app.get('/api/events', (req, res) => {
    const conversationId = req.query.conversationId ?? core.defaultConversationId;
    if (typeof conversationId !== 'string') throw new CoreError('INVALID_CONVERSATION', '会话标识无效。', 400);
    const limit = historyLimit(req.query.historyLimit);
    const initial = limit === undefined ? core.getState(conversationId) : core.getStateWindow(conversationId, limit);
    res.status(200).set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    // 状态事件合并：同一事件循环内的多次变更只发最新一帧，避免长思考时积压把连接挤掉。
    let pending: StateEnvelope | null = null, scheduled = false, skipped = 0;
    const encode = (payload: StateEnvelope) => `event: state\ndata: ${JSON.stringify(limit === undefined ? payload : { ...payload, state: core.projectStateWindow(payload.state, limit) })}\n\n`;
    const flush = () => {
      scheduled = false;
      if (res.destroyed || !pending) return;
      // 客户端读得慢时跳过中间帧（下一次状态会覆盖），只在积压极大时才断开。
      if (res.writableLength > 4_194_304) { res.destroy(); return; }
      if (res.writableLength > 1_048_576) { skipped += 1; return; }
      const body = encode(pending); pending = null;
      res.write(body);
    };
    const write = (payload: StateEnvelope) => {
      if (res.destroyed) return;
      pending = payload;
      if (!scheduled) { scheduled = true; setImmediate(flush); }
    };
    const unsubscribe = core.subscribe(write, conversationId);
    res.write(encode({ state: initial }));
    const timer = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15_000);
    timer.unref();
    req.on('close', () => { clearInterval(timer); unsubscribe(); });
  });
  app.post('/api/messages', (req, res) => {
    const body = req.body as unknown;
    if (!isRecord(body) || typeof body.text !== 'string' || typeof body.requestId !== 'string') {
      res.status(400).json({ error: '消息必须包含文本和请求标识。' }); return;
    }
    const receipt = services?.inputRouter.route(core.defaultConversationId, body.text, body.requestId);
    res.status(202).json(receipt ?? core.send(body.text, body.requestId));
  });
  app.post('/api/abort', async (req, res) => {
    if (!isRecord(req.body) || typeof req.body.runId !== 'string') {
      res.status(400).json({ error: '停止请求必须包含运行标识。' }); return;
    }
    res.json(await core.abort(req.body.runId));
  });
  if (services && privateLifecycle) app.use('/api/files/upload', express.raw({ type: 'application/octet-stream', limit: FILE_TRANSFER_LIMIT, inflate: false }), privateRecheck);
  if (services) app.use('/api', createPlatformRouter(services));
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  if (options.serveWeb !== false) {
    const webRoot = options.webRoot ?? resolve(import.meta.dirname, '../../dist/web');
    app.use(express.static(webRoot));
    app.get('/', (_req, res) => {
      if (existsSync(resolve(webRoot, 'index.html'))) res.sendFile(resolve(webRoot, 'index.html'));
      else res.status(503).type('text').send('界面尚未构建。请运行 npm run build，或用 npm run dev 启动开发界面。');
    });
  }
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof CoreError) res.status(error.status).json({ code: error.code, error: error.message,
      ...(error.code === 'DRAFT_CONFLICT' && 'draft' in error ? { draft: error.draft } : {}) });
    else if (error instanceof MemoryError || error instanceof PersonalResourceError || error instanceof ContextLedgerError) res.status(error.status).json({ code: error.code, error: error.message });
    else if (error instanceof PermissionError || error instanceof FileReferenceError || error instanceof TaskError || error instanceof SkillError) {
      res.status(error.code.includes('NOT_FOUND') ? 404 : error.code.startsWith('INVALID_') ? 400 : 409).json({ code: error.code, error: error.message });
    }
    else if (isRecord(error) && (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')) {
      res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: '请求正文无效或过大。' });
    } else res.status(500).json({ error: '本机服务处理失败。' });
  };
  app.use(errors);
  return app;
}

/** 两种宿主共用同一相对路由；只使用传入的服务实例和原状态，不经过回环代理。 */
export function createHarnessApiRouter(services?: ApplicationServices, recheck?: express.RequestHandler) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
      res.status(405).json({ code: 'WORKSPACE_METHOD_UNAVAILABLE', error: '此操作不属于工作台入口。' }); return;
    }
    next();
  });
  router.use(express.json({ limit: '160kb' }));
  if (recheck) router.use(recheck);
  if (services?.harness) {
    router.use(createApprovalRouter(services));
    if (services.databaseLines) router.use('/database-lines', createDatabaseLineRouter(services.databaseLines,
      services.options.resources ? { runtimeRoot: services.options.resources.runtimeRoot, runtimeIdentity: services.options.resources.document.runtimeIdentity } : undefined));
    if (services.harness.isWorkspace) router.use(createWorkspaceRouter(services));
    router.use(createHarnessRouter(services.harness));
  }
  // 未知工作台路径在此结束，不能继续匹配个人接口或网页回退。
  router.use(serviceRouteUnavailable);
  router.use(serviceErrors);
  return router;
}

const serviceRouteUnavailable: express.RequestHandler = (_req, res) => {
  res.status(404).json({ code: 'SERVICE_ROUTE_UNAVAILABLE', error: '此入口不属于当前启用的服务能力。' });
};
const serviceErrors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof CoreError) res.status(error.status).json({ code: error.code, error: error.message });
  else if (error instanceof TaskError || error instanceof FileReferenceError || error instanceof PermissionError || error instanceof MaterialError) res.status(error.code.includes('NOT_FOUND') ? 404 : error.code.startsWith('INVALID_') ? 400 : 409).json({ code: error.code, error: error.message });
  else if (isRecord(error) && (error.type === 'entity.parse.failed' || error.type === 'entity.too.large')) res.status(error.type === 'entity.too.large' ? 413 : 400).json({ code: 'INVALID_BODY', error: '请求正文无效或超过入口上限。' });
  else res.status(500).json({ code: 'SERVICE_ERROR', error: '服务处理失败，已有任务仍可凭原编号核对。' });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CoreError('INVALID_BODY', '请求正文必须是对象。', 400);
  return value;
}
function stringField(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== 'string') throw new CoreError('INVALID_BODY', `字段 ${key} 必须是文本。`, 400);
  return body[key];
}
function integerField(body: Record<string, unknown>, key: string): number {
  if (!Number.isSafeInteger(body[key]) || (body[key] as number) < 0) throw new CoreError('INVALID_BODY', `字段 ${key} 必须是非负整数。`, 400);
  return body[key] as number;
}
function draftReference(value: unknown): { key: string; revision: number } | undefined {
  if (value === undefined) return undefined;
  const draft = objectBody(value);
  return { key: stringField(draft, 'key'), revision: integerField(draft, 'revision') };
}
function sendRequestMode(value: unknown): 'send' | 'queue' | 'steer' | 'interrupt' {
  if (typeof value !== 'string' || !['send', 'queue', 'steer', 'interrupt'].includes(value)) {
    throw new CoreError('INVALID_MODE', '发送方式无效。', 400);
  }
  return value as 'send' | 'queue' | 'steer' | 'interrupt';
}
function conversationPlugin(value: unknown): ConversationPlugin {
  if (value === undefined) return 'pi';
  if (value !== 'pi' && value !== 'direct') throw new CoreError('INVALID_PLUGIN', '请选择智能对话或本机直接执行。', 400);
  return value;
}
function historyLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 200) {
    throw new CoreError('INVALID_LIMIT', '每次读取需为1到200条消息。', 400);
  }
  return Number(value);
}
