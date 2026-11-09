import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import { openPdf } from '../../../platform/capabilities/conversion/pdf.js';
import { TaskError } from '../../../platform/jobs/tasks.js';
import { normalizeNumericLexeme, readNumericFormat, type NumericFormat } from './numeric-format.js';

export const FINANCIAL_PDF_VERSION = 'bd-financial-pdf-regions/1';
export interface FinancialPdfSelection {
  version: typeof FINANCIAL_PDF_VERSION;
  sourceSha256: string;
  report: { id: string; version: string; subjectScheme: string; subjectCode: string; accountingStandard: string;
    currency: string; auditStatus: string };
  regions: { page: number; yMin: number; yMax: number; statement: string; scope: string; section: string;
    label: [number, number]; expectedLabels: string[]; rowBands: { yMin: number; yMax: number }[];
    columns: { xMin: number; xMax: number; dimension: string; periodType: 'instant' | 'duration';
      startDate: string; endDate: string; unit: string; numericFormat: NumericFormat }[];
    continuations?: { rowIndex: number; columnIndex: number; page: number; yMin: number; yMax: number;
      xMin: number; xMax: number; quote: string }[] }[];
}
const fail = (message: string): never => { throw new TaskError('FINANCIAL_PDF_SELECTION', message); };
const day = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
export function readFinancialPdfSelection(raw: unknown): FinancialPdfSelection {
  const value = raw as FinancialPdfSelection;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'regions,report,sourceSha256,version'
    || value.version !== FINANCIAL_PDF_VERSION || !/^[a-f0-9]{64}$/u.test(value.sourceSha256)
    || !value.report || Object.keys(value.report).sort().join(',') !== 'accountingStandard,auditStatus,currency,id,subjectCode,subjectScheme,version'
    || Object.values(value.report).some(item => typeof item !== 'string' || !item.trim() || item.length > 256)
    || !Array.isArray(value.regions) || !value.regions.length || value.regions.length > 64) fail('PDF财报须有固定原件、报告身份和明确已核定表区；不按文件名或关键词补造。');
  for (const region of value.regions) {
    if (!region || Object.keys(region).filter(key => key !== 'continuations').sort().join(',') !== 'columns,expectedLabels,label,page,rowBands,scope,section,statement,yMax,yMin'
      || !Number.isSafeInteger(region.page) || region.page < 1 || !Number.isFinite(region.yMin) || !Number.isFinite(region.yMax) || region.yMax <= region.yMin
      || ![region.statement, region.scope, region.section].every(item => typeof item === 'string' && item.trim() && item.length <= 256)
      || !Array.isArray(region.label) || region.label.length !== 2 || !region.label.every(Number.isFinite) || region.label[1] <= region.label[0]
      || !Array.isArray(region.expectedLabels) || !region.expectedLabels.length || region.expectedLabels.length > 300
      || region.expectedLabels.some(label => typeof label !== 'string' || !label || label.length > 1000)
      || !Array.isArray(region.rowBands) || region.rowBands.length !== region.expectedLabels.length
      || region.rowBands.some((band, index) => !band || Object.keys(band).sort().join(',') !== 'yMax,yMin'
        || !Number.isFinite(band.yMin) || !Number.isFinite(band.yMax) || band.yMax <= band.yMin
        || band.yMin < region.yMin || band.yMax > region.yMax || index > 0 && band.yMax > region.rowBands[index - 1]!.yMin)
      || !Array.isArray(region.columns) || !region.columns.length || region.columns.length > 32) fail('PDF表区、完整行标签或列定义不明确。');
    let previous = region.label[1];
    for (const column of region.columns) {
      if (!column || Object.keys(column).sort().join(',') !== 'dimension,endDate,numericFormat,periodType,startDate,unit,xMax,xMin'
        || !Number.isFinite(column.xMin) || !Number.isFinite(column.xMax) || column.xMax <= column.xMin || column.xMin < previous
        || !['instant', 'duration'].includes(column.periodType) || !day(column.startDate) || !day(column.endDate) || column.endDate < column.startDate
        || column.periodType === 'instant' && column.startDate !== column.endDate
        || ![column.dimension, column.unit].every(item => typeof item === 'string' && item.trim() && item.length <= 256)) fail('PDF期间、单位、范围列交叠或缺定义。');
      readNumericFormat(column.numericFormat); previous = column.xMax;
    }
    if (region.continuations !== undefined && (!Array.isArray(region.continuations) || region.continuations.length > 64
      || region.continuations.some(part => !part || Object.keys(part).sort().join(',') !== 'columnIndex,page,quote,rowIndex,xMax,xMin,yMax,yMin'
        || !Number.isSafeInteger(part.rowIndex) || part.rowIndex < 0 || part.rowIndex >= region.expectedLabels.length
        || !Number.isSafeInteger(part.columnIndex) || part.columnIndex < 0 || part.columnIndex >= region.columns.length
        || !Number.isSafeInteger(part.page) || part.page < 1 || ![part.xMin, part.xMax, part.yMin, part.yMax].every(Number.isFinite)
        || part.xMax <= part.xMin || part.yMax <= part.yMin || typeof part.quote !== 'string' || !part.quote || part.quote.length > 1024))) fail('跨页单元格续段须明确核定行列、真实页/范围和原文片段；未自动猜接。');
  }
  return structuredClone(value);
}

