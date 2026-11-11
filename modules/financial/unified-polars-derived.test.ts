import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { financialAlgorithmDefinition, FINANCIAL_LINEAR_ADMISSION_VERSION } from '../collection/data-processing/financial-fixed.js';
import { macroYoYAlgorithmDefinition, polarsFixedVersionBinding } from '../collection/data-processing/polars-fixed.js';
import { buildStructuredIngestDocument } from '../collection/r1-structured-handoff.js';
import { checkUnifiedStructuredForWfd } from './unified-polars-derived.js';
import type { UnifiedPolarsResult } from './unified-polars-execution.js';

const digest = (x: unknown) => wfdSha256(canonicalWfdJson(x));
const base = { version: 'bd.algorithms.polars/1' as const, taskId: 'calculation-task-one',
  inputDigest: 'a'.repeat(64), source: { kind: 'fixed_snapshot' as const },
  implementationVersion: polarsFixedVersionBinding().polarsWorker,
  computedAt: '2026-01-31T09:00:00.000Z', publication: 'candidate_only' as const };
const binding = { namespace: 'bd.test', mode: 'user_test' as const, expectedParentSnapshotId: 's_frozen_parent' };

function mock(methodId: 'financial_linear' | 'macro_yoy'): UnifiedPolarsResult {
  const finance = methodId === 'financial_linear';
  const row: WfdRecord = finance
    ? { business_key: 'financial_derived_one', start_utc: '2026-01-01T00:00:00Z',
      end_utc: '2026-04-01T00:00:00Z', value: '30.15', value_state: 'valid_value',
      subject_scheme: 'fixture', subject_code: 'company-one', currency: 'CNY', unit: 'cny' }
    : { business_key: 'macro_yoy_one', start_utc: '2026-01-01T00:00:00Z',
      end_utc: '2026-02-01T00:00:00Z', value: '20.00000000', value_state: 'valid_value',
      region: 'CN', unit: 'percent' };
  const algorithmDefinition = finance
    ? financialAlgorithmDefinition('quarter_difference') : macroYoYAlgorithmDefinition();
  return { ...base, methodId,
    methodVersion: finance ? FINANCIAL_LINEAR_ADMISSION_VERSION : 'bd.macro-yoy/1',
    calculation: finance
      ? { version: 'bd-financial-fixed/1', operation: 'quarter_difference', inputs: [
        { snapshotId: 's_one', productId: 'p_one', businessKeys: ['current'] },
        { snapshotId: 's_two', productId: 'p_one', businessKeys: ['previous'] },
      ] }
      : { version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents', knowledgeCutoff: '2026-02-15T00:00:00Z', inputs: [
        { snapshotId: 's_one', productId: 'p_one', businessKey: 'current', recordVersion: 'r_one' },
        { snapshotId: 's_two', productId: 'p_one', businessKey: 'previous', recordVersion: 'r_two' },
      ] },
    rows: [row], candidateSha256: digest([row]),
    evidence: { workerSha256: base.implementationVersion, algorithmDefinition },
    algorithmDefinition };
}
const expectBlock = (result: UnifiedPolarsResult, code: string) => {
  assert.throws(() => checkUnifiedStructuredForWfd(result, binding, 'bd-derived:request-one'),
    (error: unknown) => (error as { code?: string }).code === code, code);
};

test('Polars financial and macro use identical R1 scalar output and signed fixed-source evidence', () => {
  for (const methodId of ['financial_linear', 'macro_yoy'] as const) {
    const result = mock(methodId);
    const checked = checkUnifiedStructuredForWfd(result, binding, 'bd-derived:request-one');
    assert.equal(checked.structured.payload.kind, 'scalar_rows');
    assert.equal(checked.structured.inputMode, 'partial_observation');
    assert.equal(checked.structured.subject.kind, methodId === 'financial_linear' ? 'entity' : 'region');
    assert.equal(checked.structured.subject.id, methodId === 'financial_linear' ? 'company-one' : 'CN');
    assert.equal(checked.structured.expectedParentSnapshotId, binding.expectedParentSnapshotId);
    assert.equal((checked.structured.definition.field_definitions as any[])[0].unit_code,
      methodId === 'financial_linear' ? 'cny' : 'percent');
    const rows = (checked.structured.payload.rows as any[]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value_decimal, result.rows[0]!.value);
    assert.equal(rows[0].observation_time.earliest_utc, result.rows[0]!.start_utc);
    assert.equal(rows[0].observation_time.latest_exclusive_utc, result.rows[0]!.end_utc);
    assert.equal(checked.source.sha256, checked.sourceSha256);
    assert.equal(wfdSha256(checked.originalBytes), checked.sourceSha256);
    assert.equal(checked.resultSha256, digest(result));
    const document = buildStructuredIngestDocument(checked.structured);
    assert.match(checked.structured.submissionDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal((document.outputs as unknown[]).length, 1);
  }
});

test('unified result schema refuses altered scalar, unit, source subject or algorithm method', () => {
  const rowValueChanged = structuredClone(mock('macro_yoy'));
  rowValueChanged.rows[0]!.value = '19.00';
  expectBlock(rowValueChanged, 'UNIFIED_DERIVED_INVALID');

  const valueUnknown = structuredClone(mock('macro_yoy'));
  valueUnknown.rows[0]!.value = null;
  valueUnknown.candidateSha256 = digest(valueUnknown.rows);
  expectBlock(valueUnknown, 'UNIFIED_DERIVED_VALUE');

  const wrongUnit = structuredClone(mock('macro_yoy'));
  wrongUnit.rows[0]!.unit = 'cny';
  wrongUnit.candidateSha256 = digest(wrongUnit.rows);
  expectBlock(wrongUnit, 'UNIFIED_DERIVED_SUBJECT');

  const newWorker = structuredClone(mock('financial_linear'));
  newWorker.implementationVersion = 'f'.repeat(64);
  expectBlock(newWorker, 'UNIFIED_DERIVED_VALUE');

  const methodChanged = structuredClone(mock('financial_linear'));
  methodChanged.methodVersion = 'another-financial-method';
  expectBlock(methodChanged, 'UNIFIED_DERIVED_METHOD');

  const scopeChanged = structuredClone(mock('financial_linear'));
  scopeChanged.rows[0]!.currency = 'USD';
  scopeChanged.candidateSha256 = digest(scopeChanged.rows);
  expectBlock(scopeChanged, 'UNIFIED_DERIVED_SUBJECT');
});
