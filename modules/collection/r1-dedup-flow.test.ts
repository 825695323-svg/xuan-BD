import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { CoreDatabase } from '../../platform/state/database.js';
import { wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { R1ChunkedCsvService } from './r1-chunked-csv.js';

// Two tiny already-frozen parser pages exercise the journal transition, not parser capacity.
for (const legacy of [false,true]) test(`CSV ${legacy?'legacy':'new'} journal continues beyond a conflict page and keeps pending pages without retrying`,async()=>{
  const database=new CoreDatabase(),bytes=Buffer.from('synthetic complete original');let starts=0;
  const connection={connectionId:'isolated',profile:'data_only',namespace:'isolated'};
  const views=new Map([['page-auto-0',{state:'conflicts_pending',currentRequest:{rowCount:2,rowSummary:{inserted:1,duplicate_skipped:0,conflict_pending:1}},error:null}],
    ['page-auto-1',{state:'associated',currentRequest:{rowCount:2,rowSummary:{inserted:1,duplicate_skipped:1,conflict_pending:0}},error:null}]]);
  const service=new R1ChunkedCsvService({database,tasks:()=>({getControl:()=>({generation:0,stopped:false})}) as never,
    materials:{} as never,auto:{get:(id:string)=>views.get(id),start:(input:{requestId:string})=>{starts++;return views.get(input.requestId);}} as never,
    connection:()=>connection as never,accept:async()=>{throw Error('Already frozen pages must not create another original');}});
  try{
    service.start({intakeId:'two-small-pages',name:'small.csv',sha256:wfdSha256(bytes),byteLength:bytes.length,datasetId:'isolated',
      source:{source_id:'synthetic',provider:'test',requested_url:'https://fixture.example.test/test.csv',requested_at_utc:'2026-01-02T00:00:00Z',acquired_at_utc:'2026-01-03T00:00:00Z',usage_scope:'isolated test',authorization:{status:'authorized',basis:'explicit synthetic unit test'}}},{requestId:'test'} as never);
    const record=JSON.parse(String(database.connection.prepare('SELECT record_json FROM r1_csv_intakes').get()!.record_json));
    if(legacy)delete record.rowSummary;
    Object.assign(record,{receivedBytes:bytes.length,custodyTaskId:'original-task',materialId:'original',parsed:true,totalRows:4,totalPages:2,state:'publishing'});
    database.connection.prepare('UPDATE r1_csv_intakes SET record_json=?').run(JSON.stringify(record));
    for(let ordinal=0;ordinal<2;ordinal++){
      const page={ordinal,rowStart:ordinal*2+1,rowEnd:ordinal*2+2,byteStart:ordinal,byteEnd:ordinal+1,sha256:wfdSha256(bytes),byteLength:bytes.length,
        locations:[],classification:null,custodyTaskId:'page-task-'+ordinal,materialId:'page-material-'+ordinal,autoRequestId:'page-auto-'+ordinal,auto:null};
      database.connection.prepare('INSERT INTO r1_csv_pages VALUES(?,?,?,?)').run('two-small-pages',ordinal,JSON.stringify(page),bytes);
    }
    await service.advance('two-small-pages');await nextTurn();await nextTurn();
    const completed=service.get('two-small-pages');
    assert.equal(completed.state,'conflicts_pending');assert.equal(completed.processedPages,2);assert.equal(completed.processedRows,4);
    assert.deepEqual(completed.rowSummary,{inserted:2,duplicate_skipped:1,conflict_pending:1});assert.equal(completed.publishedRows,2);
    assert.deepEqual(completed.conflictPages,[{ordinal:0,rowStart:1,rowEnd:2,autoRequestId:'page-auto-0',conflictCount:1}]);
    assert.equal(completed.activePage,null);assert.equal(starts,2);
    await service.advance('two-small-pages');await nextTurn();assert.equal(starts,2);
  }finally{await service.dispose();database.close();}
});
