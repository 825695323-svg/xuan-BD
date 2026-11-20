import assert from 'node:assert/strict';
import test from 'node:test';
import { parsedRecordDependencies, readRecordDependencySelection, selectRecordDependencyImpact } from './processing-record-dependencies.js';
const ref = { snapshot_id: 's1', product_id: 'p1', logical_key: 'k1', revision_id: 'r1' };
function fixture() {
  const inputs = [{ snapshotId: 's1', productId: 'p1', businessKeys: ['k1'] }];
  const parsed: any = { kind: 'parsed-table', format: 'financial-fixed', adapter: { id: 'bd-financial-fixed' },
    source_columns: ['business_key'], rows: [[{ original: 'out1' }]], total_rows: 1,
    financial_evidence: { version: 'bd-financial-fixed/1', operation: 'standardize', mappingVersion: 'cas-primary-statements/1', outputRows: 1,
      inputs: [{ ...inputs[0], selectedRows: 1, recordVersions: [ref] }],
      lineage: [{ businessKey: 'out1', source: { snapshot: 's1', product: 'p1', mapping: 'cas-primary-statements/1', record: ref } }] } };
  return { parsed, calculation: { inputs } };
}
test('record edges require exact persisted identities and never leak extended record fields', () => {
  const { parsed, calculation } = fixture();
  parsed.financial_evidence.lineage[0].source.record = { ...ref, values: { private: 'UNIQUE_SECRET' } };
  assert.deepEqual(parsedRecordDependencies(parsed, calculation), [{ parsedBusinessKey: 'out1', sourceRecordRef: ref }]);
  assert.equal(JSON.stringify(parsedRecordDependencies(parsed, calculation)).includes('UNIQUE_SECRET'), false);

  for (const mappingProfile of ['cas-primary-statements/2', 'ifrs-primary-statements/1', 'us-gaap-primary-statements/1']) {
    const candidate = fixture();
    candidate.parsed.financial_evidence.mappingVersion = mappingProfile;
    candidate.parsed.financial_evidence.lineage[0].source.mapping = mappingProfile;
    assert.deepEqual(parsedRecordDependencies(candidate.parsed, { ...candidate.calculation, mappingProfile }),
      [{ parsedBusinessKey: 'out1', sourceRecordRef: ref }]);
    assert.equal(parsedRecordDependencies(candidate.parsed, candidate.calculation), null);
  }
});

test('historical candidate mapping requires the same pinned digest in request, evidence and every source edge', () => {
  const { parsed, calculation } = fixture();
  const mappingProfile = 'historical-fixture-coa/1';
  const mappingProfileDigest = 'sha256:' + '1'.repeat(64);
  const otherDigest = 'sha256:' + '2'.repeat(64);
  const frozen = { ...calculation, mappingProfile, mappingProfileDigest };
  const evidence = parsed.financial_evidence;
  evidence.mappingVersion = mappingProfile;
  evidence.mappingProfileDigest = mappingProfileDigest;
  const source = evidence.lineage[0].source;
  source.mapping = mappingProfile;
  source.mappingProfileDigest = mappingProfileDigest;
  assert.deepEqual(parsedRecordDependencies(parsed, frozen), [{ parsedBusinessKey: 'out1', sourceRecordRef: ref }]);
  for (const digest of [undefined, 'malformed', otherDigest]) {
    assert.equal(parsedRecordDependencies(parsed, { ...frozen, mappingProfileDigest: digest }), null);
  }
  evidence.mappingProfileDigest = otherDigest;
  assert.equal(parsedRecordDependencies(parsed, frozen), null);
  evidence.mappingProfileDigest = mappingProfileDigest;
  source.mappingProfileDigest = otherDigest;
  assert.equal(parsedRecordDependencies(parsed, frozen), null);
});
test('missing or inconsistent evidence is unknown, not guessed from keys or concepts', () => {
  for (const mutate of [
    (p: any) => delete p.financial_evidence,
    (p: any) => delete p.financial_evidence.inputs[0].businessKeys,
    (p: any) => delete p.adapter,
    (p: any) => delete p.rows,
    (p: any) => { p.source_columns.push('business_key'); },
    (p: any) => { p.financial_evidence.mappingVersion = 'unregistered'; },
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

test('exact impact never matches just key, concept or revision, and incomplete negative is unknown', () => {
  const refs = readRecordDependencySelection({ recordRefs: [ref, { ...ref, revision_id: 'r2' }, { ...ref, snapshot_id: 's2' }] });
  const edge = { parsedBusinessKey: 'out', sourceRecordRef: ref };
  assert.deepEqual(selectRecordDependencyImpact(refs, [edge], []).results.map(item => item.status),
    ['observed', 'not_observed', 'not_observed']);
  assert.deepEqual(selectRecordDependencyImpact(refs, [edge], ['missing_evidence']).results.map(item => item.status),
    ['observed', 'unknown', 'unknown']);
  for (const invalid of [{ recordRefs: [] }, { recordRefs: [ref, ref] }, { recordRefs: Array(129).fill(ref) },
    { recordRefs: [{ ...ref, revision_id: 'latest' }] }, { recordRefs: [{ ...ref, values: 'SECRET' }] },
    { recordRefs: [{ logical_key: 'k1' }] }, { recordRefs: [ref], concept: 'revenue' }])
    assert.throws(() => readRecordDependencySelection(invalid), /精确影响|记录引用/u);
});
