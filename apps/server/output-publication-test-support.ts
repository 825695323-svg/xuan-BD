import assert from 'node:assert/strict';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { buildStructuredIngestDocument } from '../../modules/collection/r1-structured-handoff.js';
import type { FullChainHost } from './full-chain-test-support.js';
const namespace = 'full.chain.test';
const subject = { kind: 'entity', namespace, id: 'synthetic_financial_subject' };
const second = (at: string) => ({ status: 'known', precision: 'second', earliest_utc: at,
  latest_exclusive_utc: new Date(Date.parse(at) + 1000).toISOString().replace('.000Z', 'Z'), source_timezone: 'UTC' });
export const values = { subject_scheme: 'synthetic', subject_code: 'company', accounting_standard: 'CAS', currency: 'CNY', scope: 'consolidated',
  unit: 'cny', concept: '其中：营业收入', report_id: 'synthetic-report', report_version: 'v1', dimension: 'group', period_type: 'duration',
  start_date: '2024-01-01', end_date: '2024-03-31', value: '9007199254740993.1200',
  report_nature: 'formal', fiscal_calendar: 'declared-calendar-year', comparability_basis: 'synthetic-same-accounting-basis' };
const definition = { semantic_code: 'synthetic.financial.compatible', measurement_nature: 'mixed_observation', unit_code: 'per_field',
  definition_authority: namespace, time_role: 'observation',
  semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'source_claim',
    time: { period_type: 'natural', frequency: 'year', interval: 'half_open', timezone: 'UTC' } },
  field_definitions: Object.keys(values).map(field_code => ({ field_code, data_type: field_code === 'value' ? 'decimal' : 'text',
    unit_code: field_code === 'value' ? 'cny' : 'text', measurement_nature: 'flow', time_role: 'observation' })) };
