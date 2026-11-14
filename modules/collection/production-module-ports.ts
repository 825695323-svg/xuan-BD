import { TaskError } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, isWfdRecord, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { AlgorithmConversationPort } from '../../contracts/workspace-services.js';
import type { ProcessingPlanService, ProcessingStepKind } from './processing-plan.js';
import type { R1ProductRead, R1ProductDiscovery } from '../../contracts/r1-contracts.js';
import { readFileSync } from 'node:fs';
import { ALGORITHM_REGISTRY, ALGORITHM_REGISTRY_VERSION, ALGORITHM_REGISTRY_NOTE,
  registryCounts } from '../financial/algorithm-registry.js';
import { ALGORITHM_DEFINITION_SUMMARY, definitionFor } from '../financial/algorithm-definitions.js';
import { MATERIAL_CLEANING_RULES_VERSION, MATERIAL_SEMANTIC_PROPOSAL_VERSION } from './materials/semantic-contracts.js';
import { compareProfileSemantics, profileFingerprint, profileSemanticGaps, sourceFieldProfileDigest,
  type SourceFieldProfile, type SourceFieldProfileStore, type SemanticProductRegistryStore,
  type SourceProfileAdapterBinding } from './source-field-profile.js';

/** 八个平行模块复用现有服务；读取、处理、语义核对和正式发布各守自己的边界。 */
export const PRODUCTION_MODULE_PORTS_VERSION = 'bd.production-module-ports/2';
export const PRODUCTION_MODULES = [
  { id: 'parse', action: 'data.modules.parse', title: '解析', source: 'declared_material_or_fixed_wfd' },
  { id: 'clean', action: 'data.modules.clean', title: '清洗', source: 'declared_material_or_fixed_wfd' },
  { id: 'structure', action: 'data.modules.structure', title: '结构化', source: 'declared_material_or_fixed_wfd' },
  { id: 'annotate', action: 'data.modules.annotate', title: '标注', source: 'declared_material_or_fixed_wfd' },
  { id: 'check', action: 'data.modules.check', title: '核对', source: 'declared_material_or_fixed_wfd' },
  { id: 'calculate', action: 'data.modules.calculate', title: '计算', source: 'fixed_wfd_only' },
  { id: 'factors', action: 'data.modules.factors', title: '因子库', source: 'registered_definitions_and_fixed_wfd' },
  { id: 'semantics', action: 'data.modules.semantics', title: '语义词典', source: 'read_only_templates_source_profiles_and_fixed_wfd' },
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

/** 新会话只逐步执行；历史批量入口不属于新任务的推荐路径。 */
export function processingSessionContract() {
  return {
    discovery: 'data.processing.capabilities', route: 'data.processing.route', plan: 'data.processing.plan',
    execute: 'data.processing.execute', status: 'data.processing.status', recover: 'data.processing.recover',
    moduleActions: PRODUCTION_MODULES.filter(module => stepModuleForAction(module.action) !== null).map(module => module.action),
    feedback: '识别材料和输入证据 → 选择一个必要模块 → 执行并返回实际结果 → AGENTS决定继续、修订或结束；数据类型不绑定处理模块',
    automaticCrossTrigger: false, automaticFiveStages: false,
    recoveryPolicy: 'recover只核对本会话原计划的持久对象，不创建新计划；已完成步骤不重跑',
    legacyRecovery: { execute: 'data.processing.run',
      newTasks: false, scope: '仅未选择stages的历史批量计划；新计划必须单步执行并读取反馈' },
  } as const;
}

export function productionModuleDirectory(services: {
  processing?: Pick<ProcessingPlanService, 'moduleCapability'>;
  algorithms?: Pick<AlgorithmConversationPort, 'catalog'>;
  hasWfdReader: boolean;
  hasSourceProfiles?: boolean;
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
        sourceVersion: id === 'factors' ? ALGORITHM_REGISTRY_VERSION : SEMANTIC_TEMPLATES_VERSION,
        ...(id === 'semantics' ? { sourceProfilesAvailable: services.hasSourceProfiles === true,
          sourceSemanticsMode: 'read_only_lookup_or_comparison_not_authority' } : {}) };
    }
    if (id === 'calculate') {
      const methods = services.algorithms?.catalog().methods.map(method => ({
        methodId: method.id, status: method.status, reason: method.reason,
        methodVersion: method.methodVersion, implementationVersion: method.implementationVersion,
      })) ?? [];
      return { id, action, title, source, status: !attached ? 'unplugged' as const
          : methods.some(method => method.status === 'ready') ? 'ready' as const : 'blocked' as const,
        engine: services.algorithms ? 'python' : 'unavailable', methods,
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
      dependencies: [] as string[], inputBinding: 'selected_plan_step_artifact' };
  });
  return { version: PRODUCTION_MODULE_PORTS_VERSION, owner: 'bd_service', mode: 'eight_parallel_ports',
    modules, sharedWfdReader: 'R1Workspace.readProduct (bounded, fixed snapshot, single page)',
    sharedVerifier: 'production-verifier',
    sharedPublication: 'existing R1/WFD only', autoTrigger: false,
    note: '八端口彼此并列且按需调用；输入产物类型只约束技术前置条件，不依据数据来源或业务类型自动绑定处理模块。AGENTS每次执行一个模块并读取实际产物，然后决定继续或结束。历史计划与 WFD 发布证明不被改写。' };
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

