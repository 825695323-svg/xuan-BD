import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';
import { conversionText } from '../../platform/capabilities/conversion/storage.js';

// Self-authored native text, not a supplier report or OCR result.
function longPdf() {
 const objects:string[]=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 const kids:string[]=[], expectedPages:string[]=[];
 for(let page=0;page<8;page++) {
  const id=objects.length+1;kids.push(`${id} 0 R`);
  const lines=Array.from({length:48},(_,line)=>page===7&&line===47?'LASTREPORTMARKER final native source line':`Page ${page+1} line ${line+1} synthetic financial narrative without factual claims`);
  expectedPages.push(lines.join('\n'));
  const stream='BT /F1 9 Tf 12 TL 40 740 Td '+lines.map((s,i)=>(i?'T* ':'')+`(${s}) Tj`).join('\n')+' ET';
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id+1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
 }
 objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count 8 >>`;
 let out='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${o}\nendobj\n`;});
 const xref=Buffer.byteLength(out);out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return {bytes:Buffer.from(out),expectedPages};
}
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
test('long native PDF preview truncation does not truncate registered text or tail retrieval', {skip:!process.env.XUAN_FULL_CHAIN_ROOT}, async()=>{
 const f=createFullChainFixture({name:'long-pdf-retrieval'});let h=await openFullChainHost(f);
 try {
  const {bytes,expectedPages}=longPdf(),upload=await h.upload('synthetic-long.pdf','data',bytes,'long-upload');
  assert.equal((await h.settled(upload.jobId)).status,'succeeded');
  const material=h.services.materials!.getByTask(upload.jobId)!.envelope;
  const conversion=await h.call(`/retrieval/documents/${material.materialId}/convert`,{requestId:'long-convert'},202);
  const task=await h.settled(conversion.jobId);assert.equal(task.status,'succeeded',JSON.stringify(task.error));
  const data=(task.result as any).data;
  assert.equal(data.truncated,true);assert.equal(data.text.length,16000);assert.ok(data.characterCount>16000);
  assert.ok(!data.text.includes('LASTREPORTMARKER'));
  const artifactBytes=readFileSync(h.services.files.verify(data.structuredReference.fileRefId).invocationPath);
  assert.equal(sha(artifactBytes),data.structuredReference.sha256);
  const envelope=JSON.parse(artifactBytes.toString('utf8')),full=conversionText(envelope)!;
  assert.equal(envelope.content.pageCount,8);assert.equal(envelope.content.pages.length,8);
  assert.equal(envelope.source.sha256,sha(bytes));assert.equal(full.length,data.characterCount);
  assert.deepEqual(full.split('\f').map(page=>page.trimEnd()),expectedPages);
  assert.equal(full.slice(0,16000),data.text);assert.ok(full.indexOf('LASTREPORTMARKER')>16000);
  assert.equal(data.status,'partial');assert.ok(envelope.issues.some((i:any)=>i.code==='PDF_READING_ORDER_UNVERIFIED'));
  let result:any;for(let i=0;i<100;i++){result=await h.call('/retrieval/search',{method:'keyword',query:'LASTREPORTMARKER'});if(result.status==='matched')break;await delay(20);}
  assert.equal(result.status,'matched');assert.equal(result.citations.length,1);
  const citation=result.citations[0];assert.equal(citation.page_number,8);assert.equal(citation.document_id,material.materialId);
  assert.equal(citation.excerpt_truncated,true);assert.equal(citation.excerpt.length,2000);
  assert.ok(citation.char_end-citation.char_start>citation.excerpt.length);
  assert.notEqual(sha(citation.excerpt),citation.text_digest,'excerpt digest cannot prove full segment bytes');
  const fixed={method:'keyword',query:'LASTREPORTMARKER',indexVersion:result.coverage.index_version};
  result=await h.call('/retrieval/search',fixed);
  const input={indexVersion:fixed.indexVersion,segmentId:citation.segment_id};
  const evidence=await h.call('/retrieval/evidence',input);
  assert.deepEqual(evidence.citation,citation);
  for(const key of ['cache','artifact','original']) assert.equal(evidence[key].status,'verified',JSON.stringify(evidence));
  assert.equal(evidence.factVerification,'not_established');assert.equal(evidence.historicalQualification,'not_evaluated');
  assert.deepEqual(h.services.materials!.readOriginal(material.materialId).bytes,bytes);
  const tasks=h.services.tasks.list().map(t=>t.id).sort();
  await h.close();h=await openFullChainHost(f,f.root);
  assert.deepEqual(await h.call('/retrieval/search',fixed),result);assert.deepEqual(await h.call('/retrieval/evidence',input),evidence);
  assert.deepEqual(h.services.tasks.list().map(t=>t.id).sort(),tasks);
 } finally {await h.close();}
});
