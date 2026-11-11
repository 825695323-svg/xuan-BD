import { isWfdRecord } from '../../adapters/database/wfd-transport.js';
import { FIXED_CALCULATION_METHODS, FIXED_CALCULATION_VERSION, type FixedCalculationCapabilities,
  type FixedCalculationInputs, type FixedCalculationMethodId, type FixedCalculationRecordPage,
  type FixedCalculationTaskView } from '../../contracts/fixed-calculation-contracts.js';
import { TaskError, type TaskService } from '../../platform/jobs/tasks.js';
import type { PolarsFixedService } from './polars-fixed-service.js';
import type { R1AutoService } from './r1-auto.js';
import type { R1WorkspaceService } from './r1-workspace.js';
import type { ProcessingPlanService } from './processing-plan.js';
import type { MaterialService } from './materials/service.js';
import { readSourceProjection } from './source-reported-table.js';

const financialFields = ['subject_scheme', 'subject_code', 'accounting_standard', 'currency', 'scope', 'unit',
  'concept', 'dimension', 'period_type', 'start_date', 'end_date', 'report_version', 'value'];
const macroFields = ['series_code', 'region', 'unit', 'seasonal_adjustment', 'base_period', 'period_start',
  'period_end', 'published_at', 'release_id', 'value'];
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };

