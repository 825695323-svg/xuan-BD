import { Router } from 'express';
import { CoreError } from '../../platform/runtime/errors.js';
import { DATABASE_PORT_RESERVATION } from '../../adapters/database/data-service-port.js';
import type { TaskRecord } from '../../contracts/task-contracts.js';
import type { MaterialRecord } from '../../modules/collection/materials/contracts.js';
import type { ApplicationServices } from './services.js';

export interface DataBrowserPage<T> {
  items: T[];
  nextCursor: string | null;
  limit: number;
  query: string;
  availability: 'available' | 'unavailable';
  scope: string;
}
export interface OfficialLineIdentityView {
  connectionId: string; instanceId: string; principalId: string; mode: string; purpose: string;
  protocol: string; protocolRevision: string; schemaSha256: string; credentialReference: string;
  runtimeRoot: string; libraryRoot?: string; storageId?: string; harnessRootId?: string;
}
export interface OfficialLineView {
  revision: number; connectionId: string; previousConnectionId: string | null; pendingId: string | null;
  selected: OfficialLineIdentityView | null;
  registered: Array<OfficialLineIdentityView & { businessBound: boolean; genericBound: boolean }>;
  dispatchBlocked: boolean; businessLedgerReady: boolean; activeTaskIds: string[];
  unresolved: Array<{ id: string; state: string; requestId: string; instanceId: string; operation: string }>;
}
export interface OfficialPermissionView {
  operations: string[]; maxReadRows: number | null; timeCapability: string | null;
  productionEnabled: boolean; writeEnabled: boolean | null;
}
export interface OfficialDatasetView {
  datasetId: string; registered: boolean; readable: boolean; allowedPurposes: string[];
  headSnapshotId: string | null; snapshotIds: string[];
  contractVersion: string | null; mappingVersion: string | null;
  coverage: { complete: boolean; gaps: string[]; scope: string | null } | null;
}
export interface OfficialReadbackView { state: string; rows: number; rowsSha256: string }
export interface OfficialSnapshotView {
  productId: string; snapshotId: string; commitId: string; outputId: string; namespace: string | null;
  taskId: string; requestId: string; state: string; registered: boolean;
  coverage: { complete: boolean; gaps: string[]; scope: string | null } | null;
  custody: { state: string; byteLength: number; manifestSha256: string } | null;
  readback: OfficialReadbackView | null;
  issues: Array<{ code: string; message: string }>;
}
export interface OfficialCatalogItem { productId: string; namespace: string | null; snapshots: OfficialSnapshotView[] }
export interface OfficialCheckView {
  state: 'never' | 'passed' | 'failed'; checkedAt: string | null; revision: number | null;
  error: { code: string; message: string } | null;
  permissions: OfficialPermissionView | null;
  fixedRead: { state: 'verified'; datasetId: string; snapshotId: string; sha256: string }
    | { state: 'empty'; datasetIds: string[]; reason: string }
    | null;
}
export interface OfficialGenericGrantView {
  enabled: boolean; grantId: string | null; grantState: string | null;
  readNamespaces: string[]; writeNamespaces: string[]; createNamespaces: string[];
  purposes: string[];
}
export interface OfficialGenericProductView {
  productId: string; namespace: string | null; state: string | null; registered: boolean;
  /** 能力目录只报告当前头，不是完整历史快照集合。 */
  headSnapshotId: string | null; snapshotIds: string[];
  snapshotScope: 'head_only' | 'reported' | 'not_reported';
  registrationBasis: 'catalog_definition_and_declaration' | 'catalog_flag' | 'not_registered';
}
export interface OfficialGenericView {
  status: 'never' | 'passed' | 'failed'; checkedAt: string | null;
  contract: string | null; instanceId: string | null; purpose: string | null; mode: string | null;
  /** 实例/用途/模式来自选中线路身份，不是能力响应字段。 */
  identitySource: 'selected_line_binding' | null;
  operations: string[];
  grant: OfficialGenericGrantView | null;
  products: OfficialGenericProductView[]; productsTruncated: boolean;
  error: { code: string; message: string } | null;
}
export interface OfficialDataView {
  connection: 'unbound' | 'registered' | 'unreachable' | 'denied' | 'unavailable';
  code: string | null; reason: string | null; source: string;
  productionBinding: typeof DATABASE_PORT_RESERVATION.state;
  line: OfficialLineView | null;
  check: OfficialCheckView;
  generic: OfficialGenericView;
  catalog: { status: 'not_provided'; items: OfficialCatalogItem[]; reason: string };
  datasets: OfficialDatasetView[];
  checkedAt: string | null;
  observedAt: string;
}
export interface CandidateOutputView {
  outputId: string; namespace: string;
  productId: string | null; expectedSnapshotId: string | null;
  preparedState: string | null; state: string;
  commitId: string | null; snapshotId: string | null; registered: boolean;
  coverage: { complete: boolean; gaps: string[]; scope: string | null } | null;
  custody: { state: string; byteLength: number; manifestSha256: string } | null;
  readback: OfficialReadbackView | null;
  issues: Array<{ code: string; message: string }>;
}
export interface CandidateView {
  taskId: string; title: string; action: string; status: string; requestId: string;
  createdAt: number; updatedAt: number; parentTaskId: string | null;
  requiresReview: boolean; approvalId: string | null; blockedReason: string | null;
  progress: { message: string; fraction: number | null; timestamp: string } | null;
  error: { code: string; message: string } | null;
  database: {
    state: string; requestId: string | null; instanceId: string | null;
    error: { code: string; message: string } | null;
    receiptState: string | null; committed: number; storedNotCommitted: number; rejected: number;
  };
  outputs: CandidateOutputView[];
  actionability: { canSubmit: boolean; canResume: boolean; canCancel: boolean; canReconcile: boolean };
}
export interface ConversationCandidatePage {
  conversationId: string; branchId: string;
  items: CandidateView[]; availability: 'available' | 'unavailable';
  reason: string | null; scope: string;
}
export interface ProcessingStepView {
  stepId: string; outputId: string; kind: string; state: string;
  required: boolean; applicability: string | null; dependsOn: string[]; gaps: string[];
  outputDigest: string | null; output: { sha256: string; byteLength: number | null } | null;
  error: { code: string; message: string } | null;
  reusedFrom: { planId: string; stepId: string } | null;
}
export interface ProcessingOutputView {
  outputId: string; materialIds: string[]; intendedAction: string;
  target: { kind: 'product' | 'declaration' | 'none'; productId: string | null; expectedSnapshotId: string | null } | null;
  routingState: string; state: string; gaps: string[]; semanticGaps: string[];
  publishEligible?: boolean; publishAuthorization?: string; publishScope?: string;
  evidenceScope: string | null; steps: ProcessingStepView[];
}
export interface ProcessingMaterialView {
  materialId: string; filename: string; sha256: string; format: string; support: string;
  custodyState: string; routingState: string; gaps: string[];
}
export interface ProcessingPlanView {
  planId: string; requestId: string; parentPlanId: string | null; status: string;
  createdAt: number; updatedAt: number;
  materials: ProcessingMaterialView[]; outputs: ProcessingOutputView[]; steps: ProcessingStepView[];
}
export interface ProcessingTaskView {
  taskId: string; action: string; status: string; version: number; generation: number;
  currentRunId: string | null; requestId: string; updatedAt: number;
  error: { code: string; message: string } | null;
}
export interface ConversationProcessingItem {
  plan: ProcessingPlanView; task: ProcessingTaskView | null; executions: ProcessingTaskView[];
}
export interface ConversationProcessingPage {
  conversationId: string; branchId: string;
  items: ConversationProcessingItem[]; availability: 'available' | 'unavailable';
  reason: string | null; scope: string;
}
type Position = { createdAt: number; id: string };
type CheckCache = { checkedAt: string; revision: number; verification?: DatabaseVerification; error?: { code: string; message: string } };
type DatabaseVerification = {
  identity: unknown;
  capabilities: Record<string, unknown>;
  fixedRead: { state: 'verified'; datasetId: string; snapshotId: string; sha256: string }
    | { state: 'empty'; datasetIds: string[]; reason: string };
};
const checkCache = new Map<string, CheckCache>();
type GenericCheckCache = { checkedAt: string; capabilities?: Record<string, unknown>; error?: { code: string; message: string } };
const genericCheckCache = new Map<string, GenericCheckCache>();