/** 正式语义只从指定 WFD 固定快照读取；本地模板不能替代已经采用的产品定义。 */
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
    items: entries.map(item => ({ ...item, definition: definitionFor(item.id) ?? null,
      publication: 'not_granted_by_library', execution: 'not_granted_by_library' })) };
}

/** G5 复用 R1 的来源档案和产品登记；只读比较不授予正式采用权限。 */
export const G5_SOURCE_SEMANTICS_VERSION = 'bd.g5.source-semantics/1';
export interface SourceSemanticPorts {
  profiles?: Pick<SourceFieldProfileStore, 'match'>;
  products?: Pick<SemanticProductRegistryStore, 'datasetFor'>;
}
type SourceScope = { sourceId: string; series: string; adapter?: SourceProfileAdapterBinding };
const scopeCode = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/u;
const badSourceQuery = (message: string): never => { throw new TaskError('PRODUCTION_SEMANTIC_SOURCE_QUERY', message); };
function sourceScope(value: unknown, name: string): SourceScope {
  if (!isWfdRecord(value) || Object.keys(value).some(key => !['sourceId','series','adapter'].includes(key))
    || typeof value.sourceId !== 'string' || !scopeCode.test(value.sourceId)
    || typeof value.series !== 'string' || !value.series.trim() || value.series.length > 512
    || value.series.includes('*') || value.series.includes('?')
    || /[\u0000-\u001f]/u.test(value.series)) badSourceQuery(name + ' 需要真实来源编号和明确的数据系列；不能用模糊检索或文件路径代替。');
  const record = value as WfdRecord;
  let adapter: SourceProfileAdapterBinding | undefined;
  if (record.adapter !== undefined) {
    const ref = record.adapter;
    if (!isWfdRecord(ref) || Object.keys(ref).sort().join(',') !== 'adapterId,configDigest,version'
      || typeof ref.adapterId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,99}$/u.test(ref.adapterId)
      || typeof ref.version !== 'string' || !/^[0-9]{1,4}$/u.test(ref.version)
      || typeof ref.configDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.configDigest))
      badSourceQuery(name + ' 的端点适配必须有已登记的 adapterId（编号）、version（版本）与 configDigest（配置摘要）。');
    const verified = ref as WfdRecord;
    adapter = { adapterId: verified.adapterId as string, version: verified.version as string,
      configDigest: verified.configDigest as string };
  }
  return { sourceId: record.sourceId as string, series: record.series as string, ...(adapter ? { adapter } : {}) };
}
function sourceProfilePreview(profile: SourceFieldProfile | null, scope: SourceScope, ports: SourceSemanticPorts, fieldCode?: string) {
  if (!profile) return { status: 'not_registered', scope, gaps: ['指定来源和数据系列无已确认字段档案；不借用其他系列的映射。'],
    candidate: '需由受信操作者根据接口文档和保管原件补充来源字段档案；本工具不登记或采用。' };
  const fingerprint = profileFingerprint(profile), datasetId = ports.products?.datasetFor(fingerprint) ?? null;
  const filtered = fieldCode ? profile.fields.filter(field => field.fieldCode === fieldCode) : profile.fields;
  const displayFields = filtered.slice(0, 8).map(field => ({
    fieldCode: field.fieldCode, originalHeader: field.originalHeader.slice(0, 128),
    aliases: (field.aliases ?? []).slice(0, 2).map(alias => alias.slice(0, 128)),
    totalAliases: field.aliases?.length ?? 0, dataType: field.dataType,
    unitCode: field.unitCode, role: field.role, measurement: field.measurement?.slice(0, 192) ?? null,
    ...(field.measurementStatus === undefined ? {} : { measurementStatus: field.measurementStatus }),
    previewMayTruncate: field.originalHeader.length > 128 || (field.aliases ?? []).length > 2
      || (field.aliases ?? []).some(alias => alias.length > 128) || (field.measurement?.length ?? 0) > 192,
  }));
  const semanticGaps = profileSemanticGaps(profile);
  const gaps = [...semanticGaps,
    ...(fieldCode && !filtered.length ? ['来源档案没有规范字段 ' + fieldCode + '。'] : []),
    ...(!datasetId ? ['没有该语义指纹对应的本机数据集登记；来源档案不等于 WFD 已发布定义。'] : [])];
  return { status: 'registered_source_profile', scope, profileId: profile.profileId,
    semanticStatus: semanticGaps.length ? 'needs_evidence' : 'profile_complete',
    mappingVersion: profile.mappingVersion, digest: sourceFieldProfileDigest(profile),
    fingerprint, registeredDatasetId: datasetId, fieldCount: profile.fields.length,
    displayedFields: displayFields.length, fieldPreviewComplete: filtered.length <= 8
      && displayFields.every(field => !field.previewMayTruncate),
    fields: displayFields, frequency: profile.frequency,
    timeBucket: { ...profile.timeBucket, timezone: profile.timeBucket.timezone.slice(0, 128),
      previewTruncated: profile.timeBucket.timezone.length > 128 },
    adjustment: { status: profile.adjustment.status,
      method: profile.adjustment.method?.slice(0, 192) ?? null, basis: profile.adjustment.basis?.slice(0, 192) ?? null,
      previewTruncated: (profile.adjustment.method?.length ?? 0) > 192 || (profile.adjustment.basis?.length ?? 0) > 192 },
    supersedes: (profile.supersedes ?? []).slice(0, 8).map(item => ({ ...item, note: item.note.slice(0, 192) })),
    totalSupersedes: profile.supersedes?.length ?? 0,
    supersedesPreviewComplete: (profile.supersedes ?? []).length <= 8
      && (profile.supersedes ?? []).every(item => item.note.length <= 192),
    confirmation: { status: profile.confirmation.status, confirmedAtUtc: profile.confirmation.confirmedAtUtc },
    gaps, authority: 'local_operator_confirmed_source_profile_not_formal_wfd_definition', adoption: 'not_granted' };
}

