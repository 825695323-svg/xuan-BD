import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { officeNative } from '../../../platform/capabilities/conversion/office.js';
import { parseTableSource } from '../candidate-pipeline.js';
import { projectXlsxNativeSelection, readXlsxTableSelection, type XlsxTableSelection } from './xlsx-table.js';

const workbook = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="明示表" sheetId="1" r:id="rId1"/></sheets></workbook>';
const relations = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
const crcTable = Array.from({ length: 256 }, (_, n) => { let value = n; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zip(parts: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, count = 0;
  for (const [path, xml] of Object.entries(parts)) {
    const name = Buffer.from(path), data = Buffer.from(xml), crc = crc32(data), head = Buffer.alloc(30), directory = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(20, 8); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(head, name, data); central.push(directory, name); offset += head.length + name.length + data.length; count++;
  }
  const centralLength = central.reduce((sum, entry) => sum + entry.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralLength, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
function fixture(sheet: string): Buffer {
  return zip({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': relations,
    'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>主体</t></si><si><t>甲公司</t></si><si><t>乙公司</t></si></sst>',
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheet}</worksheet>` });
}
const header = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c><c r="C1" t="inlineStr"><is><t>标志</t></is></c><c r="D1" t="inlineStr"><is><t>说明</t></is></c></row>';
const row2 = '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="2"><v>9007199254740993</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="inlineStr"><is><t>原样</t></is></c></row>';
const row3 = '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>1.2300</v></c><c r="C3" t="b"><v>0</v></c><c r="D3" t="str"><v>2026-10-31</v></c></row>';
const sheet = `<sheetData>${header}${row2}${row3}</sheetData>`;
const selection: XlsxTableSelection = { sheetName: '明示表', headerRow: 1, firstDataRow: 2, lastDataRow: 3,
  firstColumn: 'A', lastColumn: 'D', columns: [
    { column: 'A', header: '主体', name: 'entity' }, { column: 'B', header: '金额', name: 'amount', type: 'decimal_string' },
    { column: 'C', header: '标志', name: 'flag', type: 'boolean' }, { column: 'D', header: '说明', name: 'note' },
  ] };
const project = (xml = sheet, chosen = selection) => {
  const bytes = fixture(xml), payload = officeNative(bytes, 'xlsx', new AbortController().signal);
  return projectXlsxNativeSelection(payload, wfdSha256(bytes), chosen);
};
const code = (expected: string) => (error: unknown): boolean => (error as { code?: string }).code === expected;

test('显式矩形投影保留大整数词面、共享串原文、布尔原值与 XLSX 准确坐标；JSON 可进既有解析步', () => {
  const result = project(), rows = JSON.parse(result.jsonBytes.toString('utf8'));
  assert.deepEqual(rows, [
    { entity: '甲公司', amount: '9007199254740993', flag: true, note: '原样' },
    { entity: '乙公司', amount: '1.2300', flag: false, note: '2026-10-31' },
  ]);
  assert.equal(result.jsonSha256, wfdSha256(result.jsonBytes));
  assert.deepEqual({ ...result.planTypes }, { amount: 'decimal_string', flag: 'boolean' });
  assert.equal(result.evidence.parserVersion, '1');
  assert.equal(result.evidence.sourceSha256.length, 64);
  assert.equal(result.evidence.sheetPart, 'xl/worksheets/sheet1.xml');
  assert.equal(result.evidence.columns[0]!.cell.location.cell, 'A1');
  assert.match(result.evidence.columns[0]!.cell.sharedStringRawXml!, /<t>主体<\/t>/u);
  assert.equal(result.evidence.rows[0]!.cells[1]!.rawStorage, '9007199254740993');
  assert.equal(result.evidence.rows[0]!.cells[1]!.rawXml, '<c r="B2" s="2"><v>9007199254740993</v></c>');
  assert.equal(result.evidence.rows[0]!.cells[1]!.location.cell, 'B2');
  assert.equal(result.evidence.rows[0]!.cells[1]!.styleIndex, '2');
  assert.equal(result.evidence.rows[1]!.cells[3]!.rawStorage, '2026-10-31');
  assert.equal(result.evidence.projectionLocation, 'derived-json-only');
  const parsed = parseTableSource(result.jsonBytes, { materialId: 'explicit-selection', format: 'json', types: result.planTypes });
  assert.equal(parsed.rows[0]![1]!.original, '9007199254740993');
  assert.equal(parsed.rows[1]![1]!.original, '1.2300');
  assert.equal(parsed.rows[0]![2]!.original, true);
});

test('选区声明冻结时拒绝缺列、超限、重复表头、重复输出名和未开放类型', () => {
  assert.deepEqual(readXlsxTableSelection(selection), selection);
  assert.throws(() => readXlsxTableSelection({ ...selection, lastColumn: 'E' }), code('XLSX_SELECTION_LIMIT'));
  assert.throws(() => readXlsxTableSelection({ ...selection, lastDataRow: 5002 }), code('XLSX_SELECTION'));
  assert.throws(() => readXlsxTableSelection({ ...selection, columns: selection.columns.map((item, i) => i === 1 ? { ...item, header: '主体' } : item) }), code('XLSX_DUPLICATE_HEADER'));
  assert.throws(() => readXlsxTableSelection({ ...selection, columns: selection.columns.map((item, i) => i === 1 ? { ...item, name: 'entity' } : item) }), code('XLSX_DUPLICATE_FIELD'));
  assert.throws(() => readXlsxTableSelection({ ...selection, columns: selection.columns.map((item, i) => i === 1 ? { ...item, type: 'binary64_hex' } : item) }), code('XLSX_SELECTION'));
  assert.throws(() => readXlsxTableSelection({ ...selection, unreviewed: true }), code('XLSX_SELECTION'));
});

test('列名恰为 JavaScript 原型属性时也完整保留，不能静默漏列', () => {
  const chosen: XlsxTableSelection = { ...selection, columns: selection.columns.map((item, i) => i === 0
    ? { ...item, name: '__proto__', type: 'string' } : item) };
  const result = project(sheet, chosen), rows = JSON.parse(result.jsonBytes.toString('utf8'));
  assert.equal(Object.hasOwn(rows[0], '__proto__'), true);
  assert.equal(rows[0].__proto__, '甲公司');
  assert.equal(result.planTypes.__proto__, 'string');
});

test('公式缓存、合并格、缺格、缺行、日期型和表头不符均不投影为成功行表', () => {
  assert.throws(() => project(sheet.replace('<v>9007199254740993</v>', '<f>A2*2</f><v>9007199254740993</v>')), code('XLSX_FORMULA'));
  assert.throws(() => project(sheet + '<mergeCells><mergeCell ref="B1:C2"/></mergeCells>'), code('XLSX_MERGE'));
  assert.throws(() => project(sheet.replace('<c r="B3"><v>1.2300</v></c>', '')), code('XLSX_NON_RECTANGULAR'));
  assert.throws(() => project(sheet.replace(row3, '')), code('XLSX_NON_RECTANGULAR'));
  assert.throws(() => project(sheet.replace('<c r="B3"><v>1.2300</v></c>', '<c r="B3" t="d"><v>2026-10-31</v></c>')), code('XLSX_CELL_TYPE'));
  assert.throws(() => project(sheet, { ...selection, columns: selection.columns.map((item, i) => i === 1 ? { ...item, header: '总额' } : item) }), code('XLSX_HEADER_MISMATCH'));
});

test('G01 retained counterexample keeps source formula and stale 999 cache distinct; unsupported recomputation cannot publish the cache', () => {
  const body = `<sheetData>${header}` + [
    '<row r="4"><c r="B4"><v>12345.67</v></c></row>',
    '<row r="5"><c r="B5"><v>9000</v></c></row>',
    '<row r="6"><c r="B6"><f>B4-B5</f><v>999</v></c></row>',
  ].join('') + '</sheetData>';
  const bytes = fixture(body), native = officeNative(bytes, 'xlsx', new AbortController().signal);
  const cells = (native.content as any).native.sheets[0].rows.flatMap((row: any) => row.cells);
  const b6 = cells.find((cell: any) => cell.address === 'B6');
  assert.equal(cells.find((cell: any) => cell.address === 'B4').rawStorage, '12345.67');
  assert.equal(cells.find((cell: any) => cell.address === 'B5').rawStorage, '9000');
  assert.equal(b6.formula.expression, 'B4-B5'); assert.equal(b6.rawStorage, '999');
  const chosen: XlsxTableSelection = { sheetName: '明示表', headerRow: 1, firstDataRow: 4, lastDataRow: 6,
    firstColumn: 'B', lastColumn: 'B', columns: [{ column: 'B', header: '金额', name: 'amount', type: 'decimal_string' }] };
  assert.throws(() => projectXlsxNativeSelection(native, wfdSha256(bytes), chosen), code('XLSX_FORMULA'));
  // Independent expected arithmetic documents the retained counterexample; it is not a source value or an installed workbook evaluator.
  assert.equal(1234567n - 900000n, 334567n);
});

test('转换部分成功、原生错误和未验证 SHA 不被当作合格行表', () => {
  const bytes = fixture(sheet), payload = officeNative(bytes, 'xlsx', new AbortController().signal);
  assert.throws(() => projectXlsxNativeSelection({ ...payload, status: 'partial', issues: [{ code: 'GAP', message: '缺口' }] }, wfdSha256(bytes), selection), code('XLSX_CONVERSION'));
  assert.throws(() => projectXlsxNativeSelection(payload, 'unknown', selection), code('XLSX_CONVERSION'));
  assert.throws(() => project(sheet.replace('<c r="B3"><v>1.2300</v></c>', '<c r="B3" t="e"><v>#N/A</v></c>')), code('XLSX_CELL_TYPE'));
});

test('明确选择的真实 XLSX 小矩形只读回核原件与来源定位', { skip: !process.env.XUAN_XLSX_REAL }, () => {
  const bytes = readFileSync(process.env.XUAN_XLSX_REAL!);
  const sha = wfdSha256(bytes);
  assert.equal(sha, '1156fb9d5c38f9e6b81d22abfe0007da022dc6b49a5c0987c8902da8a6d851a1');
  const payload = officeNative(bytes, 'xlsx', new AbortController().signal);
  const result = projectXlsxNativeSelection(payload, sha, { sheetName: '数据@余哈哈的数据助手 原创整理', headerRow: 2,
    firstDataRow: 3, lastDataRow: 4, firstColumn: 'A', lastColumn: 'C', columns: [
      { column: 'A', header: '交易日', name: 'date_serial' }, { column: 'B', header: '股票代码', name: 'stock_code' },
      { column: 'C', header: '股票名称', name: 'stock_name' },
    ] });
  const rows = JSON.parse(result.jsonBytes.toString('utf8'));
  assert.deepEqual(rows[0], { date_serial: '45231', stock_code: '603390', stock_name: '通达电气' });
  assert.equal(result.evidence.rows[0]!.cells[0]!.location.cell, 'A3');
  assert.equal(result.evidence.rows[0]!.cells[0]!.rawStorage, '45231');
  assert.equal(result.evidence.rows[0]!.cells[1]!.location.cell, 'B3');
  assert.equal(wfdSha256(readFileSync(process.env.XUAN_XLSX_REAL!)), sha);
});

test('选区拒绝数组/共享公式覆盖的缓存格，即使公式锚点在所选列外', () => {
  const chosen: XlsxTableSelection = { sheetName: '明示表', headerRow: 1, firstDataRow: 2, lastDataRow: 2,
    firstColumn: 'C', lastColumn: 'C', columns: [{ column: 'C', header: '缓存', name: 'cached' }] };
  const sample = (attributes: string) => '<sheetData><row r="1"><c r="C1" t="inlineStr"><is><t>缓存</t></is></c></row><row r="2"><c r="B2"><f ' + attributes + '>1+1</f><v>2</v></c><c r="C2"><v>2</v></c></row></sheetData>';
  for (const kind of ['array', 'shared']) assert.throws(() => project(sample(`t="${kind}" ref="B2:C2"`), chosen), code('XLSX_FORMULA'));
  assert.throws(() => project(sample('t="array" ref="invalid"'), chosen), code('XLSX_FORMULA'));
  assert.throws(() => project(sample('t="array"'), chosen), code('XLSX_FORMULA'));
  assert.deepEqual(JSON.parse(project(sample('t="array" ref="A2:B2"'), chosen).jsonBytes.toString()), [{ cached: '2' }]);
});
