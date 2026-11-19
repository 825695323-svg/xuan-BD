import type { R1PrepareInput } from '../../contracts/r1-contracts.js';
import { DIMENSION_KEYS } from '../../modules/collection/processing-routing.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { R1AutoView } from '../../modules/collection/r1-auto.js';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const enabled=!!process.env.WFD_PYTHON&&!!process.env.XUAN_FULL_CHAIN_ROOT;
const source={source_id:'dedup-synthetic',provider:'isolated-fixture',requested_url:'https://fixture.example.test/observations.csv',
  requested_at_utc:'2026-01-02T00:00:00Z',acquired_at_utc:'2026-01-20T00:01:00Z',usage_scope:'isolated duplicate admission verification',
  authorization:{status:'authorized',basis:'operator selected newly generated synthetic observations for isolated duplicate admission'}};
function raw(rows:[number,string][]):Buffer {
  const columns=['business_key','start_utc','end_utc','value_state','reading','bd.semantic_code','bd.subject_kind','bd.subject_id','bd.frequency','bd.precision','bd.timezone','bd.period_type','bd.type.reading','bd.unit.reading','bd.measurement.reading'];
  return Buffer.from([columns,...rows.map(([day,value])=>['dedup-'+day,`2026-01-${String(day).padStart(2,'0')}T00:00:00Z`,`2026-01-${String(day+1).padStart(2,'0')}T00:00:00Z`,'valid_value',value,'generic.source.report','physical_object','item_1','day','day','UTC','natural','decimal','count','stock'])].map(row=>row.join(',')).join('\n')+'\n');
}
async function settled(host:FullChainHost,id:string):Promise<R1AutoView>{
  for(let tries=0;tries<1000;tries++){
    const view=await host.call('/r1/auto/'+id) as R1AutoView;
    if(['associated','conflicts_pending','blocked','awaiting_answers','stopped','recovering'].includes(view.state))return view;
    await delay(20);
  }
  throw new Error('Automatic duplicate intake did not settle: '+JSON.stringify(await host.call('/r1/auto/'+id)));
}
async function ingest(host:FullChainHost,id:string,rows:[number,string][]):Promise<R1AutoView>{
  const uploaded=await host.upload(id+'.csv','data',raw(rows),id+'-upload'),task=await host.settled(uploaded.jobId);
  assert.equal(task.status,'succeeded',JSON.stringify(task.error));
  const materialId=host.services.materials!.getByTask(task.id)!.envelope.materialId;
  await host.call('/r1/auto/start',{requestId:id,materialId,source:{...source,source_id:id,requested_url:'https://fixture.example.test/'+id+'.csv'},datasetId:'dedup_observations'},202);
  return settled(host,id);
}

