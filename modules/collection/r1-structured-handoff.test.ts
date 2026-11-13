import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { RestrictionEvidence } from './purpose-eligibility.js';
import { buildStructuredIngestDocument, R1HandoffService, type R1LocalReferences, type R1SourceRef, type R1StructuredRequest } from './r1-structured-handoff.js';

const raw = Buffer.from('business_key,value\nfixture:1,12.30\n');
const artifact = Buffer.from('[{"business_key":"fixture:1","value":"12.30"}]');
const source = (id = 'fixture:one'): R1SourceRef => ({ source_id: id, provider: 'synthetic-test',
  requested_url: `https://${id.endsWith('one') ? 'one' : 'two'}.example.test/input.csv`,
  requested_at_utc: '2026-01-02T00:00:00Z', acquired_at_utc: '2026-01-02T00:01:00Z',
  sha256: wfdSha256(raw), bytes: raw.byteLength, license: 'synthetic-test', usage_scope: 'isolated-test',
  authorization: { status: 'authorized', basis: 'operator declared isolated synthetic test use' } });
const structured = (requestId = 'test-r1-1'): R1StructuredRequest => ({ datasetId: 'test-r1', namespace: 'test.r1',
  producerNamespace: 'test.r1', requestId, submissionDigest: 'sha256:' + '0'.repeat(64), expectedParentSnapshotId: null,
  outputKey: 'test.scalar', subject: { kind: 'entity', namespace: 'test', id: 'one' }, definition: { semantic_code: 'test.scalar' },
  inputMode: 'partial_observation', coverage: { scope: { test: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
  payload: { kind: 'scalar_rows', rows: [{ business_key: 'fixture:1', value_decimal: '12.30', value_state: 'valid_value' }] } });
// Unit reader contract only. Actual ProcessingPlanService / application assembly is covered by the HTTP integration suite.
const reader = (withPurpose = true, withRestriction = true) => ({ get: (planId: string) => {
  if (planId !== 'plan:one') throw new Error('plan not found');
  return { planId, version: 'bd-processing-plan/1', materials: [{ materialId: 'material:one', sha256: wfdSha256(raw) }],
    outputs: [{ outputId: 'out', state: 'structured', materialIds: ['material:one'], publishEligible: true, routingState: 'ready_candidate',
      usage: withPurpose ? { purpose: 'current_publish', historyMode: null, cutoff: null, perspective: null,
        purposeEvidence: [{ purpose: 'current_publish', authority: 'operator-http', quote: 'structured action: intendedAction=publish',
          observedAtUtc: '2026-11-07T00:00:00Z', evidenceSha256: 'd'.repeat(64), requestId: 'test-plan' }],
        restriction: withRestriction ? { authority: 'wfd_usage_governance_check', result: 'no_known_issue',
          checkedAtUtc: '2026-11-07T00:00:00Z', evidenceSha256: 'e'.repeat(64) } : null } : null }] };
}, outputArtifact: (planId: string, outputId: string) => {
  if (planId !== 'plan:one' || outputId !== 'out') throw new Error('output not found');
  return { bytes: Buffer.from(artifact) };
} });
function refs(originalId: string, input = structured(), src = source()): R1LocalReferences {
  return { originalIds: [originalId], materialIds: [], sourceRefs: [src], processRefs: [{ process_id: 'plan:one/out',
    plan_id: 'plan:one', output_id: 'out', version: 'bd-processing-plan/1', input_sha256: src.sha256,
    output_sha256: wfdSha256(artifact), evidence_sha256: wfdSha256(artifact),
    document_sha256: wfdSha256(canonicalWfdJson(buildStructuredIngestDocument(input))) }],
    evidenceRefs: [{ ref_id: 'artifact:' + wfdSha256(artifact), content_sha256: wfdSha256(artifact), kind: 'processing-output' }] };
}
const expectCode = (work: () => unknown, code: string) => assert.throws(work, (error: unknown) => (error as { code?: string }).code === code);

test('R1 checks original publication purpose and WFD restriction before prepare and first send', () => {
  const database = new CoreDatabase();
  try {
    let withPurpose = false, withRestriction = true;
    const processing = {
      get: (planId: string) => reader(withPurpose, withRestriction).get(planId),
      outputArtifact: reader().outputArtifact,
    };
    const service = new R1HandoffService({ database, processing });
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const input = structured('original-publication-usage');
    input.definition = { ...input.definition, measurement_nature: 'mixed_observation',
      semantic_context: { content_nature: 'source_claim' } };
    const prepare = () => service.prepare({ structured: input, localRefs: refs(original.originalId, input) });
    const firstSend = (restriction?: RestrictionEvidence) => service.assertPublicationReadyToSend(input.requestId, restriction);
    expectCode(prepare, 'R1_USAGE_DECLARATION_MISSING');
    withPurpose = true;
    withRestriction = false;
    expectCode(prepare, 'PURPOSE_ELIGIBILITY_INSUFFICIENT');
    withRestriction = true;
    for (const declaration of [
      { measurement_nature: 'derived' },
      { semantic_context: { content_nature: 'deterministic_derived' } },
      { algorithm_definition: { mathematical_definition: 'MACD' } },
    ]) {
      const claimed = { ...input, definition: { ...input.definition, ...declaration } };
      expectCode(() => service.prepare({ structured: claimed, localRefs: refs(original.originalId, claimed) }),
        'R1_DERIVED_PROOF_REQUIRED');
    }
    prepare();
    withPurpose = false;
    expectCode(firstSend, 'R1_USAGE_DECLARATION_MISSING');
    withPurpose = true;
    withRestriction = false;
    expectCode(firstSend, 'PURPOSE_ELIGIBILITY_INSUFFICIENT');
    firstSend({ authority: 'wfd_usage_governance_check', result: 'no_known_issue',
      checkedAtUtc: '2026-11-07T00:00:00Z', evidenceSha256: 'e'.repeat(64) });
    assert.equal(service.attempt(input.requestId).state, 'prepared_profile_pending');
  } finally { database.close(); }
});

function registeredNotPublished(service: R1HandoffService, requestId: string): WfdRecord {
  const document = JSON.parse(String(service.attempt(requestId).document_json)) as WfdRecord;
  return { state: 'registered_not_published', request_identity: document.request_identity, snapshot_id: null,
    formal_publication_verified: false, formal_publication_ref: null, output_results: [{ output_key: 'test.scalar',
      product_id: 'registered-product', registration_state: 'registered', publication_state: 'not_published',
      definition_ref: { id: 'registered-definition', digest: 'sha256:' + '1'.repeat(64) },
      errors: [{ code: 'UNIT_DIMENSION_MISMATCH', message: 'Injected unit dimension is incompatible with data_type' }] }] };
}

test('R1 complete registered-but-unpublished output rejection preserves registration and cannot resubmit', async () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const input = structured('registered-output-rejected'); service.prepare({ structured: input, localRefs: refs(original.originalId, input) });
    const result = registeredNotPublished(service, input.requestId);
    // Unit receipt classification only; real Python submit/status is covered by the batch HTTP tests.
    const consumed = await service.consumeResult(input.requestId, result, {} as never);
    assert.equal(consumed.state, 'rejected'); assert.equal(consumed.registration_preserved, true);
    assert.equal(service.attempt(input.requestId).pending_count, 0);
    assert.equal(service.attempt(input.requestId).receipt_json, canonicalWfdJson(result));
    const error = JSON.parse(String(service.attempt(input.requestId).error_json));
    assert.equal(error.wfd_state, 'registered_not_published'); assert.equal(error.registration_preserved, true);
    assert.equal(error.errors[0].output_key, 'test.scalar'); assert.equal(error.errors[0].code, 'UNIT_DIMENSION_MISMATCH');
    assert.equal((service.localExplanation(input.requestId).associations as unknown[]).length, 0);
    await assert.rejects(service.submitAndAssociate(input.requestId, {} as never), (error: unknown) => (error as { code?: string }).code === 'R1_WFD_REJECTED');
    const recovered = await service.recoverStatus(input.requestId, {} as never);
    assert.equal(recovered.state, 'rejected'); assert.equal(recovered.registration_preserved, true);
  } finally { database.close(); }
});