export function sourceSemanticView(query: unknown, ports: SourceSemanticPorts = {}) {
  if (!isWfdRecord(query) || Object.keys(query).some(key => !['left','right','fieldCode'].includes(key))
    || !Object.hasOwn(query, 'left') || JSON.stringify(query).length > 4096)
    badSourceQuery('G5 来源语义查询只接受 left（来源身份）、可选 right（对照来源身份）和 fieldCode（规范字段筛选）。');
  const record = query as WfdRecord;
  const leftScope = sourceScope(record.left, 'left'), rightScope = record.right === undefined ? null : sourceScope(record.right, 'right');
  const fieldCode = record.fieldCode === undefined ? undefined : record.fieldCode;
  if (fieldCode !== undefined && (typeof fieldCode !== 'string' || !scopeCode.test(fieldCode)))
    badSourceQuery('fieldCode 必须是已登记的规范字段编号，不能使用通配符或路径。');
  if (!ports.profiles) return { version: G5_SOURCE_SEMANTICS_VERSION, kind: 'read_only_source_semantics',
    status: 'not_configured', scope: leftScope, compareWith: rightScope,
    gaps: ['本宿主没有装配受信来源字段档案目录。'], adoption: 'not_granted', publication: 'not_requested' };
  const left = ports.profiles.match(leftScope), right = rightScope ? ports.profiles.match(rightScope) : null;
  const result = { version: G5_SOURCE_SEMANTICS_VERSION, kind: 'read_only_source_semantics',
    operation: rightScope ? 'compare' : 'lookup', left: sourceProfilePreview(left, leftScope, ports, fieldCode as string | undefined),
    ...(rightScope ? { right: sourceProfilePreview(right, rightScope, ports, fieldCode as string | undefined) } : {}),
    adoption: 'not_granted', publication: 'not_requested', dataWrite: 'forbidden' };
  if (!rightScope) return { ...result, status: left ? 'registered' : 'needs_evidence' };
  if (!left || !right) return { ...result, status: 'needs_evidence', comparison: null,
    gaps: ['至少一个来源没有匹配来源/系列的已确认字段档案，不能认定同一金融语义。'] };
  const compared = compareProfileSemantics(left, right);
  const leftFingerprint = profileFingerprint(left), rightFingerprint = profileFingerprint(right);
  const leftDataset = ports.products?.datasetFor(leftFingerprint) ?? null;
  const rightDataset = ports.products?.datasetFor(rightFingerprint) ?? null;
  const bounded = (items: string[]) => items.slice(0, 24).map(item => item.slice(0, 240));
  return { ...result, status: compared.status,
    comparison: { sameSignature: compared.sameProduct, identicalSignature: leftFingerprint === rightFingerprint,
      status: compared.status, reasons: bounded(compared.reasons),
      reasonCount: compared.reasons.length,
      reasonsPreviewComplete: compared.reasons.length <= 24 && compared.reasons.every(reason => reason.length <= 240),
      differences: bounded(compared.differences), differenceCount: compared.differences.length,
      gaps: bounded(compared.gaps), gapCount: compared.gaps.length,
      registeredSameDataset: !!leftDataset && leftDataset === rightDataset,
      implication: compared.sameProduct
        ? '仅来源档案口径候选相同；仍需按 WFD 固定产品定义与来源权限独立核对，不自动合并或发布。'
        : compared.status === 'needs_evidence'
          ? '缺少足够语义证据；相同字段、标签或指纹不代表等价，不能自动映射为同一个正式产品。'
          : '存在已明确的金融语义差异；差异与未核证据分别保留，不自动合并或发布。' } };
}

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
  const groups = (document.business_groups as WfdRecord[]).filter(value => isWfdRecord(value));
  const selected = groupId ? groups.filter(item => item.group_id === groupId) : groups;
  if (groupId && !selected.length) return fail('PRODUCTION_SEMANTIC_GROUP', '没有该语义模板分组，不能补造未知概念。');
  return { version: SEMANTIC_TEMPLATES_VERSION, kind: 'read_only_semantic_dictionary',
    status: 'templates_only_not_products', authority: 'no_adoption_or_decision_granted',
    commonAxes: document.common_axes, businessGroups: selected,
    financeSubdomains: groupId ? [] : document.finance_subdomains,
    materialProposalVersion: MATERIAL_SEMANTIC_PROPOSAL_VERSION,
    cleaningRulesVersion: MATERIAL_CLEANING_RULES_VERSION,
    wfdActiveDefinitions: 'select a real frozen WFD product or catalog source; templates do not imply activation',
    noAutomaticAnnotation: true };
}
