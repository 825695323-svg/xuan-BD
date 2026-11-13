import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalWfdJson, wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { WfdProductMachineReply } from '../../adapters/database/wfd-product-machine.js';
import type { SourceMinuteBatchHeader, SourceMinuteReadPage } from '../../contracts/source-minute-batch.js';
import type { SourceMinuteBulkManifest } from './data-processing/source-minute-bulk.js';
import { buildSourceMinuteBatchHeader, verifySourceMinuteBatchReadback, verifySourceMinuteBatchReceipt } from './r1-source-minute-transport.js';
const sha = (v: unknown) => 'sha256:' + wfdSha256(canonicalWfdJson(v));
const cells = Array.from({ length: 7 }, (_, i) => ['20260407', `2026-04-07 09:${String(30+i).padStart(2,'0')}:00`, '000001', '0.0','0','1.0','2','3.0','4','5.0',null]);
const fields = ['date','minute','identity',...Array.from({length:8},(_,i)=>'value'+i)];
function fixture() {
  const base = { version: 'bd.source-minute-bulk/1', planDigest: sha('plan'), sourceSha256: sha('source'), sourceBytes: 100, materialId: 'material',
    headerRange: { sourceRow:1,sourceLine:1,startByte:0,endByte:10 }, evidenceRange:{startByte:0,endByte:100,sha256:sha('source')},
    target:{datasetId:'isolated',outputKey:'source.minute',expectedParentSnapshotId:null,subject:{kind:'entity',namespace:'local',id:'source'},
      definition:{semantic_code:'source.minute',semantic_context:{content_nature:'source_claim'},field_definitions:fields.map(field_code=>({field_code,data_type:'text'}))},
      inputMode:'partial_observation',coverage:{basis:'observed_partial'}}, fieldCodes:fields,
    partition:{date:'20260407',date_field:'date',minute_field:'minute',identity_field:'identity',timezone:'Asia/Shanghai',key_algorithm:'wfd.source-minute-key/1'},
    rowCount:cells.length,rowsDigest:'sha256:'+createHash('sha256').update(cells.map(r=>canonicalWfdJson(r)+'\n').join('')).digest('hex'),
    chunks:[cells.slice(0,4),cells.slice(4)].map((rows,ordinal)=>({chunk_id:'c'+String(ordinal).padStart(6,'0'),ordinal,row_count:rows.length,digest:sha(rows)})),
    locatorDigests:[sha('loc1'),sha('loc2')],check:{standardMarketCalculation:false,quality:'pass',ruleVersion:'test',ruleDigest:sha('rules'),checkScope:[],gaps:[]},
  };
  const manifest = {...base,manifestDigest:sha(base)} as SourceMinuteBulkManifest;
  const header = buildSourceMinuteBatchHeader(manifest,{requestId:'one',namespace:'local'});
  const product_id = 'p_'+'b'.repeat(24), roles=['algorithm_dependency','read_layout','semantic','update_release'];
  const contract_refs = Object.fromEntries(roles.map(role=>[role,{id:'contract_'+role+'_'+wfdSha256(canonicalWfdJson(['isolated',product_id,role])).slice(0,24),
    version:'v_'+sha(role).slice(7,23),kind:'contract',role,dataset_id:'isolated',namespace:'wfd.product',resolution:'pinned',digest:sha(role),required:true,dependency_type:'read'}]));
  const bundleBody={format_version:'wfd.contract-bundle/1.0',product_id,dataset_id:'isolated',roles,contracts:contract_refs};
  const receipt:WfdRecord={snapshot_id:'s_'+'a'.repeat(24),product_id,partition:'20260407',result_root:sha('root'),protocol_version:header.protocol_version,
    state:'published_formal',formal_publication_verified:true,row_count:7,rows_digest:manifest.rowsDigest,row_summary:{inserted:7,duplicate_skipped:0,conflict_pending:0,pending_publication:0},
    partition_fingerprint:header.request_identity.submission_digest,output_key:'source.minute',subject:base.target.subject,definition:base.target.definition,
    definition_ref:{kind:'definition_version',dataset_id:'isolated',namespace:'wfd.product',id:'def_'+sha(base.target.definition).slice(7,31),
      version:'v_'+sha(base.target.definition).slice(7,23),digest:sha(base.target.definition),resolution:'pinned',required:true,dependency_type:'read'},contract_refs,
    contract_bundle_ref:{id:'cb_'+sha(bundleBody).slice(7,31),version:'v_'+sha(bundleBody).slice(7,23),kind:'contract_bundle',dataset_id:'isolated',namespace:'wfd.product',
      resolution:'pinned',roles,digest:sha(bundleBody),required:true,dependency_type:'read'}};
  const page = (input:SourceMinuteReadPage, raw = cells) => {
    const offset = input.cursor===null?0:Number(input.cursor), end=Math.min(offset+Math.min(input.page_size,2),raw.length);
    return {...receipt,rows:raw.slice(offset,end).map((values,index)=>{
      const key='source_minute_20260407_'+wfdSha256(canonicalWfdJson([values[2],values[1]]));
      const start=new Date(String(values[1]).replace(' ','T')+'+08:00');
      const semantic={business_key:key,subject:receipt.subject,observation_time:{status:'known',earliest_utc:start.toISOString().replace('.000Z','Z'),
        latest_exclusive_utc:new Date(start.getTime()+60000).toISOString().replace('.000Z','Z'),precision:'minute',source_timezone:'Asia/Shanghai'},
        values:Object.fromEntries(fields.map((code,i)=>[code,{data_type:'text',value_state:values[i]===null?'unknown':'valid_value',value:values[i]}]))};
      return {cells:values,record_id:key,record_version:'r_'+wfdSha256(canonicalWfdJson([product_id,semantic,'partial_observation',null,String(receipt.partition_fingerprint).slice(7),'source.minute'])).slice(0,32),row_index:offset+index};
    }),next_cursor:end<raw.length?String(end):null};
  };
  return {manifest,header,receipt,page};
}
const reply=(result:WfdRecord)=>({result} as WfdProductMachineReply);
test('whole-source receipt binds header, complete original lexemes, fixed contracts and deterministic row versions',async()=>{
  const f=fixture(), checkpoints:WfdRecord[]=[];
  const proof=await verifySourceMinuteBatchReadback({...f,client:{sourceMinuteReadPage:async input=>reply(f.page(input))},assertCurrent(){},onCheckpoint:c=>{checkpoints.push(c);}});
  assert.equal(proof.row_count,7);assert.equal(proof.verified_chunks,2);assert.equal(proof.standard_market_calculation,false);
  assert.deepEqual(checkpoints.map(c=>c.verifiedRows),[4,7]);assert.ok(JSON.stringify(proof).length<5000);
});
test('readback resumes only complete source chunks and retains original versions for duplicate whole-date replay',async()=>{
  const f=fixture(), checkpoint:WfdRecord[]=[];let calls=0;
  await assert.rejects(verifySourceMinuteBatchReadback({...f,client:{sourceMinuteReadPage:async input=>{if(++calls===4)throw Error('disconnect');return reply(f.page(input));}},assertCurrent(){},onCheckpoint:c=>{checkpoint.push(c);}}),/disconnect/);
  assert.equal(checkpoint.length,1);assert.equal(checkpoint[0]!.verifiedRows,4);
  const starts:(string|null)[]=[];
  await verifySourceMinuteBatchReadback({...f,checkpoint:checkpoint[0],client:{sourceMinuteReadPage:async input=>{starts.push(input.cursor);return reply(f.page(input));}},assertCurrent(){},onCheckpoint(){}});
  assert.deepEqual(starts,['4','6']);
  const header:SourceMinuteBatchHeader=buildSourceMinuteBatchHeader(f.manifest,{requestId:'new-id',namespace:'local'});
  f.receipt.state='unchanged';f.receipt.row_summary={inserted:0,duplicate_skipped:7,conflict_pending:0,pending_publication:0};
  const proof=await verifySourceMinuteBatchReadback({...f,header,client:{sourceMinuteReadPage:async input=>reply(f.page(input))},assertCurrent(){},onCheckpoint(){}});
  assert.equal(proof.partition_fingerprint,f.header.request_identity.submission_digest);
});
test('wrong root/contract, omitted tail, changed original values, ordering and versions never produce an association',async()=>{
  const changes:((p:WfdRecord)=>void)[]=[p=>{p.result_root=sha('wrong');},p=>{p.contract_bundle_ref={};},p=>{p.next_cursor=null;},
    p=>{(p.rows as any[])[0].cells[3]='0';},p=>{(p.rows as any[])[0].record_version='wrong';},
    p=>{(p.rows as any[])[0].row_index=2;},p=>{p.definition={};},p=>{p.rows=[];}];
  for(const change of changes){const f=fixture();let saved=0;
    await assert.rejects(verifySourceMinuteBatchReadback({...f,client:{sourceMinuteReadPage:async input=>{const p=structuredClone(f.page(input));change(p);return reply(p);}},assertCurrent(){},onCheckpoint(){saved++;}}));assert.equal(saved,0);
  }
  const f=fixture(),raw=structuredClone(cells);raw[0]![3]='0';
  await assert.rejects(verifySourceMinuteBatchReadback({...f,client:{sourceMinuteReadPage:async input=>reply(f.page(input,raw))},assertCurrent(){},onCheckpoint(){}}),/完整原报列值/);
});
test('changed receipt counts, definition, manifest or checkpoint and cancellation fail closed',async()=>{
  const f=fixture();for(const change of [(r:WfdRecord)=>{r.row_count=6;},(r:WfdRecord)=>{r.definition={};},(r:WfdRecord)=>{r.partition_fingerprint=sha('other');}]){
    const r=structuredClone(f.receipt);change(r);assert.throws(()=>verifySourceMinuteBatchReceipt(f.header,f.manifest,r));
  }
  for (const key of ['kind','dataset_id','namespace','id','version','resolution']) {
    const receipt=structuredClone(f.receipt);(receipt.definition_ref as WfdRecord)[key]='wrong';
    assert.throws(()=>verifySourceMinuteBatchReceipt(f.header,f.manifest,receipt));
  }
  const manifest=structuredClone(f.manifest);manifest.sourceBytes++;assert.throws(()=>buildSourceMinuteBatchHeader(manifest,{requestId:'one',namespace:'local'}));
  const controller=new AbortController();controller.abort(Error('stop'));let called=false;
  await assert.rejects(verifySourceMinuteBatchReadback({...f,signal:controller.signal,client:{sourceMinuteReadPage:async input=>{called=true;return reply(f.page(input));}},assertCurrent(){},onCheckpoint(){}}),/stop/);assert.equal(called,false);
  await assert.rejects(verifySourceMinuteBatchReadback({...f,checkpoint:{version:'bad'},client:{sourceMinuteReadPage:async input=>reply(f.page(input))},assertCurrent(){},onCheckpoint(){}}),/检查点/);
});