/** 直接读取已保管PDF的原生文字项；坐标投影只按操作者核定的表区/完整行清单执行。 */
export async function projectFinancialPdf(bytes: Buffer, raw: FinancialPdfSelection, signal: AbortSignal) {
  const selection = readFinancialPdfSelection(raw);
  if (bytes.byteLength > 25 * 1024 * 1024 || wfdSha256(bytes) !== selection.sourceSha256 || bytes.subarray(0, 5).toString() !== '%PDF-') fail('PDF字节身份/格式/预算与核定选择不符。');
  const loading = await openPdf(bytes), document = await loading.promise;
  const rows: WfdRecord[] = [], evidence: WfdRecord[] = [], seen = new Set<string>();
  const cache = new Map<number, { index: number; str: string; x: number; y: number; width: number; height: number; transform: number[] }[]>();
  let totalItems = 0;
  const readPage = async (pageNumber: number) => {
    signal.throwIfAborted();
    if (pageNumber > document.numPages) fail('所选页不存在。');
    if (!cache.has(pageNumber)) {
      const page = await document.getPage(pageNumber), content = await page.getTextContent({ disableNormalization: true });
      if ((totalItems += content.items.length) > 200_000) fail('所选PDF原生文字项超过预算。');
      cache.set(pageNumber, content.items.flatMap((item, index) => 'str' in item ? [{ index, str: item.str, x: item.transform[4]!, y: item.transform[5]!,
        width: item.width, height: item.height, transform: item.transform }] : []));
      page.cleanup();
    }
    return cache.get(pageNumber)!;
  };
  try {
    for (const region of selection.regions) {
      signal.throwIfAborted();
      const items = (await readPage(region.page)).filter(item => item.y >= region.yMin && item.y <= region.yMax && item.str.trim());
      const lines = region.rowBands.map(band => items.filter(item => item.y >= band.yMin && item.y < band.yMax));
      const reading = (a: (typeof items)[number], b: (typeof items)[number]) => Math.abs(b.y - a.y) >= 2 ? b.y - a.y : a.x - b.x;
      const cells = lines.map(line => ({ line,
        label: line.filter(item => item.x >= region.label[0] && item.x < region.label[1]).sort(reading).map(item => item.str).join('').trim(),
        values: region.columns.map(column => line.filter(item => item.x >= column.xMin && item.x < column.xMax).sort(reading).map(item => item.str).join('').trim()) }));
      // 换行的科目名与同一行实值先保留，不把跨行猜接当生产结果。
      const actual = cells.filter(row => row.label).map(row => row.label);
      if (canonicalWfdJson(actual) !== canonicalWfdJson(region.expectedLabels)) fail(`第${region.page}页所选原生行与核定完整行清单不一致；未漏行、拼行或自动猜表。实际=${actual.join('|').slice(0, 800)}`);
      if (cells.some(row => !row.label && row.values.some(Boolean))) fail('所选表区存在无科目数值行；需明确处理跨行结构。');
      if (items.some(item => item.x >= region.label[0] && item.x < region.columns.at(-1)!.xMax
        && !region.rowBands.some(band => item.y >= band.yMin && item.y < band.yMax))) fail('表区内存在未纳入核定行的原文项；未把缺行声称为完整表区。');
      for (const [rowIndex, row] of cells.entries()) {
        if (!row.label) continue;
        for (const [index, column] of region.columns.entries()) {
          let lexical = row.values[index]!;
          const continued: WfdRecord[] = [];
          for (const part of region.continuations?.filter(part => part.rowIndex === rowIndex && part.columnIndex === index) ?? []) {
            const originalItems = (await readPage(part.page)).filter(item => item.str.trim() && item.x >= part.xMin && item.x < part.xMax && item.y >= part.yMin && item.y < part.yMax).sort(reading);
            const quote = originalItems.map(item => item.str).join('').trim();
            if (quote !== part.quote) fail('跨页续段原文与核定片段不符；未部分采用或自动拼接。');
            lexical += quote; continued.push({ page: part.page, originalItems, quote, selection: part });
          }
          let value: string | null;
          // 本版缺值词典仅含空格和独立连字符；原因未披露时只记unknown，绝不认定零或不适用。
          try { value = lexical === '' || lexical === '-' ? null : normalizeNumericLexeme(lexical, column.numericFormat); }
          catch (error) { if (error instanceof TaskError) fail(`第${region.page}页「${row.label}」${column.dimension}原词面「${lexical}」不符合冻结数值语法；未猜值。`); throw error; }
          const identity = { report_id: selection.report.id, report_version: selection.report.version, subject_scheme: selection.report.subjectScheme,
            subject_code: selection.report.subjectCode, accounting_standard: selection.report.accountingStandard, currency: selection.report.currency,
            audit_status: selection.report.auditStatus, statement: region.statement, scope: region.scope, section: region.section,
            concept: row.label, dimension: column.dimension, period_type: column.periodType, start_date: column.startDate, end_date: column.endDate, unit: column.unit };
          const businessKey = 'financial_' + wfdSha256(canonicalWfdJson(identity));
          if (seen.has(businessKey)) fail('报告、范围、期间、维度与科目存在重复身份；须核定真实层级，未按页号伪造唯一键。');
          seen.add(businessKey);
          rows.push({ business_key: businessKey, ...identity, value, value_state: value === null ? 'unknown' : value === '0' ? 'reported_zero' : 'valid_value',
            start_utc: column.startDate + 'T00:00:00Z', end_utc: new Date(Date.parse(column.endDate + 'T00:00:00Z') + 86_400_000).toISOString().replace('.000Z', 'Z') });
          const originalItems = row.line.filter(item => item.x >= region.label[0] && item.x < region.label[1] || item.x >= column.xMin && item.x < column.xMax);
          evidence.push({ businessKey, page: region.page, originalLexeme: lexical, value, originalItems, continued,
            coordinateSystem: 'PDF-user-space/origin-native/transform-retained', selection: { yMin: region.yMin, yMax: region.yMax,
              label: region.label, value: [column.xMin, column.xMax] } });
        }
      }
    }
    if (!rows.length || rows.length > 5000) fail('选定财报记录超过1–5000行预算。');
    return { jsonBytes: Buffer.from(canonicalWfdJson(rows)), evidence: { adapter: FINANCIAL_PDF_VERSION, parser: 'pdfjs-dist/6.4.299',
      sourceSha256: selection.sourceSha256, sourcePages: document.numPages, selectedPages: [...cache.keys()], selectedRows: rows.length,
      selectedScopeOnly: true, missingDictionary: { '': 'unknown', '-': 'unknown' }, blankState: 'unknown-without-source-missing-reason', report: selection.report, records: evidence } };
  } finally { await loading.destroy(); }
}