test('R1 registration summaries, incomplete outputs, any records or publication facts remain pending', async () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const changes: ((value: WfdRecord) => void)[] = [
      value => { value.state = 'publication_unknown'; },
      value => { (value.output_results as WfdRecord[])[0]!.errors = []; },
      value => { (value.output_results as WfdRecord[])[0]!.publication_state = 'published_formal'; },
      value => { (value.output_results as WfdRecord[])[0]!.publication_state = 'published_sandbox'; },
      value => { (value.output_results as WfdRecord[])[0]!.records = [{ record_id: 'r', record_version: 'v' }]; },
      value => { (value.output_results as WfdRecord[])[0]!.engine_publication_state = 'committed_pending_activation'; },
      value => { value.snapshot_id = 'some-snapshot'; },
      value => { value.formal_publication_verified = true; },
      value => { value.formal_publication_ref = 'formal-receipt'; },
      value => { value.publication_summary = { published_formal: 1, not_published: 1 }; },
      value => { value.outputs_total = 2; },
      value => { value.outputs_complete = false; },
      value => { value.outputs_included = 0; },
      value => { value.pagination = { has_more: true, detail: 'full' }; },
      value => { value.bounded = true; value.view = 'bounded_page'; value.outputs_complete = true; value.pagination = { has_more: false, detail: 'summary' }; },
      value => { (value.output_results as WfdRecord[])[0]!.output_key = 'another-output'; },
      value => { delete (value.output_results as WfdRecord[])[0]!.product_id; },
      value => { delete (value.output_results as WfdRecord[])[0]!.definition_ref; },
    ];
    for (const [index, change] of changes.entries()) {
      const input = structured(`nonterminal-registration-${index}`); service.prepare({ structured: input, localRefs: refs(original.originalId, input) });
      const result = registeredNotPublished(service, input.requestId); change(result);
      assert.equal((await service.consumeResult(input.requestId, result, {} as never)).state, 'pending_receipt', String(index));
      assert.equal((service.localExplanation(input.requestId).associations as unknown[]).length, 0);
    }
  } finally { database.close(); }
});