/** 通用 v3 能力只按本次显式核对缓存；过去成功不写成当前授权。 */
function genericView(cached: GenericCheckCache | undefined, selected?: OfficialLineIdentityView | null): OfficialGenericView {
  const capabilities = cached?.capabilities ?? null;
  const products = Array.isArray(capabilities?.products) ? capabilities.products.filter(record) : [];
  const permission = record(capabilities?.permissions) ? capabilities.permissions : null;
  // 实例、用途、模式不属于 capabilities.search 响应；只从本次选中并已发出通用调用的线路身份投影。
  const identity = capabilities && selected ? selected : null;
  return {
    status: cached?.error ? 'failed' : capabilities ? 'passed' : 'never',
    checkedAt: cached?.checkedAt ?? null,
    contract: typeof capabilities?.contract_version === 'string' ? capabilities.contract_version
      : typeof capabilities?.schema_version === 'string' ? capabilities.schema_version : null,
    instanceId: identity?.instanceId ?? null,
    purpose: identity?.purpose ?? null,
    mode: identity?.mode ?? null,
    identitySource: identity ? 'selected_line_binding' : null,
    operations: stringArray(capabilities?.operations),
    grant: permission ? {
      enabled: permission.enabled === true,
      grantId: typeof permission.grant_id === 'string' ? permission.grant_id : null,
      grantState: typeof permission.grant_state === 'string' ? permission.grant_state : null,
      readNamespaces: stringArray(permission.read_namespaces),
      writeNamespaces: stringArray(permission.write_namespaces),
      createNamespaces: stringArray(permission.create_namespaces),
      purposes: stringArray(permission.purposes),
    } : null,
    products: products.slice(0, 50).flatMap(item => {
      if (typeof item.product_id !== 'string') return [];
      const declaration = record(item.declaration) ? item.declaration : null;
      const definitionRevision = typeof item.definition_rev === 'string' && item.definition_rev ? item.definition_rev : null;
      const definitionSha256 = typeof item.definition_sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.definition_sha256) ? item.definition_sha256 : null;
      const declaredProductId = declaration && typeof declaration.product_id === 'string' ? declaration.product_id : null;
      const declaredRevision = declaration && typeof declaration.definition_rev === 'string' ? declaration.definition_rev : null;
      const declaredNamespace = declaration && typeof declaration.namespace === 'string' ? declaration.namespace : null;
      const namespace = typeof item.namespace === 'string' ? item.namespace : declaredNamespace;
      // 真实 v3 目录用 definition_rev + definition_sha256 + declaration 表达登记事实，没有 registered 字段。
      const declarationRegistered = !!declaration && !!definitionRevision && !!definitionSha256 && !!namespace
        && declaredProductId === item.product_id && declaredRevision === definitionRevision
        && declaredNamespace === namespace;
      const registered = item.registered === true || declarationRegistered;
      // 只对已登记的目录条目投影当前头；不把不完整条目的 head 当作已核快照。
      const headSnapshotId = registered && typeof item.head_snapshot_id === 'string' && item.head_snapshot_id ? item.head_snapshot_id : null;
      const reportedSnapshotIds = stringArray(item.snapshot_ids);
      const snapshotIds = headSnapshotId
        ? [headSnapshotId, ...reportedSnapshotIds.filter(snapshotId => snapshotId !== headSnapshotId)]
        : reportedSnapshotIds;
      return [{
        productId: item.product_id,
        namespace,
        state: typeof item.state === 'string' ? item.state : null,
        registered,
        headSnapshotId,
        snapshotIds,
        snapshotScope: reportedSnapshotIds.length ? 'reported' : headSnapshotId ? 'head_only' : 'not_reported',
        registrationBasis: declarationRegistered ? 'catalog_definition_and_declaration'
          : item.registered === true ? 'catalog_flag' : 'not_registered',
      }];
    }),
    productsTruncated: products.length > 50,
    error: cached?.error ?? null,
  };
}

