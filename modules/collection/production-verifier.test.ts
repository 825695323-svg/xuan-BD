import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { verifyProductionRows, verifyProductionDerived } from './production-verifier.js';

const rows: WfdRecord[] = [{ time: '2026-01-02', amount: '12.3000', missing: null }];
const base = { rows, maxRows: 5000, maxBytes: 20000 };
const code = (value: string) => (error: unknown) => (error as { code?: string }).code === value;

test('source and fixed algorithm share one production verifier without changing their immutable wire envelopes', () => {
  const source = verifyProductionRows({ ...base, kind: 'source',
    fields: ['time','amount','missing'] });
  const derived = verifyProductionRows({ ...base, kind: 'derived',
    expectedRowsSha256: wfdSha256(canonicalWfdJson(rows)) });
  assert.equal(source.bytes.toString(), canonicalWfdJson({ rows }));
  assert.equal(derived.bytes.toString(), canonicalWfdJson(rows));
  assert.equal(source.sha256, wfdSha256(canonicalWfdJson({ rows })));
  assert.equal(derived.sha256, wfdSha256(canonicalWfdJson(rows)));
  assert.equal(source.rowCount, derived.rowCount);
  assert.deepEqual(JSON.parse(derived.bytes.toString())[0].missing, null,
    '合法的原始 null 原样保存，绝不作为坏数据的替代值');
});

test('shared verification rejects corrupt values, fabricated columns, changed digest and truncated outputs', () => {
  const valid = { ...base, kind: 'derived' as const };
  for (const bad of [
    { ...valid, rows: [{ time: '2026-01-02', amount: Number.NaN }] },
    { ...valid, rows: [{ time: '2026-01-02', amount: Infinity }] },
    { ...valid, rows: [{ time: '2026-01-02', amount: { invalid: 'nested' } }] },
  ]) assert.throws(() => verifyProductionRows(bad), code('PRODUCTION_VALUE_INVALID'));
  assert.throws(() => verifyProductionRows({ ...valid, expectedRowsSha256: '0'.repeat(64) }),
    code('PRODUCTION_OUTPUT_CHANGED'));
  assert.throws(() => verifyProductionRows({ ...valid, maxRows: 0 }),
    code('PRODUCTION_ROW_BUDGET'));
  assert.throws(() => verifyProductionRows({ ...valid, maxBytes: 1 }),
    code('PRODUCTION_OUTPUT_BUDGET'));
  assert.throws(() => verifyProductionRows({ ...base, kind: 'source', fields: ['time','amount'] }),
    code('PRODUCTION_FIELDS_INVALID'));
  assert.throws(() => verifyProductionRows({ ...base, kind: 'source', fields: ['time','time'] }),
    code('PRODUCTION_FIELDS_INVALID'));
});

test('independent method/source proof executes once only after shared structural proof', async () => {
  let calls = 0;
  const controller = new AbortController(), expectedRowsSha256 = wfdSha256(canonicalWfdJson(rows));
  const methodVerifier = async (signal: AbortSignal) => {
    signal.throwIfAborted(); calls++; return { method: 'macro_yoy', qualified: 'not_asserted' };
  };
  assert.deepEqual(await verifyProductionDerived({ ...base, expectedRowsSha256 }, methodVerifier, controller.signal),
    { method: 'macro_yoy', qualified: 'not_asserted' });
  assert.equal(calls, 1);
  await assert.rejects(verifyProductionDerived({ ...base, expectedRowsSha256: '0'.repeat(64) }, methodVerifier,
    controller.signal), code('PRODUCTION_OUTPUT_CHANGED'));
  assert.equal(calls, 1, '改变结果摘要时不能读取 WFD，也不能调用方法独立核验');
  controller.abort();
  await assert.rejects(verifyProductionDerived({ ...base, expectedRowsSha256 }, methodVerifier,
    controller.signal), (error: unknown) => (error as { name?: string }).name === 'AbortError');
  assert.equal(calls, 1);
});