test('R1 recovery accepts only a complete full-detail registration rejection under the original identity', async () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const input = structured('registered-output-status'); service.prepare({ structured: input, localRefs: refs(original.originalId, input) });
    service.markSending(input.requestId);
    const result = { ...registeredNotPublished(service, input.requestId), bounded: true, view: 'bounded_page',
      outputs_total: 1, outputs_complete: true, outputs_included: 1, outputs_offset: 0, outputs_remaining: 0,
      pagination: { offset: 0, has_more: false, detail: 'full' } };
    let lookups = 0;
    const client = { requestStatusPage: async () => { lookups++; return { result }; } } as never;
    const recovered = await service.recoverStatus(input.requestId, client);
    assert.equal(recovered.state, 'rejected'); assert.equal(recovered.registration_preserved, true);
    assert.equal(service.attempt(input.requestId).receipt_json, canonicalWfdJson(result));
    await service.recoverStatus(input.requestId, client); assert.equal(lookups, 1);
  } finally { database.close(); }
});

test('F01: absent processing reader fails closed (actual R1 class, no transpiler stub)', () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database });
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    expectCode(() => service.prepare({ structured: structured(), localRefs: refs(original.originalId) }), 'R1_PROCESSING_UNBOUND');
    assert.equal(database.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts').get()!.n, 0);
  } finally { database.close(); }
});

test('F01: fixed plan/output, actual bytes, input and document digests are all required', () => {
  const database = new CoreDatabase();
  try {
    const processing = reader(), service = new R1HandoffService({ database, processing });
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const input = structured(), good = refs(original.originalId, input);
    assert.equal(service.prepare({ structured: input, localRefs: good }).state, 'prepared_profile_pending');
    assert.equal(service.prepare({ structured: input, localRefs: good }).requestId, input.requestId);
    for (const [field, value, code] of [
      ['plan_id', undefined, 'R1_PROCESS_REFERENCE_REQUIRED'], ['plan_id', 'missing', 'R1_PROCESS_NOT_FOUND'],
      ['output_id', 'missing', 'R1_PROCESS_NOT_FOUND'], ['input_sha256', '0'.repeat(64), 'R1_PROCESS_INPUT_MISMATCH'],
      ['output_sha256', '0'.repeat(64), 'R1_PROCESS_OUTPUT_MISMATCH'], ['document_sha256', '0'.repeat(64), 'R1_PROCESS_DOCUMENT_MISMATCH'],
      ['evidence_sha256', '0'.repeat(64), 'R1_PROCESS_EVIDENCE_MISMATCH'],
    ] as const) {
      const changed = structuredClone(good); Object.assign(changed.processRefs[0], { [field]: value });
      expectCode(() => service.prepare({ structured: input, localRefs: changed }), code);
    }
    processing.outputArtifact = () => ({ bytes: Buffer.from('changed bytes') });
    expectCode(() => service.prepare({ structured: input, localRefs: good }), 'R1_PROCESS_OUTPUT_MISMATCH');
  } finally { database.close(); }
});

test('F01: process version comes from the frozen plan, not a nonempty caller label', () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const input = structured('version-forgery'), changed = refs(original.originalId, input);
    changed.processRefs[0]!.version = 'invented-version';
    expectCode(() => service.prepare({ structured: input, localRefs: changed }), 'R1_PROCESS_VERSION_MISMATCH');
    assert.equal(database.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts').get()!.n, 0);
  } finally { database.close(); }
});

