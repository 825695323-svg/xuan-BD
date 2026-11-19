import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { canonicalWfdJson, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { preparedSetPlan } from './r1-publication-set-test-support.js';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
const enabled = !!process.env.XUAN_FULL_CHAIN_ROOT && !!process.env.WFD_PYTHON;
test('explicit set evidence verifies every actual BD member, rejects incomplete evidence and never mutates publication',
  {skip:!enabled,timeout:180_000},async()=>{
  const fixture=createFullChainFixture({name:'publication-set-evidence',machine:true,
    units:{cny_per_share:{dimension:'money_per_share'},share:{dimension:'quantity'},cny:{dimension:'money'}}});
  let host=await openFullChainHost(fixture,fixture.root);
  try {
    const built=await preparedSetPlan(host,'set-evidence');
    const input={planId:built.planId,setId:'pair'},requestId='set-evidence-request',path=`/r1/requests/${requestId}/publication-set-evidence`;
    const prepared=await host.call('/r1/prepare',{kind:'publication_set',requestId,...input},201);
    assert.equal((await host.call(path,input,409)).code,'R1_SET_EVIDENCE_NOT_ASSOCIATED');
    const sent=await host.call(`/r1/requests/${requestId}/submit`,{confirmationDigest:prepared.documentSha256},202);
    const settled=await host.settled(sent.jobId);assert.equal(settled.status,'succeeded',JSON.stringify(settled.error));
    const counts=()=>['tasks','processing_plans','candidate_objects','r1_record_associations'].map(t=>host.database.connection.prepare(`SELECT count(*) AS n FROM ${t}`).get()!.n);
    const before=counts(),snapshot=(await host.services.r1Runtime!.connection.client.snapshotStatus()).result;
    const result=await host.call(path,input);
    assert.equal(result.status,'complete_fixed_set_verified');assert.equal(result.coverage,'selected_set_only');assert.equal(result.impact,'unknown');
    assert.equal(result.members.length,2);assert.equal(result.recordCount,2);
    assert.deepEqual(result.members.map((m:any)=>m.outputId).sort(),['left','right']);
    for(const m of result.members){assert.equal(m.snapshotId,result.snapshotId);assert.equal(m.records.length,1);assert.equal(m.records[0].product_id,m.productId);}
    assert.deepEqual(counts(),before);assert.deepEqual((await host.services.r1Runtime!.connection.client.snapshotStatus()).result,snapshot);
    assert.equal((await host.call(path,{...input,setId:'other'},409)).code,'R1_SET_EVIDENCE_REQUEST');
    const db=host.database.connection;
    const row=db.prepare('SELECT receipt_json,local_refs_json,local_refs_sha256 FROM r1_handoff_attempts WHERE request_id=?').get(requestId)!;
    for(const change of [
      (r:any)=>{r.members.pop();},
      (r:any)=>{r.members[1].output_key=r.members[0].output_key;},
      (r:any)=>{r.members[1].snapshot_id='different-snapshot';},
      (r:any)=>{r.members[1].product_id=r.members[0].product_id;},
      (r:any)=>{r.output_results.pop();},
      (r:any)=>{r.members[0].rows=[];},
      (r:any)=>{r.output_results[0].records[0].record_version='wrong-version';},
    ]){
      const receipt=JSON.parse(String(row.receipt_json));change(receipt);
      db.prepare('UPDATE r1_handoff_attempts SET receipt_json=? WHERE request_id=?').run(canonicalWfdJson(receipt),requestId);
      const denied=await host.call(path,input,409);assert.ok(!denied.members);assert.match(denied.code,/^R1_/);
    }
    db.prepare('UPDATE r1_handoff_attempts SET receipt_json=? WHERE request_id=?').run(row.receipt_json,requestId);
    db.prepare("UPDATE r1_handoff_attempts SET state='pending_unknown' WHERE request_id=?").run(requestId);
    assert.equal((await host.call(path,input,409)).code,'R1_SET_EVIDENCE_NOT_ASSOCIATED');
    db.prepare("UPDATE r1_handoff_attempts SET state='associated' WHERE request_id=?").run(requestId);
    const refs=JSON.parse(String(row.local_refs_json)), refsKeys=Object.keys(refs.outputs);
    refs.outputs[refsKeys[1]!].processRefs[0].output_id=refs.outputs[refsKeys[0]!].processRefs[0].output_id;
    const refsJson=canonicalWfdJson(refs);
    db.prepare('UPDATE r1_handoff_attempts SET local_refs_json=?,local_refs_sha256=? WHERE request_id=?').run(refsJson,wfdSha256(refsJson),requestId);
    assert.equal((await host.call(path,input,409)).code,'R1_SET_EVIDENCE_PROCESS');
    db.prepare('UPDATE r1_handoff_attempts SET local_refs_json=?,local_refs_sha256=? WHERE request_id=?').run(row.local_refs_json,row.local_refs_sha256,requestId);
    const client=host.services.r1Runtime!.client,read=client.fixedReadHistory.bind(client);
    let memberReads=0;
    client.fixedReadHistory=async(...args)=>{const reply=await read(...args);if(++memberReads===2)(reply.result.products as any[])[0].definition_ref.digest='changed';return reply;};
    const lastMemberFailed=await host.call(path,input,409);assert.equal(lastMemberFailed.code,'R1_OUTPUT_DEPENDENCIES_READBACK');assert.equal(memberReads,2);assert.ok(!lastMemberFailed.members);client.fixedReadHistory=read;
    client.fixedReadHistory=async(...args)=>{const reply=await read(...args);(reply.result.products as any[])[0].contract_bundle_ref.digest='changed';return reply;};
    const wrongContract=await host.call(path,input,409);assert.ok(!wrongContract.members);client.fixedReadHistory=read;
    const cancellation=new AbortController();let cancellationReads=0;
    client.fixedReadHistory=async(...args)=>{assert.ok(args[2]);assert.notEqual(args[2],cancellation.signal);const reply=await read(...args);cancellationReads++;cancellation.abort();return reply;};
    await assert.rejects(host.services.r1Workspace!.publicationSetEvidence(requestId,input,()=>{},cancellation.signal),{name:'AbortError'});
    assert.equal(cancellationReads,1);client.fixedReadHistory=read;
    const lifecycle=new DatabaseSync(join(fixture.root,'lifecycle.sqlite'));
    client.fixedReadHistory=async(...args)=>{const reply=await read(...args);lifecycle.exec('UPDATE local_data_lifecycle SET generation=2');return reply;};
    try {const denied=await host.call(path,input,409);assert.equal(denied.code,'STALE_LOCAL_DATA_GENERATION');assert.ok(!denied.members);}
    finally {client.fixedReadHistory=read;lifecycle.exec('UPDATE local_data_lifecycle SET generation=1');lifecycle.close();}
    assert.deepEqual(counts(),before);
    await host.close();host=await openFullChainHost(fixture,fixture.root);
    assert.deepEqual(await host.call(path,input),result);
    assert.deepEqual((await host.services.r1Runtime!.connection.client.snapshotStatus()).result,snapshot);
  }finally{await host.close();}
});

test('set identifier equal to an output identifier remains a complete two-member read', {skip:!enabled,timeout:180_000},async()=>{
  const fixture=createFullChainFixture({name:'set-evidence-same-id',machine:true,units:{cny_per_share:{dimension:'money_per_share'},share:{dimension:'quantity'},cny:{dimension:'money'}}});
  const host=await openFullChainHost(fixture,fixture.root);
  try {
    const built=await preparedSetPlan(host,'same-id',{setId:'left'}),input={planId:built.planId,setId:'left'},requestId='same-id-set';
    const prepared=await host.call('/r1/prepare',{kind:'publication_set',requestId,...input},201);
    const sent=await host.call(`/r1/requests/${requestId}/submit`,{confirmationDigest:prepared.documentSha256},202);
    assert.equal((await host.settled(sent.jobId)).status,'succeeded');
    const result=await host.call(`/r1/requests/${requestId}/publication-set-evidence`,input);
    assert.equal(result.status,'complete_fixed_set_verified');assert.equal(result.publicationState,'published_formal');
    assert.deepEqual(result.members.map((m:any)=>m.outputId).sort(),['left','right']);
  } finally {await host.close();}
});
