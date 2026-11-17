import assert from 'node:assert/strict';
import test from 'node:test';
import { parsedRecordDependencies } from './processing-record-dependencies.js';
const ref = { snapshot_id: 's1', product_id: 'p1', logical_key: 'k1', revision_id: 'r1' };
function fixture() {
  const inputs = [{ snapshotId: 's1', productId: 'p1', businessKeys: ['k1'] }];
  const parsed: any = { kind: 'parsed-table', format: 'financial-fixed', adapter: { id: 'bd-financial-fixed' },
    source_columns: ['business_key'], rows: [[{ original: 'out1' }]], total_rows: 1,
    financial_evidence: { version: 'bd-financial-fixed/1', operation: 'standardize', mappingVersion: 'mapping1', outputRows: 1,
      inputs: [{ ...inputs[0], selectedRows: 1, recordVersions: [ref] }],
      lineage: [{ businessKey: 'out1', source: { snapshot: 's1', product: 'p1', mapping: 'mapping1', record: ref } }] } };
  return { parsed, calculation: { inputs } };
}
test('record edges require exact persisted identities and never leak extended record fields', () => {
  const { parsed, calculation } = fixture();
  parsed.financial_evidence.lineage[0].source.record = { ...ref, values: { private: 'UNIQUE_SECRET' } };
  assert.deepEqual(parsedRecordDependencies(parsed, calculation), [{ parsedBusinessKey: 'out1', sourceRecordRef: ref }]);
  assert.equal(JSON.stringify(parsedRecordDependencies(parsed, calculation)).includes('UNIQUE_SECRET'), false);
});
test('missing or inconsistent evidence is unknown, not guessed from keys or concepts', () => {
  for (const mutate of [
    (p: any) => delete p.financial_evidence,
    (p: any) => delete p.financial_evidence.inputs[0].businessKeys,
    (p: any) => delete p.adapter,
    (p: any) => delete p.rows,
    (p: any) => { p.financial_evidence.lineage[0].source.record = { ...ref, revision_id: 'other' }; },
    (p: any) => { p.financial_evidence.lineage[0].source.record = { ...ref, revision_id: '' }; },
    (p: any) => { p.financial_evidence.inputs[0].productId = 'other'; },
    (p: any) => { p.rows[0][0].original = 'unrelated'; },
    (p: any) => { p.financial_evidence.outputRows = 2; },
    (p: any) => { p.selection = {}; },
    (p: any) => { p.financial_evidence.lineage = []; },
  ]) {
    const { parsed, calculation } = fixture(); mutate(parsed);
    assert.equal(parsedRecordDependencies(parsed, calculation), null);
  }
});