test('F01: submit rechecks current processing bytes before any external send', async () => {
  const database = new CoreDatabase();
  try {
    const processing = reader(), service = new R1HandoffService({ database, processing });
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    service.prepare({ structured: structured(), localRefs: refs(original.originalId) });
    processing.outputArtifact = () => ({ bytes: Buffer.from('changed after prepare') });
    await assert.rejects(service.submitAndAssociate('test-r1-1', {} as never), (error: unknown) => (error as { code?: string }).code === 'R1_PROCESS_OUTPUT_MISMATCH');
    assert.equal(service.attempt('test-r1-1').state, 'prepared_profile_pending');
  } finally { database.close(); }
});

test('F01: source UTC facts reject rollover dates, shorthand and silent submillisecond truncation', () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    for (const fraction of ['', '.0', '.00', '.000', '.1', '.12', '.123']) {
      const declared = { ...source(), requested_at_utc: `2026-01-02T00:00:00${fraction}Z`, acquired_at_utc: `2026-01-02T00:00:01${fraction}Z` };
      assert.ok(service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: declared }).originalId);
    }
    const before = database.connection.prepare('SELECT count(*) n FROM r1_originals').get()!.n;
    for (const value of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-1-2Z',
      '2026-01-02T24:00:00Z', '2026-01-02T00:00:00.0001Z', '2026-01-02T00:00:00+00:00']) {
      expectCode(() => service.registerOriginal({ bytes: raw, originalName: 'input.csv',
        source: { ...source(), requested_at_utc: value, acquired_at_utc: value } }), 'R1_SOURCE_TIME');
    }
    expectCode(() => service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: { ...source(),
      requested_at_utc: '2026-01-02T00:00:00.12Z', acquired_at_utc: '2026-01-02T00:00:00.1Z' } }), 'R1_SOURCE_TIME');
    assert.equal(database.connection.prepare('SELECT count(*) n FROM r1_originals').get()!.n, before);
  } finally { database.close(); }
});

test('F02: identical content shares bytes but never collapses distinct source acquisitions', () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    const one = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const two = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source('fixture:two') });
    const again = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    assert.notEqual(one.originalId, two.originalId); assert.deepEqual(again, one);
    assert.equal(database.connection.prepare('SELECT count(*) n FROM r1_originals').get()!.n, 2);
    assert.equal(database.connection.prepare('SELECT count(*) n FROM r1_original_contents').get()!.n, 1);
    const input = structured();
    service.prepare({ structured: input, localRefs: refs(two.originalId, input, source('fixture:two')) });
    expectCode(() => service.prepare({ structured: input, localRefs: refs(one.originalId, input, source('fixture:two')) }), 'R1_SOURCE_CHANGED');
    const changedTime = { ...source(), acquired_at_utc: '2026-01-02T00:02:00Z' };
    assert.notEqual(service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: changedTime }).originalId, one.originalId);
    const nextBytes = Buffer.from('new revision'), nextSource = { ...source(), sha256: wfdSha256(nextBytes), bytes: nextBytes.length };
    assert.notEqual(service.registerOriginal({ bytes: nextBytes, originalName: 'input.csv', source: nextSource }).originalId, one.originalId);
  } finally { database.close(); }
});

test('F02: v1 migration retains IDs, source metadata, timestamps, references and exact bytes', () => {
  const database = new CoreDatabase();
  try {
    database.migrate('r1-structured-handoff', 1, `CREATE TABLE r1_originals (
      original_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,original_name TEXT NOT NULL,media_type TEXT NOT NULL,
      source_json TEXT NOT NULL,source_digest TEXT NOT NULL,original_bytes BLOB NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE r1_record_associations (
 dataset_id TEXT NOT NULL, product_id TEXT NOT NULL, definition_digest TEXT NOT NULL,
 snapshot_id TEXT NOT NULL, record_id TEXT NOT NULL, record_version TEXT NOT NULL,
 request_id TEXT NOT NULL, original_id TEXT NOT NULL, source_id TEXT NOT NULL,
 process_refs_json TEXT NOT NULL, evidence_refs_json TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(dataset_id,product_id,record_id,record_version));
 CREATE INDEX r1_assoc_request ON r1_record_associations(request_id);
      CREATE TABLE historical_refs(original_id TEXT NOT NULL,request_id TEXT NOT NULL);`);
    const src = canonicalWfdJson(source());
    database.connection.prepare('INSERT INTO r1_originals VALUES(?,?,?,?,?,?,?,?)').run('old-original', wfdSha256(raw), 'old.csv', 'text/csv', src, wfdSha256(src), raw, 12345);
    database.connection.prepare('INSERT INTO historical_refs VALUES(?,?)').run('old-original', 'old-request');
    new R1HandoffService({ database });
    new R1HandoffService({ database }); // restart/reassembly is idempotent; no downgrade attempt.
    const old = database.connection.prepare('SELECT * FROM r1_originals WHERE original_id=?').get('old-original')!;
    assert.equal(old.source_json, src); assert.equal(old.created_at, 12345); assert.equal(old.sha256, wfdSha256(raw));
    assert.deepEqual(Buffer.from(database.connection.prepare('SELECT original_bytes FROM r1_original_contents').get()!.original_bytes as Uint8Array), raw);
    assert.equal(database.connection.prepare('SELECT request_id FROM historical_refs JOIN r1_originals USING(original_id)').get()!.request_id, 'old-request');
  } finally { database.close(); }
});