test('formal record evidence fixes exact identity, current binding and original bytes without a document index', {skip:!enabled,timeout:180000}, async()=>{
  const fixture=createFullChainFixture({name:'record-evidence',machine:true});let host=await openFullChainHost(fixture);
  try {
    const seed=await ingest(host,'evidence-seed',[[2,'12.30'],[3,'13.40']]);
    assert.equal(seed.state,'associated',JSON.stringify(seed));
    const association=(seed.currentRequest!.local.associations as WfdRecord[])[0]!;
    const identity={datasetId:String(association.dataset_id),productId:String(association.product_id),recordId:String(association.record_id),recordVersion:String(association.record_version)};
    const packet=await host.call('/r1/records/evidence',identity);
    assert.equal(packet.factVerification,'not_established');assert.equal(packet.snapshotId,association.snapshot_id);
    assert.equal(packet.requestId,seed.currentRequest!.requestId);assert.equal(packet.materials.length,1);
    const original=await fetch(new URL(packet.materials[0].originalUrl,host.base));
    assert.equal(original.status,200);assert.equal(wfdSha256(new Uint8Array(await original.arrayBuffer())),packet.materials[0].sha256);
    const reject=async(input:unknown)=>{const r=await fetch(host.base+'/r1/records/evidence',{method:'POST',headers:{'content-type':'application/json','x-mashiro-client':'web'},body:JSON.stringify(input)});assert.notEqual(r.status,200,await r.text());};
    await reject({...identity,recordVersion:'invented'});await reject({...identity,materialId:packet.materials[0].materialId});
    const duplicate=await ingest(host,'evidence-duplicate',[[2,'12.30'],[3,'13.40']]);assert.equal(duplicate.state,'associated');
    assert.deepEqual(await host.call('/r1/records/evidence',identity),packet,'duplicate does not replace origin');
    assert.equal(packet.processingRefsStatus,'frozen_reference_not_revalidated');
    const associationDb=host.database.connection;
    // Same bytes in a later acquisition are not authority to replace the original request.
    associationDb.prepare('UPDATE r1_record_associations SET request_id=? WHERE product_id=? AND record_id=? AND record_version=?')
      .run(duplicate.currentRequest!.requestId,identity.productId,identity.recordId,identity.recordVersion);
    await reject(identity);
    associationDb.prepare('UPDATE r1_record_associations SET request_id=? WHERE product_id=? AND record_id=? AND record_version=?')
      .run(seed.currentRequest!.requestId,identity.productId,identity.recordId,identity.recordVersion);
    assert.deepEqual(await host.call('/r1/records/evidence',identity),packet);

    const client=host.services.r1Runtime!.client, read=client.fixedRead.bind(client);
    client.fixedRead=async(...args)=>{const reply=await read(...args);return {...reply,result:{...reply.result,rows:[]}};};
    await reject(identity);client.fixedRead=read;
    const runtime=host.services.r1Runtime!, current=runtime.currentIdentity.bind(runtime);
    runtime.currentIdentity=()=>({...current(),namespace:'different-bound-database'});
    await reject(identity);runtime.currentIdentity=current;
    const db=host.database.connection, request=packet.requestId;
    const stored=db.prepare('SELECT local_refs_json FROM r1_handoff_attempts WHERE request_id=?').get(request)!;
    db.prepare("UPDATE r1_handoff_attempts SET local_refs_json='{}' WHERE request_id=?").run(request);
    await reject(identity);db.prepare('UPDATE r1_handoff_attempts SET local_refs_json=? WHERE request_id=?').run(stored.local_refs_json!,request);
    const originalId=packet.originalIds[0];
    const originalRow=db.prepare('SELECT original_bytes FROM r1_original_contents WHERE sha256=?').get(packet.source.sha256)!;
    db.prepare('UPDATE r1_original_contents SET original_bytes=? WHERE sha256=?').run(Buffer.from('tampered'),packet.source.sha256);
    await reject(identity);
    db.prepare('UPDATE r1_original_contents SET original_bytes=? WHERE sha256=?').run(originalRow.original_bytes!,packet.source.sha256);
    assert.ok(originalId);
    const refsRow=db.prepare('SELECT local_refs_json,local_refs_sha256 FROM r1_handoff_attempts WHERE request_id=?').get(request)!;
    const emptyRefs=JSON.parse(String(refsRow.local_refs_json));emptyRefs.originalIds=[];emptyRefs.materialIds=[];emptyRefs.processRefs=[];
    const missingRefs=JSON.parse(String(refsRow.local_refs_json));missingRefs.originalIds=['missing-acquisition'];
    const missingText=canonicalWfdJson(missingRefs);
    db.prepare('UPDATE r1_handoff_attempts SET local_refs_json=?,local_refs_sha256=? WHERE request_id=?').run(missingText,wfdSha256(missingText),request);
    await reject(identity);
    const emptyText=canonicalWfdJson(emptyRefs);
    db.prepare('UPDATE r1_handoff_attempts SET local_refs_json=?,local_refs_sha256=? WHERE request_id=?').run(emptyText,wfdSha256(emptyText),request);
    const emptyResponse=await host.call('/r1/records/evidence',identity,409);
    assert.ok(JSON.stringify(emptyResponse).includes('R1_EVIDENCE_SOURCE_BYTES_UNVERIFIED'));
    db.prepare('UPDATE r1_handoff_attempts SET local_refs_json=?,local_refs_sha256=? WHERE request_id=?').run(refsRow.local_refs_json!,refsRow.local_refs_sha256!,request);
    assert.equal(packet.evidenceRefsStatus,'frozen_reference_not_revalidated');assert.equal(packet.sourceBytesStatus,'verified');
    const taskCount=db.prepare('SELECT count(*) n FROM tasks').get()!.n;
    await host.close();host=await openFullChainHost(fixture);
    assert.deepEqual(await host.call('/r1/records/evidence',identity),packet);
    assert.equal(host.database.connection.prepare('SELECT count(*) n FROM tasks').get()!.n,taskCount);
    await host.close();host=await openFullChainHost(fixture,fixture.root);
    assert.deepEqual(await host.call('/r1/records/evidence',identity),packet);
    await reject(identity); // Missing current local-data generation is rejected by the actual application gate.
    const lifecycle=new DatabaseSync(join(fixture.root,'lifecycle.sqlite'));
    try {
      // Explicit fault injection of unavailable private state, not a fabricated owner lifecycle command.
      lifecycle.prepare("UPDATE local_data_lifecycle SET status='inactive',generation=generation+1").run();
      const denied=await fetch(host.base+'/r1/records/evidence',{method:'POST',headers:{'content-type':'application/json','x-mashiro-client':'web','x-local-data-generation':'1'},body:JSON.stringify(identity)});
      assert.notEqual(denied.status,200);assert.ok(!(await denied.text()).includes(packet.source.sha256));
    } finally { lifecycle.close(); }
  }finally{await host.close();}
});

