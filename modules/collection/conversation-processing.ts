import type { PersonalCore } from '../agent/runtime/core.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { WorkspaceServices } from '../../contracts/workspace-services.js';
import type { ModelTaskOrigin } from '../agent/model-tools.js';
import type { SkillRegistration } from '../../platform/plugins/registry.js';
import type { SkillField } from '../../contracts/skill-contracts.js';
import { TaskError, type TaskExecutionContext, type TaskRecord } from '../../platform/jobs/tasks.js';
import { acquireAuthority } from '../../platform/runtime/file-workspace.js';
import type { JsonValue, TaskResult } from '../../contracts/task-contracts.js';
import { isWfdRecord } from '../../adapters/database/wfd-transport.js';
import type { OperatorContext, ProcessingPlanInput } from './processing-plan.js';
import { PRODUCTION_MODULES, stepModuleForAction, readWfdModulePage,
  productionModuleDirectory, factorLibraryView, semanticDictionaryView,
  readPublishedWfdSemanticDefinition } from './production-module-ports.js';

const ACTIONS = new Set(['data.processing.capabilities', 'data.processing.route', 'data.processing.plan',
  'data.processing.execute', 'data.processing.run', 'data.processing.status', 'data.processing.recover',
  ...PRODUCTION_MODULES.filter(item => item.id !== 'calculate').map(item => item.action),
  'data.adapters.capabilities', 'data.adapters.propose', 'data.adapters.replay', 'data.adapters.adopt']);
const text = (key: string, label: string, required = false, maxLength = 160): SkillField =>
  ({ key, label, type: 'text', required, maxLength });
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const view = (value: unknown): Record<string, JsonValue> => ({ kind: 'conversation-processing', modelPreview: json(value) });

/**
 * 受信会话宿主到处理计划的桥：材料只来自本会话分支 material.read 的保管关系；
 * 用户目的只来自当前分支真实用户消息；模型可以判断路由和步骤，但不能自授用户目的、权限或发布目标。
 */
