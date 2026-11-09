import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { R1AutoView } from '../../modules/collection/r1-auto.js';
import { wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1BatchView } from '../../modules/collection/r1-auto-batch.js';
import type { R1ChunkedCsvView } from '../../modules/collection/r1-chunked-csv.js';
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

test('duplicate HTTP intake appends new rows first, skips identical rows, preserves conflict facts and stops automatic retries', {skip:!enabled},async()=>{
  const fixture=createFullChainFixture({name:'r1-dedup',machine:true});let host=await openFullChainHost(fixture);
  const results:Record<string,R1AutoView>={};
  try{
    const first=results.first=await ingest(host,'dedup-first',[[2,'12.30'],[3,'13.40']]);
    assert.equal(first.state,'associated',JSON.stringify(first));assert.deepEqual(first.currentRequest!.rowSummary,{inserted:2,duplicate_skipped:0,conflict_pending:0});
    const original=(first.currentRequest!.local.associations as WfdRecord[])[0]!;
    const mixed=results.mixed=await ingest(host,'dedup-mixed',[[2,'12.30'],[3,'99.90'],[4,'14.50']]);
    assert.equal(mixed.state,'conflicts_pending',JSON.stringify(mixed));assert.equal(mixed.currentRequest!.state,'partially_associated');
    assert.deepEqual(mixed.currentRequest!.rowSummary,{inserted:1,duplicate_skipped:1,conflict_pending:1});
    assert.equal((mixed.currentRequest!.local.associations as unknown[]).length,2);
    const conflicts=(mixed.currentRequest!.local.receipt as WfdRecord).conflicts as WfdRecord[];
    assert.equal(conflicts.length,1);assert.equal(conflicts[0]!.row_index,1);assert.ok((conflicts[0]!.existing_rows as unknown[]).length);
    assert.match(JSON.stringify(conflicts[0]!.incoming_row),/99\.9/);assert.match(JSON.stringify(conflicts[0]!.existing_rows),/13\.4/);
    const count=host.database.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts').get()!.n;
    await host.call('/r1/auto/dedup-mixed/advance',{});await delay(50);
    assert.equal(host.database.connection.prepare('SELECT count(*) n FROM r1_handoff_attempts').get()!.n,count);
    const oldSource=host.services.r1!.recordMaterials({datasetId:'dedup_observations',productId:String(original.product_id),recordId:String(original.record_id),recordVersion:String(original.record_version)});
    assert.equal(oldSource!.requestId,first.currentRequest!.requestId);
    const head=await host.call('/r1/products/snapshot',{});
    const mixedAgain=results.mixedAgain=await ingest(host,'dedup-mixed-again',[[2,'12.30'],[3,'99.90'],[4,'14.50']]);
    assert.equal(mixedAgain.state,'conflicts_pending',JSON.stringify(mixedAgain));assert.deepEqual(mixedAgain.currentRequest!.rowSummary,{inserted:0,duplicate_skipped:2,conflict_pending:1});
    assert.equal((await host.call('/r1/products/snapshot',{})).snapshotId,head.snapshotId);
    const same=results.same=await ingest(host,'dedup-identical',[[2,'12.30'],[4,'14.50']]);
    assert.equal(same.state,'associated',JSON.stringify(same));assert.deepEqual(same.currentRequest!.rowSummary,{inserted:0,duplicate_skipped:2,conflict_pending:0});
    assert.equal((same.currentRequest!.local.receipt as WfdRecord).wfd_state,'unchanged');
    assert.equal((await host.call('/r1/products/snapshot',{})).snapshotId,head.snapshotId);
    const conflict=results.conflict=await ingest(host,'dedup-conflict',[[3,'99.90']]);
    assert.equal(conflict.state,'conflicts_pending',JSON.stringify(conflict));assert.equal(conflict.currentRequest!.state,'conflicts_pending');
    assert.deepEqual(conflict.currentRequest!.rowSummary,{inserted:0,duplicate_skipped:0,conflict_pending:1});
    const local=results.local=await ingest(host,'dedup-local',[[5,'15.60'],[5,'15.60'],[6,'16.70'],[6,'66.70']]);
    assert.equal(local.state,'conflicts_pending',JSON.stringify(local));assert.deepEqual(local.currentRequest!.rowSummary,{inserted:1,duplicate_skipped:1,conflict_pending:2});
    assert.equal((local.currentRequest!.local.associations as unknown[]).length,1);
    writeFileSync(join(fixture.root,'dedup-verification.json'),JSON.stringify({fixture,results},null,2)+'\n');
    await host.close();host=await openFullChainHost(fixture);
    const restored=await host.call('/r1/auto/dedup-mixed') as R1AutoView;
    assert.equal(restored.state,'conflicts_pending');assert.deepEqual(restored.currentRequest!.rowSummary,mixed.currentRequest!.rowSummary);
    assert.equal(restored.currentRequest!.documentSha256,mixed.currentRequest!.documentSha256);
    if(process.env.R1_DEDUP_EVIDENCE)writeFileSync(join(process.env.R1_DEDUP_EVIDENCE,'ui-fixture.json'),JSON.stringify({fixture,autoId:'dedup-mixed',requestId:mixed.currentRequest!.requestId,closed:true},null,2)+'\n');
  }finally{await host.close();}
});