function recipe(outputId: string): Omit<R1PrepareInput, 'requestId' | 'planId'> {
  return { outputId, source: { source_id: 'review-fixture', provider: 'synthetic-test', requested_url: 'test:review-fixture',
    requested_at_utc: '2026-01-06T09:00:00Z', acquired_at_utc: '2026-01-06T09:00:01Z', usage_scope: 'isolated-test',
    authorization: { status: 'authorized', basis: 'operator declared isolated synthetic test use' } },
    mapping: { kind: 'tabular_rows', businessKey: 'key', earliestUtc: 'start', latestExclusiveUtc: 'end',
      precision: 'day', sourceTimezone: 'Asia/Shanghai',
      fields: ['open','high','low','close','volume','amount'].map(fieldCode => ({ fieldCode, value: fieldCode, state: 'state' })),
      bar: { frequency: 'day', open: 'open', high: 'high', low: 'low', close: 'close', volume: 'volume', amount: 'amount' } },
    target: { datasetId: 'r1_review_test', outputKey: 'review.' + outputId, expectedParentSnapshotId: null,
      subject: { kind: 'instrument', namespace: 'r1.review.test', id: outputId }, inputMode: 'partial_observation',
      coverage: { scope: { synthetic_sample: true }, basis: 'observed_partial', completeness: 'partial', absence_means: 'unknown' },
      definition: { semantic_code: 'review.' + outputId, measurement_nature: 'mixed_observation', unit_code: 'per_field',
        definition_authority: 'r1.review.test', time_role: 'observation',
        field_definitions: ['open','high','low','close','volume','amount'].map((field_code, index) => ({ field_code, data_type: 'decimal',
          unit_code: index < 4 ? 'cny_per_share' : index === 4 ? 'share' : 'cny', measurement_nature: index < 4 ? 'stock' : 'flow', time_role: 'observation' })),
        semantic_context: { version: 'wfd.semantic-context/1.0', content_nature: 'observed_fact',
          time: { period_type: 'natural', frequency: 'day', interval: 'half_open', timezone: 'Asia/Shanghai' },
          statistical: { price_basis: 'nominal', period_aggregation: 'period' }, financial: { price_adjustment: { direction: 'raw' } } },
        field_semantic_context: { volume: { measurement: { aggregation: 'period_total' } }, amount: { measurement: { aggregation: 'period_total' } } } } } };
}

