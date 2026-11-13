import { R1DuplicateResult } from './R1DuplicateResult';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react';
import type { R1CapabilitiesView, R1Mapping, R1PrepareInput, R1RequestSummary, R1RequestView, R1ScalarMapping, R1SourceDeclaration, R1TabularMapping, R1TimeMapping } from '../../../../contracts/r1-contracts';
import type { MaterialCategory, MaterialEnvelope, MaterialRecord } from '../../../../modules/collection/materials/contracts';
import type { XlsxColumnType, XlsxTableSelection } from '../../../../modules/collection/data-processing/xlsx-table';
import { r1SourceGaps, r1SourceReadyForHandoff, validR1Authorization, type R1SourceAuthorization } from '../../../../modules/collection/r1-source';
import type { BdJob } from '../bd-api';
import { dataBrowserApi } from '../data-browser-api';
import { r1Api, type R1XlsxPreview } from '../r1-api';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { R1AutoPanel } from './R1AutoPanel';
import { DocumentProcessingPanel } from './DocumentProcessingPanel';
import { CloudCustodyPanel } from './CloudCustodyPanel';
import { StructuredQueryPanel } from './StructuredQueryPanel';
import { R1ReadPanel } from './R1ReadPanel';
import './R1Panel.css';

const newId = (kind: string) => `web-r1-${kind}-${crypto.randomUUID()}`;
const dimensions = [ ['role', '材料角色', 'Material role'], ['informationNature', '信息性质', 'Information nature'],
  ['businessObject', '业务对象', 'Business object'], ['objectTime', '对象与时间', 'Object and time'],
  ['purpose', '使用目的', 'Purpose'], ['structureGranularity', '结构与粒度', 'Structure and granularity'] ] as const;
const sourceFields = [ ['source_id', '来源身份', 'Source ID'], ['provider', '提供者', 'Provider'],
  ['requested_url', '原始地址或 URI', 'Original URL / URI'], ['requested_at_utc', '请求时间（UTC）', 'Requested at (UTC)'],
  ['acquired_at_utc', '取得时间（UTC）', 'Acquired at (UTC)'], ['usage_scope', '获准用途', 'Permitted usage'] ] as const;
const scalarFields = [ ['businessKey', '业务键列', 'Business-key column'], ['value', '十进制值列', 'Decimal-value column'],
  ['earliestUtc', '时间起点列（UTC）', 'Start-time column (UTC)'], ['latestExclusiveUtc', '时间开区间终点列（UTC）', 'Exclusive end-time column (UTC)'],
  ['sourceTimezone', '来源时区', 'Source timezone'] ] as const;
const tabularFields = [ ['businessKey', '业务键列', 'Business-key column'],
  ['earliestUtc', '时间起点列（UTC）', 'Start-time column (UTC)'], ['latestExclusiveUtc', '时间开区间终点列（UTC）', 'Exclusive end-time column (UTC)'],
  ['sourceTimezone', '来源时区', 'Source timezone'] ] as const;
const barRoles = [ ['open', '开盘价', 'Open'], ['high', '最高价', 'High'], ['low', '最低价', 'Low'],
  ['close', '收盘价', 'Close'], ['volume', '成交量', 'Volume'] ] as const;
const barRoleKeys = [...barRoles.map(([role]) => role), 'amount'] as const;
type R1Authorization = R1SourceAuthorization;
type R1SourceEditor = R1SourceDeclaration & { authorization: R1Authorization };
const unknownAuthorization = (): R1Authorization => ({ status: 'unknown', basis: null });
const emptySource = (): R1SourceEditor => ({ source_id: '', provider: '', requested_url: '', requested_at_utc: '', acquired_at_utc: '', usage_scope: '', authorization: unknownAuthorization() });
const emptyScalarMapping = (): R1ScalarMapping => ({ businessKey: '', value: '', earliestUtc: '', latestExclusiveUtc: '', precision: 'day', sourceTimezone: '' });
const emptyTabularMapping = (): R1TabularMapping => ({ kind: 'tabular_rows', businessKey: '',
  earliestUtc: '', latestExclusiveUtc: '', precision: 'day', sourceTimezone: '', fields: [] });
const targetTemplate = JSON.stringify({ datasetId: '', outputKey: '', expectedParentSnapshotId: null,
  subject: { kind: '', namespace: '', id: '' }, definition: { semantic_code: '', measurement_nature: '', unit_code: '',
    definition_authority: '', time_role: '', semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: '',
      time: { period_type: '', frequency: '', interval: '' }, statistical: { price_basis: '', period_aggregation: '' } } },
  inputMode: 'partial_observation', coverage: { scope: {}, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } }, null, 2);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const objectOrNull = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
function readAuthorization(value: unknown): R1Authorization {
  return validR1Authorization(value) ? value : unknownAuthorization();
}
function frozenSource(view: R1RequestView): Record<string, unknown> {
  const refs = record(record(view.local).local_refs).sourceRefs;
  return Array.isArray(refs) ? record(refs[0]) : {};
}
const states: Record<string, string> = { prepared_profile_pending: '已准备，待人工确认', associated: '已接收记录已固定读回并回链', partially_associated: '无冲突记录已处理，冲突待确认', conflicts_pending: '冲突待确认，未自动覆盖', rejected: 'WFD 实际拒绝', pending_unknown: '提交结果未知，须核对原请求',
  pending_receipt: '回执待核对', sending: '提交中', send_failed: '明确未发送成功', pending_wfd_profile: '连接 profile 不可用' };

type TableFormat = 'csv' | 'json' | 'xlsx';
const xlsxTypes = new Set(['string', 'decimal_string', 'safe_integer', 'boolean']);
function excelColumnNumber(value: string): number {
  if (!/^[A-Z]{1,3}$/u.test(value)) return 0;
  return [...value].reduce((number, character) => number * 26 + character.charCodeAt(0) - 64, 0);
}
function readXlsxSelection(input: { sheetName: string; headerRow: string; firstDataRow: string; lastDataRow: string;
  firstColumn: string; lastColumn: string; columns: string }): XlsxTableSelection {
  const sheetName = input.sheetName, headerRow = Number(input.headerRow), firstDataRow = Number(input.firstDataRow), lastDataRow = Number(input.lastDataRow);
  const firstColumn = input.firstColumn.trim().toUpperCase(), lastColumn = input.lastColumn.trim().toUpperCase();
  const first = excelColumnNumber(firstColumn), last = excelColumnNumber(lastColumn);
  if (!sheetName.trim() || !Number.isSafeInteger(headerRow) || headerRow < 1 || !Number.isSafeInteger(firstDataRow) || firstDataRow <= headerRow
    || !Number.isSafeInteger(lastDataRow) || lastDataRow < firstDataRow || lastDataRow - firstDataRow + 1 > 5000
    || !first || last < first) throw new Error('请明确 XLSX 工作表、1 基表头/数据行及字母列范围；最多选择 5000 行。BD 未建立计划。');
  let raw: unknown;
  try { raw = JSON.parse(input.columns); } catch { throw new Error('XLSX 列映射不是有效 JSON，BD 未建立计划。'); }
  if (!Array.isArray(raw) || !raw.length || raw.length !== last - first + 1) throw new Error('XLSX 列映射须逐列覆盖所选范围，不能漏列、补列；BD 未建立计划。');
  const columns = raw.map(item => {
    const column = objectOrNull(item), letter = text(column?.column).trim().toUpperCase(), header = text(column?.header), name = text(column?.name).trim();
    const type = column?.type;
    if (!column || !excelColumnNumber(letter) || !header.trim() || !name || !(type === undefined || typeof type === 'string' && xlsxTypes.has(type))) {
      throw new Error('XLSX 每列须明确字母列、原表头与输出名；类型只能是 string/decimal_string/safe_integer/boolean 或省略。BD 未建立计划。');
    }
    return { column: letter, header, name, ...(type === undefined ? {} : { type: type as XlsxColumnType }) };
  });
  if (columns.some((column, index) => excelColumnNumber(column.column) !== first + index) || new Set(columns.map(column => column.name)).size !== columns.length) {
    throw new Error('XLSX 列映射必须按所选范围顺序逐列填写，输出名不得重复；BD 未建立计划。');
  }
  return { sheetName, headerRow, firstDataRow, lastDataRow, firstColumn, lastColumn, columns };
}
const previewFormat: Record<TableFormat, string> = { csv: 'csv', json: 'json-table', xlsx: 'excel' };
const previewBudgetIssues = new Set(['MATERIAL_BYTE_BUDGET', 'MATERIAL_CHARACTER_BUDGET', 'ROW_BUDGET', 'COLUMN_BUDGET', 'CELL_BUDGET']);
const emptyXlsxDraft = () => ({ sheetName: '', headerRow: '', firstDataRow: '', lastDataRow: '', firstColumn: '', lastColumn: '', columns: '[]' });
function materialTableIssue(material: MaterialRecord, format: TableFormat, selectedCsvRows: boolean): string | null {
  const { envelope, preview } = material;
  if (envelope.category === 'tool' || preview.category === 'tool') return '这份原件按代码或工具材料保管；BD 已保存原件，当前 R1 表格发布路径不接收工具。';
  if (preview.format !== previewFormat[format]) return `原件识别格式为 ${preview.format}，与所选 ${format} 表源不一致；BD 未送出表格计划。`;
  if (format === 'xlsx') return /\.xlsx$/iu.test(envelope.filename) ? null : '当前选区入口只承接 .xlsx 工作簿；BD 未送出表格计划。';
  if (preview.support !== 'supported') return `${preview.reason} BD 未送出表格计划。`;
  const budgetOnly = preview.checks.issues.length > 0 && preview.checks.issues.every(issue => previewBudgetIssues.has(issue.code));
  if (preview.checks.status === 'blocked') {
    if (!(budgetOnly && (format === 'json' || selectedCsvRows))) return `${preview.checks.issues.map(issue => issue.message).join('；') || '原件预览核对受阻'}；BD 未送出表格计划。`;
  }
  if (format === 'json' && !preview.table && preview.text) {
    try { if (!Array.isArray(JSON.parse(preview.text.original))) return 'JSON 原件根部不是行对象数组，现有表格解析器不支持；BD 未送出表格计划。'; }
    catch { return 'JSON 原件无法解析为完整行数组；BD 未送出表格计划。'; }
  }
  if (!preview.table && !preview.text && !budgetOnly) return '原件尚未形成可核对的表格预览；BD 未送出表格计划。';
  return null;
}

