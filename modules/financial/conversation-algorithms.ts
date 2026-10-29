import type { PersonalCore } from '../agent/runtime/core.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import { isWfdRecord } from '../../adapters/database/wfd-transport.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import type { ConversationCandidateBridge } from '../collection/conversation-candidates.js';
import type { FileReferenceService } from '../../platform/resources/files.js';
import type { AlgorithmCatalogView } from './algorithm-types.js';

const ACTIONS = new Set(['algorithms.capabilities', 'algorithms.calculate', 'algorithms.status', 'algorithms.prepare_candidate']);
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const text = (key: string, label: string, maxLength = 160, required = true): SkillField =>
  ({ key, label, type: 'text', required, maxLength });
const view = (value: unknown): Record<string, JsonValue> => ({ kind: 'conversation-algorithm', modelPreview: json(value) });

/**
 * 基础算法与当前会话分支之间的只读/受控桥。
 *
 * - capabilities 只读目录、采用状态和真实数据库能力，不能采用、启用或授予 Python 执行权限。
 * - calculate 只提交已有 LocalAlgorithmService；审批仍由原服务任务和现有本机审批完成。
 * - status 只读本分支原任务；结果按有限窗口给模型，完整行留在原结果与后续候选对象中。
 * - prepare_candidate 只从本分支自己的算法任务准备本地草稿；保存仍走已有 data.candidates.submit。
 */
