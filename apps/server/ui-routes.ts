import { Router } from 'express';
import { join } from 'node:path';
import { CoreError } from '../../platform/runtime/errors.js';
import { normalizeAttachmentRefs } from '../../modules/agent/state/store.js';
import { DATABASE_PORT_RESERVATION } from '../../adapters/database/data-service-port.js';
import type { ApplicationServices } from './services.js';
import type { UiIndicator, UiRuntimeView, UiSettingsView, UiStopResult } from '../../contracts/ui-contracts.js';
import type { ConversationAttachmentRef, RunSummary } from '../../contracts/contracts.js';

/** 仅展示和调用原有权威服务；这里不探测网络，不维护第二份任务或连接状态。 */
export function createUiRouter(services: ApplicationServices) {
  const router = Router();
  const companion = services.options.workspaceServices;
  const owners = [services, ...(companion ? [companion] : [])];
  const materialLinksExist = () => !!services.core.store.one("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_material_links'");
  function draftReference(fileRefId: string, version: number): ConversationAttachmentRef {
    const file = services.files.verify(fileRefId); services.direct.assertPublicPath(file.invocationPath);
    if (file.version !== version) throw new CoreError('STALE_ATTACHMENT', '文件版本已变化，请重新选择。');
    if (file.kind !== 'file' || !['user-attached', 'user-selected'].includes(file.source)) throw new CoreError('INVALID_ATTACHMENT_SOURCE', '只有已登记的用户原件可作为附件加入草稿。', 400);
    const link = materialLinksExist() ? services.core.store.one<{ material_id: string; sha256: string }>(
      'SELECT material_id,sha256 FROM conversation_material_links WHERE file_ref_id=? AND file_ref_version=?', file.id, file.version) : undefined;
    let category: ConversationAttachmentRef['category'] = 'unclassified';
    if (link) {
      if (!companion?.materials) throw new CoreError('MATERIAL_REFERENCE_UNAVAILABLE', '原件既有保管身份暂时无法核对，请恢复原材料服务后再带入。');
      const original = companion.materials.get(link.material_id).envelope;
      if (original.sha256 !== link.sha256) throw new CoreError('MATERIAL_REFERENCE_UNAVAILABLE', '原件与既有材料绑定未能核对。');
      category = original.category;
    }
    return { fileRefId: file.id, version: file.version, category, displayName: file.displayName };
  }
  const currentRuns = (): RunSummary[] => services.core.store.all<{ conversation_id: string }>(
    "SELECT conversation_id FROM runs WHERE state IN ('starting','running','stopping') ORDER BY started_at")
    .map(row => services.core.getState(row.conversation_id).lastRun!).filter(Boolean);
  function indicators(): UiIndicator[] {
    const now = new Date().toISOString();
    const financial = companion?.financial ?? services.financial;
    const sourceSettings = services.sourceSettings.get(), checks = services.sourceSettings.checks();
    const enabledSourceIds = [...sourceSettings.connections.filter(item => item.enabled && sourceSettings.plugins.some(plugin => plugin.id === item.pluginId && plugin.enabled)).map(item => item.id),
      ...sourceSettings.capture.filter(item => item.enabled).map(item => item.sourceId)];
    const currentChecks = checks.filter(check => enabledSourceIds.includes(check.id));
    const passed = currentChecks.filter(check => check.status === 'passed').length, failed = currentChecks.filter(check => check.status === 'blocked').length;
    const sourceStatus: UiIndicator['status'] = passed ? 'partial' : failed ? 'failed' : 'unknown';
    const sourceIssues = currentChecks.filter(check => check.status !== 'passed').map(check => `${check.id}：${check.reason}`);
    if (enabledSourceIds.some(id => !checks.some(check => check.id === id))) sourceIssues.push('部分启用来源尚未检查，连接声明不代表实际可用。');
    if (passed) sourceIssues.push('已通过检查的端点可达与授权已核验；其他能力及数据及时性仍须按任务核对。');
    if (!enabledSourceIds.length) sourceIssues.push('所有来源连接与采集源均已停用。');
    const toolState = financial?.status();
    const toolLibrary = companion?.toolLibrary ?? services.toolLibrary;
    const algorithms = companion?.algorithms ?? services.algorithms;
    // 这里只读采用账本；完整目录可能解析大表，不由运行态轮询触发。
    const adoption = algorithms?.adoptionStatus();
    const hasToolLibrary = !!toolLibrary || !!algorithms || !!toolState;
    const database = (companion?.r1Workspace ?? services.r1Workspace)?.capabilities();
    const selectedDatabase = database?.connection;
    return [
      { id: 'data_sources', name: '数据源', status: sourceStatus,
        source: 'sourceSettings.checks', scope: '共享来源配置与最近实际检查；此状态读取不发起网络调用',
        checkedAt: currentChecks.map(check => check.checkedAt).sort().at(-1) ?? null, observedAt: now, staleAfterMs: 5 * 60_000,
        issues: sourceIssues, settingsTarget: 'sources' },
      { id: 'database', name: '数据库', status: selectedDatabase ? 'unknown' : 'missing',
        source: selectedDatabase ? `r1.capabilities:${selectedDatabase.connectionId}:${selectedDatabase.profile}` : `DatabasePort:${DATABASE_PORT_RESERVATION.code}`,
        scope: selectedDatabase ? `已装配连接 ${selectedDatabase.connectionId}，范围 ${selectedDatabase.profile}，用途 ${selectedDatabase.mode}；材料提交与质量须分别核对` : '当前没有已装配的数据库连接', checkedAt: null, observedAt: now, staleAfterMs: null,
        issues: [selectedDatabase ? '连接已装配；本次状态读取不发起网络或权限探测。' : '数据库连接尚未装配。'], settingsTarget: 'storage' },
      { id: 'tool_library', name: '工具库', status: hasToolLibrary ? 'unknown' : 'missing',
        source: algorithms ? 'algorithms.adoptionStatus' : toolLibrary ? 'toolLibrary.registry' : toolState ? 'financial.plugins.status' : 'missing: algorithm catalog',
        scope: '基础算法目录装配与采用状态；输入、权限、真实执行和发布资格仍须分别核对',
        checkedAt: null, observedAt: now, staleAfterMs: null,
        issues: [adoption ? adoption.state === 'adopted'
          ? '基础算法目录与受控入口已装配，采用记录与当前实现一致；本次状态读取未核验输入、执行权限或真实运行结果。'
          : `基础算法目录与受控入口已装配；${adoption.reason ?? '尚未核对采用状态。'}`
          : toolLibrary ? '只读基础算法目录已装配；受控计算入口尚未装配。'
            : toolState ? toolState.enabled ? '金融插件已启用；未提供当前运行依赖的综合检查时间。' : '金融插件已登记但未启用。'
              : '基础算法目录未装配。'], settingsTarget: 'plugins' },
    ];
  }
  function runtime(): UiRuntimeView {
    const personal = services.tasks.getControl(), workspace = companion?.tasks.getControl() ?? null;
    const activeRuns = currentRuns();
    const activeTaskIds = new Set([...personal.activeTaskIds, ...(workspace?.activeTaskIds ?? [])]);
    const standaloneRuns = activeRuns.filter(run => {
      const taskId = services.core.store.run(run.id).task_id;
      return !taskId || !activeTaskIds.has(taskId);
    });
    const stoppingTasks = owners.flatMap(owner => owner.core.store.all<{ id: string }>(
      "SELECT id FROM tasks WHERE status IN ('pausing','cancelling')").map(row => row.id));
    return { indicators: indicators(), control: { stopped: personal.stopped || !!workspace?.stopped,
      persisted: personal.persisted && (workspace?.persisted ?? true),
      activeCount: standaloneRuns.length + activeTaskIds.size, pendingCount: standaloneRuns.filter(run => run.state === 'stopping').length + new Set(stoppingTasks).size,
      personal, workspace }, activeRuns, observedAt: new Date().toISOString() };
  }
  router.get('/preferences', (_req, res) => res.json(services.uiPreferences.get()));
  router.put('/preferences', (req, res) => {
    if (!services.core.healthy) throw new CoreError('STORAGE_UNAVAILABLE', '偏好尚未保存，当前仍使用旧值。', 503);
    res.json(services.uiPreferences.update(object(req.body) as unknown as Parameters<typeof services.uiPreferences.update>[0]));
  });
  router.get('/runtime', (_req, res) => res.json(runtime()));
  router.get('/custom-sources', async (_req, res) => res.json({ sources: services.customSources ? await services.customSources.list() : [] }));
  router.get('/settings', (_req, res) => {
    const health = services.options.health, thinking = services.core.getState().thinking;
    const tools = services.direct.registry.list(), collection = companion?.collection ?? services.collection;
    const selectedRuntime = companion?.r1Runtime ?? services.r1Runtime;
    const selectedDatabase = (companion?.r1Workspace ?? services.r1Workspace)?.capabilities().connection;
    const settings: UiSettingsView = {
      model: { id: health.model, displayName: health.displayName ?? health.model,
        provider: health.provider, configured: health.configured, availability: health.configured ? 'not_probed' : 'not_configured',
        endpoint: publicEndpoint(services.options.modelConnection?.endpoint), protocol: services.options.modelConnection?.protocol ?? null,
        supportedThinkingLevels: [...(thinking?.supportedLevels ?? [])], configurationVersion: services.options.modelConfigurationVersion ?? null,
        credential: { configured: !!services.options.credentialReference, referenceName: services.options.credentialReference?.name ?? null, secretExposed: false } },
      storage: [
        location('attachments', 'data', '附件草稿与原件工作副本', services.attachmentRoot),
        location('artifacts', 'data', '本机任务产物', services.artifactRoot),
        location('core', 'system', '会话、草稿、配置、人设、任务、权限和恢复记录', services.database.path, 'local', 'managed'),
        location('model-config', 'system', '模型连接配置；凭据仅显示受保护引用', join(services.options.resources?.path('config') ?? join(services.options.projectRoot, 'config'), 'model.json')),
        location('tools', 'tools', '受控工具实现与锁定依赖', services.options.codeRoot ?? services.options.projectRoot),
        location('tool-settings', 'tools', '通用工具设置；与会话配置共用核心存储', services.database.path),
        location('sources', 'sources', '收集输入、分页状态与处理证据；来源定义由受信宿主登记', collection ? (companion ?? services).database.path : null),
        location('database', 'database', selectedDatabase ? `已装配数据库连接 ${selectedDatabase.connectionId}；范围 ${selectedDatabase.profile}；用途 ${selectedDatabase.mode}` : '外部数据库连接尚未装配', selectedRuntime?.connection.store ?? null, 'external', 'not_checked'),
        location('evidence', 'evidence', '本机任务回执、尝试结果与证据关联；与任务状态共用核心存储', services.database.path),
        ...(companion ? [location('workspace-core', 'system', '本Bd服务任务与独立控制记录', companion.database.path, 'workspace_service'),
          location('workspace-materials', 'data', '材料服务原件工作副本', companion.attachmentRoot, 'workspace_service'),
          location('workspace-artifacts', 'evidence', '材料与金融工具产物', companion.artifactRoot, 'workspace_service')] : []),
      ],
      sources: { status: 'registered', source: 'sourceSettings',
        note: '接口连接、主备组合与已登记站点采集共用一份设置；可用性按最近实际检查与原任务结果分别核对。',
        items: services.sourceSettings.get().connections.map(({ id, pluginId, alias, enabled, scopes }) => ({ id, pluginId, alias, enabled, scopes })) },
      plugins: tools.filter(tool => ['material.ocr', 'material.transcribe'].includes(tool.action)).map(tool => ({
        id: tool.action, title: tool.title, available: tool.availability.available, reason: tool.availability.reason ?? null, source: 'direct.registry' })),
      security: { policyVersion: services.permissions.policyVersion, grantCount: services.permissions.listGrants().length,
        pendingApprovalCount: services.permissions.listApprovals().filter(item => item.status === 'pending').length, secretExposed: false },
      advanced: { schemaVersions: services.core.store.all<{ module: string; version: number }>('SELECT module,version FROM schema_versions ORDER BY module'),
        backgroundExecution: 'requires_running_service', recovery: '重启核对原任务；不自动发送草稿、解除全局停止或重新派发未知结果。' },
    };
    res.json(settings);
  });
  router.post('/stop', async (req, res) => {
    const body = object(req.body); exact(body, ['scope', 'conversationId', 'runId']);
    if (body.scope !== 'all' && body.scope !== 'current') throw new CoreError('INVALID_STOP', '请选择本轮或全部停止。', 400);
    const issues: string[] = [];
    if (body.scope === 'current') {
      if (typeof body.conversationId !== 'string' || typeof body.runId !== 'string') throw new CoreError('INVALID_STOP', '本轮停止需要原会话和运行编号。', 400);
      if (services.core.store.run(body.runId).conversation_id !== body.conversationId) throw new CoreError('STALE_RUN', '运行编号不属于此会话。');
      await services.core.abort(body.runId, body.conversationId);
    } else {
      if (body.conversationId !== undefined || body.runId !== undefined) throw new CoreError('INVALID_STOP', '全部停止不接受外部任务或运行范围。', 400);
      const controls = await Promise.allSettled(owners.map(owner => owner.tasks.stopControl('本机用户请求全部停止本 BD。')));
      controls.forEach(result => { if (result.status === 'rejected') issues.push(result.reason instanceof Error ? result.reason.message : '停止记录未确认。'); });
      // abort先同步收紧活动run，响应不把尚待远端取消收束的任务说成已停止。
      for (const run of currentRuns()) void services.core.abort(run.id, run.conversationId).catch(() => {});
      const unresolved = owners.reduce((count, owner) => count + Number(owner.core.store.one<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tasks WHERE requires_review=1 OR status='needs_review'")!.count), 0);
      if (unresolved) issues.push(`本 BD 有 ${unresolved} 个任务结果待核；本地停止不代表远端结果已确认。`);
    }
    const view = runtime();
    const confirmed = body.scope === 'current'
      ? !['starting', 'running', 'stopping'].includes(services.core.store.run(String(body.runId)).state)
      : !view.control.activeCount && !issues.length;
    res.json({ ...view, scope: body.scope, confirmed, issues } satisfies UiStopResult);
  });
  router.post('/resume', async (req, res) => {
    const body = object(req.body); exact(body, ['personalGeneration', 'workspaceGeneration']);
    const view = runtime();
    if (view.control.activeCount) throw new CoreError('CONTROL_BUSY', '本 BD 仍有未收束任务，请先核对实际结果。');
    if (body.personalGeneration !== view.control.personal.generation || (companion && body.workspaceGeneration !== view.control.workspace?.generation)
      || (!companion && body.workspaceGeneration !== undefined)) throw new CoreError('CONTROL_GENERATION_CONFLICT', '停止状态已变化，请重新核对后再恢复。');
    try {
      if (companion) companion.tasks.resumeControl(Number(body.workspaceGeneration), '本机用户明确恢复本 BD 新增派发。');
      services.tasks.resumeControl(Number(body.personalGeneration), '本机用户明确恢复本 BD 新增派发。');
      companion?.segments?.reconcileConversions();
      services.segments?.reconcileConversions();
    } catch {
      // 两个原角色状态库没有分布式事务；部分恢复失败立即同步收紧所有闸门。
      await Promise.allSettled(owners.map(owner => owner.tasks.stopControl('恢复结果未确认，本 BD 保持停止；请重新核对控制代次。')));
      throw new CoreError('CONTROL_RESUME_UNCONFIRMED', '恢复未能全部持久确认，本 BD 已重新请求停止；请核对当前控制状态后再恢复。', 503);
    }
    res.json(runtime());
  });
  router.get('/materials/:id/draft-reference', (req, res) => {
    const link = materialLinksExist() ? services.core.store.one<{ file_ref_id: string; file_ref_version: number }>(
      'SELECT file_ref_id,file_ref_version FROM conversation_material_links WHERE material_id=?', req.params.id) : undefined;
    if (!link) throw new CoreError('MATERIAL_REFERENCE_UNAVAILABLE', '此材料没有可供当前会话使用的原始文件引用。', 404);
    res.json(draftReference(link.file_ref_id, link.file_ref_version));
  });
  router.post('/draft-references', (req, res) => {
    const body = object(req.body); exact(body, ['conversationId', 'branchId', 'refs']);
    if (typeof body.conversationId !== 'string' || typeof body.branchId !== 'string') throw new CoreError('INVALID_DRAFT', '草稿归属无效。', 400);
    const state = services.core.getState(body.conversationId);
    if (state.pluginId !== 'pi' || state.visibility !== 'active' || state.branchId !== body.branchId || state.storageError) throw new CoreError('STALE_BRANCH', '会话或分支已变化，请在当前草稿重试。');
    const refs = normalizeAttachmentRefs(body.refs).map(ref => draftReference(ref.fileRefId, ref.version));
    for (const ref of refs) services.files.link(ref.fileRefId, { conversationId: state.conversationId });
    res.json(services.core.store.validateAttachmentRefs(state.conversationId, refs));
  });
  return router;
}

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_BODY', '请求正文必须是对象。', 400); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) throw new CoreError('INVALID_BODY', '请求包含当前操作不支持的字段。', 400); }
function publicEndpoint(value?: string): string | null {
  if (!value) return null;
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return null; url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
  catch { return null; }
}
function location(id: string, group: UiSettingsView['storage'][number]['group'], purpose: string, path: string | null,
  owner: UiSettingsView['storage'][number]['owner'] = 'local', access: UiSettingsView['storage'][number]['access'] = 'not_checked'): UiSettingsView['storage'][number] {
  return { id, group, purpose, location: path, owner, editable: false, access: path ? access : 'missing', version: null };
}
