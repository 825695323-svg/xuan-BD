import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowUpRight, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import type { ToolLibraryDesignSummary, ToolLibraryParameter, ToolLibraryTool, ToolLibraryView } from '../../../../contracts/tool-library';
import type { AlgorithmDefinition } from '../../../../contracts/algorithm-definition';
import type { AlgorithmDesignCatalog } from '../../../../contracts/algorithm-design-catalog';
import type { FixedCalculationCapabilities } from '../../../../contracts/fixed-calculation-contracts';
import type { AlgorithmCatalogView, AlgorithmTaskView } from '../../../../modules/financial/algorithm-types';
import { RequestError, request } from '../api';
import { loadAlgorithmCatalog } from '../algorithm-api';
import { useAlgorithmResult } from './useAlgorithmResult';
import { fixedCalculationApi } from '../fixed-calculation-api';
import { ALGORITHM_GROUPS, BATCH_ALGORITHMS, OTHER_GROUP, algorithmGroup, batchAlgorithm,
  appendixGroup, DESIGN_RELATED, designGroup, fixedGroup, libraryGroup, type AlgorithmFocusRequest, type AlgorithmGroup, type AlgorithmGroupId,
  type BatchAlgorithmEntry } from './algorithm-catalog';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { taskStateText } from './TaskResults';
import { PageSearch } from './PageUI';
import { usePreferences } from './Preferences';
import { useObjectSelection } from './useStoredSelection';
import { DetailDiagnostics, DetailFacts, DetailHeader, ObjectDetailPanel } from './ObjectDetailPanel';
import { setWorkspaceObject } from './workspace-context';
import './ToolsPage.css';

type Words = (zh: string, en: string) => string;
type EntryKind = 'library' | 'fixed' | 'batch' | 'design';
/** 目录条目分两类：独立算法定义与数据产品/执行配置。只有前者计入算法数量。 */
type EntryClass = 'definition' | 'product' | 'design';
type EntryStatus = 'ready' | 'blocked' | 'unavailable' | null;
/** 设计登记条目归一化后的展示形状；产品、制度与情绪方法共用一套详情结构。 */
interface DesignEntry {
  id: string; name: string; kind: 'product' | 'institutional' | 'sentiment' | 'appendix';
  categoryLabel: string; coverage: string; inputs: string; calculation: string;
  trigger: string; gate: string; owner: string; evidence: string;
  /** 长原文（规范、批次、方法说明），按等宽文本展示。 */
  body?: string;
  links?: { name: string; url: string }[];
  /** 该条目服务的算法或设计条目编号。 */
  related?: readonly string[];
}
interface CatalogEntry {
  key: string; kind: EntryKind; id: string; title: string; description: string; group: AlgorithmGroupId;
  status: EntryStatus; statusLabel: string; search: string;
  entryClass: EntryClass; definition?: AlgorithmDefinition; parent?: AlgorithmDefinition; design?: DesignEntry;
}
const NO_TOOLS: ToolLibraryTool[] = [];
/** 左侧数据产品分组的固定键；与分类 id 分开，避免与用途分类混用。 */
const PRODUCT_NAV = '__products';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const sourceLabels: Record<EntryKind, [string, string]> = {
  library: ['算法定义', 'Definition'], fixed: ['固定产品', 'Fixed product'], batch: ['批量配置', 'Batch config'],
  design: ['设计登记', 'Design entry'],
};
const sourceText = (kind: EntryKind, words: Words) => words(...sourceLabels[kind]);

function groupText(group: AlgorithmGroup, words: Words): string { return words(group.zh, group.en); }

function isParameter(value: unknown): value is ToolLibraryParameter {
  return isRecord(value) && typeof value.key === 'string' && typeof value.label === 'string'
    && typeof value.defaultValue === 'number' && typeof value.min === 'number' && typeof value.max === 'number';
}
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((line) => typeof line === 'string');
}
/** 设计建议是可选只读增项；旧服务不返回时保持原目录，结构不对时也不让整页读取失败。 */
function designText(value: unknown): string {
  if (!isRecord(value)) return '';
  const parts = [value.proposedOwner, value.proposedMethod, value.proposedAcceptance];
  const lists = [value.relatedProducts, value.rulingKeys];
  return parts.filter((part): part is string => typeof part === 'string')
    .concat(lists.flatMap((list) => Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []))
    .join(' ');
}
/** 让搜索能命中公式、口径、产品与旧编号，避免只能靠名称找到算法。 */
function definitionSearch(definition: AlgorithmDefinition): string {
  return [definition.id, definition.title, definition.summary,
    ...definition.formula.map((item) => `${item.output} ${item.expression}`),
    ...definition.semantics.map((item) => `${item.label} ${item.value}`),
    ...definition.products.map((item) => `${item.label} ${item.note}`),
    ...definition.legacyAliases.map((item) => item.alias)].join(' ');
}
function isTool(value: unknown): value is ToolLibraryTool {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    && typeof value.title === 'string' && typeof value.description === 'string'
    && ['ready', 'blocked', 'unavailable'].includes(String(value.status))
    && (value.reason === null || typeof value.reason === 'string')
    && Array.isArray(value.parameters) && value.parameters.every(isParameter)
    && Array.isArray(value.outputFields) && value.outputFields.every((field) => typeof field === 'string')
    && Array.isArray(value.limitations) && value.limitations.every((line) => typeof line === 'string')
    && (value.requiredInputs === undefined || isStringList(value.requiredInputs))
    && (value.missing === undefined || isStringList(value.missing))
    && (value.sources === undefined || isStringList(value.sources))
    && (value.design === undefined || isRecord(value.design))
    && (value.definition === undefined || isRecord(value.definition));
}
function asView(value: unknown): ToolLibraryView {
  if (!isRecord(value) || !Array.isArray(value.tools) || !['ready', 'unavailable'].includes(String(value.status))
    || !(value.reason === null || typeof value.reason === 'string') || !value.tools.every(isTool)) {
    throw new Error('数据算法返回的数据与当前接口契约不一致。');
  }
  return value as unknown as ToolLibraryView;
}
function toolStatusLabel(status: ToolLibraryTool['status'], words: Words): string {
  if (status === 'ready') return words('已启用', 'Enabled');
  if (status === 'blocked') return words('受阻', 'Blocked');
  return words('不可用', 'Unavailable');
}
function toolStateLabel(state: ToolLibraryTool['state'], words: Words): string | null {
  if (state === 'executable') return words('固定实现已登记', 'Fixed implementation registered');
  if (state === 'assets_only') return words('实现已在本工程，入口未放行', 'Implemented locally, entry not released');
  if (state === 'not_implemented') return words('本工程无实现', 'Not implemented here');
  if (state === 'needs_data') return words('缺输入数据', 'Missing input data');
  return null;
}
type StatusTone = 'ok' | 'warn' | 'bad' | 'idle';
interface StatusCell { key: string; label: string; state: string; labelText: string; basis: string; tone: StatusTone }

/**
 * 六维运行状态。
 *
 * 定义/实现/验证三维取自定义层（静态登记）；发布、数据、运行三维必须按当前接口真实返回判定，
 * 不能由静态文件代替。这样“实现已放行”和“入口不可用”就不会再显示成两句互相冲突的话。
 */
function statusCells(tool: ToolLibraryTool, method: AlgorithmCatalogView['methods'][number] | null,
  algorithms: AlgorithmCatalogView | null, words: Words): StatusCell[] {
  const record = tool.definition?.status;
  const definition = record?.definition;
  const implementation = record?.implementation;
  const verification = record?.verification;

  const definitionCell: StatusCell = {
    key: 'definition', label: words('定义状态', 'Definition'), state: definition?.state ?? 'unrecorded',
    labelText: definition?.state === 'frozen' ? words('公式已冻结', 'Frozen')
      : definition?.state === 'conflict' ? words('口径未统一', 'Unresolved') : words('未冻结', 'Not frozen'),
    basis: definition?.basis ?? words('该条目没有登记定义层信息。', 'No definition-layer record.'),
    tone: definition?.state === 'frozen' ? 'ok' : definition?.state === 'conflict' ? 'warn' : 'idle',
  };
  const implementationCell: StatusCell = {
    key: 'implementation', label: words('实现状态', 'Implementation'), state: implementation?.state ?? 'absent',
    labelText: implementation?.state === 'present' ? words('已就位', 'Present')
      : implementation?.state === 'partial' ? words('部分实现', 'Partial') : words('无实现', 'Absent'),
    basis: implementation?.basis ?? words('本工程没有该方法的实现。', 'No implementation in this project.'),
    tone: implementation?.state === 'present' ? 'ok' : implementation?.state === 'partial' ? 'warn' : 'bad',
  };
  const verificationCell: StatusCell = {
    key: 'verification', label: words('验证状态', 'Verification'), state: verification?.state ?? 'unrecorded',
    labelText: verification?.state === 'passed' ? words('已通过', 'Passed')
      : verification?.state === 'not_run' ? words('未验证', 'Not run') : words('无验证回执', 'No receipt'),
    basis: verification?.basis ?? words('没有登记数值回执。', 'No numeric receipt registered.'),
    tone: verification?.state === 'passed' ? 'ok' : 'idle',
  };

  const releaseCell: StatusCell = tool.state !== 'executable'
    ? { key: 'release', label: words('方法登记', 'Method registration'), state: 'not_implemented',
      labelText: words('尚未接入', 'Not implemented'), basis: words('该方法尚无可执行固定实现。', 'Method has no registered fixed executor.'), tone: 'idle' }
    : { key: 'release', label: words('方法登记', 'Method registration'), state: 'fixed_registered',
      labelText: words('固定实现已登记', 'Fixed implementation registered'),
      basis: words('不需要人工采用或逐次业务审批；执行时仍核代码摘要和 WFD 输入资格。',
        'No manual adoption or per-run business approval; code identity and WFD eligibility are still verified.'), tone: 'ok' };

  const dataCell: StatusCell = algorithms?.inputs.fixedSnapshots.status === 'available'
    ? { key: 'data', label: words('数据状态', 'Data'), state: 'fixed_wfd', labelText: words('WFD 快照可读', 'WFD snapshot ready'),
      basis: words('固定算法仅从 WFD 正式快照取数，不接受本地受管原件直算。',
        'Fixed algorithms read only WFD published snapshots, not local managed files.'), tone: 'ok' }
    : { key: 'data', label: words('数据状态', 'Data'), state: 'unavailable',
      labelText: words('无可用固定快照', 'No fixed snapshot'),
      basis: algorithms?.inputs.fixedSnapshots.reason ?? words('尚未读取真实 WFD 快照端口。', 'WFD snapshot port has not been verified.'),
      tone: algorithms ? 'warn' : 'idle' };

  let runtimeCell: StatusCell;
  if (tool.state !== 'executable') {
    runtimeCell = { key: 'runtime', label: words('运行状态', 'Runtime'), state: 'not_released',
      labelText: words('入口未放行', 'Not released'),
      basis: words('受控执行入口没有放行该操作；登记存在不等于可以计算。', 'The controlled entry does not release this operation; registration is not runnability.'),
      tone: 'idle' };
  } else if (!algorithms) {
    runtimeCell = { key: 'runtime', label: words('运行状态', 'Runtime'), state: 'unavailable', labelText: words('未读取', 'Not read'),
      basis: words('计算入口目录未读取。', 'Compute catalog not read.'), tone: 'idle' };
  } else if (!method) {
    runtimeCell = { key: 'runtime', label: words('运行状态', 'Runtime'), state: 'unavailable', labelText: words('目录未声明', 'Not declared'),
      basis: words('计算入口没有声明此方法。', 'The compute catalog does not declare this method.'), tone: 'bad' };
  } else if (method.status === 'ready') {
    runtimeCell = { key: 'runtime', label: words('运行状态', 'Runtime'), state: 'available', labelText: words('可执行', 'Available'),
      basis: words('固定算法可用；计算后仍核结果并经 WFD 正式提交。', 'Fixed algorithm available; results require independent verification and formal WFD publication.'), tone: 'ok' };
  } else if (method.status === 'blocked') {
    runtimeCell = { key: 'runtime', label: words('运行状态', 'Runtime'), state: 'blocked', labelText: words('受阻', 'Blocked'),
      basis: method.reason ?? words('输入或服务尚未就绪。', 'Input or service not ready.'), tone: 'warn' };
  } else {
    runtimeCell = { key: 'runtime', label: words('运行状态', 'Runtime'), state: 'unavailable', labelText: words('不可用', 'Unavailable'),
      basis: method.reason ?? algorithms.reason ?? words('计算入口当前不可用。', 'The compute entry is unavailable.'), tone: 'bad' };
  }

  return [definitionCell, implementationCell, verificationCell, releaseCell, dataCell, runtimeCell];
}

