import { TaskError, type TaskRecord } from '../../platform/jobs/tasks.js';
import { isWfdRecord } from '../../adapters/database/wfd-transport.js';
import type { OperatorContext, ProcessingPlanService, ProcessingStepKind } from './processing-plan.js';
import type { ProductionCalculation } from './production-calculation.js';
import type { R1WorkspaceService } from './r1-workspace.js';
import { ALGORITHM_DEFINITIONS, ALGORITHM_DEFINITION_SUMMARY } from '../financial/algorithm-definitions.js';
import { ALGORITHM_REGISTRY } from '../financial/algorithm-registry.js';
import { FIXED_CALCULATION_METHODS } from '../../contracts/fixed-calculation-contracts.js';

export const PRODUCTION_MODULE_PORTS_VERSION = 'bd.production-module-ports/2';
export const PRODUCTION_MODULE_IDS = ['parse', 'clean', 'structure', 'annotate', 'check', 'calculate',
  'factor_library', 'semantic_dictionary'] as const;
export type ProductionModuleId = typeof PRODUCTION_MODULE_IDS[number];
type ProcessingModuleId = ProcessingStepKind;
const STEPS: readonly ProcessingModuleId[] = ['parse', 'clean', 'structure', 'annotate', 'check'];
const ACTIONS: Record<ProductionModuleId, string> = {
  parse: 'data.module.parse', clean: 'data.module.clean', structure: 'data.module.structure',
  annotate: 'data.module.annotate', check: 'data.module.check', calculate: 'algorithms.calculate',
  factor_library: 'data.factor.catalog', semantic_dictionary: 'data.semantic.lookup',
};
const LABELS: Record<ProductionModuleId, string> = {
  parse: '解析原件', clean: '显式数据清洗', structure: '严格类型结构化',
  annotate: '受控常量标注', check: '结构与语义核对', calculate: '金融公式与因子计算',
  factor_library: '因子与公式库', semantic_dictionary: 'WFD 语义词典',
};
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const id = (value: unknown) => typeof value === 'string'
  && /^[A-Za-z0-9_.:/-]{1,160}$/u.test(value) && !/^(latest|current)$/iu.test(value);

/**
 * Eight equal, removable business ports. The ports do not create task schedulers,
 * copy WFD data, publish records, or execute another module implicitly.
 *
 * Five stage ports delegate to the original durable processing task; calculation
 * delegates to the existing trusted Polars/pandas method registry.
 * Factor-library and semantic-dictionary ports are read-only: factor definitions come
 * from the existing frozen algorithm registry, semantic definitions from the actual
 * WFD snapshot's product declarations. Neither claims a template is an adopted fact.
 * The shared read_product is a bounded, snapshot-pinned WFD read-only adapter.
 */
export class ProductionModulePorts {
  constructor(private readonly options: {
    processing?: Pick<ProcessingPlanService, 'get' | 'executeStep' | 'moduleStatus'>;
    calculation?: Pick<ProductionCalculation, 'capabilities' | 'submit' | 'publish'>;
    wfd?: Pick<R1WorkspaceService, 'capabilities' | 'readProduct' | 'discoverProducts'>;
    enabledModules?: Partial<Record<ProductionModuleId, boolean>>;
  }) {}