export class ConversationProcessingBridge {
  readonly registrations: readonly SkillRegistration[];
  constructor(private readonly options: { database: CoreDatabase; core: PersonalCore; companion: WorkspaceServices;
    origin(taskId: string): ModelTaskOrigin | null }) {
    options.database.migrate('conversation_processing_links', 1, `CREATE TABLE conversation_processing_links(
      ref_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, material_id TEXT,
      origin_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(ref_id,kind));
      CREATE INDEX conversation_processing_origin ON conversation_processing_links(kind,created_at);`);
    const registration = (action: string, title: string, description: string, fields: SkillField[]): SkillRegistration => ({
      action, title, description, fields, runtimeId: 'direct', kind: 'direct', modelCalls: 0,
      permissionSummary: ['仅当前会话分支已保管的原件', '用户目的只引用真实用户原话', '结构检查不等于来源真实性、业务语义或发布资格'],
      available: () => ({ available: !!options.companion.processing, ...(!options.companion.processing ? { reason: '处理计划服务未装配。' } : {}) }),
    });
    const moduleCatalog = () => productionModuleDirectory({
      processing: options.companion.processing,
      calculation: options.companion.productionCalculation,
      hasWfdReader: !!options.companion.r1Workspace?.readProduct,
      enabled: options.companion.productionModuleSwitches,
    });
    const modules: SkillRegistration[] = PRODUCTION_MODULES
      .filter(module => module.id !== 'calculate')
      .map(module => {
        const fields: SkillField[] = module.id === 'factors'
          ? [text('factorId', '可选：已登记因子编号'),
            text('wfdRefJson', '可选：WFD固定产品只读引用', false, 16000)]
          : module.id === 'semantics'
            ? [text('groupId', '可选：语义词典模板分组'),
              text('wfdRefJson', '可选：WFD固定产品只读引用', false, 16000)]
            : [text('planId', '当前分支已冻结的处理计划'),
              text('stepId', '该计划中同类步骤编号'),
              text('wfdRefJson', '可选：WFD固定产品只读引用', false, 16000)];
        const standard = registration(module.action, module.title + '（按需独立接口）',
          '与其他模块并列；五步计划的前置证据仍必须完整。WFD固定来源读取为只读模式，不替代加工、核验或发布。',
          fields);
        return { ...standard,
          permissionSummary: ['受信宿主独立拔插；同一TaskService保留真实任务身份',
            '只有冻结计划同类步骤才可执行；WFD为签名固定快照只读，不自动变成可发布加工产物',
            '因子库登记不启用计算；语义模板不等于词典已采用，不自动裁决来源'],
          available: () => {
            const capability = moduleCatalog().modules.find(item => item.id === module.id);
            const available = capability?.status === 'ready';
            return { available, ...(!available
              ? { reason: '本模块未装配、已被受信宿主拔除或依赖未就绪。' } : {}) };
          },
        };
      });
    this.registrations = [
      ...modules,
      registration('data.processing.capabilities', '发现处理计划与六维路由能力', '先查当前会话分支已保管材料、真实用户消息、六维合同、处理步骤与限制。材料编号只能从这里列出的保管关系取得；不要让用户手填内部编号、六维状态或JSON。未知语义保持unknown并记录缺口，不阻断不依赖它的解析、清洗或结构检查。', []),
      registration('data.processing.route', '按现有原文判断材料路由', '用于单个材料的路由判断（六维：角色、信息性质、业务对象、对象与时间、目的、结构粒度）。dimensionsJson是直接以六维英文键为根的JSON对象文本，不包dimensions或materials。known须有value和evidence；每项证据必须带source：原件用{source:"material",materialId,quote}（原句重复时加start/end），真实用户消息用{source:"user-message",messageId,quote}；会话模型不能自报operator证据。用户目的须由本分支真实用户消息核对。不猜未知，不把模型建议当证据，不让用户填ID或JSON。intendedAction只接受inspect或publish；publish缺目标会needs_target。', [
        text('materialId', '本分支已保管材料编号', true),
        text('dimensionsJson', '六维判断与可核证据', false, 32000),
        text('suggestionsJson', '未采用的模型建议（可选）', false, 8000),
        { key: 'intendedAction', label: '明确用途动作', type: 'select', required: false, options: ['inspect', 'publish'].map(value => ({ value, label: value })) },
      ]),
      registration('data.processing.plan', '准备或修订处理计划', '按材料关系与明确输出规则准备计划；previousPlanId存在时修订原计划。planJson根对象只接受{routing:{materials:[{materialId,dimensions,suggestions,intendedAction}]},outputs:[{outputId,materialIds,tables,target,dimensions,intendedAction}]}。其中每个dimensions直接以六维英文键为根，known证据必须带source，格式与data.processing.capabilities的inputContract一致；不要再包dimensions或materials。材料编号取自本桥列出的本分支保管关系。六维未知仍会生成解析/清洗/结构检查步骤并保留语义缺口；publish仍须目标、必要语义与真实权限，结构检查不替代。修改规则或声明会形成新计划并只复用实际相关旧证明；不让用户手填内部ID或JSON。', [
        text('planJson', '明确计划对象', true, 131072),
        text('previousPlanId', '需修订的原处理计划', false),
      ]),
      registration('data.processing.execute', '执行已计划的一个处理步骤', '只执行本会话分支已准备计划中的单个步骤；按原计划身份、依赖和预算执行，不越过未完成前置，不重算其他步骤。已完成步骤只查询，不重复执行。', [
        text('planId', '本分支处理计划', true), text('stepId', '计划内步骤编号', true),
      ]),
      registration('data.processing.run', '按顺序运行处理计划', '运行本会话分支已准备计划中仍待执行的步骤；每阶段持久后检查停止与预算。已成功步骤按原证明查询/复用，不重复计算；失败或阻塞保留原件与上游产物。', [
        text('planId', '本分支处理计划', true),
      ]),
      registration('data.processing.status', '查询原处理计划与产物', '只读取本会话分支已链接的计划、步骤和路由事实；查询不重算、不重发、不推进。可给planId、taskId或materialId之一。缺项回原计划；对象损坏另行明确恢复，不在查询中静默修复。', [
        text('planId', '原处理计划', false), text('taskId', '原处理任务', false), text('materialId', '原材料编号', false),
      ]),
      registration('data.processing.recover', '核对原处理计划产物', '按原计划身份核对已持久化步骤对象的存在、长度和摘要；不重跑完成步骤，不修改旧计划，不把损坏对象静默当成通过。真实恢复只推进未完成且可继续的步骤。', [
        text('planId', '原处理计划', true),
      ]),
      registration('data.adapters.capabilities', '查看端点适配版本、重放证据与漂移异常', '只读列出已登记适配版本、采用状态、重放证据摘要与漂移原因。查看不采用、不改配置、不影响任何既有计划。', []),
      registration('data.adapters.propose', '提交端点适配候选配置', '只登记候选配置及其摘要，不采用、不解析、不影响新计划；配置须为受控字段/位置/单位声明，不能包含脚本或任意表达式。候选采用须另经本机受信入口确认。', [
        text('configJson', '完整适配配置对象', true, 131072),
      ]),
      registration('data.adapters.replay', '用本分支材料重放适配候选', '对候选配置在本分支已保管的原件上实际执行五步并逐项核对期望值；只写入重放证据，不采用配置。缺字段、坏数值、无效时间与不符期望都记为失败。', [
        text('adapterId', '适配编号', true), text('version', '适配版本', true),
        text('samplesJson', '样本数组：materialId/expectation/expectedCode/expect', true, 32000),
      ]),
      registration('data.adapters.adopt', '经真实审批采用适配版本', '采用属于权限动作：须先经本机审批回执，回执绑定本次动作、参数、调用与父运行；批准后再次核对适配编号、版本、配置摘要与重放证据摘要。会话模型不能自授权、不能只凭正文 authorized 采用。', [
        text('adapterId', '适配编号', true), text('version', '适配版本', true),
        text('configDigest', '已登记配置摘要', true), text('evidenceDigest', '重放证据摘要', true),
        text('confirmationDigest', '确认的重放证据摘要', true),
      ]),
    ];
  }
  handles(action: string): boolean { return ACTIONS.has(action); }

