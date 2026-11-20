import { isWfdRecord, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { readFinancialPdfSelection, type FinancialPdfSelection } from './financial-pdf.js';
import { FINANCIAL_COLUMN_ROLES, FINANCIAL_SCOPES, type FinancialColumnRole,
  type FinancialStatementScope } from './financial-temporal-pairing.js';
import { readXbrlSelection, type XbrlSelection } from './xbrl-table.js';
import { readXlsxTableSelection, type XlsxTableSelection } from './xlsx-table.js';

export const FINANCIAL_L1_TEMPLATE_VERSION = 'bd-financial-l1-template/1';

interface PdfScopePage {
  page: number;
  titleRows: readonly string[];
  columnRole?: FinancialColumnRole;
}

const templateError = (message: string): never => { throw new TaskError('FINANCIAL_L1_TEMPLATE', message); };
const scopeError = (message: string): never => { throw new TaskError('FINANCIAL_L1_SCOPE_MISMATCH', message); };
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const onlyKeys = (value: unknown, keys: readonly string[]): value is WfdRecord =>
  isWfdRecord(value) && Object.keys(value).every(key => keys.includes(key));

function pdfTitleScopes(title: string) {
  const compact = title.replace(/\s/gu, '');
  const nonConsolidated = /\bnon[-\s]?consolidated\b/giu;
  const nonConsolidatedChinese = /非合[并併]/gu;
  const consolidated = /合[并併]/u.test(compact.replace(nonConsolidatedChinese, ''))
    || /\bconsolidated\b/iu.test(title.replace(nonConsolidated, ''));
  const parent = /母公司|[个個][别別](?:[财財][务務])?[报報]表/u.test(compact) || nonConsolidatedChinese.test(compact)
    || /\b(?:parent|separate|unconsolidated|stand[-\s]?alone)\b/iu.test(title) || nonConsolidated.test(title);
  return { consolidated, parent };
}

export function guardFinancialPdfInterveningTitle(scope: string, page: number, text: string): void {
  const title = text.normalize('NFKC').trim();
  const compact = title.replace(/\s/gu, '');
  const statementTitle = /(?:[资資][产產][负負][债債]|[现現]金流量|利[润潤]|[损損]益|收益|[权權]益[变變][动動]|[财財][务務][状狀][况況]|[报報])表/u.test(compact)
    || /\b(?:statements?|balance\s+sheets?|profit\s+and\s+loss)\b/iu.test(title);
  const scopeTitle = /^(?:母公司|(?:非)?合[并併]|[个個][别別])$/u.test(compact)
    || /^(?:parent(?:\s+company)?|separate|(?:non[-\s]?|un)?consolidated|stand[-\s]?alone)$/iu.test(title);
  if (!statementTitle && !scopeTitle) return;
  const { consolidated, parent } = pdfTitleScopes(title);
  if (consolidated && scope === 'parent_only' || parent && scope === 'consolidated')
    scopeError(`第 ${page} 页在所引标题与取数范围之间出现相反范围的报表标题。`);
}

export function guardFinancialPdfTableScope(input: {
  scope: FinancialStatementScope;
  columnRole: FinancialColumnRole;
  pages: readonly PdfScopePage[];
}): void {
  if (!FINANCIAL_SCOPES.includes(input.scope) || !FINANCIAL_COLUMN_ROLES.includes(input.columnRole)
    || !Array.isArray(input.pages) || !input.pages.length) {
    scopeError('PDF 表区须明确报表范围、列角色及每个选区和续段的标题行。');
  }
  for (const page of input.pages) {
    if (!page || !Number.isSafeInteger(page.page) || page.page < 1
      || !Array.isArray(page.titleRows) || !page.titleRows.length || !page.titleRows.every(nonempty)
      || page.columnRole !== undefined && page.columnRole !== input.columnRole) {
      scopeError('PDF 表区或续表缺少明确页码和标题行，或列角色与首表不一致。');
    }
    const { consolidated, parent } = pdfTitleScopes(page.titleRows.join(' ').normalize('NFKC'));
    if (consolidated && parent || consolidated && input.scope !== 'consolidated'
      || parent && input.scope !== 'parent_only' || !consolidated && !parent) {
      scopeError(`第 ${page.page} 页标题与已声明报表范围 ${input.scope} 不一致或无法确认。`);
    }
  }
}

interface PdfRegionHeader {
  columns: { columnRole: FinancialColumnRole; declaredUnit: string }[];
  pages: { page: number; titleRows: { text: string; yMin: number; yMax: number }[];
    columnRoles?: FinancialColumnRole[] }[];
}
type XbrlAxisBinding = { sourceAxis: string; l2Axis: string }
  & ({ kind: 'explicit' } | { kind: 'typed'; typedDomain: string });
type FinancialL1Template = {
  version: typeof FINANCIAL_L1_TEMPLATE_VERSION;
  preserveOriginalLexeme: true;
  preserveDeclaredUnit: true;
} & (
  | { kind: 'pdf_regions'; selection: FinancialPdfSelection; regionHeaders: PdfRegionHeader[] }
  | { kind: 'xlsx_rectangles'; rectangles: { selection: XlsxTableSelection; declaredUnits: Record<string, string> }[] }
  | { kind: 'xbrl_dimensions'; selection: XbrlSelection; axisBindings: XbrlAxisBinding[] }
);
type PdfL1Template = Extract<FinancialL1Template, { kind: 'pdf_regions' }>;
type ScopedPdfSelection = FinancialPdfSelection & { scope: FinancialStatementScope; regionHeaders: PdfRegionHeader[] };
export type FinancialPdfProjection = FinancialPdfSelection | ScopedPdfSelection | PdfL1Template;

const common = ['version', 'kind', 'preserveOriginalLexeme', 'preserveDeclaredUnit'];
const expandedName = (value: unknown): value is string =>
  typeof value === 'string' && /^\{[^{}]+\}[A-Za-z_][\w.-]*$/u.test(value);

function assertPdfL1RegionHeaders(selection: FinancialPdfSelection, headers: unknown): asserts headers is PdfRegionHeader[] {
  if (!Array.isArray(headers) || headers.length !== selection.regions.length)
    return scopeError('PDF 标题证据须和选区逐一对应。');
  for (const [index, region] of selection.regions.entries()) {
    const header = headers[index];
    if (!onlyKeys(header, ['columns', 'pages']) || !Array.isArray(header.columns)
      || header.columns.length !== region.columns.length) {
      return templateError('PDF 每个所选列须对应一个列角色和声明单位。');
    }
    const segments = [region, ...(region.continuations ?? [])];
    if (!Array.isArray(header.pages) || header.pages.length !== segments.length
      || !header.pages.every((page, segmentIndex) => onlyKeys(page, ['page', 'titleRows', 'columnRoles'])
        && page.page === segments[segmentIndex]!.page && Array.isArray(page.titleRows) && page.titleRows.every(row =>
          onlyKeys(row, ['text', 'yMin', 'yMax']) && nonempty(row.text)
          && typeof row.yMin === 'number' && typeof row.yMax === 'number'
          && Number.isFinite(row.yMin) && Number.isFinite(row.yMax) && row.yMin < row.yMax
          && row.yMin > segments[segmentIndex]!.yMax)
        && (page.columnRoles === undefined || Array.isArray(page.columnRoles)
          && page.columnRoles.length === region.columns.length && page.columnRoles.every(role => FINANCIAL_COLUMN_ROLES.includes(role))))) {
      return scopeError('PDF 主表及每个续段须按选区顺序绑定同页取数区上方的标题原文和坐标。');
    }
    for (const [columnIndex, column] of header.columns.entries()) {
      if (!onlyKeys(column, ['columnRole', 'declaredUnit']) || !nonempty(column.declaredUnit))
        return templateError('PDF 所选列须保留表头单位原文。');
      guardFinancialPdfTableScope({
        scope: region.scope as FinancialStatementScope,
        columnRole: column.columnRole as FinancialColumnRole,
        pages: (header.pages as PdfRegionHeader['pages']).map(page => ({
          page: page.page, titleRows: page.titleRows.map(row => row.text), columnRole: page.columnRoles?.[columnIndex],
        })),
      });
    }
  }
}

export function readFinancialPdfProjection(raw: unknown): FinancialPdfProjection {
  if (isWfdRecord(raw) && raw.kind === 'pdf_regions') {
    const template = validateFinancialL1Template(raw);
    if (template.kind === 'pdf_regions') return template;
  }
  if (isWfdRecord(raw) && (Object.hasOwn(raw, 'scope') || Object.hasOwn(raw, 'regionHeaders'))) {
    const { scope, regionHeaders, ...rawSelection } = raw;
    const selection = readFinancialPdfSelection(rawSelection);
    if ((scope !== 'consolidated' && scope !== 'parent_only') || selection.regions.some(region => region.scope !== scope))
      return scopeError('显式声明的 PDF 报表范围须与每个选区一致。');
    assertPdfL1RegionHeaders(selection, regionHeaders);
    return { ...selection, scope, regionHeaders: structuredClone(regionHeaders) };
  }
  const selection = readFinancialPdfSelection(raw);
  if (selection.regions.some(region => region.continuations?.length))
    return scopeError('含续段的 PDF 选区须为主表及每段续表提供同范围标题原文和坐标。');
  return selection;
}

export function validateFinancialL1Template(raw: unknown): FinancialL1Template {
  if (!isWfdRecord(raw) || raw.version !== FINANCIAL_L1_TEMPLATE_VERSION
    || raw.preserveOriginalLexeme !== true || raw.preserveDeclaredUnit !== true) {
    return templateError('L1 模板须明确版本，并保留单元格原词面和声明单位。');
  }
  if (raw.kind === 'pdf_regions') {
    if (!onlyKeys(raw, [...common, 'selection', 'regionHeaders']))
      return templateError('PDF 模板须逐区声明标题、列角色及原始单位。');
    const selection = readFinancialPdfSelection(raw.selection);
    assertPdfL1RegionHeaders(selection, raw.regionHeaders);
  } else if (raw.kind === 'xlsx_rectangles') {
    if (!onlyKeys(raw, [...common, 'rectangles']) || !Array.isArray(raw.rectangles) || !raw.rectangles.length)
      return templateError('XLSX 模板须包含一个或多个明确的工作表矩形。');
    for (const rectangle of raw.rectangles) {
      if (!onlyKeys(rectangle, ['selection', 'declaredUnits']) || !isWfdRecord(rectangle.declaredUnits))
        return templateError('XLSX 矩形须保留所选数值列的表头单位原文。');
      const selection = readXlsxTableSelection(rectangle.selection);
      const units = rectangle.declaredUnits;
      if (!Object.keys(units).length || Object.entries(units).some(([name, unit]) =>
        !nonempty(unit) || !selection.columns.some(column => column.name === name))
        || selection.columns.some(column => (column.type === 'decimal_string' || column.type === 'safe_integer')
          && !Object.hasOwn(units, column.name))) {
        return templateError('XLSX 矩形声明单位须对应所选输出列，并覆盖数值列。');
      }
    }
  } else if (raw.kind === 'xbrl_dimensions') {
    if (!onlyKeys(raw, [...common, 'selection', 'axisBindings']) || !Array.isArray(raw.axisBindings))
      return templateError('XBRL 模板须明确声明维度轴到 L2 轴的绑定。');
    readXbrlSelection(raw.selection);
    const sourceAxes = new Set<string>(), l2Axes = new Set<string>();
    for (const binding of raw.axisBindings) {
      if (!onlyKeys(binding, ['kind', 'sourceAxis', 'l2Axis', 'typedDomain'])
        || !expandedName(binding.sourceAxis) || typeof binding.l2Axis !== 'string'
        || !/^[a-z][a-z0-9_.]*$/u.test(binding.l2Axis)
        || !(binding.kind === 'explicit' && !Object.hasOwn(binding, 'typedDomain')
          || binding.kind === 'typed' && expandedName(binding.typedDomain))
        || sourceAxes.has(binding.sourceAxis) || l2Axes.has(binding.l2Axis)) {
        return templateError('XBRL 轴须唯一绑定到明确的 L2 轴，类型化轴还须声明带命名空间的值域。');
      }
      sourceAxes.add(binding.sourceAxis);
      l2Axes.add(binding.l2Axis);
    }
  } else {
    return templateError('L1 模板须声明受支持的原件选区类型。');
  }
  return structuredClone(raw) as FinancialL1Template;
}