export class ConversationAlgorithmBridge {
  readonly registrations: readonly SkillRegistration[];
  constructor(private readonly options: { database: CoreDatabase; core: PersonalCore; companion: WorkspaceServices; files?: FileReferenceService;
    origin(taskId: string): ModelTaskOrigin | null;
    /** 已有候选桥只提供受信链接登记；候选内容与提交授权仍由 CandidateService 持有。 */
    candidates?: ConversationCandidateBridge }) {
    options.database.migrate('conversation_algorithm_links', 1, `CREATE TABLE conversation_algorithm_links(
      service_task_id TEXT PRIMARY KEY,local_task_id TEXT NOT NULL,operation TEXT NOT NULL,origin_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX conversation_algorithm_local ON conversation_algorithm_links(local_task_id);`);
    const registration = (action: string, title: string, description: string, fields: SkillField[]): SkillRegistration => ({
      action, title, description, fields, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      permissionSummary: ['只读取本机算法目录、采用状态与真实数据库能力；不能采用、启用或授予持续执行权限',
        '计算沿原算法服务任务与本机逐次审批；结果只是本地持久结果，不自动发布',
        '候选只引用本会话分支自己的原算法任务；保存必须由真实用户明确要求并走已有候选提交工具'],
      available: () => ({ available: !!options.companion.algorithms,
        ...(!options.companion.algorithms ? { reason: '基础算法服务尚未装配。' } : {}) }),
    });
    this.registrations = [
      registration('algorithms.capabilities', '发现本机基础算法与真实数据能力',
        '读取当前算法目录、受控采用状态、真实输入（本会话分支通过 material.read 保管的受管表/固定快照）与可用数据库能力。受管表不会列出其他会话或分支的材料；固定快照仍按实际数据库授权读取。只读：不会采用、启用、修改绑定或授予Python（编程语言）执行权限。人类只需说明要用哪份材料或产品、哪个算法；模型从返回的方法、字段和产品元数据判断，不需要人类填写JSON、实例或内部编号。', []),
      registration('algorithms.calculate', '受控执行已登记基础算法',
        'calculationJson 由模型按 capabilities 返回的真实方法参数、字段映射、语义、日历和固定快照身份组装，不是让人类填写的表单。受管表只接受本会话分支通过 material.read 保管的原件；固定快照仍按实际数据库授权。计算只调用本机已登记算法，沿原任务与本机逐次审批；不会自动入库、发布或改用旧 compute_assets（旧计算资产）入口。提交后按返回的任务编号核对本次审批与实际结果。', [
          text('calculationJson', '算法计算请求（模型从实际元数据组装）', 100_000),
        ]),
      registration('algorithms.status', '查看本会话原算法结果',
        '按本会话分支原算法任务编号读取真实状态、持久结果摘要、有限结果窗口和来源谱系。不重算、不发布、不读取其他会话任务；完整数值仍在原持久结果中。', [
          text('taskId', '原算法任务编号（来自本会话计算或状态结果）'),
        ]),
      registration('algorithms.prepare_candidate', '从本会话算法结果准备本地候选',
        '只从本会话分支自己的算法任务准备候选草稿：核对原任务成功、持久结果摘要、未发布状态和真实固定快照谱系，生成WFD（世界金融数据库）可用表示；不提交、不联网。namespace 必须来自 capabilities 返回的真实授权；targetJson 由模型按实际声明合同或已有产品引用组装，人类不需要填JSON或内部编号。保存仍由真实用户明确要求后调用 data.candidates.submit；本动作不会替用户提交。', [
          text('taskId', '原算法任务编号（来自本会话）'),
          text('namespace', '实际授权命名空间（来自 capabilities）'),
          text('outputId', '候选输出编号', 160, false),
          text('targetJson', 'WFD 新声明或已有产品引用（模型按实际合同组装）', 65_536, false),
        ]),
    ];
  }
  handles(action: string): boolean { return ACTIONS.has(action); }
  async execute(context: TaskExecutionContext): Promise<TaskResult> {
    const action = context.task.action, args = context.task.args as Record<string, JsonValue>;
    if (!this.handles(action)) throw new TaskError('ALGORITHM_ACTION', '未登记的算法会话动作。');
    const origin = this.options.origin(context.task.id);
    if (!origin) throw new TaskError('ALGORITHM_CONVERSATION_REQUIRED', '算法会话动作必须由本次真实会话代理调用。');
    const service = this.options.companion.algorithms;
    if (!service) throw new TaskError('ALGORITHM_UNAVAILABLE', '基础算法服务尚未装配。');
    // 直接模型动作必须先取得当前模型分享回执；否则 saveResultProof 会拒绝返回。
    const authority = await acquireAuthority(context, action, args, []);
    authority.assert(); this.options.companion.harness?.assertDispatch();
    if (action === 'algorithms.capabilities') {
      let database: JsonValue = { available: false, reason: '通用候选服务尚未装配；无法读取数据库能力。' };
      try {
        database = this.options.companion.candidates ? json(await this.options.companion.candidates.capabilities(context.signal))
          : database;
      } catch (error) {
        database = { available: false, reason: error instanceof Error ? error.message : '数据库能力读取失败。' };
      }
      const catalog = this.modelCatalog(service, origin);
      authority.assert();
      return { summary: catalog.enabled
        ? '已读取本机算法目录、受控采用状态和真实数据库能力；只列当前会话分支通过 material.read 保管的受管表。本动作只读，不能采用或授予权限。'
        : `算法入口当前未启用（${catalog.adoption.state}）；只能读取目录，不能计算。采用只由本机受控采用入口完成。`,
        data: view({ algorithms: catalog, database, guidance: {
          humanInput: '人类只需说明材料/产品与算法；实例、快照、字段映射和内部编号由模型从实际元数据判断。',
          adoption: '工具不能自 adopt；未启用时不要改用旧 financial/compute_assets 入口。',
          managedTables: '受管表只列当前会话分支通过 material.read 保管的原件；其他会话或分支的材料不会出现在这里。固定快照仍按实际数据库授权读取，不要求本地附件。',
          calculation: '计算沿原任务审批；结果 publication=not_requested 只是计算时未提交快照，不能据此判断后续候选是否已提交。',
          candidate: '候选只引用本分支自己的原算法任务；保存由用户明确要求后走 data.candidates.submit。后续提交状态按 data.candidates.status 核对原候选任务。',
        } }) };
    }
    if (action === 'algorithms.calculate') {
      let calculation: unknown;
      try { calculation = JSON.parse(String(args.calculationJson)); }
      catch { throw new TaskError('ALGORITHM_CALCULATION_JSON', '算法计算请求不是有效JSON。'); }
      if (!isWfdRecord(calculation)) throw new TaskError('ALGORITHM_CALCULATION_JSON', '算法计算请求必须是对象。');
      this.assertCalculationMaterials(calculation, origin);
      const submitted = service.submit('conversation:algorithms:' + context.task.id, calculation);
      const taskId = submitted.taskId;
      this.link(taskId, context.task.id, 'calculate', origin);
      await this.wait(context, taskId);
      const current = this.options.companion.tasks.get(taskId);
      authority.assert();
      return { summary: current.status === 'waiting_approval'
        ? '原算法任务正在等待本机操作者审批；尚未执行Python（编程语言）或产生结果。批准后按同一任务编号查询。'
        : current.status === 'succeeded' ? '算法计算已按原任务完成并持久结果；没有自动发布或提交。'
          : `算法任务当前状态为 ${current.status}；请按原编号核对，不能换号重算。`,
        data: view(this.statusPayload(taskId)) };
    }
    const taskId = String(args.taskId ?? '');
    this.assertLink(taskId, origin);
    if (action === 'algorithms.status') {
      authority.assert();
      return { summary: '已沿本会话原算法任务读取实际状态与持久结果；没有重算。publication 字段只是计算时快照，后续是否已提交请按 data.candidates.status 核对原候选任务。', data: view(this.statusPayload(taskId)) };
    }
    if (!this.options.candidates || !this.options.companion.candidates) {
      throw new TaskError('ALGORITHM_CANDIDATE_UNAVAILABLE', '已有候选桥或候选服务尚未装配；不能准备候选。');
    }
    let target: Record<string, unknown> = {};
    if (args.targetJson !== undefined) {
      let parsed: unknown;
      try { parsed = JSON.parse(String(args.targetJson)); }
      catch { throw new TaskError('ALGORITHM_CANDIDATE_TARGET', '候选目标不是有效JSON。'); }
      if (!isWfdRecord(parsed) || Object.keys(parsed).some(key => !['declaration', 'productRef', 'expectedSnapshotId'].includes(key))) {
        throw new TaskError('ALGORITHM_CANDIDATE_TARGET', '候选目标只接受 declaration、productRef 或 expectedSnapshotId。');
      }
      target = parsed;
    }
    const namespace = String(args.namespace ?? '').trim();
    if (!namespace) throw new TaskError('ALGORITHM_CANDIDATE_TARGET', '需要实际授权命名空间；不能由工具自行推断。');
    const outputId = typeof args.outputId === 'string' && args.outputId.trim() ? args.outputId.trim() : 'algorithm-result';
    const draft = service.prepareCandidate(taskId, { outputId, namespace,
      ...(target.declaration !== undefined ? { declaration: target.declaration as Record<string, unknown> } : {}),
      ...(target.productRef !== undefined ? { productRef: target.productRef as Record<string, unknown> } : {}),
      ...(target.expectedSnapshotId !== undefined ? { expectedSnapshotId: target.expectedSnapshotId as string | null } : {}) });
    // 算法结果保存是独立候选，不把算法任务当作候选提交的 previous 父任务；来源由
    // conversation_algorithm_links、conversation_candidate_links 和 preparation 内的引用共同绑定。
    const prepared = this.options.companion.candidates.prepare(draft.input, 'conversation:algorithms:' + context.task.id);
    this.options.candidates.linkPrepared(prepared.id, context.task.id, origin);
    await this.wait(context, prepared.id);
    authority.assert();
    return { summary: this.options.companion.tasks.get(prepared.id).status === 'succeeded'
      ? '已从本会话原算法结果准备本地候选草稿；尚未向数据库提交，本步骤不联网。保存必须由用户明确要求后调用 data.candidates.submit；后续提交状态按 data.candidates.status 核对原候选任务，不以计算时的 publication 快照推断。'
      : '本地候选草稿尚未完成；没有向数据库提交。',
      data: view({ ...this.options.companion.candidates.get(prepared.id), algorithmResult: draft.reference,
        guidance: { publication: '计算结果里的 publication=not_requested 只是计算时未提交快照；后续候选是否已提交，只按 data.candidates.status 的原候选任务核对。' },
        algorithmLineage: { taskId: draft.lineage.taskId, resultDigest: draft.lineage.resultDigest,
          objectSha256: draft.lineage.objectSha256, methodId: draft.lineage.methodId, methodVersion: draft.lineage.methodVersion,
          implementationVersion: draft.lineage.implementationVersion, rows: draft.lineage.rows,
          representation: draft.lineage.representation } }) };
  }