  async execute(context: TaskExecutionContext, action: string, args: Record<string, JsonValue>): Promise<TaskResult> {
    if (!this.handles(action)) throw new TaskError('PROCESSING_ACTION', '未登记的处理会话动作。');
    const origin = this.options.origin(context.task.id);
    if (!origin) throw new TaskError('PROCESSING_ORIGIN', '处理计划工具必须由本次真实会话代理调用。');
    const service = this.options.companion.processing;
    const moduleAction = PRODUCTION_MODULES.find(item => item.action === action && item.id !== 'calculate');
    // 因子/语义目录是独立只读模块；既有处理计划与端点适配仍按原边界装配。
    if (!service && !moduleAction && !action.startsWith('data.adapters.'))
      throw new TaskError('PROCESSING_UNAVAILABLE', '处理计划服务未装配。');
    this.options.companion.bd!.assertDispatch();
    context.signal.throwIfAborted();
    // 处理计划桥不向模型发送完整行，但仍须由受控上下文确认本次结果可发送给当前模型。
    // 这一步只建立模型分享回执，不替处理步骤或数据库提交授权，也不扩大文件权限。
    // 适配写入/权限动作保留审核；只读查看仍为自动，沿用同一受信上下文。
    const authority = await acquireAuthority(context, action, args, [],
      action.startsWith('data.adapters.') && action !== 'data.adapters.capabilities' ? { approvalMode: 'review' } : {});
    authority.assert();
    if (action.startsWith('data.adapters.')) return this.executeAdapter(context, action, args, origin, authority);
    if (moduleAction) {
      const directory = productionModuleDirectory({
        processing: service, calculation: this.options.companion.productionCalculation,
        hasWfdReader: !!this.options.companion.r1Workspace?.readProduct,
        enabled: this.options.companion.productionModuleSwitches,
      });
      if (directory.modules.find(item => item.id === moduleAction.id)?.status !== 'ready')
        throw new TaskError('PRODUCTION_MODULE_UNAVAILABLE', '该并列模块未启用或其受信依赖不可用。');
      const rawReference = typeof args.wfdRefJson === 'string' && args.wfdRefJson.trim()
        ? args.wfdRefJson : null;
      let wfdPage: unknown = null, selection: unknown = null;
      if (rawReference) {
        if (args.planId || args.stepId) throw new TaskError('PRODUCTION_MODULE_MODE',
          'WFD只读分页不能与原处理步骤执行同时提交；先分别核验来源与加工计划。');
        const read = this.options.companion.r1Workspace?.readProduct;
        if (!read) throw new TaskError('PRODUCTION_MODULE_WFD_UNAVAILABLE', '真实WFD只读端口尚未装配。');
        let wfdRef: unknown;
        try { wfdRef = JSON.parse(rawReference); }
        catch { throw new TaskError('PRODUCTION_MODULE_WFD_REFERENCE', '固定WFD来源引用必须为合法JSON。'); }
        selection = wfdRef;
        wfdPage = await readWfdModulePage(
          moduleAction.id as Exclude<typeof moduleAction.id, 'calculate'>, wfdRef,
          read.bind(this.options.companion.r1Workspace), context.signal);
        authority.assert();
      }
      if (moduleAction.id === 'factors' || moduleAction.id === 'semantics') {
        if (args.planId || args.stepId) throw new TaskError('PRODUCTION_MODULE_MODE',
          '因子库与语义词典只读，不执行原报五步计划。');
        const catalog = moduleAction.id === 'factors'
          ? factorLibraryView(typeof args.factorId === 'string' && args.factorId.trim()
            ? args.factorId.trim() : undefined)
          : semanticDictionaryView(typeof args.groupId === 'string' && args.groupId.trim()
            ? args.groupId.trim() : undefined);
        let publishedDefinition: unknown = null;
        if (moduleAction.id === 'semantics' && selection) {
          const discover = this.options.companion.r1Workspace?.discoverProducts;
          if (!discover) throw new TaskError('PRODUCTION_SEMANTIC_WFD_UNAVAILABLE',
            '正式语义词典需要实际 WFD 固定产品发现接口；不能以模板假装已经入库。');
          publishedDefinition = await readPublishedWfdSemanticDefinition(selection,
            discover.bind(this.options.companion.r1Workspace), context.signal);
          authority.assert();
        }
        return { summary: publishedDefinition
          ? '语义模板与 WFD 固定快照正式定义已分开读取；没有计算、自动标注或变更 WFD。'
          : moduleAction.title + '已按需读取受信登记或仅供参考的模板；没有计算或变更WFD。',
          data: view({ module: moduleAction.id, catalog, wfdPage, publishedDefinition,
            publication: 'not_requested' }) };
      }
      const stage = stepModuleForAction(action);
      if (!stage) throw new TaskError('PRODUCTION_MODULE_KIND', '此动作不是受信加工模块。');
      if (wfdPage) return { summary: '已按该模块接口读取固定WFD当页事实；没有执行清洗五步。',
        data: view({ module: stage, wfdPage, execution: 'read_only' }) };
      if (!service) throw new TaskError('PROCESSING_UNAVAILABLE', '本宿主没有原报加工计划执行服务。');
      const planId = typeof args.planId === 'string' ? args.planId : '';
      const stepId = typeof args.stepId === 'string' ? args.stepId : '';
      if (!planId || !stepId) throw new TaskError('PRODUCTION_MODULE_STEP',
        '执行处理模块须提供当前分支真实计划与其中同类步骤；否则请指定固定WFD只读引用。');
      this.assertPlan(planId, origin);
      const found = service.get(planId);
      if (!found.steps.some(step => step.stepId === stepId && step.kind === stage))
        throw new TaskError('PRODUCTION_MODULE_STEP_MISMATCH',
          '该计划没有所选模块对应步骤，不能改写冻结步骤类型。');
      const task = service.executeStep(planId, stepId, this.operator(origin, context.task.id));
      this.link(task.id, task.id, origin, 'execution', planId);
      const done = await this.wait(context, task.id);
      authority.assert();
      return this.taskResult('已按需执行所选独立加工模块，结果仍遵守原冻结计划前置证明。',
        done, this.safePlan(planId));
    }
    if (!service) throw new TaskError('PROCESSING_UNAVAILABLE', '处理计划服务未装配。');
    if (action === 'data.processing.capabilities') {
      return { summary: '已列出本分支材料关系、真实用户消息与处理计划合同；未知语义不预填。',
        data: view(this.capabilitiesView(origin)) };
    }
    const operator = this.operator(origin, context.task.id);
    if (action === 'data.processing.route') {
      const materialId = String(args.materialId ?? '');
      this.assertMaterial(materialId, origin);
      const dimensions = this.parseObject(args.dimensionsJson, '维度判断');
      const suggestions = this.parseArray(args.suggestionsJson);
      const intendedAction = args.intendedAction === 'publish' ? 'publish' : 'inspect';
      const task = service.decideMaterial({ materialId, ...(dimensions ? { dimensions } : {}), ...(suggestions.length ? { suggestions } : {}),
        intendedAction }, operator);
      const done = await this.wait(context, task.id);
      const route = service.getByTask(task.id);
      if (route?.decision) this.link(route.decision.decisionId, task.id, origin, 'decision', materialId);
      return this.taskResult('材料路由判断已保存；未知维度保持缺口。', done, route);
    }
    if (action === 'data.processing.plan') {
      let planInput: unknown;
      try { planInput = JSON.parse(String(args.planJson)); }
      catch { throw new TaskError('PROCESSING_JSON', '计划对象不是有效JSON。'); }
      if (!isWfdRecord(planInput)) throw new TaskError('PROCESSING_INPUT', '计划对象须为明确对象。');
      this.assertPlanMaterials(planInput, origin);
      const previousPlanId = typeof args.previousPlanId === 'string' && args.previousPlanId ? args.previousPlanId
        : typeof planInput.previousPlanId === 'string' && planInput.previousPlanId ? planInput.previousPlanId : undefined;
      if (previousPlanId) this.assertPlan(previousPlanId, origin);
      const task = previousPlanId ? service.revisePlan(previousPlanId, planInput, operator)
        : service.preparePlan(planInput as unknown as ProcessingPlanInput, operator);
      const planId = String((task.args as { planId?: unknown }).planId ?? '');
      if (planId) this.link(planId, task.id, origin, 'plan', null);
      const done = await this.wait(context, task.id);
      const found = planId ? this.safePlan(planId) : null;
      return this.taskResult(previousPlanId ? '已按原计划身份形成修订计划；旧证明只在相关绑定仍有效时复用。' : '已形成处理计划；未知语义保留缺口，未声称发布资格。', done, found);
    }
    const planId = typeof args.planId === 'string' ? args.planId : '';
    if (planId) this.assertPlan(planId, origin);
    if (action === 'data.processing.execute') {
      const task = service.executeStep(planId, String(args.stepId ?? ''), operator);
      // 只登记本分支刚创建的执行任务，status(taskId) 才能复核；不接受模型或 HTTP 自带的任务编号。
      this.link(task.id, task.id, origin, 'execution', planId);
      const done = await this.wait(context, task.id);
      return this.taskResult('已按原计划执行单个步骤；完成产物与缺口以查询事实为准。', done, this.safePlan(planId));
    }
    if (action === 'data.processing.run') {
      const task = service.runPlan(planId, operator);
      this.link(task.id, task.id, origin, 'execution', planId);
      const done = await this.wait(context, task.id);
      return this.taskResult('已运行原计划中可执行步骤；停止、失败和阻塞按原任务与步骤事实报告。', done, this.safePlan(planId));
    }
    if (action === 'data.processing.recover') {
      const task = service.recoverPlan(planId, operator);
      this.link(task.id, task.id, origin, 'execution', planId);
      const done = await this.wait(context, task.id);
      return this.taskResult('已核对原计划持久产物；没有重跑已完成步骤。', done, this.safePlan(planId));
    }
    // 查询：优先 planId；其次 taskId；再次该分支最近一次材料路由决定。
    const taskId = typeof args.taskId === 'string' && args.taskId ? args.taskId : null;
    const materialId = typeof args.materialId === 'string' && args.materialId ? args.materialId : null;
    if (taskId) this.assertTaskLink(taskId, origin);
    let found: unknown = planId ? this.safePlan(planId) : taskId ? service.getByTask(taskId) : null;
    if (!found && materialId) {
      const routedTask = this.latestDecisionTask(materialId, origin);
      if (routedTask) found = service.getByTask(routedTask);
    }
    if (!found) throw new TaskError('PROCESSING_PLAN_NOT_FOUND', '没有本会话分支可核的原处理计划、任务或材料路由。');
    return { summary: '已读取原处理计划与步骤事实；查询未触发重算。', data: view(this.planPreview(found, { query: true })) };
  }