/** 一句总体结论：把“实现已放行”和“入口不可用”解释成同一件事的不同维度。 */
function overallStatus(cells: StatusCell[], words: Words): { title: string; tone: StatusTone } {
  const runtime = cells.find((cell) => cell.key === 'runtime');
  if (runtime?.state === 'available') return { title: words('当前可以执行正式计算', 'Formal computation is available'), tone: 'ok' };
  if (runtime?.state === 'not_released') {
    return { title: words('受控入口未放行，当前不能执行', 'Not released on the controlled entry; cannot run'), tone: 'idle' };
  }
  return { title: words('当前不能执行正式计算', 'Formal computation is not available now'), tone: runtime?.tone ?? 'warn' };
}

function shortDigest(value: string): string { return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value; }
function displayCell(value: unknown, words: Words): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? words('是', 'Yes') : words('否', 'No');
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(10).replace(/0+$/u, '').replace(/\.$/u, '');
  return String(value);
}
function sourceLabel(source: unknown): string {
  if (isRecord(source) && typeof source.displayName === 'string') return source.displayName;
  if (isRecord(source) && source.kind === 'fixed_snapshot') return '固定快照';
  return '受管表';
}

/** 数据产品归属：按定义层登记的 products.entryId 反查父算法，不靠名称匹配。 */
function parentOfProduct(tools: ToolLibraryTool[], entryId: string): AlgorithmDefinition | undefined {
  for (const tool of tools) {
    if (tool.definition?.products.some((item) => item.entryId === entryId)) return tool.definition;
  }
  return undefined;
}

function buildEntries(tools: ToolLibraryTool[], fixed: FixedCalculationCapabilities['methods'], configured: boolean,
  catalog: AlgorithmDesignCatalog | undefined, words: Words): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const tool of tools) {
    const group = libraryGroup(tool.id);
    const statusLabel = toolStatusLabel(tool.status, words);
    entries.push({ key: `library:${tool.id}`, kind: 'library', id: tool.id, title: tool.title, description: tool.description,
      group, status: tool.status, statusLabel, entryClass: 'definition',
      ...(tool.definition ? { definition: tool.definition } : {}),
      search: `${tool.id} ${tool.title} ${tool.description} ${sourceText('library', words)} ${groupText(algorithmGroup(group), words)} ${designText(tool.design)} ${tool.definition ? definitionSearch(tool.definition) : ''}`.toLowerCase() });
  }
  for (const method of fixed) {
    const group = fixedGroup(method.id);
    const statusLabel = configured ? words('固定入口已装配', 'Fixed entry configured') : words('固定入口未装配', 'Fixed entry not configured');
    const parent = parentOfProduct(tools, `fixed:${method.id}`);
    entries.push({ key: `fixed:${method.id}`, kind: 'fixed', id: method.id, title: method.title, description: method.description,
      group, status: configured ? 'ready' : 'blocked', statusLabel, entryClass: 'product',
      ...(parent ? { parent } : {}),
      search: `${method.id} ${method.title} ${method.description} ${method.scope} ${sourceText('fixed', words)} ${groupText(algorithmGroup(group), words)} ${parent ? parent.title : ''}`.toLowerCase() });
  }
  for (const batch of BATCH_ALGORITHMS) {
    const group: AlgorithmGroupId = 'technical';
    const parent = parentOfProduct(tools, `batch:${batch.id}`);
    entries.push({ key: `batch:${batch.id}`, kind: 'batch', id: batch.id, title: words(batch.zh, batch.en),
      description: words(batch.zhDescription, batch.enDescription), group, status: null,
      statusLabel: words('原批次入口', 'Original batch entry'), entryClass: 'product',
      ...(parent ? { parent } : {}),
      search: `${batch.id} ${batch.zh} ${batch.en} ${batch.zhDescription} ${batch.enDescription} ${sourceText('batch', words)} ${groupText(algorithmGroup(group), words)} ${parent ? parent.title : ''}`.toLowerCase() });
  }
  if (catalog) {
    for (const item of catalog.products) {
      entries.push({ key: `design:${item.id}`, kind: 'design', id: item.id, title: item.name,
        description: item.calculation, group: designGroup(item.id), status: null,
        statusLabel: words('设计登记', 'Design only'), entryClass: 'design',
        design: { id: item.id, name: item.name, kind: 'product', categoryLabel: item.category,
          coverage: item.coverage, inputs: item.inputs, calculation: item.calculation,
          trigger: item.trigger, gate: item.gate, owner: item.h02, evidence: item.sourceCues },
        search: [item.id, item.name, item.category, item.coverage, item.inputs, item.calculation,
          item.trigger, item.gate, item.h02, item.sourceCues, '设计登记', '产品'].join(' ').toLowerCase() });
    }
    for (const item of catalog.institutional) {
      entries.push({ key: `design:${item.id}`, kind: 'design', id: item.id, title: item.name,
        description: item.calculation, group: designGroup(item.id), status: null,
        statusLabel: words('设计登记', 'Design only'), entryClass: 'design',
        design: { id: item.id, name: item.name, kind: 'institutional', categoryLabel: 'A 股制度与披露',
          coverage: item.coverage, inputs: item.inputs, calculation: item.calculation,
          trigger: item.trigger, gate: item.gate, owner: item.h02,
          evidence: [item.provenanceNote, ...item.sourceFiles].join(' · ') },
        search: [item.id, item.name, item.coverage, item.inputs, item.calculation, item.trigger,
          item.gate, item.h02, item.provenanceNote, item.sourceFiles.join(' '), '设计登记', '制度'].join(' ').toLowerCase() });
    }
    for (const item of catalog.sentiment) {
      entries.push({ key: `design:${item.id}`, kind: 'design', id: item.id, title: item.name,
        description: item.formula, group: designGroup(item.id), status: null,
        statusLabel: words('设计登记', 'Design only'), entryClass: 'design',
        design: { id: item.id, name: item.name, kind: 'sentiment', categoryLabel: 'A 股短线情绪',
          coverage: item.layer, inputs: item.inputs, calculation: item.formula,
          trigger: item.layer, gate: item.gate, owner: item.layer,
          evidence: [item.evidence, ...item.sources].join(' · ') },
        search: [item.id, item.name, item.layer, item.evidence, item.inputs, item.formula, item.gate,
          item.sources.join(' '), '设计登记', '情绪'].join(' ').toLowerCase() });
    }
    const spec = catalog.sentimentSpec;
    const specLines = [
      ...spec.rules,
      '',
      '权重：' + spec.weights.map((item) => `${item.dimension} ${item.weight}`).join(' · '),
      '温度带：' + spec.bands.map((item) => `${item.range} ${item.label}`).join(' · '),
      '阶段：' + spec.stages.map((item) => `${item.name}＝${item.rule}`).join('；'),
    ].join('\n');
    const appendix: DesignEntry[] = [
      { id: 'SPEC-01', name: '情绪五维原式、权重与温度带', kind: 'appendix', categoryLabel: '情绪评分规范',
        coverage: '五维加权总分、温度分档与阶段判定', inputs: spec.weights.map((item) => `${item.dimension} ${item.weight}`).join(' · '),
        calculation: '五维各自取历史分位，按 30/25/25/15/5 加权；可用权重低于 70% 输出缺失。',
        trigger: spec.stages.map((item) => item.name).join(' / '), gate: '恰 70% 可算；时间序列保留覆盖，避免把某维掉线当成市场转暖。',
        owner: 'BD 事实与评分；H-02 版本回放与验证', evidence: '规划原文「市场情绪五维原式、阶段与验收算例」', body: specLines },
      { id: 'SPEC-02', name: '情绪验收算例', kind: 'appendix', categoryLabel: '情绪评分规范',
        coverage: `${spec.fixtures.length} 组合成样例`, inputs: '封板率、分位、连板队列、竞价快照、龙虎榜明细',
        calculation: '逐组给出期望值，用于拦截口径错误（如把回封计入炸板分母）。',
        trigger: '每次评分实现变更', gate: '算例不过不得发布分数。', owner: 'H-02 复算；BD 保留独立评测',
        evidence: '规划原文验收算例表',
        body: spec.fixtures.map((item, index) => `${index + 1}. 样例：${item.sample}\n   期望：${item.expected}`).join('\n\n') },
      { id: 'SPEC-03', name: '生产表与最小数据档位', kind: 'appendix', categoryLabel: '情绪评分规范',
        coverage: '逐股明细键、队列字段、版本字段与最小数据要求', inputs: '交易日、快照截点、稳定证券 ID、规则版本',
        calculation: '每行记 event_time / available_at / computed_at / 源对象版本与修订号。',
        trigger: '建表与回放', gate: '只有复权价格时须先找原始执行价；日线不能复原盘口队列。', owner: 'BD 建表与保管',
        evidence: '规划原文「生产表建议」「最小数据档位」', body: spec.production.join('\n\n') },
      { id: 'SPEC-04', name: '情绪分与预测标签发布条件', kind: 'appendix', categoryLabel: '情绪评分规范',
        coverage: '描述性复现与次日预测效力的分别验收', inputs: '样本外结果、目标定义、基准',
        calculation: '描述性复现与预测效力各自回执，不得互相替代。',
        trigger: '发布前', gate: '没有样本外结果时，研究分只描述当天输出。', owner: 'Xuan 发起、H-02 执行、BD 独立评测',
        evidence: '规划原文「何时允许发布情绪分和预测标签」', body: spec.publish.join('\n\n') },
      ...catalog.batches.map((item, index): DesignEntry => ({
        id: `BATCH-${index}`, name: item.batch, kind: 'appendix', categoryLabel: '落地批次',
        coverage: '实施顺序建议', inputs: item.delivery, calculation: item.acceptance,
        trigger: '批次启动', gate: '每个产品只在获得自身验收回执后前进。', owner: '按批次分工',
        evidence: '规划原文「落地批次与退出条件」', body: `${item.delivery}\n\n${item.acceptance}` })),
      ...catalog.external.map((item, index): DesignEntry => ({
        id: `EXT-${String(index + 1).padStart(2, '0')}`, name: `${item.topic}核对`, kind: 'appendix',
        categoryLabel: '外部规则', coverage: item.topic, inputs: '交易所/监管规则原文', calculation: item.note,
        trigger: '规则或公司行动变更', gate: '按交易所、板块、生效日与例外匹配，不得套用现行规则回算历史。',
        owner: 'BD 事实核对；H-02 研究', evidence: '规划原文「外部规则核对」',
        links: item.links.map((link) => ({ name: link.name, url: link.url })) })),
      ...catalog.notes.map((item, index): DesignEntry => ({
        id: `NOTE-${String(index + 1).padStart(2, '0')}`, name: item.title, kind: 'appendix',
        categoryLabel: '规划方法说明', coverage: '原文保留', inputs: '规划原件', calculation: '见下方原文',
        trigger: '设计与复核', gate: '说明性内容，不构成验收。', owner: '规划原件', evidence: '规划 md 原文',
        body: item.text })),
    ];
    for (const item of appendix) {
      entries.push({ key: `design:${item.id}`, kind: 'design', id: item.id, title: item.name,
        description: item.calculation, group: appendixGroup(item.id), status: null,
        statusLabel: words('设计附录', 'Design appendix'), entryClass: 'design', design: item,
        search: [item.id, item.name, item.categoryLabel, item.coverage, item.inputs, item.calculation,
          item.trigger, item.gate, item.owner, item.evidence, item.body ?? '', '设计附录'].join(' ').toLowerCase() });
    }
  }
  for (const entry of entries) {
    if (entry.design) entry.design.related = DESIGN_RELATED[entry.design.id] ?? [];
  }
  return entries;
}

