import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { wfdSha256, type WfdRecord } from '../../adapters/database/wfd-transport.js';
import type { R1BatchStartInput, R1BatchView } from '../../modules/collection/r1-auto-batch.js';
import type { R1ChunkedCsvView } from '../../modules/collection/r1-chunked-csv.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT;
const source: R1BatchStartInput['source'] = { source_id: 'production-batch-fixture', provider: 'isolated fixture',
  requested_url: 'file:///explicit-selected-observations', requested_at_utc: '2026-01-01T00:00:00Z', acquired_at_utc: '2026-01-10T00:00:00Z',
  usage_scope: 'isolated continuous batch verification', authorization: { status: 'authorized', basis: 'explicit isolated batch and correction verification' } };
const binaryHeaders = { 'Content-Type': 'application/octet-stream', 'x-mashiro-client': 'web' };
async function wait<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let tries=0;tries<6000;tries++) { const value=await read();if(done(value))return value;await delay(50); }
  assert.fail('Production batch did not reach the expected state: '+JSON.stringify(await read()));
}
async function binary(host:FullChainHost,path:string,bytes:Buffer,status=202) {
  const response=await fetch(host.base+path,{method:'POST',headers:binaryHeaders,body:new Uint8Array(bytes)});
  const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
}

test('automatic later batches publish source rows and keep conflicting observations pending', {skip:!enabled,timeout:600000},async()=>{
  const fixture=createFullChainFixture({name:'continuous-source-batches',machine:true,units:{date:{dimension:'date'},cny_per_share:{dimension:'money_per_share'}}});
  let host=await openFullChainHost(fixture);
  try {
    const results:R1BatchView[]=[];
    for (const [index,rows] of [ [['20260101','1'],['20260102','2']], [['20260103','3'],['20260104','4']], [['20260102','20']] ].entries()) {
      const bytes=Buffer.from('交易日期,股票代码,股票名称,收盘价（元）\n'+rows.map(([date,value])=>`${date},000001,原报证券,${value}`).join('\n')+'\n');
      const batchId='series-'+index,input:R1BatchStartInput={batchId,source,datasetId:'series',datePolicy:'a_share_calendar_day_asia_shanghai',
        files:[{name:`part-${index}.csv`,relativePath:`part-${index}.csv`,byteLength:bytes.length,sha256:wfdSha256(bytes)}]};
      await host.call('/r1/batches/start',input,202);await binary(host,`/r1/batches/${batchId}/items/item-1/upload`,bytes);
      const view=await wait(()=>host.call('/r1/batches/'+batchId) as unknown as Promise<R1BatchView>,view=>{
        assert.equal(view.error,null,JSON.stringify(view));
        assert.ok(view.items.every(item=>item.state!=='blocked'),JSON.stringify(view));
        // 第三批与已发布内容冲突时按既定路径转正式更正入口，不在自动批次里静默
        // 更正；此处置于冲突态是本测试的预期结果。
        return view.state==='completed'||view.state==='conflicts_pending';
      });results.push(view);
      if(index===0) {await host.close();host=await openFullChainHost(fixture);}
    }
    assert.equal(results[2]!.state,'conflicts_pending',JSON.stringify(results[2]));
    assert.equal(results[2]!.items[0]!.state,'conflicts_pending',JSON.stringify(results[2]!.items[0]));
    assert.equal((results[2]!.items[0]!.auto!.currentRequest!.rowSummary as unknown as WfdRecord).conflict_pending,1);
    const count=host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get();
    await host.close();host=await openFullChainHost(fixture);
    const reopened=await host.call('/r1/batches/series-2');assert.equal(reopened.state,'conflicts_pending');
    assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get(),count);
    const final = (results[1]!.items[0]!.auto!.currentRequest!.local.associations as WfdRecord[])[0]!;
    const read = await host.call('/r1/products/read', { snapshotId: final.snapshot_id, productId: final.product_id });
    assert.equal(read.result.rows.length, 4);
    writeFileSync(join(fixture.root, 'continuous-batches-proof.json'), JSON.stringify({ results, read }, null, 2));
  } finally {await host.close();}
});