/** 固定路由薄层；沿用原任务、冻结输入和候选保管，不建第二份计算或发布账本。 */
export class FixedCalculationService {
  constructor(private readonly options: { polars: PolarsFixedService; tasks(): TaskService;
    workspace: R1WorkspaceService; auto: R1AutoService; processing: ProcessingPlanService; materials: MaterialService;
    /** 本机开关；缺省为启用。关闭只影响本入口，不改任何已存任务或结果。 */
    enabled?: boolean }) {}
  private get enabled(): boolean { return this.options.enabled !== false; }
  capabilities(): FixedCalculationCapabilities {
    const execution = this.options.polars.capabilities();
    // 旧 Polars 路线保留历史目录与查询；新计算由 AGENTS algorithms.calculate 唯一受理。
    const configured = false;
    return { version: FIXED_CALCULATION_VERSION, configured,
      methods: (Object.keys(FIXED_CALCULATION_METHODS) as FixedCalculationMethodId[])
        .map(id => ({ id, ...FIXED_CALCULATION_METHODS[id] })),
      routing: 'fixed_by_method', query: { engine: 'duckdb', role: 'query_only', registeredCalculationMethods: 0 },
      existingWorkflows: { method: 'source_observation_ma', scope: 'existing_daily_minute_batch',
        implementation: 'existing_exact_decimal', period: 'saved_batch_settings' },
      publication: 'candidate_only', limits: execution.limits,
      reason: '原固定计算只读保留历史任务；新计算统一使用 BD AGENTS algorithms.calculate。'
        + (!this.enabled ? ' 本机旧入口已停用。' : '')
        + (execution.dependency.error ? ' 原依赖状态：' + execution.dependency.error : '') };
  }
  async inputs(): Promise<FixedCalculationInputs> {
    const sources: FixedCalculationInputs['sources'] = [], gaps: string[] = [];
    for (const source of this.options.auto.list().filter(item => item.state === 'associated' && item.currentRequest)) {
      try {
        const request = source.currentRequest!;
        const plan = this.options.processing.get(request.planId);
        const projection = readSourceProjection(plan.steps.find(step => step.kind === 'parse')?.parameters.sourceProjection);
        if (projection.minute) continue;
        const associations = request.local.associations;
        const association = Array.isArray(associations) && isWfdRecord(associations[0]) ? associations[0] : null;
        if (typeof association?.product_id !== 'string' || typeof association.snapshot_id !== 'string') continue;
        const declaration = plan.outputs.find(output => output.outputId === request.outputId)?.target?.declaration;
        const target = isWfdRecord(declaration) && isWfdRecord(declaration.target) ? declaration.target : null;
        const definition = target && isWfdRecord(target.definition) ? target.definition : null;
        const fields = definition && Array.isArray(definition.field_definitions) ? definition.field_definitions.filter(isWfdRecord) : [];
        const numeric = new Set(fields.filter(field => field.data_type === 'decimal').map(field => field.field_code));
        const valueColumns = projection.fields.filter(field => numeric.has(field.fieldCode) && !projection.keyColumns.includes(field.column)).map(field => field.column);
        if (!valueColumns.length) continue;
        sources.push({ autoRequestId: source.requestId, materialId: source.materialId,
          filename: this.options.materials.get(source.materialId).envelope.filename, rowCount: request.rowCount,
          productId: association.product_id, snapshotId: association.snapshot_id, valueColumns });
      } catch (error) {
        // Other associated source formats are valid inputs for their own workflows, but are not daily observations.
        if (!(error instanceof TaskError && error.code === 'SOURCE_REPORTED_PROJECTION')) {
          gaps.push(`原报 ${source.requestId} 的固定输入无法发现：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const status = await this.options.workspace.snapshotStatus();
    const products: FixedCalculationInputs['products'] = [];
    if (status.snapshotId) {
      const discovery = await this.options.workspace.discoverProducts({ snapshotId: status.snapshotId });
      for (const selection of discovery.selections.filter(item => item.readable)) {
        const methods: Array<'financial_linear' | 'macro_yoy'> = [];
        if (financialFields.every(field => selection.fields.includes(field))) methods.push('financial_linear');
        if (macroFields.every(field => selection.fields.includes(field))) methods.push('macro_yoy');
        if (!methods.length) continue;
        const product = discovery.products.find(item => item.product_id === selection.productId);
        const declaration = product && isWfdRecord(product.declaration) ? product.declaration : {};
        products.push({ productId: selection.productId, datasetId: selection.datasetId, subject: selection.subject,
          semanticCode: typeof declaration.semantic_code === 'string' ? declaration.semantic_code : selection.productId, methods });
      }
    }
    return { snapshotId: status.snapshotId, sources, products, sourceLimit: 20, gaps };
  }
  async records(value: unknown): Promise<FixedCalculationRecordPage> {
    if (!isWfdRecord(value) || Object.keys(value).some(key => !['snapshotId', 'productId', 'cursor'].includes(key))) {
      return fail('FIXED_CALCULATION_INPUT', '请选择已发现的固定快照和产品，不接受客户端数值或字段覆盖。');
    }
    const read = await this.options.workspace.readProduct(value);
    if (!Array.isArray(read.result.rows) || !isWfdRecord(read.result.page)) return fail('FIXED_CALCULATION_READ', '固定读取没有完整记录及分页声明。');
    const rows = read.result.rows.map(row => {
      if (!isWfdRecord(row) || !isWfdRecord(row.record_ref) || !isWfdRecord(row.values)
        || typeof row.record_ref.logical_key !== 'string' || typeof row.record_ref.revision_id !== 'string') {
        return fail('FIXED_CALCULATION_READ', '固定行缺业务键、记录版本或原字段。');
      }
      return { businessKey: row.record_ref.logical_key, recordVersion: row.record_ref.revision_id, values: row.values };
    });
    const page = read.result.page;
    if (typeof page.has_more !== 'boolean' || page.has_more && (typeof page.next_cursor !== 'string' || !page.next_cursor)) {
      return fail('FIXED_CALCULATION_READ', '固定记录的下一页身份无法核对。');
    }
    return { snapshotId: read.snapshotId, productId: read.productId, rows,
      page: { hasMore: page.has_more, nextCursor: page.has_more ? String(page.next_cursor) : null } };
  }
  async create(_value: unknown): Promise<FixedCalculationTaskView> {
    // 不使用旧 Polars 独立的受理/候选/五步加工发布路线创建新任务。
    // 保留 list/get/records 和旧任务的原回执，不虚构自动迁移已冻结任务。
    return fail('ALGORITHM_UNIFIED_ENTRY_ONLY',
      '新计算仅可通过 BD AGENTS algorithms.calculate 创建。旧 Polars 任务保留只读及原身份。');
  }

  list(): FixedCalculationTaskView[] {
    return this.options.polars.listTaskIds().map(taskId => this.get(taskId));
  }
  get(taskId: string): FixedCalculationTaskView {
    const { task, candidate } = this.options.polars.get(taskId);
    const args = isWfdRecord(task.args) ? task.args : {};
    const input = isWfdRecord(args.input) ? args.input : {};
    if (typeof input.method !== 'string' || !Object.hasOwn(FIXED_CALCULATION_METHODS, input.method)) {
      return fail('FIXED_CALCULATION_METHOD', '原任务没有已登记的固定方法。');
    }
    const data = task.status === 'succeeded' && isWfdRecord(task.result?.data) ? task.result.data : null;
    return { version: FIXED_CALCULATION_VERSION, methodId: input.method as FixedCalculationMethodId, implementation: 'polars',
      task: { id: task.id, requestId: String(input.requestId), status: task.status, version: task.version,
        updatedAt: task.updatedAt, requiresReview: task.requiresReview, error: task.error },
      result: data ? { rowCount: (data.rows as unknown[]).length, sha256: String(data.candidateSha256),
        rows: data.rows as Record<string, unknown>[], algorithmDefinition: data.algorithmDefinition as Record<string, unknown> } : null,
      candidate: candidate ? { custodyTaskId: candidate.custodyTaskId, materialId: candidate.materialId } : null };
  }
  async stage(taskId: string): Promise<FixedCalculationTaskView> { await this.options.polars.stage(taskId); return this.get(taskId); }
  prepare(taskId: string, value: unknown) { return this.options.polars.prepare(taskId, value); }
}
