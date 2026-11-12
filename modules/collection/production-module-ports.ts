import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { ProcessingPlanService, ProcessingStepKind } from './processing-plan.js';
import type { ProductionCalculation } from './production-calculation.js';
import type { R1ProductRead } from '../../contracts/r1-contracts.js';

/**
 * 六个平行的业务模块端口。这里仅复用现有清洗/计算服务，不设新任务状态、数据表或发布器。
 * WFD 输入经同一只读受信读取器，结果不自动冒充已核对的五步加工对象。
 */
export const PRODUCTION_MODULE_PORTS_VERSION = 'bd.production-module-ports/1';
export const PRODUCTION_MODULES = [
  { id: 'parse', action: 'data.modules.parse', title: '解析', source: 'declared_material_or_fixed_wfd' },
  { id: 'clean', action: 'data.modules.clean', title: '清洗', source: 'declared_material_or_fixed_wfd' },
  { id: 'structure', action: 'data.modules.structure', title: '结构化', source: 'declared_material_or_fixed_wfd' },
  { id: 'annotate', action: 'data.modules.annotate', title: '标注', source: 'declared_material_or_fixed_wfd' },
  { id: 'check', action: 'data.modules.check', title: '核对', source: 'declared_material_or_fixed_wfd' },
  { id: 'calculate', action: 'data.modules.calculate', title: '计算公式与因子', source: 'fixed_wfd_only' },
] as const;
export type ProductionModuleId = typeof PRODUCTION_MODULES[number]['id'];
export type ProductionStepModuleId = Exclude<ProductionModuleId, 'calculate'>;

export const stepModuleForAction = (action: string): ProductionStepModuleId | null => {
  const found = PRODUCTION_MODULES.find(value => value.action === action);
  return found && found.id !== 'calculate' ? found.id : null;
};

export function productionModuleDirectory(services: {
  processing?: Pick<ProcessingPlanService, 'moduleCapability'>;
  calculation?: Pick<ProductionCalculation, 'capabilities'>;
  hasWfdReader: boolean;
}) {
  const modules = PRODUCTION_MODULES.map(({ id, action, title, source }) => {
    if (id === 'calculate') {
      const capability = services.calculation?.capabilities();
      return { id, action, title, source, status: capability ? 'installed' : 'unplugged',
        engine: 'polars_or_opt_in_pandas', methods: capability?.methods ?? [],
        execution: 'on_demand', history: 'wfd_fixed_snapshot_only',
        wfdRead: services.hasWfdReader, dependencies: [] as string[] };
    }
    const capability = services.processing?.moduleCapability(id);
    return { id, action, title, source,
      status: capability?.status ?? 'unplugged',
      engine: capability?.engine ?? 'unavailable',
      methods: [] as unknown[], execution: 'on_demand',
      history: 'original_plan_immutable_or_read_only_wfd_page',
      wfdRead: services.hasWfdReader,
      dependencies: id === 'parse' ? [] : id === 'clean' ? ['parse']
        : id === 'structure' ? ['clean'] : id === 'annotate' ? ['structure'] : ['annotate'] };
  });
  return { version: PRODUCTION_MODULE_PORTS_VERSION, owner: 'bd_service', mode: 'six_parallel_ports',
    modules, sharedWfdReader: 'R1Workspace.readProduct (bounded, fixed snapshot, single page)',
    sharedVerifier: 'production-verifier + method-specific proof',
    sharedPublication: 'existing R1/WFD only', autoTrigger: false,
    note: '端口彼此并列；旧清洗计划的阶段依赖不会被端口独立性绕过。WFD 只读输入不自动成为已核验的清洗产物。' };
}

const fixed = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)
  && !/^(latest|current)$/iu.test(value);
const identifier = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };

export function fixedWfdModuleReference(raw: unknown) {
  if (!isWfdRecord(raw) || Object.keys(raw).some(key => !['snapshotId', 'productId', 'fields', 'cursor'].includes(key))
    || !fixed(raw.snapshotId) || !identifier(raw.productId)
    || (raw.fields !== undefined && (!Array.isArray(raw.fields) || !raw.fields.length || raw.fields.length > 64
      || raw.fields.some(value => !identifier(value)) || new Set(raw.fields).size !== raw.fields.length))
    || (raw.cursor !== undefined && (typeof raw.cursor !== 'string' || !raw.cursor
      || raw.cursor.length > 8192 || /[\u0000-\u001f]/u.test(raw.cursor)))) {
    return fail('PRODUCTION_MODULE_WFD_REFERENCE', '仅接受固定 WFD 快照、实际产品、最多64个已登记字段和原分页游标。');
  }
  return { snapshotId: raw.snapshotId as string, productId: raw.productId as string,
    ...(raw.fields ? { fields: raw.fields as string[] } : {}),
    ...(raw.cursor ? { cursor: raw.cursor as string } : {}) };
}

/** 各模块共用一份真实 WFD 读取端口；仅返回已核验的当页事实，不建立第二个来源仓库。 */
export async function readWfdModulePage(module: ProductionStepModuleId, raw: unknown,
  reader: (input: unknown, signal?: AbortSignal) => Promise<R1ProductRead>, signal: AbortSignal) {
  const ref = fixedWfdModuleReference(raw);
  signal.throwIfAborted();
  const value = await reader(ref, signal);
  signal.throwIfAborted();
  if (value.snapshotId !== ref.snapshotId || value.productId !== ref.productId
    || value.historyMode !== 'snapshot_contents' || !Array.isArray(value.result.rows)
    || value.result.rows.length > 100 || !isWfdRecord(value.connection)
    || value.result.snapshot_id !== ref.snapshotId || value.result.product_id !== ref.productId) {
    return fail('PRODUCTION_MODULE_WFD_CHANGED', '受信 WFD 读取返回了其他快照、连接或超预算数据。');
  }
  const rawPage = value.result;
  const rows = value.result.rows;
  return { version: PRODUCTION_MODULE_PORTS_VERSION, module, mode: 'wfd_read_only',
    source: { kind: 'wfd_fixed_snapshot', snapshotId: ref.snapshotId, productId: ref.productId,
      historyMode: 'snapshot_contents', historicalQualification: 'not_asserted',
      connectionSha256: wfdSha256(canonicalWfdJson(value.connection)),
      resultSha256: wfdSha256(canonicalWfdJson(rawPage)) },
    page: rawPage.page, rows, rowCount: rows.length,
    next: isWfdRecord(rawPage.page) ? rawPage.page.next_cursor ?? null : null,
    execution: 'not_requested', publication: 'not_requested',
    note: '这是只读的正式 WFD 数据页，不授权跳过既有原报计划的解析/清洗/核对，不自动入库。' };
}
