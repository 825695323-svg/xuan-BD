import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isExplicitUtcInstant } from '../../contracts/financial-value.js';
import { assertDecimalPrecision, readDecimalPrecision, normalizeNumericLexeme, readNumericFormat,
  type NumericFormat } from './data-processing/numeric-format.js';
import { parseTableSource, structureCandidateTable, checkCandidateTables } from './candidate-pipeline.js';
import { compareProfileSemantics, profileFingerprint, readSourceFieldProfile, readSemanticProductRegistry,
  SourceFieldProfileStore, type SourceFieldProfile } from './source-field-profile.js';
import { sourceSemanticView } from './production-module-ports.js';

const code = (expected: string) => (error: unknown) => !!error && typeof error === 'object'
  && 'code' in error && error.code === expected;
const format: NumericFormat = { decimal: '.', grouping: ',', negative: 'minus_or_parentheses',
  plus: false, percent: 'reject', precision: { precision: 18, scale: 2, rounding: 'reject' } };
const profile = (sourceId: string, changes: Partial<SourceFieldProfile> = {}): SourceFieldProfile => readSourceFieldProfile({
  version: 'bd.source-field-profile/1', profileId: sourceId + '.current', sourceId, series: 'daily.price',
  fields: [{ originalHeader: 'date', fieldCode: 'date', dataType: 'text', unitCode: 'date', role: 'date' },
    { originalHeader: 'close', fieldCode: 'close', dataType: 'decimal', unitCode: 'cny_per_share', role: 'value',
      measurement: '本交易日未复权收盘价，每股人民币' }],
  frequency: 'day', timeBucket: { labelSemantics: 'start', interval: 'closed_open', lengthMinutes: 1440, timezone: 'Asia/Shanghai' },
  adjustment: { status: 'raw' },
  confirmation: { status: 'operator_confirmed', basis: '明确标注的隔离合成语义样本，不代表真实供应商已验收',
    confirmedAtUtc: '2026-11-13T00:00:00Z' }, ...changes,
}, sourceId + '.json');

test('declared decimal precision preserves large exact values, zero and source display precision', () => {
  assert.equal(normalizeNumericLexeme('9,007,199,254,740,993.15', format), '9007199254740993.15');
  assert.equal(normalizeNumericLexeme('(9,007,199,254,740,993.15)', format), '-9007199254740993.15');
  assert.equal(normalizeNumericLexeme('0.0000', format), '0');
  assert.equal(normalizeNumericLexeme('1.230000', format), '1.23');
  assert.throws(() => normalizeNumericLexeme('1.231', format), code('CANDIDATE_DECIMAL_SCALE'));
  assert.throws(() => normalizeNumericLexeme('99,999,999,999,999,999.99', format), code('CANDIDATE_DECIMAL_PRECISION'));
  assert.throws(() => normalizeNumericLexeme('', format), code('CANDIDATE_NUMERIC_FORMAT'));
  assert.throws(() => normalizeNumericLexeme('NaN', format), code('CANDIDATE_NUMERIC_FORMAT'));
  assert.throws(() => normalizeNumericLexeme(1.23 as never, format), code('CANDIDATE_NUMERIC_FORMAT'));
  assert.equal(normalizeNumericLexeme('1.234567', { ...format, precision: { precision: 12, scale: 6, rounding: 'reject' } }), '1.234567');
  const originalFormat = { decimal: '.' as const, grouping: null, negative: 'minus' as const, plus: false, percent: 'reject' as const };
  assert.equal(normalizeNumericLexeme('1.234567890123', originalFormat), '1.234567890123',
    'No default four-decimal rule may be introduced for existing plans');
});

test('decimal limits agree with an independent integer coefficient oracle', () => {
  for (let precision = 1; precision <= 8; precision++) for (let scale = 0; scale <= precision; scale++) {
    const limit = 10n ** BigInt(precision);
    for (const coefficient of [0n, 1n, limit - 1n, limit, limit + 1n]) {
      const digits = coefficient.toString().padStart(scale + 1, '0');
      const value = scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits;
      for (const sign of ['', '-']) {
        const actual = sign + value, rule = { precision, scale, rounding: 'reject' as const };
        if (coefficient < limit) assert.equal(assertDecimalPrecision(actual, rule), actual);
        else assert.throws(() => assertDecimalPrecision(actual, rule), code('CANDIDATE_DECIMAL_PRECISION'));
      }
    }
  }
});

test('precision contract is explicit and applied after percent semantics', () => {
  const valid = { precision: 8, scale: 4, rounding: 'reject' };
  for (const invalid of [{ precision: 8, scale: 4 }, { ...valid, rounding: 'half_up' },
    { ...valid, scale: -1 }, { ...valid, precision: 0 }, { ...valid, scale: 9 },
    { ...valid, precision: 129 }, { ...valid, scale: 1.5 }, { ...valid, guess: true }])
    assert.throws(() => readDecimalPrecision(invalid), code('CANDIDATE_DECIMAL_CONTRACT'));
  assert.throws(() => readNumericFormat({ ...format, precision: null }), code('CANDIDATE_DECIMAL_CONTRACT'));
  const fractional: NumericFormat = { ...format, percent: 'fraction', precision: { precision: 6, scale: 4, rounding: 'reject' } };
  assert.equal(normalizeNumericLexeme('12.34%', fractional), '0.1234');
  assert.throws(() => normalizeNumericLexeme('12.345%', fractional), code('CANDIDATE_DECIMAL_SCALE'));
});