type RowMode = 'scalar' | 'table' | 'day' | 'minute';
type BarMapping = NonNullable<R1TabularMapping['bar']>;
type OperatorConstant = string | number | boolean | null;
interface TargetFieldDefinition { code: string; dataType: string; unitCode: string }
type SemanticQuality = 'pending' | 'pass' | 'fail' | 'indeterminate';
interface SemanticProof { quality: SemanticQuality; ruleVersion: string; ruleDigest: string; checkScope: string[]; gaps: string[];
  coverage: { inputRows: number | null; checkedRows: number | null; complete: boolean } }
const proofLabels: Record<SemanticQuality, string> = { pending: '尚未执行', pass: '已列规则通过', fail: '未通过', indeterminate: '无法判定' };
const checkScopeLabels: Record<string, string> = {
  explicit_contract_fields: '合同字段与映射集合', effective_field_measurement: '逐字段有效计量口径',
  explicit_coverage_declaration: '覆盖声明是否明确', general_tabular_semantics: '普通表格语义声明',
  declared_market_bar_semantics: '已声明行情角色语义', unique_business_keys: '业务键唯一性',
  explicit_utc_intervals: '明确的 UTC（协调世界时）区间', explicit_value_states: '逐字段显式值状态',
  exact_decimal_ohlc: '完整开高低收十进制关系', partial_decimal_price_bounds: '可比较的部分价格上下界关系',
  positive_declared_market_prices: '已声明价格为正值', nonnegative_volume_amount: '已声明成交量或成交额非负',
  bar_closed_by_acquisition: '行情区间在取得时已结束', operator_source_declaration_binding: '操作者来源声明与计划绑定',
  source_acquisition_time_order: '请求与取得时间顺序',
  operator_declared_usage_and_handoff_authorization: '操作者声明的用途与本次交接授权',
  financial_record_role_adoption: '金融记录角色采用声明', direct_observation_nature_adoption: '直接观测性质采用声明',
};

/** Read only the contract field list that the operator has already written into the target. */
function readTargetFields(value: string): { fields: TargetFieldDefinition[]; error: string | null } {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return { fields: [], error: '目标合同 JSON 尚未完成。' }; }
  const root = objectOrNull(parsed), definition = objectOrNull(root?.definition), list = definition?.field_definitions;
  if (!Array.isArray(list) || !list.length) return { fields: [], error: '目标合同还没有 definition.field_definitions；请先补全合同字段。' };
  const fields: TargetFieldDefinition[] = [];
  for (const item of list) {
    const field = objectOrNull(item), code = text(field?.field_code).trim();
    if (!field || !code) return { fields: [], error: 'field_definitions 中有字段缺少 field_code。' };
    fields.push({ code, dataType: text(field.data_type), unitCode: text(field.unit_code) });
  }
  if (new Set(fields.map(field => field.code)).size !== fields.length) return { fields: [], error: 'field_definitions 的 field_code 重复。' };
  return { fields, error: null };
}

function readTimeMapping(value: unknown): R1TimeMapping | null {
  const raw = objectOrNull(value); if (!raw) return null;
  const { earliestUtc, latestExclusiveUtc, precision, sourceTimezone } = raw;
  if (typeof earliestUtc !== 'string' || typeof latestExclusiveUtc !== 'string' || typeof sourceTimezone !== 'string') return null;
  if (precision !== 'day' && precision !== 'minute' && precision !== 'second') return null;
  return { earliestUtc, latestExclusiveUtc, precision, sourceTimezone };
}

function readScalarMapping(value: unknown): R1ScalarMapping | null {
  const raw = objectOrNull(value); if (!raw || raw.kind !== undefined) return null;
  const time = readTimeMapping(raw); if (!time || typeof raw.businessKey !== 'string' || typeof raw.value !== 'string') return null;
  return { ...time, businessKey: raw.businessKey, value: raw.value };
}

function readTabularMapping(value: unknown): R1TabularMapping | null {
  const raw = objectOrNull(value); if (!raw || raw.kind !== 'tabular_rows') return null;
  const time = readTimeMapping(raw), bar = raw.bar === undefined ? undefined : objectOrNull(raw.bar);
  if (!time || typeof raw.businessKey !== 'string' || !Array.isArray(raw.fields)
    || (raw.bar !== undefined && (!bar || (bar.frequency !== 'day' && bar.frequency !== 'minute')
      || barRoleKeys.some(role => bar[role] !== undefined && typeof bar[role] !== 'string')
      || !barRoleKeys.some(role => typeof bar[role] === 'string' && String(bar[role]).trim())))) return null;
  const fields: R1TabularMapping['fields'] = [];
  for (const item of raw.fields) {
    const field = objectOrNull(item);
    if (!field || typeof field.fieldCode !== 'string' || typeof field.value !== 'string') return null;
    fields.push({ fieldCode: field.fieldCode, value: field.value, ...(typeof field.state === 'string' ? { state: field.state } : {}) });
  }
  const publicTime = raw.publicTime === undefined ? undefined : readTimeMapping(raw.publicTime);
  if (raw.publicTime !== undefined && !publicTime) return null;
  const restoredBar = bar ? { frequency: bar.frequency as BarMapping['frequency'],
    ...Object.fromEntries(barRoleKeys.filter(role => typeof bar[role] === 'string')
      .map(role => [role, bar[role]])) } as BarMapping : undefined;
  return { kind: 'tabular_rows', businessKey: raw.businessKey, ...time, fields,
    ...(restoredBar ? { bar: restoredBar } : {}), ...(publicTime ? { publicTime } : {}) };
}

function readMapping(value: unknown): R1Mapping | null {
  const raw = objectOrNull(value); if (!raw) return null;
  return raw.kind === 'tabular_rows' ? readTabularMapping(raw) : readScalarMapping(raw);
}

function readSemanticProof(value: unknown): SemanticProof | null {
  const raw = objectOrNull(value); if (!raw) return null;
  const quality = raw.quality;
  if (quality !== 'pending' && quality !== 'pass' && quality !== 'fail' && quality !== 'indeterminate') return null;
  const coverage = objectOrNull(raw.coverage), number = (item: unknown): number | null => typeof item === 'number' && Number.isFinite(item) ? item : null;
  return { quality, ruleVersion: text(raw.ruleVersion), ruleDigest: text(raw.ruleDigest), checkScope: strings(raw.checkScope),
    gaps: strings(raw.gaps), coverage: { inputRows: number(coverage?.inputRows), checkedRows: number(coverage?.checkedRows),
      complete: coverage?.complete === true } };
}
function rejectionErrors(value: Record<string, unknown> | null): { code: string; message: string }[] {
  const raw = value?.errors;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    const error = objectOrNull(item);
    return error && typeof error.code === 'string' && typeof error.message === 'string' ? [{ code: error.code, message: error.message }] : [];
  });
}

/** Only explicit operator constants enter the frozen processing plan. */
function readConstants(value: string): Record<string, OperatorConstant> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('常量标注 JSON 尚未完成。'); }
  const raw = objectOrNull(parsed);
  if (!raw) throw new Error('常量标注必须是 JSON 对象。');
  const constants: Record<string, OperatorConstant> = Object.create(null) as Record<string, OperatorConstant>;
  for (const [key, item] of Object.entries(raw)) {
    if (!key.trim() || !(item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) throw new Error('常量名称不能为空，值只能是文本、数字、布尔或 null。');
    constants[key] = item;
  }
  return constants;
}

