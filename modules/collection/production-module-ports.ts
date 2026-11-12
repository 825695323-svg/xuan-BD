import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { ProcessingPlanService, ProcessingStepKind } from './processing-plan.js';
import type { ProductionCalculation } from './production-calculation.js';
import type { R1ProductRead, R1ProductDiscovery } from '../../contracts/r1-contracts.js';
import { readFileSync } from 'node:fs';
import { ALGORITHM_REGISTRY, ALGORITHM_REGISTRY_VERSION, ALGORITHM_REGISTRY_NOTE,
  registryCounts } from '../financial/algorithm-registry.js';
import { ALGORITHM_DEFINITION_SUMMARY, definitionFor } from '../financial/algorithm-definitions.js';
import { MATERIAL_CLEANING_RULES_VERSION, MATERIAL_SEMANTIC_PROPOSAL_VERSION } from './materials/semantic-contracts.js';

/**
 * 八个平行的业务模块端口。这里仅复用现有清洗/计算服务，不设新任务状态、数据表或发布器。
 * WFD 输入经同一只读受信读取器，结果不自动冒充已核对的五步加工对象。
 */
export const PRODUCTION_MODULE_PORTS_VERSION = 'bd.production-module-ports/2';
export const PRODUCTION_MODULES = [
  { id: 'parse', action: 'data.modules.parse', title: '解析', source: 'declared_material_or_fixed_wfd' },
  { id: 'clean', action: 'data.modules.clean', title: '清洗', source: 'declared_material_or_fixed_wfd' },
  { id: 'structure', action: 'data.modules.structure', title: '结构化', source: 'declared_material_or_fixed_wfd' },
  { id: 'annotate', action: 'data.modules.annotate', title: '标注', source: 'declared_material_or_fixed_wfd' },
  { id: 'check', action: 'data.modules.check', title: '核对', source: 'declared_material_or_fixed_wfd' },
  { id: 'calculate', action: 'data.modules.calculate', title: '计算公式与因子', source: 'fixed_wfd_only' },
  { id: 'factors', action: 'data.modules.factors', title: '因子库', source: 'registered_definitions_and_fixed_wfd' },
  { id: 'semantics', action: 'data.modules.semantics', title: '语义词典', source: 'read_only_semantic_templates_and_fixed_wfd' },
] as const;
export type ProductionModuleId = typeof PRODUCTION_MODULES[number]['id'];
export type ProductionStepModuleId = Exclude<ProductionModuleId, 'calculate' | 'factors' | 'semantics'>;
export type ProductionCatalogModuleId = Extract<ProductionModuleId, 'factors' | 'semantics'>;
export type ProductionWfdModuleId = Exclude<ProductionModuleId, 'calculate'>;

export const stepModuleForAction = (action: string): ProductionStepModuleId | null => {
  const found = PRODUCTION_MODULES.find(value => value.action === action);
  return found && !['calculate', 'factors', 'semantics'].includes(found.id)
    ? found.id as ProductionStepModuleId : null;
};

