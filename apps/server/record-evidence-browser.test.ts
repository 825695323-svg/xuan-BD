import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1AutoView } from '../../modules/collection/r1-auto.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';
const enabled=!!process.env.WFD_PYTHON&&!!process.env.XUAN_FULL_CHAIN_ROOT;
const program=process.env.XUAN_TEST_BROWSER,digest=process.env.XUAN_TEST_BROWSER_SHA256,webRoot=process.env.XUAN_TEST_WEB_ROOT;
type Browser=Awaited<ReturnType<typeof openIsolatedBrowser>>;
const q=JSON.stringify,root='.r1-read-panel';
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


async function setup(host:FullChainHost){
 const first=await ingest(host,'evidence-ui-first',[[2,'12.30'],[3,'13.40']]);assert.equal(first.state,'associated',JSON.stringify(first));
 const link=(first.currentRequest!.local.associations as WfdRecord[])[0]!;
 const identity={datasetId:String(link.dataset_id),productId:String(link.product_id),recordId:String(link.record_id),recordVersion:String(link.record_version)};
 const later=await ingest(host,'evidence-ui-later',[[4,'14.50']]);assert.equal(later.state,'associated',JSON.stringify(later));
 const packet=await host.call('/r1/records/evidence',identity);
 const current=(await host.call('/r1/products/snapshot',{})).snapshotId;
 assert.notEqual(packet.snapshotId,current,'Evidence publication snapshot is not necessarily current reading snapshot');
 return {identity,packet,current};
}
async function state(host:FullChainHost){return {tasks:host.database.connection.prepare('SELECT id,status,version FROM tasks ORDER BY id').all(),attempts:host.database.connection.prepare('SELECT request_id,state,receipt_json FROM r1_handoff_attempts ORDER BY request_id').all(),snapshot:(await host.services.r1Runtime!.connection.client.snapshotStatus()).result};}
test('original evidence UI fixture uses actual BD publication and exact read-only source association',{skip:!enabled,timeout:180000},async()=>{
 const f=createFullChainFixture({name:'record-evidence-ui-http',machine:true}),h=await openFullChainHost(f,f.root);
 try{const {identity,packet}=await setup(h),before=await state(h);
 const response=await fetch(new URL(packet.materials[0].originalUrl,h.base),{headers:{'x-local-data-generation':'1'}});assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer());assert.equal(bytes.byteLength,packet.materials[0].bytes);assert.equal(wfdSha256(bytes),packet.materials[0].sha256);
 await h.call('/r1/records/evidence',{...identity,recordVersion:'no-association'},409);
 const db=h.database.connection,stored=db.prepare('SELECT original_bytes FROM r1_original_contents WHERE sha256=?').get(packet.source.sha256)!;
 db.prepare('UPDATE r1_original_contents SET original_bytes=? WHERE sha256=?').run(Buffer.from('explicit-test-corruption'),packet.source.sha256);
 await h.call('/r1/records/evidence',identity,409);
 db.prepare('UPDATE r1_original_contents SET original_bytes=? WHERE sha256=?').run(stored.original_bytes!,packet.source.sha256);
 assert.deepEqual(await h.call('/r1/records/evidence',identity),packet);assert.deepEqual(await state(h),before);
 }finally{await h.close();}
});
async function click(b:Browser,label:string){await b.until(`(()=>{const e=[...document.querySelector(${q(root)}).querySelectorAll('button')].find(e=>e.innerText.trim()===${q(label)}&&!e.disabled&&e.checkVisibility()&&!e.closest('details:not([open])'));if(!e)return false;e.click();return true;})()`,'Unavailable '+label);await b.until(`document.querySelector(${q(root)})?.getAttribute('aria-busy')==='false'`,'Read pending');}
async function navigate(b:Browser,h:FullChainHost){await b.page('Page.navigate',{url:h.base.replace('/api/bd','/')});await b.until(`(()=>{if(document.querySelector('.r1-panel')?.getAttribute('aria-busy')==='false')return true;(document.querySelector('button[aria-label="数据库"]')||document.querySelector('button[aria-label="Database"]'))?.click();return false;})()`,'Reader unavailable');}
async function select(b:Browser,id:string,en=false){
 await click(b,en?'View current data':'查看当前数据');
 const label=en?'Product':'产品';
 await b.evaluate(`(()=>{
   const field=[...document.querySelector(${q(root)}).querySelectorAll('label')].find(e=>e.firstElementChild?.innerText===${q(label)});
   const product=field?.querySelector('select');
   if(!product||!product.checkVisibility()||![...product.options].some(e=>e.value===${q(id)}))throw Error('Missing visible product selection');
   if(product.value!==${q(id)}){
     Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(product,${q(id)});
     product.dispatchEvent(new Event('change',{bubbles:true}));
   }
 })()`);
 await click(b,en?'View data':'查看数据');
}
const evidencePanel='[data-testid="record-evidence-panel"]';
async function verify(b:Browser,id:string,en=false){
 const label=en?'Verify original':'核对原件';
 await b.until(`(()=>{const e=[...document.querySelectorAll(${q(root+' button[data-record-id]')})].find(e=>e.dataset.recordId===${q(id)}&&e.innerText.trim()===${q(label)}&&!e.disabled&&e.checkVisibility());if(!e)return false;e.click();return true;})()`,'Actual row evidence button unavailable');
}
async function evidenceDetails(b:Browser,en=false){
 const label=en?'Evidence details':'原件核对详情';
 return b.evaluate<string>(`(()=>{
   const panel=document.querySelector(${q(evidencePanel)});
   const summary=[...panel.querySelectorAll('details > summary')].find(e=>e.innerText.trim()===${q(label)}&&e.checkVisibility());
   if(!summary||summary.parentElement.open)throw Error('Evidence details must start closed');
   summary.click();
   if(!summary.parentElement.open)throw Error('Evidence details did not open');
   const text=summary.parentElement.innerText;
   summary.click();
   return text;
 })()`);
}
async function assertVerifiedEvidence(b:Browser,identifiers:string[],en=false){
 const message=en?'The original file and its association with this record were verified.':'已核对这条记录与原件的关联及文件内容。';
 await b.until(`(()=>{const panel=document.querySelector(${q(evidencePanel)});return panel?.getAttribute('aria-busy')==='false'&&panel.innerText.includes(${q(message)});})()`,'Verified source evidence missing');
 const visible=await b.evaluate<string>(`document.querySelector(${q(evidencePanel)}).innerText`);
 const details=await evidenceDetails(b,en);
 for(const identifier of identifiers){
   assert.ok(!visible.includes(identifier), 'Evidence identity must stay out of the default view: '+identifier);
   assert.ok(details.includes(identifier), 'Opened evidence details must show the verified identity: '+identifier);
 }
}
async function capture(b:Browser,dir:string,name:string){const selector='[data-testid="record-evidence-panel"]';await b.evaluate(`document.querySelector(${q(selector)}).scrollIntoView({block:'start',inline:'nearest'})`);await b.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const boxes=await b.evaluate<Array<{left:number;right:number;top:number;bottom:number;width:number}>>(`[document.querySelector(${q(selector)}),...document.querySelectorAll(${q(selector+' button')})].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}})`);assert.ok(Math.min(boxes[0]!.bottom,1100)>Math.max(boxes[0]!.top,0));for(const box of boxes)assert.ok(box.width>0&&box.left>=-2&&box.right<=392,JSON.stringify(box));writeFileSync(join(dir,name+'.png'),Buffer.from((await b.page('Page.captureScreenshot',{format:'png'})).data,'base64'));}
test('actual persisted row original-evidence UI verifies source bytes without publishing or dispatching',{skip:!(enabled&&program&&digest&&webRoot),timeout:240000},async()=>{
 assert.equal(wfdSha256(readFileSync(program!)),digest);const f=createFullChainFixture({name:'r-ev',machine:true}),h=await openFullChainHost(f,webRoot!),visual=process.env.XUAN_RECORD_EVIDENCE_VISUAL_ROOT??f.root;mkdirSync(visual,{recursive:true});let b:Browser|undefined;
 try{const {identity,packet,current}=await setup(h),before=await state(h);b=await openIsolatedBrowser(program!,f.root);await b.page('Emulation.setDeviceMetricsOverride',{width:390,height:1100,deviceScaleFactor:1,mobile:false});
 await b.page('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const original=window.fetch.bind(window);window.__evidenceDelay=false;window.__downloadDelay=false;window.__blobReads=[];window.__downloadClicks=[];window.__capsCompleted=0;
 const create=URL.createObjectURL.bind(URL),anchorClick=HTMLAnchorElement.prototype.click;
 URL.createObjectURL=function(blob){const url=create(blob);if(blob instanceof Blob){const item={url,bytes:blob.size,sha256:null};window.__blobReads.push(item);blob.arrayBuffer().then(data=>crypto.subtle.digest('SHA-256',data)).then(hash=>item.sha256=[...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,'0')).join(''));}return url;};
 HTMLAnchorElement.prototype.click=function(){if(this.href.startsWith('blob:')&&this.download)window.__downloadClicks.push({href:this.href,filename:this.download});return anchorClick.call(this);};window.fetch=async(...a)=>{const u=new URL(String(a[0]),location.href);const r=await original(...a);if(u.pathname==='/api/bd/r1/capabilities')window.__capsCompleted++;if(u.pathname==='/api/bd/r1/records/evidence'&&window.__evidenceDelay){window.__evidenceWaiting=true;await new Promise(resolve=>window.__evidenceRelease=resolve);}if(u.pathname.startsWith('/api/bd/materials/')&&u.pathname.endsWith('/original')&&r.ok){const data=await r.clone().arrayBuffer();window.__originalRead={bytes:data.byteLength,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('')};if(window.__downloadDelay){window.__downloadWaiting=true;await new Promise(resolve=>window.__downloadRelease=resolve);}}return r;};})()`});
 await navigate(b,h);await b.click('查询固定快照');await select(b,identity.productId);
 assert.equal(b.requests.filter(r=>new URL(r.url).pathname==='/api/bd/r1/records/evidence').length,0);
 await verify(b,identity.recordId);
 const identities=[identity.recordId,identity.recordVersion,current,packet.snapshotId,packet.requestId,packet.materials[0].sha256];
 await assertVerifiedEvidence(b,identities);await capture(b,visual,'record-evidence-zh-light');
 await click(b,'下载已核原件');await b.until('!!window.__originalRead','Actual original GET not completed');assert.deepEqual(await b.evaluate('window.__originalRead'),{bytes:packet.materials[0].bytes,sha256:packet.materials[0].sha256});
 await b.until('window.__blobReads.length===1&&window.__blobReads[0].sha256!==null&&window.__downloadClicks.length===1','Verified Blob was not handed to the actual download click');
 const download=await b.evaluate<any>('({blob:window.__blobReads[0],click:window.__downloadClicks[0]})');assert.equal(download.blob.sha256,packet.materials[0].sha256);assert.equal(download.blob.bytes,packet.materials[0].bytes);assert.equal(download.click.href,download.blob.url);assert.ok(download.click.filename);
 // Retain the actual GET response until the active reader scope is removed. Real native Blob/click hooks observe, never replace, the download.
 await b.evaluate('window.__downloadDelay=true;window.__downloadWaiting=false');await click(b,'下载已核原件');await b.until('window.__downloadWaiting===true','Download response not delayed');
 await click(b,'查看当前数据');const caps=await b.evaluate<number>('window.__capsCompleted');await b.evaluate('window.__downloadDelay=false;window.__downloadRelease()');
 await b.until(`window.__capsCompleted>${caps}`,'Post-download binding check did not complete');await delay(200);
 assert.deepEqual(await b.evaluate('({blobs:window.__blobReads.length,clicks:window.__downloadClicks.length})'),{blobs:1,clicks:1},'Removed evidence panel must not create or click a new download');
 await select(b,identity.productId);await verify(b,identity.recordId);await assertVerifiedEvidence(b,identities);

 // Actual retained bytes corruption: no positive report or download link may remain.
 const db=h.database.connection,stored=db.prepare('SELECT original_bytes FROM r1_original_contents WHERE sha256=?').get(packet.source.sha256)!;
 db.prepare('UPDATE r1_original_contents SET original_bytes=? WHERE sha256=?').run(Buffer.from('explicit-test-corruption'),packet.source.sha256);
 await click(b,'重新核对原件');
 await b.until(`document.querySelector(${q(evidencePanel+' [role=alert]')})?.innerText.includes('未能核对这条记录关联的原件。')`,'Corruption not rejected');
 assert.ok(!(await evidenceDetails(b)).includes(packet.materials[0].sha256));
 assert.ok(!(await b.evaluate<string>(`document.querySelector(${q(evidencePanel)}).innerText`)).includes('下载已核原件'));
 await capture(b,visual,'record-evidence-error-zh-light');
 db.prepare('UPDATE r1_original_contents SET original_bytes=? WHERE sha256=?').run(stored.original_bytes!,packet.source.sha256);
 await b.evaluate('window.__evidenceDelay=true;window.__evidenceWaiting=false');await verify(b,identity.recordId);await b.until('window.__evidenceWaiting===true','Actual evidence response not delayed');await click(b,'查看当前数据');await b.evaluate('window.__evidenceDelay=false;window.__evidenceRelease()');await delay(200);assert.equal(await b.evaluate("!!document.querySelector('[data-testid=record-evidence-panel]')"),false,'Old scope evidence reappeared');
 await b.evaluate(`(async()=>{const s=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));const headers={'x-local-data-generation':String(s.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const p=await(await fetch('/api/ui/preferences',{headers})).json();const r=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en',theme:'dark'})});if(!r.ok)throw Error('Preference update failed');})()`);
 await navigate(b,h);await b.click('Query fixed snapshot');await select(b,identity.productId,true);await verify(b,identity.recordId,true);await assertVerifiedEvidence(b,identities,true);await capture(b,visual,'record-evidence-en-dark');
 const evidenceRequests=b.requests.filter(r=>new URL(r.url).pathname==='/api/bd/r1/records/evidence').length;
 await b.evaluate(`(()=>{
   const panel=document.querySelector(${q(root)});
   const summary=[...panel.querySelectorAll('details > summary')].find(e=>e.firstElementChild?.innerText==='Historical view'&&e.checkVisibility());
   if(!summary||summary.parentElement.open)throw Error('Historical view should be available and collapsed');
   summary.click();
   const select=summary.parentElement.querySelector('select[aria-label="Historical view"]');
   if(!select?.checkVisibility())throw Error('Historical view did not open');
   Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'market_known_at');
   select.dispatchEvent(new Event('change',{bubbles:true}));
 })()`);
 await b.until("!document.querySelector('[data-testid=record-evidence-panel]')&&!document.querySelector('button[data-record-id]')",'Snapshot evidence entry remains in historical mode');
 assert.equal(b.requests.filter(r=>new URL(r.url).pathname==='/api/bd/r1/records/evidence').length,evidenceRequests,'Mode change must not automatically verify original bytes');assert.deepEqual(await state(h),before);
 const allowed=new Set(['/api/bd/r1/records/evidence','/api/bd/r1/products/snapshot','/api/bd/r1/products/discover','/api/bd/r1/products/read']);
 assert.equal(b.requests.filter(r=>new URL(r.url).pathname.startsWith('/api/bd/')&&r.method!=='GET'&&!allowed.has(new URL(r.url).pathname)).length,0,'No task dispatch or publication command');assert.equal(b.blockedRequests.length,0);assert.equal(b.exceptions.length,0);
 }finally{await b?.close();await h.close();}
});
