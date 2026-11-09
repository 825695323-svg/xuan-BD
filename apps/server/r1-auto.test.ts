import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import type { R1AutoStartInput, R1AutoView } from '../../modules/collection/r1-auto.js';
import { resolveR1Evidence } from '../../modules/collection/r1-evidence.js';
import { sourceReportedCode } from '../../modules/collection/source-reported-table.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { WfdProductMachineError } from '../../adapters/database/wfd-product-machine.js';
import { canonicalWfdJson, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const source: R1AutoStartInput['source'] = { source_id: 'auto-synthetic', provider: 'isolated-fixture',
  requested_url: 'https://fixture.example.test/observations.csv', requested_at_utc: '2026-01-02T00:00:00Z',
  acquired_at_utc: '2026-01-04T00:01:00Z', usage_scope: 'isolated automatic data-only acceptance',
  authorization: { status: 'authorized', basis: 'operator selected newly generated synthetic observations for isolated automatic admission' } };
const csvCell = (value: string) => /[",\r\n]/u.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
function raw(prefix: string, options: { missingUnit?: boolean; extra?: boolean; nature?: string } = {}): Buffer {
  const columns = ['business_key', 'start_utc', 'end_utc', 'value_state', 'reading', ...(options.extra ? ['additional'] : []),
    'bd.semantic_code', 'bd.subject_kind', 'bd.subject_id', 'bd.frequency', 'bd.precision', 'bd.timezone', 'bd.period_type',
    'bd.type.reading', ...(!options.missingUnit ? ['bd.unit.reading'] : []), 'bd.measurement.reading',
    ...(options.extra ? ['bd.type.additional', 'bd.unit.additional', 'bd.measurement.additional'] : [])];
  const rows = [2, 3].map(day => [`${prefix}-${day}`, `2026-01-0${day}T00:00:00Z`, `2026-01-0${day + 1}T00:00:00Z`,
    'valid_value', day === 2 ? '12.30' : '13.40', ...(options.extra ? ['4.50'] : []),
    'generic.source.report', 'physical_object', 'item_1', 'day', 'day', 'UTC', 'natural', 'decimal',
    ...(!options.missingUnit ? ['count'] : []), options.nature ?? 'stock', ...(options.extra ? ['decimal', 'count', 'flow'] : [])]);
  return Buffer.from([columns, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n');
}
async function material(host: FullChainHost, requestId: string, bytes: Buffer): Promise<string> {
  const uploaded = await host.upload(`${requestId}.csv`, 'data', bytes, `${requestId}-upload`);
  const task = await host.settled(uploaded.jobId); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
  return host.services.materials!.getByTask(task.id)!.envelope.materialId;
}
async function autoSettled(host: FullChainHost, requestId: string, expected?: string): Promise<R1AutoView> {
  for (let tries = 0; tries < 2400; tries++) {
    const view = await host.call(`/r1/auto/${requestId}`) as R1AutoView;
    if (expected === 'associated' && view.state === 'recovering') { await delay(25); continue; }
    if (['associated', 'awaiting_answers', 'blocked', 'stopped', 'recovering'].includes(view.state)) {
      if (expected) assert.equal(view.state, expected, JSON.stringify(view)); return view;
    }
    await delay(25);
  }
  throw new Error('Automatic workflow did not settle: ' + JSON.stringify(await host.call(`/r1/auto/${requestId}`)));
}
async function close(host: FullChainHost) { await host.services.r1Auto!.dispose(); await host.close(); }
function compact(view: R1AutoView) {
  return { requestId: view.requestId, state: view.state, questions: view.questions.map(question => question.key),
    definitionReview: view.definitionReview, definitionAction: view.definitionAction, localReturn: view.localReturn,
    wfdRejection: view.wfdRejection, error: view.error, planIds: view.planIds, requestIds: view.requestIds, taskIds: view.taskIds,
    handoffState: view.currentRequest?.state ?? null, documentSha256: view.currentRequest?.documentSha256 ?? null,
    associations: view.currentRequest?.local.associations ?? [],
    materialEvidence: view.evidence.filter(fact => fact.origin === 'file').map(fact => ({ key: fact.key, column: fact.column })) };
}
function proof(host: FullChainHost, name: string, result: unknown) {
  writeFileSync(join(host.fixture.root, 'auto-verification.json'), JSON.stringify({ name, result }, null, 2) + '\n', { flag: 'wx' });
}

test('automatic HTTP intake preserves real machine return, five steps, publication, fixed read, and idempotence', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-auto-happy', machine: true });
  const host = await openFullChainHost(fixture);
  try {
    const bytes = raw('base'), materialId = await material(host, 'auto-base', bytes);
    const input: R1AutoStartInput = { requestId: 'auto-base', materialId, source, datasetId: 'auto_observations' };
    await host.call('/r1/auto/start', input, 202);
    const first = await autoSettled(host, input.requestId, 'associated');
    assert.equal(first.definitionReview?.code, 'FAMILY_DEFINITION_REQUIRED');
    assert.equal(first.definitionReview?.disposition, 'return_to_bd');
    assert.ok(first.definitionReview?.machineRequestId);
    assert.equal(first.localReturn?.code, 'FAMILY_DEFINITION_REQUIRED');
    assert.equal(first.wfdRejection, null);
    assert.equal(first.definitionAction, 'create_from_evidence');
    assert.equal(first.planIds.length, 1); assert.equal(first.requestIds.length, 1);
    assert.deepEqual(host.services.materials!.readOriginal(materialId).bytes, bytes);
    const plan = host.services.processing!.get(first.planIds[0]!);
    assert.deepEqual(plan.steps.map(step => step.kind), ['parse', 'clean', 'structure', 'annotate', 'check']);
    assert.ok(plan.steps.every(step => step.state === 'succeeded' || step.applicability === 'not_applicable'));
    assert.equal(plan.outputs[0]!.publishEligible, true);
    assert.equal(plan.materials[0]!.dimensions.find(dimension => dimension.key === 'purpose')?.value, source.usage_scope);
    const associations = first.currentRequest!.local.associations as WfdRecord[];
    assert.equal(associations.length, 2);
    const fixed = await host.call('/r1/products/read', { snapshotId: associations[0]!.snapshot_id, productId: associations[0]!.product_id });
    assert.equal(fixed.result.rows.length, 2); assert.ok(fixed.result.rows.every((row: WfdRecord) => row.record_ref));
    const tasksBefore = host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n;
    const repeated = await host.call('/r1/auto/start', input, 202);
    assert.deepEqual(repeated.requestIds, first.requestIds); assert.equal(repeated.state, 'associated');
    await host.call(`/r1/auto/${input.requestId}/advance`, {});
    await host.call('/r1/auto');
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n, tasksBefore);
    const changed = await host.call('/r1/auto/start', { ...input, datasetId: 'other' }, 409);
    assert.equal(changed.code, 'R1_AUTO_REQUEST_CONFLICT');
    const addId = await material(host, 'auto-added', raw('added', { extra: true }));
    await host.call('/r1/auto/start', { ...input, requestId: 'auto-added', materialId: addId }, 202);
    const added = await autoSettled(host, 'auto-added', 'associated');
    assert.equal(added.definitionReview?.code, 'FIELD_DEFINITION_REQUIRED');
    assert.deepEqual(added.definitionReview?.missingFields, ['additional']);
    assert.equal(added.definitionAction, 'evolve_additive_definition');
    assert.equal((added.currentRequest!.local.associations as WfdRecord[])[0]!.product_id, associations[0]!.product_id);
    const sameId = await material(host, 'auto-same', raw('same', { extra: true }));
    await host.call('/r1/auto/start', { ...input, requestId: 'auto-same', materialId: sameId }, 202);
    const same = await autoSettled(host, 'auto-same', 'associated');
    assert.equal(same.definitionReview?.code, 'CANDIDATE_FIELDS_PRESENT');
    assert.equal(same.definitionAction, 'reuse_same_definition');
    assert.equal((same.currentRequest!.local.associations as WfdRecord[])[0]!.definition_digest,
      (added.currentRequest!.local.associations as WfdRecord[])[0]!.definition_digest, 'Equivalent fields preserve the actual WFD definition digest and field order');
    const subsetId = await material(host, 'auto-subset', raw('subset'));
    await host.call('/r1/auto/start', { ...input, requestId: 'auto-subset', materialId: subsetId }, 202);
    const subset = await autoSettled(host, 'auto-subset', 'blocked');
    assert.equal(subset.definitionReview?.code, 'CANDIDATE_FIELDS_PRESENT');
    assert.equal(subset.error?.code, 'R1_AUTO_PARTIAL_FIELD_OBSERVATION');
    assert.equal(subset.requestIds.length, 0, 'A partial-field source never deletes old contract fields or submits a downgraded definition');
    const revisionId = await material(host, 'auto-revision', raw('revision', { extra: true, nature: 'flow' }));
    await host.call('/r1/auto/start', { ...input, requestId: 'auto-revision', materialId: revisionId }, 202);
    const question = await autoSettled(host, 'auto-revision', 'awaiting_answers');
    assert.equal(question.questions.length, 1); assert.match(question.questions[0]!.key, /^contractRevisionBasis:/u);
    const invalidBasis = await host.call('/r1/auto/auto-revision/answers', { answers: { [question.questions[0]!.key]: 'yes' } }, 409);
    assert.equal(invalidBasis.code, 'R1_AUTO_REVISION_EVIDENCE');
    await host.call('/r1/auto/auto-revision/answers', { answers: { [question.questions[0]!.key]: 'The selected source explicitly revises reading to period flow while retaining the published prior contract.' } }, 202);
    const revised = await autoSettled(host, 'auto-revision', 'associated');
    assert.equal(revised.definitionAction, 'evolve_explicit_revision');
    assert.equal(revised.currentRequest!.outputKey, first.currentRequest!.outputKey, 'A new semantic code is never invented to evade a conflict');
    proof(host, 'automatic publication, additive evolution, exact reuse, partial-field stop, explicit semantic revision',
      { first: compact(first), added: compact(added), same: compact(same), subset: compact(subset), revised: compact(revised), repeatedStartAddedTasks: 0 });
  } finally { await close(host); }
});

test('one actual semantic gap survives restart; invalid answers are never frozen', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-auto-answer', machine: true });
  let host = await openFullChainHost(fixture);
  try {
    const materialId = await material(host, 'auto-gap', raw('gap', { missingUnit: true }));
    const input: R1AutoStartInput = { requestId: 'auto-gap', materialId, source, datasetId: 'auto_observations' };
    await host.call('/r1/auto/start', input, 202);
    const gap = await autoSettled(host, 'auto-gap', 'awaiting_answers');
    assert.deepEqual(gap.questions.map(question => question.key), ['unit.reading']);
    assert.equal(gap.requestIds.length, 0); assert.equal(gap.taskIds.length, 0);
    const wrong = await host.call('/r1/auto/auto-gap/answers', { answers: { 'unit.reading': 'bad unit' } }, 409);
    assert.equal(wrong.code, 'R1_AUTO_ANSWERS');
    await close(host); host = await openFullChainHost(fixture);
    const restarted = await host.call('/r1/auto/auto-gap') as R1AutoView;
    assert.deepEqual(restarted.questions, gap.questions);
    await host.call('/r1/auto/auto-gap/answers', { answers: { 'unit.reading': 'count' } }, 202);
    const result = await autoSettled(host, 'auto-gap', 'associated');
    assert.equal(result.evidence.find(fact => fact.key === 'unit.reading')?.origin, 'operator');
    assert.equal(result.requestIds.length, 1);
    await host.call('/r1/auto/auto-gap/answers', { answers: { 'unit.reading': 'count' } }, 202);
    assert.equal((await host.call('/r1/auto/auto-gap')).requestIds.length, 1);
    proof(host, 'single semantic gap and restart', { beforeRestart: compact(gap), afterAnswer: compact(result), invalidAnswerCode: wrong.code });
  } finally { await close(host); }
});

test('real explicit WFD definition rejection is retained when a new evidence-bound child plan succeeds', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-auto-prior', machine: true });
  const host = await openFullChainHost(fixture);
  try {
    const bytes = raw('prior'), materialId = await material(host, 'auto-prior', bytes);
    const proposal = resolveR1Evidence({ material: host.services.materials!.get(materialId), original: bytes,
      answers: {}, namespace: 'full.chain.test', datasetId: 'auto_observations', parentSnapshotId: null }).proposal!;
    assert.ok(proposal);
    const target = structuredClone(proposal.target);
    (target.definition.semantic_context as WfdRecord).measurement_nature = 'flow';
    const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: proposal.dimensions[key],
      evidence: [{ source: 'operator', field: `synthetic.${key}`, quote: proposal.dimensions[key] }] }]));
    const prepared = await host.call('/processing/plans', { requestId: 'rejected-plan', input: {
      routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] }, outputs: [{ outputId: 'observations',
        materialIds: [materialId], dimensions, intendedAction: 'publish', tables: [{ materialId, format: proposal.format, types: proposal.types }],
        target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target, mapping: proposal.mapping, source }, expectedSnapshotId: null } }],
    } }, 202);
    const planned = await host.settled(prepared.jobId); assert.equal(planned.status, 'succeeded', JSON.stringify(planned.error));
    const planId = host.services.processing!.getByTask(planned.id)!.plan!.planId;
    const run = await host.call(`/processing/plans/${planId}/run`, { requestId: 'rejected-run' }, 202);
    const ran = await host.settled(run.jobId); assert.equal(ran.status, 'succeeded', JSON.stringify(ran.error));
    const original = await host.call('/r1/prepare', { requestId: 'original-rejected', planId, outputId: 'observations', source,
      target, mapping: proposal.mapping }, 201);
    const submitted = await host.call('/r1/requests/original-rejected/submit', { confirmationDigest: original.documentSha256 }, 202);
    await host.settled(submitted.jobId);
    const rejected = await host.call('/r1/requests/original-rejected');
    assert.equal(rejected.state, 'rejected', JSON.stringify(rejected));
    assert.ok(rejected.error.errors.some((error: WfdRecord) => error.code === 'SEMANTIC_MEASUREMENT_NATURE_MISMATCH'));
    const frozenRejection = canonicalWfdJson(host.services.r1!.attempt('original-rejected'));
    assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, null);
    await host.call('/r1/auto/start', { requestId: 'auto-repair', materialId, source, datasetId: 'auto_observations', priorRequestId: 'original-rejected' }, 202);
    const repaired = await autoSettled(host, 'auto-repair', 'associated');
    assert.equal(repaired.requestIds.length, 2);
    assert.equal(host.services.processing!.get(repaired.planIds[0]!).parentPlanId, planId);
    assert.ok(repaired.wfdRejection);
    assert.equal(canonicalWfdJson(host.services.r1!.attempt('original-rejected')), frozenRejection);
    assert.notEqual(repaired.currentRequest!.requestId, 'original-rejected');
    assert.equal((repaired.currentRequest!.local.associations as WfdRecord[]).length, 2);
    const alias = await host.call('/r1/auto/start', { requestId: 'duplicate-auto-repair', materialId, source,
      datasetId: 'auto_observations', priorRequestId: 'original-rejected' }, 409);
    assert.equal(alias.code, 'R1_AUTO_PRIOR_ALREADY_CLAIMED');
    proof(host, 'real explicit definition rejection followed by evidence-bound repair',
      { originalRequestId: 'original-rejected', originalState: rejected.state, originalErrors: rejected.error,
        originalPlanId: planId, childParentPlanId: host.services.processing!.get(repaired.planIds[0]!).parentPlanId,
        originalRejectionUnchanged: true, repaired: compact(repaired) });
  } finally { await close(host); }
});

