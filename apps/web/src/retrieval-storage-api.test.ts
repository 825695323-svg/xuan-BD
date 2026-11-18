import assert from 'node:assert/strict';
import test from 'node:test';
import { storageView } from './retrieval-storage-api.js';
function fixture(): any { return {schema:'bd.retrieval-storage/1',basis:'sqlite_file_lengths_and_logical_contents',database:{bytes:100,walBytes:50,segments:1,documents:1,indexVersions:1,textBytes:20,ftsTokenBytes:0,ftsIndexBytes:80,indexMembershipRows:1,sharedIndexVersions:0,oldestParsedAt:10,newestParsedAt:20,file:'/private/must-not-project',pages:999},policy:{scope:'bd-retrieval-workspace',automaticDeletion:false,rebuildable:{segments:false,index:true},notes:['not trusted for UI']}}; }
test('storage projection preserves separate byte meanings and omits raw paths and legacy page counts',()=>{
 const view=storageView(fixture());assert.equal(view.bytes,100);assert.equal(view.walBytes,50);assert.equal(view.textBytes,20);assert.equal(view.ftsIndexBytes,80);
 assert.equal('file' in view,false);assert.equal('pages' in view,false);assert.equal('policy' in view,false);
});
test('unknown malformed counts and retention semantics cannot become zero or cleanup permission',()=>{
 for(const change of [(x:any)=>delete x.database.bytes,(x:any)=>x.database.walBytes=-1,(x:any)=>x.database.textBytes=0.5,(x:any)=>x.database.oldestParsedAt=30,(x:any)=>x.database.newestParsedAt=Number.MAX_SAFE_INTEGER,(x:any)=>x.database.oldestParsedAt=null,(x:any)=>x.policy.automaticDeletion=true,(x:any)=>x.policy.rebuildable.segments=true,(x:any)=>x.schema='unknown']){const x=fixture();change(x);assert.throws(()=>storageView(x));}
 const x=fixture();x.database.oldestParsedAt=null;x.database.newestParsedAt=null;assert.equal(storageView(x).oldestParsedAt,null);
});
