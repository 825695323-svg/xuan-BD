import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../../adapters/database/wfd-transport.js';
import {
  assertMacroYoYCandidate, macroYoYAlgorithmDefinition, polarsFixedVersionBinding,
  POLARS_DEPENDENCY_VERSION, POLARS_FIXED_VERSION, type MacroYoYCalculation,
} from './polars-fixed.js';

const calc: MacroYoYCalculation = {
  version: 'bd.macro-yoy/1', historyMode: 'snapshot_contents', knowledgeCutoff: '2026-02-15T00:00:00Z',
  inputs: [
    { snapshotId: 'snap-2026', productId: 'macro-product', businessKey: 'current-2026', recordVersion: 'rev-2026' },
    { snapshotId: 'snap-2025', productId: 'macro-product', businessKey: 'previous-2025', recordVersion: 'rev-2025' },
  ],
};
const current = { series_code: 'synthetic-series', region: 'CN', unit: 'count',
  seasonal_adjustment: 'not_adjusted', base_period: '2020', period_start: '2026-01-01',
  period_end: '2026-01-31', published_at: '2026-02-14T00:00:00Z',
  release_id: 'release-2026', value: '120.00' };
const previous = { ...current, period_start: '2025-01-01', period_end: '2025-01-31',
  published_at: '2025-02-14T00:00:00Z', release_id: 'release-2025', value: '100' };

function fixture(currentValue: string = '120.00', previousValue: string = '100',
  output: string | null = '20.00000000') {
  const inputs = calc.inputs.map((input, index) => ({
    ...input,
    record: { product_id: input.productId, snapshot_id: input.snapshotId,
      logical_key: input.businessKey, revision_id: input.recordVersion },
    selectedSha256: wfdSha256(canonicalWfdJson({ index, input })),
    values: index ? { ...previous, value: previousValue } : { ...current, value: currentValue },
  }));
  const state = output === null ? previousValue === '0' ? 'undefined_zero_denominator'
    : 'unsupported_negative_base' : 'valid_value';
  const executionRequest = {
    version: POLARS_FIXED_VERSION, method: 'macro_yoy',
    rows: [{ current: currentValue, previous: previousValue }],
    parameters: { scale: 8, rounding: 'half_even', output_unit: 'percent' },
  };
  const evidence: WfdRecord = {
    version: POLARS_FIXED_VERSION, method: 'macro_yoy', inputs, workerSha256: polarsFixedVersionBinding().polarsWorker,
    algorithmDefinition: macroYoYAlgorithmDefinition(), knowledgeCutoff: calc.knowledgeCutoff,
    historicalQualification: 'not_asserted', releaseSelection: 'explicit business-key and record-version; never latest',
    connection: null, publication: 'candidate_only',
    execution: { version: POLARS_FIXED_VERSION, executor: 'polars', polars_version: POLARS_DEPENDENCY_VERSION,
      method: 'macro_yoy', input_sha256: wfdSha256(canonicalWfdJson(executionRequest)),
      rows: [{ value: output, state }], resources: {}, publication: 'candidate_only' },
  };
  const row: WfdRecord = {
    ...inputs[0]!.values,
    business_key: 'macro_yoy_' + wfdSha256(canonicalWfdJson(inputs)),
    value: output, value_state: output === null ? 'unknown' : state,
    calculation_status: state, unit: 'percent', method: 'exact_yoy_percentage',
    start_utc: '2026-01-01T00:00:00Z', end_utc: '2026-02-01T00:00:00Z',
  };
  return { evidence, row };
}
const fails = (fn: () => void) =>
  assert.throws(fn, (error: unknown) => (error as { code?: string }).code === 'POLARS_MACRO_CANDIDATE_CHANGED');

test('independent macro YoY verifier accepts fixed two-source exact 8-place Decimal result', () => {
  const f = fixture();
  assert.doesNotThrow(() => assertMacroYoYCandidate(calc, f.evidence, [f.row]));
});

test('zero and negative previous values stay unknown, never fabricated as zero or a valid negative-base rate', () => {
  for (const previousValue of ['0', '-10']) {
    const f = fixture('120', previousValue, null);
    assert.doesNotThrow(() => assertMacroYoYCandidate(calc, f.evidence, [f.row]));
    fails(() => assertMacroYoYCandidate(calc, f.evidence, [{ ...f.row, value: '0.00000000', value_state: 'valid_value' }]));
  }
});

test('macro YoY verifier rejects changed arithmetic, version, lineage, period, units, release time and worker receipt', () => {
  const base = fixture();
  const tamper = (changes: (evidence: WfdRecord, row: WfdRecord) => void) => {
    const evidence = structuredClone(base.evidence), row = structuredClone(base.row);
    changes(evidence, row);
    fails(() => assertMacroYoYCandidate(calc, evidence, [row]));
  };
  tamper((_evidence, row) => { row.value = '19.99999999'; });
  tamper((_evidence, row) => { row.unit = 'cny'; });
  tamper((_evidence, row) => { row.business_key = 'forged-key'; });
  tamper((_evidence, row) => { row.end_utc = '2026-01-31T00:00:00Z'; });
  tamper((evidence) => { (evidence.inputs as WfdRecord[])[0]!.recordVersion = 'changed-revision'; });
  tamper((evidence) => { ((evidence.inputs as WfdRecord[])[0]!.record as WfdRecord).revision_id = 'changed-revision'; });
  tamper((evidence) => { ((evidence.inputs as WfdRecord[])[1]!.values as WfdRecord).unit = 'cny'; });
  tamper((evidence) => { ((evidence.inputs as WfdRecord[])[0]!.values as WfdRecord).published_at = '2026-02-16T00:00:00Z'; });
  tamper((evidence) => { ((evidence.inputs as WfdRecord[])[1]!.values as WfdRecord).period_start = '2025-02-01'; });
  tamper((evidence) => { (evidence.execution as WfdRecord).input_sha256 = 'a'.repeat(64); });
  tamper((evidence) => { ((evidence.execution as WfdRecord).rows as WfdRecord[])[0]!.value = '21.00000000'; });
  tamper((evidence) => { evidence.algorithmDefinition = { mathematical_definition: 'unverified formula' }; });
  tamper((evidence) => { evidence.historicalQualification = 'market_known_at'; });
  tamper((evidence) => { evidence.workerSha256 = 'b'.repeat(64); });
});

test('half-even tie calculation does not substitute JS floating point', () => {
  // 100*(1/2^9)=0.1953125, then 8 decimals is 0.19531250 exactly.
  const f = fixture('513', '512', '0.19531250');
  assert.doesNotThrow(() => assertMacroYoYCandidate(calc, f.evidence, [f.row]));
  fails(() => assertMacroYoYCandidate(calc, f.evidence, [{ ...f.row, value: '0.19531249' }]));
});
