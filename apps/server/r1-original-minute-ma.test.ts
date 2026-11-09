import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalWfdJson } from '../../adapters/database/wfd-transport.js';
import { createFullChainFixture, openFullChainHost, type FullChainHost } from './full-chain-test-support.js';

type Json = Record<string, any>;
const enabled = !!process.env.WFD_PYTHON && !!process.env.XUAN_FULL_CHAIN_ROOT && !!process.env.XUAN_MINUTE_ORACLE;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const code = (column:string) => 'src_'+Buffer.from(column).toString('base64url');
const save = (root:string,name:string,value:unknown) => writeFileSync(join(root,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const decimal = (value:string) => {
  const [integer,fraction='']=value.split('.'), tail=fraction.replace(/0+$/u,'');
  return integer+(tail ? '.'+tail : '');
};
async function until(host:FullChainHost,batchId:string,predicate:(value:Json)=>boolean) {
  for(let count=0;count<4800;count++) {
    const value=await host.call('/r1/batches/'+batchId);
    assert.equal(value.error,null,JSON.stringify(value));
    assert.ok(value.items.every((item:Json)=>item.state!=='blocked'),JSON.stringify(value));
    assert.ok(value.calculations.every((item:Json)=>item.state!=='blocked'),JSON.stringify(value));
    if(predicate(value)) return value as Json;
    if(value.state==='awaiting_answers') assert.fail('受控原报分钟材料出现未处理缺项：'+JSON.stringify(value.items.map((item:Json)=>item.auto?.questions)));
    await delay(25);
  }
  assert.fail('分钟批次未收束：'+JSON.stringify(await host.call('/r1/batches/'+batchId)));
}
async function read(host:FullChainHost,snapshotId:string,productId:string) {
  const pages:Json[]=[]; let cursor:string|undefined;
  do {
    const reply=await host.call('/r1/products/read',{snapshotId,productId,...(cursor ? {cursor} : {})});
    assert.equal(reply.result.snapshot_id,snapshotId); assert.equal(reply.result.product_id,productId);
    pages.push(reply.result); cursor=reply.result.page.has_more ? reply.result.page.next_cursor : undefined;
    assert.ok(!reply.result.page.has_more || cursor);
  } while(cursor);
  return {pages,rows:pages.flatMap(page=>page.rows) as Json[]};
}

test('real selected minute rows use saved automatic routing, publish distinct source and minute MA, and retain fixed readback after reopening',
  {skip:!enabled,timeout:600_000},async()=>{
    const oracleBytes=readFileSync(process.env.XUAN_MINUTE_ORACLE!),oracle=JSON.parse(oracleBytes.toString()) as Json;
    assert.equal(oracle.oracleVersion,'independent-python-csv-fraction-minute-ma/1');
    assert.equal(oracle.selection.rows,482); assert.equal(oracle.original.preservedColumns.length,11);
    const fullOriginal=readFileSync(oracle.original.path),bytes=readFileSync(oracle.file.path);
    assert.equal(fullOriginal.length,oracle.original.bytes); assert.equal(sha(fullOriginal),oracle.original.sha256);
    assert.equal(bytes.length,oracle.file.byteLength); assert.equal(sha(bytes),oracle.file.sha256);
    const rawOrder=[...oracle.observations].sort((a:Json,b:Json)=>a.byteStart-b.byteStart);
    assert.deepEqual(bytes,Buffer.concat([fullOriginal.subarray(0,oracle.original.headerBytes),
      ...rawOrder.map((row:Json)=>{
        const raw=fullOriginal.subarray(row.byteStart,row.byteEnd); assert.equal(sha(raw),row.rawRowSha256); return raw;
      })]),'所有选择行保留原包全11列原始字节');
    const fixture=createFullChainFixture({name:'original-minute-ma',machine:true,
      units:{date:{dimension:'date'},srcunit_5YWD:{dimension:'number'}}});
    let host=await openFullChainHost(fixture);
    const batchId='real-selected-minute-automatic-ma',stamp=new Date().toISOString();
    let sourceRows:Json[]=[],derivedRows:Json[]=[],proof:Json={},completed:Json={},settings:Json={},input:Json={};
    try {
      const initial=await host.call('/r1/batches/algorithm-settings');
      assert.deepEqual(initial,{revision:0,dailyPeriod:null,minutePeriod:null});
      const settingsResponse=await fetch(host.base+'/r1/batches/algorithm-settings',{method:'PUT',
        headers:{'Content-Type':'application/json','x-mashiro-client':'web'},
        body:JSON.stringify({...initial,minutePeriod:oracle.period})});
      settings=await settingsResponse.json() as Json; assert.equal(settingsResponse.status,200,JSON.stringify(settings));
      const classifiedResponse=await fetch(host.base+'/r1/batches/classify',{method:'POST',
        headers:{'Content-Type':'application/octet-stream','x-mashiro-client':'web'},body:new Uint8Array(bytes)});
      const classification=await classifiedResponse.json() as Json; assert.equal(classifiedResponse.status,200,JSON.stringify(classification));
      assert.equal(classification.kind,'minute_bar'); assert.equal(classification.complete,true);
      assert.equal(classification.rowCount,482); assert.equal(classification.minuteColumn,'分钟时间');
      assert.equal(classification.sha256,sha(bytes));
      input={batchId,datasetId:'real_selected_minute_observations',datePolicy:'a_share_calendar_day_asia_shanghai',
        sourceValueColumns:oracle.sourceValueColumns,
        source:{source_id:'user-selected-minute-original-row-slice',provider:'余哈哈的数据仓库 原创整理；本轮明确原行选择',
          requested_url:pathToFileURL(oracle.selectionRoot+'/').href,requested_at_utc:stamp,acquired_at_utc:stamp,
          usage_scope:'真实分钟原报选择与三观测均线隔离验收；不认领整包接入、标签起止、交易分钟完整性、复权或历史可得性',
          authorization:{status:'authorized',basis:'用户授权本轮真实原件只读选行并在全新隔离状态验证分类算法；保留全11列原行字节与原件摘要'}},
        algorithmRouting:{version:'bd.r1-algorithm-routing/1',settings,files:[classification]},
        files:[Object.fromEntries(['name','relativePath','sha256','byteLength'].map(key=>[key,oracle.file[key]]))]};
      save(fixture.root,'run-context.json',{input,fixture,oraclePath:process.env.XUAN_MINUTE_ORACLE,oracleSha256:sha(oracleBytes),
        original:{bytes:oracle.original.bytes,sha256:oracle.original.sha256},selectedRows:482,selectedOriginalColumns:11,
        node:process.execPath,nodeVersion:process.version,python:process.env.WFD_PYTHON});
      await host.call('/r1/batches/start',input,202);
      const pending=await until(host,batchId,value=>!!value.nextUploadItemId);
      const upload=await fetch(`${host.base}/r1/batches/${batchId}/items/${pending.nextUploadItemId}/upload`,{method:'POST',
        headers:{'Content-Type':'application/octet-stream','x-mashiro-client':'web'},body:new Uint8Array(bytes)});
      assert.equal(upload.status,202,JSON.stringify(await upload.json()));
      completed=await until(host,batchId,value=>value.state==='completed');
      assert.equal(completed.items.length,1); assert.equal(completed.items[0].state,'associated');
      assert.equal(completed.calculations.length,1);
      const calculation=completed.calculations[0]; assert.equal(calculation.kind,'minute_bar'); assert.equal(calculation.state,'associated');
      assert.deepEqual(calculation.selection,{method:'source_observation_ma',period:3,valueColumn:'收盘价（元）'});
      assert.equal(host.services.materials!.readOriginal(completed.items[0].materialId).sha256,sha(bytes));
      const sourceRef=completed.items[0].auto.currentRequest.local.associations[0];
      assert.notEqual(sourceRef.product_id,calculation.productId);
      const sourceRead=await read(host,sourceRef.snapshot_id,sourceRef.product_id),derivedRead=await read(host,calculation.snapshotId,calculation.productId);
      sourceRows=sourceRead.rows; derivedRows=derivedRead.rows;
      assert.equal(sourceRows.length,482); assert.equal(derivedRows.length,482);
      assert.ok(sourceRead.pages.length>1); assert.ok(derivedRead.pages.length>1);
      const response=await host.call(`/r1/batches/${batchId}/calculation-evidence?calculationId=${calculation.calculationId}`);
      proof=response.proof; assert.equal(proof.version,'bd.source-observation-ma-proof/2');
      assert.equal(proof.methodVersion,'1.1.0'); assert.equal(proof.minuteColumn,'分钟时间');
      assert.equal(proof.minuteLabelMeaning,'unknown'); assert.equal(proof.sessionContinuity,'not_asserted');
      assert.equal(proof.historicalAvailability,'unknown'); assert.equal(proof.priceBasis,'source_reported_unverified');
      assert.deepEqual(proof.groupColumns,['证券代码']);
      assert.deepEqual(proof.counts,{rows:482,groups:2,valid:478,warmup:4,windowMissing:0});
      assert.equal(sha(canonicalWfdJson(proof)),calculation.proof.proofSha256);
      const sourceByKey=new Map(sourceRows.map(row=>[row.record_ref.logical_key,row]));
      const derivedByKey=new Map(derivedRows.map(row=>[row.record_ref.logical_key,row]));
      const expectedByKey=new Map<string,Json>();
      for(const expected of oracle.observations) expectedByKey.set('source_row_'+sha(canonicalWfdJson([expected.date,expected.minute,expected.symbol])),expected);
      const text=bytes.toString('utf8').replace(/^\uFEFF/u,'');
      for(const row of proof.lineage) {
        const expected=expectedByKey.get(row.businessKey)!; assert.ok(expected,row.businessKey);
        const original=sourceByKey.get(row.businessKey)!,derived=derivedByKey.get(row.businessKey)!;
        assert.equal(row.minute,expected.minute.replace(' ','T')); assert.equal(row.inputValue,expected.close);
        assert.equal(row.status,expected.status); assert.equal(row.value,expected.value);
        assert.equal(text.slice(row.location.start,row.location.end),expected.close);
        const originalIndex=rawOrder.findIndex((entry:Json)=>entry.sourceRow===expected.sourceRow);
        assert.equal(row.sourceRow,originalIndex+1); assert.equal(row.location.line,originalIndex+2);
        assert.equal(original.values[code('证券代码')].value,expected.symbol);
        assert.equal(original.values[code('交易日期')].value,expected.date);
        assert.equal(original.values[code('分钟时间')].value,expected.minute);
        assert.equal(decimal(original.values[code('收盘价（元）')].value),decimal(expected.close));
        assert.equal(original.record_ref.revision_id,row.recordVersion);
        assert.equal(Date.parse(original.business_time.earliest_utc),Date.parse(expected.minute.replace(' ','T')+'+08:00'));
        assert.equal(Date.parse(original.business_time.latest_exclusive_utc)-Date.parse(original.business_time.earliest_utc),60_000);
        assert.equal(derived.business_time.precision,'minute');
        assert.equal(derived.values.calculation_status.value,expected.status);
        assert.equal(derived.values.value.value_state,expected.status==='valid' ? 'valid_value' : 'unknown');
        assert.equal(derived.values.value.value===null ? null : decimal(derived.values.value.value),expected.value===null ? null : decimal(expected.value));
        const window=proof.lineage.slice(row.windowStart,row.windowStart+row.windowCount);
        assert.deepEqual(window.map((item:Json)=>expectedByKey.get(item.businessKey)!.sourceRow),expected.windowSourceRows);
        assert.ok(window.every((item:Json)=>item.groupValues[0]===expected.symbol));
      }
      const discovered=await host.call('/r1/products/discover',{snapshotId:calculation.snapshotId});
      const derivative=discovered.products.find((product:Json)=>product.product_id===calculation.productId);
      const context=discovered.products.find((product:Json)=>product.product_id===sourceRef.product_id)?.declaration.semantic_context;
      assert.ok(context); assert.equal(context.time.frequency,'source_reported_minute');
      assert.equal(context.time.roles.business_interval,'minute_label_bucket_not_verified_bar_interval');
      assert.equal(context.time.roles.minute_label_meaning,'unknown');
      assert.ok(derivative); assert.equal(derivative.declaration.algorithm_definition.definition_version,'1.1.0');
      assert.equal(derivative.declaration.semantic_context.time.frequency,'source_reported_minute');
      assert.match(derivative.declaration.algorithm_definition.result_semantics,/标签起止含义未知/);
      for(const page of [...sourceRead.pages,...derivedRead.pages])
        assert.deepEqual(Object.keys(page.product.contract_role_refs).sort(),['algorithm_dependency','read_layout','semantic','update_release']);
      save(fixture.root,'fixed-source-read.json',sourceRead); save(fixture.root,'fixed-derived-read.json',derivedRead);
      save(fixture.root,'calculation-proof.json',proof); save(fixture.root,'completed-batch.json',completed);
      save(fixture.root,'product-contracts.json',{sourceContext:context,derivative});
      await host.close(); host=await openFullChainHost(fixture);
      let sends=0; const submit=host.services.r1Runtime!.client.submit.bind(host.services.r1Runtime!.client);
      host.services.r1Runtime!.client.submit=async(...args)=>{sends++;return submit(...args);};
      assert.deepEqual(await host.call('/r1/batches/algorithm-settings'),settings);
      const replay=await host.call('/r1/batches/start',input,202); assert.equal(replay.duplicateBatch,true);
      const reopened=await until(host,batchId,value=>value.state==='completed');
      assert.deepEqual(reopened.calculations[0].proof,completed.calculations[0].proof);
      assert.deepEqual((await read(host,calculation.snapshotId,calculation.productId)).rows,derivedRows);
      assert.equal(sends,0,'完成批次重开和重复确认不会重新发布');
      save(fixture.root,'verified.json',{passed:true,selectedRows:482,originalColumnsPreserved:11,publishedSourceFields:4,
        groups:2,period:3,validMeans:478,warmupUnknowns:4,sourcePages:sourceRead.pages.map(page=>page.rows.length),derivedPages:derivedRead.pages.map(page=>page.rows.length),
        independentOracleSha256:sha(oracleBytes),originalSha256:oracle.original.sha256,selectedMaterialSha256:sha(bytes),
        sourceProductId:sourceRef.product_id,sourceSnapshotId:sourceRef.snapshot_id,derivedProductId:calculation.productId,
        derivedSnapshotId:calculation.snapshotId,proofSha256:sha(canonicalWfdJson(proof)),reopenedSubmitCalls:sends,
        fullPackageIngested:false,minuteLabelMeaning:'unknown',sessionCompleteness:'unknown',historicalAvailability:'unknown'});
    } finally {await host.close();}
  });
