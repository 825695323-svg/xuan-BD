import { readPinnedFile, FILE_TRANSFER_LIMIT } from '../../platform/resources/pinned-read.js';
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { root } from '@openclaw/fs-safe';
import { ConfigError, CoreError } from '../../platform/runtime/errors.js';
import type { ApplicationServices } from './services.js';
import type { MemoryInput } from '../../contracts/memory-contracts.js';
import type { JsonValue } from '../../contracts/task-contracts.js';
import type { PermissionCapability } from '../../platform/security/permissions.js';
import type { FileReference } from '../../platform/resources/files.js';
import { previewResourceImport, commitResourceImport } from '../../modules/agent/resources/import.js';
import { loadShortcutConfiguration } from '../../platform/config/shortcuts.js';
import { resourceContentHash } from '../../modules/agent/personal-resources.js';

/** 操作者审批复用各自账本；服务审批用显式前缀进入既有审批条，不建立跨库授权。 */
export function createApprovalRouter(services: ApplicationServices, companion?: ApplicationServices) {
  const router = express.Router();
  const owners = [{ services, prefix: '', scope: services.harness ? 'service' : 'personal' },
    ...(companion?.harness ? [{ services: companion, prefix: 'service:', scope: 'service' }] : [])];
  const ownerFor = (reference: string) => {
    const owner = reference.startsWith('service:') ? owners.find(entry => entry.prefix === 'service:') : owners[0];
    if (!owner) throw new CoreError('APPROVAL_OWNER_UNAVAILABLE', '原审批所属服务未装配，不能换用个人权限账本。', 404);
    return { owner, id: owner.prefix ? reference.slice(owner.prefix.length) : reference };
  };
  const source = (owner: typeof owners[number], id: string) => {
    const approval = owner.services.permissions.getApproval(id);
    const row = owner.services.database.connection.prepare('SELECT task_id FROM task_attempts WHERE id=? AND run_id=?').get(approval.operation.attemptId, approval.operation.runId);
    const task = row ? owner.services.tasks.get(String(row.task_id)) : null;
    const origin = task ? owner.services.modelTools.taskOrigin(task.id) : null;
    if (!origin && approval.operation.operationId.startsWith('model.')) throw new CoreError('APPROVAL_ORIGIN_UNAVAILABLE', '此模型动作的来源与分享范围尚未核对，暂不能批准。');
    return { approval, task, origin };
  };
  const present = (owner: typeof owners[number], approval: ReturnType<ApplicationServices['permissions']['getApproval']>) =>
    ({ ...approval, id: owner.prefix + approval.id, sourceApprovalId: approval.id, ownerScope: owner.scope });
  router.get('/approvals', (_req, res) => res.json(owners.flatMap(owner => owner.services.permissions.listApprovals()
    .filter(approval => approval.status === 'pending').map(approval => present(owner, approval)))));
  router.get('/approvals/:id', (req, res) => {
    const { owner, id } = ownerFor(req.params.id), { approval, task, origin } = source(owner, id);
    res.json({ ...present(owner, approval), ...(task ? { taskId: task.id, task: { title: task.title, action: task.action, args: task.args } } : {}), origin });
  });
  router.post('/approvals/:id', (req, res) => {
    const { owner, id } = ownerFor(req.params.id), body = object(req.body);
    if (!owner.services.core.healthy) throw new CoreError('STORAGE_UNAVAILABLE', '原审批账本的存储暂不可用。', 503);
    if (Object.keys(body).some(key => !['decision', 'capabilities'].includes(key))) throw new CoreError('INVALID_APPROVAL', '审批只接受决定及原请求的子范围。', 400);
    if (body.decision === 'deny') res.json(present(owner, owner.services.tasks.deny(id)));
    else if (body.decision === 'approve') {
      source(owner, id);
      if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) throw new CoreError('INVALID_APPROVAL', '审批范围无效。', 400);
      res.json(present(owner, owner.services.tasks.approve(id, body.capabilities as PermissionCapability[] | undefined)));
    } else throw new CoreError('INVALID_APPROVAL', '请选择批准或拒绝。', 400);
  });
  return router;
}

