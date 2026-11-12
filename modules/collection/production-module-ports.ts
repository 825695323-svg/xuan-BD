import { TaskError, type TaskRecord } from '../../platform/jobs/tasks.js';
import { isWfdRecord } from '../../adapters/database/wfd-transport.js';
import type { OperatorContext, ProcessingPlanService, ProcessingStepKind } from './processing-plan.js';
import type { ProductionCalculation } from './production-calculation.js';
import type { R1WorkspaceService } from './r1-workspace.js';

export const PRODUCTION_MODULE_PORTS_VERSION = 'bd.production-module-ports/1';
export const PRODUCTION_MODULE_IDS = ['parse', 'clean', 'structure', 'annotate', 'check', 'calculate'] as const;
export type ProductionModuleId = typeof PRODUCTION_MODULE_IDS[number];
type ProcessingModuleId = ProcessingStepKind;
const STEPS: readonly ProcessingModuleId[] = ['parse', 'clean', 'structure', 'annotate', 'check'];
const ACTIONS: Record<ProductionModuleId, string> = {
  parse: 'data.module.parse', clean: 'data.module.clean', structure: 'data.module.structure',
  annotate: 'data.module.annotate', check: 'data.module.check', calculate: 'algorithms.calculate',
};
const LABELS: Record<ProductionModuleId, string> = {
  parse: '解析原件', clean: '显式数据清洗', structure: '严格类型结构化',
  annotate: '受控常量标注', check: '结构与语义核对', calculate: '金融公式与因子计算',
};
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const id = (value: unknown) => typeof value === 'string'
  && /^[A-Za-z0-9_.:/-]{1,160}$/u.test(value) && !/^(latest|current)$/iu.test(value);

/**
 * Six equal, removable business ports. The ports do not create task schedulers,
 * copy WFD data, publish records, or execute another module implicitly.
 *
 * Five stage ports delegate to the original durable processing task; calculation
 * delegates to the existing trusted Polars/pandas method registry. The common
 * read_product dependency is a bounded, snapshot-pinned WFD read-only adapter.
 */
export class ProductionModulePorts {
  constructor(private readonly options: {
    processing?: Pick<ProcessingPlanService, 'get' | 'executeStep' | 'moduleStatus'>;
    calculation?: Pick<ProductionCalculation, 'capabilities' | 'submit' | 'publish'>;
    wfd?: Pick<R1WorkspaceService, 'capabilities' | 'readProduct'>;
    calculationEnabled?: boolean;
  }) {}

  capability(moduleId: ProductionModuleId) {
    if (!PRODUCTION_MODULE_IDS.includes(moduleId)) return fail('PRODUCTION_MODULE_UNKNOWN', '模块编号不属于六个固定端口。');
    const wfd = this.options.wfd?.capabilities();
    const wfdReadable = !!wfd?.connection && wfd.configuration.state === 'ready';
    const result = moduleId === 'calculate' ? (() => {
      const calc = this.options.calculation?.capabilities();
      if (this.options.calculationEnabled === false)
        return { available: false, reason: '受信宿主已拔除计算模块；历史计算任务仍保留。',
          implementation: 'not_bound', methods: [] as string[] };
      const methods = calc?.methods.filter(method => method.status === 'ready').map(method => method.methodId) ?? [];
      return { available: methods.length > 0, reason: methods.length ? null : '未装配可运行的受信计算方法或固定 WFD 来源。',
        implementation: calc?.version ?? 'not_bound', methods };
    })() : (() => {
      const stage = this.options.processing?.moduleStatus(moduleId as ProcessingModuleId);
      return { available: stage?.available === true, reason: stage?.reason ?? (stage ? null : '此处理模块未装配。'),
        implementation: stage?.implementation ?? 'not_bound', methods: [] as string[] };
    })();
    return { id: moduleId, title: LABELS[moduleId], action: ACTIONS[moduleId],
      version: PRODUCTION_MODULE_PORTS_VERSION, status: result.available ? 'ready' as const : 'blocked' as const,
      reason: result.reason, implementation: result.implementation, methods: result.methods,
      wfd: { readable: wfdReadable, source: 'pinned_snapshot_only',
        mode: moduleId === 'calculate' ? 'fixed_source_inside_registered_formula' : 'read_wfd',
        reason: wfdReadable ? null : wfd?.configuration.reason ?? 'WFD 正式只读连接未装配。' },
      input: moduleId === 'calculate'
        ? '明确方法、参数与 WFD 冻结快照；不得自选引擎或直接提供数值行'
        : '本会话已冻结计划及实际步骤；也可仅按明确 WFD 快照读取资料，不自动跳过步骤前置依赖',
      output: moduleId === 'calculate' ? '固定公式候选，经方法核验后复用 R1/WFD'
        : '原计划持久产物与完整来源证明；不自动进入下一个接口' };
  }
  capabilities() {
    return { version: PRODUCTION_MODULE_PORTS_VERSION, owner: 'bd_data_production',
      modules: PRODUCTION_MODULE_IDS.map(id => this.capability(id)),
      execution: 'explicit_on_demand_only', sharedTasks: 'existing_TaskService',
      verification: 'production_verifier_plus_method_specific_proof',
      publication: 'existing_R1_WFD', automaticCrossTrigger: false };
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