test('F02: source size/digest are checked and stored content corruption fails closed', () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    expectCode(() => service.registerOriginal({ bytes: raw, originalName: 'a', source: { ...source(), bytes: 1 } }), 'R1_SOURCE_BYTES_MISMATCH');
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    database.connection.prepare('UPDATE r1_original_contents SET original_bytes=?').run(Buffer.from('tampered'));
    expectCode(() => service.prepare({ structured: structured(), localRefs: refs(original.originalId) }), 'R1_SOURCE_MISMATCH');
  } finally { database.close(); }
});

function duplicateResult(service: R1HandoffService, input: R1StructuredRequest, options: {
  states: ('inserted' | 'duplicate_skipped' | 'conflict_pending')[]; state: string; versions?: string[];
}): WfdRecord {
  const document = JSON.parse(String(service.attempt(input.requestId).document_json)) as WfdRecord;
  const payloadRows = input.payload.rows as WfdRecord[];
  const rowResults = options.states.map((state, row_index) => state === 'conflict_pending'
    ? { row_index, business_key: payloadRows[row_index]!.business_key, state, reason: 'same_request_different_content',
      difference_fields: ['value_decimal'], existing_records: [] }
    : { row_index, business_key: payloadRows[row_index]!.business_key, state, record_id: payloadRows[row_index]!.business_key,
      record_version: options.versions?.[row_index] ?? 'version-1' });
  const records = [...new Map(rowResults.filter(row => row.state !== 'conflict_pending').map(row =>
    [row.record_id, { record_id: row.record_id, record_version: row.record_version }])).values()];
  const summary = { inserted: options.states.filter(state => state === 'inserted').length,
    duplicate_skipped: options.states.filter(state => state === 'duplicate_skipped').length,
    conflict_pending: options.states.filter(state => state === 'conflict_pending').length };
  return { state: options.state, new_snapshot_created: summary.inserted > 0, request_identity: document.request_identity, row_summary: summary, output_results: [{
    output_key: input.outputKey, product_id: 'dedup-product', definition_ref: { id: 'definition-1', digest: 'definition-digest' },
    snapshot_id: 'fixed-snapshot', new_snapshot_created: summary.inserted > 0,
    row_results: rowResults, row_summary: summary, records, inserted_records: records.filter(record => rowResults.some(row => row.state === 'inserted' && row.record_id === record.record_id)),
    row_results_total: rowResults.length, row_results_offset: 0, row_results_included: rowResults.length,
    row_results_complete: true, next_row_offset: null,
  }] };
}
function duplicateReader(input: R1StructuredRequest) {
  return { fixedRead: async () => ({ result: { rows: (input.payload.rows as WfdRecord[]).map(row => ({
    record_id: row.business_key, record_version: 'version-1', product_id: 'dedup-product', definition_ref: { digest: 'definition-digest' },
    record_ref: { snapshot_id: 'fixed-snapshot', logical_key: row.business_key, revision_id: 'version-1' }, row,
  })) } }) };
}

test('duplicate intake retains each new source link and resolves original publication materials separately', async () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    const first = { ...structured('dedup-insert'), duplicatePolicy: 'skip_identical_append' as const };
    const original = service.registerOriginal({ bytes: raw, originalName: 'first.csv', source: source() });
    service.prepare({ structured: first, localRefs: refs(original.originalId, first) });
    assert.equal((await service.consumeResult(first.requestId, duplicateResult(service,first,{states:['inserted'],state:'published_formal'}),duplicateReader(first) as never)).state, 'associated');
    const second = { ...first, requestId: 'dedup-second' }, secondSource = source('fixture:two');
    const newOriginal = service.registerOriginal({ bytes: raw, originalName: 'second.csv', source: secondSource });
    service.prepare({ structured: second, localRefs: refs(newOriginal.originalId, second, secondSource) });
    const receipt = duplicateResult(service,second,{states:['duplicate_skipped'],state:'unchanged'});
    assert.equal((await service.consumeResult(second.requestId,receipt,duplicateReader(second) as never)).state, 'associated');
    const firstLinks = service.localExplanation(first.requestId).associations as WfdRecord[];
    const secondLinks = service.localExplanation(second.requestId).associations as WfdRecord[];
    assert.equal(firstLinks.length,1); assert.equal(secondLinks.length,1);
    assert.equal(firstLinks[0]!.original_id,original.originalId); assert.equal(secondLinks[0]!.original_id,newOriginal.originalId);
    assert.equal(service.recordMaterials({ datasetId:first.datasetId,productId:'dedup-product',recordId:'fixture:1',recordVersion:'version-1' })!.requestId,first.requestId);
    assert.equal((await service.submitAndAssociate(second.requestId,{} as never)).state,'associated');
    assert.equal((await service.recoverStatus(second.requestId,{} as never)).state,'associated');
    assert.equal(database.connection.prepare('SELECT count(*) n FROM r1_record_associations').get()!.n,2);
  } finally { database.close(); }
});