/** 所有结构化交接沿原 R1 请求身份核对。 */
export function R1Panel() {
  const words = useWords();
  const [caps, setCaps] = useState<R1CapabilitiesView | null>(null), [recent, setRecent] = useState<R1RequestSummary[]>([]);
  const [materials, setMaterials] = useState<MaterialEnvelope[]>([]), [materialId, setMaterialId] = useState('');
  const [materialCategory, setMaterialCategory] = useState<MaterialCategory>('unclassified');
  const [selectedMaterial, setSelectedMaterial] = useState<MaterialRecord | null>(null);
  const [materialLoading, setMaterialLoading] = useState(false), [materialError, setMaterialError] = useState<string | null>(null);
  const [xlsxPreview, setXlsxPreview] = useState<R1XlsxPreview | null>(null), [xlsxDraft, setXlsxDraft] = useState(emptyXlsxDraft);
  const [source, setSource] = useState(emptySource);
  const [rowMode, setRowMode] = useState<RowMode>('scalar');
  const [scalarMapping, setScalarMapping] = useState<R1ScalarMapping>(emptyScalarMapping);
  const [tabularMapping, setTabularMapping] = useState<R1TabularMapping>(emptyTabularMapping);
  const [targetText, setTargetText] = useState(targetTemplate), [facts, setFacts] = useState<Record<string, string>>({});
  const [constantText, setConstantText] = useState('{}');
  const [selectionEnabled, setSelectionEnabled] = useState(false), [selectionColumn, setSelectionColumn] = useState(''), [selectionValue, setSelectionValue] = useState('');
  const [selectedBudget, setSelectedBudget] = useState(5000), [scanBudget, setScanBudget] = useState(2000000);
  const [format, setFormat] = useState<TableFormat>('csv');
  const [requestId, setRequestId] = useState(() => newId('request')), [planRequestId, setPlanRequestId] = useState<string | null>(null);
  const [planId, setPlanId] = useState(''), [outputId, setOutputId] = useState('scalar'), [plan, setPlan] = useState<Record<string, unknown> | null>(null);
  const [job, setJob] = useState<BdJob | null>(null), [view, setView] = useState<R1RequestView | null>(null);
  const [lookupId, setLookupId] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [notice, setNotice] = useState(''), [error, setError] = useState<string | null>(null);
  const fixed = plan !== null || planRequestId !== null;
  const ready = !!caps?.connection;
  const connectionLabel = (mode: string | undefined) => mode === 'production'
    ? words('已登记正式连接', 'registered production connection')
    : mode === 'user_test' ? words('已登记验收连接', 'registered acceptance connection') : words('连接待核对', 'connection to verify');
  const output = (Array.isArray(plan?.outputs) ? plan.outputs : []).map(record).find(item => item.outputId === outputId);
  const activeMaterial = selectedMaterial?.envelope.materialId === materialId ? selectedMaterial : null;
  const activeXlsxPreview = xlsxPreview?.materialId === materialId && xlsxPreview.sha256 === activeMaterial?.envelope.sha256 ? xlsxPreview.preview : null;
  const materialIssue = activeMaterial ? materialTableIssue(activeMaterial, format, selectionEnabled) : null;
  const sourceGaps = r1SourceGaps(source), authorizationReady = r1SourceReadyForHandoff(source);
  const frozenSourceGaps = view ? r1SourceGaps(frozenSource(view)) : [];
  const frozenAuthorizationReady = view ? r1SourceReadyForHandoff(frozenSource(view)) : false;
  const proof = readSemanticProof(output?.semantic);
  const outputMapping = readMapping(record(record(output?.target).declaration).mapping);
  const outputBar = outputMapping && 'kind' in outputMapping ? outputMapping.bar : undefined;
  const missingBarRoles = outputBar ? barRoles.filter(([role]) => !outputBar[role]).map(([, zh]) => zh) : [];
  const missingPublicTime = outputMapping && 'kind' in outputMapping && !outputMapping.publicTime;
  const targetFields = useMemo(() => readTargetFields(targetText), [targetText]);
  const tabularSupported = caps?.limits.supportedPayloads?.includes('tabular_rows') === true;
  const mappingCodes = tabularMapping.fields.map(field => field.fieldCode.trim()).filter(Boolean);
  const publicTimeDraft = tabularMapping.publicTime;
  const fieldsAligned = !targetFields.error && targetFields.fields.length === mappingCodes.length
    && targetFields.fields.every(field => mappingCodes.includes(field.code));
  const refreshLists = useCallback(async () => {
    const [capabilities, requests, page] = await Promise.all([r1Api.capabilities(), r1Api.list(), dataBrowserApi.materials('')]);
    setCaps(capabilities); setRecent(requests); setMaterials(page.items);
    return page.items;
  }, []);
  useEffect(() => { let live = true;
    void refreshLists().catch(failure => { if (live) setError(errorDetail(failure)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [refreshLists]);
  useEffect(() => { let live = true;
    setSelectedMaterial(null); setMaterialError(null);
    if (!materialId) { setMaterialLoading(false); return () => { live = false; }; }
    setMaterialLoading(true);
    void dataBrowserApi.material(materialId).then(material => {
      if (!live) return;
      if (material.envelope.materialId !== materialId || material.envelope.localOnly !== true) throw new Error('原件保管身份无法核对。');
      setSelectedMaterial(material);
      if (!fixed) {
        if (material.preview.format === 'csv') setFormat('csv');
        else if (material.preview.format === 'json-table') setFormat('json');
        else if (material.preview.format === 'excel' && /\.xlsx$/iu.test(material.envelope.filename)) setFormat('xlsx');
      }
    }).catch(failure => { if (live) setMaterialError(errorDetail(failure)); }).finally(() => { if (live) setMaterialLoading(false); });
    return () => { live = false; };
  }, [materialId]);
  const action = async (work: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(null);
    try { await work(); } catch (failure) { setError(errorDetail(failure)); }
    finally { setBusy(false); }
  };
  const showView = (current: R1RequestView) => {
    setView(current); setConfirmed(false);
    const savedSource = frozenSource(current);
    setSource({ source_id: text(savedSource.source_id), provider: text(savedSource.provider), requested_url: text(savedSource.requested_url),
      requested_at_utc: text(savedSource.requested_at_utc), acquired_at_utc: text(savedSource.acquired_at_utc),
      ...(typeof savedSource.license === 'string' ? { license: savedSource.license } : {}),
      usage_scope: text(savedSource.usage_scope), authorization: readAuthorization(savedSource.authorization) });
    // Confirmation belongs to the visible detail load; a refresh requires explicit re-confirmation.
    // A task can settle between list and detail reads; never leave its visible row on an older state.
    setRecent(items => items.map(item => item.requestId === current.requestId
      ? { requestId: current.requestId, state: current.state, rowCount: current.rowCount,
        errorCode: typeof current.error?.code === 'string' ? current.error.code : null } : item));
  };
  const patchScalar = (patch: Partial<R1ScalarMapping>) => setScalarMapping(previous => ({ ...previous, ...patch }));
  const patchXlsx = (patch: Partial<ReturnType<typeof emptyXlsxDraft>>) => setXlsxDraft(previous => ({ ...previous, ...patch }));
  const chooseMaterial = (id: string) => { setMaterialId(id); setXlsxPreview(null); setXlsxDraft(emptyXlsxDraft());
    setSource(previous => { const next = { ...previous }; delete next.license; return { ...next, authorization: unknownAuthorization() }; }); };
  const patchBar = (key: Exclude<keyof BarMapping, 'frequency'>, value: string) =>
    setTabularMapping(previous => {
      const bar = { ...previous.bar, frequency: rowMode === 'minute' ? 'minute' : 'day' } as BarMapping;
      if (value) bar[key] = value;
      else delete bar[key];
      return { ...previous, bar };
    });
  const patchField = (index: number, patch: Partial<R1TabularMapping['fields'][number]>) =>
    setTabularMapping(previous => ({ ...previous, fields: previous.fields.map((field, at) => at === index ? { ...field, ...patch } : field) }));
  const addField = () => setTabularMapping(previous => ({ ...previous, fields: [...previous.fields, { fieldCode: '', value: '', state: '' }] }));
  const removeField = (index: number) => setTabularMapping(previous => ({ ...previous, fields: previous.fields.filter((_, at) => at !== index) }));
  const patchPublicTime = (patch: Partial<R1TimeMapping>) =>
    setTabularMapping(previous => previous.publicTime ? { ...previous, publicTime: { ...previous.publicTime, ...patch } } : previous);
  const togglePublicTime = (enabled: boolean) => setTabularMapping(previous => ({ ...previous,
    publicTime: enabled ? { earliestUtc: '', latestExclusiveUtc: '', precision: previous.precision, sourceTimezone: '' } : undefined }));
  const changeMode = (next: RowMode) => {
    setRowMode(next);
    if (next === 'scalar') { setTabularMapping(previous => ({ ...previous, bar: undefined })); return; }
    const parsed = readTargetFields(targetText);
    setTabularMapping(previous => ({ ...previous,
      ...(next === 'table' ? { bar: undefined } : { precision: next, bar: { frequency: next } }),
      fields: previous.fields.length || parsed.error ? previous.fields
        : parsed.fields.map(field => ({ fieldCode: field.code, value: '', state: '' })) }));
  };
  const syncFields = () => {
    const parsed = readTargetFields(targetText);
    if (parsed.error) throw new Error(parsed.error);
    const codes = parsed.fields.map(field => field.code);
    setTabularMapping(previous => {
      const existing = new Map(previous.fields.map(field => [field.fieldCode, field])), bar = previous.bar ? { ...previous.bar } : undefined;
      if (bar) for (const role of barRoleKeys) {
        if (bar[role] && !codes.includes(bar[role])) delete bar[role];
      }
      return { ...previous, bar, fields: parsed.fields.map(field => existing.get(field.code) ?? { fieldCode: field.code, value: '', state: '' }) };
    });
    setNotice(words(`已从目标合同读取 ${parsed.fields.length} 个字段；请填写实际加工列名和状态列。`,
      `Loaded ${parsed.fields.length} contract fields. Fill in the actual processed columns and state columns.`));
  };
  const readPlan = async (id: string) => {
    const value = await r1Api.plan(id);
    const outputs = (Array.isArray(value.outputs) ? value.outputs : []).map(record);
    let current = outputs.find(item => item.outputId === outputId);
    if (!current && outputs.length === 1) { current = outputs[0]; if (typeof current.outputId === 'string') setOutputId(current.outputId); }
    const planMaterial = strings(current?.materialIds)[0];
    if (planMaterial) setMaterialId(planMaterial);
    const declaration = record(record(current?.target).declaration);
    if (declaration.protocol !== 'wfd.structured-ingest/1.0') throw new Error(words('该计划不是新 R1 冻结声明，不能按当前 profile 重放。', 'This plan is not a frozen R1 declaration; it cannot be replayed under the new profile.'));
    const restored = readMapping(declaration.mapping);
    if (!restored) throw new Error(words('计划中的字段映射无法核对；请保留原计划编号并检查合同。', 'The plan mapping cannot be verified. Preserve the original plan ID and inspect the contract.'));
    setPlan(value); setPlanId(id);
    setTargetText(JSON.stringify(declaration.target, null, 2));
    if ('kind' in restored) {
      const savedSource = record(declaration.source);
      if (sourceFields.some(([key]) => typeof savedSource[key] !== 'string')) throw new Error(words('冻结计划缺少来源声明，请保留原编号核对。', 'The frozen plan is missing its source declaration. Preserve the original ID.'));
      setSource({ source_id: String(savedSource.source_id), provider: String(savedSource.provider), requested_url: String(savedSource.requested_url),
        requested_at_utc: String(savedSource.requested_at_utc), acquired_at_utc: String(savedSource.acquired_at_utc),
        ...(typeof savedSource.license === 'string' ? { license: savedSource.license } : {}), usage_scope: String(savedSource.usage_scope),
        authorization: readAuthorization(savedSource.authorization) });
      setRowMode(restored.bar?.frequency ?? 'table'); setTabularMapping(restored);
    }
    else { setRowMode('scalar'); setScalarMapping(restored); if (planMaterial && planMaterial !== materialId) setSource(emptySource()); }
    const parsedStep = (Array.isArray(current?.steps) ? current.steps : []).map(record).find(step => step.kind === 'parse');
    const table = record(parsedStep?.parameters), selected = record(table.selection), predicate = record(selected.predicate);
    setConstantText(JSON.stringify(table.annotations ?? {}, null, 2));
    if (table.format === 'csv' || table.format === 'json' || table.format === 'xlsx') setFormat(table.format);
    if (table.format === 'xlsx') {
      const selected = record(table.xlsxSelection);
      setXlsxDraft({ sheetName: text(selected.sheetName), headerRow: String(selected.headerRow ?? ''),
        firstDataRow: String(selected.firstDataRow ?? ''), lastDataRow: String(selected.lastDataRow ?? ''),
        firstColumn: text(selected.firstColumn), lastColumn: text(selected.lastColumn), columns: JSON.stringify(selected.columns ?? [], null, 2) });
    }
    setSelectionEnabled(typeof predicate.column === 'string' && typeof predicate.equals === 'string');
    setSelectionColumn(text(predicate.column)); setSelectionValue(text(predicate.equals));
    if (typeof selected.maxSelectedRows === 'number') setSelectedBudget(selected.maxSelectedRows);
    if (typeof selected.maxScannedRows === 'number') setScanBudget(selected.maxScannedRows);
  };
  const refresh = async () => {
    await refreshLists();
    if (materialId) setSelectedMaterial(await dataBrowserApi.material(materialId));
    if (planId) await readPlan(planId);
    else if (planRequestId) { const value = await r1Api.planByRequest(planRequestId); if (value?.planId) await readPlan(String(value.planId)); }
    if (view) showView(await r1Api.get(view.requestId));
    if (job) {
      const latest = await dataBrowserApi.processingTask(job.jobId);
      setJob(latest);
      const uploadedId = text(record(latest.result?.data).materialId);
      if (latest.operation === 'materials.inspect' && uploadedId && !materialId) chooseMaterial(uploadedId);
    }
    setNotice(words('已读取当前状态；刷新不会提交或重发。', 'Current state loaded. Refresh never submits or resends.'));
  };
  const preparePlan = async () => {
    if (!ready) throw new Error(words('当前没有可用的 data_only 连接，BD 未建立交接计划。', 'No data_only connection is available; BD did not create a handoff plan.'));
    if (!materialId || dimensions.some(([key]) => !facts[key]?.trim())) throw new Error(words('请选择真实材料并明确六项用途事实；未知不能标为通过。', 'Select a real material and state all six facts; unknown is not a pass.'));
    const material = await dataBrowserApi.material(materialId);
    setSelectedMaterial(material);
    if (material.envelope.materialId !== materialId || material.envelope.localOnly !== true) throw new Error(words('原件保管身份无法核对，BD 未建立计划。', 'Material custody cannot be verified; BD did not create a plan.'));
    const materialIssue = materialTableIssue(material, format, selectionEnabled);
    if (materialIssue) throw new Error(materialIssue);
    let xlsxSelection: XlsxTableSelection | undefined;
    if (format === 'xlsx') {
      if (!activeXlsxPreview || activeXlsxPreview.conversionStatus !== 'complete') throw new Error('请先查看并核对 XLSX 工作簿结构；转换未完整时 BD 不建立表格计划。');
      xlsxSelection = readXlsxSelection(xlsxDraft);
    }
    if (rowMode !== 'scalar' && !tabularSupported) throw new Error(words('当前连接没有声明 tabular_rows（表格行）能力，不能建立多字段计划。', 'The live connection does not advertise tabular_rows; a multi-field plan cannot be created.'));
    const target = JSON.parse(targetText) as R1PrepareInput['target'];
    const types: Record<string, 'decimal_string' | 'string' | 'boolean'> = Object.create(null) as Record<string, 'decimal_string' | 'string' | 'boolean'>;
    let mapping: R1Mapping;
    let annotations: Record<string, OperatorConstant> | undefined;
    if (rowMode === 'scalar') {
      if (scalarFields.some(([key]) => !scalarMapping[key].trim())) throw new Error(words('请明确全部字段映射和来源时区。', 'Specify every field mapping and the source timezone.'));
      const scalar: R1ScalarMapping = { ...scalarMapping, businessKey: scalarMapping.businessKey.trim(), value: scalarMapping.value.trim(),
        earliestUtc: scalarMapping.earliestUtc.trim(), latestExclusiveUtc: scalarMapping.latestExclusiveUtc.trim(),
        sourceTimezone: scalarMapping.sourceTimezone.trim() };
      mapping = scalar;
      types[scalar.value] = 'decimal_string';
    } else {
      const contract = readTargetFields(targetText);
      if (contract.error) throw new Error(contract.error);
      const contractCodes = contract.fields.map(field => field.code).sort();
      const mappedCodes = tabularMapping.fields.map(field => field.fieldCode.trim()).sort();
      if (contractCodes.length !== mappedCodes.length || new Set(mappedCodes).size !== mappedCodes.length
        || contractCodes.some((code, index) => code !== mappedCodes[index])) throw new Error(words(
        '字段映射必须与目标合同的 field_definitions 完全一致：不能丢列、补列或重复。',
        'Field mappings must match the target definition.field_definitions exactly; do not drop, add or duplicate fields.'));
      const fields = tabularMapping.fields.map(field => ({ fieldCode: field.fieldCode.trim(), value: field.value.trim(), state: (field.state ?? '').trim() }));
      if (fields.some(field => !field.fieldCode || !field.value || !field.state)) throw new Error(words(
        '每个合同字段都要给出实际加工值列和状态列；状态不能留空后自动当作有效。',
        'Every contract field needs a processed value column and a state column; an empty state is never treated as valid.'));
      if (!tabularMapping.businessKey.trim() || !tabularMapping.earliestUtc.trim() || !tabularMapping.latestExclusiveUtc.trim() || !tabularMapping.sourceTimezone.trim()) throw new Error(words(
        '请明确业务键、UTC 起止列和来源时区；页面不猜日期或时区。',
        'Specify the business key, UTC bound columns and source timezone; dates and timezones are never guessed.'));
      const selectedRoles = rowMode === 'table' ? [] : barRoleKeys.flatMap(role => {
        const code = tabularMapping.bar?.[role]?.trim();
        return code ? [[role, code] as const] : [];
      });
      const roleCodes = selectedRoles.map(([, code]) => code);
      if (rowMode !== 'table' && !selectedRoles.length) throw new Error(words(
        '选择日线或分钟行情时，至少明确一个实际存在的行情角色；普通多字段表格请选“普通表格”。',
        'Daily or minute market data needs at least one actual role; choose “General table” for other multi-field records.'));
      if (new Set(roleCodes).size !== roleCodes.length || roleCodes.some(code => !contractCodes.includes(code))) throw new Error(words(
        '每个已声明的行情角色必须引用不同的目标合同字段。', 'Each declared market role must reference a distinct target contract field.'));
      const publicTime = tabularMapping.publicTime;
      if (publicTime && (!publicTime.earliestUtc.trim() || !publicTime.latestExclusiveUtc.trim() || !publicTime.sourceTimezone.trim())) throw new Error(words(
        '公开时间要么完整填写 UTC 起止列和来源时区，要么不启用。',
        'Public time must include UTC bound columns and a source timezone, or stay disabled.'));
      mapping = { kind: 'tabular_rows', businessKey: tabularMapping.businessKey.trim(), earliestUtc: tabularMapping.earliestUtc.trim(),
        latestExclusiveUtc: tabularMapping.latestExclusiveUtc.trim(), precision: rowMode === 'table' ? tabularMapping.precision : rowMode,
        sourceTimezone: tabularMapping.sourceTimezone.trim(), fields,
        ...(rowMode === 'table' ? {} : { bar: { frequency: rowMode, ...Object.fromEntries(selectedRoles) } }),
        ...(publicTime ? { publicTime: { earliestUtc: publicTime.earliestUtc.trim(), latestExclusiveUtc: publicTime.latestExclusiveUtc.trim(),
          precision: publicTime.precision, sourceTimezone: publicTime.sourceTimezone.trim() } } : {}) };
      const typeByCode = new Map(contract.fields.map(field => [field.code, field.dataType]));
      for (const field of fields) {
        const type = typeByCode.get(field.fieldCode);
        if (type === 'decimal') types[field.value] = 'decimal_string';
        else if (type === 'integer') types[field.value] = 'decimal_string';
        else if (type === 'boolean') types[field.value] = 'boolean';
        else if (type === 'text') types[field.value] = 'string';
      }
      const constants = readConstants(constantText);
      annotations = Object.keys(constants).length ? constants : undefined;
      for (const name of Object.keys(constants)) delete types[name];
    }
    const declared = Object.fromEntries(dimensions.map(([key]) => [key, { status: 'known', value: facts[key],
      evidence: [{ source: 'operator', field: `routing.materials.0.dimensions.${key}`, quote: facts[key] }] }]));
    if (selectionEnabled && (format !== 'csv' || !selectionColumn || !Number.isSafeInteger(selectedBudget)
      || selectedBudget < 1 || selectedBudget > 5000 || !Number.isSafeInteger(scanBudget) || scanBudget < 1 || scanBudget > 2000000)) {
      throw new Error(words('请明确 CSV 原列名、精确匹配值和扫描范围；最多选 5000 行、扫描 200 万行，超限会停止。', 'Specify the original CSV column, exact match and budgets: at most 5000 selected rows and 2 million scanned rows.'));
    }
    const id = newId('plan'); setPlanRequestId(id);
    const selection = format === 'csv' && selectionEnabled ? { predicate: { column: selectionColumn, equals: selectionValue }, maxSelectedRows: selectedBudget, maxScannedRows: scanBudget } : undefined;
    const task = await r1Api.createPlan(id, { routing: { materials: [{ materialId, dimensions: declared, intendedAction: 'publish' }] },
      outputs: [{ outputId, materialIds: [materialId], intendedAction: 'publish', tables: [{ materialId, format, types,
        ...(annotations ? { annotations } : {}), ...(selection ? { selection } : {}), ...(xlsxSelection ? { xlsxSelection } : {}) }],
        target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target, mapping, ...(rowMode !== 'scalar' ? { source } : {}) }, expectedSnapshotId: target.expectedParentSnapshotId } }] });
    setJob(task); const created = await r1Api.planByRequest(id); if (created?.planId) await readPlan(String(created.planId));
    setNotice(words('计划请求已受理，尚未运行加工或提交数据库。请刷新核对后运行五步。', 'Plan accepted, not executed or submitted. Refresh, then explicitly run the processing steps.'));
  };
  const startNew = () => { setPlan(null); setPlanRequestId(null); setPlanId(''); setJob(null); setView(null); setConfirmed(false); setRequestId(newId('request')); setSource(emptySource()); setNotice(''); };
  const uploadOriginal = async (file: File, category: MaterialCategory) => {
    const uploaded = await r1Api.upload(file, newId('upload'), category);
    setJob(uploaded); chooseMaterial('');
    const stored = await refreshLists();
    const uploadedId = text(record(uploaded.result?.data).materialId)
      || stored.find(material => material.taskId === uploaded.jobId)?.materialId;
    if (uploadedId) chooseMaterial(uploadedId);
    setNotice(uploadedId ? words('原件已由 BD 保管并选中；请核对下方预览。尚未建立加工计划或提交 WFD。', 'BD stored and selected the original. Check its preview below. No processing plan or WFD submission has occurred.')
      : words('原件接收任务已受理，尚未证明保管完成；刷新原任务后核对材料。', 'Intake task accepted, but custody is not yet confirmed. Refresh the original task to inspect the material.'));
  };

  return <div className="r1-panel" aria-busy={busy || loading}>
    <header className="database-overview-head"><div><h2 className="data-panel-title">{words('R1 结构化交接', 'R1 structured handoff')}</h2>
      <p className="data-panel-sub">{words('新请求：真实材料 → 五步加工 → 明确确认 → WFD 固定读回。可交接单值标量、普通多字段表格或声明了部分/完整字段的日线与分钟记录。', 'New requests: real material → processing → explicit confirmation → fixed WFD readback. Scalar records, general multi-field tables, and daily or minute records with declared partial or complete market fields are supported.')}</p></div>
      <button type="button" className="text-button" disabled={busy || loading} onClick={() => void action(refresh)}><RefreshCw size={16} aria-hidden="true" />{words('刷新状态', 'Refresh state')}</button></header>
    {loading && <p role="status">{words('读取本地能力和最近请求中…', 'Loading local capabilities and recent requests…')}</p>}
    {error && <ErrorNote detail={error}>{words('本次动作未确认完成，请按具体错误核对原编号。', 'The action is not confirmed complete. Check the error and preserve the original ID.')}</ErrorNote>}
    <div className="database-line-card"><strong>data_only · wfd.structured-ingest/1.0 · {connectionLabel(caps?.connection?.mode)}</strong>
      <span>{caps?.connection?.connectionId ?? words('连接未配置', 'Connection not configured')}</span>
      <span>{caps?.configuration.reason ?? words('当前连接来自本机登记；可只读核对数据库能力，每次交接仍需明确确认。', 'The connection comes from local registration. Check its capabilities read-only; each handoff still requires explicit confirmation.')}</span>
      <button type="button" className="text-button" disabled={busy || !ready} onClick={() => void action(async () => { const result = await r1Api.check(); setNotice(result.supported ? words('当前机器入口真实声明支持 data_only。', 'The live machine advertises data_only.') : String(result.reason)); })}>{words('只读核对数据库能力', 'Check database capabilities (read-only)')}</button></div>
    {!ready && !loading && <div className="database-gap"><ShieldAlert size={20} aria-hidden="true" /><p>{words('未绑定可用的 data_only 连接：不能提交、不能在网页填写 store/runtime 或权限绕过配置。仍可查看已保存的本地回链。', 'No usable data_only binding: submission is disabled. The page cannot override store/runtime or permissions. Saved local links remain readable.')}</p></div>}
    <R1AutoPanel materials={materials} materialId={materialId} material={activeMaterial} materialLoading={materialLoading} materialError={materialError}
      source={source} ready={ready} disabled={busy || fixed || loading} onChooseMaterial={chooseMaterial} onSourceChange={setSource}
      onUpload={async (file, category) => { setBusy(true); try { await uploadOriginal(file, category); } finally { setBusy(false); } }} />
    <CloudCustodyPanel materials={materials} initialId={materialId} />
    <DocumentProcessingPanel key={materialId} materialId={materialId} />
    {notice && <p className="r1-notice" role="status" aria-live="polite">{notice}</p>}
    {job && <div className="database-receipt"><strong>{words('原任务', 'Original task')} · {job.status}</strong><code>{job.jobId}</code>{job.error && <span>{job.error.code}: {job.error.message}</span>}</div>}
    <section className="r1-lifecycle" aria-label={words('交接阶段', 'Handoff stages')}>
      <span>{words('原件', 'Material')}：{activeMaterial ? words('BD 已保管', 'Stored in BD') : words('待选择或核对', 'Select or verify')}</span>
      <span>{words('结构', 'Structure')}：{output?.state === 'structured' ? words('五步完成', 'Five steps complete') : words('未证实完成', 'Not verified complete')}</span>
      <span>{words('交接', 'Handoff')}：{view ? words(states[view.state] ?? '原请求状态待核对', view.state) : words('尚未准备确认', 'Not prepared for confirmation')}</span>
    </section>
    <form className="r1-form" onSubmit={event => { event.preventDefault(); void action(preparePlan); }}>
      <fieldset disabled={busy || fixed}><legend>{words('1 · 选择原件与明确事实', '1 · Material and explicit facts')}</legend>
        <label>{words('已有材料（仅最近 50 份）', 'Stored material (latest 50)')}<select required value={materialId} onChange={event => chooseMaterial(event.target.value)}>
          <option value="">{words('请选择真实保管的材料', 'Select a stored material')}</option>{materials.map(material => <option key={material.materialId} value={material.materialId}>{material.filename} · {material.materialId}</option>)}
          {materialId && !materials.some(material => material.materialId === materialId) && <option value={materialId}>{activeMaterial?.envelope.filename ?? materialId} · {materialId}</option>}</select></label>
        <div className="r1-grid">
          <label>{words('上传接收类别（须明确选择）', 'Upload intake category (choose explicitly)')}<select value={materialCategory} onChange={event => setMaterialCategory(event.target.value as MaterialCategory)}>
            <option value="unclassified">{words('未分类，仅保管并预览', 'Unclassified: custody and preview only')}</option>
            <option value="data">{words('数据材料', 'Data material')}</option><option value="tool">{words('代码或工具材料', 'Code or tool material')}</option>
          </select></label>
          <label>{words('上传一份原件（25 MiB 内）', 'Upload one original (up to 25 MiB)')}<input type="file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void action(() => uploadOriginal(file, materialCategory)); }} /></label>
        </div>
        {!materialId ? <p className="r1-help">{words('先选择已保管材料，或明确接收类别后上传；上传只保管原件并生成只读预览。', 'Select stored material or choose an intake category and upload. Upload only stores the original and creates a read-only preview.')}</p>
          : materialLoading ? <p role="status" className="r1-help">{words('读取原件保管与预览中…', 'Loading custody and preview…')}</p>
          : materialError ? <p className="r1-help danger-text" role="alert">{materialError}</p>
          : activeMaterial && <section className="r1-material" aria-label={words('材料状态', 'Material state')}>
            <p><strong>{words('材料已保存于 BD', 'Material stored in BD')}</strong> · {activeMaterial.envelope.filename} · {activeMaterial.envelope.byteLength.toLocaleString()} B</p>
            <p className="r1-help">{words('原件身份', 'Original ID')} <code>{activeMaterial.envelope.materialId}</code> · SHA-256 <code>{activeMaterial.envelope.sha256}</code> · {words('仅本机保管，尚未送 WFD', 'Local custody only; not sent to WFD')}</p>
            <p><strong>{words('识别与适配', 'Format and adapter')}</strong> · {activeMaterial.preview.format} · {activeMaterial.preview.support} · {activeMaterial.preview.adapter ? `${activeMaterial.preview.adapter.id}/${activeMaterial.preview.adapter.version}` : words('未装配表格适配器', 'No table adapter')}</p>
            <p className="r1-help">{activeMaterial.preview.reason}</p>
            {activeMaterial.envelope.category === 'unclassified' && <p className="r1-help">{words('接收时未分类；原件类别保持不变。若本次确实用作数据，请在下方亲自声明六维事实，实际解析和 WFD 准入仍独立核对。', 'Unclassified at intake; the stored category stays unchanged. If this is data for this request, state the six facts below. Parsing and WFD admission are checked separately.')}</p>}
            {activeMaterial.preview.checks.issues.length > 0 && activeMaterial.preview.checks.issues.every(issue => previewBudgetIssues.has(issue.code)) && <p className="r1-help danger-text">{words('只读预览受预算限制，未看到完整原件；明确选件或实际计划解析仍会重新核对完整原件，不能把此预览当作结构完成。', 'The read-only preview hit its budget and did not cover the full original. Explicit selection or plan parsing checks the full original separately; this preview is not structural completion.')}</p>}
            {activeMaterial.preview.table && <div className="r1-raw-preview"><p><strong>{words('原字段与原值预览', 'Original fields and values')}</strong> · {activeMaterial.preview.table.totalRows} {words('行；仅显示前 3 行', 'rows; first 3 shown')}</p>
              <div className="r1-table-scroll"><table><thead><tr>{activeMaterial.preview.table.columns.map((column, index) => <th key={index}>{column.name}</th>)}</tr></thead>
                <tbody>{activeMaterial.preview.table.rows.slice(0, 3).map((row, rowIndex) => <tr key={rowIndex}>{activeMaterial.preview.table!.columns.map((_, columnIndex) => {
                  const cell = row[columnIndex]; return <td key={columnIndex} title={cell?.quote ?? ''}>{!cell || cell.sourceType === 'missing' ? words('缺失', 'Missing') : cell.original === null ? 'null' : String(cell.original)}</td>;
                })}</tr>)}</tbody></table></div></div>}
            {activeMaterial.preview.text && <details><summary>{words('查看原文预览（只读）', 'View original text preview (read-only)')}</summary><pre className="database-text-preview">{activeMaterial.preview.text.original}</pre></details>}
            {activeMaterial.preview.checks.issues.length > 0 && <ul className="r1-proof-gaps">{activeMaterial.preview.checks.issues.map((issue, index) => <li key={index}>{issue.code}: {issue.message}</li>)}</ul>}
            {activeMaterial.preview.pending.length > 0 && <details open><summary>{words('待核缺口', 'Pending gaps')} · {activeMaterial.preview.pending.length}</summary><ul className="r1-proof-gaps">{activeMaterial.preview.pending.map((gap, index) => <li key={index}>{gap}</li>)}</ul></details>}
            {activeMaterial.preview.limitations.length > 0 && <details><summary>{words('预览边界', 'Preview limits')}</summary><ul className="r1-proof-gaps">{activeMaterial.preview.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></details>}
            <p className={materialIssue ? 'r1-help danger-text' : 'r1-help'}>{materialIssue ?? words('下一步：核对原字段、原值与缺口，再明确六维事实、映射和目标；结构成功后仍需独立确认与 WFD 实际回执。', 'Next: inspect original fields, values and gaps, then state facts, mappings and target. Structural success still requires separate confirmation and an actual WFD receipt.')}</p>
          </section>}
        <label>{words('表源格式', 'Table format')}<select value={format} onChange={event => { setFormat(event.target.value as TableFormat); setSelectionEnabled(false); }}><option value="csv">UTF-8 CSV</option><option value="json">UTF-8 JSON</option><option value="xlsx">XLSX</option></select></label>
        {format === 'xlsx' && <div className="r1-xlsx">
          <div className="r1-actions"><button type="button" className="text-button" disabled={!activeMaterial || !!materialIssue || busy}
            onClick={() => void action(async () => {
              const result = await r1Api.xlsxPreview(materialId);
              if (result.sha256 !== activeMaterial?.envelope.sha256) throw new Error('工作簿预览与所选原件摘要不一致，BD 未建立计划。');
              setXlsxPreview(result);
            })}>{words('查看工作簿结构', 'Inspect workbook structure')}</button>
            <span className="r1-help">{words('只在点击后读取原生工作簿结构；预览有界，未显示的行列尚未核对。', 'The native workbook structure is read only when clicked. The preview is bounded; unseen rows and columns are not verified.')}</span></div>
          {activeXlsxPreview && <div className="r1-raw-preview">
            <p><strong>{words('工作簿原生结构', 'Native workbook structure')}</strong> · {activeXlsxPreview.conversionStatus} · {activeXlsxPreview.sheetCount} {words('张表', 'sheets')} · {activeXlsxPreview.totalRows} {words('行', 'rows')}</p>
            <ul className="r1-proof-gaps">{activeXlsxPreview.sheets.map((sheet, index) => <li key={index}>{sheet.name ?? words('无表名', 'Unnamed')} · {sheet.rowCount} {words('行', 'rows')} · {sheet.cellCount} {words('格', 'cells')} · {sheet.part}</li>)}</ul>
            <p className="r1-help">{words('首批原格', 'First native cells')} · {activeXlsxPreview.previewSheet ?? '—'}{activeXlsxPreview.truncated && ` · ${words('仅有界预览', 'Bounded preview')}`}</p>
            <pre className="database-text-preview">{JSON.stringify(activeXlsxPreview.rows, null, 2)}</pre>
            <p className="r1-help">{activeXlsxPreview.scopeGuidance}</p>
          </div>}
          <p className="r1-help">{words('请按原生位置亲自填写工作表、表头行、数据行与字母列范围。列映射 JSON 须逐列填写 column（字母列）、header（原表头）、name（输出名），type 可省略以保留原词面，或明确选 string、decimal_string、safe_integer、boolean。页面不猜表头、类型、单位或日期。',
            'Enter the sheet, header row, data rows and lettered column range from native positions. Map each column with column, original header and output name. Type may be omitted to preserve raw spelling, or explicitly set to string, decimal_string, safe_integer or boolean. The page does not guess headers, types, units or dates.')}</p>
          <div className="r1-grid">
            <label>{words('工作表原名', 'Original sheet name')}<input value={xlsxDraft.sheetName} onChange={event => patchXlsx({ sheetName: event.target.value })} /></label>
            <label>{words('表头行（1 基）', 'Header row (1-based)')}<input type="number" min={1} value={xlsxDraft.headerRow} onChange={event => patchXlsx({ headerRow: event.target.value })} /></label>
            <label>{words('首数据行（1 基）', 'First data row (1-based)')}<input type="number" min={1} value={xlsxDraft.firstDataRow} onChange={event => patchXlsx({ firstDataRow: event.target.value })} /></label>
            <label>{words('末数据行（1 基，含）', 'Last data row (inclusive)')}<input type="number" min={1} value={xlsxDraft.lastDataRow} onChange={event => patchXlsx({ lastDataRow: event.target.value })} /></label>
            <label>{words('首列字母', 'First column letter')}<input value={xlsxDraft.firstColumn} onChange={event => patchXlsx({ firstColumn: event.target.value })} placeholder="A" /></label>
            <label>{words('末列字母（含）', 'Last column letter (inclusive)')}<input value={xlsxDraft.lastColumn} onChange={event => patchXlsx({ lastColumn: event.target.value })} placeholder="C" /></label>
          </div>
          <label>{words('逐列映射 JSON（显式填写）', 'Column mapping JSON (explicit)')}<textarea className="r1-constants" rows={5} spellCheck={false} value={xlsxDraft.columns} onChange={event => patchXlsx({ columns: event.target.value })} /></label>
          {!activeXlsxPreview && <p className="r1-help danger-text">{words('工作簿结构尚未核对；BD 不会建立 XLSX 表格计划。', 'Workbook structure has not been inspected; BD will not create an XLSX table plan.')}</p>}
          {activeXlsxPreview && activeXlsxPreview.conversionStatus !== 'complete' && <p className="r1-help danger-text">{words('工作簿原生转换未完整；BD 不会建立 XLSX 表格计划。', 'Native workbook conversion is incomplete; BD will not create an XLSX table plan.')}</p>}
        </div>}
        <label><input type="checkbox" checked={selectionEnabled} disabled={format !== 'csv'} onChange={event => setSelectionEnabled(event.target.checked)} />{words('按原列精确选件', 'Select exact original CSV values')}</label>
        {selectionEnabled && <div className="r1-grid">
          <label>{words('选件原列名', 'Original selection column')}<input required value={selectionColumn} onChange={event => setSelectionColumn(event.target.value)} /></label>
          <label>{words('原值精确等于（可为空）', 'Exact original value (may be empty)')}<input value={selectionValue} onChange={event => setSelectionValue(event.target.value)} /></label>
          <label>{words('最多选中行数', 'Selected row limit')}<input type="number" min={1} max={5000} value={selectedBudget} onChange={event => setSelectedBudget(Number(event.target.value))} /></label>
          <label>{words('最多扫描行数', 'Scan row limit')}<input type="number" min={1} max={2000000} value={scanBudget} onChange={event => setScanBudget(Number(event.target.value))} /></label>
          <p className="r1-help">{words('选件会扫描整份原件，核对到末尾才记录完整；保留原字段、原值和原行位置。选中部分不代表全市场覆盖。大原件须先经受控文件引用保管，网页上传仍限 25 MiB。', 'Selection scans to the end of the original and retains raw fields, values and positions. It does not prove market coverage. Large originals require controlled custody; browser upload remains limited to 25 MiB.')}</p>
        </div>}
        <div className="r1-grid">{dimensions.map(([key, zh, en]) => <label key={key}>{words(zh, en)}<input required value={facts[key] ?? ''} onChange={event => setFacts(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}</div>
        <p className="r1-help">{words('以上内容保存为本机操作者的明确声明，不代表程序独立验证来源真实性。未知或冲突请先核对，不要填“已通过”。', 'These are explicit operator declarations, not independent verification of source authenticity. Resolve unknowns or conflicts rather than marking them passed.')}</p>
      </fieldset>
      <fieldset disabled={busy || !!view || fixed && rowMode !== 'scalar'}><legend>{words('来源与本次交接授权', 'Source and authorization for this handoff')}</legend>
        <div className="r1-grid">{sourceFields.map(([key, zh, en]) => <label key={key}>{words(zh, en)}<input value={source[key]}
          onChange={event => setSource(previous => ({ ...previous, [key]: event.target.value }))} placeholder={key.endsWith('_utc') ? 'YYYY-MM-DDTHH:mm:ssZ' : undefined} /></label>)}</div>
        <label>{words('本次 R1 正式交接授权', 'Authorization for this R1 formal handoff')}<select value={source.authorization.status}
          onChange={event => setSource(previous => ({ ...previous, authorization: { status: event.target.value as R1Authorization['status'], basis: null } }))}>
          <option value="unknown">{words('待核：尚未确认授权', 'Unknown: authorization not verified')}</option>
          <option value="authorized">{words('有授权：填写明确依据', 'Authorized: provide the basis')}</option>
          <option value="denied">{words('无授权：本次不允许交接', 'Denied: no handoff for this request')}</option>
        </select></label>
        <label>{words('本次授权依据（最多 4096 字）', 'Authorization basis (up to 4096 characters)')}<textarea className="r1-constants" rows={3} maxLength={4096}
          value={source.authorization.basis ?? ''} onChange={event => setSource(previous => ({ ...previous,
            authorization: { ...previous.authorization, basis: event.target.value || null } }))} /></label>
        <p className="r1-help">{words('原包许可不作为本次准入项目；旧来源文字仍保留在 BD。请单独确认本次交接授权和用途。授权待核或明确无授权时，可保管原件并完成结构加工，但不能准备或提交 WFD。',
          'Original-package license is not an admission item. Existing source text stays in BD. Confirm this handoff authorization and usage separately. Unknown or denied authorization can be stored and structurally processed, but cannot be prepared or submitted to WFD.')}</p>
        {source.authorization.status === 'denied' ? <p className="r1-help danger-text">{words('本次明确无授权，不允许正式交接。', 'Authorization is denied for this request; formal handoff is not allowed.')}</p>
          : source.authorization.status === 'unknown' ? <p className="r1-help danger-text">{words('本次授权待核；请先核对依据。', 'Authorization for this request is unknown; verify the basis first.')}</p>
          : !authorizationReady && <div><p className="r1-help danger-text">{words('来源、用途或本次授权依据仍有缺口或显见冲突；须核对后才可准备交接。', 'The source, usage scope or this handoff authorization basis has gaps or an explicit conflict. Verify it before preparing the handoff.')}</p>
            <ul className="r1-proof-gaps">{sourceGaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></div>}
        {rowMode !== 'scalar' && <p className="r1-help">{words('多字段计划会冻结上述来源及授权。建计划后若核实或修订授权，须另建新计划与请求；原任务保留原身份。',
          'A multi-field plan freezes the source and authorization above. If authorization is verified or revised after planning, create a new plan and request; the original task keeps its identity.')}</p>}
      </fieldset>
      <fieldset disabled={busy || !ready || fixed}><legend>{words('2 · 冻结映射与目标合同', '2 · Freeze mappings and target contract')}</legend>
        <label>{words('记录形态', 'Record shape')}<select value={rowMode} onChange={event => changeMode(event.target.value as RowMode)}>
          <option value="scalar">{words('标量记录（单值 + 时间区间）', 'Scalar record (single value + time interval)')}</option>
          <option value="table" disabled={!tabularSupported}>{words('普通多字段表格（不声明行情角色）', 'General multi-field table (no market roles)')}</option>
          <option value="day" disabled={!tabularSupported}>{words('日线记录（声明实际行情角色）', 'Daily records (declare actual market roles)')}</option>
          <option value="minute" disabled={!tabularSupported}>{words('分钟记录（声明实际行情角色）', 'Minute records (declare actual market roles)')}</option>
        </select></label>
        {rowMode === 'scalar' ? <>
          <div className="r1-grid">{scalarFields.map(([key, zh, en]) => <label key={key}>{words(zh, en)}
            <input required value={scalarMapping[key]} onChange={event => setScalarMapping(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}</div>
          <label>{words('明确时间精度', 'Explicit time precision')}<select value={scalarMapping.precision}
            onChange={event => patchScalar({ precision: event.target.value as R1ScalarMapping['precision'] })}><option value="day">day</option><option value="minute">minute</option><option value="second">second</option></select></label>
          <p className="r1-help">{words('时间列必须是已加工的明确 UTC 起止时间；不猜日期或时区。十进制值保持字符串。标量切片只承接单材料、最多 5000 行。',
            'Time columns must already contain explicit UTC bounds; dates or timezones are never guessed. Decimals remain strings. This scalar slice supports one material and at most 5000 rows.')}</p>
        </> : <>
          <div className="r1-grid">{tabularFields.map(([key, zh, en]) => <label key={key}>{words(zh, en)}
            <input required value={tabularMapping[key]} onChange={event => setTabularMapping(previous => ({ ...previous, [key]: event.target.value }))} /></label>)}</div>
          {rowMode === 'table' && <label>{words('明确时间精度', 'Explicit time precision')}<select value={tabularMapping.precision}
            onChange={event => setTabularMapping(previous => ({ ...previous, precision: event.target.value as R1TimeMapping['precision'] }))}>
            <option value="day">day</option><option value="minute">minute</option><option value="second">second</option></select></label>}
          <p className="r1-help">{words('合同字段逐项映射到实际加工值列和显式状态列。只声明材料里确有的事实；不自动补零、补有效状态、时区或未复权口径。',
            'Map each contract field to an actual processed value column and explicit state column. Declare only facts present in the material; zeroes, valid states, timezones and unadjusted basis are never filled in automatically.')}</p>
          {rowMode !== 'table' && <>
            <p className="r1-help">{words('以下选择目标合同的 field_code（字段编码），不是实际列名。至少选一个材料真实包含的行情角色；未选择的角色及其关系不会被核对。只有五项齐全才可称完整 OHLCV（开高低收及成交量）。',
              'Select target field_code values here, not processed column names. Declare at least one market role actually present in the material. Unselected roles and their relationships are not checked. Complete OHLCV requires all five roles.')}</p>
            <div className="r1-grid">{barRoles.map(([key, zh, en]) => <label key={key}>{words(`${zh}（可选）`, `${en} (optional)`)}
              <select value={tabularMapping.bar?.[key] ?? ''} onChange={event => patchBar(key, event.target.value)}><option value="">{words('未声明此角色', 'Role not declared')}</option>
                {mappingCodes.map(code => <option key={code} value={code}>{code}</option>)}</select></label>)}</div>
            <label>{words('成交额角色（可选）', 'Amount role (optional)')}<select value={tabularMapping.bar?.amount ?? ''} onChange={event => patchBar('amount', event.target.value)}>
              <option value="">{words('未声明此角色', 'Role not declared')}</option>{mappingCodes.map(code => <option key={code} value={code}>{code}</option>)}</select></label>
          </>}
          <div className="r1-actions"><button type="button" className="text-button" disabled={busy || !!targetFields.error || !targetFields.fields.length}
            onClick={() => void action(async () => { syncFields(); })}>{words('读取目标合同字段', 'Load contract fields')}</button>
            <span className="r1-help">{targetFields.error ? words('目标合同还没有可读取的字段；请先补全 definition.field_definitions。', 'No readable contract fields yet. Add definition.field_definitions first.')
              : words(`目标合同有 ${targetFields.fields.length} 个字段；当前映射 ${tabularMapping.fields.length} 个。`, `Target contract has ${targetFields.fields.length} fields; ${tabularMapping.fields.length} mapped now.`)}</span></div>
          {!fieldsAligned && !targetFields.error && <p className="r1-help danger-text">{words('当前映射与目标合同字段不一致；请读取字段并逐项核对，不能丢列、补列或重复。',
            'Current mappings do not match the target contract fields. Load and verify them; do not drop, add or duplicate fields.')}</p>}
          <div className="r1-field-list">{tabularMapping.fields.map((field, index) => <div className="r1-field-row" key={index}>
            <label>{words('合同字段', 'Contract field')}<input value={field.fieldCode} aria-label={words('合同字段', 'Contract field')}
              onChange={event => patchField(index, { fieldCode: event.target.value })} /></label>
            <label>{words('实际值列', 'Processed value column')}<input value={field.value} aria-label={words('实际值列', 'Processed value column')}
              onChange={event => patchField(index, { value: event.target.value })} /></label>
            <label>{words('状态列', 'State column')}<input value={field.state ?? ''} aria-label={words('状态列', 'State column')}
              onChange={event => patchField(index, { state: event.target.value })} /></label>
            <button type="button" className="text-button" disabled={busy} onClick={() => removeField(index)}>{words('移除', 'Remove')}</button>
          </div>)}</div>
          <button type="button" className="text-button" disabled={busy} onClick={addField}>{words('添加合同字段', 'Add contract field')}</button>
          <p className="r1-help">{words('状态列必须来自实际加工产物；留空不会自动当作有效。常量只能由操作者在加工步骤中明确声明并随计划冻结，页面不自动补常量。',
            'State columns must come from the actual processed output; an empty state is never treated as valid. Constants are declared explicitly by the operator in processing and frozen with the plan; the page never fills them in.')}</p>
          <details className="r1-constants"><summary>{words('操作者常量（可选，随计划冻结）', 'Operator constants (optional, frozen with the plan)')}</summary>
            <p className="r1-help">{words('按 JSON 对象填写你明确选择的固定口径，例如 {"adjustment":"raw"}。常量不是来源实测值；字段映射仍需引用实际加工列和状态列，页面不会自动补常量。',
              'Enter the fixed values you explicitly choose as a JSON object, for example {"adjustment":"raw"}. Constants are not measured source values; field mappings still need actual processed and state columns, and the page never fills constants in automatically.')}</p>
            <textarea className="r1-constants" rows={3} spellCheck={false} value={constantText} onChange={event => setConstantText(event.target.value)} />
          </details>
          <details className="r1-public-time"><summary>{words('可选：公开时间（UTC）', 'Optional: public time (UTC)')}</summary>
            <label className="r1-confirm"><input type="checkbox" checked={!!publicTimeDraft} disabled={busy}
              onChange={event => togglePublicTime(event.target.checked)} />{words('这份材料另有公开时间列', 'This material also has public-time columns')}</label>
            {publicTimeDraft && <div className="r1-grid">
              <label>{words('最早公开时间列（UTC）', 'Public start column (UTC)')}<input value={publicTimeDraft.earliestUtc}
                onChange={event => patchPublicTime({ earliestUtc: event.target.value })} /></label>
              <label>{words('公开时间开区间终点列（UTC）', 'Public exclusive end column (UTC)')}<input value={publicTimeDraft.latestExclusiveUtc}
                onChange={event => patchPublicTime({ latestExclusiveUtc: event.target.value })} /></label>
              <label>{words('公开时间精度', 'Public time precision')}<select value={publicTimeDraft.precision}
                onChange={event => patchPublicTime({ precision: event.target.value as R1TimeMapping['precision'] })}><option value="day">day</option><option value="minute">minute</option><option value="second">second</option></select></label>
              <label>{words('公开时间来源时区', 'Public-time source timezone')}<input value={publicTimeDraft.sourceTimezone}
                onChange={event => patchPublicTime({ sourceTimezone: event.target.value })} /></label>
            </div>}
            <p className="r1-help">{words('公开时间缺失时保持未知；不用取得时间替代。', 'When public time is absent it remains unknown; acquisition time is never substituted.')}</p>
          </details>
        </>}
        <label>{words('目标产品合同（JSON，高级）', 'Target product contract (JSON, advanced)')}<textarea required rows={14} spellCheck={false} value={targetText} onChange={event => setTargetText(event.target.value)} /></label>
        <p className="r1-help">{words('模板空值不是事实；按真实产品合同填写对象、语义、单位、覆盖及原父快照。程序将使用公开 schema 和实际 WFD 门槛核对。',
          'Blank template values are not facts. Supply the real subject, semantics, unit, coverage and parent snapshot. The public schema and live WFD admission remain authoritative.')}</p>
        {rowMode !== 'scalar' && <details><summary>{words('多字段目标合同要核对什么', 'What the multi-field target must state')}</summary>
          <p className="r1-help">{words('目标须按真实业务对象明确身份、逐字段单位（unit_code=per_field，按字段计量）、field_definitions（字段定义）、时间与覆盖口径。若声明行情角色，还须明确相应频率、价格或数量口径及适用的复权依据。页面只读取合同字段形成映射，不补单位、身份、日历、复权或公开时间。',
            'State the real business identity, per-field units, field definitions, time and coverage in the target. Declared market roles also need their applicable frequency, price or quantity basis, and adjustment basis. The page reads contract fields for mapping and never fills units, identity, calendars, adjustments or public time.')}</p></details>}
        <button type="submit" className="primary-button" disabled={!ready || !activeMaterial || !!materialIssue || format === 'xlsx' && activeXlsxPreview?.conversionStatus !== 'complete'}>{words('仅建立新 R1 加工计划', 'Create R1 processing plan only')}</button>
      </fieldset>
    </form>
    <section className="r1-stage"><h3>{words('3 · 运行与核对真实加工', '3 · Run and verify real processing')}</h3>
      <div className="r1-grid"><label>{words('固定计划 ID', 'Fixed plan ID')}<input value={planId} disabled={busy || fixed} onChange={event => setPlanId(event.target.value)} /></label>
        <label>{words('固定输出 ID', 'Fixed output ID')}<input value={outputId} disabled={busy || fixed} onChange={event => setOutputId(event.target.value)} /></label></div>
      <div className="r1-actions"><button type="button" className="text-button" disabled={busy || !planId || fixed} onClick={() => void action(() => readPlan(planId))}>{words('读取已有 R1 计划', 'Read existing R1 plan')}</button>
        <button type="button" className="primary-button" disabled={busy || !ready || !plan || output?.state === 'structured'} onClick={() => void action(async () => { setJob(await r1Api.run(planId, newId('run'))); setNotice(words('五步运行任务已受理；请刷新核对每步产物，不会自动提交。', 'Processing accepted. Refresh to verify the actual artifacts; nothing is submitted automatically.')); })}>{words('明确运行五步加工', 'Run processing steps')}</button>
        <button type="button" className="text-button" disabled={busy} onClick={startNew}>{words('另建新请求（不改旧请求）', 'Start another request (keep old intact)')}</button></div>
      {plan && <div className="r1-proof" role="status">
        <p><strong>{words('结构状态', 'Structural state')}</strong> {String(plan.status)} · <strong>{words('输出', 'Output')}</strong> {String(output?.state ?? 'missing')} · {output?.evidenceScope === 'structural_only' ? words('仅有结构证明', 'Structural proof only') : words('尚无结构证明', 'No structural proof yet')}</p>
        <p className="r1-help">{words('结构产物只证明编码、字段、类型、行预算和摘要；语义核对与发布资格另看下方实际结果。', 'Structural output proves encoding, fields, types, row budget and digest; inspect the actual semantic result and publish eligibility separately below.')}</p>
        {proof ? <div className={`r1-proof-state r1-proof-state--${proof.quality}`}>
          <p><strong>{words('已声明字段的语义核对', 'Semantic checks for declared fields')}</strong> {words(proofLabels[proof.quality], proof.quality)} · {proof.coverage.complete
            ? words(`已核对 ${proof.coverage.checkedRows ?? '—'}/${proof.coverage.inputRows ?? '—'} 行`, `Checked ${proof.coverage.checkedRows ?? '—'}/${proof.coverage.inputRows ?? '—'} rows`)
            : words(`核对未完成（${proof.coverage.checkedRows ?? '—'}/${proof.coverage.inputRows ?? '—'} 行）`, `Check incomplete (${proof.coverage.checkedRows ?? '—'}/${proof.coverage.inputRows ?? '—'} rows)`)}</p>
          <p className="r1-help">{words('通过只覆盖已声明字段及实际执行的规则；未列规则不构成已检查。',
            'A pass covers declared fields and executed rules only. Unlisted rules were not checked.')}</p>
          <details><summary>{words('查看实际语义核对范围', 'View actual semantic check scope')}</summary>
            <p className="r1-help">{words('固定规则版本', 'Frozen rule version')}：<code>{proof.ruleVersion || '—'}</code></p>
            {proof.checkScope.length > 0 ? <ul className="r1-proof-gaps">{proof.checkScope.map((scope, index) => <li key={index}>{words(checkScopeLabels[scope] ?? '回执所列执行规则', 'Executed receipt rule')}（<code>{scope}</code>）</li>)}</ul>
              : <p className="r1-help">{words('尚无已执行语义规则范围。', 'No executed semantic rule scope is recorded.')}</p>}
          </details>
          {outputMapping && 'kind' in outputMapping && <p className="r1-help">{outputBar
            ? missingBarRoles.length ? words(`未声明 ${missingBarRoles.join('、')}；这些角色与依赖它们的关系未核对。`,
              `Undeclared roles: ${missingBarRoles.join(', ')}. Their values and dependent relationships were not checked.`)
              : words('已声明五项行情角色；是否执行了各项关系检查仍以实际规则范围为准。',
                'All five market roles are declared; the actual rule scope still determines which relationships were checked.')
            : words('本计划没有声明行情角色；不按完整 OHLCV 行情作关系核对。',
              'This plan declares no market roles; complete OHLCV relationships were not checked.')}</p>}
          {missingPublicTime && <p className="r1-help">{words('未声明公开时间；历史公开或可得时点仍待核，不由取得时间替代。',
            'Public time was not declared. Historical publication or availability remains unverified; acquisition time is not substituted.')}</p>}
          {proof.gaps.length > 0 && <ul className="r1-proof-gaps">{proof.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul>}
        </div> : <p className="r1-help">{words('本输出尚无已执行语义证明；标量路径只形成结构检查，多字段计划须待实际加工结果核对。',
          'This output has no executed semantic evidence yet. The scalar path has structural checks only; inspect actual processing results for a multi-field plan.')}</p>}
        {output?.publishEligible === true ? <p className="r1-success"><CheckCircle2 size={18} aria-hidden="true" />{words('加工侧门槛已齐；本次来源授权、准确摘要和正式提交仍须单独核对。结构成功不等于生产验收。', 'Processing prerequisites are met; this request still requires separate authorization, digest confirmation and submission. Structural success is not production acceptance.')}</p>
          : <p className="r1-help">{words('发布门槛未齐：六维用途、目标合同、结构输出及本次要求的语义核对须逐项满足。', 'Publish prerequisites are incomplete: the six purpose facts, target contract, structural output and required semantic checks must each be satisfied.')}</p>}
      </div>}
    </section>
    <section className="r1-stage"><h3>{words('4 · 核对来源并预览交接', '4 · Verify source and preview handoff')}</h3>
      <p className="r1-help">{words('来源、原件、加工与证据只留在 BD；交接文档不携带外部路径、来源包或执行信息。', 'Sources, originals, processing and evidence stay in BD; the handoff contains no external paths, source bundle or execution data.')}</p>
      <label>{words('本次原请求编号', 'Original request ID')}<input readOnly value={requestId} /></label>
      <button type="button" className="primary-button" disabled={busy || !ready || output?.publishEligible !== true || !authorizationReady || !!view} onClick={() => void action(async () => {
        if (!r1SourceReadyForHandoff(source)) throw new Error(words('本次来源、用途或授权依据未核清；BD 未准备交接。', 'The source, usage scope or authorization basis is not clear for this request; BD did not prepare the handoff.'));
        const declaration = record(record(output?.target).declaration), frozen = readMapping(declaration.mapping);
        if (!frozen) throw new Error(words('冻结计划中的字段映射无法核对；请保留原计划编号并检查合同。', 'The frozen plan mapping cannot be verified. Preserve the original plan ID and inspect the contract.'));
        const input = { requestId, planId, outputId, source, mapping: frozen, target: JSON.parse(targetText) as R1PrepareInput['target'] };
        const prepared = await r1Api.prepare(input);
        showView(prepared); setConfirmed(false); await refreshLists(); setNotice(words('已冻结文档和连接身份。追加请求将跳过相同内容，先追加无冲突新记录，冲突项保留待确认；尚未提交。', 'Document and connection identity frozen locally. Nothing has been submitted to WFD.'));
      })}>{words('仅准备并预览，不提交', 'Prepare and preview only')}</button>
    </section>
    {view && <section className="r1-stage"><h3>{words('固定文档与真实回执', 'Frozen document and actual receipt')}</h3>
      <div className="database-receipt"><strong>{words(states[view.state] ?? view.state, view.state)}</strong><span>{view.rowCount} {words('行', 'rows')} · {connectionLabel(view.connection.mode)} · {view.connection.connectionId}</span>
        <code>{view.requestId}</code><code>{view.documentSha256}</code><span>{view.datasetId} · {view.outputKey}</span>
        <span>{words('已登记存储', 'Registered store')} · {view.connection.store}</span><span>{words('已登记运行入口', 'Registered runtime')} · {view.connection.runtime}</span></div>
      <R1DuplicateResult request={view} />
      <pre className="database-text-preview">{JSON.stringify(view.previewRows, null, 2)}</pre>
      {view.requiresRecovery && <div className="database-gap"><ShieldAlert size={20} aria-hidden="true" /><p>{words('结果未知：只查询原请求，不更换编号、不重新发送。', 'Result unknown: query the original request. Do not replace its ID or resend.')}</p></div>}
      {!frozenAuthorizationReady && view.state === 'prepared_profile_pending' && <div className="database-gap"><ShieldAlert size={20} aria-hidden="true" /><div><p>{words('这份固定请求的来源、用途或授权依据有缺口或显见冲突；不能用当前输入补造原声明或提交旧请求。请核对后另建计划和请求，原编号只读保留。',
        'This frozen request has a source, usage scope or authorization gap or explicit conflict. Current inputs cannot retrofit the original declaration or submit the old request. Create a new plan and request after review; retain the original ID for read-only lookup.')}</p>
        <ul className="r1-proof-gaps">{frozenSourceGaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul></div></div>}
      {view.state === 'rejected' && <div className="database-gap"><ShieldAlert size={20} aria-hidden="true" /><div>
        <p>{words('WFD 已实际拒绝这份固定文档；原请求到此终止。查看下列原回执错误，修订材料、计划或目标后另建新请求。', 'WFD rejected this frozen document. This request is terminal. Inspect the original errors, revise the material, plan or target, and start a new request.')}</p>
        {rejectionErrors(view.error).length > 0 && <ul className="r1-proof-gaps">{rejectionErrors(view.error).map((item, index) => <li key={index}>{item.code}: {item.message}</li>)}</ul>}
        {rejectionErrors(view.error).length === 0 && view.error && <p>{text(view.error.code) || 'R1_WFD_REJECTED'}: {text(view.error.message) || words('请查看原回执详细错误。', 'Inspect the original receipt for details.')}</p>}
      </div></div>}
      {!view.submitTaskId && !view.requiresRecovery && !['associated','partially_associated','conflicts_pending','rejected'].includes(view.state) && <label className="r1-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !frozenAuthorizationReady} onChange={event => setConfirmed(event.target.checked)} />{words('我确认上述准确摘要、目标和行预览，明确交接到', 'I confirm this exact digest, target and row preview for handoff to the ')}{connectionLabel(view.connection.mode)}{words('。', '.')}</label>}
      <div className="r1-actions"><button type="button" className="primary-button" disabled={busy || !confirmed || !ready || !frozenAuthorizationReady || !!view.submitTaskId || view.requiresRecovery || ['associated','partially_associated','conflicts_pending','rejected'].includes(view.state)} onClick={() => void action(async () => {
        if (!r1SourceReadyForHandoff(frozenSource(view))) throw new Error(words('固定请求来源或授权仍有缺口或显见冲突；不能补造或提交。', 'The frozen request still has source or authorization gaps or an explicit conflict; it cannot be retrofitted or submitted.'));
        setJob(await r1Api.submit(view)); setConfirmed(false); showView(await r1Api.get(view.requestId)); setNotice(words('原交接任务已受理；只有实际逐行身份与固定读回成功才显示完成。', 'Original handoff accepted. Completion requires actual row identities and fixed readback.'));
      })}>{words('明确提交这份固定文档', 'Submit this exact document')}</button>
        <button type="button" className="text-button" disabled={busy || !ready || !view.submitTaskId || ['associated','partially_associated','conflicts_pending','rejected'].includes(view.state)} onClick={() => void action(async () => { setJob(await r1Api.recover(view.requestId, newId('lookup'))); showView(await r1Api.get(view.requestId)); await refreshLists(); })}>{words('核对原请求与固定读回', 'Query original request and fixed readback')}</button></div>
      {view.error && <pre className="database-text-preview">{JSON.stringify(view.error, null, 2)}</pre>}
      {view.state === 'rejected' && <details><summary>{words('查看 WFD 原回执', 'Inspect original WFD receipt')}</summary><pre className="database-text-preview">{JSON.stringify(record(view.local).receipt ?? view.local, null, 2)}</pre></details>}
      {view.state === 'associated' && <p className="r1-success"><CheckCircle2 size={18} aria-hidden="true" />{words('真实 WFD 行身份已固定读回，并回链到 BD；这不是正式生产验收。', 'Actual WFD row identities were read back and linked to BD. This is not production acceptance.')}</p>}
      <details><summary>{words('查看 BD 原件、来源、加工、证据与逐行关联', 'Inspect BD originals, sources, processing, evidence and row links')}</summary><pre className="database-text-preview">{JSON.stringify(view.local, null, 2)}</pre></details>
    </section>}
    <section className="r1-stage"><h3>{words('原请求恢复', 'Original-request recovery')}</h3>
      <div className="r1-actions"><label>{words('已保存的 R1 请求编号', 'Saved R1 request ID')}<input value={lookupId} onChange={event => setLookupId(event.target.value)} /></label>
        <button type="button" className="text-button" disabled={busy || !lookupId.trim()} onClick={() => void action(async () => { showView(await r1Api.get(lookupId.trim())); setConfirmed(false); })}>{words('仅读取本地回链', 'Read local links only')}</button></div>
      <p className="r1-help">{words('以下仅为最近 20 个新 profile 请求，不是完整历史。重开页面后可按原编号恢复；不会换号重放原请求。', 'Only the latest 20 new-profile requests are shown, not full history. Recover by original ID after reopening; original requests are never replayed with new identities.')}</p>
      {!recent.length && <p className="data-empty">{words('尚无新 R1 请求。', 'No new R1 requests yet.')}</p>}
      {recent.map(item => <button type="button" className="database-row database-row--button" key={item.requestId} disabled={busy} onClick={() => void action(async () => { showView(await r1Api.get(item.requestId)); setLookupId(item.requestId); setConfirmed(false); })}><span>{item.requestId}</span><span>{words(states[item.state] ?? item.state, item.state)}</span></button>)}
    </section>
    <R1ReadPanel ready={ready} />
    <StructuredQueryPanel ready={ready} />
  </div>;
}
