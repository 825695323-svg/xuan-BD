import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalWfdJson, wfdSha256 } from '../../../adapters/database/wfd-transport.js';
import { parseTableSource, structureCandidateTable, checkCandidateTables, type CandidateTablePlan } from '../candidate-pipeline.js';
import { normalizeNumericLexeme, type NumericFormat } from './numeric-format.js';
import { projectXbrlTable, type XbrlSelection } from './xbrl-table.js';
import { NECESSARY_TEXT_VERSION, type NecessaryTextSelection } from './necessary-text.js';

/** 测试只执行显式需要的解析、类型转换与核对，不触发清洗/标注。 */
function inspectDeclared(source: Uint8Array, plan: CandidateTablePlan) {
  const parsed = parseTableSource(source, plan);
  const structured = structureCandidateTable(parsed, plan.types);
  return checkCandidateTables([structured]);
}

const european: NumericFormat = { decimal: ',', grouping: '.', negative: 'minus_or_parentheses', plus: false, percent: 'reject' };
const english: NumericFormat = { ...european, decimal: '.', grouping: ',' };
const selection: XbrlSelection = { version: 'bd-xbrl-numeric/1', reportId: 'real-regression-contract', reportVersion: 'v1', concepts: [] };
const xml = (prefix = 'xbrli', scheme = 'https://id.example/one', code = '000001', value = '1234.56') => `<?xml version="1.0"?>
<${prefix}:xbrl xmlns:${prefix}="http://www.xbrl.org/2003/instance" xmlns:gaap="urn:example:gaap" xmlns:iso4217="http://www.xbrl.org/2003/iso4217">
<${prefix}:context id="c"><${prefix}:entity><${prefix}:identifier scheme="${scheme}">${code}</${prefix}:identifier></${prefix}:entity><${prefix}:period><${prefix}:startDate>2024-01-01</${prefix}:startDate><${prefix}:endDate>2024-06-30</${prefix}:endDate></${prefix}:period></${prefix}:context>
<${prefix}:unit id="u"><${prefix}:measure>iso4217:CNY</${prefix}:measure></${prefix}:unit><gaap:Revenue contextRef="c" unitRef="u" decimals="2">${value}</gaap:Revenue></${prefix}:xbrl>`;
const rows = (source: string) => JSON.parse(projectXbrlTable(Buffer.from(source), selection).jsonBytes.toString());

test('J06 same lexical counterexample is rejected under incompatible grammar and exactly decoded under declared grammar', () => {
  assert.throws(() => inspectDeclared(Buffer.from('[{"value":"1.234,56"}]'), { materialId: 'j06', format: 'json', types: { value: 'decimal_string' } }), /数字字面量/u);
  assert.equal(normalizeNumericLexeme('1.234,56', european), '1234.56');
  assert.throws(() => normalizeNumericLexeme('1.234,56', english));
  for (const value of ['12.34,56', '1.23.456,78', '1,2,3', '001', '', 'NaN', 'Infinity', '1 234,56']) assert.throws(() => normalizeNumericLexeme(value, european), value);
  assert.equal(normalizeNumericLexeme('(9.007.199.254.740.993,01)', european), '-9007199254740993.01');
  const processed = inspectDeclared(Buffer.from('[{"code":"000001","value":"1.234,56"}]'), { materialId: 'j06-good', format: 'json', types: { value: 'decimal_string' }, numericFormats: { value: european } });
  assert.equal(processed.rows[0]!.value, '1234.56');
  assert.equal(processed.rows[0]!.code, '000001');
  assert.equal(parseTableSource(Buffer.from('[{"value":"1.234,56"}]'), { materialId: 'j06-original', format: 'json' }).rows[0]![0]!.original, '1.234,56');
});

test('I05 namespace URI plus local name yields the same business identity for equivalent prefixes', () => {
  const first = rows(xml()), renamed = rows(xml('arbitrary'));
  assert.deepEqual(first, renamed);
  const renamedConcept = xml().replaceAll('gaap:', 'alt:').replace('xmlns:gaap=', 'xmlns:alt=');
  assert.deepEqual(rows(renamedConcept), first);
  assert.equal(first[0].entity_code, '000001');
  assert.equal(first[0].concept, '{urn:example:gaap}Revenue');
  const original = xml().replace('contextRef="c" unitRef="u"', 'contextRef="c"\n unitRef="u"');
  const proof = projectXbrlTable(Buffer.from(original), selection).evidence.facts[0]!.locations as { start: number; line: number; column: number }[];
  const start = original.indexOf('<gaap:Revenue');
  assert.equal(proof[0]!.start, start);
  assert.equal(proof[0]!.line, original.slice(0, start).split('\n').length);
  assert.equal(proof[0]!.column, start - original.lastIndexOf('\n', start));
});