test('duplicate reference alone never attributes an old WFD publication to the new source', async () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    const input = { ...structured('dedup-existing-only'), duplicatePolicy: 'skip_identical_append' as const };
    const original = service.registerOriginal({ bytes:raw,originalName:'new.csv',source:source() });
    service.prepare({ structured:input,localRefs:refs(original.originalId,input) });
    await service.consumeResult(input.requestId,duplicateResult(service,input,{states:['duplicate_skipped'],state:'unchanged'}),duplicateReader(input) as never);
    assert.equal((service.localExplanation(input.requestId).associations as unknown[]).length,1);
    assert.equal(service.recordMaterials({datasetId:input.datasetId,productId:'dedup-product',recordId:'fixture:1',recordVersion:'version-1'}),null);
  } finally { database.close(); }
});

test('same-request conflicting rows remain terminal pending confirmation with no invented accepted identities', async () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    const input = { ...structured('dedup-conflicts'), duplicatePolicy:'skip_identical_append' as const };
    input.payload.rows = [...input.payload.rows as WfdRecord[], {...(input.payload.rows as WfdRecord[])[0],value_decimal:'99.99'}];
    const original = service.registerOriginal({bytes:raw,originalName:'conflicts.csv',source:source()});
    service.prepare({structured:input,localRefs:refs(original.originalId,input)});
    const result = await service.consumeResult(input.requestId,duplicateResult(service,input,{states:['conflict_pending','conflict_pending'],state:'conflicts_pending'}),{} as never);
    assert.equal(result.state,'conflicts_pending'); assert.equal((service.localExplanation(input.requestId).associations as unknown[]).length,0);
    const receipt = service.localExplanation(input.requestId).receipt as WfdRecord;
    assert.equal((receipt.conflicts as WfdRecord[])[0]!.confirmation_state,'pending_user_confirmation');
    assert.equal(((receipt.conflicts as WfdRecord[])[0]!.incoming_conflict_rows as unknown[]).length,1);
    assert.equal((await service.submitAndAssociate(input.requestId,{} as never)).state,'conflicts_pending');
    assert.equal((await service.recoverStatus(input.requestId,{} as never)).state,'conflicts_pending');
  } finally { database.close(); }
});

test('duplicate full-status row pages must be continuous and complete before fixed read or association', async () => {
  for (const corrupt of [false,true]) {
    const database=new CoreDatabase();
    try {
      const service=new R1HandoffService({database,processing:reader()}), input={...structured('dedup-status-'+corrupt),duplicatePolicy:'skip_identical_append' as const};
      input.payload.rows=[1,2,3].map(n=>({business_key:'fixture:'+n,value_decimal:'12.30',value_state:'valid_value'}));
      const original=service.registerOriginal({bytes:raw,originalName:'status.csv',source:source()});service.prepare({structured:input,localRefs:refs(original.originalId,input)});
      const result=duplicateResult(service,input,{states:['inserted','inserted','inserted'],state:'published_formal'}), full=(result.output_results as WfdRecord[])[0]!;
      const initial={...result,output_results:[{...full,row_results:undefined,row_results_complete:false}]};
      let reads=0,calls=0;
      const client={...duplicateReader(input),fixedRead:async()=>{reads++;return duplicateReader(input).fixedRead();},requestStatusPage:async(_identity:unknown,options:{rowOffset:number})=>{
        calls++;const offset=options.rowOffset;
        return {result:{...result,outputs_total:1,outputs_complete:true,pagination:{detail:'full'},output_results:[{...full,
          row_results:(full.row_results as WfdRecord[]).slice(offset,offset+1),records:(full.records as WfdRecord[]).slice(offset,offset+1),
          inserted_records:(full.records as WfdRecord[]).slice(offset,offset+1),row_results_offset:corrupt?offset+1:offset,row_results_included:1,row_results_complete:false,next_row_offset:offset<2?offset+1:null}]}};
      }};
      if(corrupt){await assert.rejects(service.consumeResult(input.requestId,initial,client as never),{code:'R1_ROW_STATUS_PAGE'});assert.equal(reads,0);}
      else{assert.equal((await service.consumeResult(input.requestId,initial,client as never)).state,'associated');assert.equal(calls,3);assert.equal(reads,1);}
      assert.equal((service.localExplanation(input.requestId).associations as unknown[]).length,corrupt?0:3);
    } finally {database.close();}
  }
});