export function createPlatformRouter(services: ApplicationServices) {
  const router = express.Router();
  const { core, files, memory, permissions, tasks, direct } = services;
  // 旧宿主/测试替身未必提供运行时快照；缺失时保持 null，不伪称运行值已核对。
  const runtime = () => typeof direct.configuration === 'function' ? direct.configuration() : null;
  router.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !core.healthy) throw new CoreError('STORAGE_UNAVAILABLE', '核心存储需要恢复，当前暂停提交。', 503);
    next();
  });
  router.get('/skills', (_req, res) => res.json(direct.registry.list()));
  router.get('/context-usage', (req, res) => {
    const state = core.getState(string(req.query.conversationId));
    res.json(state.lastRun ? services.contextLedger.list(state.lastRun.id) : []);
  });
  router.get('/input-rules', (_req, res) => res.json(services.inputRules.list()));
  router.put('/input-rules/:id', (req, res) => {
    const b = object(req.body); exact(b, ['enabled', 'priority', 'revision']);
    if (typeof b.enabled !== 'boolean') throw new CoreError('INVALID_RULE', '启用状态无效。', 400);
    res.json(services.inputRules.update(req.params.id, { enabled: b.enabled, priority: integer(b.priority), revision: integer(b.revision) }));
  });
  router.post('/input-rules/attachment', (req, res) => {
    const b = object(req.body); exact(b, ['conversationId', 'fileRefId', 'requestId']);
    res.json(services.inputRouter.routeAttachment(string(b.conversationId), string(b.fileRefId), string(b.requestId)));
  });
  router.get('/settings/tools', (_req, res) => res.json(services.toolSettings.get()));
  /** 启动/首次读取时按当前 direct 实际运行值核对哪些原操作可补记采用或需重试；不自动安装。 */
  router.get('/settings/tools/adoptions', (_req, res) => res.json({ checks: services.toolSettings.adoptionChecks(runtime()) }));
  router.get('/settings/tools/operations/:requestId', (req, res) => {
    const operation = services.toolSettings.operation(req.params.requestId, runtime());
    if (!operation) throw new CoreError('SETTINGS_OPERATION_NOT_FOUND', '未找到该请求编号对应的设置提交记录。', 404);
    res.json(operation);
  });
  router.put('/settings/tools', async (req, res) => {
    const body = object(req.body);
    if (Object.keys(body).some((key) => !['revision', 'requestId', 'whisperModelPath', 'shortcutConfigPath', 'videoMaxMinutes', 'videoMaxBytes'].includes(key))) throw new CoreError('INVALID_SETTINGS', '工具设置包含未知字段。', 400);
    const requestId = body.requestId === undefined ? randomUUID() : string(body.requestId);
    const pathValue = (key: string) => body[key] === null || body[key] === '' ? null : string(body[key]);
    const whisperModelPath = pathValue('whisperModelPath'), shortcutConfigPath = pathValue('shortcutConfigPath');
    const revision = integer(body.revision), videoMaxMinutes = integer(body.videoMaxMinutes), videoMaxBytes = integer(body.videoMaxBytes);
    let shortcuts;
    try { shortcuts = await loadShortcutConfiguration(shortcutConfigPath ?? undefined); } catch (error) {
      if (error instanceof ConfigError && body.requestId !== undefined) {
        // 历史回执查询不依赖旧快捷方式路径仍可读；只回执原候选，不保存、不安装。
        const operation = services.toolSettings.operation(requestId, runtime());
        const stored = services.toolSettings.storedCandidate(requestId);
        if (operation && stored) {
          if (operation.status === 'conflict') throw new CoreError('SETTINGS_CONFLICT', '该请求编号此前因设置版本冲突未保存；请重新读取当前设置后使用新的请求编号。', 409);
          if (stored.whisperModelPath === whisperModelPath && stored.shortcutConfigPath === shortcutConfigPath
            && stored.videoMaxMinutes === videoMaxMinutes && stored.videoMaxBytes === videoMaxBytes
            && operation.expectedRevision === revision) {
            res.json({ ...services.toolSettings.get(), operation,
              warning: '原快捷方式配置文件当前不可读；本次只回执原操作，未重新读取、保存或安装新候选。' });
            return;
          }
          throw new CoreError('SETTINGS_REQUEST_CONFLICT', '同一请求编号已用于不同设置内容，本次未覆盖当前设置；请重新读取并使用新的请求编号。', 409);
        }
      }
      if (error instanceof ConfigError) throw new CoreError('INVALID_SETTINGS', error.message, 400);
      throw error;
    }
    const candidate = { whisperModelPath, shortcutConfigPath, shortcuts,
      videoMaxMinutes, videoMaxBytes };
    // 准备阶段只校验并固定候选；同一 requestId 重放不会再写库或覆盖后续修订。
    const prepared = services.toolSettings.prepareOperation(requestId, candidate, revision, runtime);
    if (prepared.replay) { res.json({ ...services.toolSettings.get(), operation: prepared.operation() }); return; }
    // 已保存但未采用的原操作先核对原事实：被后续修订替代时只回执，不准备、不安装旧候选。
    let committed = prepared.saved ? prepared.commit() : null;
    if (committed && !committed.adoptable) {
      res.json({ ...committed.value, operation: committed.operation,
        warning: '原操作已由后续修订替代，本次未安装旧候选；当前以持久最新设置为准。' });
      return;
    }
    let install;
    try {
      if (whisperModelPath && !services.toolSettings.isBundledWhisperModelPath(whisperModelPath)) direct.assertPublicPath(whisperModelPath);
      install = direct.prepareConfiguration({ whisperModelPath: whisperModelPath ?? undefined, shortcuts, shortcutConfigPath: shortcutConfigPath ?? undefined,
        videoMaxMinutes: candidate.videoMaxMinutes, videoMaxBytes: candidate.videoMaxBytes });
    } catch (error) {
      if (committed) {
        // 原操作已经持久保存；准备失败只表示本次未采用，不能伪报“尚未保存”。
        prepared.failed(error instanceof Error ? error.message : '运行时配置准备失败。');
        res.json({ ...committed.value, operation: prepared.operation(),
          warning: '设置此前已保存；本次运行时配置准备失败，未能采用新值，也未回退声称旧值仍生效。' });
        return;
      }
      services.toolSettings.discard(requestId);
      throw new CoreError('SETTINGS_NOT_PREPARED', `运行时配置准备失败，设置尚未保存：${error instanceof Error ? error.message : '未知原因'}`, 503);
    }
    if (!committed) {
      if (!core.healthy) throw new CoreError('STORAGE_UNAVAILABLE', '设置尚未保存，请稍后重试。', 503);
      committed = prepared.commit();
      // 旧操作只核对原事实：保存修订已被后续修订替代时，绝不再次安装旧候选。
      if (!committed.adoptable) {
        res.json({ ...committed.value, operation: committed.operation,
          warning: '原操作已由后续修订替代，本次未安装旧候选；当前以持久最新设置为准。' });
        return;
      }
    }
    const value = committed.value;
    try {
      install();
    } catch (error) {
      // 持久提交已成事实，但安装异常时运行时可能已部分或全部变化，不能声称旧值仍生效。
      prepared.failed(error instanceof Error ? error.message : '运行时采用失败。');
      const operation = prepared.operation();
      const actual = operation.loadedMatches === true ? '运行时实际配置已等于本次候选（安装已生效但动作报告异常）'
        : operation.loadedMatches === false ? '运行时实际配置仍不等于本次候选'
          : '当前运行时有效配置无法核对';
      res.json({ ...value, operation,
        warning: `设置已保存；安装过程异常，${actual}；不能据此声称旧值仍在生效，请重启或重新读取后核对。` });
      return;
    }
    try {
      prepared.adopted(value);
    } catch {
      // 安装已经成功，只有采用回执写入失败，不能误报成安装失败。
      res.json({ ...value, operation: prepared.operation(),
        warning: '设置已保存并已安装到当前运行时；采用回执写入失败，重启后按运行时有效配置核对。' });
      return;
    }
    res.json({ ...value, operation: prepared.operation() });
  });
  router.get('/personal-resources', (_req, res) => res.json({ resources: services.personalResources.list(), selection: services.personalResources.getSelection() }));
  router.post('/personal-resources', (req, res) => {
    const body = object(req.body); exact(body, ['title', 'body']);
    const title = string(body.title), text = string(body.body), id = `harness-agent-${randomUUID()}`;
    res.status(201).json(services.personalResources.register({ id, profileId: id, kind: 'persona', title, body: text,
      originalBody: text, version: 1, enabled: true, adaptationNotes: ['本机用户明确创建内置 Agent 人设；不增加任何权限。'],
      source: { kind: 'user', identifier: 'local-operator', revision: '1', contentHash: resourceContentHash(text) } }));
  });
  router.post('/personal-resources/selection', (req, res) => {
    const b = object(req.body); exact(b, ['personaId', 'personaVersion', 'revision']);
    res.json(services.personalResources.selectDefault(b.personaId === null ? null : string(b.personaId), b.personaVersion === null ? null : integer(b.personaVersion), integer(b.revision)));
  });
  router.post('/personal-resources/import/preview', async (req, res) => {
    const b = object(req.body); exact(b, ['directory']);
    direct.assertPublicPath(string(b.directory));
    res.json(await previewResourceImport(string(b.directory)));
  });
  router.post('/personal-resources/import/commit', async (req, res) => {
    const b = object(req.body); exact(b, ['directory', 'digest', 'selectedIds']);
    if (!Array.isArray(b.selectedIds) || b.selectedIds.some((id) => typeof id !== 'string')) throw new CoreError('INVALID_IMPORT', '请选择本次导入的条目。', 400);
    direct.assertPublicPath(string(b.directory));
    res.json(await commitResourceImport(string(b.directory), string(b.digest), b.selectedIds as string[], services));
  });
  router.get('/personal-resources/:id', (req, res) => res.json({ resource: services.personalResources.get(req.params.id), versions: services.personalResources.versions(req.params.id) }));
  router.post('/personal-resources/:id/revise', (req, res) => {
    const b = object(req.body); exact(b, ['version', 'body', 'title']);
    res.json(services.personalResources.revise(req.params.id, integer(b.version), string(b.body), b.title === undefined ? undefined : string(b.title)));
  });
  router.post('/personal-resources/:id/enabled', (req, res) => {
    const b = object(req.body); exact(b, ['enabled', 'revision']);
    if (typeof b.enabled !== 'boolean') throw new CoreError('INVALID_RESOURCE', '启用状态无效。', 400);
    res.json(services.personalResources.setEnabled(req.params.id, b.enabled, integer(b.revision)));
  });
  router.get('/agent-skills', (_req, res) => res.json(services.agentSkills.list()));
  router.get('/agent-skills/:id', (req, res) => res.json({ skill: services.agentSkills.get(req.params.id), versions: services.agentSkills.versions(req.params.id) }));
  router.post('/agent-skills/:id/enabled', (req, res) => {
    const body = object(req.body);
    if (typeof body.enabled !== 'boolean' || Object.keys(body).some((key) => key !== 'enabled' && key !== 'revision')) {
      throw new CoreError('INVALID_SKILL_SETTING', '技能设置只接受是否启用和当前版本。', 400);
    }
    res.json(services.agentSkills.setEnabled(req.params.id, body.enabled, integer(body.revision)));
  });
  router.get('/files', (req, res) => {
    const conversationId = optionalString(req.query.conversationId), query = optionalString(req.query.query);
    if (conversationId) core.getState(conversationId);
    const filter = { ...(conversationId ? { conversationId } : {}), limit: 300 };
    res.json((query ? files.searchRefs(query, filter) : files.getRefs(filter)).map(presentFile));
  });
  router.post('/files', (req, res) => {
    const body = object(req.body), path = string(body.path), conversationId = optionalString(body.conversationId);
    if (conversationId) core.getState(conversationId);
    direct.assertPublicPath(path);
    res.status(201).json(files.register({ path, source: 'user-selected', ...(conversationId ? { conversationId } : {}) }));
  });
  router.post('/files/upload', (req, _res, next) => {
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new CoreError('INVALID_UPLOAD', '附件不接受压缩的请求正文。', 400);
    if (Number(req.headers['content-length']) > FILE_TRANSFER_LIMIT) throw new CoreError('UPLOAD_TOO_LARGE', '附件上限为 25 MB；更大的文件请登记本机路径。', 413);
    next();
  }, express.raw({ type: 'application/octet-stream', limit: FILE_TRANSFER_LIMIT, inflate: false }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new CoreError('INVALID_UPLOAD', '请选择一个非空文件。', 400);
    const conversationId = string(req.query.conversationId), name = string(req.query.name);
    core.getState(conversationId);
    if (!name.trim() || name === '.' || name === '..' || name.length > 512 || name !== basename(name) || /[\\\u0000-\u001f\u007f]/u.test(name)) throw new CoreError('INVALID_FILE_NAME', '文件名无效。', 400);
    const suffix = extname(name).slice(0, 20).replace(/[^.a-zA-Z0-9_-]/g, '');
    const localName = `${randomUUID()}${suffix}`, path = join(services.attachmentRoot, localName);
    direct.assertPublicPath(path, true);
    const owner = await root(services.attachmentRoot, { symlinks: 'reject', mutationSymlinks: 'reject', hardlinks: 'reject' });
    await owner.create(localName, req.body, { atomic: true, private: true, durable: 'file',
      assertBeforeMutation: () => { if (!core.healthy) throw new CoreError('STORAGE_UNAVAILABLE', '存储暂时不可用，附件未确认保存。', 503); direct.assertPublicPath(path, true); } });
    // 登记失败时保留已发布附件，不能盲删可能被另一动作替换的路径。
    direct.assertPublicPath(path);
    const reference = files.register({ path, source: 'user-attached', displayName: name, conversationId });
    const stored = await readPinnedFile(owner, localName, reference, () => { direct.assertPublicPath(path); files.verify(reference.id); });
    if (!stored.equals(req.body)) throw new CoreError('UPLOAD_CHANGED', '附件落盘后的字节未能核对，请重新查看文件状态。');
    res.status(201).json(reference);
  });
  router.post('/files/:id/observe', (req, res) => res.json(files.observe(req.params.id)));
  router.get('/files/:id', (req, res) => res.json(presentFile(files.getRef(req.params.id))));
  router.get('/artifacts/:id/download', async (req, res) => {
    const controller = new AbortController(), stop = () => controller.abort();
    res.once('close', stop);
    try {
      const { reference, buffer } = await readArtifactForDownload(services, req.params.id, controller.signal);
      if (res.destroyed) return;
      res.type('application/octet-stream').set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(reference.displayName)}`).send(buffer);
    } finally { res.off('close', stop); }
  });

  router.get('/conversations/:id/direct-messages', (req, res) => {
    res.json(services.directConversations.list(req.params.id, optionalString(req.query.before), req.query.limit === undefined ? 40 : Number(req.query.limit)));
  });
  router.get('/tasks', (req, res) => res.json(tasks.list({ conversationId: optionalString(req.query.conversationId) })));
  router.get('/tasks/completions', (_req, res) => res.json(services.taskCompletions?.status() ?? { available: false }));
  router.get('/tasks/events', (req, res) => {
    const conversationId = optionalString(req.query.conversationId);
    if (conversationId) core.getState(conversationId);
    res.status(200).set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const write = (payload: unknown) => {
      if (res.destroyed) return;
      if (res.writableLength > 1_048_576) { res.destroy(); return; }
      res.write(`event: tasks\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    const unsubscribe = tasks.subscribe((envelope) => {
      if (!conversationId || envelope.task.conversationId === conversationId) write(envelope);
    });
    write({ tasks: tasks.list({ conversationId }) });
    const timer = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15_000); timer.unref();
    req.on('close', () => { clearInterval(timer); unsubscribe(); });
  });
  router.get('/tasks/:id', (req, res) => {
    const task = tasks.get(req.params.id), runs = tasks.getRuns(task.id);
    res.json({ task, runs, attempts: runs.flatMap((run) => tasks.getAttempts(run.id)), events: tasks.events(task.id) });
  });
  router.post('/tasks', (req, res) => {
    const body = object(req.body), action = string(body.action), conversationId = optionalString(body.conversationId);
    exact(body, ['title', 'action', 'args', 'conversationId', 'requestId', 'dependencies', 'reviewRequired', 'completionSourceCommandId', 'deadlineAt']);
    if (conversationId) core.getState(conversationId);
    const routed = direct.registry.route({ action, args: body.args });
    if (conversationId && core.getState(conversationId).pluginId === 'direct' && routed.runtimeId !== 'direct') {
      throw new CoreError('PLUGIN_ACTION_MISMATCH', '本机插件只接受本机直接动作，请在 Pi（智能对话）中创建智能任务。', 400);
    }
    const deadlineAt = body.deadlineAt === undefined ? undefined : integer(body.deadlineAt);
    const sourceCommandId = optionalString(body.completionSourceCommandId);
    if (sourceCommandId && !services.taskCompletions) throw new CoreError('COMPLETION_UNAVAILABLE', '此角色未装配会话完成通知。');
    const accepted = services.database.transaction(() => {
      const hasBudget = sourceCommandId ? services.database.connection.prepare('SELECT 1 FROM task_budgets WHERE scope=?').get(sourceCommandId) : null;
      const accepted = tasks.createInTransaction({ title: string(body.title), conversationId, requestId: string(body.requestId),
        runtimeId: routed.runtimeId, action: routed.action, args: routed.args,
        ...(routed.runtimeId === 'direct' ? { versions: direct.registry.captureVersions(routed.action, routed.args) } : {}),
        ...(sourceCommandId ? { budgetScope: sourceCommandId } : {}), ...(deadlineAt === undefined ? {} : { deadlineAt }),
        dependencies: body.dependencies as string[] | undefined, reviewRequired: body.reviewRequired as boolean | undefined });
      if (sourceCommandId) services.taskCompletions!.bind(accepted.task.id, sourceCommandId);
      if (sourceCommandId && !hasBudget) {
        const source = core.store.command(sourceCommandId);
        const prior = Number(services.database.connection.prepare('SELECT COUNT(*) AS n FROM model_requests WHERE parent_run_id=?').get(source.run_id)?.n ?? 0);
        if (prior) tasks.consumeBudget(accepted.task.id, { modelRequests: prior });
      }
      return accepted;
    });
    accepted.publish();
    const created = accepted.task;
    res.status(202).json(created.status === 'ready' ? tasks.start(created.id, created.version) : created);
  });
  router.post('/tasks/:id/command', async (req, res) => {
    const body = object(req.body), command = string(body.command), task = tasks.get(req.params.id);
    if (command === 'pause' || command === 'cancel') {
      exact(body, ['command', 'generation', 'runId']);
      if (body.generation !== task.generation || body.runId !== task.currentRunId) throw new CoreError('STALE_RUN', '操作属于较早的任务运行，请查看当前状态。');
      res.json(await (command === 'pause' ? tasks.pause(task.id) : tasks.cancel(task.id)));
    } else {
      exact(body, command === 'block' || command === 'reject' ? ['command', 'version', 'reason']
        : command === 'dependencies' ? ['command', 'version', 'dependencies'] : ['command', 'version']);
      const version = integer(body.version);
      if (body.version !== task.version) throw new CoreError('TASK_VERSION_CONFLICT', '任务状态已经变化，请重新查看。');
      if (command === 'start') res.json(tasks.start(task.id, version));
      else if (command === 'resume') res.json(tasks.resume(task.id, version));
      else if (command === 'retry') res.json(tasks.retry(task.id, version));
      else if (command === 'block') res.json(tasks.block(task.id, string(body.reason), version));
      else if (command === 'unblock') res.json(tasks.unblock(task.id, version));
      else if (command === 'accept') res.json(tasks.acceptReview(task.id, version));
      else if (command === 'reject') res.json(tasks.rejectReview(task.id, string(body.reason), version));
      else if (command === 'dependencies') res.json(tasks.setDependencies(task.id, body.dependencies as string[], version));
      else throw new CoreError('INVALID_COMMAND', '任务操作无效。', 400);
    }
  });
  router.post('/tasks/:id/reconcile', (req, res) => {
    const body = object(req.body), task = tasks.get(req.params.id);
    exact(body, ['version', 'outcome', 'evidence']);
    const version = integer(body.version);
    if (body.version !== task.version) throw new CoreError('TASK_VERSION_CONFLICT', '任务状态已经变化，请重新核对。');
    res.json(tasks.reconcile(task.id, { outcome: string(body.outcome) as 'succeeded' | 'failed' | 'not_applied', evidence: string(body.evidence) }, version));
  });
  router.post('/tasks/:id/recover', async (req, res) => {
    const body = object(req.body); exact(body, ['version']);
    const task = tasks.get(req.params.id);
    if (task.version !== integer(body.version)) throw new CoreError('TASK_VERSION_CONFLICT', '原任务已变化，请先读回状态。');
    res.json(await tasks.recover(task.id));
  });
  router.use(createApprovalRouter(services, services.options.workspaceServices));
  router.get('/permissions', (_req, res) => res.json(permissions.listGrants({ includeRevoked: true })));
  router.get('/permissions/snapshot', (_req, res) => res.json({ grants: permissions.listGrants({ includeRevoked: true }), policyVersion: permissions.policyVersion }));
  router.post('/permissions/:id/revoke', (req, res) => res.json({ revoked: permissions.revoke(req.params.id) }));
  router.post('/permissions/:id/restore', (req, res) => {
    const body = object(req.body);
    if (Object.keys(body).some((key) => key !== 'policyVersion')) throw new CoreError('INVALID_RESTORE', '只能恢复这条规则原先的权限范围。', 400);
    if (integer(body.policyVersion) !== permissions.policyVersion) throw new CoreError('POLICY_CHANGED', '权限规则已变化，请重新查看后再恢复。');
    const previous = permissions.getGrant(req.params.id);
    if (!previous.revoked || previous.scope.kind !== 'persistent' || previous.effect !== 'allow') throw new CoreError('INVALID_RESTORE', '只有已撤销的持续允许规则可以恢复。', 400);
    res.status(201).json(permissions.grant({ capabilities: previous.capabilities, scope: { kind: 'persistent' }, label: previous.label ?? undefined }));
  });

  router.get('/memory', (req, res) => res.json(memory.list({ query: optionalString(req.query.query), includeInactive: req.query.history === 'true' })));
  router.get('/memory/export', (_req, res) => res.type('application/json').set('Content-Disposition', 'attachment; filename="mashiro-memory.json"').send(JSON.stringify(memory.export(), null, 2)));
  router.get('/memory/:id', (req, res) => res.json({ record: memory.get(req.params.id), history: memory.history(req.params.id) }));
  router.post('/memory/source/message', (req, res) => {
    const body = object(req.body);
    res.json(services.sourceForMessage(string(body.conversationId), string(body.messageId)));
  });
  router.post('/memory', (req, res) => {
    const body = object(req.body);
    if (body.candidate !== undefined && typeof body.candidate !== 'boolean') throw new CoreError('INVALID_MEMORY', '记忆状态无效。', 400);
    res.status(201).json(memory.create(object(body.input) as unknown as MemoryInput, string(body.requestId), { candidate: body.candidate as boolean | undefined }));
  });
  router.put('/memory/:id', (req, res) => {
    const body = object(req.body);
    res.json(memory.update(req.params.id, integer(body.version), object(body.input) as unknown as MemoryInput));
  });
  router.post('/memory/:id/confirm', (req, res) => res.json(memory.confirm(req.params.id, integer(object(req.body).version))));
  router.post('/memory/:id/reject', (req, res) => res.json(memory.reject(req.params.id, integer(object(req.body).version))));
  router.post('/memory/:id/resolve', (req, res) => {
    const body = object(req.body);
    if (!Array.isArray(body.supersede)) throw new CoreError('INVALID_MEMORY', '请明确选择冲突记录。', 400);
    const supersede = body.supersede.map((value: unknown) => { const entry = object(value); return { id: string(entry.id), version: integer(entry.version) }; });
    res.json(memory.resolveConflict(req.params.id, integer(body.version), supersede));
  });
  router.get('/memory/:id/forget-preview', (req, res) => res.json(memory.previewForget(req.params.id)));
  router.post('/memory/:id/forget', (req, res) => res.json(memory.forget(req.params.id, string(object(req.body).digest))));
  return router;

  function presentFile(reference: ReturnType<typeof files.getRef>) {
    const path = relative(services.artifactRoot, reference.canonicalPath);
    const downloadable = reference.kind === 'file' && reference.source === 'generated' && reference.relations.some((relation) => relation.kind === 'artifact')
      && !!path && !path.startsWith('..') && !path.startsWith('/') && reference.size <= FILE_TRANSFER_LIMIT;
    return { ...reference, downloadUrl: downloadable ? `/api/artifacts/${encodeURIComponent(reference.id)}/download` : null };
  }
}