  capability(moduleId: ProductionModuleId) {
    if (!PRODUCTION_MODULE_IDS.includes(moduleId)) return fail('PRODUCTION_MODULE_UNKNOWN', '模块编号不属于六个固定端口。');
    const wfd = this.options.wfd?.capabilities();
    const wfdReadable = !!wfd?.connection && wfd.configuration.state === 'ready';
    const result = moduleId === 'calculate' ? (() => {
      const calc = this.options.calculation?.capabilities();
      const methods = calc?.methods.filter(method => method.status === 'ready').map(method => method.methodId) ?? [];
      return { available: methods.length > 0, reason: methods.length ? null : '未装配可运行的受信计算方法或固定 WFD 来源。',
        implementation: calc?.version ?? 'not_bound', methods };
    })() : moduleId === 'factor_library' ? {
      available: true, reason: null, implementation: ALGORITHM_DEFINITION_SUMMARY.version,
      methods: [] as string[],
    } : moduleId === 'semantic_dictionary' ? {
      available: wfdReadable, reason: wfdReadable ? null : 'WFD 语义词典只来自固定快照的已发布产品定义，当前只读连接未就绪。',
      implementation: 'wfd.data-service/definitions', methods: [] as string[],
    } : (() => {
      const stage = this.options.processing?.moduleStatus(moduleId as ProcessingModuleId);
      return { available: stage?.available === true, reason: stage?.reason ?? (stage ? null : '此处理模块未装配。'),
        implementation: stage?.implementation ?? 'not_bound', methods: [] as string[] };
    })();
    if (this.options.enabledModules?.[moduleId] === false)
      return { id: moduleId, title: LABELS[moduleId], action: ACTIONS[moduleId],
        version: PRODUCTION_MODULE_PORTS_VERSION, status: 'blocked' as const,
        reason: '受信宿主已拔除该模块；不影响其他七个模块或历史记录。',
        implementation: result.implementation, methods: [] as string[],
        wfd: { readable: false, source: 'pinned_snapshot_only', mode: 'disabled' as const, reason: '模块已拔除。' },
        input: '已停用，不受理新任务或读取请求。',
        output: '既有数据与任务身份不变。' };
    return { id: moduleId, title: LABELS[moduleId], action: ACTIONS[moduleId],
      version: PRODUCTION_MODULE_PORTS_VERSION, status: result.available ? 'ready' as const : 'blocked' as const,
      reason: result.reason, implementation: result.implementation, methods: result.methods,
      wfd: { readable: wfdReadable, source: 'pinned_snapshot_only',
        mode: moduleId === 'calculate' ? 'fixed_source_inside_registered_formula' : 'read_wfd',
        reason: wfdReadable ? null : wfd?.configuration.reason ?? 'WFD 正式只读连接未装配。' },
      input: moduleId === 'calculate'
        ? '明确方法、参数与 WFD 冻结快照；不得自选引擎或直接提供数值行'
        : moduleId === 'factor_library' ? '只读查询现有因子和公式定义编号，可返回方法状态但不启用执行'
        : moduleId === 'semantic_dictionary' ? '指定 WFD 已冻结快照，查已发布定义、单位、字段和口径'
        : '本会话已冻结计划及实际步骤；也可仅按明确 WFD 快照读取资料，不自动跳过步骤前置依赖',
      output: moduleId === 'calculate' ? '固定公式候选，经方法核验后复用 R1/WFD'
        : moduleId === 'factor_library' ? '已有因子定义及实际方法状态；非采用或数值验证凭证'
        : moduleId === 'semantic_dictionary' ? '实际 WFD 快照中已有的产品声明；没有自动语义裁决'
        : '原计划持久产物与完整来源证明；不自动进入下一个接口' };
  }
  capabilities() {
    return { version: PRODUCTION_MODULE_PORTS_VERSION, owner: 'bd_data_production',
      modules: PRODUCTION_MODULE_IDS.map(id => this.capability(id)),
      execution: 'explicit_on_demand_only', sharedTasks: 'existing_TaskService',
      verification: 'production_verifier_plus_method_specific_proof',
      publication: 'existing_R1_WFD', automaticCrossTrigger: false,
      boundary: 'five-stage-processing, financial-calculation, read-only-factor-library, read-only-WFD-semantic-dictionary' };
  }

  stage(moduleId: ProcessingModuleId, planId: string, stepId: string, operator: OperatorContext): TaskRecord {
    if (!STEPS.includes(moduleId)) return fail('PRODUCTION_MODULE_UNKNOWN', '未登记的五步处理模块。');
    if (this.capability(moduleId).status !== 'ready')
      return fail('PRODUCTION_MODULE_DISABLED', '本处理模块未装配或被受信宿主停用。');
    const service = this.options.processing!;
    const plan = service.get(planId);
    const matched = plan.steps.find(item => item.stepId === stepId);
    if (!matched || matched.kind !== moduleId)
      return fail('PRODUCTION_MODULE_STEP_MISMATCH', '所选任务步骤不属于当前模块；不能跨模块提交或转换其输入。');
    return service.executeStep(planId, stepId, operator);
  }

  calculate(requestId: string, raw: unknown) {
    if (this.capability('calculate').status !== 'ready')
      return fail('PRODUCTION_MODULE_DISABLED', '计算模块未启用，不调用其他引擎兜底。');
    return this.options.calculation!.submit(requestId, raw);
  }
  publishCalculation(taskId: string, signal?: AbortSignal) {
    if (this.capability('calculate').status !== 'ready')
      return fail('PRODUCTION_MODULE_DISABLED', '计算模块未启用；无法为旧任务伪造新发布资格。');
    return this.options.calculation!.publish(taskId, signal);
  }