export function row(key: string, changes: Partial<typeof values> = {}, at = '2025-01-02T00:00:00Z') {
  return { business_key: key, subject, public_time: second(at), observation_time: { status: 'known', precision: 'day',
    earliest_utc: '2024-01-01T00:00:00Z', latest_exclusive_utc: '2025-01-01T00:00:00Z', source_timezone: 'UTC' },
  values: Object.fromEntries(Object.entries({ ...values, ...changes }).map(([key, value]) => [key,
    { data_type: key === 'value' ? 'decimal' : 'text', value_state: 'valid_value', value }])) };
}
export function doc(requestId: string, rows: WfdRecord[], parent: string | null = null, revision?: { previous: WfdRecord; definitionRef: WfdRecord }, semanticCode = definition.semantic_code) {
  return buildStructuredIngestDocument({ requestId, datasetId: 'synthetic_financial', namespace, producerNamespace: namespace,
    submissionDigest: 'sha256:' + wfdSha256(canonicalWfdJson({ requestId, rows, parent })), expectedParentSnapshotId: parent,
    outputKey: 'financial', subject, definition: { ...definition, semantic_code: semanticCode },
    inputMode: revision ? 'source_correction' : 'partial_observation',
    ...(revision ? { definitionMode: 'reuse', definitionRef: revision.definitionRef,
      revisions: { q1: { previous: revision.previous, reason: 'Explicit synthetic corrected report' } } } : {}),
    coverage: { scope: { synthetic: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
    payload: { kind: 'tabular_rows', rows } });
}
export async function publish(host: FullChainHost, document: WfdRecord) {
  const result = (await host.services.r1Runtime!.client.submit(document)).result;
  assert.equal(result.state, 'published_formal', JSON.stringify(result));
  return { snapshotId: String(result.snapshot_id), output: (result.output_results as WfdRecord[])[0]! };
}

export async function prepareOutputFixture(host: FullChainHost, bdSource = false) {
    const initial = await (bdSource ? publishSourceThroughBd(host) : publish(host, doc('input', [row('q1')])));
    const sourceProduct = String(initial.output.product_id);
    const fixed = await host.call('/r1/products/read', { snapshotId: initial.snapshotId, productId: sourceProduct });
    const sourceRef = fixed.result.rows[0].record_ref;
    const bytes = Buffer.from('instruction\nexplicit synthetic financial selection\n');
    const upload = await host.upload('selection.csv', 'data', bytes, 'selected-material');
    assert.equal((await host.settled(upload.jobId)).status, 'succeeded');
    const materialId = host.services.materials!.getByTask(upload.jobId)!.envelope.materialId;
    const source = { source_id: 'synthetic-selection', provider: 'isolated synthetic fixture',
      requested_url: 'file:///explicit-synthetic-selection', requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-01T00:00:01Z',
      usage_scope: 'isolated standardization provenance test, not supplier evidence',
      authorization: { status: 'authorized', basis: 'explicit isolated fixture' } };
    const target = { datasetId: 'standardized_fixture', outputKey: 'standardized', expectedParentSnapshotId: initial.snapshotId,
      subject, definition: { ...definition, semantic_code: 'synthetic.standardized', field_definitions: definition.field_definitions.filter(f => ['value', 'concept'].includes(f.field_code)) },
      inputMode: 'partial_observation', coverage: { scope: { selected: 'q1' }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' } };
    const mapping = { kind: 'tabular_rows', businessKey: 'business_key', earliestUtc: 'start_utc', latestExclusiveUtc: 'end_utc',
      precision: 'day', sourceTimezone: 'UTC', fields: [{ fieldCode: 'value', value: 'value', state: 'value_state' },
        { fieldCode: 'concept', value: 'concept', state: 'metadata_state' }] };
    const dimensions = Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: key === 'informationNature' ? 'source_claim' : key === 'role' ? 'financial-record' : 'explicit synthetic selected financial source claim',
      evidence: [{ source: 'operator', field: key, quote: 'explicit synthetic selected financial source claim' }] }]));
    const creation = await host.call('/processing/plans', { requestId: 'standardized-plan', input: {
      routing: { materials: [{ materialId, dimensions, intendedAction: 'publish' }] },
      outputs: [{ outputId: 'financial', materialIds: [materialId], intendedAction: 'publish', stages: ['parse', 'structure', 'annotate', 'check'],
        tables: [{ materialId, format: 'financial-fixed', types: { value: 'decimal_string' }, annotations: { metadata_state: 'valid_value' },
          financialCalculation: { version: 'bd-financial-fixed/1', operation: 'standardize',
            inputs: [{ snapshotId: initial.snapshotId, productId: sourceProduct, businessKeys: ['q1'] }] } }],
        target: { declaration: { protocol: 'wfd.structured-ingest/1.0', source, target, mapping }, expectedSnapshotId: initial.snapshotId } }] } }, 202);
    const task = await host.settled(creation.jobId); assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
    const planId = host.services.processing!.getByTask(task.id)!.plan!.planId;
    for (const step of host.services.processing!.get(planId).steps) {
      const run = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: 'execute-' + step.stepId }, 202);
      const done = await host.settled(run.jobId); assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    }
    const candidate = host.services.processing!.get(planId).outputs[0]!;
    assert.equal(candidate.publishEligible, true, JSON.stringify(candidate));
    const requestId = 'selected-publication';
    const prepared = await host.call('/r1/prepare', { requestId, planId, outputId: 'financial', source, target, mapping }, 201);
    const path = `/r1/requests/${requestId}/output-dependencies`;
    const input = { planId, outputId: 'financial', recordRefs: [sourceRef] };
    return { initial,sourceProduct,sourceRef,planId,requestId,path,input,prepared };
}
/** Synthetic declared source, genuinely uploaded/processed/published by BD; no seeded associations. */
async function publishSourceThroughBd(host: FullChainHost) {
  const names = Object.keys(values), bytes = Buffer.from(['key,start,end,state,'+names.join(','),
    'q1,2024-01-01T00:00:00Z,2025-01-01T00:00:00Z,valid_value,'+Object.values(values).join(',')].join('\n')+'\n');
  const uploaded = await host.upload('synthetic-financial-source.csv','data',bytes,'source-upload');
  assert.equal((await host.settled(uploaded.jobId)).status,'succeeded');
  const materialId = host.services.materials!.getByTask(uploaded.jobId)!.envelope.materialId;
  const source = {source_id:'synthetic-source',provider:'explicit synthetic fixture',requested_url:'file:///synthetic-financial-source',
    requested_at_utc:'2026-01-01T00:00:00Z',acquired_at_utc:'2026-01-01T00:00:01Z',usage_scope:'isolated source dependency test',
    authorization:{status:'authorized',basis:'explicit isolated fixture'}};
  const target = {datasetId:'synthetic_financial',outputKey:'financial',expectedParentSnapshotId:null,subject,definition,inputMode:'partial_observation',
    coverage:{scope:{synthetic:true},basis:'observed_partial',completeness:'partial',absence_means:'unknown'}};
  const mapping = {kind:'tabular_rows',businessKey:'key',earliestUtc:'start',latestExclusiveUtc:'end',precision:'day',sourceTimezone:'UTC',
    fields:names.map(fieldCode=>({fieldCode,value:fieldCode,state:'state'}))};
  const dimensions=Object.fromEntries(DIMENSION_KEYS.map(key=>[key,{status:'known',value:key==='informationNature'?'source_claim':key==='role'?'financial-record':'explicit synthetic financial source',evidence:[{source:'operator',field:key,quote:'explicit synthetic financial source'}]}]));
  const accepted=await host.call('/processing/plans',{requestId:'source-plan',input:{routing:{materials:[{materialId,dimensions,intendedAction:'publish'}]},outputs:[{outputId:'source',materialIds:[materialId],intendedAction:'publish',stages:['parse','structure','check'],tables:[{materialId,format:'csv',types:{value:'decimal_string'}}],target:{declaration:{protocol:'wfd.structured-ingest/1.0',source,target,mapping},expectedSnapshotId:null}}]}},202);
  const planned=await host.settled(accepted.jobId);assert.equal(planned.status,'succeeded',JSON.stringify(planned.error));
  const sourcePlanId=host.services.processing!.getByTask(planned.id)!.plan!.planId;
  for(const step of host.services.processing!.get(sourcePlanId).steps){const run=await host.call(`/processing/plans/${sourcePlanId}/steps/${step.stepId}/execute`,{requestId:'source-'+step.stepId},202);const done=await host.settled(run.jobId);assert.equal(done.status,'succeeded',JSON.stringify(done.error));}
  const prepared=await host.call('/r1/prepare',{requestId:'source-publish',planId:sourcePlanId,outputId:'source',source,target,mapping},201);
  const sent=await host.call('/r1/requests/source-publish/submit',{confirmationDigest:prepared.documentSha256},202);const done=await host.settled(sent.jobId);assert.equal(done.status,'succeeded',JSON.stringify(done.error));
  const published=await host.call('/r1/requests/source-publish');assert.equal(published.state,'associated');
  const a=published.local.associations[0];return {snapshotId:String(a.snapshot_id),output:{product_id:a.product_id,definition_ref:{digest:a.definition_digest}} as WfdRecord,sourcePlanId};
}
export async function publishedCaseFixture(host: FullChainHost) {
  const fixture=await prepareOutputFixture(host,true);
  const submitted=await host.call(`/r1/requests/${fixture.requestId}/submit`,{confirmationDigest:fixture.prepared.documentSha256},202);
  const task=await host.settled(submitted.jobId);assert.equal(task.status,'succeeded',JSON.stringify(task.error));
  assert.ok('sourcePlanId' in fixture.initial);
  const cap=await host.call('/corrections/capabilities'),caseId='source-dependency-case';
  await host.call('/corrections/cases',{requestId:'source-case-register',input:{caseId,kind:'processing_repair',errorType:'mapping_error',discoveredAt:'2026-11-19T00:00:00Z',evidence:'Explicit synthetic source mapping review. Not supplier evidence.',binding:{planOutput:{planId:fixture.initial.sourcePlanId,outputId:'source'}},connectionSha256:cap.connectionSha256}},201);
  const impact=await host.call(`/corrections/cases/${caseId}/impact`,{requestId:'source-case-impact'});assert.equal(impact.state,'impact_frozen');assert.equal(impact.itemCount,1);
  assert.deepEqual({snapshot_id:impact.items[0].snapshotId,product_id:impact.items[0].productId,logical_key:impact.items[0].businessKey,revision_id:impact.items[0].recordVersion},fixture.sourceRef);
  return {...fixture,caseId};
}