/** 正式目录浏览接口尚未装配；数据库线路状态由既有连接服务单独提供。 */
export function officialDataView(services: ApplicationServices): OfficialDataView {
  const companion = services.options.workspaceServices;
  const lines = companion?.databaseLines ?? services.databaseLines;
  const now = new Date().toISOString();
  if (!lines) return {
    connection: 'unbound', code: DATABASE_PORT_RESERVATION.code,
    reason: '当前没有已装配的数据库线路；用户测试目录不能当作正式生产。',
    source: `DatabasePort:${DATABASE_PORT_RESERVATION.code}`,
    productionBinding: DATABASE_PORT_RESERVATION.state,
    line: null,
    check: { state: 'never', checkedAt: null, revision: null, error: null, permissions: null, fixedRead: null },
    generic: genericView(undefined),
    catalog: { status: 'not_provided', items: [], reason: '没有已装配的 WFD 连接，未读取任何目录。' },
    datasets: [], checkedAt: null, observedAt: now,
  };
  const status = lines.status();
  const selected = status.selected as OfficialLineIdentityView | null;
  const line: OfficialLineView = {
    revision: status.revision,
    connectionId: status.connectionId,
    previousConnectionId: status.previousConnectionId,
    pendingId: status.pendingId,
    selected,
    registered: status.registered as OfficialLineView['registered'],
    dispatchBlocked: status.dispatchBlocked,
    businessLedgerReady: status.businessLedgerReady,
    activeTaskIds: status.activeTaskIds,
    unresolved: status.unresolved.map(item => ({ id: item.id, state: item.state, requestId: item.requestId,
      instanceId: String(item.instanceId), operation: item.operation })),
  };
  const key = selected ? checkKey(status.revision, selected) : null;
  const cached = key ? checkCache.get(key) : undefined;
  const verification = cached?.verification;
  const capabilities = verification?.capabilities ?? null;
  const datasets = capabilities ? parseDatasets(capabilities) : [];
  const permissions = capabilities ? parsePermissions(capabilities) : null;
  const fixedRead = verification?.fixedRead ?? null;
  const failure = cached?.error ?? null;
  const genericCached = key ? genericCheckCache.get(key) : undefined;
  const generic = genericView(genericCached, selected);
  const genericVerified = generic.status === 'passed';
  const connection = failure ? (genericVerified ? 'registered' : connectionForFailure(failure.code)) : selected ? 'registered' : 'unavailable';
  const reason = !selected ? '当前选择没有可核的线路身份，保持未绑定。'
    : status.pendingId ? '数据库线路有尚未完成的切换或维护核对，未派发新请求。'
      : failure && genericVerified ? '当前通用 v3 能力已核对；旧 v2 兼容核对未通过，见兼容详情。'
        : failure ? failure.message
          : cached ? '本次运行已核对线路身份、实例、用途与能力；正式生产仍未绑定。'
            : '线路已登记，本次运行尚未发起连接核对；登记不等于可用。';
  return {
    connection, code: failure?.code ?? null, reason,
    source: selected ? `databaseLines.status:${selected.connectionId}:${selected.instanceId}` : `DatabasePort:${DATABASE_PORT_RESERVATION.code}`,
    productionBinding: DATABASE_PORT_RESERVATION.state,
    line,
    check: {
      state: failure ? 'failed' : cached ? 'passed' : 'never',
      checkedAt: cached?.checkedAt ?? null,
      revision: cached?.revision ?? null,
      error: failure,
      permissions,
      fixedRead,
    },
    generic,
    catalog: {
      status: 'not_provided',
      items: registeredProducts(companion),
      reason: '本地只保留历史提交回执，不是数据库当前服务目录。当前产品与授权以通用 v3 能力查询为准；没有独立目录树接口，不拼接多个 latest（最新）结果。',
    },
    datasets,
    checkedAt: cached?.checkedAt ?? null,
    observedAt: now,
  };
}