test('I06 same code in a different identifier scheme never collides', () => {
  assert.notEqual(rows(xml())[0].business_key, rows(xml('xbrli', 'https://id.example/two'))[0].business_key);
  assert.notEqual(rows(xml())[0].business_key, rows(xml().replace('2024-06-30', '2024-03-31'))[0].business_key);
});

test('G02 duplicate views preserve both locations, conflicting facts and unsafe XML are refused', () => {
  const marker = '<gaap:Revenue contextRef="c" unitRef="u" decimals="2">1234.56</gaap:Revenue>';
  const doubled = projectXbrlTable(Buffer.from(xml().replace(marker, marker + marker)), selection);
  assert.equal(JSON.parse(doubled.jsonBytes.toString()).length, 1);
  assert.equal((doubled.evidence.facts[0]!.locations as unknown[]).length, 2);
  assert.throws(() => rows(xml().replace(marker, marker + marker.replace('1234.56', '0'))), /矛盾/u);
  assert.throws(() => rows(xml().replace('<?xml version="1.0"?>', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>')), /DTD/u);
  assert.throws(() => rows(xml().replace('decimals="2"', '')), /精度/u);
  const nil = rows(xml().replace('xmlns:gaap=', 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:gaap=').replace('decimals="2">1234.56', 'decimals="2" xsi:nil="true">'));
  assert.equal(nil[0].value, null); assert.equal(nil[0].value_state, 'not_reported');
});

test('G02 controlled inline transformation handles namespaces, scale, sign and exact mixed content', () => {
  const instance = xml();
  const contexts = instance.slice(instance.indexOf('<xbrli:context'), instance.indexOf('<gaap:Revenue'));
  const inline = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:gaap="urn:example:gaap" xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:fmt="http://www.xbrl.org/inlineXBRL/transformation/2020-02-12"><body><ix:resources>${contexts}</ix:resources><ix:nonFraction name="gaap:Revenue" contextRef="c" unitRef="u" decimals="2" scale="2" sign="-" format="fmt:num-comma-decimal">1.<span>234</span>,56</ix:nonFraction></body></html>`;
  assert.equal(rows(inline)[0].value, '-123456');
  assert.throws(() => rows(inline.replace('num-comma-decimal', 'unsupported')), /支持列表/u);
});

test('D05 self-labelled full article fails, exact reviewed complete condition paragraphs survive without truncation', () => {
  const article = '这是一篇完整合成文章。\n\n分析内容不能靠标签获得必要条件资格。';
  assert.throws(() => inspectDeclared(Buffer.from(canonicalWfdJson([{ text_role: 'necessary_condition', text: article }])), { materialId: 'd05', format: 'json' }), /选择证明/u);
  const paragraph = '本次会计差错更正仅影响营业收入和营业成本，不涉及合并资产负债表、现金流量表；预计不超过披露范围，除非另行审议，尚未生效的事项不得作为实际结果。';
  const source = Buffer.from('报告标题。\n\n' + paragraph + '\n\n其他业务材料。');
  const sourceText = source.toString(), start = sourceText.indexOf(paragraph);
  const spec: NecessaryTextSelection = { version: NECESSARY_TEXT_VERSION, sourceSha256: wfdSha256(source), documentVersion: 'correction-2025-04-30',
    purpose: 'correction_scope' as const, reviewBasis: '操作者核对原更正披露完整影响范围与全部限制条件', paragraphs: [{ start, end: start + paragraph.length, quote: paragraph }] };
  const result = inspectDeclared(source, { materialId: 'd05-good', format: 'text', fieldMapping: {}, necessaryTextSelection: spec });
  assert.equal(result.rows[0]!.text, paragraph);
  assert.ok(parseTableSource(source, { materialId: 'd05-proof', format: 'text', necessaryTextSelection: spec }).necessary_text_evidence);
  assert.throws(() => inspectDeclared(source, { materialId: 'd05-cut', format: 'text', necessaryTextSelection: { ...spec,
    paragraphs: [{ start, end: start + 20, quote: paragraph.slice(0, 20) }] } }), /完整原文段/u);
  assert.throws(() => inspectDeclared(source, { materialId: 'd05-wrong-original', format: 'text', necessaryTextSelection: { ...spec, sourceSha256: '0'.repeat(64) } }), /摘要/u);
});
