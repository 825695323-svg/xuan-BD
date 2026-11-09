import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { officeNative } from './office.js';
import { xlsxModelPreview } from './index.js';
import { decodeText, parseXml, zipMembers } from './formats.js';

const workbook = '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Test" sheetId="1" r:id="rId1"/></sheets></workbook>';
const relations = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
const crcTable = Array.from({ length: 256 }, (_, n) => { let value = n; for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(bytes: Buffer): number { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zip(parts: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, count = 0;
  for (const [path, xml] of Object.entries(parts)) {
    const name = Buffer.from(path), data = Buffer.from(xml), crc = crc32(data), head = Buffer.alloc(30), directory = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(head, name, data); central.push(directory, name); offset += head.length + name.length + data.length; count++;
  }
  const directoryBytes = central.reduce((sum, entry) => sum + entry.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directoryBytes, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
function fixture(sheetData: string, extras: Record<string, string> = {}): Buffer {
  return zip({ 'xl/workbook.xml': workbook, 'xl/_rels/workbook.xml.rels': relations,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetData}</worksheet>`, ...extras });
}
function convert(bytes: Buffer) { return officeNative(bytes, 'xlsx', new AbortController().signal); }
function errorCode(bytes: Buffer): string {
  try { convert(bytes); assert.fail('expected conversion failure'); } catch (error) { return (error as { code?: string }).code ?? 'UNKNOWN'; }
}

test('合成 XLSX：公式、缓存值、共享及内联字符串均保留原生表达', () => {
  const row = '<row r="1"><c r="A1"><f>B1*2</f><v>12.50</v></c><c r="B1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>内联</t></is></c></row>';
  const bytes = fixture(`<sheetData>${row}</sheetData><mergeCells count="1"><mergeCell ref="B1:C1"/></mergeCells>`,
    { 'xl/sharedStrings.xml': '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>共享</t></si></sst>' });
  const payload = convert(bytes), sheet = (payload.content as any).native.sheets[0];
  assert.equal(payload.status, 'complete'); assert.deepEqual(payload.issues, []);
  assert.equal(sheet.rows[0].cells[0].formula.expression, 'B1*2');
  assert.equal(sheet.rows[0].cells[0].rawStorage, '12.50');
  assert.equal(sheet.rows[0].cells[0].rawXml, '<c r="A1"><f>B1*2</f><v>12.50</v></c>');
  assert.equal(sheet.rows[0].cells[1].resolvedSharedString, '共享');
  assert.equal(sheet.rows[0].cells[2].inlineString, '内联');
  assert.deepEqual(sheet.mergedRanges, ['B1:C1']);
  assert.equal(sheet.rows[0].cells[0].location.part, 'xl/worksheets/sheet1.xml');
});

test('合成 XLSX：模型只看首批真实行格，UTF-8 字节预算与字段截断显式可见', () => {
  const long = '中文🙂'.repeat(100);
  const rows = Array.from({ length: 4 }, (_, index) => `<row r="${index + 1}">${['A', 'B', 'C', 'D', 'E'].map(column =>
    `<c r="${column}${index + 1}" t="inlineStr"><is><t>${long}</t></is></c>`).join('')}</row>`).join('');
  const payload = convert(fixture(`<sheetData>${rows}</sheetData>`));
  const preview = xlsxModelPreview(payload) as any;
  assert.ok(preview);
  assert.equal(preview.format, 'xlsx');
  assert.equal(preview.totalRows, 4); assert.equal(preview.totalCells, 20);
  assert.equal(preview.rows.length, 3); assert.ok(preview.rows.every((row: any) => row.cells.length >= 1));
  assert.equal(preview.rows[0].cells[0].address, 'A1');
  assert.equal(preview.rows[0].cells[0].location.part, 'xl/worksheets/sheet1.xml');
  assert.match(preview.scopeGuidance, /仅按已展示的行格原值概述/u);
  assert.match(preview.scopeGuidance, /未展示的行列视为未读/u);
  assert.match(preview.scopeGuidance, /不适合用 file\.read（读取文本）整份读取/u);
  assert.match(preview.scopeGuidance, /不得猜表头、拼整表、计算公式或宣称五步表格适配完成/u);
  assert.ok(preview.rows[0].cells[0].inlineString.startsWith('中文🙂'));
  assert.ok(preview.rows[0].cells[0].truncatedFields.includes('inlineString'));
  assert.ok(preview.rows[0].cells[0].truncatedFields.includes('rawXml'));
  assert.equal(preview.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= 6_000);
  assert.deepEqual(JSON.parse(JSON.stringify(preview)), preview);
});

test('模型预览空工作表的 JSON 转义膨胀仍守 6 KB 总预算', () => {
  const escaped = parseXml('<root value="&#x1;"/>').documentElement.getAttribute('value')!;
  assert.equal(escaped, '\u0001');
  const sheets = Array.from({ length: 8 }, () => ({ name: escaped.repeat(80), nativeId: escaped.repeat(40),
    state: escaped.repeat(40), part: escaped.repeat(120), rows: [] }));
  const preview = xlsxModelPreview({ status: 'complete', issues: [], content: { native: { sheets } } }) as any;
  assert.equal(preview.sheetCount, 8);
  assert.equal(preview.totalRows, 0); assert.equal(preview.totalCells, 0);
  assert.match(preview.scopeGuidance, /仅按已展示的行格原值概述/u);
  assert.match(preview.scopeGuidance, /未展示的行列视为未读/u);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) <= 6_000);
  assert.equal(preview.truncated, true);
});

test('合成 XLSX：坏行、错位和重复不会被分块扫描略过', () => {
  const cases: [string, string][] = [
    ['<sheetData><row r="1"><c r="A1"></row></sheetData>', 'XML_INVALID'],
    ['<sheetData>lost<row r="1"/></sheetData>', 'XLSX_STRUCTURE_INVALID'],
    ['lost<sheetData/>', 'XLSX_STRUCTURE_INVALID'],
    ['<sheetData><row r="1"><x/></row></sheetData>', 'XLSX_STRUCTURE_INVALID'],
    ['<sheetData><row r="1"><c r="A1">lost</c></row></sheetData>', 'XLSX_STRUCTURE_INVALID'],
    ['<sheetData><row r="1"/><row r="1"/></sheetData>', 'XLSX_STRUCTURE_INVALID'],
    ['<sheetData><row r="1"><c r="A2"/></row></sheetData>', 'XLSX_STRUCTURE_INVALID'],
    ['<sheetData><row r="1"><c r="A1"/><c r="A1"/></row></sheetData>', 'XLSX_STRUCTURE_INVALID'],
  ];
  for (const [xml, code] of cases) assert.equal(errorCode(fixture(xml)), code, xml);
});

test('合成 XLSX：跨簿行、单元格、元素与单行片段预算明确拒绝', () => {
  assert.equal(errorCode(fixture(`<sheetData>${'<row/>'.repeat(10_001)}</sheetData>`)), 'XLSX_ROW_LIMIT');
  assert.equal(errorCode(fixture(`<sheetData><row>${'<c/>'.repeat(100_001)}</row></sheetData>`)), 'XLSX_CELL_LIMIT');
  assert.equal(errorCode(fixture(`<x>${'<y/>'.repeat(400_001)}</x><sheetData/>`)), 'XLSX_XML_LIMIT');
  assert.equal(errorCode(fixture(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(1_000_001)}</t></is></c></row></sheetData>`)), 'XLSX_ROW_LIMIT');
  assert.equal(errorCode(fixture('<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'.replace('<v>1</v>', '<v>' + '<x>'.repeat(129) + '</x>'.repeat(129) + '</v>'))), 'XLSX_XML_LIMIT');
});

test('合成 XLSX：多工作表预算跨整个工作簿累计', () => {
  const multi = (first: string, second: string) => zip({
    'xl/workbook.xml': workbook.replace('</sheets>', '<sheet name="Test2" sheetId="2" r:id="rId2"/></sheets>'),
    'xl/_rels/workbook.xml.rels': relations.replace('</Relationships>', '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${first}</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet><sheetData>${second}</sheetData></worksheet>`,
  });
  const fiveThousand = '<row/>'.repeat(5000);
  assert.equal(convert(multi(fiveThousand, fiveThousand)).status, 'complete');
  assert.equal(errorCode(multi(fiveThousand, fiveThousand + '<row/>')), 'XLSX_ROW_LIMIT');
  const fiftyThousand = `<row>${'<c/>'.repeat(50_000)}</row>`;
  assert.equal(convert(multi(fiftyThousand, fiftyThousand)).status, 'complete');
  assert.equal(errorCode(multi(fiftyThousand, `<row>${'<c/>'.repeat(50_001)}</row>`)), 'XLSX_CELL_LIMIT');
});

test('合成 XLSX：结果累计超 64 MB 时拒绝，不扩大原件或 XML 上限', () => {
  const columns = Array.from({ length: 46 }, (_, index) => index < 26 ? String.fromCharCode(65 + index) : 'A' + String.fromCharCode(65 + index - 26));
  const value = 'x'.repeat(125);
  const rows = Array.from({ length: 2000 }, (_, index) => {
    const row = index + 1;
    return `<row r="${row}">${columns.map(column => `<c r="${column}${row}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`;
  }).join('');
  const bytes = fixture(`<sheetData>${rows}</sheetData>`);
  assert.ok(bytes.length < 20_000_000);
  assert.equal(errorCode(bytes), 'XLSX_RESULT_LIMIT');
});

test('通用 XML 的原 100,000 元素预算仍有效', () => {
  assert.throws(() => parseXml(`<root>${'<x/>'.repeat(100_000)}</root>`), (error: any) => error.code === 'XML_LIMIT');
});

test('真实 XLSX：直接与 ZIP 中原工作表 XML 核对每格原片段及关键原值', { skip: !process.env.XUAN_XLSX_REAL }, () => {
  const bytes = readFileSync(process.env.XUAN_XLSX_REAL!);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '1156fb9d5c38f9e6b81d22abfe0007da022dc6b49a5c0987c8902da8a6d851a1');
  const source = decodeText(zipMembers(bytes).find(value => value.path === 'xl/worksheets/sheet1.xml')!.read()).text;
  const payload = convert(bytes), sheet = (payload.content as any).native.sheets[0];
  assert.equal(payload.status, 'complete'); assert.deepEqual(payload.issues, []);
  assert.equal(sheet.rows.length, 1906);
  assert.equal(sheet.rows.reduce((sum: number, row: any) => sum + row.cells.length, 0), 87676);
  let position = 0;
  for (const row of sheet.rows) for (const cell of row.cells) {
    const found = source.indexOf(cell.rawXml, position); assert.ok(found >= position, cell.address);
    position = found + cell.rawXml.length;
  }
  const first = sheet.rows[0].cells[0], number = sheet.rows[950].cells[0], last = sheet.rows.at(-1).cells.at(-1);
  assert.equal(first.inlineString, '@余哈哈的数据助手 原创整理');
  assert.deepEqual(number.location, { part: 'xl/worksheets/sheet1.xml', sheet: sheet.name, cell: 'A951' });
  assert.equal(number.rawStorage, '45259'); assert.ok(number.rawXml.includes('<v>45259</v>'));
  assert.ok(last.inlineString.startsWith('TOPCON电池+无缝服装'));
  assert.equal(sheet.rows.flatMap((row: any) => row.cells).filter((cell: any) => cell.formula !== null).length, 0);
  const envelope = { schemaVersion: '1.0', implementation: { name: 'harness-native-conversion', version: '1.0.0' }, operation: 'conversion.structured',
    source: { fileRefId: '0d33b4dd-bc46-4566-85d3-94da276c8f81', fileRefVersion: 1, sha256: '1156fb9d5c38f9e6b81d22abfe0007da022dc6b49a5c0987c8902da8a6d851a1',
      bytes: bytes.length, declaredName: '涨停分布表_2023@余哈哈的数据仓库 原创整理.xlsx', detectedType: 'xlsx' }, ...payload, artifacts: [] };
  const compact = JSON.stringify(envelope), pretty = JSON.stringify(envelope, null, 2);
  assert.ok(Buffer.byteLength(compact) < 64_000_000); assert.ok(Buffer.byteLength(pretty) > 64_000_000);
  assert.deepEqual(JSON.parse(compact), JSON.parse(pretty));
});