  /**
   * 端点适配受控工具：查看、候选、重放只走会话分支材料；采用必须持有真实审批回执，
   * 并在批准后再次核对同一适配编号、版本、配置摘要与重放证据摘要。
   */
  private async executeAdapter(context: TaskExecutionContext, action: string, args: Record<string, JsonValue>,
    origin: ModelTaskOrigin, authority: Awaited<ReturnType<typeof acquireAuthority>>): Promise<TaskResult> {
    const registry = this.options.companion.endpointAdapters;
    if (!registry) throw new TaskError('ADAPTER_UNAVAILABLE', '本实例未装配端点适配登记。');
    const operator = this.operator(origin, context.task.id);
    if (action === 'data.adapters.capabilities') {
      // 异常查看守会话分支边界：只返回本分支已保管材料的异常，其他材料只给计数，不含编号或错误内容。
      const linked = new Set(this.linkedMaterialIds(origin));
      const all = registry.exceptions(100) as unknown as { items: { materialId: string | null; message: string; code: string }[]; limit: number };
      const visible = all.items.filter(item => item.materialId !== null && linked.has(item.materialId));
      return { summary: '已读取适配版本与采用状态；异常按本分支材料边界过滤。',
        data: view({ contract: 'conversation-adapters/1', catalog: registry.catalog(),
          exceptions: { items: visible, limit: all.limit, hidden: all.items.length - visible.length,
            note: '其他分支材料的异常只计数，不返回编号或错误内容。' },
          guidance: '候选提交与重放不改变采用状态；采用须本机审批回执，模型不能自授权。' }) };
    }
    if (action === 'data.adapters.propose') {
      let config: unknown;
      try { config = JSON.parse(String(args.configJson)); } catch { throw new TaskError('ADAPTER_INPUT', '适配配置不是有效 JSON。'); }
      const result = registry.propose({ config }, operator);
      return { summary: '已登记适配候选；未采用，未影响任何计划。', data: view({ status: result.status, adapterId: result.adapterId,
        version: result.version, configDigest: result.configDigest, created: result.created }) };
    }
    if (action === 'data.adapters.replay') {
      let samples: unknown;
      try { samples = JSON.parse(String(args.samplesJson)); } catch { throw new TaskError('ADAPTER_REPLAY', '样本数组不是有效 JSON。'); }
      if (!Array.isArray(samples) || !samples.length) throw new TaskError('ADAPTER_REPLAY', '重放须提供明确样本数组。');
      // 每个样本的原件必须属于本会话分支；不能借其他会话或任意材料编号重放。
      for (const sample of samples) {
        if (!isWfdRecord(sample) || typeof sample.materialId !== 'string') throw new TaskError('ADAPTER_REPLAY', '样本须明确引用本分支材料编号。');
        this.assertMaterial(sample.materialId, origin);
      }
      const result = registry.replay({ adapterId: String(args.adapterId ?? ''), version: String(args.version ?? ''), samples }, operator);
      return { summary: result.passed === true ? '重放样本全部符合期望；仍未采用配置。' : '存在未通过的重放样本；该组证据不可用于采用。',
        data: view(result) };
    }
    if (action === 'data.adapters.adopt') {
      // 复用外层同一授权：未批准时已在 requestApproval 处等待或拒绝，不会落到采用写入。
      authority.assert();
      if (!authority.approvalId) throw new TaskError('ADAPTER_ADOPTION_AUTHORITY', '适配采用须有本机真实审批回执；模型不能自授权。');
      const adapterId = String(args.adapterId ?? ''), version = String(args.version ?? ''), configDigest = String(args.configDigest ?? '');
      type AdapterRow = { version: string; configDigest: string; status: string };
      const rows = registry.list(adapterId) as unknown as AdapterRow[];
      const listed = rows.find(row => row.version === version);
      if (!listed || listed.configDigest !== configDigest) throw new TaskError('ADAPTER_CONFIG_CHANGED', '批准后登记的配置摘要已变化；未采用。');
      const adopted = registry.adopt({ adapterId, version, configDigest, evidenceDigest: String(args.evidenceDigest ?? ''),
        confirmationDigest: String(args.confirmationDigest ?? '') }, { operatorId: 'approval.' + authority.approvalId,
        requestId: 'approval:' + authority.approvalId, method: 'POST', path: '/model/approval', remoteAddress: null, observedAt: Date.now() });
      // 批准与采用之间登记被改写时，本次采用无效。
      authority.assert();
      const after = (registry.list(adapterId) as unknown as AdapterRow[]).find(row => row.version === version);
      if (!after || after.status !== 'adopted' || after.configDigest !== configDigest)
        throw new TaskError('ADAPTER_ADOPTION_CHANGED', '采用后登记状态或摘要与本次批准不一致；请重新核对。');
      return { summary: '已按本机审批回执采用适配版本；旧计划不因新采用改写。', data: view({ adapterId, version,
        configDigest, status: after.status, adoption: adopted.adoption }) };
    }
    throw new TaskError('PROCESSING_ACTION', '未登记的适配会话动作。');
  }