export function productionModuleDirectory(services: {
  processing?: Pick<ProcessingPlanService, 'moduleCapability'>;
  calculation?: Pick<ProductionCalculation, 'capabilities'>;
  hasWfdReader: boolean;
  enabled?: Partial<Record<ProductionModuleId, boolean>>;
}) {
  const modules = PRODUCTION_MODULES.map(({ id, action, title, source }) => {
    const attached = services.enabled?.[id] !== false;
    if (id === 'factors' || id === 'semantics') {
      const available = id === 'factors' || semanticTemplatesAvailable();
      return { id, action, title, source,
        status: !attached ? 'unplugged' as const : available ? 'ready' as const : 'blocked' as const,
        engine: 'read_only_catalog', methods: [] as unknown[], execution: 'on_demand',
        history: 'registered_definitions_are_not_adoption_or_historical_qualification',
        wfdRead: services.hasWfdReader,
        dependencies: [] as string[], readOnly: true,
        sourceVersion: id === 'factors' ? ALGORITHM_REGISTRY_VERSION : SEMANTIC_TEMPLATES_VERSION };
    }
    if (id === 'calculate') {
      const capability = services.calculation?.capabilities();
      return { id, action, title, source, status: !attached ? 'unplugged'
          : capability?.methods.some(method => method.status === 'ready') ? 'ready' : 'blocked',
        engine: 'polars_or_opt_in_pandas', methods: capability?.methods ?? [],
        execution: 'on_demand', history: 'wfd_fixed_snapshot_only',
        wfdRead: services.hasWfdReader, dependencies: [] as string[] };
    }
    const capability = services.processing?.moduleCapability(id);
    return { id, action, title, source,
      status: !attached ? 'unplugged' : capability?.status ?? 'unplugged',
      engine: capability?.engine ?? 'unavailable',
      methods: [] as unknown[], execution: 'on_demand',
      history: 'original_plan_immutable_or_read_only_wfd_page',
      wfdRead: services.hasWfdReader,
      dependencies: id === 'parse' ? [] : id === 'clean' ? ['parse']
        : id === 'structure' ? ['clean'] : id === 'annotate' ? ['structure'] : ['annotate'] };
  });
  return { version: PRODUCTION_MODULE_PORTS_VERSION, owner: 'bd_service', mode: 'eight_parallel_ports',
    modules, sharedWfdReader: 'R1Workspace.readProduct (bounded, fixed snapshot, single page)',
    sharedVerifier: 'production-verifier + method-specific proof',
    sharedPublication: 'existing R1/WFD only', autoTrigger: false,
    note: '八端口彼此并列：五步加工、公式计算、只读因子库、只读语义词典。词典模板不等于 WFD 已采用定义；旧清洗计划依赖与原 WFD 发布证据不因拔插改变。' };
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
export async function readWfdModulePage(module: ProductionWfdModuleId, raw: unknown,
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


/**
 * Semantic dictionary's authoritative view: published product declarations inside an
 * explicitly pinned WFD snapshot. Templates (semanticDictionaryView) stay separately
 * marked as unadopted reference material and never replace this fixed read.
 */
export async function readPublishedWfdSemanticDefinition(raw: unknown,
  discover: (input: { snapshotId: string }, signal?: AbortSignal) => Promise<R1ProductDiscovery>,
  signal: AbortSignal) {
  const selection = fixedWfdModuleReference(raw);
  signal.throwIfAborted();
  const reply = await discover({ snapshotId: selection.snapshotId }, signal);
  signal.throwIfAborted();
  if (reply.snapshotId !== selection.snapshotId || reply.historyMode !== 'snapshot_contents'
    || !isWfdRecord(reply.connection) || !Array.isArray(reply.products)) {
    return fail('PRODUCTION_SEMANTIC_WFD_CHANGED',
      '语义词典返回了不同快照、历史视角或不可核对的正式产品目录。');
  }
  const found = reply.products.filter(item => isWfdRecord(item) && item.product_id === selection.productId);
  if (found.length !== 1 || !isWfdRecord(found[0]!.declaration)
    || !isWfdRecord(found[0]!.subject) || !identifier(found[0]!.dataset_id)) {
    return fail('PRODUCTION_SEMANTIC_WFD_NOT_FOUND',
      '该 WFD 固定快照不存在唯一且完整的产品声明；未使用本地语义模板填补。');
  }
  const entry = found[0]!, declaration = entry.declaration as WfdRecord;
  if (!identifier(declaration.semantic_code) || !identifier(declaration.unit_code)
    || typeof declaration.measurement_nature !== 'string') {
    return fail('PRODUCTION_SEMANTIC_WFD_INVALID',
      '已发布产品的语义编号、单位或测量属性不完整；不伪造词典定义。');
  }
  return { version: PRODUCTION_MODULE_PORTS_VERSION,
    kind: 'wfd_published_semantic_definition', authority: 'actual_fixed_snapshot',
    snapshotId: selection.snapshotId, productId: selection.productId,
    datasetId: entry.dataset_id, subject: entry.subject, declaration,
    declarationSha256: wfdSha256(canonicalWfdJson(declaration)),
    source: { historyMode: 'snapshot_contents', connectionSha256: wfdSha256(canonicalWfdJson(reply.connection)) },
    execution: 'not_requested', publication: 'not_requested',
    note: '正式定义只按原 WFD Snapshot 读取；仅查询，不采用/修订口径，也不触发自动标注或计算。' };
}

/** 因子库直接读取当前已有登记/公式谱系；登记不能直接赋予计算或 WFD 发布资格。 */
export function factorLibraryView(factorId?: string) {
  if (factorId !== undefined && (!identifier(factorId) || factorId.length > 128))
    return fail('PRODUCTION_FACTOR_ID', '因子编号格式无效；不能作为动态程序、脚本或表达式。');
  const entries = factorId ? ALGORITHM_REGISTRY.filter(item => item.id === factorId)
    : ALGORITHM_REGISTRY.slice(0, 50);
  if (factorId && !entries.length) return fail('PRODUCTION_FACTOR_NOT_FOUND', '受信登记中没有该因子编号。');
  return { version: ALGORITHM_REGISTRY_VERSION, kind: 'read_only_factor_library',
    designOnly: true, note: ALGORITHM_REGISTRY_NOTE,
    definitions: ALGORITHM_DEFINITION_SUMMARY, counts: registryCounts(),
    total: ALGORITHM_REGISTRY.length, selected: entries.length,
    items: entries.map(item => ({
      ...item, definition: definitionFor(item.id) ?? null,
      publication: 'not_granted_by_library',
      execution: 'only_registered_calculation_module_can_execute',
    })) };
}

/** WFD 语义模板并非权威已采用产品词典；按需公开真实模板和当前材料语义合同。 */
export const SEMANTIC_TEMPLATES_VERSION = 'wfd.semantic-templates/1.0';
const semanticTemplatePath = new URL('../../wfd/product/protocol/templates/wfd-semantic-templates.json', import.meta.url);
function loadSemanticTemplates(): WfdRecord | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(semanticTemplatePath, 'utf8'));
    if (!isWfdRecord(raw) || raw.format_version !== SEMANTIC_TEMPLATES_VERSION
      || raw.status !== 'templates_only_not_products'
      || !Array.isArray(raw.business_groups) || !Array.isArray(raw.common_axes)) return null;
    return raw;
  } catch { return null; }
}
export const semanticTemplatesAvailable = () => loadSemanticTemplates() !== null;