test('lost actual publication reply only recovers original identity and never submits twice', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-auto-unknown', machine: true });
  const host = await openFullChainHost(fixture);
  try {
    const materialId = await material(host, 'auto-unknown', raw('unknown'));
    const client = host.services.r1Runtime!.client, originalSubmit = client.submit.bind(client); let sends = 0;
    client.submit = async (document, signal) => { sends++; await originalSubmit(document, signal);
      throw new WfdProductMachineError('WFD_PROCESS_TIMEOUT', 'synthetic loss after actual publication', {
        operation: 'submit', requestId: String((document.request_identity as WfdRecord).request_id), mayHaveBeenAccepted: true }); };
    const input = { requestId: 'auto-unknown', materialId, source, datasetId: 'auto_observations' };
    await host.call('/r1/auto/start', input, 202);
    let result = await autoSettled(host, 'auto-unknown');
    if (result.state === 'recovering') result = await host.call('/r1/auto/auto-unknown/advance', {});
    assert.equal(result.state, 'associated', JSON.stringify(result)); assert.equal(sends, 1);
    assert.equal(result.requestIds.length, 1);
    await host.call('/r1/auto/start', input, 202); await host.call('/r1/auto/auto-unknown/advance', {});
    assert.equal(sends, 1); assert.equal((result.currentRequest!.local.associations as WfdRecord[]).length, 2);
    proof(host, 'lost actual publication reply recovers original identity', { actualSubmits: sends, result: compact(result) });
  } finally { await close(host); }
});

