import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';
import { textPdf } from './retrieval-evidence-test-support.js';
import { openIsolatedBrowser } from './r1-browser-test-support.js';
const program=process.env.XUAN_TEST_BROWSER,digest=process.env.XUAN_TEST_BROWSER_SHA256,webRoot=process.env.XUAN_TEST_WEB_ROOT;
const enabled=!!process.env.XUAN_FULL_CHAIN_ROOT,q=JSON.stringify,panel='[data-testid="retrieval-storage"]',report='[data-testid="retrieval-storage-report"]';
type Browser=Awaited<ReturnType<typeof openIsolatedBrowser>>;
async function populate(h:FullChainHost){
 const bytes=textPdf(),u=await h.upload('storage-synthetic.pdf','data',bytes,'storage-upload');
 assert.equal((await h.settled(u.jobId)).status,'succeeded');
 const material=h.services.materials!.getByTask(u.jobId)!.envelope;
 const c=await h.call('/retrieval/documents/'+material.materialId+'/convert',{requestId:'storage-convert'},202);
 assert.equal((await h.settled(c.jobId)).status,'succeeded');
 for(let n=0;n<200;n++){const found=await h.call('/retrieval/search',{method:'keyword',query:'provenance'});if(found.status==='matched')return {materialId:material.materialId,bytes,hit:found};await delay(25);}
 assert.fail('Actual PDF conversion/index did not become available');
}
async function facts(h:FullChainHost,materialId:string){return {tasks:h.database.connection.prepare('SELECT id,status,version FROM tasks ORDER BY id').all(),indexes:await h.call('/retrieval/index-versions'),original:wfdSha256(h.services.materials!.readOriginal(materialId).bytes)};}
test('retrieval storage HTTP reads real PDF index without creating cold stores or migrating old schemas',{skip:!enabled,timeout:120000},async()=>{
 const f=createFullChainFixture({name:'storage-http'});let h=await openFullChainHost(f,f.root);const path=join(dirname(h.database.path),'segments.sqlite');
 try{
  assert.equal(existsSync(path),false);const cold=await h.call('/retrieval/storage',undefined,409);assert.equal(cold.code,'RETRIEVAL_STORAGE_UNAVAILABLE');assert.equal(existsSync(path),false);
  const input=await populate(h),before=await facts(h,input.materialId),r=await h.call('/retrieval/storage');
  assert.equal(r.schema,'bd.retrieval-storage/1');assert.equal(r.basis,'sqlite_file_lengths_and_logical_contents');
  assert.ok(r.database.bytes>0);assert.ok(r.database.textBytes>0);assert.ok(r.database.segments>0);assert.ok(r.database.documents>0);assert.ok(r.database.indexVersions>0);
  assert.equal(r.policy.automaticDeletion,false);assert.deepEqual(await facts(h,input.materialId),before);
  await h.close();const db=new DatabaseSync(path);try{
   db.exec('UPDATE doc_segment_storage SET schema_version=0');const schema=db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
   h=await openFullChainHost(f,f.root);const old=await h.call('/retrieval/storage',undefined,409);assert.equal(old.code,'RETRIEVAL_STORAGE_SCHEMA_UNSUPPORTED');
   assert.equal(db.prepare('SELECT schema_version FROM doc_segment_storage').get()!.schema_version,0);assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),schema);
   db.exec('UPDATE doc_segment_storage SET schema_version=1');
  }finally{db.close();}
  const restored=await h.call('/retrieval/storage');assert.equal(restored.database.segments,r.database.segments);assert.deepEqual(await facts(h,input.materialId),before);
  const denied=await fetch(h.base+'/retrieval/storage',{headers:{'x-local-data-generation':'0'}});assert.equal(denied.status,409);
 }finally{await h.close();}
});
async function click(b:Browser,label:string){await b.until(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${q(label)}&&!e.disabled);if(!e)return false;e.click();return true;})()`,'Unavailable '+label);}
async function navigate(b:Browser,h:FullChainHost,en=false){await b.page('Page.navigate',{url:h.base.replace('/api/bd','/')});const name=en?'Database':'数据库';await b.until(`!!document.querySelector('button[aria-label='+${q(JSON.stringify(name))}+']')`,'Navigation unavailable');await b.evaluate(`document.querySelector('button[aria-label='+${q(JSON.stringify(name))}+']').click()`);await click(b,en?'Retrieval storage':'检索容量');await b.until(`!!document.querySelector(${q(panel)})`,'Storage view unavailable');}
async function settled(b:Browser){await b.until(`document.querySelector(${q(panel)})?.getAttribute('aria-busy')==='false'`,'Storage read pending');}
async function capture(b:Browser,root:string,name:string){await b.evaluate(`document.querySelector(${q(panel)}).scrollIntoView({block:'start'});`);await b.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const boxes=await b.evaluate<Array<{left:number;right:number;top:number;bottom:number;width:number;height:number}>>(`[document.querySelector(${q(panel)}),...document.querySelectorAll(${q(panel+' button')})].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}})`);assert.ok(Math.min(boxes[0]!.bottom,1100)>Math.max(boxes[0]!.top,0));for(const box of boxes)assert.ok(box.width>0&&box.left>=-2&&box.right<=392,JSON.stringify(box));writeFileSync(join(root,name+'.png'),Buffer.from((await b.page('Page.captureScreenshot',{format:'png'})).data,'base64'));}
test('actual retrieval storage UI reports measured usage and preserves private read-only boundaries',{skip:!(enabled&&program&&digest&&webRoot),timeout:180000},async()=>{
 assert.equal(wfdSha256(readFileSync(program!)),digest);const f=createFullChainFixture({name:'storage-ui'}),h=await openFullChainHost(f,webRoot!),visual=process.env.XUAN_STORAGE_VISUAL_ROOT??f.root;assert.ok(isAbsolute(visual));mkdirSync(visual,{recursive:true});let b:Browser|undefined;
 try{
  b=await openIsolatedBrowser(program!,f.root);await b.page('Emulation.setDeviceMetricsOverride',{width:390,height:1100,deviceScaleFactor:1,mobile:false});
  await b.page('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const native=window.fetch.bind(window);window.__storageMode='normal';window.fetch=async(...a)=>{const u=new URL(String(a[0]),location.href);if(u.pathname!=='/api/bd/retrieval/storage')return native(...a);if(window.__storageMode==='fail')return new Response(JSON.stringify({code:'EXPLICIT_TEST_503'}),{status:503,headers:{'Content-Type':'application/json'}});const r=await native(...a);if(window.__storageMode==='delay'){window.__storageWaiting=true;await new Promise(resolve=>window.__storageRelease=resolve);}return r;};})()`});
  await navigate(b,h);assert.equal(b.requests.filter(r=>new URL(r.url).pathname==='/api/bd/retrieval/storage').length,0);
  await click(b,'读取容量');await settled(b);await b.until(`!!document.querySelector(${q(panel+' [role=alert]')})&&!document.querySelector(${q(report)})`,'Cold store must be unavailable, not zero');await capture(b,visual,'storage-cold-zh-light');
  const input=await populate(h),before=await facts(h,input.materialId),r=await h.call('/retrieval/storage');
  await click(b,'读取容量');await settled(b);await b.until(`!!document.querySelector(${q(report)})`,'Actual report unavailable');await capture(b,visual,'storage-report-zh-light');
  const actual=await b.evaluate<Record<string,string>>(`Object.fromEntries([...document.querySelectorAll(${q(report+' .object-detail-facts > div')})].map(e=>[e.querySelector('dt').textContent,e.querySelector('dd').textContent]))`);
  for(const [label,key] of [['主数据库文件（字节）','bytes'],['WAL 文件（字节）','walBytes'],['片段正文逻辑字节','textBytes'],['FTS 索引页字节','ftsIndexBytes'],['文档版本数','documents'],['片段数','segments'],['索引版本数','indexVersions']])assert.equal(Number(actual[label!]!.replace(/,/g,'')),r.database[key!],label);
  assert.ok(r.database.documents>0);assert.equal(await b.evaluate(`document.querySelector(${q(panel)}).textContent.includes('provenance')`),false,'No document text in capacity report');
  await b.evaluate("window.__storageMode='delay';window.__storageWaiting=false");await click(b,'读取容量');await b.until('window.__storageWaiting===true','Response not held');await click(b,'工作台任务');await click(b,'检索容量');await b.evaluate("window.__storageMode='normal';window.__storageRelease()");await delay(200);assert.equal(await b.evaluate(`!!document.querySelector(${q(report)})`),false,'Unmounted response restored old capacity');
  await b.evaluate("window.__storageMode='fail'");await click(b,'读取容量');await settled(b);await b.until(`!!document.querySelector(${q(panel+' [role=alert]')})&&!document.querySelector(${q(report)})`,'503 displayed as zero');await capture(b,visual,'storage-error-zh-light');
  await b.evaluate(`(async()=>{const s=JSON.parse(sessionStorage.getItem('mashiro.local-data-generation'));const headers={'x-local-data-generation':String(s.generation),'x-mashiro-client':'web','Content-Type':'application/json'};const p=await(await fetch('/api/ui/preferences',{headers})).json();const r=await fetch('/api/ui/preferences',{method:'PUT',headers,body:JSON.stringify({revision:p.revision,language:'en',theme:'dark'})});if(!r.ok)throw Error('Preference update failed');})()`);
  await navigate(b,h,true);await click(b,'Read storage');await settled(b);await b.until(`!!document.querySelector(${q(report)})`,'English report unavailable');await capture(b,visual,'storage-report-en-dark');assert.deepEqual(await facts(h,input.materialId),before);
  // Real isolated lifecycle storage fault, not a user deactivation or permission grant.
  const life=new DatabaseSync(join(f.root,'lifecycle.sqlite'));try{life.exec('UPDATE local_data_lifecycle SET generation=2');}finally{life.close();}
  await click(b,'Read storage');await b.until(`!document.querySelector(${q(report)})`,'Old private storage survived generation invalidation');
  const denied=await fetch(h.base+'/retrieval/storage',{headers:{'x-local-data-generation':'1'}});assert.equal(denied.status,409);assert.equal((await denied.json()).code,'STALE_LOCAL_DATA_GENERATION');
  assert.equal(b.requests.filter(r=>new URL(r.url).pathname.startsWith('/api/bd/retrieval/')&&r.method!=='GET').length,0,'No index, cleanup, convert or rebuild command');assert.equal(b.blockedRequests.length,0);assert.equal(b.exceptions.length,0);
 }finally{await b?.close();await h.close();}
});