test('source parse/structure/check enforces precision while retaining original cells', () => {
  const original = '9,007,199,254,740,993.1500';
  const source = Buffer.from(JSON.stringify([{ id: '001', amount: original }, { id: '002', amount: '0' }, { id: '003', amount: null }]));
  const parsed = parseTableSource(source, { materialId: 'precision-fixture', format: 'json',
    types: { amount: 'decimal_string' }, numericFormats: { amount: format } });
  const structured = structureCandidateTable(parsed);
  assert.equal(structured.rows[0]![1]!.original, original);
  assert.deepEqual(checkCandidateTables([structured]).rows,
    [{ id: '001', amount: '9007199254740993.15' }, { id: '002', amount: '0' }, { id: '003', amount: null }]);
  const invalid = parseTableSource(Buffer.from('[{"amount":"1.231"}]'), { materialId: 'precision-invalid', format: 'json',
    types: { amount: 'decimal_string' }, numericFormats: { amount: format } });
  assert.throws(() => structureCandidateTable(invalid), code('CANDIDATE_DECIMAL_SCALE'));
  assert.equal(invalid.rows[0]![0]!.original, '1.231');
});

test('UTC metadata rejects inferred midnight, implicit zones and impossible calendar dates', () => {
  for (const value of ['2024-02-29T00:00:00Z', '2026-11-13T23:59:59.1Z', '2026-11-13T23:59:59.001Z'])
    assert.equal(isExplicitUtcInstant(value), true, value);
  for (const value of ['2026-11-13', '2026-11-13T00:00:00', '2026-11-13T00:00:00+08:00',
    '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-11-13T24:00:00Z',
    '2026-11-13T23:59:60Z', '0000-01-01T00:00:00Z', '2026-11-13T23:59:59.0001Z']) {
    assert.equal(isExplicitUtcInstant(value), false, value);
    const current = profile('provider-a');
    assert.throws(() => readSourceFieldProfile({ ...current,
      confirmation: { ...current.confirmation, confirmedAtUtc: value } }, 'invalid-time'), code('SOURCE_FIELD_PROFILE'));
  }
  const current = profile('provider-a');
  assert.throws(() => readSourceFieldProfile({ ...current, timeBucket: { ...current.timeBucket, timezone: 'Not/A_Timezone' } },
    'invalid-zone'), code('SOURCE_FIELD_PROFILE'));
  assert.throws(() => readSemanticProductRegistry({ version: 'bd.semantic-products/1',
    products: [{ fingerprint: 'a'.repeat(64), datasetId: 'declared', registeredAtUtc: '2026-11-13' }] }, 'invalid-registry-time'),
    code('SOURCE_FIELD_PROFILE'));
});

test('G5 distinguishes identical unknown signatures from evidence-complete equivalence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bd-financial-contract-'));
  try {
    const a = profile('provider-a', { adjustment: { status: 'qfq' } });
    const b = profile('provider-b', { adjustment: { status: 'qfq' } });
    assert.equal(profileFingerprint(a), profileFingerprint(b));
    assert.equal(compareProfileSemantics(a, b).status, 'needs_evidence');
    writeFileSync(join(directory, 'a.json'), JSON.stringify(a));
    writeFileSync(join(directory, 'b.json'), JSON.stringify(b));
    const ports = { profiles: new SourceFieldProfileStore(directory) };
    const query = { left: { sourceId: a.sourceId, series: a.series }, right: { sourceId: b.sourceId, series: b.series } };
    const result = sourceSemanticView(query, ports) as any;
    assert.equal(result.status, 'needs_evidence');
    assert.equal(result.comparison.identicalSignature, true);
    assert.equal(result.comparison.sameSignature, false);
    assert.equal(result.comparison.differenceCount, 0);
    assert.ok(result.comparison.gapCount >= 2);
    assert.equal(result.left.semanticStatus, 'needs_evidence');
    assert.equal(result.adoption, 'not_granted');
    assert.equal(result.publication, 'not_requested');
    const known = { status: 'qfq' as const, method: 'explicit-company-action-factor', basis: '2026-11-13' };
    const knownA = profile('provider-a', { adjustment: known });
    const knownB = profile('provider-b', { adjustment: known });
    writeFileSync(join(directory, 'a.json'), JSON.stringify(knownA));
    writeFileSync(join(directory, 'b.json'), JSON.stringify(knownB));
    assert.equal(sourceSemanticView(query, ports).status, 'candidate_equivalent');
    const comparison = compareProfileSemantics(knownA, profile('provider-b', { adjustment: { ...known, basis: '2026-11-12' } }));
    assert.equal(comparison.status, 'different_semantics');
    assert.match(comparison.differences.join(';'), /复权基准不同/u);
    assert.deepEqual(comparison.gaps, []);
    const both = compareProfileSemantics(knownA, profile('provider-b', { adjustment: { status: 'unknown' },
      fields: b.fields.map(field => field.role === 'value' ? { ...field, unitCode: 'usd_per_share' } : field) }));
    assert.equal(both.status, 'different_semantics');
    assert.ok(both.differences.length > 0 && both.gaps.length > 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('one-sided optional meanings never pass as complete equivalence', () => {
  const left = profile('provider-a');
  const right = profile('provider-b', { adjustment: { status: 'raw', method: 'source-observation-policy' } });
  assert.notEqual(profileFingerprint(left), profileFingerprint(right));
  assert.equal(compareProfileSemantics(left, right).status, 'needs_evidence');
  assert.equal(compareProfileSemantics(right, left).sameProduct, false);
});