/** 对既有本机/同宿主服务记录的只读分页投影；不会装配正式数据库或新的目录服务。 */
export function createDataBrowserRouter(services: ApplicationServices) {
  const router = Router(), companion = services.options.workspaceServices;
  router.get('/files', (req, res) => {
    if (req.query.group !== 'materials' && req.query.group !== 'outputs') invalid('请选择材料或产物列表。');
    const collection = `files:${req.query.group}`, input = pageInput(req.query, collection, ['group']);
    const page = services.files.listPage({ group: req.query.group, query: input.query, after: input.after, limit: input.limit });
    res.json(presentPage(page, input, collection, 'personal.file_references:displayName,id'));
  });
  router.get('/materials', (req, res) => {
    const input = pageInput(req.query, 'materials');
    const page = companion?.materials?.listPage({ query: input.query, after: input.after, limit: input.limit });
    res.json(presentPage(page ?? { items: [], next: null }, input, 'materials',
      'workspace.materials:filename,materialId,category; completed custody only', page ? 'available' : 'unavailable'));
  });
  router.get('/materials/:id', (req, res) => {
    if (Object.keys(req.query).length) invalid('材料预览不接受检索或路径参数。');
    if (!companion?.materials) throw new CoreError('MATERIAL_PREVIEW_UNAVAILABLE', '材料服务尚未装配，不能读取预览。', 503);
    const record: MaterialRecord = companion.materials.get(req.params.id);
    res.json(record);
  });
  router.get('/jobs', (req, res) => {
    const input = pageInput(req.query, 'jobs');
    if (!companion?.harness) {
      res.json(presentPage({ items: [], next: null }, input, 'jobs', 'workspace.tasks: active, approval, result or failure', 'unavailable')); return;
    }
    const parameters: (number | string)[] = [input.query, input.query, input.query, input.query, input.query, input.query];
    let where = "owner_role='service' AND (instr(lower(action),lower(?))>0 OR instr(lower(id),lower(?))>0 OR instr(lower(title),lower(?))>0 OR instr(lower(status),lower(?))>0 OR instr(lower(coalesce(json_extract(result,'$.summary'),'')),lower(?))>0 OR instr(lower(coalesce(blocked_reason,'')),lower(?))>0)";
    if (input.after) { where += ' AND (created_at<? OR (created_at=? AND id>?))'; parameters.push(input.after.createdAt, input.after.createdAt, input.after.id); }
    const rows = companion.database.connection.prepare(`SELECT id,created_at FROM tasks WHERE ${where} ORDER BY created_at DESC,id LIMIT ?`).all(...parameters, input.limit + 1);
    const visible = rows.slice(0, input.limit), last = visible.at(-1);
    const page = { items: visible.map(row => {
      const task = companion.tasks.get(String(row.id));
      return { ...companion.harness!.taskView(task.id), title: task.title, progress: task.progress ?? null,
        blockedReason: task.blockedReason, createdAt: task.createdAt, updatedAt: task.updatedAt };
    }),
      next: rows.length > input.limit && last ? { createdAt: Number(last.created_at), id: String(last.id) } : null };
    res.json(presentPage(page, input, 'jobs', 'workspace.tasks:operation,status,progress,approval,error,result; includes active and waiting approval'));
  });
  router.get('/candidates', (req, res) => {
    const input = pageInput(req.query, 'candidates');
    if (!companion?.candidates || !companion.harness) {
      res.json(presentPage({ items: [], next: null }, input, 'candidates',
        'workspace.candidates:prepare,submit,outputs,readback', 'unavailable')); return;
    }
    const tasks = companion.tasks.list({ ownerRole: 'service', limit: 500 })
      .filter(task => task.runtimeId === 'harness.candidates');
    const views = tasks.flatMap(task => {
      try { return [candidateView(companion, task)]; } catch { return []; }
    }).filter(view => matchesCandidate(view, input.query))
      .sort((left, right) => right.createdAt - left.createdAt || left.taskId.localeCompare(right.taskId));
    const after = input.after;
    const remaining = after ? views.filter(view => view.createdAt < after.createdAt || (view.createdAt === after.createdAt && view.taskId > after.id)) : views;
    const visible = remaining.slice(0, input.limit), last = remaining.length > input.limit ? visible.at(-1) : undefined;
    const page = { items: visible, next: last ? { createdAt: last.createdAt, id: last.taskId } : null };
    res.json(presentPage(page, input, 'candidates',
      'workspace.candidates:prepared outputs, custody, gaps, submit receipt and fixed readback'));
  });
  router.get('/conversation-candidates', (req, res) => {
    const input = conversationInput(req.query);
    const state = services.core.getState(input.conversationId);
    if (!state.branches.some(branch => branch.id === input.branchId)) throw new CoreError('STALE_BRANCH', '会话分支已变化，请重新读取。', 409);
    if (!services.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_candidate_links'").get()) {
      res.json({ conversationId: input.conversationId, branchId: input.branchId, items: [], availability: 'unavailable',
        reason: '本会话尚未装配候选关联记录。', scope: 'conversation_candidate_links: exact conversation and branch only' } satisfies ConversationCandidatePage); return;
    }
    if (!companion?.candidates || !companion.harness) {
      res.json({ conversationId: input.conversationId, branchId: input.branchId, items: [], availability: 'unavailable',
        reason: '工作台候选服务未装配，不能读取已关联任务。', scope: 'conversation_candidate_links: exact conversation and branch only' } satisfies ConversationCandidatePage); return;
    }
    const rows = services.database.connection.prepare('SELECT service_task_id,origin_json,kind FROM conversation_candidate_links ORDER BY created_at DESC LIMIT 200').all();
    const seen = new Set<string>(), items: CandidateView[] = [];
    for (const row of rows) {
      let origin: unknown;
      try { origin = JSON.parse(String(row.origin_json)); } catch { continue; }
      if (!record(origin) || origin.conversationId !== input.conversationId || origin.branchId !== input.branchId) continue;
      const taskId = String(row.service_task_id);
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      try {
        const task = companion.tasks.get(taskId);
        if (task.runtimeId !== 'harness.candidates') continue;
        items.push(candidateView(companion, task));
      } catch { /* 已不存在的关联不向任何会话泄露。 */ }
    }
    res.json({ conversationId: input.conversationId, branchId: input.branchId,
      items: items.sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId)),
      availability: 'available', reason: null,
      scope: 'conversation_candidate_links: exact conversation and branch only' } satisfies ConversationCandidatePage);
  });
  router.get('/conversation-processing', (req, res) => {
    const input = conversationInput(req.query);
    const state = services.core.getState(input.conversationId);
    if (!state.branches.some(branch => branch.id === input.branchId)) throw new CoreError('STALE_BRANCH', '会话分支已变化，请重新读取。', 409);
    const scope = 'conversation_processing_links: exact conversation and branch only';
    const companion = services.options.workspaceServices;
    const processing = services.processing ?? companion?.processing;
    const processingTasks = companion?.tasks ?? services.tasks;
    if (!processing) {
      res.json({ conversationId: input.conversationId, branchId: input.branchId, items: [], availability: 'unavailable',
        reason: '处理计划服务未装配，不能读取本分支计划。', scope } satisfies ConversationProcessingPage); return;
    }
    if (!services.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_processing_links'").get()) {
      res.json({ conversationId: input.conversationId, branchId: input.branchId, items: [], availability: 'unavailable',
        reason: '本会话尚未装配处理计划关联记录。', scope } satisfies ConversationProcessingPage); return;
    }
    const rows = services.database.connection.prepare(`SELECT ref_id,task_id,kind,material_id,origin_json,created_at
      FROM conversation_processing_links WHERE kind IN ('plan','execution') ORDER BY created_at DESC,rowid DESC LIMIT 500`).all();
    const plans = new Map<string, { taskId: string }>(), executions = new Map<string, string[]>();
    for (const row of rows) {
      let origin: unknown;
      try { origin = JSON.parse(String(row.origin_json)); } catch { continue; }
      if (!record(origin) || origin.conversationId !== input.conversationId || origin.branchId !== input.branchId) continue;
      const planId = String(row.material_id ?? '');
      if (row.kind === 'plan') {
        if (typeof row.ref_id === 'string' && !plans.has(row.ref_id)) plans.set(row.ref_id, { taskId: String(row.task_id) });
      } else if (planId && typeof row.task_id === 'string') {
        const list = executions.get(planId) ?? [];
        if (!list.includes(row.task_id)) list.push(row.task_id);
        executions.set(planId, list);
      }
    }
    // 同一计划的执行任务可能由会话代理或本机界面的既有 run/单步/recover 入口创建；
    // 计划本身已按精确分支链接核对，执行任务只从该计划的事实反查，不接受任意 taskId。
    for (const task of processingTasks.list({ ownerRole: 'service', limit: 1000 })) {
      const args = record(task.args) ? task.args as Record<string, unknown> : null;
      const planId = args && typeof args.planId === 'string' ? args.planId : '';
      if (!planId || !plans.has(planId) || !['data.processing.execute', 'data.processing.run', 'data.processing.recover'].includes(task.action)) continue;
      const list = executions.get(planId) ?? [];
      if (!list.includes(task.id)) list.push(task.id);
      executions.set(planId, list);
    }
    const items: ConversationProcessingItem[] = [];
    for (const [planId, link] of plans) {
      try {
        const plan = processingPlanForUi(processing.get(planId));
        items.push({ plan, task: processingTaskView(processingTasks, link.taskId),
          executions: (executions.get(planId) ?? []).slice(0, 10).flatMap(taskId => {
            const task = processingTaskView(processingTasks, taskId); return task ? [task] : [];
          }) });
      } catch { /* 已不存在或不可读的计划不向任何会话泄露。 */ }
    }
    res.json({ conversationId: input.conversationId, branchId: input.branchId,
      items: items.sort((left, right) => right.plan.createdAt - left.plan.createdAt || left.plan.planId.localeCompare(right.plan.planId)).slice(0, 10),
      availability: 'available', reason: null, scope } satisfies ConversationProcessingPage);
  });
  router.get('/official', (req, res) => {
    if (Object.keys(req.query).length) invalid('正式目录状态不接受连接或检索参数。');
    res.json(officialDataView(services));
  });
  router.post('/official/check', async (req, res) => {
    const body = objectBody(req.body), keys = Object.keys(body);
    if (keys.some(key => key !== 'expectedRevision') || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
      throw new CoreError('INVALID_DATA_BROWSER_QUERY', '连接核对需要当前线路修订。', 400);
    }
    const lines = companion?.databaseLines ?? services.databaseLines;
    if (!lines) throw new CoreError('DATABASE_LINE_UNAVAILABLE', '当前没有已装配的数据库线路。', 503);
    const before = lines.status();
    if (before.revision !== body.expectedRevision) throw new CoreError('DATABASE_LINE_REVISION_CONFLICT', '线路修订已变化，请重新读取后再核对。', 409);
    const selected = before.selected as OfficialLineIdentityView | null;
    if (!selected) throw new CoreError('DATABASE_LINE_UNAVAILABLE', '当前选择没有可核对的线路身份。', 503);
    const key = checkKey(before.revision, selected);
    // 选择变更后旧修订的通用能力不再保留；读取端也只认当前 revision/connection/instance。
    for (const cachedKey of genericCheckCache.keys()) if (cachedKey !== key) genericCheckCache.delete(cachedKey);
    try {
      const result = await lines.verifySelected({ expectedRevision: Number(body.expectedRevision) });
      checkCache.set(key, { checkedAt: new Date().toISOString(), revision: result.revision, verification: result.verification as DatabaseVerification });
    } catch (error) {
      const failure = safeError(error);
      checkCache.set(key, { checkedAt: new Date().toISOString(), revision: before.revision, error: failure });
    }
    const registered = before.registered.find(line => line.connectionId === selected.connectionId);
    if (registered?.genericBound && companion?.candidates) {
      try {
        const capabilities = await companion.candidates.capabilities();
        genericCheckCache.set(key, { checkedAt: new Date().toISOString(), capabilities });
      } catch (error) {
        genericCheckCache.set(key, { checkedAt: new Date().toISOString(), error: safeError(error) });
      }
    } else genericCheckCache.delete(key);
    res.json(officialDataView(services));
  });
  return router;
}