test('pending original identity survives a failed lookup and host restart without another submission', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-auto-restart-unknown', machine: true });
  let host = await openFullChainHost(fixture);
  try {
    const materialId = await material(host, 'auto-restart-unknown', raw('restart-unknown'));
    const client = host.services.r1Runtime!.client, submit = client.submit.bind(client); let sends = 0;
    client.submit = async (document, signal) => { sends++; await submit(document, signal);
      throw new WfdProductMachineError('WFD_PROCESS_TIMEOUT', 'synthetic loss after actual publication', {
        operation: 'submit', requestId: 'restart-unknown', mayHaveBeenAccepted: true }); };
    client.requestStatusPage = async () => { throw new WfdProductMachineError('WFD_LOOKUP_FAILED', 'synthetic temporary lookup failure', {
      operation: 'request_status_page', requestId: 'restart-lookup', mayHaveBeenAccepted: false }); };
    const input = { requestId: 'auto-restart-unknown', materialId, source, datasetId: 'auto_observations' };
    await host.call('/r1/auto/start', input, 202);
    await autoSettled(host, input.requestId, 'recovering');
    const pending = await host.call(`/r1/auto/${input.requestId}/advance`, {});
    assert.equal(pending.state, 'recovering'); assert.equal(pending.error.code, 'WFD_LOOKUP_FAILED'); assert.equal(sends, 1);
    const illegal = await host.call('/r1/auto/start', { ...input, requestId: 'unknown-must-not-be-retried',
      priorRequestId: pending.currentRequest.requestId }, 409);
    assert.equal(illegal.code, 'R1_AUTO_PRIOR_NOT_REJECTED');
    const originalRequestId = pending.currentRequest.requestId;
    await close(host); host = await openFullChainHost(fixture);
    const recovered = await autoSettled(host, input.requestId, 'associated');
    assert.deepEqual(recovered.requestIds, [originalRequestId]);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get()!.n, 1);
    assert.equal((recovered.currentRequest!.local.associations as WfdRecord[]).length, 2);
    proof(host, 'lookup failure and host restart preserve original identity', { beforeRestart: compact(pending), afterRestart: compact(recovered),
      actualSubmitsBeforeRestart: sends, handoffRequestsAfterRestart: 1, unknownPriorRejectedCode: illegal.code });
  } finally { await close(host); }
});

