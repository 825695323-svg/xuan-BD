import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue } from '../../../../contracts/task-contracts.js';
import { thsSource } from './api.js';
import { buildThsRequest, decodeThsResponse, projectThsFinancials } from './requests.js';

// 合成财报与时间戳，只核验原值保留和错误边界，不代表真实公司披露或有效凭据。
const request = { thscode: '600001.SH', statement: 'income', period: 'quarterly', limit: 2 };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;

test('Fuyao financial request binds the endpoint, security, native period and explicit record budget', () => {
  for (const [statement, endpoint] of [['income', 'income-statements'], ['balance_sheet', 'balance-sheets'], ['cash_flow', 'cash-flow-statements']]) {
    const url = buildThsRequest(thsSource.apiBaseUrl, 'financial_statements', { ...request, statement });
    assert.equal(url.pathname, '/api/a-share/financials/' + endpoint);
    assert.equal(url.searchParams.get('thscode'), request.thscode);
    assert.equal(url.searchParams.get('period'), 'quarterly');
    assert.equal(url.searchParams.get('limit'), '2');
  }
  const bad: Array<Record<string, JsonValue>> = [{ thscode: '600001' }, { thscode: 'AAPL.US' }, { period: 'ttm' },
    { statement: 'unknown' }, { limit: null }, { limit: 0 }, { limit: 21 }, { api_key: 'not-read' }];
  for (const delta of bad) assert.throws(() => buildThsRequest(thsSource.apiBaseUrl, 'financial_statements', { ...request, ...delta }), code('SOURCE_PARAMETERS_INVALID'));
  assert.throws(() => buildThsRequest('https://example.test', 'financial_statements', request), code('SOURCE_PARAMETERS_INVALID'));
});

test('Fuyao financial projection retains millisecond precision, explicit nulls and vendor period values', () => {
  const originalRow = { thscode: request.thscode, report_date_ms: 1793000123456, period_end_ms: 1788105600123,
    net_profit: null, operating_income: 12345.67, fiscal_period: 'source_period', vendor_specific_field: { unit: 'source_native' } };
  const result = projectThsFinancials(request, bytes({ code: 0, message: '', data: { item: [originalRow] } }));
  assert.deepEqual(result.rows, [{ ...originalRow, report_date_ms: '1793000123456', period_end_ms: '1788105600123', operating_income: '12345.67' }]);
  assert.equal(result.recordCount, 1);
  assert.equal(result.timestampPolicy, 'retain_source_values_and_precision');
  assert.equal(result.periodSemantics, 'source_reported_not_single_quarter_or_ttm');
  assert.equal(result.historicalAvailability, 'not_established');
  assert.equal(result.coverageState, 'not_established');
  const empty = projectThsFinancials(request, bytes({ code: 0, data: { item: [] } }));
  assert.equal(empty.recordCount, 0);
  assert.equal(empty.coverageState, 'not_established');
});

test('Fuyao refuses missing item, record overrun, foreign identity and business failures', () => {
  for (const data of [{}, { item: null }, { item: {} }, { item: [null] },
    { item: [{}] }, { item: [{ thscode: request.thscode }] }, { item: [{ garbage: 1 }] }, { item: [{ report_date: {} }] }, { item: [{}, {}, {}] }, { item: [{ thscode: '600002.SH' }] }])
    assert.throws(() => projectThsFinancials(request, bytes({ code: 0, data })), code('SOURCE_FINANCIAL_RESPONSE_INVALID'));
  assert.throws(() => projectThsFinancials(request, bytes({ code: 4001, data: { item: [] } })), code('SOURCE_RATE_LIMITED'));
  assert.throws(() => projectThsFinancials(request, bytes({ code: 5003, data: { item: [] } })), code('SOURCE_BUSINESS_ERROR'));
  assert.throws(() => projectThsFinancials(request, bytes({ code: 2003, data: { item: [] } })), code('SOURCE_FORBIDDEN'));
  assert.throws(() => decodeThsResponse(bytes([])), code('SOURCE_RESPONSE_INVALID'));
  assert.throws(() => decodeThsResponse(new Uint8Array([0xff])), code('SOURCE_RESPONSE_INVALID'));
});

test('Fuyao preserves JSON numeric tokens at every statement depth and only diagnoses known business codes', () => {
  const raw = Buffer.from('{"code":0,"data":{"item":[{"net_profit":9007199254740993,"nested":[1.2300,1e-400,{"code":1.00}],"zero":0}]}}');
  assert.deepEqual(projectThsFinancials(request, raw).rows, [
    { net_profit: '9007199254740993', nested: ['1.2300', '1e-400', { code: '1.00' }], zero: '0' },
  ]);
  for (const value of ['0', 'untrusted-fixture'.repeat(100), { sensitive: 'untrusted-fixture' }, 9007199254740992, 9379]) {
    assert.throws(() => decodeThsResponse(bytes({ code: value })), {
      code: 'SOURCE_BUSINESS_ERROR', message: /code unknown/u,
    });
    assert.throws(() => projectThsFinancials(request, bytes({ code: value, data: { item: [] } })), code('SOURCE_BUSINESS_ERROR'));
  }
  for (const raw of ['{"code":1e-400}', '{"code":2001.00000000000000000001}'])
    assert.throws(() => decodeThsResponse(Buffer.from(raw)), code('SOURCE_BUSINESS_ERROR'));
  assert.throws(() => decodeThsResponse(bytes({ code: 2001 })), code('SOURCE_UNAUTHORIZED'));
});
