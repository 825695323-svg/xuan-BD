import assert from 'node:assert/strict';
import { DatabaseSync, constants } from 'node:sqlite';
import test from 'node:test';
import { buildDocumentSegments } from './segments/segmenter.js';
import { UNKNOWN_TIME } from './segments/contracts.js';
import { syntheticPages } from './segments/fixture.js';
import { createCurrentIndexVersion, createIndexVersion, putDocumentSegments, rebuildSegmentFts, FTS_REBUILD_LIMITS, readSegment, searchSegments, putDocumentVersion, resolveVisibleVersions } from './segments/store.js';
function seed() {
  const db=new DatabaseSync(':memory:');
  const built=buildDocumentSegments({documentId:'isolated',documentVersion:'1',sourceRef:'synthetic-conversion',pages:syntheticPages()});
  putDocumentSegments(db,built.segments);const index=createCurrentIndexVersion(db);
  createIndexVersion(db,{indexVersion:'subset',segmentIds:[built.segments[1]!.segment_id]});
  putDocumentVersion(db,{document_id:'isolated',document_version:'1',parser_version:built.segments[0]!.parser_version,
    artifact_ref:'synthetic-conversion',artifact_sha256:'a'.repeat(64),origin_sha256:'b'.repeat(64),acquired_at:1,
    event_time:UNKNOWN_TIME,disclosed_at:UNKNOWN_TIME,parsed_at:2,page_count:2,segment_count:built.segments.length,issues:[]});
  return {db,built,index};
}
const metadata=(db:DatabaseSync)=>['doc_segments','doc_index_versions','doc_index_members','doc_segment_storage','doc_document_versions'].map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
test('explicit cache repair preserves evidence, subsets and all index identities; text corruption never returns excerpt',()=>{
  const {db,built,index}=seed();try{
    const saved=metadata(db),hits=searchSegments(db,{indexVersion:index.indexVersion,query:'先进封装'}),subset=searchSegments(db,{indexVersion:'subset',query:'先进封装'});
    const historical=resolveVisibleVersions(db,{indexVersion:index.indexVersion,asOf:3,mode:'system_held_at'});
    db.exec('DELETE FROM doc_segments_fts');assert.equal(searchSegments(db,{indexVersion:index.indexVersion,query:'先进封装'}).length,0);
    rebuildSegmentFts(db);assert.deepEqual(resolveVisibleVersions(db,{indexVersion:index.indexVersion,asOf:3,mode:'system_held_at'}),historical);assert.deepEqual(metadata(db),saved);assert.deepEqual(searchSegments(db,{indexVersion:index.indexVersion,query:'先进封装'}),hits);assert.deepEqual(searchSegments(db,{indexVersion:'subset',query:'先进封装'}),subset);
    const hit=hits[0]!.segment;db.prepare('UPDATE doc_segments SET text=? WHERE segment_id=?').run('tampered',hit.segment_id);
    assert.throws(()=>readSegment(db,hit.segment_id),/正文与冻结摘要/);assert.throws(()=>searchSegments(db,{indexVersion:index.indexVersion,query:'先进封装'}),/正文与冻结摘要/);
    assert.throws(()=>rebuildSegmentFts(db),/正文与冻结摘要/);db.prepare('UPDATE doc_segments SET text=? WHERE segment_id=?').run(hit.text,hit.segment_id);
    assert.deepEqual(searchSegments(db,{indexVersion:index.indexVersion,query:'先进封装'}),hits);
    db.prepare('DELETE FROM doc_segments WHERE segment_id=?').run(built.segments[0]!.segment_id);
    assert.throws(()=>rebuildSegmentFts(db),/存储头/);
  }finally{db.close();}
});
test('write interruption rolls back deletion; damaged storage head and membership cannot authorize repair',()=>{
 const {db,index}=seed();try{
  const hits=searchSegments(db,{indexVersion:index.indexVersion,query:'先进封装'}),saved=metadata(db);
  db.setAuthorizer((action,name)=> action===constants.SQLITE_INSERT&&name==='doc_segments_fts'?constants.SQLITE_DENY:constants.SQLITE_OK);
  assert.throws(()=>rebuildSegmentFts(db),/authorized/);db.setAuthorizer(null);
  assert.deepEqual(metadata(db),saved);assert.deepEqual(searchSegments(db,{indexVersion:index.indexVersion,query:'先进封装'}),hits);
  db.exec("UPDATE doc_index_versions SET segment_count=999 WHERE index_version='subset'");assert.throws(()=>rebuildSegmentFts(db),/成员计数/);
  db.exec("UPDATE doc_index_versions SET segment_count=1 WHERE index_version='subset'");
  db.exec("UPDATE doc_segment_storage SET content_digest='bad'");assert.throws(()=>rebuildSegmentFts(db),/存储头/);
 }finally{db.close();}
});

test('repair does not migrate old or missing-header stores, including before a failed repair',()=>{
 const {db}=seed();try{
  db.exec('UPDATE doc_segment_storage SET schema_version=0');
  const before=metadata(db),schema=db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  assert.throws(()=>rebuildSegmentFts(db),/旧格式或缺失存储头/);assert.deepEqual(metadata(db),before);assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),schema);
  db.exec('DROP TABLE doc_segment_storage');const missing=db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  assert.throws(()=>rebuildSegmentFts(db),/旧格式或缺失存储头/);assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),missing);
 }finally{db.close();}
});

test('cooperative time and declared text budgets refuse without changing the old cache',()=>{
 const {db,built,index}=seed();const now=Date.now;
 try{
  const before=searchSegments(db,{indexVersion:index.indexVersion,query:'先进封装'});let tick=0;
  Date.now=()=>++tick*(FTS_REBUILD_LIMITS.elapsedMs+1);
  assert.throws(()=>rebuildSegmentFts(db),/时间预算/);Date.now=now;
  assert.deepEqual(searchSegments(db,{indexVersion:index.indexVersion,query:'先进封装'}),before);
  db.prepare('UPDATE doc_segments SET text=? WHERE segment_id=?').run('x'.repeat(FTS_REBUILD_LIMITS.textBytes+1),built.segments[0]!.segment_id);
  const cacheCount=db.prepare('SELECT count(*) n FROM doc_segments_fts').get()!.n;
  assert.throws(()=>rebuildSegmentFts(db),/预算/);
  assert.equal(db.prepare('SELECT count(*) n FROM doc_segments_fts').get()!.n,cacheCount);
 }finally{Date.now=now;db.close();}
});