  private operator(origin: ModelTaskOrigin, taskId: string): OperatorContext {
    return { operatorId: 'conversation:' + origin.conversationId, requestId: 'conversation:' + taskId,
      method: 'conversation', path: `/conversation/${origin.conversationId}/${origin.branchId}`,
      remoteAddress: null, observedAt: Date.now(), source: 'conversation',
      conversation: { conversationId: origin.conversationId, branchId: origin.branchId,
        verifyUserMessage: (messageId, quote) => this.verifyUserMessage(origin, messageId, quote) } };
  }
  private verifyUserMessage(origin: ModelTaskOrigin, messageId: string, quote: string): boolean {
    if (!quote.trim()) return false;
    let id: string | null = origin.messageId, seen = new Set<string>();
    while (id && seen.size < 24) {
      if (seen.has(id)) return false; seen.add(id);
      const message = this.options.core.store.message(id);
      if (message.conversation_id !== origin.conversationId) return false;
      if (id === messageId) return message.role === 'user' && message.text.includes(quote);
      id = message.parent_id;
    }
    return false;
  }
  private userMessages(origin: ModelTaskOrigin) {
    const result: { id: string; text: string }[] = [];
    let id: string | null = origin.messageId, remaining = 3000, seen = new Set<string>();
    while (id && result.length < 6 && remaining > 0 && seen.size < 24) {
      if (seen.has(id)) break; seen.add(id);
      const message = this.options.core.store.message(id);
      if (message.conversation_id !== origin.conversationId) break;
      if (message.role === 'user') {
        const text = message.text.slice(0, Math.min(1200, remaining)); remaining -= text.length;
        result.push({ id, text });
      }
      id = message.parent_id;
    }
    return result.reverse();
  }
  /** 本分支已保管材料编号；用于异常与重放的分支边界。 */
  private linkedMaterialIds(origin: ModelTaskOrigin): string[] {
    const rows = this.options.database.connection.prepare(`SELECT material_id FROM conversation_material_links
      WHERE origin_json LIKE ? AND material_id IS NOT NULL`).all(`%"conversationId":"${origin.conversationId}"%"branchId":"${origin.branchId}"%`) as { material_id: string }[];
    return rows.map(row => row.material_id);
  }
  private capabilitiesView(origin: ModelTaskOrigin) {
    const service = this.options.companion.processing!;
    const rows = this.options.database.connection.prepare(`SELECT material_id FROM conversation_material_links
      WHERE origin_json LIKE ? ORDER BY created_at DESC,rowid DESC LIMIT 20`)
      .all(`%"conversationId":"${origin.conversationId}"%"branchId":"${origin.branchId}"%`) as { material_id: string }[];
    const materials = rows.flatMap(row => {
      try { const material = this.options.companion.materials!.get(row.material_id);
        const taskId = this.latestDecisionTask(row.material_id, origin);
        const routing = taskId ? (this.options.companion.processing!.getByTask(taskId)?.decision as { routingState?: string } | null)?.routingState : null;
        return [{ materialId: row.material_id, filename: material.envelope.filename, sha256: material.envelope.sha256.slice(0, 16),
          format: material.preview.format, support: material.preview.support, routing: routing ?? 'needs_classification' }];
      } catch { return []; }
    });
    return { contract: 'conversation-processing/1', conversation: { conversationId: origin.conversationId, branchId: origin.branchId,
      userMessages: this.userMessages(origin) }, materials,
      inputContract: {
        dimensionsJson: { allowedKeys: ['role', 'informationNature', 'businessObject', 'objectTime', 'purpose', 'structureGranularity'],
          root: '直接使用六维键，不加dimensions或materials外层；序列化为JSON字符串后传给route。planJson内的dimensions也使用相同对象。',
          example: { role: { status: 'unknown', gap: '材料角色尚待原文核对。' }, purpose: { status: 'unknown', gap: '使用目的尚待真实用户消息核对。' } },
          known: 'known须同时有value与非空evidence；unknown/conflict保留gap，不携带已确定value。' },
        evidence: {
          material: { required: ['source', 'materialId', 'quote'], source: 'material',
            materialId: '从materials取当前原件编号', quote: '引用已读原件中的唯一真实原句；重复时给准确start/end' },
          userMessage: { required: ['source', 'messageId', 'quote'], source: 'user-message',
            messageId: '从conversation.userMessages取真实编号', quote: '逐字引用该消息中的真实原句；程序核对当前分支' },
          operator: '仅受信HTTP操作者使用；会话模型不得自报operator证据或用材料文字授权purpose。' },
        planJson: { rootKeys: ['routing', 'outputs'],
          dimensionsPath: 'routing.materials[].dimensions和outputs[].dimensions直接使用相同六维对象；不要加第二层dimensions或materials。' },
      },
      catalog: service.catalog(),
      parallelModuleDirectory: productionModuleDirectory({
        processing: service, calculation: this.options.companion.productionCalculation,
        hasWfdReader: !!this.options.companion.r1Workspace?.readProduct,
        enabled: this.options.companion.productionModuleSwitches,
      }),
      guidance: '材料编号只从materials取；六维只写可核事实，未知保持unknown。用户目的必须引用conversation.userMessages中的真实原话。结构检查通过不等于来源真实性、业务语义或发布资格已验证；发布目标与用户授权不能由模型补造。' };
  }
  private taskResult(summary: string, task: TaskRecord, found: unknown): TaskResult {
    if (task.status !== 'succeeded') return { summary: `${summary} 原任务状态：${task.status}。`,
      data: view({ taskId: task.id, status: task.status, error: task.error ?? null, plan: found ?? null }) };
    return { summary, data: view(this.planPreview(found, { taskId: task.id })) };
  }
  /** 有界模型视图：保留可核事实与步骤状态，不分享完整表行或对象内容。 */
  private planPreview(found: unknown, extra: { taskId?: string; query?: boolean } = {}): JsonValue {
    const plan = found && isWfdRecord(found) && isWfdRecord(found.plan) ? found.plan as Record<string, unknown>
      : found && isWfdRecord(found) && typeof found.planId === 'string' ? found as Record<string, unknown> : null;
    const decision = found && isWfdRecord(found) && isWfdRecord(found.decision) ? found.decision : null;
    if (!plan) return json({ ...((found && isWfdRecord(found)) ? found : { found: null }), ...extra,
      guidance: '没有计划文档；只返回原任务或决定事实。' });
    const output = Array.isArray(plan.outputs) ? plan.outputs as Record<string, unknown>[] : [];
    const steps = Array.isArray(plan.steps) ? plan.steps as Record<string, unknown>[] : [];
    const materials = Array.isArray(plan.materials) ? plan.materials as Record<string, unknown>[] : [];
    const preview = { taskId: extra.taskId ?? null, planId: plan.planId, status: plan.status, parentPlanId: plan.parentPlanId,
      operator: plan.operator, policyDigest: plan.policyDigest, executionDigest: plan.executionDigest,
      materials: materials.map(material => ({ materialId: material.materialId, filename: material.filename, sha256: material.sha256,
        format: material.format, support: material.support, custodyState: material.custodyState, routingState: material.routingState, gaps: material.gaps,
        dimensions: this.dimensions(material.dimensions) })),
      outputs: output.map(item => ({ outputId: item.outputId, materialIds: item.materialIds, intendedAction: item.intendedAction,
        target: item.target, routingState: item.routingState, state: item.state, gaps: item.gaps, semanticGaps: item.semanticGaps,
        publishEligible: item.publishEligible, evidenceScope: item.evidenceScope, steps: item.steps })),
      steps: steps.map(step => this.step(step)), decision,
      query: extra.query === true, guidance: '清洗变化数只统计显式去空白与空值规则；结构步骤另列类型转换与十进制词面规范化，清洗为零不表示输出词面未变。旧产物若标记 not_recorded，变化数未知，不能按零解释。结构产物只证明编码、形状、类型、行预算与摘要；来源真实性、业务语义、对象时间、发布权限仍以缺口和真实用户输入为准。' };
    let text = JSON.stringify(preview);
    if (Buffer.byteLength(text, 'utf8') > 22000) {
      const normalizationCounts = (value: unknown) => isWfdRecord(value) ? {
        state: value.state, scope: value.scope, clean_changes_total: value.clean_changes_total, type_changes_total: value.type_changes_total,
        decimal_lexeme_changes_total: value.decimal_lexeme_changes_total,
        type_changes_sample_count: value.type_changes_total === null ? null : 0,
        type_changes_truncated: value.type_changes_total === null ? null : Number(value.type_changes_total) > 0,
      } : null;
      const compact = { ...preview, steps: preview.steps.map(step => ({ ...step, gaps: Array.isArray(step.gaps) ? step.gaps.slice(0, 4) : [],
        normalization: normalizationCounts(step.normalization) })),
        outputs: preview.outputs.map(item => ({ ...item, steps: Array.isArray(item.steps) ? item.steps.map(step => isWfdRecord(step)
          ? { stepId: step.stepId, kind: step.kind, state: step.state, normalization: normalizationCounts(step.normalization) } : step) : item.steps })) };
      text = JSON.stringify(compact);
    }
    return JSON.parse(text) as JsonValue;
  }
  private dimensions(value: unknown) {
    return Array.isArray(value) ? value.slice(0, 6).map(item => isWfdRecord(item) ? { key: item.key, status: item.status,
      value: item.value, gap: item.gap, evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 3).map(evidence =>
        isWfdRecord(evidence) ? { source: evidence.source, quote: String(evidence.quote ?? '').slice(0, 160), messageId: evidence.messageId,
          materialId: evidence.materialId, start: evidence.start, end: evidence.end } : evidence) : [] } : item) : [];
  }
  private step(step: Record<string, unknown>) {
    return { stepId: step.stepId, outputId: step.outputId, kind: step.kind, required: step.required, applicability: step.applicability,
      state: step.state, dependsOn: step.dependsOn, implementation: step.implementation, gaps: step.gaps,
      outputDigest: step.outputDigest, reusedFrom: step.reusedFrom, normalization: step.normalization };
  }
  private parseObject(value: unknown, label: string): Record<string, unknown> | null {
    if (value === undefined || value === '') return null;
    let parsed: unknown;
    try { parsed = JSON.parse(String(value)); } catch { throw new TaskError('PROCESSING_JSON', `${label}不是有效JSON。`); }
    if (!isWfdRecord(parsed)) throw new TaskError('PROCESSING_INPUT', `${label}须为明确对象。`);
    return parsed;
  }
  private parseArray(value: unknown): unknown[] {
    if (value === undefined || value === '') return [];
    let parsed: unknown;
    try { parsed = JSON.parse(String(value)); } catch { throw new TaskError('PROCESSING_JSON', '模型建议不是有效JSON。'); }
    if (!Array.isArray(parsed)) throw new TaskError('PROCESSING_SUGGESTIONS', '模型建议须为数组。');
    return parsed;
  }
  private assertPlanMaterials(input: Record<string, unknown>, origin: ModelTaskOrigin): void {
    const routing = isWfdRecord(input.routing) ? input.routing : null;
    const materials = routing && Array.isArray(routing.materials) ? routing.materials : [];
    const ids = new Set<string>();
    for (const item of materials) {
      if (!isWfdRecord(item) || typeof item.materialId !== 'string') throw new TaskError('PROCESSING_MATERIAL_ID', '路由材料须有明确材料编号。');
      this.assertMaterial(item.materialId, origin); ids.add(item.materialId);
    }
    const outputs = Array.isArray(input.outputs) ? input.outputs : [];
    for (const output of outputs) {
      if (!isWfdRecord(output) || !Array.isArray(output.materialIds)) continue;
      for (const materialId of output.materialIds) if (typeof materialId !== 'string' || !this.assertMaterialSafe(materialId, origin)) {
        throw new TaskError('PROCESSING_MATERIAL_ORIGIN', '输出引用的材料不属于当前会话分支的保管关系。');
      }
    }
  }
  private assertMaterialSafe(materialId: string, origin: ModelTaskOrigin): boolean {
    try { this.assertMaterial(materialId, origin); return true; } catch { return false; }
  }
  private assertMaterial(materialId: string, origin: ModelTaskOrigin): void {
    const exists = this.options.database.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_material_links'").get();
    const row = exists && materialId ? this.options.database.connection.prepare('SELECT origin_json FROM conversation_material_links WHERE material_id=?').get(materialId) : undefined;
    const saved: unknown = row ? JSON.parse(String(row.origin_json)) : null;
    if (!isWfdRecord(saved) || saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId) {
      throw new TaskError('PROCESSING_MATERIAL_ORIGIN', '处理计划只接受本会话分支通过material.read保管的原件。');
    }
  }
  private assertPlan(planId: string, origin: ModelTaskOrigin): void {
    const row = this.options.database.connection.prepare("SELECT origin_json FROM conversation_processing_links WHERE ref_id=? AND kind='plan'").get(planId);
    const saved: unknown = row ? JSON.parse(String(row.origin_json)) : null;
    if (!isWfdRecord(saved) || saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId) {
      throw new TaskError('PROCESSING_PLAN_ORIGIN', '该处理计划不属于当前会话分支。');
    }
  }
  private assertTaskLink(taskId: string, origin: ModelTaskOrigin): void {
    const row = this.options.database.connection.prepare('SELECT origin_json FROM conversation_processing_links WHERE task_id=?').get(taskId);
    const saved: unknown = row ? JSON.parse(String(row.origin_json)) : null;
    if (!isWfdRecord(saved) || saved.conversationId !== origin.conversationId || saved.branchId !== origin.branchId) {
      throw new TaskError('PROCESSING_TASK_ORIGIN', '该处理任务不属于当前会话分支。');
    }
  }
  private latestDecisionTask(materialId: string, origin: ModelTaskOrigin): string | null {
    const rows = this.options.database.connection.prepare(`SELECT task_id,origin_json FROM conversation_processing_links
      WHERE kind='decision' AND material_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20`).all(materialId) as { task_id: string; origin_json: string }[];
    for (const row of rows) {
      try { const saved: unknown = JSON.parse(row.origin_json);
        if (isWfdRecord(saved) && saved.conversationId === origin.conversationId && saved.branchId === origin.branchId) return row.task_id;
      } catch { /* 旧链接不可核时跳过，不在查询中重建事实。 */ }
    }
    return null;
  }
  private safePlan(planId: string): unknown {
    try { return this.options.companion.processing!.get(planId); } catch { return null; }
  }
  private link(refId: string, taskId: string, origin: ModelTaskOrigin, kind: string, materialId: string | null): void {
    this.options.database.connection.prepare('INSERT OR IGNORE INTO conversation_processing_links VALUES(?,?,?,?,?,?)')
      .run(refId, taskId, kind, materialId, JSON.stringify(origin), Date.now());
  }
  private async wait(context: TaskExecutionContext, taskId: string): Promise<TaskRecord> {
    const tasks = this.options.companion.tasks;
    context.signal.throwIfAborted();
    let abort!: () => void, unsubscribe = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { abort = () => reject(new TaskError('PROCESSING_WAIT_STOPPED', '会话已停止等待，原处理任务保持原身份。')); context.signal.addEventListener('abort', abort, { once: true }); });
    const ready = new Promise<void>((resolve, reject) => {
      const check = () => { const task = tasks.get(taskId); if (['succeeded', 'failed', 'cancelled', 'interrupted', 'paused', 'needs_review', 'waiting_approval'].includes(task.status)) resolve(); };
      unsubscribe = tasks.subscribe(event => { if (event.task.id === taskId) check(); });
      check(); void tasks.wait(taskId).then(() => resolve(), reject);
    });
    try { context.signal.throwIfAborted(); await Promise.race([ready, stopped]); }
    finally { unsubscribe(); context.signal.removeEventListener('abort', abort); }
    return tasks.get(taskId);
  }
}