  /**
   * 模型可见的受管表只来自当前会话分支通过 material.read 建立的保管关系。
   * 全局材料目录不作为分支授权：这里只把已有 FileRef/任务证据与
   * conversation_material_links / conversation_material_calls 对齐，不新建授权体系。
   */
  private visibleTableMaterials(origin: ModelTaskOrigin): Map<string, { sha256: string }> {
    const db = this.options.database.connection;
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversation_material_links','conversation_material_calls')").all()
      .map(row => String(row.name)));
    const materials = this.options.companion.materials;
    if (!materials || !present.has('conversation_material_links') || !present.has('conversation_material_calls')) return new Map();
    let rows: Array<{ material_id: string; service_task_id: string; sha256: string;
      file_ref_id: string; file_ref_version: number }>;
    try {
      rows = db.prepare(`SELECT l.material_id,l.service_task_id,l.sha256,l.file_ref_id,l.file_ref_version
        FROM conversation_material_links l WHERE json_extract(l.origin_json,'$.conversationId')=?
          AND json_extract(l.origin_json,'$.branchId')=?
          AND EXISTS (SELECT 1 FROM conversation_material_calls c WHERE c.material_id=l.material_id
            AND c.service_task_id=l.service_task_id AND c.operation='material.read')`)
        .all(origin.conversationId, origin.branchId) as typeof rows;
    } catch { return new Map(); }
    const visible = new Map<string, { sha256: string }>();
    for (const row of rows) {
      try {
        const material = materials.get(row.material_id);
        // conversation_material_links.file_ref_id 是 personal 原引用；material.envelope.fileRefId 是
        // workspace 为保管副本另行登记的引用，两者不是同一编号。这里只核对 personal 原引用的
        // 版本/大小/状态，以及保管信封的 sha256/byteLength/taskId，绝不把不同存储的 fileRefId 直接相等比较。
        const personal = this.options.files?.getRef(row.file_ref_id);
        if (!personal || personal.kind !== 'file' || personal.status !== 'available'
          || personal.version !== row.file_ref_version || personal.size !== material.envelope.byteLength) continue;
        if (material.envelope.sha256 !== row.sha256 || material.envelope.byteLength !== personal.size
          || material.envelope.taskId !== row.service_task_id || material.envelope.localOnly !== true) continue;
        // 只有真正成功保管的原件才能作为可选表；接收中断或尚未完成的材料不进入模型目录。
        if (this.options.companion.tasks.get(row.service_task_id).status !== 'succeeded') continue;
        visible.set(row.material_id, { sha256: row.sha256 });
      } catch { /* 不可核的链接或任务不进入模型可见范围。 */ }
    }
    return visible;
  }

  /** 只收窄模型桥目录；固定快照仍由实际数据库授权决定，不要求本地附件。 */
  private modelCatalog(service: NonNullable<WorkspaceServices['algorithms']>, origin: ModelTaskOrigin): AlgorithmCatalogView {
    const catalog = service.catalog(), visible = this.visibleTableMaterials(origin);
    const items = catalog.inputs.managedTables.items.filter(item => visible.has(item.materialId));
    const managedTables = items.length === 0 && catalog.inputs.managedTables.status === 'available'
      ? { status: 'unavailable' as const, reason: '当前会话分支没有通过 material.read 保管的受管表；其他会话或分支的材料不会在此列出。', items }
      : { ...catalog.inputs.managedTables, items };
    const noVisibleInput = managedTables.status !== 'available' && catalog.inputs.fixedSnapshots.status !== 'available';
    return { ...catalog,
      ...(noVisibleInput && catalog.status === 'available' ? { status: 'unavailable' as const,
        reason: '当前会话分支没有可用的受管表或固定快照输入；其他会话或分支的材料不会在此列出。' } : {}),
      methods: noVisibleInput ? catalog.methods.map(method => method.status === 'ready'
        ? { ...method, status: 'blocked' as const, reason: '当前会话分支没有可用的受管表或固定快照输入。' } : method) : catalog.methods,
      inputs: { ...catalog.inputs, managedTables } };
  }

  /** 计算提交前先核材料属于当前分支；固定快照仍走数据库实际授权，不要求本地附件。 */
  private assertCalculationMaterials(value: Record<string, unknown>, origin: ModelTaskOrigin): void {
    const source = isWfdRecord(value.source) ? value.source : null;
    if (!source || source.kind !== 'managed_table') return;
    const materialId = typeof source.materialId === 'string' ? source.materialId : '';
    const material = this.visibleTableMaterials(origin).get(materialId);
    if (!material) throw new TaskError('ALGORITHM_MATERIAL_ORIGIN',
      '算法输入只接受本会话分支通过 material.read 保管的受管表；不能借用其他会话或分支的材料。');
    if (source.materialSha256 !== undefined && source.materialSha256 !== material.sha256) {
      throw new TaskError('ALGORITHM_MATERIAL_ORIGIN', '受管表摘要与当前会话分支保管的原件不符；不能改用其他材料。');
    }
  }

  private statusPayload(taskId: string) {
    const value = this.options.companion.algorithms!.view(taskId);
    const result = value.result;
    return { taskId: value.taskId, requestId: value.requestId, methodId: value.methodId, status: value.status,
      taskVersion: value.taskVersion, requiresReview: value.requiresReview, createdAt: value.createdAt, updatedAt: value.updatedAt,
      error: value.error, publication: value.publication, guidance: value.guidance,
      result: result ? { taskId: result.taskId, methodId: result.methodId, methodVersion: result.methodVersion,
        implementationVersion: result.implementationVersion, contractVersion: result.contractVersion, environment: result.environment,
        parameters: result.parameters, inputDigest: result.inputDigest, source: result.source, metadata: result.metadata,
        coverage: result.coverage, validInterval: result.validInterval, invalidIntervals: result.invalidIntervals,
        gaps: result.gaps, limitations: result.limitations, publication: result.publication, persistence: result.persistence,
        rowCount: result.rows.length, rows: result.rows.slice(0, 8),
        rowsOmitted: Math.max(0, result.rows.length - 8) } : null };
  }
  private link(serviceTaskId: string, localTaskId: string, operation: string, origin: ModelTaskOrigin) {
    this.options.database.connection.prepare('INSERT OR IGNORE INTO conversation_algorithm_links VALUES(?,?,?,?,?)')
      .run(serviceTaskId, localTaskId, operation, JSON.stringify(origin), Date.now());
    const row = this.options.database.connection.prepare('SELECT * FROM conversation_algorithm_links WHERE service_task_id=?')
      .get(serviceTaskId) as { local_task_id: string; operation: string; origin_json: string } | undefined;
    if (!row || row.local_task_id !== localTaskId || row.operation !== operation) {
      throw new TaskError('ALGORITHM_LINK_MISMATCH', '算法任务与原会话来源绑定不符。');
    }
    const saved = JSON.parse(row.origin_json) as ModelTaskOrigin;
    if (saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId) {
      throw new TaskError('ALGORITHM_LINK_MISMATCH', '算法任务不能跨会话分支登记。');
    }
  }
  private assertLink(taskId: string, origin: ModelTaskOrigin) {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/u.test(taskId)) throw new TaskError('ALGORITHM_TASK_ID', '需要稳定的原算法任务编号。');
    const row = this.options.database.connection.prepare('SELECT origin_json,operation FROM conversation_algorithm_links WHERE service_task_id=?')
      .get(taskId) as { origin_json: string; operation: string } | undefined;
    const saved = row ? JSON.parse(row.origin_json) as ModelTaskOrigin : null;
    if (!row || !saved || saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId) {
      throw new TaskError('ALGORITHM_TASK_ORIGIN', '原算法任务不属于当前会话分支；不能跨分支查看或准备候选。');
    }
    return row;
  }
  private async wait(context: TaskExecutionContext, taskId: string) {
    const tasks = this.options.companion.tasks;
    context.signal.throwIfAborted();
    let abort!: () => void, unsubscribe = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new TaskError('ALGORITHM_WAIT_STOPPED', '会话已停止等待，原服务任务保持原身份。')); context.signal.addEventListener('abort', abort, { once: true }); });
    const ready = new Promise<void>((resolve, reject) => {
      const check = () => { const task = tasks.get(taskId); if (task.status === 'waiting_approval' || ['succeeded', 'failed', 'cancelled', 'interrupted', 'paused', 'needs_review'].includes(task.status)) resolve(); };
      unsubscribe = tasks.subscribe(event => { if (event.task.id === taskId) check(); });
      check(); void tasks.wait(taskId).then(() => resolve(), reject);
    });
    try { context.signal.throwIfAborted(); await Promise.race([ready, stopped]); }
    finally { unsubscribe(); context.signal.removeEventListener('abort', abort); }
  }
}