test('chunked CSV receipts resume exact offsets, parse all multiline records and publish every frozen page through real R1', {skip:!enabled,timeout:600000},async()=>{
  const fixture=createFullChainFixture({name:'chunked-csv-r1',machine:true,units:{date:{dimension:'date'},cny_per_share:{dimension:'money_per_share'}}});
  let host=await openFullChainHost(fixture);
  try {
    const bytes=Buffer.from('交易日期,股票代码,股票名称,收盘价（元）\r\n'+Array.from({length:403},(_,index)=>`20260101,${String(index).padStart(6,'0')},"名称\r\n${index}",${index}.12345678\r\n`).join(''));
    const input={intakeId:'chunked-resume',name:'all.csv',sha256:wfdSha256(bytes),byteLength:bytes.length,source:{...source,requested_url:'file:///explicit-selected-observations/all.csv'},datasetId:'chunked',datePolicy:'a_share_calendar_day_asia_shanghai'};
    await host.call('/r1/batches/chunked/start',input,202);
    await binary(host,'/r1/batches/chunked/chunked-resume/chunks/0',bytes.subarray(0,113));
    host.services.r1Batches!.chunked.sweepTemporaryChunks(Date.now()+4*24*60*60*1000);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_csv_upload_chunks').get()!.n,1, 'Incomplete originals retain their transport for recovery');
    assert.equal((await host.call('/r1/batches/chunked/chunked-resume/advance',{},409)).code,'R1_CSV_INCOMPLETE');
    await host.close();host=await openFullChainHost(fixture);
    assert.equal((await host.call('/r1/batches/chunked/chunked-resume')).receivedBytes,113);
    await binary(host,'/r1/batches/chunked/chunked-resume/chunks/0',bytes.subarray(0,113));
    assert.equal((await binary(host,'/r1/batches/chunked/chunked-resume/chunks/0',Buffer.from('wrong'),409)).code,'R1_CSV_CHUNK_CONFLICT');
    await binary(host,'/r1/batches/chunked/chunked-resume/chunks/113',bytes.subarray(113));
    await host.call('/r1/batches/chunked/chunked-resume/advance',{},202);
    const result=await wait(()=>host.call('/r1/batches/chunked/chunked-resume') as unknown as Promise<R1ChunkedCsvView>,view=>{
      assert.equal(view.error,null,JSON.stringify(view));return view.state==='completed';
    });
    assert.equal(result.parsed,true);assert.equal(result.totalRows,403);assert.equal(result.publishedRows,403);
    assert.equal(result.totalPages,3);assert.equal(result.publishedPages,3);
    assert.deepEqual(host.services.materials!.readOriginal(result.materialId!).bytes,bytes);
    const pages=Array.from({length:3},(_,ordinal)=>host.services.r1Batches!.chunked.readPage(input.intakeId,ordinal));
    let prior=bytes.indexOf(Buffer.from('\r\n'))+2;
    for(const {page,bytes:part} of pages) {
      assert.equal(page.byteStart,prior);assert.equal(wfdSha256(part),page.sha256);
      assert.deepEqual(part.subarray(part.indexOf(Buffer.from('\r\n'))+2),bytes.subarray(page.byteStart,page.byteEnd));
      for(const location of page.locations) {
        const raw=bytes.subarray(location.byteStart,location.byteEnd).toString();
        assert.ok(raw.includes('名称\r\n'));assert.equal(location.lineEnd,location.lineStart+1);
      }
      assert.equal(page.auto!.state,'associated');prior=page.byteEnd;
    }
    assert.equal(prior,bytes.length);
    const final=pages.at(-1)!.page.auto!.currentRequest!.local.associations as WfdRecord[];
    const snapshotId=final[0]!.snapshot_id,productId=final[0]!.product_id;
    const rows:WfdRecord[]=[];let cursor:string|undefined;
    do {const value=await host.call('/r1/products/read',{snapshotId,productId,...(cursor?{cursor}:{})});rows.push(...value.result.rows);cursor=value.result.page.has_more?value.result.page.next_cursor:undefined;}while(cursor);
    assert.equal(rows.length,403);
    await host.close();host=await openFullChainHost(fixture);
    assert.equal((await host.call('/r1/batches/chunked/chunked-resume')).publishedRows,403);
    const retention=host.database.connection.prepare('SELECT * FROM r1_csv_transport_retention WHERE intake_id=?').get(input.intakeId)!;
    assert.equal(Number(retention.expires_at)-Number(retention.released_at),3*24*60*60*1000);
    assert.equal(host.services.r1Batches!.chunked.sweepTemporaryChunks(Number(retention.expires_at)-1).removed,0);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_csv_upload_chunks').get()!.n,2);
    assert.equal(host.services.r1Batches!.chunked.sweepTemporaryChunks(Number(retention.expires_at)).removed,1);
    assert.equal(host.database.connection.prepare('SELECT count(*) AS n FROM r1_csv_upload_chunks').get()!.n,0);
    assert.deepEqual(host.services.materials!.readOriginal(result.materialId!).bytes,bytes);
    assert.deepEqual(host.services.r1Batches!.chunked.readPage(input.intakeId,0).bytes,pages[0]!.bytes);
    const attempts=host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get();
    await host.close();host=await openFullChainHost(fixture);
    assert.equal((await host.call('/r1/batches/chunked/chunked-resume')).publishedRows,403);
    assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get(),attempts);
    writeFileSync(join(fixture.root,'chunked-complete-proof.json'),JSON.stringify({input,result,pages:pages.map(({page})=>page),fixedRows:rows,retention,transportExpiredAndOriginalReopened:true},null,2));
  } finally {await host.close();}
});

