import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {createFullChainFixture,openFullChainHost} from './full-chain-test-support.js';
import {buildDocumentSegments} from '../../modules/collection/segments/segmenter.js';
import {syntheticPages} from '../../modules/collection/segments/fixture.js';
import {putDocumentSegments,createIndexVersion} from '../../modules/collection/segments/store.js';
// Native synthetic conversion pages, real store and HTTP service. No claim of real PDF extraction or source verification.
test('HTTP explicit FTS repair restores hit identity through reopen and obeys the private generation gate',{skip:!process.env.XUAN_FULL_CHAIN_ROOT},async()=>{
 const f=createFullChainFixture({name:'fts-repair-http'});let h=await openFullChainHost(f);let db:DatabaseSync|undefined;
 try{
  await h.call('/retrieval/index-versions');db=new DatabaseSync(join(dirname(h.database.path),'segments.sqlite'));
  const built=buildDocumentSegments({documentId:'synthetic-local-material',documentVersion:'v1',sourceRef:'synthetic-conversion',pages:syntheticPages()});
  putDocumentSegments(db,built.segments);createIndexVersion(db,{indexVersion:'historical-subset',segmentIds:[built.segments[1]!.segment_id]},1700000000000);
  const idx=await h.call('/retrieval/index',{},201),query={method:'keyword',query:'先进封装',indexVersion:idx.indexVersion};
  const before=await h.call('/retrieval/search',query),versions=await h.call('/retrieval/index-versions');
  assert.equal(before.status,'matched');db.exec('DELETE FROM doc_segments_fts');assert.equal((await h.call('/retrieval/search',query)).status,'no_match');
  const rebuilt=await h.call('/retrieval/index/rebuild-fts',{});assert.equal(rebuilt.identityPreserved,true);
  assert.deepEqual(await h.call('/retrieval/search',query),before);assert.deepEqual(await h.call('/retrieval/index-versions'),versions);
  const id=before.citations[0].segment_id;db.prepare('UPDATE doc_segments SET text=? WHERE segment_id=?').run('broken',id);
  const response=await h.call('/retrieval/segments/'+id,undefined,409);assert.ok(!JSON.stringify(response).includes('broken'));
  await h.call('/retrieval/index/rebuild-fts',{},409);db.prepare('UPDATE doc_segments SET text=? WHERE segment_id=?').run(built.segments.find(s=>s.segment_id===id)!.text,id);
  db.close();db=undefined;await h.close();h=await openFullChainHost(f,f.root);
  assert.deepEqual(await h.call('/retrieval/search',query),before);assert.deepEqual(await h.call('/retrieval/index-versions'),versions);
  const denied=await fetch(h.base+'/retrieval/index/rebuild-fts',{method:'POST',headers:{'content-type':'application/json','x-mashiro-client':'web'},body:'{}'});assert.notEqual(denied.status,200);
  await h.call('/retrieval/index/rebuild-fts',{});assert.deepEqual(await h.call('/retrieval/search',query),before);
  await h.close();db=new DatabaseSync(join(dirname(h.database.path),'segments.sqlite'));
  db.exec('UPDATE doc_segment_storage SET schema_version=0');
  const oldSchema=db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  h=await openFullChainHost(f);
  await h.call('/retrieval/index/rebuild-fts',{},409);
  assert.equal(db.prepare('SELECT schema_version FROM doc_segment_storage').get()!.schema_version,0);
  assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),oldSchema);
  db.exec('UPDATE doc_segment_storage SET schema_version=1');
 }finally{db?.close();await h.close();}
});

function textPdf(): Buffer {
 const stream='BT /F1 18 Tf 50 700 Td (Isolated rebuild provenance sample) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let text='%PDF-1.4\n';const offsets=[0];
 objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${body}\nendobj\n`;});
 const xref=Buffer.byteLength(text);text+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(text);
}
test('uploaded PDF runs real conversion and segment task before missing-cache repair',{skip:!process.env.XUAN_FULL_CHAIN_ROOT},async()=>{
 const f=createFullChainFixture({name:'fts-repair-real-pdf'}),h=await openFullChainHost(f);let db:DatabaseSync|undefined;
 try{
  const bytes=textPdf(),upload=await h.upload('rebuild.pdf','data',bytes,'repair-real-upload');assert.equal((await h.settled(upload.jobId)).status,'succeeded');
  const material=h.services.materials!.getByTask(upload.jobId)!.envelope;
  const converted=await h.call('/retrieval/documents/'+material.materialId+'/convert',{requestId:'repair-real-convert'},202);
  const task=await h.settled(converted.jobId);assert.equal(task.status,'succeeded',JSON.stringify(task.error));
  let indexed=false;
  for(let i=0;i<100;i++){const result=await h.call('/retrieval/search',{method:'keyword',query:'provenance'});if(result.status==='matched'){indexed=true;break;}await delay(20);}
  assert.ok(indexed,JSON.stringify(await h.call('/retrieval/documents/'+material.materialId+'/artifacts')));
  const query={method:'keyword',query:'provenance'},before=await h.call('/retrieval/search',query);
  db=new DatabaseSync(join(dirname(h.database.path),'segments.sqlite'));db.exec('DROP TABLE doc_segments_fts');
  await h.call('/retrieval/index/rebuild-fts',{});assert.deepEqual(await h.call('/retrieval/search',query),before);
  assert.deepEqual(h.services.materials!.readOriginal(material.materialId).bytes,bytes);
 }finally{db?.close();await h.close();}
});
