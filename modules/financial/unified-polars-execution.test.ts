import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnifiedPolarsMethod, UnifiedPolarsExecution } from './unified-polars-execution.js';

const macro = { version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents',
  knowledgeCutoff: '2026-01-30T00:00:00Z', inputs: [
    { snapshotId: 's_2026', productId: 'p_macro', businessKey: 'release_current', recordVersion: 'r_2026' },
    { snapshotId: 's_2025', productId: 'p_macro', businessKey: 'release_previous', recordVersion: 'r_2025' },
  ] };
const financial = { version: 'bd-financial-fixed/1', operation: 'quarter_difference', inputs: [
  { snapshotId: 's_q2', productId: 'p_finance', businessKeys: ['ytd_current'] },
  { snapshotId: 's_q1', productId: 'p_finance', businessKeys: ['ytd_previous'] },
] };

function backend() {
  let taskQueries = 0;
  const subject = new UnifiedPolarsExecution({
    database: {} as never,
    tasks: () => { taskQueries++; throw Error('no task should be created by invalid input'); },
    workspace: { capabilities: () => ({ connection: { connection_id: 'trusted-wfd' } }) } as never,
    processRuntime: { path: (name: string) => {
      assert.equal(name, 'polars-python');
      return process.execPath;
    } } as never,
  });
  return { subject, queries: () => taskQueries };
}
const fixed = (methodId: string, calculation: unknown) => ({
  methodId, source: { kind: 'fixed_snapshot' }, calculation,
  usage: { purpose: 'current_compute' },
});
const fails = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: unknown) => (error as { code?: string }).code === code);

test('one public algorithms.calculate route has exact financial and macro method preflights', () => {
  const b = backend();
  assert.equal(isUnifiedPolarsMethod('financial_linear'), true);
  assert.equal(isUnifiedPolarsMethod('macro_yoy'), true);
  assert.equal(isUnifiedPolarsMethod('observation_ma20'), false);
  assert.equal(isUnifiedPolarsMethod('ma'), false);
  assert.equal(b.subject.capabilities().status, 'ready');
  const normalize = (b.subject as never as { normalize(value: unknown): any }).normalize.bind(b.subject);
  const fi = normalize(fixed('financial_linear', financial));
  const ma = normalize(fixed('macro_yoy', macro));
  assert.equal(fi.methodId, 'financial_linear');
  assert.equal(ma.methodId, 'macro_yoy');
  assert.equal(fi.source.kind, 'fixed_snapshot');
  assert.equal(fi.usage.purpose, 'current_compute');
  assert.equal(b.queries(), 0, 'Method validation cannot create a TaskService job or query WFD.');
});

test('normalization rejects caller-selected engine, mutable snapshots, historical claims and arbitrary rows', () => {
  const b = backend();
  const normalize = (b.subject as never as { normalize(value: unknown): unknown }).normalize.bind(b.subject);
  for (const input of [
    { ...fixed('macro_yoy', macro), engine: 'pandas' },
    { ...fixed('macro_yoy', macro), source: { kind: 'fixed_snapshot', path: '/tmp/proof.csv' } },
    { ...fixed('macro_yoy', macro), source: { kind: 'managed_table' } },
    { ...fixed('macro_yoy', macro), usage: { purpose: 'historical_compute', cutoff: '2020-01-01T00:00:00Z' } },
    { ...fixed('financial_linear', financial), rows: [{ value: '1000' }] },
    fixed('macro_yoy', { ...macro, inputs: [{ ...macro.inputs[0], snapshotId: 'latest' }, macro.inputs[1]] }),
  ]) fails(() => normalize(input), input.source?.kind === 'managed_table' || Object.hasOwn(input, 'rows')
    || Object.hasOwn(input, 'engine') || Object.hasOwn(input, 'usage') && (input as any).usage.purpose !== 'current_compute'
    || Object.hasOwn(input.source, 'path') ? 'UNIFIED_POLARS_INPUT' : 'POLARS_MACRO_CONTRACT');
  fails(() => normalize(fixed('financial_linear', { ...financial, operation: 'standardize' })), 'UNIFIED_POLARS_METHOD');
  assert.equal(b.queries(), 0);
});

test('invalid method and request identity never touch TaskService', () => {
  const b = backend();
  fails(() => b.subject.submit('source-case', fixed('unregistered_method', macro)), 'UNIFIED_POLARS_INPUT');
  fails(() => b.subject.submit('', fixed('macro_yoy', macro)), 'UNIFIED_POLARS_REQUEST');
  assert.equal(b.queries(), 0);
});