test('minute batches preserve source row versions and keep overlapping observations pending', {skip:!enabled,timeout:600000},async()=>{
  const fixture=createFullChainFixture({name:'continuous-minute-batches',machine:true,units:{date:{dimension:'date'},cny_per_share:{dimension:'money_per_share'}}});
  let host=await openFullChainHost(fixture);
  try {
    const results:R1BatchView[]=[];
    for(const [index,rows] of [[['09:30','1'],['09:31','2']],[['09:32','3'],['09:33','4']],[['09:31','20']]].entries()) {
      const bytes=Buffer.from('交易日期,股票代码,股票名称,分钟时间,收盘价（元）\n'+rows.map(([minute,value])=>`20260101,000001,原报证券,2026-01-01 ${minute}:00,${value}`).join('\n')+'\n');
      const batchId='minute-series-'+index,input:R1BatchStartInput={batchId,source,datasetId:'minute_series',datePolicy:'a_share_calendar_day_asia_shanghai',
        files:[{name:`minute-${index}.csv`,relativePath:`minute-${index}.csv`,byteLength:bytes.length,sha256:wfdSha256(bytes)}]};
      await host.call('/r1/batches/start',input,202);await binary(host,`/r1/batches/${batchId}/items/item-1/upload`,bytes);
      results.push(await wait(()=>host.call('/r1/batches/'+batchId) as unknown as Promise<R1BatchView>,view=>{
        assert.equal(view.error,null,JSON.stringify(view));assert.ok(view.items.every(item=>item.state!=='blocked'),JSON.stringify(view));
        return view.state === 'completed' || view.state === 'conflicts_pending';
      }));
      if(index===0){await host.close();host=await openFullChainHost(fixture);}
    }
    assert.equal(results[2]!.state, 'conflicts_pending');
    assert.equal(results[2]!.items[0]!.state, 'conflicts_pending');
    const final = (results[1]!.items[0]!.auto!.currentRequest!.local.associations as WfdRecord[])[0]!;
    const read = await host.call('/r1/products/read', { snapshotId: final.snapshot_id, productId: final.product_id });
    assert.equal(read.result.rows.length, 4);
    const attempts=host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get();
    await host.close();host=await openFullChainHost(fixture);
    assert.equal((await host.call('/r1/batches/minute-series-2')).state,'conflicts_pending');
    assert.deepEqual(host.database.connection.prepare('SELECT count(*) AS n FROM r1_handoff_attempts').get(),attempts);
    writeFileSync(join(fixture.root,'minute-continuation-proof.json'),JSON.stringify({results,read},null,2));
  }finally{await host.close();}
});
