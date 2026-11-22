import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonValue } from '../../../../contracts/task-contracts.js';
import { buildTickflowDailyRequest, decodeTickflowDailyBars, normalizeTickflowDailyRequest } from './api.js';

// 合成业务样本；这些价格、日期与预算不是实盘参数或供应商限额实测。
const request = { symbol: '600001.SH', start: '2026-01-05', end: '2026-01-06', adjustment: 'none' as const, limit: 3 };
const stamp = (day: string) => Date.parse(`${day}T00:00:00+08:00`);
const response = () => ({ data: { timestamp: [stamp('2026-01-05'), stamp('2026-01-06')],
  open: [10, 11], high: [12, 12], low: [9, 10], close: [11, 11.5], volume: [101, null] } });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const code = (expected: string) => (error: unknown) => error instanceof Error && 'code' in error && error.code === expected;

test('TickFlow explicitly requests free unadjusted daily data and the whole Beijing date window', () => {
  const built = buildTickflowDailyRequest({ ...request, start: '20260105' });
  assert.equal(built.url.origin, 'https://free-api.tickflow.org');
  assert.equal(built.url.searchParams.get('adjust'), 'none');
  assert.equal(built.url.searchParams.get('period'), '1d');
  assert.equal(built.url.searchParams.get('count'), '3');
  assert.equal(built.url.searchParams.get('start_time'), String(stamp(request.start)));
  assert.equal(built.url.searchParams.get('end_time'), String(stamp('2026-01-07') - 1));
  assert.deepEqual(built.headers, { Accept: 'application/json' });
  assert.equal(built.method, 'GET');
  const invalidParameters: Array<Record<string, JsonValue>> = [{ start: '2026-02-30' }, { end: '2026-01-01' }, { symbol: 'AAPL.US' }, { symbol: '600001' },
    { adjustment: 'forward' }, { limit: null }, { limit: 1.5 }, { limit: 0 }, { apiKey: 'not-read' }];
  for (const delta of invalidParameters)
    assert.throws(() => normalizeTickflowDailyRequest({ ...request, ...delta }), code('SOURCE_PARAMETERS_INVALID'));
});

test('TickFlow retains milliseconds, odd-lot volume and missing amounts without zero filling or false completeness', () => {
  const raw = bytes(response()), result = decodeTickflowDailyBars(request, raw);
  assert.equal(result.rows[0]!.trade_date, '2026-01-05');
  assert.equal(result.rows[0]!.timestamp, stamp('2026-01-05'));
  assert.equal(result.rows[0]!.volume, 101);
  assert.equal(result.rows[1]!.volume, null);
  assert.equal(result.rows[0]!.amount, null);
  assert.equal(result.volumeUnit, 'native_unverified');
  assert.equal(result.amountUnit, 'native_unverified');
  assert.equal(result.coverageState, 'not_established');
  assert.equal(result.historyAvailability, 'not_established');
  assert.equal(result.rawSha256.length, 64);
  assert.equal(result.limitReached, false);
  assert.equal(decodeTickflowDailyBars({ ...request, limit: 2 }, raw).limitReached, true);
  const empty = decodeTickflowDailyBars(request, bytes({ data: { timestamp: [], open: [], high: [], low: [], close: [], volume: [] } }));
  assert.equal(empty.recordCount, 0);
  assert.equal(empty.actualStart, null);
  assert.equal(empty.continuation, 'not_declared');
});

test('TickFlow refuses truncated columns, wrong identity, response errors and unsafe numeric coercion', () => {
  const variants = [
    { ...response(), code: 'NO_PERMISSION' },
    { data: { ...response().data, amount: [1] } },
    { data: { ...response().data, volume: [] } },
    { data: { ...response().data, close: ['11', 11.5] } },
    { data: { ...response().data, adjust: 'forward' } },
    { data: { ...response().data, symbol: '600002.SH' } },
    { data: { ...response().data, high: [8, 12] } },
    { data: { ...response().data, low: [-1, 10] } },
  ];
  for (const variant of variants) assert.throws(() => decodeTickflowDailyBars(request, bytes(variant)), code('SOURCE_DAILY_RESPONSE_INVALID'));
  assert.throws(() => decodeTickflowDailyBars({ ...request, limit: 1 }, bytes(response())), code('SOURCE_DAILY_RESPONSE_INVALID'));
  assert.throws(() => decodeTickflowDailyBars(request, new Uint8Array([0xff])), code('SOURCE_DAILY_RESPONSE_INVALID'));
});

test('TickFlow detects reversed, duplicate, out-of-window and second-unit timestamps without silently repairing rows', () => {
  for (const timestamp of [[stamp('2026-01-06'), stamp('2026-01-05')], [stamp('2026-01-05'), stamp('2026-01-05')],
    [stamp('2026-01-04'), stamp('2026-01-06')], [stamp('2026-01-05') / 1000, stamp('2026-01-06') / 1000]])
    assert.throws(() => decodeTickflowDailyBars(request, bytes({ data: { ...response().data, timestamp } })), code('SOURCE_DAILY_RESPONSE_INVALID'));
});