export function semanticDictionaryView(groupId?: string) {
  const document = loadSemanticTemplates();
  if (!document) return fail('PRODUCTION_SEMANTIC_TEMPLATES_UNAVAILABLE',
    '本机构建没有完整受信语义模板；不能伪造已经采用的 WFD 词典。');
  if (groupId !== undefined && (!identifier(groupId) || groupId.length > 128))
    return fail('PRODUCTION_SEMANTIC_GROUP', '语义词典分组编号无效。');
  const groups = (document.business_groups as WfdRecord[])
    .filter(value => isWfdRecord(value));
  const selected = groupId ? groups.filter(item => item.group_id === groupId) : groups;
  if (groupId && !selected.length)
    return fail('PRODUCTION_SEMANTIC_GROUP', '没有该语义模板分组，不能补造未知概念。');
  return { version: SEMANTIC_TEMPLATES_VERSION, kind: 'read_only_semantic_dictionary',
    status: 'templates_only_not_products', authority: 'no_adoption_or_decision_granted',
    commonAxes: document.common_axes, businessGroups: selected,
    financeSubdomains: groupId ? [] : document.finance_subdomains,
    materialProposalVersion: MATERIAL_SEMANTIC_PROPOSAL_VERSION,
    cleaningRulesVersion: MATERIAL_CLEANING_RULES_VERSION,
    wfdActiveDefinitions: 'select a real frozen WFD product or catalog source; templates do not imply activation',
    noAutomaticAnnotation: true };
}