const fixedInputLabels: Record<string, [string, string]> = {
  associated_daily_sources: ['已关联的完整日线原报', 'Associated complete daily source reports'],
  fixed_financial_records: ['固定财务报表记录', 'Fixed financial statement records'],
  fixed_macro_records: ['固定宏观发布记录', 'Fixed macro release records'],
};
const fixedInputText = (input: string, words: Words) => {
  const label = fixedInputLabels[input];
  return label ? words(label[0], label[1]) : input;
};

export function ToolsPage({ onOpenEntry }: { onOpenEntry(request: AlgorithmFocusRequest): void }) {
  const words = useWords(), { t } = usePreferences();
  const [view, setView] = useState<ToolLibraryView | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState<string | null>(null);
  const [loadStatus, setLoadStatus] = useState<number | null>(null), [reloadNonce, setReloadNonce] = useState(0);
  const [catalogQuery, setCatalogQuery] = useState('');
  /** 第一栏只选分类；具体条目在第二栏。 */
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [algorithms, setAlgorithms] = useState<AlgorithmCatalogView | null>(null);
  const [algorithmError, setAlgorithmError] = useState<string | null>(null);
  const [algorithmStatus, setAlgorithmStatus] = useState<number | null>(null);
  const [fixedCaps, setFixedCaps] = useState<FixedCalculationCapabilities | null>(null);
  const [fixedLoading, setFixedLoading] = useState(true), [fixedError, setFixedError] = useState<string | null>(null);
  const [fixedStatus, setFixedStatus] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setLoadError(null); setLoadStatus(null);
    void request('/api/ui/tool-library').then(asView).then((next) => {
      if (!cancelled) setView(next);
    }).catch((failure) => {
      if (cancelled) return;
      setLoadError(errorDetail(failure));
      setLoadStatus(failure instanceof RequestError ? failure.status : null);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadNonce]);

  useEffect(() => {
    let cancelled = false;
    setAlgorithmError(null); setAlgorithmStatus(null);
    void loadAlgorithmCatalog().then((next) => {
      if (!cancelled) setAlgorithms(next);
    }).catch((failure) => {
      if (cancelled) return;
      setAlgorithms(null);
      setAlgorithmError(failure instanceof RequestError && failure.status === 404
        ? '算法计算入口尚未装配（/api/ui/algorithms 未挂载）；当前只保留只读目录。'
        : errorDetail(failure));
      setAlgorithmStatus(failure instanceof RequestError ? failure.status : null);
    });
    return () => { cancelled = true; };
  }, [reloadNonce]);

  useEffect(() => {
    let cancelled = false;
    setFixedLoading(true); setFixedError(null); setFixedStatus(null);
    void fixedCalculationApi.capabilities().then((next) => {
      if (!cancelled) setFixedCaps(next);
    }).catch((failure) => {
      if (cancelled) return;
      setFixedCaps(null);
      setFixedError(failure instanceof RequestError && failure.status === 404
        ? '固定计算入口尚未装配（/api/bd/computation/capabilities 未挂载）；基础库与批量入口仍各自保留。'
        : errorDetail(failure));
      setFixedStatus(failure instanceof RequestError ? failure.status : null);
    }).finally(() => { if (!cancelled) setFixedLoading(false); });
    return () => { cancelled = true; };
  }, [reloadNonce]);

  const tools = view?.tools ?? NO_TOOLS;
  const fixedMethods = useMemo(() => fixedCaps?.methods ?? [], [fixedCaps]);
  const entries = useMemo(() => buildEntries(tools, fixedMethods, fixedCaps?.configured === true, view?.catalog, words),
    [tools, fixedMethods, fixedCaps?.configured, view?.catalog, words]);
  /**
   * 三栏布局里当前选中的条目。只认目录里真实存在的 key：
   * 目录未读回前保持 pending，不先回落到"没有条目"。
   */
  const catalogsComplete = loadError === null && fixedError === null;
  const selection = useObjectSelection('xuan.tools.object', entries.map((entry) => entry.key),
    !loading && !fixedLoading, 'first', catalogsComplete);
  const selectedKey = selection.id;
  const result = useAlgorithmResult(selectedKey);
  const { task: callView, error: callError, loading: busy } = result;
  const setSelectedKey = selection.select;
  const selectedEntry = entries.find((entry) => entry.key === selectedKey) ?? null;
  const selectedTool = selectedEntry?.kind === 'library' ? tools.find((tool) => tool.id === selectedEntry.id) ?? null : null;
  const selectedMethod = algorithms?.methods.find((method) => method.id === selectedTool?.id) ?? null;
  const selectedFixed = selectedEntry?.kind === 'fixed' ? fixedMethods.find((method) => method.id === selectedEntry.id) ?? null : null;
  const selectedBatch = selectedEntry?.kind === 'batch' ? batchAlgorithm(selectedEntry.id) : null;
  const selectedDesign = selectedEntry?.entryClass === 'design' ? selectedEntry : null;
  const relatedDesign = selectedTool
    ? entries.filter((entry) => entry.entryClass === 'design' && entry.design?.related?.includes(selectedTool.id))
    : [];
  const query = catalogQuery.trim().toLowerCase();
  const definitionEntries = entries.filter((entry) => entry.entryClass === 'definition');
  const productEntries = entries.filter((entry) => entry.entryClass === 'product');
  const designEntries = entries.filter((entry) => entry.entryClass === 'design');
  /** 分类只用于左侧目录分组与计数；数据产品与设计登记都不计入算法数量。 */
  const categoryCounts = new Map<AlgorithmGroupId, number>();
  for (const entry of definitionEntries) categoryCounts.set(entry.group, (categoryCounts.get(entry.group) ?? 0) + 1);
  const designCounts = new Map<AlgorithmGroupId, number>();
  for (const entry of designEntries) designCounts.set(entry.group, (designCounts.get(entry.group) ?? 0) + 1);
  const visibleGroups = [...ALGORITHM_GROUPS, OTHER_GROUP].filter((group) =>
    (categoryCounts.get(group.id) ?? 0) + (designCounts.get(group.id) ?? 0) > 0);
  const filteredDefinitions = definitionEntries.filter((entry) => !query || entry.search.includes(query));
  const filteredProducts = productEntries.filter((entry) => !query || entry.search.includes(query));
  const filteredDesign = designEntries.filter((entry) => !query || entry.search.includes(query));
  const filteredEntries = [...filteredDefinitions, ...filteredProducts, ...filteredDesign];
  const visibleEntries = filteredEntries.filter((entry) => !activeGroup || !!query
    || (activeGroup === PRODUCT_NAV ? entry.entryClass === 'product' : entry.group === activeGroup && entry.entryClass !== 'product'));
  const definitionCount = definitionEntries.length, productCount = productEntries.length, designCount = designEntries.length;
  const refresh = () => setReloadNonce((value) => value + 1);
  const libraryStatus = loading ? 'loading' : loadError ? 'error' : view?.status === 'ready' ? 'ready' : 'unavailable';
  const fixedStatusView = fixedLoading ? 'loading' : fixedError ? 'error' : fixedCaps?.configured ? 'ready' : 'blocked';
  // 只发布"当前在看哪个算法"，不写会话、不触发计算。
  useEffect(() => {
    setWorkspaceObject(selectedEntry ? { page: 'tools', kind: 'algorithm', id: selectedEntry.id, label: selectedEntry.title } : null);
  }, [selectedEntry?.key, selectedEntry?.id, selectedEntry?.title]);
  useEffect(() => () => setWorkspaceObject(null), []);
  const selectedOutsideFilter = !!selectedEntry && !filteredEntries.some((entry) => entry.key === selectedEntry.key);
  const statusList = selectedTool ? statusCells(selectedTool, selectedMethod, algorithms, words) : [];
  const runtimeCell = statusList.find((cell) => cell.key === 'runtime');
  const overall = overallStatus(statusList, words);

  /** 第三栏头部：名称 + 主要状态；条目编号与分类放次要行，避免和列表重复。 */
  const detailHeader = <DetailHeader
    title={selection.pending ? words('正在读取…', 'Loading…') : selectedEntry ? selectedEntry.title : words('算法定义与数据产品', 'Algorithm definitions and data products')}
    status={selectedEntry?.statusLabel}
    tone={selectedEntry?.status === 'ready' ? 'ready' : selectedEntry?.status === 'blocked' ? 'blocked' : selectedEntry?.status === 'unavailable' ? 'warning' : 'neutral'}
    meta={selectedEntry
      ? selectedEntry.entryClass === 'product'
        ? words(`数据产品 · 归属 ${selectedEntry.parent?.title ?? '未登记'} · ${selectedEntry.id}`, `Data product · belongs to ${selectedEntry.parent?.title ?? 'unregistered'} · ${selectedEntry.id}`)
        : `${groupText(algorithmGroup(selectedEntry.group), words)} · ${selectedEntry.id}`
      : words('统一算法查找', 'Unified algorithm finder')}
    badge={<button type="button" className="text-button tools-refresh" onClick={refresh} disabled={loading || busy}>
      {loading ? <Loader2 className="tools-spin" size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
      {loading ? words('读取中…', 'Loading…') : words('重新读取', 'Refresh')}
    </button>} />;

  /**
   * 摘要：只放算法使用者最先要判断的三件事——算什么、几个参数、产出什么。
   * 这里只给条目与数量；完整公式、默认值与范围留在主体，避免同一段文字出现两次。
   */
  const detailSummary = selectedEntry?.entryClass === 'definition' && selectedTool ? <DetailFacts items={[
    { label: words('输出', 'Outputs'), value: selectedTool.definition?.formula.length
      ? words(`${selectedTool.definition.formula.length} 条：${selectedTool.definition.formula.map((item) => item.output).join('、')}`,
        `${selectedTool.definition.formula.length}: ${selectedTool.definition.formula.map((item) => item.output).join(', ')}`)
      : words('未登记定义层公式', 'No definition-layer formula') },
    { label: words('参数', 'Parameters'), value: selectedTool.parameters.length
      ? words(`${selectedTool.parameters.length} 个：${selectedTool.parameters.map((parameter) => parameter.label).join('、')}`,
        `${selectedTool.parameters.length}: ${selectedTool.parameters.map((parameter) => parameter.label).join(', ')}`)
      : words('无参数', 'None') },
    { label: words('关联产物', 'Products'), value: selectedTool.definition?.products.length
      ? words(`${selectedTool.definition.products.length} 个：${selectedTool.definition.products.map((product) => product.label).join('、')}`,
        `${selectedTool.definition.products.length}: ${selectedTool.definition.products.map((product) => product.label).join(', ')}`)
      : words('未登记数据产品', 'No data products') },
  ]} /> : undefined;

  /** 折叠诊断：运行状态、目录读取、源码与设计台账只在这里出现。 */
  const detailDiagnostics = <DetailDiagnostics
    label={words('运行状态与工程诊断', 'Runtime and engineering diagnostics')}
    count={words(`${definitionCount} 定义 · ${productCount} 产品 · ${designCount} 设计`, `${definitionCount} defs · ${productCount} products · ${designCount} designs`)}>
    {selectedEntry?.entryClass === 'definition' && selectedTool && statusList.length > 0 && <div className="object-detail-section">
      <div className="tools-section-head"><h4 id="algo-status">{words('④ 运行状态', '④ Runtime')}</h4>
        <span className="algo-layer-note">{words('六个维度分别判定，不用一个状态概括全部', 'Six independent dimensions')}</span></div>
      <div className="algo-status-grid">{statusList.map((cell) => <div className="algo-status-cell" key={cell.key} data-tone={cell.tone}>
        <span className="algo-status-label">{cell.label}</span>
        <span className="algo-status-value" data-tone={cell.tone}>{cell.labelText}</span>
        <span className="algo-status-basis">{cell.basis}</span>
      </div>)}</div>
      <p className="algo-overall" data-tone={overall.tone} role="status">
        <strong>{overall.title}</strong>
        <span>{runtimeCell?.basis ?? words('状态尚未读取。', 'Status not read yet.')}</span>
      </p>
      {algorithmError && <p className="tools-muted algo-status-error">{algorithmStatus === 404
        ? words('计算入口尚未装配；运行状态按未读取显示，不用旧数据代替。', 'Compute endpoint not connected; runtime is shown as not read instead of using stale data.')
        : algorithmError}</p>}
    </div>}
    <p className="algo-counts">{words(
      `${definitionCount} 个算法定义 · ${designCount} 条设计登记 · ${productCount} 个数据产品；设计登记与批量作业不重复计入算法数量。`,
      `${definitionCount} algorithm definitions · ${designCount} design entries · ${productCount} data products; design entries and batch jobs are not counted as algorithms.`)}</p>
    <div className="market-scope">
      <span>{query
        ? words(`搜索「${catalogQuery.trim()}」`, `Search "${catalogQuery.trim()}"`)
        : words('全部算法定义与数据产品', 'All definitions and data products')}</span>
      <span className="market-state">{words(
        `${filteredDefinitions.length} 个算法定义${filteredProducts.length ? ` · ${filteredProducts.length} 个数据产品` : ''}`,
        `${filteredDefinitions.length} definitions${filteredProducts.length ? ` · ${filteredProducts.length} data products` : ''}`)}</span>
    </div>
    <div className="source-check-block" aria-label={words('目录与数据产品读取状态', 'Catalog and product load status')}>
      <div className="source-check-head"><strong>{words('目录读取状态', 'Catalog load status')}</strong>
        <small>{words('页面加载只读目录与能力；检查、计算与发布都由用户在原入口显式发起。',
          'Page load only reads catalogs and capabilities; checks, computation and publication start explicitly in the original entry.')}</small></div>
      <details className="algo-status-details">
        <summary>{words('展开查看目录读取状态', 'Show catalog load status')}</summary>
        <section className="tools-source-overview">
          <article className="tools-source-card" data-status={libraryStatus}>
            <div className="tools-source-card-head"><span className="tools-source-tag" data-kind="library">{sourceText('library', words)}</span>
              {loading && <Loader2 className="tools-spin" size={14} aria-hidden="true" />}</div>
            <p className="tools-source-card-count">{loading ? words('读取中…', 'Loading…') : loadError ? words('读取失败', 'Load failed') : `${tools.length}`}
              {!loading && !loadError && <span>{words(' 个算法定义', ' algorithm definitions')}</span>}</p>
            <p className="tools-source-card-note">{loading ? words('正在读取目录与各条真实状态…', 'Reading the catalog and actual states…')
              : loadError ? words('算法定义目录未读取成功；数据产品仍单独显示。', 'The definition catalog did not load; data products remain listed separately.')
                : view?.status === 'ready' ? words('目录已读取；分类不改变采用、可用或发布状态。', 'Catalog loaded; categories do not change adoption, availability or publication state.')
                  : words('基础库目录当前不可用；未用旧数据代替。', 'The base-library catalog is unavailable; stale data is not substituted.')}</p>
          </article>
          <article className="tools-source-card" data-status={fixedStatusView}>
            <div className="tools-source-card-head"><span className="tools-source-tag" data-kind="fixed">{sourceText('fixed', words)}</span>
              {fixedLoading && <Loader2 className="tools-spin" size={14} aria-hidden="true" />}</div>
            <p className="tools-source-card-count">{fixedLoading ? words('读取中…', 'Loading…') : fixedError ? words('读取失败', 'Load failed') : `${fixedMethods.length}`}
              {!fixedLoading && !fixedError && <span>{words(' 个固定产品', ' fixed products')}</span>}</p>
            <p className="tools-source-card-note">{fixedLoading ? words('正在读取固定方法目录…', 'Reading the fixed method catalog…')
              : fixedError ? words('固定产品目录未读取成功；算法定义与批量配置仍分别显示。', 'The fixed product catalog did not load; definitions and batch configs remain listed separately.')
                : fixedCaps?.configured ? words('入口已装配；实际输入仍以数据库固定计算面板为准。', 'Entry configured; actual inputs still come from the Database fixed-calculation panel.')
                  : words('入口未装配或当前不可用；未把方法标成可运行。', 'Entry is not configured or unavailable; methods are not marked runnable.')}</p>
          </article>
          <article className="tools-source-card" data-status="entry">
            <div className="tools-source-card-head"><span className="tools-source-tag" data-kind="batch">{sourceText('batch', words)}</span></div>
            <p className="tools-source-card-count">{BATCH_ALGORITHMS.length}<span>{words(' 条批量执行配置', ' batch configs')}</span></p>
            <p className="tools-source-card-note">{words('原入口在数据库 R1 面板；本页不读取批次、周期或批次状态。', 'The original entry is in the Database R1 panel; this page does not read batches, periods or batch states.')}</p>
          </article>
        </section>
      </details>
    </div>
    {selectedEntry?.entryClass === 'definition' && selectedTool && <DevDiagnostics tool={selectedTool} summary={view?.design} words={words} />}
    {view?.design && <DesignLedger summary={view.design} words={words} />}
  </DetailDiagnostics>;

  return <div className="data-page tools-page page-panes">
    <aside className="data-nav tools-nav algo-nav" aria-label={words('算法分类', 'Algorithm categories')}>
      <div className="sidebar-search-slot">
        <PageSearch compact value={catalogQuery} onChange={setCatalogQuery}
          label={words('搜索算法、编号或用途', 'Search algorithm, ID or usage')} />
      </div>
      <header className="page-nav-head"><span>{words('分类', 'Categories')}</span></header>
      <div className="page-nav-list">
        <button type="button" className="data-nav-item" aria-current={activeGroup === null ? 'true' : undefined} onClick={() => setActiveGroup(null)}>
          <span>{words('全部条目', 'All entries')}</span><span className="algo-nav-count">{filteredEntries.length}</span>
        </button>
        {visibleGroups.map((group) => <button type="button" key={group.id} className="data-nav-item"
          aria-current={activeGroup === group.id ? 'true' : undefined} onClick={() => setActiveGroup(group.id)}>
          <span className="algo-nav-category-title">{groupText(group, words)}</span>
          <span className="algo-nav-count">{(categoryCounts.get(group.id) ?? 0) + (designCounts.get(group.id) ?? 0)}</span>
        </button>)}
        {filteredProducts.length > 0 && <button type="button" className="data-nav-item"
          aria-current={activeGroup === PRODUCT_NAV ? 'true' : undefined} onClick={() => setActiveGroup(PRODUCT_NAV)}>
          <span className="algo-nav-category-title">{words('数据产品与执行配置', 'Data products and execution configs')}</span>
          <span className="algo-nav-count">{filteredProducts.length}</span>
        </button>}
      </div>
    </aside>

    {/* 第二栏：对象列表。只做选择，不改变任何登记、采用或运行状态。 */}
    <div className="page-cards" aria-label={words('算法条目', 'Algorithm entries')}>
      <div className="object-list">
        {visibleEntries.map((entry) => <button type="button" key={entry.key} className="object-card"
          aria-current={selectedEntry?.key === entry.key ? 'true' : undefined} onClick={() => setSelectedKey(entry.key)}>
          <span className="object-card-main">
            <span className="object-card-title">{entry.title}</span>
            <span className="object-card-meta">{entry.id} · {entry.entryClass === 'product'
              ? words('数据产品', 'Data product') : entry.entryClass === 'design'
                ? words('设计登记', 'Design only') : groupText(algorithmGroup(entry.group), words)}</span>
          </span>
          <span className="object-card-state" data-state={entry.status}>{entry.statusLabel}</span>
        </button>)}
        {!visibleEntries.length && <p className="data-empty">{query
          ? words('没有匹配的算法条目。', 'No matching entries.') : words('这个分类下没有条目。', 'No entries in this category.')}</p>}
      </div>
    </div>

    <ObjectDetailPanel label={t('nav.tools')} header={detailHeader} summary={detailSummary} diagnostics={detailDiagnostics}>
      <div className="tools-content" aria-busy={loading || fixedLoading}>
        {!filteredEntries.length && <p className="data-empty">{query
          ? words('左侧目录没有匹配的算法或数据产品；下方设计目录仍按同一搜索词过滤。',
            'No matching algorithm or product in the catalog; the design catalog below is still filtered by the same term.')
          : entries.length ? words('当前没有可显示的条目。', 'No entries are available to show.') : words('尚未读取到任何算法条目。', 'No algorithm entries loaded.')}</p>}

        {loadError && <div className="tools-state-block"><ErrorNote detail={loadError}>{view
          ? words('上次刷新未完成；下面仍是上次成功读取的内容。', 'The last refresh failed. The content below is from the last successful read.')
          : loadStatus === 404
            ? words('数据算法接口尚未装配。', 'The data algorithm endpoint is not connected.')
            : words('数据算法没有读取成功。', 'Data algorithms could not be loaded.')}</ErrorNote></div>}
        {fixedError && <div className="tools-state-block"><ErrorNote detail={fixedError}>{fixedStatus === 404
          ? words('固定计算接口尚未装配；未影响基础算法库与批量入口的分别读取。', 'The fixed-calculation endpoint is not connected; base-library and batch entries are still loaded separately.')
          : words('固定方法目录没有读取成功；未把固定方法标成可运行。', 'The fixed method catalog could not be read; fixed methods are not marked runnable.')}</ErrorNote></div>}
        {!loading && view && tools.length === 0 && !loadError && <div className="tools-state-block" role="status">
          <p className="tools-empty-title">{words('基础算法库目录为空。', 'The base-library catalog is empty.')}</p>
          <p className="tools-muted">{words('服务当前没有返回登记方法；固定计算与批量入口仍在上方单独显示。', 'The service returned no registered methods; fixed and batch entries remain listed separately above.')}</p>
        </div>}
        {!fixedLoading && fixedCaps && fixedMethods.length === 0 && <div className="tools-state-block" role="status">
          <p className="tools-empty-title">{words('固定方法目录为空。', 'The fixed method catalog is empty.')}</p>
          <p className="tools-muted">{words('服务当前没有返回固定计算方法；基础算法库与批量入口仍在上方单独显示。', 'The service returned no fixed methods; base-library and batch entries remain listed separately above.')}</p>
        </div>}

        {selectedOutsideFilter && <p className="tools-scope-note" role="status">{words('当前详情仍保留显示，但不在当前筛选结果中。', 'The current detail remains visible but is outside the filter results.')}</p>}

        {!selectedEntry && (loading || fixedLoading || selection.pending ? <p className="tools-loading" role="status"><Loader2 className="tools-spin" size={16} aria-hidden="true" />{words('正在读取算法目录…', 'Loading the algorithm catalog…')}</p>
          : !catalogsComplete && entries.length > 0 ? <p className="tools-muted">{words('请选择已读取的条目，或重新读取目录。', 'Select an available entry or refresh the catalog.')}</p>
          : <div className="tools-state-block"><p className="tools-empty-title">{words('当前没有可显示的算法条目。', 'No algorithm entries are available to show.')}</p>
            <p className="tools-muted">{words('基础库、固定计算与批量入口各自保留读取状态；未用本地旧数据补造条目。', 'Base-library, fixed and batch entries keep their own load states; no stale local entries are invented.')}</p></div>)}

        {selectedEntry?.entryClass === 'definition' && selectedTool && <>
          <div className="tools-tool-head algo-detail-head">
            <p className="tools-description">{selectedTool.definition?.summary ?? selectedTool.description}</p>
          </div>

          <section className="tools-section algo-layer" aria-labelledby="algo-definition">
            <div className="tools-section-head"><h4 id="algo-definition">{words('① 算法定义', '① Definition')}</h4>
              <span className="algo-layer-note">{words('公式、口径与输入输出；不含源码位置', 'Formula, semantics and I/O; no source paths')}</span></div>
            {selectedTool.definition ? <>
              <div className="algo-formula">
                {selectedTool.definition.formula.map((item) => <div className="algo-formula-line" key={item.output}>
                  <span className="algo-formula-output">{item.output}</span>
                  <code className="algo-formula-code">{item.expression}</code>
                  {item.note && <span className="algo-formula-note">{item.note}</span>}
                </div>)}
              </div>
              <dl className="algo-semantics">
                {selectedTool.definition.semantics.filter((item) => item.key !== 'missing').map((item) => <div key={item.key} data-state={item.state}>
                  <dt>{item.label}
                    {item.state === 'conflict' && <span className="algo-flag" data-state="conflict">{words('未统一', 'Unresolved')}</span>}
                    {item.state === 'unresolved' && <span className="algo-flag" data-state="unresolved">{words('未冻结', 'Not frozen')}</span>}</dt>
                  <dd>{item.value}</dd>
                </div>)}
              </dl>
              <dl className="tools-meta algo-meta">
                <div><dt>{words('参数', 'Parameters')}</dt><dd>{selectedTool.parameters.length
                  ? selectedTool.parameters.map((parameter) => `${parameter.label} · ${parameter.key}（${words('默认', 'default')} ${parameter.defaultValue}，${words('范围', 'range')} ${parameter.min}–${parameter.max}）`).join('；')
                  : words('无参数', 'None')}</dd></div>
                <div><dt>{words('输入字段', 'Inputs')}</dt><dd>{selectedTool.requiredInputs?.length
                  ? selectedTool.requiredInputs.join('、') : words('未登记', 'Not registered')}</dd></div>
                <div><dt>{words('输出字段', 'Outputs')}</dt><dd>{selectedTool.outputFields.length
                  ? selectedTool.outputFields.join('、') : words('未登记', 'Not registered')}</dd></div>
                <div><dt>{words('预热规则', 'Warm-up')}</dt><dd>{selectedTool.definition.warmup}</dd></div>
                <div><dt>{words('缺失处理', 'Missing values')}</dt><dd>{selectedTool.definition.missingPolicy}</dd></div>
              </dl>
              {selectedTool.limitations.length ? <ul className="tools-limits algo-limits">{selectedTool.limitations.map((text) => <li key={text}>{text}</li>)}</ul> : null}
              {selectedTool.definition.relation && <p className="tools-field-hint">{words('所属形态族', 'Pattern family')}：
                {selectedTool.definition.relation.note}</p>}
            </> : <p className="tools-muted">{words('该条目没有登记定义层信息；公式与口径仍以登记说明为准。',
              'No definition-layer record; the registration notes remain authoritative.')}</p>}
          </section>

          <section className="tools-section algo-layer" aria-labelledby="algo-config">
            <div className="tools-section-head"><h4 id="algo-config">{words('② 计算配置', '② Configuration')}</h4>
              <span className="algo-layer-note">{words('实现版本与参数组合；源码位置在开发诊断里', 'Implementation version and parameter sets; source paths live in diagnostics')}</span></div>
            {selectedTool.definition?.implementations.length
              ? <ul className="algo-impl">{selectedTool.definition.implementations.map((item) => <li key={item.id}>
                <div className="algo-impl-head">
                  <span className="algo-impl-id">{item.id}</span>
                  <span className="algo-impl-role" data-role={item.role}>{item.role === 'primary' ? words('主实现', 'Primary') : words('参考', 'Reference')}</span>
                  <span className="algo-impl-lang">{item.language}</span>
                  {item.version && <code className="algo-impl-version">{item.version}</code>}
                </div>
                {item.note && <p className="tools-field-hint">{item.note}</p>}
              </li>)}</ul>
              : <p className="tools-muted">{words('本工程没有可运行实现；接入前不构成可调用能力。', 'No runnable implementation in this project.')}</p>}
            {selectedTool.definition?.configurations.length ? <div className="algo-config-list">
              {selectedTool.definition.configurations.map((item) => <div className="algo-config" key={item.id}>
                <div className="algo-config-head"><strong>{item.label}</strong><code className="algo-config-id">{item.id}</code></div>
                <p className="algo-config-meta">{words('频率', 'Frequency')}：{item.frequency} · {words('参数', 'Parameters')}：{item.parameters}</p>
                {item.note && <p className="tools-field-hint">{item.note}</p>}
              </div>)}
            </div> : null}
          </section>

          <section className="tools-section algo-layer" aria-labelledby="algo-products">
            <div className="tools-section-head"><h4 id="algo-products">{words('③ 数据产品', '③ Data products')}</h4>
              <span className="algo-layer-note">{words('预计算产物；单独登记，不重复计入算法数量', 'Precomputed products; registered separately and not counted as algorithms')}</span></div>
            {selectedTool.definition?.products.length
              ? <div className="algo-products">{selectedTool.definition.products.map((item) => {
                const target = entries.find((entry) => entry.key === item.entryId);
                return <div className="algo-product" key={item.id}>
                  <div className="algo-product-head"><strong>{item.label}</strong>
                    <span className="algo-product-kind" data-kind={item.kind}>{item.kind === 'fixed' ? words('固定产品', 'Fixed') : words('批量产物', 'Batch')}</span></div>
                  <p className="algo-product-note">{item.note}</p>
                  <p className="tools-field-hint">{words('配置', 'Config')}：<code>{item.configurationId}</code> · {words('产品编号', 'Product')}：<code>{item.id}</code></p>
                  {target && <button type="button" className="text-button algo-product-open" onClick={() => setSelectedKey(target.key)}>
                    {words('打开产品详情', 'Open product')}<ArrowUpRight size={14} aria-hidden="true" /></button>}
                </div>;
              })}</div>
              : <p className="tools-muted">{words('该算法当前没有登记的数据产品；只有固定参数或批量执行方式时，才作为产品单独登记。',
                'No data products registered; products exist only where a fixed parameter set or batch route is registered.')}</p>}
            {relatedDesign.length > 0 && <>
              <p className="tools-field-hint tools-meta-sub">{words(
                `服务本算法的设计条目 ${relatedDesign.length} 条`, `${relatedDesign.length} design entries serve this algorithm`)}</p>
              <div className="algo-related">{relatedDesign.map((entry) => <button type="button" key={entry.key}
                className="algo-related-chip" onClick={() => setSelectedKey(entry.key)}>{entry.id} · {entry.title}</button>)}</div>
            </>}
          </section>

          <section className="tools-section tools-compute" aria-labelledby="tools-compute">
            <div className="tools-section-head"><h4 id="tools-compute">{words('固定基础算法接口', 'Fixed algorithm interface')}</h4>
              <span className="algo-layer-note">{words('只读展示；执行由 BD AGENTS 发起', 'Read-only; execution through BD AGENTS')}</span>
            </div>
            <p className="tools-description">{words(
              '固定算法从 WFD 正式快照读取，直接计算结构化新数据，独立核对后经 WFD 正式交接与固定读回。这里不提供人工计算、采用或发布按钮。',
              'Fixed algorithms read WFD snapshots, produce structured data, and publish through independent result verification and formal WFD readback. No manual execution, adoption or publishing controls here.'
            )}</p>
            {algorithmError && <p className="tools-muted">{algorithmError}</p>}
            {selectedMethod && <p className="tools-muted">{words('方法编号', 'Method ID')}: <code>{selectedMethod.id}</code> · {selectedMethod.status}
              {selectedMethod.reason && <span> · {selectedMethod.reason}</span>}</p>}
            <button type="button" className="text-button" disabled={!selectedTool || busy}
              onClick={() => { if (selectedTool) void result.loadLatest(selectedTool.id); }}>
              {words('读取当前算法最近结果', 'Read latest result for this algorithm')}</button>
            {result.loaded && !busy && !callView && !callError && <p className="tools-muted">
              {words('当前算法尚无任务结果。', 'No tasks are recorded for this algorithm.')}</p>}
            {callError && <ErrorNote detail={callError}>{words('算法结果读取失败。', 'Unable to read calculation result.')}</ErrorNote>}
          </section>

          {callView && <section className="tools-section tools-result" aria-labelledby="tools-result">
            <div className="tools-section-head"><h4 id="tools-result">{words('计算任务与结果', 'Computation task and result')}</h4>
              <span className="tools-status" data-status={callView.status === 'succeeded' ? 'ready' : callView.status === 'failed' || callView.status === 'cancelled' ? 'unavailable' : 'blocked'}>{taskStateText(callView.status, words)}</span>
            </div>
            <dl className="tools-meta">
              <div><dt>{words('任务编号', 'Task ID')}</dt><dd className="tools-mono">{callView.taskId}</dd></div>
              <div><dt>{words('请求编号', 'Request ID')}</dt><dd className="tools-mono">{callView.requestId}</dd></div>
              <div><dt>{words('方法', 'Method')}</dt><dd>{callView.methodId} · {callView.result?.methodVersion ?? '—'}</dd></div>
              <div><dt>{words('状态说明', 'Guidance')}</dt><dd>{callView.guidance ?? (callView.status === 'succeeded' ? words('结果已保管，可按原任务读回。', 'Result is stored and can be read back by the original task.') : '—')}</dd></div>
            </dl>
            {callView.error && <div className="tools-block" role="alert"><AlertTriangle size={18} aria-hidden="true" />
              <div><strong>{callView.error.code}</strong><p>{callView.error.message}</p></div></div>}
            {callView.result && <AlgorithmResult view={callView} words={words} />}
          </section>}

        </>}

        {selectedEntry?.kind === 'fixed' && selectedFixed && <FixedMethodDetail method={selectedFixed} headless
          configured={fixedCaps?.configured === true} reason={fixedCaps?.reason ?? null} words={words}
          {...(selectedEntry.parent ? { parent: selectedEntry.parent } : {})}
          onOpenEntry={onOpenEntry} onOpenDefinition={(registryId) => setSelectedKey(`library:${registryId}`)} />}

        {selectedEntry?.kind === 'batch' && selectedBatch && <BatchMethodDetail entry={selectedBatch} words={words} headless
          {...(selectedEntry.parent ? { parent: selectedEntry.parent } : {})}
          onOpenEntry={onOpenEntry} onOpenDefinition={(registryId) => setSelectedKey(`library:${registryId}`)} />}

        {selectedDesign?.design && <DesignEntryDetail entry={selectedDesign} words={words} headless
          related={entries.filter((entry) => selectedDesign.design?.related?.includes(entry.id))}
          onOpen={setSelectedKey} />}


      </div>
    </ObjectDetailPanel>
  </div>;
}

/** 开发与审计详情：默认折叠。源码路径、缺失项、旧编号映射与设计稿不进入普通阅读路径。 */
function DevDiagnostics({ tool, summary, words }: { tool: ToolLibraryTool; summary?: ToolLibraryDesignSummary; words: Words }) {
  const definition = tool.definition;
  const missing = tool.missing ?? [], sources = tool.sources ?? [], aliases = definition?.legacyAliases ?? [];
  const total = missing.length + sources.length + aliases.length;
  return <details className="tools-dev">
    <summary><span>{words('开发诊断（工程与审计）', 'Engineering diagnostics')}</span>
      <span className="tools-dev-count">{words(`${total} 项`, `${total} items`)}</span></summary>
    <div className="tools-dev-body">
      <p className="tools-design-note">{words('这一层不面向算法使用者：源码路径、缺失项、采用证据与修复设计稿只用于工程核对与审计。',
        'Not for algorithm users: source paths, gaps, adoption evidence and design notes are for engineering and audit only.')}</p>
      <dl className="tools-meta">
        <div><dt>{words('登记状态', 'Registration')}</dt><dd>{toolStateLabel(tool.state ?? 'not_implemented', words) ?? '—'}</dd></div>
        <div><dt>{words('登记编号', 'Registry ID')}</dt><dd className="tools-mono">{tool.id}</dd></div>
        <div><dt>{words('定义编号', 'Definition ID')}</dt><dd className="tools-mono">{definition?.id ?? '—'}</dd></div>
        <div><dt>{words('登记原因', 'Registration reason')}</dt><dd>{tool.reason ?? words('无', 'None')}</dd></div>
      </dl>
      {missing.length ? <>
        <p className="tools-field-hint tools-meta-sub">{words('缺失项', 'Missing items')}</p>
        <ul className="tools-limits">{missing.map((line) => <li key={line}>{line}</li>)}</ul>
      </> : null}
      {sources.length ? <>
        <p className="tools-field-hint tools-meta-sub">{words('源码与口径来源', 'Source and semantics references')}</p>
        <ul className="tools-limits">{sources.map((line) => <li key={line} className="tools-mono">{line}</li>)}</ul>
      </> : null}
      {definition?.implementations.length ? <>
        <p className="tools-field-hint tools-meta-sub">{words('实现位置', 'Implementation locations')}</p>
        <ul className="tools-limits">{definition.implementations.map((item) => <li key={item.id} className="tools-mono">{item.id} · {item.location}</li>)}</ul>
      </> : null}
      {aliases.length ? <>
        <p className="tools-field-hint tools-meta-sub">{words('旧登记别名与映射', 'Legacy aliases and mapping')}</p>
        <ul className="tools-limits">{aliases.map((item) => <li key={item.alias}><code>{item.alias}</code> → <code>{item.mapsTo}</code> · {item.note}</li>)}</ul>
      </> : null}
      <DesignSuggestion tool={tool} summary={summary} words={words} />
    </div>
  </details>;
}

/** 设计登记详情：预计算产品、制度产品与情绪方法共用；只读，不创建产品也不改算法状态。 */
function DesignEntryDetail({ entry, related, onOpen, words, headless }: {
  entry: CatalogEntry; related: CatalogEntry[]; onOpen(key: string): void; words: Words; headless?: boolean;
}) {
  const item = entry.design;
  if (!item) return null;
  const kindLabel = item.kind === 'product' ? words('预计算产品', 'Precomputed product')
    : item.kind === 'institutional' ? words('制度与披露产品', 'Institutional product')
      : item.kind === 'sentiment' ? words('情绪方法', 'Sentiment method') : words('设计附录', 'Design appendix');
  return <>
    <div className="tools-tool-head algo-detail-head">
      {!headless && <>
        <div className="tools-title-row">
          <h3 className="tools-title">{item.name}</h3>
          <span className="tools-source-tag" data-kind="design">{kindLabel}</span>
          <span className="tools-group-tag">{groupText(algorithmGroup(entry.group), words)}</span>
          <span className="tools-tool-id">{item.id}</span>
          <span className="tools-status">{words('设计登记', 'Design only')}</span>
        </div>
      </>}
      <p className="tools-description">{item.categoryLabel}</p>
      <p className="algo-product-banner">{words('这是规划里的设计登记，不是已创建的产品或已接入的数据；不改变任何算法状态、白名单或发布资格。',
        'A design record from the plan, not a created product or connected data; it changes no algorithm state, allowlist or publication.')}</p>
    </div>
    <section className="tools-section algo-layer" aria-labelledby="design-definition">
      <div className="tools-section-head"><h4 id="design-definition">{words('① 定义与口径', '① Definition')}</h4></div>
      <dl className="tools-meta">
        <div><dt>{words('覆盖', 'Coverage')}</dt><dd>{item.coverage || '—'}</dd></div>
        <div><dt>{words('输入', 'Inputs')}</dt><dd>{item.inputs || '—'}</dd></div>
        <div className="algo-wide"><dt>{words('计算与口径', 'Calculation')}</dt><dd>{item.calculation || '—'}</dd></div>
      </dl>
      {item.body && <pre className="algo-note-text algo-design-body">{item.body}</pre>}
    </section>
    <section className="tools-section algo-layer" aria-labelledby="design-gate">
      <div className="tools-section-head"><h4 id="design-gate">{words('② 触发与准入门槛', '② Trigger and gate')}</h4></div>
      <dl className="tools-meta">
        <div><dt>{words('触发', 'Trigger')}</dt><dd>{item.trigger || '—'}</dd></div>
        <div><dt>{words('准入门槛', 'Gate')}</dt><dd>{item.gate || '—'}</dd></div>
      </dl>
    </section>
    <section className="tools-section algo-layer" aria-labelledby="design-owner">
      <div className="tools-section-head"><h4 id="design-owner">{words('③ 归属与证据', '③ Ownership and evidence')}</h4></div>
      <dl className="tools-meta">
        <div><dt>{words('职责', 'Ownership')}</dt><dd>{item.owner || '—'}</dd></div>
        <div className="algo-wide"><dt>{words('出处与证据', 'Evidence')}</dt><dd>{item.evidence || '—'}</dd></div>
      </dl>
      {item.links?.length ? <p className="algo-links">{item.links.map((link) => <a key={link.url} href={link.url}
        target="_blank" rel="noreferrer noopener">{link.name}</a>)}</p> : null}
    </section>
    {related.length > 0 && <section className="tools-section algo-layer" aria-labelledby="design-related">
      <div className="tools-section-head"><h4 id="design-related">{words('④ 关联算法与条目', '④ Related algorithms and entries')}</h4>
        <span className="algo-layer-note">{words('本条目服务的对象', 'What this entry serves')}</span></div>
      <div className="algo-related">{related.map((target) => <button type="button" key={target.key}
        className="algo-related-chip" onClick={() => onOpen(target.key)}>{target.id} · {target.title}</button>)}</div>
    </section>}
  </>;
}

/** 逐条处置建议：只读展示 V1.0 规划的原文，不改变上方登记状态或下方计算表单。 */
function DesignSuggestion({ tool, summary, words }: {
  tool: ToolLibraryTool; summary?: ToolLibraryDesignSummary; words: Words;
}) {
  const design = tool.design;
  const keys: string[] = design && isStringList(design.rulingKeys) ? design.rulingKeys : [];
  const allRulings = Array.isArray(summary?.rulings) ? summary?.rulings ?? [] : [];
  const linked = keys.length ? allRulings.filter((ruling) => keys.includes(ruling.conflict)) : [];
  return <section className="tools-section tools-design" aria-labelledby="tools-design">
    <div className="tools-section-head"><h4 id="tools-design">{words('处置建议 · 设计稿（未验收）', 'Disposition proposal · draft, unverified')}</h4>
      <span className="tools-design-badge">{words('只读设计建议', 'Read-only design note')}</span></div>
    <p className="tools-design-note">{words('来自 2026-11-06《BD 算法处置与 A 股数据产品 V1.0》及来源矩阵，按原件逐字展示。这是设计建议，不是采用回执；不改变登记状态、受控白名单、固定方法表或发布资格，也不能代替独立金样与逐项验收。',
      'Verbatim from the 2026-11-06 V1.0 design and source matrix. A proposal, not an adoption receipt; it changes no registration state, controlled whitelist, fixed method table or publication eligibility and does not replace independent acceptance.')}</p>
    {!design ? <p className="tools-muted">{words('这项没有对应的设计处置建议；原登记状态与缺项仍以上方为准。',
      'No design proposal for this entry; the registration state and gaps above remain authoritative.')}</p> : <>
      <dl className="tools-meta">
        <div><dt>{words('建议职责归属', 'Proposed owner')}</dt><dd>{design.proposedOwner}</dd></div>
        <div><dt>{words('关联设计产品', 'Related proposed products')}</dt><dd className="tools-mono">{design.relatedProducts.length ? design.relatedProducts.join(' · ') : '—'}</dd></div>
        <div><dt>{words('原件定位线索', 'Source location cue')}</dt><dd>{design.sourceRef}</dd></div>
      </dl>
      <p className="tools-field-hint tools-meta-sub">{words('拟采用口径（原文）', 'Proposed method (verbatim)')}</p>
      <p className="tools-design-text">{design.proposedMethod}</p>
      <p className="tools-field-hint tools-meta-sub">{words('独立验收建议（未运行）', 'Proposed acceptance (not executed)')}</p>
      <p className="tools-design-text">{design.proposedAcceptance}</p>
      {linked.length > 0 && <>
        <p className="tools-field-hint tools-meta-sub">{words('关联的同名口径裁决', 'Linked homonym rulings')}</p>
        <ul className="tools-limits">{linked.map((ruling) => <li key={ruling.conflict}>
          <strong>{ruling.conflict}</strong> · {ruling.proposal} <span className="tools-meta-sub">{ruling.validation}</span>
        </li>)}</ul>
      </>}
    </>}
  </section>;
}

/** 全局设计依据：默认折叠，展开只读取目录请求里已有的 design 摘要，不额外请求。 */
function DesignLedger({ summary, words }: { summary: ToolLibraryDesignSummary; words: Words }) {
  const rulings = Array.isArray(summary.rulings) ? summary.rulings : [];
  const excluded = Array.isArray(summary.excludedExternal) ? summary.excludedExternal : [];
  const blockers = Array.isArray(summary.externalBlockers) ? summary.externalBlockers : [];
  const order = Array.isArray(summary.implementationOrder) ? summary.implementationOrder : [];
  return <details className="tools-design-ledger">
    <summary><span>{words('设计依据与处置台账 · V1.0 设计稿（未验收）', 'Design basis and dispositions · V1.0 draft, unverified')}</span>
      <span className="tools-design-ledger-count">{rulings.length} / {excluded.length} / {blockers.length}</span></summary>
    <div className="tools-design-ledger-body">
      <p className="tools-design-note">{summary.statusNote}</p>
      <p className="tools-design-note">{words('下列均为规划原文的设计建议：六项同名口径裁决、四项外部不采用、九项工程阻断。它们不是缺陷修复回执，也不解除任何登记阻断。',
        'All verbatim from the design: six homonym rulings, four excluded external items and nine engineering blockers. They are not fix receipts and do not clear any registration block.')}</p>
      <h5>{words('六项同名口径的兼容裁决', 'Six homonym rulings')}</h5>
      <div className="tools-design-table-wrap"><table className="tools-design-table">
        <thead><tr><th>{words('冲突', 'Conflict')}</th><th>{words('建议固定的标识或换算', 'Proposed identity or conversion')}</th><th>{words('兼容验证', 'Compatibility check')}</th></tr></thead>
        <tbody>{rulings.map((item) => <tr key={item.conflict}><td>{item.conflict}</td><td>{item.proposal}</td><td>{item.validation}</td></tr>)}</tbody>
      </table></div>
      <h5>{words('不采用的外部包项与准入路线', 'Excluded external items and entry route')}</h5>
      <div className="tools-design-table-wrap"><table className="tools-design-table">
        <thead><tr><th>{words('项', 'Item')}</th><th>{words('缺陷', 'Defect')}</th><th>{words('后续可证伪的做法', 'Falsifiable follow-up')}</th></tr></thead>
        <tbody>{excluded.map((item) => <tr key={item.item}><td>{item.item}</td><td>{item.finding}</td><td>{item.followUp}</td></tr>)}</tbody>
      </table></div>
      <h5>{words('外部参考资产与真实工程阻断', 'External references and real engineering blockers')}</h5>
      <div className="tools-design-table-wrap"><table className="tools-design-table">
        <thead><tr><th>{words('定位', 'Location')}</th><th>{words('真实证据', 'Evidence')}</th><th>{words('处置与退出条件', 'Disposition and exit condition')}</th></tr></thead>
        <tbody>{blockers.map((item) => <tr key={item.item}><td>{item.item}</td><td>{item.finding}</td><td>{item.followUp}</td></tr>)}</tbody>
      </table></div>
      <h5>{words('建议执行顺序', 'Proposed execution order')}</h5>
      <ol className="tools-design-list">{order.map((line, index) => <li key={index}>{line}</li>)}</ol>
    </div>
  </details>;
}

function FixedMethodDetail({ method, configured, reason, words, parent, headless, onOpenEntry, onOpenDefinition }: {
  method: FixedCalculationCapabilities['methods'][number]; configured: boolean; reason: string | null;
  words: Words; parent?: AlgorithmDefinition; headless?: boolean; onOpenEntry(request: AlgorithmFocusRequest): void;
  onOpenDefinition(registryId: string): void;
}) {
  return <>
    <div className="tools-tool-head algo-detail-head">
      {!headless && <>
        <div className="tools-title-row">
          <h3 className="tools-title">{method.title}</h3>
          <span className="tools-source-tag" data-kind="fixed">{words('数据产品', 'Data product')}</span>
          <span className="tools-group-tag">{words('固定计算', 'Fixed calculation')}</span>
          <span className="tools-tool-id">{method.id}</span>
          <span className="tools-status" data-status={configured ? 'ready' : 'blocked'}>{configured ? words('入口已装配', 'Configured') : words('入口未装配', 'Not configured')}</span>
        </div>
      </>}
      <p className="tools-description">{method.description}</p>
      <p className="algo-product-banner">{words('这是数据产品与执行配置，不是独立算法定义。它共用父算法的公式，只固定参数、频率与产物边界。',
        'This is a data product and execution configuration, not a standalone algorithm definition. It shares the parent formula and only fixes parameters, frequency and product boundary.')}</p>
      {parent && <button type="button" className="text-button algo-product-open" onClick={() => onOpenDefinition(parent.registryId)}>
        {words(`返回算法定义：${parent.title}`, `Open definition: ${parent.title}`)}<ArrowUpRight size={14} aria-hidden="true" /></button>}
    </div>
    <section className="tools-section algo-layer" aria-labelledby="fixed-product-def">
      <div className="tools-section-head"><h4 id="fixed-product-def">{words('产品定义', 'Product definition')}</h4></div>
      <dl className="tools-meta">
        <div><dt>{words('默认实现', 'Default implementation')}</dt><dd>{method.defaultImplementation}</dd></div>
        <div><dt>{words('输入类型', 'Input type')}</dt><dd>{fixedInputText(method.input, words)}</dd></div>
        <div><dt>{words('计算范围', 'Scope')}</dt><dd>{method.scope}</dd></div>
        <div><dt>{words('发布资格', 'Publication')}</dt><dd>{words('候选（candidate_only）', 'Candidate only')}
          <span className="tools-meta-sub">{words('产品结果不因计算成功自动发布。', 'A successful computation does not publish the product.')}</span></dd></div>
      </dl>
    </section>
    <section className="tools-section algo-layer" aria-labelledby="fixed-product-entry">
      <div className="tools-section-head"><h4 id="fixed-product-entry">{words('原入口', 'Original entry')}</h4></div>
      <p className="tools-description">{words('这是数据库 R1 面板中的固定计算链，使用实际固定记录与快照。本页只帮助定位；跳转后仍需手动载入实际输入、核对来源与口径并明确确认，结果仍为候选。',
        'This is the fixed-calculation chain in the Database R1 panel, using actual fixed records and snapshots. This page only helps locate it; after opening, load the actual inputs, verify source and semantics, and confirm explicitly. Results remain candidates.')}</p>
      <div className="tools-entry-actions">
        <button type="button" className="primary-button tools-open-entry" onClick={() => onOpenEntry({ kind: 'fixed', methodId: method.id })}>
          <ArrowUpRight size={16} aria-hidden="true" />{words('前往数据库固定计算', 'Open fixed calculation in Database')}
        </button>
        <p className="tools-field-hint">{words('跳转会定位并选中此方法，不会读取业务数据、创建任务或执行计算。', 'The jump positions and selects this method; it does not read business data, create tasks or run calculations.')}</p>
      </div>
    </section>
    <details className="tools-dev">
      <summary><span>{words('开发诊断（工程与审计）', 'Engineering diagnostics')}</span></summary>
      <div className="tools-dev-body">
        <dl className="tools-meta">
          <div><dt>{words('入口状态', 'Entry state')}</dt><dd>{configured ? words('已装配', 'Configured') : words('未装配', 'Not configured')}</dd></div>
          <div><dt>{words('入口原因', 'Entry reason')}</dt><dd>{reason ?? words('无', 'None')}</dd></div>
          <div><dt>{words('产品编号', 'Product ID')}</dt><dd className="tools-mono">{method.id}</dd></div>
          {parent && <div><dt>{words('父算法', 'Parent algorithm')}</dt><dd className="tools-mono">{parent.id}</dd></div>}
        </dl>
      </div>
    </details>
  </>;
}

function BatchMethodDetail({ entry, words, parent, headless, onOpenEntry, onOpenDefinition }: {
  entry: BatchAlgorithmEntry; words: Words; parent?: AlgorithmDefinition; headless?: boolean;
  onOpenEntry(request: AlgorithmFocusRequest): void; onOpenDefinition(registryId: string): void;
}) {
  return <>
    <div className="tools-tool-head algo-detail-head">
      {!headless && <>
        <div className="tools-title-row">
          <h3 className="tools-title">{words(entry.zh, entry.en)}</h3>
          <span className="tools-source-tag" data-kind="batch">{words('数据产品', 'Data product')}</span>
          <span className="tools-group-tag">{words('批量自动计算', 'Batch calculation')}</span>
          <span className="tools-tool-id">{entry.id}</span>
          <span className="tools-status">{words('原批次入口', 'Original batch entry')}</span>
        </div>
      </>}
      <p className="tools-description">{words(entry.zhDescription, entry.enDescription)}</p>
      <p className="algo-product-banner">{words('这是批量执行配置与产物，不是独立算法定义。它按批次冻结的来源与周期产出均线系列，与基础库单次计算不合并。',
        'This is a batch execution configuration and product, not a standalone algorithm definition. It publishes mean series under the batch’s frozen sources and periods, never merged with a single base-library run.')}</p>
      {parent && <button type="button" className="text-button algo-product-open" onClick={() => onOpenDefinition(parent.registryId)}>
        {words(`返回算法定义：${parent.title}`, `Open definition: ${parent.title}`)}<ArrowUpRight size={14} aria-hidden="true" /></button>}
    </div>
    <section className="tools-section algo-layer" aria-labelledby="batch-method-boundary">
      <div className="tools-section-head"><h4 id="batch-method-boundary">{words('产品定义与执行边界', 'Product definition and boundary')}</h4></div>
      <dl className="tools-meta">
        <div><dt>{words('原件内容分类', 'Original content kind')}</dt><dd>{words(entry.zhKind, entry.enKind)}
          <span className="tools-meta-sub">{words('这是原批次的内容分类，不是用途分类。', 'This is the original batch’s content kind, not a purpose category.')}</span></dd></div>
        <div><dt>{words('周期来源', 'Period source')}</dt><dd>{words(entry.zhPeriod, entry.enPeriod)}
          <span className="tools-meta-sub">{words('每个批次使用开始前已保存的对应周期。', 'Each batch uses the matching period saved before it starts.')}</span></dd></div>
        <div><dt>{words('输入', 'Inputs')}</dt><dd>{words('本批明确授权并逐件核对的原报；来源、用途、数据集和日期口径随批次冻结。', 'Originals explicitly authorized and checked for this batch; source, purpose, dataset and date policy are frozen with the batch.')}</dd></div>
        <div><dt>{words('结果', 'Result')}</dt><dd>{words('按批次单独发布的派生均线；与基础库 MA、固定 20 期观测均值的实现、输入、参数和结果边界都不同，不能合并成同一次执行。', 'A derived mean published separately per batch. Its implementation, inputs, parameters and result boundary differ from base-library MA and the fixed 20-observation mean; the chains are never merged.')}</dd></div>
      </dl>
    </section>
    <section className="tools-section algo-layer" aria-labelledby="batch-method-entry">
      <div className="tools-section-head"><h4 id="batch-method-entry">{words('原入口', 'Original entry')}</h4></div>
      <p className="tools-description">{words('批量自动计算在数据库 R1 面板中运行：先选择原文件、声明本批用途与授权，再按保存的周期和内容分类执行。本页只帮助定位，不读取或改写批次、周期与去重结果。',
        'Batch automatic calculation runs in the Database R1 panel: select originals, declare this batch’s purpose and authorization, then run under the saved periods and content kinds. This page only helps locate it and never reads or changes batches, periods or duplicate results.')}</p>
      <div className="tools-entry-actions">
        <button type="button" className="primary-button tools-open-entry" onClick={() => onOpenEntry({ kind: 'batch', methodId: entry.id })}>
          <ArrowUpRight size={16} aria-hidden="true" />{words('前往数据库批量自动计算', 'Open batch calculation in Database')}
        </button>
        <p className="tools-field-hint">{words('跳转会定位到批量面板并展开对应周期；不会自动读取批次、保存周期或开始交接。', 'The jump positions the batch panel and opens its matching period field; it does not read batches, save periods or start a handoff.')}</p>
      </div>
    </section>
    <details className="tools-dev">
      <summary><span>{words('开发诊断（工程与审计）', 'Engineering diagnostics')}</span></summary>
      <div className="tools-dev-body">
        <dl className="tools-meta">
          <div><dt>{words('批次编号', 'Batch ID')}</dt><dd className="tools-mono">{entry.id}</dd></div>
          {parent && <div><dt>{words('父算法', 'Parent algorithm')}</dt><dd className="tools-mono">{parent.id}</dd></div>}
        </dl>
        <p className="tools-field-hint">{words('本页不读取批次状态、周期设置或去重结果；实际执行与发布在数据库 R1 面板完成。',
          'This page reads no batch state, period setting or duplicate result; execution and publication happen in the Database R1 panel.')}</p>
      </div>
    </details>
  </>;
}

function AlgorithmResult({ view, words }: { view: AlgorithmTaskView; words: Words }) {
  const result = view.result!;
  const fields = result.methodId === 'macd' ? ['DIFF', 'DEA', 'MACD', 'ZERO'] : result.methodId === 'ma' ? ['MA'] : ['bullish_engulfing'];
  const rows = result.rows.slice(0, 100);
  return <div className="tools-result-body">
    <div className="tools-result-summary">
      <div><span>{words('输入', 'Input')}</span><strong>{sourceLabel(result.source)}</strong><small>{result.coverage.windowStart} – {result.coverage.windowEnd} · {result.coverage.suppliedRows} {words('行', 'rows')}</small></div>
      <div><span>{words('输入摘要', 'Input digest')}</span><strong className="tools-mono">{shortDigest(result.inputDigest)}</strong><small>{words('封闭输入与结果分开保管', 'Sealed input and result are stored separately')}</small></div>
      <div><span>{words('有效区间', 'Valid interval')}</span><strong>{result.validInterval ? `${result.validInterval.start} – ${result.validInterval.end}` : words('无', 'None')}</strong><small>{words('预热空值', 'Leading warm-up')}: {result.coverage.leadingInvalidRows}</small></div>
      <div><span>{words('发布', 'Publication')}</span><strong>{words('未请求', 'Not requested')}</strong><small>{words('结果保留在原任务；新计算与发布请使用数据库的固定计算及 R1 结构化交接入口', 'The result stays with its original task; use the database fixed computation and R1 structured handoff for new computation and publication')}</small></div>
    </div>
    {result.gaps.length > 0 && <div className="tools-gaps"><strong>{words('范围与缺口', 'Scope and gaps')}</strong>
      <ul>{result.gaps.map((gap) => <li key={`${gap.code}-${gap.scope ?? ''}`}><code>{gap.code}</code><span>{gap.message}</span></li>)}</ul></div>}
    <div className="tools-table-wrap"><table className="tools-result-table">
      <thead><tr><th>{words('日期', 'Date')}</th>{fields.map((field) => <th key={field}>{field}</th>)}<th>{words('可得时刻', 'Available at')}</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.timestamp}><td>{row.timestamp}</td>{fields.map((field) => <td key={field} data-null={row[field] === null ? 'true' : undefined}>{displayCell(row[field], words)}</td>)}<td className="tools-mono">{row.available_at}</td></tr>)}</tbody>
    </table></div>
    {result.rows.length > rows.length && <p className="tools-field-hint">{words(`仅显示前 ${rows.length} 行；完整 ${result.rows.length} 行已按任务结果保管。`, `Showing the first ${rows.length} of ${result.rows.length} stored rows.`)}</p>}
    <div className="tools-result-foot">
      <span>{words('实现版本', 'Implementation')}: <code>{shortDigest(result.implementationVersion)}</code></span>
      <span>{words('诊断', 'Diagnostics')}: {Array.isArray(result.diagnostics) ? result.diagnostics.length : 0}</span>
      <span>{words('结果状态', 'Result state')}: {result.status} · {result.persistence}</span>
    </div>
    <ul className="tools-limits">{result.limitations.map((line) => <li key={line}>{line}</li>)}</ul>
    <p className="tools-field-hint"><CheckCircle2 size={14} aria-hidden="true" /> {words('数值、规则命中、任务成功、结果保管与数据库发布分别认定；本面板不把计算成功当作入库成功。',
      'Numbers, rule hits, task success, custody and database publication are separate facts; this panel never treats computation as publication.')}</p>
  </div>;
}

export default ToolsPage;
