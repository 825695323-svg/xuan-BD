import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreDatabase } from '../../platform/state/database.js';
import { TaskRuntimeRegistry, TaskService } from '../../platform/jobs/tasks.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { projectFinancialFixed, assertFinancialLinearCandidate, type FinancialCalculation } from './data-processing/financial-fixed.js';
import { polarsFixedVersionBinding, projectFinancialPolars, type PolarsExecution } from './data-processing/polars-fixed.js';
import { PolarsFixedService, POLARS_FIXED_RUNTIME } from './polars-fixed-service.js';
import { R1HandoffService, buildStructuredIngestDocument, type R1LocalReferences, type R1StructuredRequest } from './r1-structured-handoff.js';

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
async function fixture() {
  const database = new CoreDatabase(), runtimes = new TaskRuntimeRegistry(), tasks = new TaskService({ database, runtimes });
  const calculation: FinancialCalculation = { version: 'bd-financial-fixed/1', operation: 'quarter_difference',
    inputs: [0, 1].map(i => ({ snapshotId: 'snapshot-' + i, productId: 'product-' + i, businessKeys: ['key-' + i] })) };
  const fixed = [0, 1].map(i => ({ record_ref: { logical_key: 'key-' + i, revision_id: 'record-v1' },
    values: Object.fromEntries(Object.entries({ subject_scheme: 'explicit-fixture', subject_code: 'company-one',
      accounting_standard: 'CAS', currency: 'CNY', scope: 'consolidated', unit: 'cny', concept: 'revenue',
      period_type: 'duration', dimension: 'current', report_version: 'v1', start_date: '2024-01-01',
      end_date: i ? '2024-03-31' : '2024-06-30', value: i ? '3' : '10' }).map(([key, value]) => [key, { value, value_state: 'valid_value',
      data_type: key === 'value' ? 'decimal' : 'text', unit: key === 'value' ? { unit_code: 'cny', definition: { dimension: 'money' },
        digest: 'sha256:' + wfdSha256(canonicalWfdJson({ code: 'cny', definition: { dimension: 'money' } })), resolved: true } : { unit_code: 'text' } }])) }));
  // Semantic input and historical task fixtures only: no actual Polars/WFD execution is claimed here.
  const computed = await projectFinancialFixed(calculation, async ref => ({ connection: {}, result: { snapshot_id: ref.snapshotId,
    product_id: ref.productId, rows: [fixed[Number(ref.productId.at(-1))]], page: { has_more: false, next_cursor: null } } }),
  new AbortController().signal, () => { throw new Error('No revision review in this fixture'); });
  const rows = JSON.parse(computed.jsonBytes.toString()) as WfdRecord[], bytes = Buffer.from(canonicalWfdJson(rows));
  const data = { rows, evidence: computed.evidence, algorithmDefinition: computed.evidence.algorithmDefinition,
    candidateSha256: wfdSha256(bytes), publication: 'candidate_only' };
  let prepares = 0;
  const materials = { getByTask: () => ({ envelope: { materialId: 'material-one' } }),
    readOriginal: () => ({ bytes, sha256: wfdSha256(bytes) }) };
  const artifact = Buffer.from(canonicalWfdJson({ rows }));
  const processing = { get: (planId: string) => ({ planId, version: 'bd-processing-plan/1',
    materials: [{ materialId: 'material-one', sha256: wfdSha256(bytes) }],
    outputs: [{ outputId: 'out', state: 'structured', materialIds: ['material-one'], publishEligible: true, routingState: 'ready_candidate' }] }),
  outputArtifact: () => ({ bytes: artifact }) };
  const workspace = { capabilities: () => ({ connection: {} }), prepare: () => { prepares++; return {}; } };
  const service = new PolarsFixedService({ database, tasks: () => tasks, materials, processing, workspace,
    accept: async () => 'custody-one' } as unknown as ConstructorParameters<typeof PolarsFixedService>[0]);
  runtimes.register(service.runtime);
  const task = tasks.create({ title: 'Fixed historical financial candidate', ownerRole: 'service', runtimeId: POLARS_FIXED_RUNTIME,
    action: 'polars.fixed.calculate', requestId: 'polars:financial-proof', args: { input: { requestId: 'financial-proof',
      method: 'financial_linear', calculation }, connection: {}, python: '/explicit-unused-python' } as never,
    versions: polarsFixedVersionBinding() });
  const store = () => database.connection.prepare("UPDATE tasks SET status='succeeded',result=? WHERE id=?")
    .run(canonicalWfdJson({ summary: 'Explicit historical result fixture', data }), task.id);
  store();
  database.connection.exec('CREATE TABLE harness_material_uploads(request_id TEXT,task_id TEXT); CREATE TABLE material_objects(material_id TEXT,envelope_json TEXT);');
  database.connection.prepare('INSERT INTO harness_material_uploads VALUES(?,?)').run('polars-stage:' + task.id, 'custody-one');
  database.connection.prepare('INSERT INTO material_objects VALUES(?,?)').run('material-one', canonicalWfdJson({ taskId: 'custody-one' }));
  const definition = { semantic_code: 'financial.fixture.derived', semantic_context: { content_nature: 'deterministic_derived' },
    measurement_nature: 'derived', algorithm_definition: data.algorithmDefinition };
  const verify = { materialId: 'material-one', planId: 'plan-one', outputId: 'out', definition };
  const source = { source_id: 'explicit-fixture', provider: 'generated isolated unit records', requested_url: 'https://fixture.example.test/input',
    requested_at_utc: '2024-07-01T00:00:00Z', acquired_at_utc: '2024-07-01T00:00:00Z', sha256: wfdSha256(bytes), bytes: bytes.length,
    usage_scope: 'isolated admission tests', authorization: { status: 'authorized' as const, basis: 'explicit synthetic unit fixture use' } };
  const handoff = new R1HandoffService({ database, processing, verifyCalculationCandidate: input => service.verifyCandidate(input.taskId, input) });
  const original = handoff.registerOriginal({ bytes, originalName: 'financial.json', source });
  const structured: R1StructuredRequest = { requestId: 'original-financial-prepare', datasetId: 'financial-fixture', namespace: 'fixture',
    producerNamespace: 'fixture', submissionDigest: 'sha256:' + '0'.repeat(64), expectedParentSnapshotId: null, outputKey: 'financial.derived',
    subject: { kind: 'entity', namespace: 'fixture', id: 'company-one' }, definition, inputMode: 'partial_observation',
    coverage: { scope: { unit: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'scalar_rows', rows: rows.map(row => ({ business_key: row.business_key, value_decimal: row.value,
      value_state: row.value_state, observation_time: { earliest_utc: row.start_utc, latest_exclusive_utc: row.end_utc } })) } };
  const refs = (request: R1StructuredRequest): R1LocalReferences => ({ originalIds: [original.originalId], materialIds: [], sourceRefs: [source],
    processRefs: [{ process_id: 'plan-one/out', plan_id: 'plan-one', output_id: 'out', version: 'bd-processing-plan/1', input_sha256: source.sha256,
      output_sha256: wfdSha256(artifact), evidence_sha256: wfdSha256(artifact), document_sha256: wfdSha256(canonicalWfdJson(buildStructuredIngestDocument(request))) }],
    evidenceRefs: [{ ref_id: 'artifact-one', content_sha256: wfdSha256(artifact), kind: 'processing-output' }] });
  return { database, tasks, task, data, calculation, store, service, handoff, structured, refs, verify, prepares: () => prepares,
    async close() { await tasks.dispose(); database.close(); } };
}

test('financial candidate gates keep old results readable, block every new preparation/first send, and preserve sent recovery', async () => {
  const f = await fixture();
  try {
    f.service.verifyCandidate(f.task.id, f.verify);
    f.handoff.prepare({ structured: f.structured, localRefs: f.refs(f.structured) });
    delete (f.data.evidence as WfdRecord).linearAdmission; f.store();
    const stored = f.database.connection.prepare('SELECT result FROM tasks WHERE id=?').get(f.task.id)!.result;
    assert.equal(f.service.get(f.task.id).candidate!.rowCount, 1);
    assert.throws(() => f.service.prepare(f.task.id, { ...f.verify, target: { definition: f.verify.definition } }), code('FINANCIAL_FIXED_PROOF_REQUIRED'));
    const next = { ...f.structured, requestId: 'new-financial-prepare' };
    assert.throws(() => f.handoff.prepare({ structured: next, localRefs: f.refs(next) }), code('FINANCIAL_FIXED_PROOF_REQUIRED'));
    const state = f.handoff.attempt(f.structured.requestId).state;
    let sends = 0;
    await assert.rejects(f.handoff.submitAndAssociate(f.structured.requestId, { submit: async () => { sends++; } } as never), code('FINANCIAL_FIXED_PROOF_REQUIRED'));
    assert.equal(sends, 0); assert.equal(f.prepares(), 0); assert.equal(f.handoff.attempt(f.structured.requestId).state, state);
    assert.equal(f.database.connection.prepare('SELECT result FROM tasks WHERE id=?').get(f.task.id)!.result, stored);
    for (const sent of ['sending', 'pending_unknown', 'pending_receipt', 'associated']) {
      f.database.connection.prepare('UPDATE r1_handoff_attempts SET state=? WHERE request_id=?').run(sent, f.structured.requestId);
      assert.doesNotThrow(() => f.handoff.assertCalculationReadyToSend(f.structured.requestId));
    }
  } finally { await f.close(); }
});

test('financial candidate admission rechecks selected fixed rows and rejects changed digests or incompatible stored semantics', async () => {
  const f = await fixture();
  try {
    assertFinancialLinearCandidate(f.calculation, f.data.evidence, f.data.rows, () => {});
    const proof = f.data.evidence.linearAdmission!;
    (proof.rows[0]!.values as WfdRecord).currency = { value: 'USD', value_state: 'valid_value' };
    assert.throws(() => assertFinancialLinearCandidate(f.calculation, f.data.evidence, f.data.rows, () => {}), /摘要/u);
    for (const [index, row] of proof.rows.entries()) {
      (row.values as WfdRecord).currency = { value: 'USD', value_state: 'valid_value' };
      f.data.evidence.inputs[index]!.selectedRowsSha256 = wfdSha256(canonicalWfdJson([row]));
    }
    assert.throws(() => assertFinancialLinearCandidate(f.calculation, f.data.evidence, f.data.rows, () => {}), /CAS、人民币元/u);
  } finally { await f.close(); }
});

test('queued financial calculations without the admission version reject before reading inputs or executing a program', async () => {
  let reads = 0;
  const execution = { context: { task: { versions: { polars: 'bd.polars-fixed/1' } } } } as unknown as PolarsExecution;
  await assert.rejects(projectFinancialPolars(execution, {} as FinancialCalculation,
    async () => { reads++; throw new Error('must not read'); }, () => {}), code('POLARS_FINANCIAL_VERSION_CHANGED'));
  assert.equal(reads, 0);
});

test('financial candidate verification and central first send reject incompatible actual value units even with refreshed row digests', async () => {
  const f = await fixture();
  try {
    f.handoff.prepare({ structured: f.structured, localRefs: f.refs(f.structured) });
    const originalRows = structuredClone(f.data.evidence.linearAdmission!.rows);
    const originalUnit = ((originalRows[0]!.values as WfdRecord).value as WfdRecord).unit as WfdRecord;
    const countDefinition = { dimension: 'count' };
    const patches = [
      { unit: { unit_code: 'count', definition: countDefinition, resolved: true,
        digest: 'sha256:' + wfdSha256(canonicalWfdJson({ code: 'count', definition: countDefinition })) } },
      { data_type: 'text' },
      { unit: { ...originalUnit, resolved: false } },
      { unit: { ...originalUnit, digest: 'sha256:' + '0'.repeat(64) } },
    ];
    for (const patch of patches) {
      const proof = f.data.evidence.linearAdmission!;
      proof.rows = structuredClone(originalRows);
      Object.assign((proof.rows[0]!.values as WfdRecord).value as WfdRecord, patch);
      f.data.evidence.inputs[0]!.selectedRowsSha256 = wfdSha256(canonicalWfdJson([proof.rows[0]]));
      f.store();
      assert.throws(() => f.service.verifyCandidate(f.task.id, f.verify), /数值单元/u);
      let sends = 0;
      await assert.rejects(f.handoff.submitAndAssociate(f.structured.requestId, { submit: async () => { sends++; } } as never), /数值单元/u);
      assert.equal(sends, 0);
    }
  } finally { await f.close(); }
});
