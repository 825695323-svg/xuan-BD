import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANDIDATE_LIMITS, parseTableSource, prepareCandidateTable, type CandidateTablePlan } from './candidate-pipeline.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';

// 小型合成夹具只核 CSV 结构和选件，不代表真实行情或金融语义验收。
function plan(overrides: Record<string, unknown> = {}): CandidateTablePlan {
  return { materialId: 'synthetic-csv', format: 'csv', selection: {
    predicate: { column: '证券代码', equals: '000001' }, maxSelectedRows: 5000, maxScannedRows: 2_000_000,
  }, ...overrides } as CandidateTablePlan;
}
function rejects(source: string | Uint8Array, expected: string, options = plan()): void {
  assert.throws(() => parseTableSource(typeof source === 'string' ? Buffer.from(source) : source, options),
    (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected);
}

test('CSV exact selection scans EOF, preserves every raw column/value and original BOM/CRLF/multiline location', () => {
  const text = '\ufeff证券代码,名称,原值,备注\r\n000001,"甲\r\n乙",00001.2300,"含""引号"""\r\n000002,排除,9,尾部\r\n000001,末行,01,结束';
  const bytes = Buffer.from(text), parsed = parseTableSource(bytes, plan()) as ReturnType<typeof parseTableSource> & { selection: Record<string, unknown> };
  assert.equal(parsed.rows.length, 2, '必须只返回原始字符串精确匹配的选中行');
  assert.deepEqual(parsed.source_columns, ['证券代码', '名称', '原值', '备注']);
  assert.deepEqual(parsed.rows.map(row => row.map(cell => cell.original)), [['000001', '甲\r\n乙', '00001.2300', '含"引号"'], ['000001', '末行', '01', '结束']]);
  assert.deepEqual(parsed.rows[0]![1]!.location, { start: text.indexOf('"甲'), end: text.indexOf('",00001') + 1,
    line: 2, column: 8, row: 2, field: 2 });
  assert.equal(parsed.rows[1]![0]!.location.row, 4);
  assert.equal(parsed.rows[1]![0]!.location.line, 5);
  for (const row of parsed.rows) for (const cell of row) assert.equal(text.slice(cell.location.start, cell.location.end), cell.quote);
  assert.deepEqual(parsed.selection, { predicate: { column: '证券代码', equals: '000001' }, maxSelectedRows: 5000, maxScannedRows: 2_000_000,
    selectionComplete: true, scannedRows: 3, selectedRows: 2, excludedRows: 1, sourceBytes: bytes.length, sourceSha256: wfdSha256(bytes) });
  assert.equal(parsed.source_sha256, wfdSha256(bytes));
  assert.deepEqual(parsed.adapter, { id: 'utf8-csv-exact-selection', version: '1' });
  const result = prepareCandidateTable(bytes, plan());
  assert.deepEqual(result.rows, [{ 证券代码: '000001', 名称: '甲\r\n乙', 原值: '00001.2300', 备注: '含"引号"' },
    { 证券代码: '000001', 名称: '末行', 原值: '01', 备注: '结束' }]);
  assert.deepEqual((result.evidence.check.sources[0] as unknown as Record<string, unknown>).selection, parsed.selection);
});

test('CSV exact selection uses original column names and strings before mapping, trimming or typing', () => {
  const source = Buffer.from('证券代码,值\n000001,1\n 000001,2\n1,3\n000001 ,4\n');
  const result = prepareCandidateTable(source, plan({ fieldMapping: { 证券代码: 'symbol', 值: 'value' }, trim: ['symbol'], types: { value: 'safe_integer' } }));
  assert.deepEqual(result.rows, [{ symbol: '000001', value: 1 }]);
  rejects(source, 'CANDIDATE_SELECTION_FIELD', plan({ selection: { predicate: { column: 'symbol', equals: '000001' }, maxSelectedRows: 5, maxScannedRows: 5 } }));
  rejects(source, 'CANDIDATE_EMPTY_SELECTION', plan({ selection: { predicate: { column: '证券代码', equals: 'missing' }, maxSelectedRows: 5, maxScannedRows: 5 } }));
});

test('structure records only actual type and decimal lexeme changes separately from cleaning', () => {
  const source = Buffer.from('证券代码,值,整数\n000001,31.0,30\n000001,1.2300,7\n');
  const result = prepareCandidateTable(source, plan({ types: { 值: 'decimal_string', 整数: 'safe_integer' } }));
  assert.deepEqual(result.rows, [{ 证券代码: '000001', 值: '31', 整数: 30 }, { 证券代码: '000001', 值: '1.23', 整数: 7 }]);
  assert.equal(result.evidence.check.changes_total, 0);
  assert.equal(result.evidence.check.type_changes_total, 4);
  assert.equal(result.evidence.check.decimal_lexeme_changes_total, 2);
  assert.equal(result.evidence.type_changes_total, 4);
  assert.equal(result.evidence.decimal_lexeme_changes_total, 2);
  assert.equal(result.evidence.type_changes_truncated, false);
  assert.deepEqual(result.evidence.type_changes.map(change => [change.operation, change.row, change.field, change.before, change.after]), [
    ['decimal_lexeme', 1, '值', '31.0', '31'], ['type_conversion', 1, '整数', '30', 30],
    ['decimal_lexeme', 2, '值', '1.2300', '1.23'], ['type_conversion', 2, '整数', '7', 7],
  ]);
  for (const change of result.evidence.type_changes) {
    assert.equal(change.original, change.before);
    assert.equal(source.toString('utf8').slice(change.location.start, change.location.end), change.quote);
  }
});

test('type change evidence uses the existing 1000 item window without losing total counts', () => {
  const source = Buffer.from('证券代码,值\n' + '000001,1.0\n'.repeat(1001));
  const result = prepareCandidateTable(source, plan({ types: { 值: 'decimal_string' } }));
  assert.equal(result.evidence.check.changes_total, 0);
  assert.equal(result.evidence.type_changes_total, 1001);
  assert.equal(result.evidence.decimal_lexeme_changes_total, 1001);
  assert.equal(result.evidence.type_change_window_limit, 1000);
  assert.equal(result.evidence.type_changes.length, 1000);
  assert.equal(result.evidence.type_changes_truncated, true);
  assert.equal(result.evidence.type_changes.at(-1)?.row, 1000);
});

test('CSV exact selection rejects malformed excluded tails and ambiguous headers instead of ending at the first match', () => {
  for (const suffix of ['000002,"未闭合', '000002,无引号"内容', '000002,"闭合"非法尾部']) rejects('证券代码,值\n000001,01\n' + suffix, 'INVALID_CSV_QUOTES');
  for (const suffix of ['000002', '000002,2,额外列']) rejects('证券代码,值\n000001,01\n' + suffix, 'RAGGED_CSV');
  rejects('证券代码,证券代码\n000001,2\n', 'CANDIDATE_FIELDS');
  rejects('证券代码,\n000001,2\n', 'CANDIDATE_FIELDS');
  rejects(Buffer.concat([Buffer.from('证券代码,值\n000001,01\n000002,'), Buffer.from([0xc3, 0x28])]), 'CANDIDATE_ENCODING');
});

test('CSV exact selection budgets reject excess matches or unfinished scans without truncation', () => {
  const source = '证券代码,值\n000001,1\n000002,2\n000001,3\n';
  rejects(source, 'CANDIDATE_SELECTION_ROW_BUDGET', plan({ selection: { predicate: { column: '证券代码', equals: '000001' }, maxSelectedRows: 1, maxScannedRows: 3 } }));
  rejects(source, 'CANDIDATE_SCAN_BUDGET', plan({ selection: { predicate: { column: '证券代码', equals: '000001' }, maxSelectedRows: 2, maxScannedRows: 2 } }));
  for (const maxSelectedRows of [0, -1, 5001, 1.5, Number.NaN]) rejects(source, 'CANDIDATE_SELECTION', plan({ selection: { predicate: { column: '证券代码', equals: '000001' }, maxSelectedRows, maxScannedRows: 3 } }));
  for (const maxScannedRows of [0, -1, 2_000_001, 1.5, Number.NaN]) rejects(source, 'CANDIDATE_SELECTION', plan({ selection: { predicate: { column: '证券代码', equals: '000001' }, maxSelectedRows: 2, maxScannedRows } }));
  rejects('[{"证券代码":"000001"}]', 'CANDIDATE_SELECTION', plan({ format: 'json' }));
  rejects(new Uint8Array(CANDIDATE_LIMITS.maxObjectBytes + 1), 'CANDIDATE_PARSE_BUDGET');
  rejects(source, 'CANDIDATE_SELECTION', plan({ selection: { predicate: { column: '证券代码', equals: 1 }, maxSelectedRows: 2, maxScannedRows: 3 } }));
  rejects(source, 'CANDIDATE_SELECTION', plan({ selection: { predicate: { column: '证券代码', equals: '000001', contains: '1' }, maxSelectedRows: 2, maxScannedRows: 3 } }));
  const maxSource = Buffer.from('证券代码,值\n' + '000001,值\n'.repeat(5000));
  assert.equal(parseTableSource(maxSource, plan()).rows.length, 5000);
  rejects(Buffer.concat([maxSource, Buffer.from('000001,第5001行\n')]), 'CANDIDATE_SELECTION_ROW_BUDGET');
});

test('CSV exact selection retains CSV newline/empty-field grammar and applies cell and column limits to excluded rows', () => {
  for (const ending of ['', '\n', '\r', '\r\n']) {
    const source = '证券代码,值,空字段\r000002,排除,\r000001,"甲\r乙",' + ending;
    const parsed = parseTableSource(Buffer.from(source), plan());
    assert.deepEqual(parsed.rows[0]!.map(cell => cell.original), ['000001', '甲\r乙', '']);
    for (const cell of parsed.rows[0]!) assert.equal(source.slice(cell.location.start, cell.location.end), cell.quote);
  }
  rejects('证券代码,值\n000001,匹配\n000002,' + 'x'.repeat(1_048_577), 'CELL_BUDGET');
  rejects('证券代码,值\n000001,匹配\n000002,"' + 'x'.repeat(1_048_577) + '"', 'CELL_BUDGET');
  rejects('证券代码,值\n000001,匹配\n000002,' + Array.from({ length: 256 }, () => 'x').join(','), 'COLUMN_BUDGET');
});

test('CSV exact selection can scan more than 100000 rows while the unselected default retains its original row budget', () => {
  const source = Buffer.from('证券代码,值\n000001,开头\n' + '000002,排除\n'.repeat(100_000) + '000001,结尾\n');
  rejects(source, 'ROW_BUDGET', { materialId: 'synthetic-csv', format: 'csv' });
  const parsed = parseTableSource(source, plan()) as ReturnType<typeof parseTableSource> & { selection: Record<string, unknown> };
  assert.deepEqual(parsed.rows.map(row => row[1]!.original), ['开头', '结尾']);
  assert.equal(parsed.selection.scannedRows, 100_002);
  assert.equal(parsed.selection.excludedRows, 100_000);
  assert.equal(CANDIDATE_LIMITS.maxRows, 100_000);
});

test('CSV exact selection alone permits a source above 64 MiB and keeps the complete source digest', () => {
  const row = '000002,' + 'x'.repeat(1024) + '\n', repetitions = Math.floor(CANDIDATE_LIMITS.maxStructuredBytes / row.length) + 1;
  const source = Buffer.from('证券代码,值\n000001,完整选中\n' + row.repeat(repetitions) + '000001,最终选中\n');
  assert.ok(source.length > CANDIDATE_LIMITS.maxStructuredBytes);
  rejects(source, 'CANDIDATE_PARSE_BUDGET', { materialId: 'synthetic-csv', format: 'csv' });
  const parsed = parseTableSource(source, plan()) as ReturnType<typeof parseTableSource> & { selection: Record<string, unknown> };
  assert.deepEqual(parsed.rows.map(row => row[1]!.original), ['完整选中', '最终选中']);
  assert.equal(parsed.selection.scannedRows, repetitions + 2);
  assert.equal(parsed.selection.sourceSha256, wfdSha256(source));
  assert.equal(CANDIDATE_LIMITS.maxStructuredBytes, 67_108_864);
});


test('显式表格保留继承属性同名列，不静默改名或遗漏', () => {
  const keys = ['constructor', 'toString', '__proto__'];
  const row = Object.fromEntries(keys.map(key => [key, '1.2300']));
  const types = Object.fromEntries(keys.map(key => [key, 'decimal_string'])) as CandidateTablePlan['types'];
  for (const declared of [undefined, types]) {
    const result = prepareCandidateTable(Buffer.from(JSON.stringify([row])), { materialId: 'own-keys', format: 'json', ...(declared ? { types: declared } : {}) });
    assert.deepEqual(result.rows, [Object.fromEntries(keys.map(key => [key, declared ? '1.23' : '1.2300']))]);
    assert.deepEqual(result.evidence.fields, keys);
  }
});