/** Fresh synthetic inputs, real host processing, no fabricated WFD records or receipts. */
async function preparedSetPlan(host: Awaited<ReturnType<typeof openFullChainHost>>, prefix: string,
  options: { badMember?: boolean; unknownUnit?: boolean } = {}) {
  const materials: { outputId: string; materialId: string }[] = [];
  for (const outputId of ['left', 'right']) {
    const raw = Buffer.from('key,start,end,open,high,low,close,volume,amount,state\n'
      + `${prefix}-${outputId},2026-01-04T16:00:00Z,2026-01-05T16:00:00Z,11.42,${options.badMember && outputId === 'right' ? '10' : '11.51'},11.41,11.50,100,1145,valid_value\n`);
    const uploaded = await host.upload(outputId + '.csv', 'data', raw, prefix + '-upload-' + outputId);
    const task = await host.settled(uploaded.jobId);
    assert.equal(task.status, 'succeeded', JSON.stringify(task.error));
    materials.push({ outputId, materialId: host.services.materials!.getByTask(task.id)!.envelope.materialId });
  }
  const facts = { role: 'financial-record', informationNature: 'direct-observation', businessObject: 'market_bars',
    objectTime: 'synthetic set objects; explicit intervals', purpose: 'isolated-test', structureGranularity: 'table' };
  const drafts = materials.map(({ outputId }) => {
    const draft = recipe(outputId);
    draft.source.source_id = prefix + '-' + outputId;
    if (options.unknownUnit && outputId === 'left') {
      const fields = draft.target.definition.field_definitions as { field_code: string; unit_code: string }[];
      for (const field of fields.filter(field => ['open','high','low','close'].includes(field.field_code)))
        field.unit_code = 'synthetic_unregistered_currency';
    }
    return draft;
  });
  const input = { consistencyGroups: { pair: ['left','right'] },
    routing: { materials: materials.map((item, index) => ({ materialId: item.materialId, intendedAction: 'publish',
      dimensions: Object.fromEntries(DIMENSION_KEYS.map(key => [key, { status: 'known', value: facts[key],
        evidence: [{ source: 'operator', field: `routing.materials.${index}.dimensions.${key}`, quote: facts[key] }] }])) })) },
    outputs: materials.map(({ outputId, materialId }, index) => {
      const draft = drafts[index]!;
      return { outputId, materialIds: [materialId], intendedAction: 'publish', stages: ['parse','structure','check'],
        tables: [{ materialId, format: 'csv', types: Object.fromEntries(['open','high','low','close','volume','amount'].map(key => [key,'decimal_string'])) }],
        target: { declaration: { protocol: 'wfd.structured-ingest/1.0', target: draft.target, mapping: draft.mapping, source: draft.source }, expectedSnapshotId: null } };
    }) };
  const prepared = await host.call('/processing/plans', { requestId: prefix + '-plan', input }, 202);
  const done = await host.settled(prepared.jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const planId = host.services.processing!.getByTask(done.id)!.plan!.planId;
  for (const { outputId } of materials) for (const kind of ['parse','structure','check']) {
    const step = host.services.processing!.get(planId).steps.find(item => item.outputId === outputId && item.kind === kind)!;
    const accepted = await host.call(`/processing/plans/${planId}/steps/${step.stepId}/execute`, { requestId: `${prefix}-${outputId}-${kind}` }, 202);
    const result = await host.settled(accepted.jobId);
    assert.equal(result.status, 'succeeded', JSON.stringify(result.error));
  }
  return { planId, drafts, materials, input };
}

test('record evidence isolates the second publication-set member and refuses contract mismatch', {skip:!enabled,timeout:180000},async()=>{
  const fixture=createFullChainFixture({name:'record-evidence-set',machine:true,units:{cny_per_share:{dimension:'money_per_share'},share:{dimension:'quantity'},cny:{dimension:'money'}}});
  const host=await openFullChainHost(fixture);
  try {
    const built=await preparedSetPlan(host,'evidence-set');
    const prepared=await host.call('/r1/prepare',{kind:'publication_set',requestId:'evidence-set-publish',planId:built.planId,setId:'pair'},201);
    const submitted=await host.call('/r1/requests/'+prepared.requestId+'/submit',{confirmationDigest:prepared.documentSha256},202);
    assert.equal((await host.settled(submitted.jobId)).status,'succeeded');
    const fixed=await host.call('/r1/requests/'+prepared.requestId);
    const links=fixed.local.associations as WfdRecord[];
    for(const member of fixed.publicationSet.members){
      const link=links.find(row=>row.product_id===member.productId)!;
      const identity={datasetId:String(link.dataset_id),productId:String(link.product_id),recordId:String(link.record_id),recordVersion:String(link.record_version)};
      const packet=await host.call('/r1/records/evidence',identity);
      assert.equal(packet.materials.length,1);assert.equal(packet.materials[0].materialId,built.materials.find(item=>item.outputId===member.outputId)!.materialId);
      assert.equal(packet.source.source_id,'evidence-set-'+member.outputId);
      const read=host.services.r1Runtime!.client.fixedRead.bind(host.services.r1Runtime!.client);
      host.services.r1Runtime!.client.fixedRead=async(...args)=>{const response=await read(...args);const result=structuredClone(response.result);for(const product of result.products as WfdRecord[]) delete product.contract_refs;return {...response,result};};
      await host.call('/r1/records/evidence',identity,409);
      host.services.r1Runtime!.client.fixedRead=read;
    }
  }finally{await host.close();}
});
