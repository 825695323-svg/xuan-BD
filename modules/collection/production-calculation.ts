import { TaskError } from '../../platform/jobs/tasks.js';
import { isWfdRecord } from '../../adapters/database/wfd-transport.js';
import { FIXED_CALCULATION_METHODS } from '../../contracts/fixed-calculation-contracts.js';
import { ALGORITHM_METHOD_IDS } from '../financial/algorithm-types.js';
import type { AlgorithmConversationPort } from '../../contracts/workspace-services.js';
import type { UnifiedPolarsExecution } from '../financial/unified-polars-execution.js';
import type { DerivedWfdPublisher } from '../financial/derived-wfd-publisher.js';

/**
 * 数据生产内部唯一计算模块：引擎只负责执行，方法定义决定执行器。
 * 不持有数据库、任务运行时、授权或 WFD 发布账本；全都沿用原宿主和 R1。
 */
export const PRODUCTION_CALCULATION_VERSION = 'bd.production-calculation/1';
export type ProductionEngineId = 'polars' | 'pandas';
interface EnginePort {
  capabilities(): { status: 'ready' | 'blocked'; reason: string | null;
    methods: readonly string[]; version: string };
  submit(requestId: string, raw: unknown): { taskId: string };
}
export interface ProductionFormula {
  methodId: string;
  engine: ProductionEngineId;
  description: string;
}
const FIXED_FORMULAS: readonly ProductionFormula[] = Object.freeze([
  { methodId: 'financial_linear', engine: 'polars', description: '固定财务单季与近十二个月' },
  { methodId: 'macro_yoy', engine: 'polars', description: '宏观同比' },
  { methodId: 'source_observation_ma', engine: 'polars', description: '来源观测均线；统一 WFD 固定输入与多行派生发布待验收' },
]);
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };

export class ProductionCalculation {
  constructor(private readonly options: {
    polars?: Pick<UnifiedPolarsExecution, 'capabilities' | 'submit' | 'view' | 'owns'>;
    /** 仅由受信宿主登记，缺省不安装也不自动选择 pandas。 */
    pandas?: EnginePort;
    pandasFormulas?: readonly ProductionFormula[];
    /** 历史既有 Python 公式沿原任务服务，不能伪称其执行引擎是 pandas。 */
    legacy?: Pick<AlgorithmConversationPort, 'submit' | 'view'>;
    publisher?: Pick<DerivedWfdPublisher, 'publish'>;
  }) {}
  capabilities() {
    const polars = this.options.polars?.capabilities() ?? {
      status: 'blocked' as const, reason: '统一 Polars 执行器未装配。', methods: [] as readonly string[], version: 'not_adopted',
    };
    const pandas = this.options.pandas?.capabilities() ?? {
      status: 'blocked' as const, reason: 'pandas 按需接入，尚无经过独立验收的受信方法。', methods: [] as readonly string[], version: 'not_adopted',
    };
    const formulas = [...FIXED_FORMULAS, ...(this.options.pandasFormulas ?? [])];
    const seen = new Set<string>();
    const methods = formulas.map(formula => {
      if (seen.has(formula.methodId) || !formula.methodId
        || !['polars','pandas'].includes(formula.engine)
        || formula.engine === 'polars' && !Object.hasOwn(FIXED_CALCULATION_METHODS, formula.methodId)
        || formula.engine === 'pandas' && !(this.options.pandasFormulas ?? []).some(x => x.methodId === formula.methodId)) {
        return fail('PRODUCTION_FORMULA_REGISTRY', '受信计算公式注册存在重名或不属于允许的计算引擎。');
      }
      seen.add(formula.methodId);
      const backend = formula.engine === 'polars' ? polars : pandas;
      const ready = backend.status === 'ready' && backend.methods.includes(formula.methodId);
      return { ...formula, status: ready ? 'ready' as const : 'blocked' as const,
        reason: ready ? null : backend.methods.includes(formula.methodId)
          ? backend.reason ?? '计算引擎尚不可用。'
          : '方法尚未迁入受信执行器与生产统一核对，禁止开启新计算。',
        implementationVersion: ready ? backend.version : 'not_adopted' };
    });
    return { version: PRODUCTION_CALCULATION_VERSION, owner: 'data_production',
      action: 'algorithms.calculate', publication: 'existing_r1_wfd_readback',
      engines: [
        { id: 'polars' as const, status: polars.status, reason: polars.reason, version: polars.version,
          role: 'default_strict_columns_and_fixed_calculations' },
        { id: 'pandas' as const, status: pandas.status, reason: pandas.reason, version: pandas.version,
          role: 'opt_in_registered_third_party_methods_only' },
      ],
      methods,
      compatibility: { oldPythonMethods: [...ALGORITHM_METHOD_IDS],
        note: '原 Python 方法保留既有任务身份；未迁移前不得称为 pandas 或新 Polars 方法。' } };
  }
  /** 只有已登记公式才能执行，调用方不能覆盖引擎、输入值、程序路径或 WFD 连接。 */
  submit(requestId: string, raw: unknown): { taskId: string } {
    if (!isWfdRecord(raw) || typeof raw.methodId !== 'string' || Object.hasOwn(raw, 'engine'))
      return fail('PRODUCTION_CALCULATION_INPUT', '需要明确登记的算法编号；引擎只能由受信公式定义选择。');
    const methodId = raw.methodId;
    const method = this.capabilities().methods.find(entry => entry.methodId === methodId);
    if (method) {
      if (method.status !== 'ready')
        return fail('PRODUCTION_CALCULATION_NOT_READY', method.reason ?? '固定算法尚未迁入生产计算引擎。');
      const executor = method.engine === 'polars' ? this.options.polars : this.options.pandas;
      if (!executor) return fail('PRODUCTION_CALCULATION_NOT_READY', '公式执行器未装配。');
      return executor.submit(requestId, raw);
    }
    // 历史 Python 方法仅作原兼容执行适配，不建立第三套方法发现与发布管线。
    if ((ALGORITHM_METHOD_IDS as readonly string[]).includes(methodId)) {
      if (!this.options.legacy) return fail('PRODUCTION_CALCULATION_NOT_READY', '历史方法执行器未装配。');
      return this.options.legacy.submit(requestId, raw);
    }
    return fail('PRODUCTION_CALCULATION_METHOD', '未知计算公式；不可按调用方自行指定引擎执行。');
  }
  async publish(taskId: string, signal?: AbortSignal) {
    if (!this.options.publisher) return fail('PRODUCTION_PUBLISHER_UNAVAILABLE', '原 R1 正式发布服务未装配。');
    return this.options.publisher.publish(taskId, signal);
  }
}