test('XLSX declarations retain material cell provenance instead of operator attribution', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-auto-workbook', machine: true });
  const host = await openFullChainHost(fixture);
  try {
    const csv = raw('workbook').toString('utf8'), headers = csv.split('\n')[0]!.split(',');
    const workbookScript = String.raw`import csv, io, sys, zipfile
from xml.sax.saxutils import escape
rows = list(csv.reader(io.StringIO(sys.stdin.read())))
body = ''.join('<row r="%s">' % (r + 1) + ''.join('<c r="%s%s" t="inlineStr"><is><t>%s</t></is></c>' % (chr(65 + c), r + 1, escape(v)) for c, v in enumerate(row)) + '</row>' for r, row in enumerate(rows))
output = io.BytesIO()
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as z:
    z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Source" sheetId="1" r:id="rId1"/></sheets></workbook>')
    z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
    z.writestr('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + '</sheetData></worksheet>')
sys.stdout.buffer.write(output.getvalue())`;
    const generated = spawnSync(process.env.WFD_PYTHON!, ['-I', '-B', '-c', workbookScript], { input: csv, timeout: 30_000 });
    assert.equal(generated.status, 0, generated.stderr.toString());
    const uploaded = await host.upload('auto-workbook.xlsx', 'data', generated.stdout, 'workbook-upload');
    const uploadedTask = await host.settled(uploaded.jobId); assert.equal(uploadedTask.status, 'succeeded');
    const materialId = host.services.materials!.getByTask(uploadedTask.id)!.envelope.materialId;
    const xlsxSelection = { sheetName: 'Source', headerRow: 1, firstDataRow: 2, lastDataRow: 3, firstColumn: 'A',
      lastColumn: String.fromCharCode(64 + headers.length), columns: headers.map((header, i) => ({ column: String.fromCharCode(65 + i), header, name: header })) };
    await host.call('/r1/auto/start', { requestId: 'auto-workbook', materialId, source, datasetId: 'auto_observations', xlsxSelection }, 202);
    const result = await autoSettled(host, 'auto-workbook', 'associated');
    const plan = host.services.processing!.get(result.planIds[0]!);
    for (const dimension of plan.materials[0]!.dimensions.filter(dimension => dimension.key !== 'purpose')) {
      assert.ok(dimension.evidence.length);
      assert.ok(dimension.evidence.every(evidence => evidence.source === 'material' && evidence.table?.sheetName === 'Source'));
    }
    const parse = plan.steps.find(step => step.kind === 'parse')!;
    const parsed = JSON.parse(host.services.processing!.artifact(plan.planId, parse.stepId).bytes.toString('utf8'));
    assert.equal(plan.materials[0]!.dimensions[0]!.evidence[0]!.table?.projectionSha256, parsed.source_projection.json_sha256);
    const forged = await host.call('/processing/route', { requestId: 'forged-xlsx-claim', input: { materialId, dimensions: {
      role: { status: 'known', value: 'source_report', evidence: [{ source: 'material-table', materialId, quote: 'not in the actual sheet',
        column: 'bd.semantic_code', scope: 'column_constant', xlsxSelection }] },
    } } }, 409);
    assert.equal(forged.code, 'PROCESSING_EVIDENCE_MISMATCH');
    proof(host, 'actual generated XLSX retains verified material provenance', { result: compact(result),
      dimensionEvidence: plan.materials[0]!.dimensions.map(dimension => ({ key: dimension.key, evidence: dimension.evidence })), forgedClaimCode: forged.code });
  } finally { await close(host); }
});