test('duplicate batch and CSV APIs preserve pending conflicts while later files continue under exact status row pages',{skip:!enabled},async()=>{
  const fixture=createFullChainFixture({name:'r1-dedup-pages',machine:true}),host=await openFullChainHost(fixture);
  try{
    const client=host.services.r1Runtime!.client,submit=client.submit.bind(client),status=client.requestStatusPage.bind(client);let pages=0;
    client.submit=async(document,signal)=>{
      const reply=await submit(document,signal),result=structuredClone(reply.result);
      for(const output of (result.output_results as WfdRecord[]??[])) if(output.row_results){
        delete output.row_results;delete output.records;delete output.inserted_records;output.row_results_complete=false;
      }
      return {...reply,result};
    };
    client.requestStatusPage=async(identity,options={},signal)=>{if(options.rowOffset!==undefined)pages++;return status(identity,{...options,rowLimit:1},signal);};
    assert.equal((await ingest(host,'dedup-pages-seed',[[2,'12.30'],[3,'13.40']])).state,'associated');
    const bytes=[raw([[3,'99.90'],[7,'17.80']]),raw([[8,'18.90']])];
    let batch=await host.call('/r1/batches/start',{batchId:'dedup-batch',source:{...source,requested_url:'https://fixture.example.test/dedup-batch'},datasetId:'dedup_observations',files:bytes.map((data,index)=>({name:'item-'+index+'.csv',relativePath:'item-'+index+'.csv',sha256:wfdSha256(data),byteLength:data.length}))},202) as R1BatchView;
    for(let index=0;index<2;index++){
      assert.equal(batch.nextUploadItemId,'item-'+(index+1));
      const response=await fetch(`${host.base}/r1/batches/dedup-batch/items/item-${index+1}/upload`,{method:'POST',headers:{'Content-Type':'application/octet-stream','x-mashiro-client':'web'},body:new Uint8Array(bytes[index]!)});
      assert.equal(response.status,202,await response.text());
      for(let tries=0;tries<1000;tries++){
        batch=await host.call('/r1/batches/dedup-batch') as R1BatchView;
        if(['associated','conflicts_pending','blocked','awaiting_answers'].includes(batch.items[index]!.state))break;
        await delay(20);
      }
    }
    assert.equal(batch.state,'conflicts_pending',JSON.stringify(batch));assert.equal(batch.items[0]!.state,'conflicts_pending');assert.equal(batch.items[1]!.state,'associated');
    const csv=raw([[2,'12.30'],[3,'99.90'],[9,'19.10']]);
    await host.call('/r1/batches/chunked/start',{intakeId:'dedup-csv',name:'dedup.csv',sha256:wfdSha256(csv),byteLength:csv.length,source,datasetId:'dedup_observations'},202);
    const sent=await fetch(`${host.base}/r1/batches/chunked/dedup-csv/chunks/0`,{method:'POST',headers:{'Content-Type':'application/octet-stream','x-mashiro-client':'web'},body:new Uint8Array(csv)});
    assert.equal(sent.status,202,await sent.text());await host.call('/r1/batches/chunked/dedup-csv/advance',{},202);
    let chunked:R1ChunkedCsvView=await host.call('/r1/batches/chunked/dedup-csv');
    for(let tries=0;tries<1000;tries++){
      chunked=await host.call('/r1/batches/chunked/dedup-csv') as R1ChunkedCsvView;
      if(['completed','conflicts_pending','blocked','awaiting_answers','recovering'].includes(chunked.state))break;
      await delay(20);
    }
    assert.equal(chunked.state,'conflicts_pending',JSON.stringify(chunked));assert.equal(chunked.processedRows,3);
    assert.deepEqual(chunked.rowSummary,{inserted:1,duplicate_skipped:1,conflict_pending:1});assert.equal(chunked.conflictPages.length,1);
    assert.equal(chunked.conflictPages[0]!.rowStart,1);assert.equal(chunked.activePage,null);assert.ok(pages>=8);
    const tasks=host.database.connection.prepare('SELECT count(*) n FROM tasks').get()!.n;
    await host.call('/r1/batches/chunked/dedup-csv/advance',{},202);await host.call('/r1/batches/dedup-batch/advance',{});
    assert.equal(host.database.connection.prepare('SELECT count(*) n FROM tasks').get()!.n,tasks);
    writeFileSync(join(fixture.root,'batch-csv-verification.json'),JSON.stringify({fixture,batch,chunked,statusPages:pages},null,2)+'\n');
  }finally{await host.close();}
});