/** 下载只返回同一登记对象的稳定快照；路径的后验核对不能替代已打开句柄的身份核对。 */
export async function readArtifactForDownload(services: Pick<ApplicationServices, 'files' | 'direct' | 'artifactRoot'>, id: string, signal?: AbortSignal) {
  const reference = services.files.verify(id);
  if (reference.source !== 'generated' || !reference.relations.some((relation) => relation.kind === 'artifact') || reference.kind !== 'file') {
    throw new CoreError('NOT_DOWNLOADABLE', '此结果不是可下载的应用产物。', 400);
  }
  const path = relative(services.artifactRoot, reference.canonicalPath);
  if (!path || path.startsWith('..') || path.startsWith('/')) throw new CoreError('NOT_DOWNLOADABLE', '此结果位于用户目录，请使用文件动作打开。', 400);
  const verify = () => { signal?.throwIfAborted(); services.direct.assertPublicPath(reference.invocationPath); services.files.verify(id); };
  verify();
  const owner = await root(services.artifactRoot, { symlinks: 'reject', hardlinks: 'reject' });
  return { reference, buffer: await readPinnedFile(owner, path, reference, verify) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_BODY', '请求正文格式无效。', 400);
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new CoreError('INVALID_BODY', '请求字段需要文本。', 400);
  return value;
}
function optionalString(value: unknown): string | undefined { return value === undefined ? undefined : string(value); }
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new CoreError('INVALID_BODY', '请求版本无效。', 400);
  return Number(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) throw new CoreError('INVALID_BODY', '请求含未知字段。', 400); }