test('permission and unit dependency failures do not become semantic questions or a second submission', { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: 'r1-auto-denied', machine: true });
  const configuration = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
  configuration.caller.roles = ['read', 'submit', 'publish'];
  writeFileSync(fixture.configPath, JSON.stringify(configuration));
  const host = await openFullChainHost(fixture);
  try {
    const materialId = await material(host, 'auto-denied', raw('denied'));
    const client = host.services.r1Runtime!.client, originalSubmit = client.submit.bind(client); let sends = 0;
    client.submit = async (document, signal) => { sends++; return originalSubmit(document, signal); };
    await host.call('/r1/auto/start', { requestId: 'auto-denied', materialId, source, datasetId: 'auto_observations' }, 202);
    const result = await autoSettled(host, 'auto-denied', 'blocked');
    assert.equal(result.questions.length, 0); assert.equal(sends, 1); assert.equal(result.error!.code, 'R1_WFD_REJECTED');
    assert.ok((result.wfdRejection?.errors as WfdRecord[]).some(error => error.code === 'REGISTRATION_PERMISSION_DENIED'));
    await host.call('/r1/auto/auto-denied/advance', {}); assert.equal(sends, 1);
    assert.equal((await host.call('/r1/products/snapshot', {})).snapshotId, null);
    await host.call('/r1/auto/start', { requestId: 'no-permission-repair', materialId, source, datasetId: 'auto_observations',
      priorRequestId: result.currentRequest!.requestId }, 202);
    const cannotRepair = await autoSettled(host, 'no-permission-repair', 'blocked');
    assert.equal(cannotRepair.error?.code, 'R1_AUTO_REJECTION_NOT_DEFINITION'); assert.equal(sends, 1);
    const unitId = await material(host, 'unit-dependency', Buffer.from(raw('unit-dependency').toString().replaceAll(',count,', ',unregistered_count,')));
    await host.call('/r1/auto/start', { requestId: 'unit-dependency', materialId: unitId, source, datasetId: 'auto_observations' }, 202);
    const noUnit = await autoSettled(host, 'unit-dependency', 'blocked');
    assert.equal(noUnit.error?.code, 'R1_AUTO_UNIT_UNREGISTERED'); assert.equal(noUnit.questions.length, 0); assert.equal(sends, 1);
    const denied = await host.call('/r1/auto/start', { requestId: 'no-source-authority', materialId,
      source: { ...source, authorization: { status: 'denied', basis: 'synthetic explicit denied source use' } }, datasetId: 'auto_observations' }, 409);
    assert.equal(denied.code, 'R1_SOURCE_DENIED');
    proof(host, 'real registration permission rejection and unit dependency', { denied: compact(result), cannotRepair: compact(cannotRepair),
      unitDependency: compact(noUnit), actualSubmits: sends, unauthorizedSourceCode: denied.code });
  } finally { await close(host); }
});