test('association v2 to v3 preserves every old field and frozen request byte, then reopens unchanged', () => {
  const database=new CoreDatabase();
  try{
    let service=new R1HandoffService({database,processing:reader()});
    const original=service.registerOriginal({bytes:raw,originalName:'migration.csv',source:source()});
    const input=structured('migration-frozen');service.prepare({structured:input,localRefs:refs(original.originalId,input)});
    database.connection.prepare('INSERT INTO r1_record_associations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('test-r1','product-old','definition-old','snapshot-old','row-old','version-old',input.requestId,original.originalId,'source-old','[ {"kept": true} ]','[ "raw evidence bytes" ]',1234);
    database.connection.exec(`DROP INDEX r1_assoc_request; ALTER TABLE r1_record_associations RENAME TO association_new;
      CREATE TABLE r1_record_associations (dataset_id TEXT NOT NULL,product_id TEXT NOT NULL,definition_digest TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,record_id TEXT NOT NULL,record_version TEXT NOT NULL,request_id TEXT NOT NULL,
      original_id TEXT NOT NULL,source_id TEXT NOT NULL,process_refs_json TEXT NOT NULL,evidence_refs_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,PRIMARY KEY(dataset_id,product_id,record_id,record_version));
      INSERT INTO r1_record_associations SELECT * FROM association_new; DROP TABLE association_new;
      CREATE INDEX r1_assoc_request ON r1_record_associations(request_id);
      UPDATE schema_versions SET version=2 WHERE module='r1-structured-handoff';`);
    database.connection.prepare('UPDATE r1_handoff_attempts SET receipt_json=?').run(' { \"old_receipt\": true } ');
    const attempt=database.connection.prepare('SELECT * FROM r1_handoff_attempts').all(),links=database.connection.prepare('SELECT * FROM r1_record_associations').all();
    service=new R1HandoffService({database,processing:reader()});
    assert.deepEqual(database.connection.prepare('SELECT * FROM r1_handoff_attempts').all(),attempt);
    assert.deepEqual(database.connection.prepare('SELECT * FROM r1_record_associations').all(),links);
    assert.equal(database.connection.prepare("SELECT version FROM schema_versions WHERE module='r1-structured-handoff'").get()!.version,3);
    service=new R1HandoffService({database,processing:reader()});
    assert.deepEqual(database.connection.prepare('SELECT * FROM r1_handoff_attempts').all(),attempt);
    assert.deepEqual(database.connection.prepare('SELECT * FROM r1_record_associations').all(),links);
    assert.equal(service.attempt(input.requestId).document_json,attempt[0]!.document_json);
  }finally{database.close();}
});

test('existing R1 version with a missing association table is rejected before changing originals or version',()=>{
  const database=new CoreDatabase();
  try{
    database.migrate('r1-structured-handoff',1,`CREATE TABLE r1_originals(original_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,media_type TEXT NOT NULL,source_json TEXT NOT NULL,source_digest TEXT NOT NULL,original_bytes BLOB NOT NULL,created_at INTEGER NOT NULL);`);
    assert.throws(()=>new R1HandoffService({database}),{code:'R1_ASSOCIATIONS_MISSING'});
    assert.equal(database.connection.prepare("SELECT version FROM schema_versions WHERE module='r1-structured-handoff'").get()!.version,1);
    assert.equal(database.connection.prepare("SELECT name FROM sqlite_master WHERE name='r1_original_contents'").get(),undefined);
    assert.equal(database.connection.prepare("SELECT name FROM sqlite_master WHERE name='r1_record_associations'").get(),undefined);
  }finally{database.close();}
});

test('withdrawn conflict uses exact fixed historical read and stays a conflict without resubmission',async()=>{
  const database=new CoreDatabase();
  try{
    const service=new R1HandoffService({database,processing:reader()}),input={...structured('withdrawn-conflict'),duplicatePolicy:'skip_identical_append' as const};
    const original=service.registerOriginal({bytes:raw,originalName:'withdrawn.csv',source:source()});service.prepare({structured:input,localRefs:refs(original.originalId,input)});
    const result=duplicateResult(service,input,{states:['conflict_pending'],state:'conflicts_pending'}),output=(result.output_results as WfdRecord[])[0]!;
    (output.row_results as WfdRecord[])[0]!.existing_records=[{record_id:'fixture:1',record_version:'version-1',product_id:'dedup-product',snapshot_id:'fixed-snapshot',definition_ref:{digest:'definition-digest'},withdrawn:true}];
    let historical=0;
    const client={pageReadSupport:async()=>true,fixedReadPage:async()=>{throw Error('Withdrawn leaves are never selected from current pages');},fixedReadHistory:async()=>{
      historical++;const reply=await duplicateReader(input).fixedRead();Object.assign(reply.result.rows[0]!,{revision:{withdrawn:true},revision_state:'withdrawn'});return reply;
    }};
    assert.equal((await service.consumeResult(input.requestId,result,client as never)).state,'conflicts_pending');assert.equal(historical,1);
    const conflicts=(service.localExplanation(input.requestId).receipt as WfdRecord).conflicts as WfdRecord[];
    assert.equal(((conflicts[0]!.existing_rows as WfdRecord[])[0]!.revision as WfdRecord).withdrawn,true);
    assert.equal((service.localExplanation(input.requestId).associations as unknown[]).length,0);
  }finally{database.close();}
});

test('same-key conflict examples are bounded and include opposing content beyond an identical prefix',async()=>{
  const database=new CoreDatabase();
  try{
    const service=new R1HandoffService({database,processing:reader()}),input={...structured('bounded-conflicts'),duplicatePolicy:'skip_identical_append' as const};
    input.payload.rows=[...Array.from({length:4},()=>({...((input.payload.rows as WfdRecord[])[0])})),{...(input.payload.rows as WfdRecord[])[0],value_decimal:'99.99'}];
    const original=service.registerOriginal({bytes:raw,originalName:'bounded.csv',source:source()});service.prepare({structured:input,localRefs:refs(original.originalId,input)});
    const consumed=await service.consumeResult(input.requestId,duplicateResult(service,input,{states:Array(5).fill('conflict_pending'),state:'conflicts_pending'}),{} as never);
    assert.equal(consumed.state,'conflicts_pending');
    const conflicts=(service.localExplanation(input.requestId).receipt as WfdRecord).conflicts as WfdRecord[];
    assert.equal(conflicts.length,5);
    for(const row of conflicts){assert.equal(row.incoming_conflict_rows_total,4);assert.ok((row.incoming_conflict_rows as unknown[]).length<=4);}
    assert.match(JSON.stringify(conflicts[0]!.incoming_conflict_rows),/99\.99/);
  }finally{database.close();}
});

test('描述档待核只能写入未发送的准备态；待核对与已结算状态拒绝覆盖', async () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const input = structured('profile-state-lock');
    service.prepare({ structured: input, localRefs: refs(original.originalId, input) });
    service.markProfileUnavailable(input.requestId, 'TIER_UNAVAILABLE', '描述档当前不可用');
    assert.equal(service.attempt(input.requestId).state, 'pending_wfd_profile');
    database.connection.prepare("UPDATE r1_handoff_attempts SET state='pending_receipt' WHERE request_id=?").run(input.requestId);
    expectCode(() => service.markProfileUnavailable(input.requestId, 'TIER_UNAVAILABLE', '再次改写'), 'R1_PROFILE_STATE_LOCKED');
    assert.equal(service.attempt(input.requestId).state, 'pending_receipt');
  } finally { database.close(); }
});

test('固定读回失败时先落提交方逐行回执，再报待核对', async () => {
  const database = new CoreDatabase();
  try {
    const service = new R1HandoffService({ database, processing: reader() });
    const original = service.registerOriginal({ bytes: raw, originalName: 'input.csv', source: source() });
    const input = structured('receipt-on-readback-failure');
    service.prepare({ structured: input, localRefs: refs(original.originalId, input) });
    const receipt = { dataset_id: input.datasetId, output_key: input.outputKey, product_id: 'p_1',
      definition_digest: 'sha256:' + '2'.repeat(64), snapshot_id: 's_1', request_identity: {}, state: 'committed',
      rows: [{ business_key: 'fixture:1', record_id: 'r_1', record_version: 'v_1', values: {} }] } as unknown as Parameters<typeof service.recordReceipt>[1];
    const result = await service.recordReceipt(input.requestId, receipt, {} as never);
    assert.equal(result.state, 'pending_receipt');
    const attempt = service.attempt(input.requestId);
    assert.equal(attempt.state, 'pending_receipt');
    assert.equal(attempt.receipt_json, canonicalWfdJson(receipt));
    assert.match(String(attempt.error_json), /R1_FIXED_READ_FAILED/);
  } finally { database.close(); }
});