  /** Frozen existing algorithm definitions only; implementation/adoption is NOT inferred from registry content. */
  factorCatalog(methodId?: string) {
    if (this.capability('factor_library').status !== 'ready')
      return fail('PRODUCTION_MODULE_DISABLED', '受信因子定义库未装配或已拔除。');
    if (methodId !== undefined && (!id(methodId) || methodId.length > 128))
      return fail('PRODUCTION_FACTOR_ID', '因子编号必须为已登记定义的受信标识。');
    const definitions = methodId
      ? ALGORITHM_DEFINITIONS.filter(item => item.registryId === methodId || item.id === methodId)
      : ALGORITHM_DEFINITIONS;
    const calc = this.options.calculation?.capabilities();
    const formula = calc?.methods ?? [];
    const fixed = Object.entries(FIXED_CALCULATION_METHODS)
      .map(([key, definition]) => ({
        id: key === 'observation_ma20' ? 'source_observation_ma' : key,
        fixedMethodId: key, title: definition.title, description: definition.description,
        runtime: formula.find(item => item.methodId === (key === 'observation_ma20' ? 'source_observation_ma' : key)) ?? null,
      }))
      .filter(entry => !methodId || methodId === entry.id || methodId === entry.fixedMethodId);
    const records = definitions.map(item => {
      const registration = ALGORITHM_REGISTRY.find(reg => reg.id === item.registryId);
      const summary = { id: item.id, registryId: item.registryId, title: item.title,
        definitionKind: item.definitionKind, status: item.status,
        registryRecord: registration
          ? { state: registration.state, status: registration.status, missing: registration.missing } : null,
        currentExecution: formula.find(method => method.methodId === item.registryId) ?? null };
      return methodId ? { ...summary, formula: item.formula, semantics: item.semantics,
        warmup: item.warmup, missingPolicy: item.missingPolicy, implementationRefs: item.implementations }
        : summary;
    });
    if (methodId && !records.length && !fixed.length)
      return fail('PRODUCTION_FACTOR_UNKNOWN', '因子定义不存在，未按名字猜测或自动采用未知计算公式。');
    return { version: ALGORITHM_DEFINITION_SUMMARY.version, source: 'existing_algorithm_definitions',
      definitionCount: ALGORITHM_DEFINITIONS.length, definitions: records, fixedMethods: fixed,
      scope: 'read_only', notProofOfAdoption: true };
  }

  /** WFD semantic dictionary: actual product declarations at a pinned snapshot, not local guesses. */
  async semanticLookup(raw: unknown, signal: AbortSignal) {
    if (this.capability('semantic_dictionary').status !== 'ready' || !this.options.wfd)
      return fail('PRODUCTION_MODULE_DISABLED', '语义词典只读端口未装配 WFD 已发布定义。');
    if (!isWfdRecord(raw) || Object.keys(raw).some(key =>
      !['snapshotId', 'productId', 'semanticCode'].includes(key))
      || !id(raw.snapshotId)
      || raw.productId !== undefined && !id(raw.productId)
      || raw.semanticCode !== undefined && !id(raw.semanticCode))
      return fail('PRODUCTION_SEMANTIC_INPUT', '语义词典只能按固定快照查询已发布产品或指标定义，不能用 latest 和自填语义。');
    signal.throwIfAborted();
    const found = await this.options.wfd.discoverProducts({ snapshotId: raw.snapshotId }, signal);
    signal.throwIfAborted();
    const definitions = found.products.filter(value => isWfdRecord(value)
      && (raw.productId === undefined || value.product_id === raw.productId)
      && (raw.semanticCode === undefined ||
          (isWfdRecord(value.declaration) && value.declaration.semantic_code === raw.semanticCode)));
    if (definitions.length > 100)
      return fail('PRODUCTION_SEMANTIC_BUDGET', '语义词典匹配项超过100条；需限定产品或语义代码，不截断为完整目录。');
    return { version: PRODUCTION_MODULE_PORTS_VERSION, authority: 'WFD_published_snapshot',
      snapshotId: raw.snapshotId, count: definitions.length, definitions,
      connection: found.connection, historyMode: 'snapshot_contents',
      state: definitions.length ? 'found' : 'not_found', templatesNotAcceptedAsFacts: true };
  }

  /** Pure WFD source access. A read result is not a clean/check or publish receipt. */
  async readWfd(moduleId: ProductionModuleId, raw: unknown, signal: AbortSignal) {
    const module = this.capability(moduleId);
    if (module.status !== 'ready') return fail('PRODUCTION_MODULE_DISABLED', '本模块当前不可调用 WFD。');
    if (!module.wfd.readable || !this.options.wfd)
      return fail('PRODUCTION_WFD_UNAVAILABLE', 'WFD 固定快照只读来源未装配或不可用。');
    if (!isWfdRecord(raw) || Object.keys(raw).some(k => !['snapshotId', 'productId', 'cursor', 'fields'].includes(k))
      || !id(raw.snapshotId) || !id(raw.productId)
      || raw.cursor !== undefined && (typeof raw.cursor !== 'string' || !raw.cursor || raw.cursor.length > 8192)
      || raw.fields !== undefined && (!Array.isArray(raw.fields) || raw.fields.length > 64
        || raw.fields.some(x => !id(x)) || new Set(raw.fields).size !== raw.fields.length))
      return fail('PRODUCTION_WFD_SELECTION', '只允许固定 WFD 快照和产品的只读引用；不得使用 latest、原始行、路径或任意字段。');
    signal.throwIfAborted();
    const response = await this.options.wfd.readProduct(raw, signal);
    signal.throwIfAborted();
    return { source: 'WFD', moduleId, mode: 'read_only', historyMode: 'snapshot_contents',
      snapshotId: raw.snapshotId, productId: raw.productId, response };
  }
}