for (const legacy of [false, true]) test(`source semantic contracts preserve ${legacy ? 'legacy' : 'new'} scope through reuse, additive fields and restart`, { skip: !enabled }, async () => {
  const fixture = createFullChainFixture({ name: legacy ? 'source-semantic-legacy' : 'source-semantic-new', machine:true,
    units:{date:{dimension:'date'},percent:{dimension:'ratio'},count:{dimension:'quantity'},cny:{dimension:'money'},cny_per_share:{dimension:'money_per_share'}} });
  let host = await openFullChainHost(fixture);
  const reportSource = {...source, requested_url:'file:///explicit-source/source-price-reports/2026/table.csv',acquired_at_utc:'2026-01-06T00:00:00Z'};
  const csv = (day:number,extra = false) => Buffer.from([['交易日期','对象代码','收盘价（元）','涨跌额（元）','涨跌幅（%）',...(extra ? ['新观察次数'] : [])],
    [`2026010${day}`,'A01','13.9700','0.1200','0.87',...(extra ? ['2'] : [])]].map(row=>row.map(csvCell).join(',')).join('\n')+'\n');
  const datasetId='source_semantic_reports';
  async function admit(id:string,day:number,extra=false) {
    const materialId=await material(host,id,csv(day,extra));
    await host.call('/r1/auto/start',{requestId:id,materialId,source:reportSource,datasetId},202);
    const waiting=await autoSettled(host,id,'awaiting_answers');
    assert.deepEqual(waiting.questions.map(question=>question.key),['source_trade_date_timezone']);
    await host.call(`/r1/auto/${id}/answers`,{answers:{source_trade_date_timezone:'Asia/Shanghai'}},202);
    return await autoSettled(host,id,'associated');
  }
  async function catalog(snapshotId:string) {
    return (await host.services.r1Runtime!.client.contractDiscovery(snapshotId)).result.products as WfdRecord[];
  }
  try {
    if (legacy) {
      const bytes=csv(2),materialId=await material(host,'legacy-source-seed',bytes);
      const proposal=resolveR1Evidence({material:host.services.materials!.get(materialId),original:bytes,
        answers:{source_trade_date_timezone:'Asia/Shanghai'},source:reportSource,namespace:'full.chain.test',datasetId,parentSnapshotId:null}).proposal!;
      const target=structuredClone(proposal.target),context=target.definition.semantic_context as WfdRecord;
      delete target.definition.field_semantic_context;
      delete context.content; delete context.measurement; delete context.coverage_quality;
      (context.time as WfdRecord).roles={business_date:'source_reported_trade_date_label'};
      const dimensions=Object.fromEntries(DIMENSION_KEYS.map(key=>[key,{status:'known',value:proposal.dimensions[key],
        evidence:[{source:'operator',field:`synthetic.${key}`,quote:proposal.dimensions[key]}]}]));
      const prepared=await host.call('/processing/plans',{requestId:'legacy-source-plan',input:{
        routing:{materials:[{materialId,dimensions,intendedAction:'publish'}]},outputs:[{outputId:'observations',materialIds:[materialId],
          dimensions,intendedAction:'publish',tables:[{materialId,format:proposal.format,types:proposal.types,sourceProjection:proposal.sourceProjection}],
          target:{declaration:{protocol:'wfd.structured-ingest/1.0',target,mapping:proposal.mapping,source:reportSource},expectedSnapshotId:null}}]}},202);
      const planned=await host.settled(prepared.jobId); assert.equal(planned.status,'succeeded',JSON.stringify(planned.error));
      const planId=host.services.processing!.getByTask(planned.id)!.plan!.planId;
      const run=await host.call(`/processing/plans/${planId}/run`,{requestId:'legacy-source-run'},202);
      const ran=await host.settled(run.jobId); assert.equal(ran.status,'succeeded',JSON.stringify(ran.error));
      const handoff=await host.call('/r1/prepare',{requestId:'legacy-source-handoff',planId,outputId:'observations',source:reportSource,target,mapping:proposal.mapping},201);
      const submit=await host.call('/r1/requests/legacy-source-handoff/submit',{confirmationDigest:handoff.documentSha256},202);
      await host.settled(submit.jobId);
      assert.equal((await host.call('/r1/requests/legacy-source-handoff')).state,'associated');
    }
    const first=await admit('source-semantic-first',3);
    assert.equal(first.definitionAction,legacy ? 'reuse_same_definition' : 'create_from_evidence');
    const ref=(first.currentRequest!.local.associations as WfdRecord[])[0]!;
    const fixedSnapshot=String(ref.snapshot_id),firstCatalog=await catalog(fixedSnapshot);
    const fixed=firstCatalog.find(product=>product.product_id===ref.product_id)!;
    assert.ok(fixed);
    const definition=fixed.declaration as WfdRecord,contexts=definition.field_semantic_context as WfdRecord | undefined;
    assert.equal((definition.semantic_context as WfdRecord).content_nature,'source_claim');
    if (legacy) assert.equal(contexts,undefined);
    else assert.equal(((contexts![sourceReportedCode('src_','涨跌额（元）')!] as WfdRecord).content as WfdRecord).assertion_status,'source_reported_price_change_label');
    const repeated=await admit('source-semantic-repeated',4);
    assert.equal(repeated.definitionAction,'reuse_same_definition');
    assert.equal((repeated.currentRequest!.local.associations as WfdRecord[])[0]!.definition_digest,ref.definition_digest);
    const added=await admit('source-semantic-added',5,true);
    assert.equal(added.definitionAction,'evolve_additive_definition');
    assert.equal(added.definitionReview!.code,'FIELD_DEFINITION_REQUIRED');
    const addedRef=(added.currentRequest!.local.associations as WfdRecord[])[0]!;
    assert.equal(addedRef.product_id,ref.product_id);
    const newer=(await catalog(String(addedRef.snapshot_id))).find(product=>product.product_id===ref.product_id && product.definition_sequence!==fixed.definition_sequence)!;
    assert.ok(newer);
    const nextDefinition=newer.declaration as WfdRecord;
    assert.deepEqual(nextDefinition.semantic_context,definition.semantic_context);
    assert.deepEqual(Object.keys(nextDefinition.field_semantic_context as WfdRecord).sort(),legacy
      ? [sourceReportedCode('src_','新观察次数')!]
      : [...Object.keys(contexts!),sourceReportedCode('src_','新观察次数')!].sort());
    const oldBytes=canonicalWfdJson(firstCatalog);
    const evidence=canonicalWfdJson(added.evidence),requestIds=added.requestIds;
    await close(host); host=await openFullChainHost(fixture);
    const reopened=await host.call('/r1/auto/source-semantic-added') as R1AutoView;
    assert.equal(reopened.state,'associated'); assert.deepEqual(reopened.requestIds,requestIds);
    assert.equal(canonicalWfdJson(reopened.evidence),evidence);
    assert.equal(canonicalWfdJson(await catalog(fixedSnapshot)),oldBytes,'新规则及新增字段不重解释旧快照');
    const read=await host.call('/r1/products/read',{snapshotId:fixedSnapshot,productId:ref.product_id});
    assert.ok(read.result.rows.some((row:WfdRecord)=>((row.values as WfdRecord)[sourceReportedCode('src_','收盘价（元）')!] as WfdRecord).value==='13.97'));
    proof(host,'source qualifications, immutable prior scope, additive field and persisted restart',
      {legacy,first:compact(first),repeated:compact(repeated),added:compact(added),reopened:compact(reopened),fixedSnapshot,oldCatalogUnchanged:true});
  } finally { await close(host); }
});
