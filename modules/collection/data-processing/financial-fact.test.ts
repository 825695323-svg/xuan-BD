import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { candidateImplementationDigest } from '../candidate-pipeline.js';
import { ProcessingPlanService } from '../processing-plan.js';
import { financialFactIdentity, verifyFinancialFactRow } from './financial-fact.js';
const declaration = { version: 'bd-financial-fact/1', seriesId: 'synthetic-report-series', periodBasis: 'synthetic-exact-quarter',
  basis: 'Explicit synthetic same-fact edition relationship', assertion: 'same_fact_across_report_editions' };
const original = { subject_scheme: 'synthetic', subject_code: 'issuer', accounting_standard: 'CAS', currency: 'CNY', statement: 'income',
  scope: 'consolidated', section: 'revenue', concept: '营业收入', dimension: 'current', period_type: 'duration', start_date: '2024-01-01',
  end_date: '2024-03-31', unit: 'cny', report_id: 'report-original', report_version: 'v1', audit_status: 'unaudited', value: '10' };
test('explicit financial identity excludes source edition but preserves every fact axis', () => {
  const first = financialFactIdentity(original, declaration);
  assert.deepEqual(financialFactIdentity({ ...original, report_id: 'corrected', report_version: 'v2', audit_status: 'audited', value: '12' }, declaration), first);
  for (const key of ['subject_code', 'currency', 'accounting_standard', 'statement', 'scope', 'section', 'concept', 'dimension', 'unit'])
    assert.notEqual(financialFactIdentity({ ...original, [key]: 'changed' }, declaration).businessKey, first.businessKey);
  assert.notEqual(financialFactIdentity({ ...original, end_date: '2024-06-30' }, declaration).businessKey, first.businessKey);
  assert.notEqual(financialFactIdentity(original, { ...declaration, seriesId: 'other' }).businessKey, first.businessKey);
});
test('missing, unknown and impossible financial axes cannot opt into stable identity', () => {
  for (const key of ['subject_code', 'currency', 'scope', 'unit', 'report_id', 'report_version']) for (const value of ['', 'unknown', undefined])
    assert.throws(() => financialFactIdentity({ ...original, [key]: value }, declaration), /完整身份轴/u);
  assert.throws(() => financialFactIdentity({ ...original, end_date: '2024-02-31' }, declaration));
  assert.throws(() => financialFactIdentity({ ...original, period_type: 'instant' }, declaration));
  assert.throws(() => financialFactIdentity(original, { ...declaration, periodBasis: 'unknown' }));
});
test('mapped actual cells must reproduce the complete frozen identity, not only a chosen hash', () => {
  const fact = financialFactIdentity(original, declaration);
  const values = Object.fromEntries(Object.entries({ ...original, financial_fact_identity: fact.identity })
    .map(([key, value]) => [key, { value, value_state: 'valid_value' }]));
  const row = { business_key: fact.businessKey, values };
  assert.equal(verifyFinancialFactRow(row), fact.identity);
  assert.throws(() => verifyFinancialFactRow({ ...row, business_key: 'free-key' }));
  assert.throws(() => verifyFinancialFactRow({ ...row, values: { ...values, unit: { value: 'usd', value_state: 'valid_value' } } }));
});

test('financial identity, COA and temporal rule bytes invalidate replay and processing implementation bindings', t => {
  // Only source reads are substituted; no repository file, stored plan or production state is changed.
  const processing = () => new ProcessingPlanService({ database: { migrate() {} } } as any).versionBinding.implementation;
  const before = { candidate: candidateImplementationDigest(), processing: processing() };
  const realRead = fs.readFileSync;
  for (const source of ['financial-fact.ts', 'financial-coa-registry.ts', 'financial-temporal-pairing.ts']) {
    const mock = t.mock.method(fs, 'readFileSync', ((path: any, ...args: any[]) => {
      const bytes = (realRead as any)(path, ...args);
      return String(path).endsWith(`/data-processing/${source}`) ? Buffer.concat([bytes, Buffer.from('\n// isolated changed financial rule bytes\n')]) : bytes;
    }) as typeof fs.readFileSync);
    try {
      syncBuiltinESMExports();
      assert.notEqual(candidateImplementationDigest(), before.candidate, source);
      assert.notEqual(processing(), before.processing, source);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  }
  assert.equal(candidateImplementationDigest(), before.candidate);
  assert.equal(processing(), before.processing);
});
