import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { createFullChainFixture, openFullChainHost } from './full-chain-test-support.js';

// Entirely synthetic: text page, image-only page, then empty page. No external report or OCR.
function mixedPdf() {
 const stream=(s:string)=>`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 6 0 R 9 0 R] /Count 3 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
 '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',stream('BT /F1 18 Tf 50 700 Td (Synthetic coverage provenance) Tj ET'),
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 7 0 R >>',
 stream('q 100 0 0 100 50 500 cm /Im1 Do Q'),'<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 10 0 R >>',stream('')];
 let out='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${o}\nendobj\n`;});
 const xref=Buffer.byteLength(out);out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(out);
}
test('mixed PDF retains document text coverage through real upload conversion search and reopen',{skip:!process.env.XUAN_FULL_CHAIN_ROOT},async()=>{
 const f=createFullChainFixture({name:'mixed-pdf-coverage'});let h=await openFullChainHost(f);let db:DatabaseSync|undefined;
 try {
 const bytes=mixedPdf(),up=await h.upload('mixed.pdf','data',bytes,'mixed-upload');assert.equal((await h.settled(up.jobId)).status,'succeeded');
 const material=h.services.materials!.getByTask(up.jobId)!.envelope;
 const conversion=await h.call('/retrieval/documents/'+material.materialId+'/convert',{requestId:'mixed-convert'},202);
 const task=await h.settled(conversion.jobId);assert.equal(task.status,'succeeded',JSON.stringify(task.error));
 let result:any;for(let i=0;i<100;i++){result=await h.call('/retrieval/search',{method:'keyword',query:'provenance'});if(result.status==='matched')break;await delay(20);}
 assert.equal(result.status,'matched');db=new DatabaseSync(join(dirname(h.database.path),'segments.sqlite'));
 const row=db.prepare('SELECT * FROM doc_document_versions WHERE document_id=?').get(material.materialId)!;
 assert.equal(row.page_count,3,'total PDF pages must not be reduced to pages with indexed text');
 assert.ok(JSON.parse(String(row.issues_json)).includes('page_text_layer_incomplete'));
 assert.ok(result.citations[0].document_issues.includes('page_text_layer_incomplete'));
 assert.deepEqual(h.services.materials!.readOriginal(material.materialId).bytes,bytes);
 db.close();db=undefined;await h.close();h=await openFullChainHost(f,f.root);
 assert.deepEqual(await h.call('/retrieval/search',{method:'keyword',query:'provenance'}),result);
 }finally{db?.close();await h.close();}
});