function checkKey(revision: number, selected: OfficialLineIdentityView) {
  return `${revision}:${selected.connectionId}:${selected.instanceId}`;
}
function safeError(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: error instanceof Error ? error.message : '线路核对未完成。' };
  }
  return { code: 'DATABASE_LINE_CHECK_FAILED', message: error instanceof Error ? error.message : '线路核对未完成。' };
}
function connectionForFailure(code: string): OfficialDataView['connection'] {
  if (/AUTH|CREDENTIAL|PERMISSION|DENIED|FORBIDDEN/i.test(code)) return 'denied';
  if (/UNAVAILABLE|UNREACHABLE|TIMEOUT|TRANSPORT|HOST|CONNECT/i.test(code)) return 'unreachable';
  return 'unavailable';
}
function parsePermissions(capabilities: Record<string, unknown>): OfficialPermissionView {
  return {
    operations: Array.isArray(capabilities.operations) ? capabilities.operations.filter((value): value is string => typeof value === 'string') : [],
    maxReadRows: Number.isSafeInteger(capabilities.max_read_rows) ? Number(capabilities.max_read_rows) : null,
    timeCapability: typeof capabilities.time_capability === 'string' ? capabilities.time_capability : null,
    productionEnabled: capabilities.production_enabled === true,
    writeEnabled: typeof capabilities.write_enabled === 'boolean' ? capabilities.write_enabled : null,
  };
}
function parseDatasets(capabilities: Record<string, unknown>): OfficialDatasetView[] {
  if (!Array.isArray(capabilities.capabilities)) return [];
  return capabilities.capabilities.filter(record).flatMap(item => {
    if (typeof item.dataset_id !== 'string') return [];
    const semantics = record(item.descriptor_semantics) ? item.descriptor_semantics : null;
    return [{
      datasetId: item.dataset_id,
      registered: item.registered === true,
      readable: item.readable === true,
      allowedPurposes: Array.isArray(item.allowed_purposes) ? item.allowed_purposes.filter((value): value is string => typeof value === 'string') : [],
      headSnapshotId: typeof item.head_snapshot_id === 'string' ? item.head_snapshot_id : null,
      snapshotIds: Array.isArray(item.snapshot_ids) ? item.snapshot_ids.filter((value): value is string => typeof value === 'string') : [],
      contractVersion: typeof item.contract_version === 'string' ? item.contract_version : null,
      mappingVersion: typeof item.mapping_version === 'string' ? item.mapping_version : null,
      coverage: semantics && record(semantics.coverage) ? normalizeCoverage(semantics.coverage) : null,
    }];
  });
}
function registeredProducts(companion: ApplicationServices | undefined): OfficialCatalogItem[] {
  if (!companion) return [];
  if (!companion.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='candidate_submissions'").get()) return [];
  const rows = companion.database.connection.prepare(`SELECT s.task_id,s.request_id,s.receipt_json,s.readback_json,t.created_at
    FROM candidate_submissions s LEFT JOIN tasks t ON t.id=s.task_id WHERE s.receipt_json IS NOT NULL
    ORDER BY coalesce(t.created_at,0) DESC,s.task_id LIMIT 100`).all();
  const byProduct = new Map<string, OfficialCatalogItem>(), seen = new Set<string>();
  for (const row of rows) {
    let receipt: unknown;
    try { receipt = JSON.parse(String(row.receipt_json)); } catch { continue; }
    if (!record(receipt) || !Array.isArray(receipt.outputs)) continue;
    let readback: unknown[] = [];
    try { const parsed: unknown = row.readback_json ? JSON.parse(String(row.readback_json)) : []; readback = Array.isArray(parsed) ? parsed : []; } catch { /* 无固定读回时不补造。 */ }
    for (const output of receipt.outputs.filter(record)) {
      if (typeof output.product_id !== 'string' || typeof output.snapshot_id !== 'string' || typeof output.commit_id !== 'string') continue;
      if (/^(latest|current)$/i.test(output.snapshot_id)) continue;
      const identity = `${output.product_id}\u0000${output.snapshot_id}\u0000${output.commit_id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const outputId = typeof output.output_id === 'string' ? output.output_id : '';
      const summary = readback.filter(record).find(item => item.outputId === outputId && item.snapshotId === output.snapshot_id);
      const namespace = typeof output.namespace === 'string' ? output.namespace : null;
      const snapshot: OfficialSnapshotView = {
        productId: output.product_id, snapshotId: output.snapshot_id, commitId: output.commit_id, outputId,
        namespace, taskId: String(row.task_id), requestId: String(row.request_id), state: String(output.state ?? 'unknown'),
        registered: output.registered === true,
        coverage: record(output.coverage) ? normalizeCoverage(output.coverage) : null,
        custody: record(output.custody) ? {
          state: typeof output.custody.state === 'string' ? output.custody.state : 'unknown',
          byteLength: Number.isSafeInteger(output.custody.byte_length) ? Number(output.custody.byte_length) : 0,
          manifestSha256: typeof output.custody.manifest_sha256 === 'string' ? output.custody.manifest_sha256 : '',
        } : null,
        readback: summary ? {
          state: String(summary.state ?? 'unknown'),
          rows: Number.isSafeInteger(summary.rows) ? Number(summary.rows) : 0,
          rowsSha256: String(summary.rowsSha256 ?? ''),
        } : null,
        issues: Array.isArray(output.issues) ? output.issues.filter(record).flatMap(issue => typeof issue.code === 'string' && typeof issue.message === 'string'
          ? [{ code: issue.code, message: issue.message }] : []) : [],
      };
      const item = byProduct.get(snapshot.productId) ?? { productId: snapshot.productId, namespace, snapshots: [] };
      if (!item.namespace) item.namespace = namespace;
      item.snapshots.push(snapshot); byProduct.set(snapshot.productId, item);
    }
  }
  return [...byProduct.values()].sort((left, right) => left.productId.localeCompare(right.productId)).slice(0, 50);
}
function candidateView(companion: ApplicationServices, task: TaskRecord): CandidateView {
  const detail = companion.candidates!.get(task.id);
  const preparation = record(detail.preparation) ? detail.preparation : null;
  const database = record(detail.database) ? detail.database : null;
  const receipt = database && record(database.receipt) ? database.receipt : null;
  const readback = database && Array.isArray(database.readback) ? database.readback.filter(record) : [];
  const receiptOutputs = receipt && Array.isArray(receipt.outputs) ? receipt.outputs.filter(record) : [];
  const preparedOutputs = preparation && Array.isArray(preparation.outputs) ? preparation.outputs.filter(record) : [];
  const reports = preparation && Array.isArray(preparation.reports) ? preparation.reports.filter(record) : [];
  const outputs: CandidateOutputView[] = [];
  const seen = new Set<string>();
  for (const output of preparedOutputs) {
    const outputId = typeof output.output_id === 'string' ? output.output_id : '';
    if (!outputId) continue;
    seen.add(outputId);
    const report = reports.find(item => item.outputId === outputId);
    const receiptOutput = receiptOutputs.find(item => item.output_id === outputId);
    const summary = readback.find(item => item.outputId === outputId);
    const productRef = record(output.product_ref) ? output.product_ref : null;
    const declaration = record(output.declaration) ? output.declaration : null;
    outputs.push({
      outputId, namespace: typeof output.namespace === 'string' ? output.namespace : '',
      productId: productRef && typeof productRef.product_id === 'string' ? productRef.product_id
        : declaration && typeof declaration.product_id === 'string' ? declaration.product_id
          : receiptOutput && typeof receiptOutput.product_id === 'string' ? receiptOutput.product_id : null,
      expectedSnapshotId: typeof output.expected_snapshot_id === 'string' ? output.expected_snapshot_id : null,
      preparedState: report && typeof report.state === 'string' ? report.state : null,
      state: receiptOutput && typeof receiptOutput.state === 'string' ? receiptOutput.state
        : report?.state === 'prepared' ? 'prepared' : 'custody_only',
      commitId: receiptOutput && typeof receiptOutput.commit_id === 'string' ? receiptOutput.commit_id : null,
      snapshotId: receiptOutput && typeof receiptOutput.snapshot_id === 'string' ? receiptOutput.snapshot_id : null,
      registered: receiptOutput?.registered === true,
      coverage: record(output.coverage) ? normalizeCoverage(output.coverage) : record(receiptOutput?.coverage) ? normalizeCoverage(receiptOutput.coverage) : null,
      custody: receiptOutput && record(receiptOutput.custody) ? {
        state: typeof receiptOutput.custody.state === 'string' ? receiptOutput.custody.state : 'unknown',
        byteLength: Number.isSafeInteger(receiptOutput.custody.byte_length) ? Number(receiptOutput.custody.byte_length) : 0,
        manifestSha256: typeof receiptOutput.custody.manifest_sha256 === 'string' ? receiptOutput.custody.manifest_sha256 : '',
      } : null,
      readback: summary ? { state: String(summary.state ?? 'unknown'), rows: Number.isSafeInteger(summary.rows) ? Number(summary.rows) : 0,
        rowsSha256: String(summary.rowsSha256 ?? '') } : null,
      issues: [...issuesOf(report), ...issuesOf(receiptOutput)],
    });
  }
  for (const receiptOutput of receiptOutputs) {
    const outputId = typeof receiptOutput.output_id === 'string' ? receiptOutput.output_id : '';
    if (!outputId || seen.has(outputId)) continue;
    seen.add(outputId);
    const summary = readback.find(item => item.outputId === outputId);
    outputs.push({
      outputId, namespace: typeof receiptOutput.namespace === 'string' ? receiptOutput.namespace : '',
      productId: typeof receiptOutput.product_id === 'string' ? receiptOutput.product_id : null,
      expectedSnapshotId: null, preparedState: null,
      state: typeof receiptOutput.state === 'string' ? receiptOutput.state : 'unknown',
      commitId: typeof receiptOutput.commit_id === 'string' ? receiptOutput.commit_id : null,
      snapshotId: typeof receiptOutput.snapshot_id === 'string' ? receiptOutput.snapshot_id : null,
      registered: receiptOutput.registered === true,
      coverage: record(receiptOutput.coverage) ? normalizeCoverage(receiptOutput.coverage) : null,
      custody: record(receiptOutput.custody) ? { state: String(receiptOutput.custody.state ?? 'unknown'),
        byteLength: Number.isSafeInteger(receiptOutput.custody.byte_length) ? Number(receiptOutput.custody.byte_length) : 0,
        manifestSha256: typeof receiptOutput.custody.manifest_sha256 === 'string' ? receiptOutput.custody.manifest_sha256 : '' } : null,
      readback: summary ? { state: String(summary.state ?? 'unknown'), rows: Number.isSafeInteger(summary.rows) ? Number(summary.rows) : 0,
        rowsSha256: String(summary.rowsSha256 ?? '') } : null,
      issues: issuesOf(receiptOutput),
    });
  }
  const committed = outputs.filter(output => output.state === 'committed').length;
  const storedNotCommitted = outputs.filter(output => output.state === 'stored_not_committed').length;
  const rejected = outputs.filter(output => output.state === 'rejected' || output.state === 'cancelled').length;
  const databaseState = database && typeof database.state === 'string' ? database.state : 'not_sent';
  const canSubmit = task.action === 'data.candidates.prepare' && task.status === 'succeeded' && databaseState === 'not_sent';
  const canControl = ['data.candidates.submit', 'data.candidates.resume', 'data.candidates.cancel'].includes(task.action)
    && ['accepted', 'received'].includes(databaseState);
  const canCancel = ['data.candidates.submit', 'data.candidates.resume'].includes(task.action)
    && !['cancelled', 'verified', 'stored_not_committed', 'rejected'].includes(databaseState);
  const canReconcile = ['data.candidates.submit', 'data.candidates.resume', 'data.candidates.cancel'].includes(task.action)
    && ['accepted', 'received', 'unknown', 'needs_review', 'verified', 'stored_not_committed', 'rejected'].includes(databaseState);
  return {
    taskId: task.id, title: task.title, action: task.action, status: task.status, requestId: task.requestId,
    createdAt: task.createdAt, updatedAt: task.updatedAt, parentTaskId: task.parentTaskId,
    requiresReview: task.requiresReview, approvalId: task.approvalId, blockedReason: task.blockedReason,
    progress: task.progress ?? null,
    error: task.error ? { code: task.error.code, message: task.error.message } : null,
    database: {
      state: databaseState,
      requestId: database && typeof database.requestId === 'string' ? database.requestId : null,
      instanceId: database && typeof database.instanceId === 'string' ? database.instanceId : null,
      error: database && record(database.error) && typeof database.error.code === 'string' ? {
        code: database.error.code, message: typeof database.error.message === 'string' ? database.error.message : '原请求未形成可核回执。',
      } : null,
      receiptState: receipt && typeof receipt.state === 'string' ? receipt.state : null,
      committed, storedNotCommitted, rejected,
    },
    outputs,
    actionability: { canSubmit, canResume: canControl, canCancel, canReconcile },
  };
}
function processingPlanForUi(value: unknown): ProcessingPlanView {
  if (!record(value) || typeof value.planId !== 'string' || typeof value.status !== 'string'
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)
    || !Array.isArray(value.materials) || !Array.isArray(value.outputs) || !Array.isArray(value.steps)) {
    throw new CoreError('PROCESSING_PLAN_CHANGED', '处理计划事实暂时无法核对。', 409);
  }
  return {
    planId: value.planId, requestId: typeof value.requestId === 'string' ? value.requestId : '',
    parentPlanId: typeof value.parentPlanId === 'string' ? value.parentPlanId : null, status: value.status,
    createdAt: Number(value.createdAt), updatedAt: Number(value.updatedAt),
    materials: value.materials.slice(0, 50).map(processingMaterialForUi),
    outputs: value.outputs.slice(0, 50).map(processingOutputForUi),
    steps: value.steps.slice(0, 500).map(processingStepForUi),
  };
}
function processingMaterialForUi(value: unknown): ProcessingMaterialView {
  if (!record(value) || typeof value.materialId !== 'string' || typeof value.filename !== 'string') {
    throw new CoreError('PROCESSING_PLAN_CHANGED', '处理计划材料事实暂时无法核对。', 409);
  }
  return { materialId: value.materialId, filename: value.filename,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : '', format: typeof value.format === 'string' ? value.format : '',
    support: typeof value.support === 'string' ? value.support : '',
    custodyState: typeof value.custodyState === 'string' ? value.custodyState : '',
    routingState: typeof value.routingState === 'string' ? value.routingState : '',
    gaps: stringList(value.gaps) };
}
function processingOutputForUi(value: unknown): ProcessingOutputView {
  if (!record(value) || typeof value.outputId !== 'string' || typeof value.state !== 'string') {
    throw new CoreError('PROCESSING_PLAN_CHANGED', '处理计划输出事实暂时无法核对。', 409);
  }
  return {
    outputId: value.outputId, materialIds: stringList(value.materialIds),
    intendedAction: typeof value.intendedAction === 'string' ? value.intendedAction : 'inspect',
    target: processingTargetView(value.target),
    routingState: typeof value.routingState === 'string' ? value.routingState : '', state: value.state,
    gaps: stringList(value.gaps), semanticGaps: stringList(value.semanticGaps),
    ...(typeof value.publishEligible === 'boolean' ? { publishEligible: value.publishEligible } : {}),
    ...(typeof value.publishAuthorization === 'string' ? { publishAuthorization: value.publishAuthorization } : {}),
    ...(typeof value.publishScope === 'string' ? { publishScope: value.publishScope } : {}),
    evidenceScope: typeof value.evidenceScope === 'string' ? value.evidenceScope : null,
    steps: Array.isArray(value.steps) ? value.steps.slice(0, 200).map(processingStepForUi) : [],
  };
}
function processingTargetView(value: unknown): ProcessingOutputView['target'] {
  if (!record(value)) return null;
  const productRef = record(value.productRef) ? value.productRef : null;
  const declaration = record(value.declaration) ? value.declaration : null;
  return {
    kind: productRef ? 'product' : declaration ? 'declaration' : 'none',
    productId: typeof productRef?.product_id === 'string' ? productRef.product_id
      : typeof declaration?.product_id === 'string' ? declaration.product_id : null,
    expectedSnapshotId: typeof value.expectedSnapshotId === 'string' ? value.expectedSnapshotId : null,
  };
}
function processingStepForUi(value: unknown): ProcessingStepView {
  if (!record(value) || typeof value.stepId !== 'string' || typeof value.outputId !== 'string'
    || typeof value.kind !== 'string' || typeof value.state !== 'string' || typeof value.required !== 'boolean') {
    throw new CoreError('PROCESSING_PLAN_CHANGED', '处理步骤事实暂时无法核对。', 409);
  }
  const output = record(value.output) ? {
    sha256: typeof value.output.sha256 === 'string' ? value.output.sha256 : '',
    byteLength: Number.isSafeInteger(value.output.byte_length) ? Number(value.output.byte_length) : null,
  } : null;
  const reused = record(value.reusedFrom) && typeof value.reusedFrom.planId === 'string' && typeof value.reusedFrom.stepId === 'string'
    ? { planId: value.reusedFrom.planId, stepId: value.reusedFrom.stepId } : null;
  return { stepId: value.stepId, outputId: value.outputId, kind: value.kind, state: value.state, required: value.required,
    applicability: typeof value.applicability === 'string' ? value.applicability : null,
    dependsOn: stringList(value.dependsOn), gaps: stringList(value.gaps), outputDigest: typeof value.outputDigest === 'string' ? value.outputDigest : null,
    output, error: processingError(value.error), reusedFrom: reused };
}
function processingError(value: unknown): { code: string; message: string } | null {
  if (!record(value) || typeof value.code !== 'string') return null;
  return { code: value.code, message: typeof value.message === 'string' ? value.message : '未提供错误说明。' };
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function processingTaskView(tasks: { get(id: string): TaskRecord }, taskId: string): ProcessingTaskView | null {
  if (!taskId) return null;
  try {
    const task = tasks.get(taskId);
    return { taskId: task.id, action: task.action, status: task.status, version: task.version, generation: task.generation,
      currentRunId: task.currentRunId, requestId: task.requestId, updatedAt: task.updatedAt,
      error: task.error ? { code: task.error.code, message: task.error.message } : null };
  } catch { return null; }
}
function issuesOf(value: Record<string, unknown> | undefined): Array<{ code: string; message: string }> {
  if (!value || !Array.isArray(value.issues)) return [];
  return value.issues.filter(record).flatMap(issue => typeof issue.code === 'string' && typeof issue.message === 'string'
    ? [{ code: issue.code, message: issue.message }] : []);
}
function normalizeCoverage(value: Record<string, unknown>) {
  return { complete: value.complete === true, gaps: Array.isArray(value.gaps) ? value.gaps.filter((gap): gap is string => typeof gap === 'string') : [],
    scope: typeof value.scope === 'string' ? value.scope : null };
}
function matchesCandidate(view: CandidateView, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [view.taskId, view.title, view.action, view.status, view.requestId, view.database.state,
    view.database.instanceId ?? '', ...view.outputs.flatMap(output => [output.outputId, output.namespace, output.productId ?? '',
      output.snapshotId ?? '', output.commitId ?? '', output.state])].some(value => value.toLowerCase().includes(needle));
}
function conversationInput(values: Record<string, unknown>) {
  if (Object.keys(values).some(key => key !== 'conversationId' && key !== 'branchId')
    || typeof values.conversationId !== 'string' || !values.conversationId || values.conversationId.length > 160
    || typeof values.branchId !== 'string' || !values.branchId || values.branchId.length > 160) {
    invalid('会话候选读取需要明确会话和分支。');
  }
  return { conversationId: values.conversationId, branchId: values.branchId };
}
function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_DATA_BROWSER_QUERY', '请求正文必须是对象。', 400);
  return value as Record<string, unknown>;
}
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function invalid(message: string): never { throw new CoreError('INVALID_DATA_BROWSER_QUERY', message, 400); }
function pageInput(values: Record<string, unknown>, collection: string, additional: string[] = []) {
  if (Object.keys(values).some(key => !['q', 'cursor', 'limit', ...additional].includes(key))) invalid('列表请求包含不支持的字段。');
  if (values.q !== undefined && typeof values.q !== 'string') invalid('搜索内容无效。');
  const query = String(values.q ?? '').trim();
  if (query.length > 256) invalid('搜索内容最多 256 个字符。');
  if (values.limit !== undefined && (typeof values.limit !== 'string' || !/^[1-9][0-9]*$/u.test(values.limit))) invalid('分页条数无效。');
  const limit = values.limit === undefined ? 50 : Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) invalid('每页须在 1 到 50 条之间。');
  let after: Position | undefined;
  if (values.cursor !== undefined) {
    if (typeof values.cursor !== 'string' || !values.cursor || values.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(values.cursor)) invalid('列表游标无效，请刷新列表。');
    let value: unknown;
    try { value = JSON.parse(Buffer.from(values.cursor, 'base64url').toString('utf8')); } catch { invalid('列表游标无效，请刷新列表。'); }
    if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1 || value[1] !== collection || value[2] !== query
      || !Number.isSafeInteger(value[3]) || typeof value[4] !== 'string' || !value[4] || value[4].length > 160) invalid('搜索范围已变化，请从第一页重新读取。');
    after = { createdAt: value[3], id: value[4] };
  }
  return { query, limit, after };
}
function presentPage<T>(page: { items: T[]; next: Position | null }, input: ReturnType<typeof pageInput>, collection: string,
  scope: string, availability: DataBrowserPage<T>['availability'] = 'available'): DataBrowserPage<T> {
  return { items: page.items, nextCursor: page.next ? Buffer.from(JSON.stringify([1, collection, input.query, page.next.createdAt, page.next.id])).toString('base64url') : null,
    limit: input.limit, query: input.query, availability, scope };
}
