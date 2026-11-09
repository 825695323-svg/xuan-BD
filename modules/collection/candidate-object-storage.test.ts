import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeCandidateSharing, migrateCandidateObjects } from './candidate-object-storage.js';

const legacy = 'CREATE TABLE candidate_objects(sha256 TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, bytes BLOB NOT NULL)';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test('legacy prepared reads and writes preserve exact bytes across candidate row sharing, reopen and idempotent migration', () => {
  const path = join(mkdtempSync(join(process.env.XUAN_TEST_ROOT ?? tmpdir(),'rows-')), 'core.sqlite');
  const old = new DatabaseSync(path), migrate = new DatabaseSync(path);
  try {
    old.exec(legacy);
    const insert = old.prepare('INSERT OR IGNORE INTO candidate_objects VALUES(?,?,?)');
    const select = old.prepare('SELECT bytes FROM candidate_objects WHERE sha256=?');
    const rows = ['复杂 "转义"\u0000'.repeat(6500)];
    const samples = [Buffer.from(JSON.stringify({kind:'parsed',rows})), Buffer.from(JSON.stringify({kind:'annotated',rows})),
      Buffer.from([0,255,17]), Buffer.alloc(0), Buffer.from('{"rows": [  "非规范内容"  ]}'), Buffer.from('{'.repeat(90000))];
    const put = (bytes:Buffer) => insert.run(hash(bytes),bytes.length,bytes);
    put(samples[0]!);
    assert.deepEqual(Buffer.from(select.get(hash(samples[0]!))!.bytes as Uint8Array),samples[0]);
    initializeCandidateSharing(migrate);
    assert.equal(migrate.prepare("SELECT type FROM sqlite_master WHERE name='candidate_objects'").get()!.type,'table');
    assert.equal(migrateCandidateObjects(migrate).objects,1);
    for (const sample of samples) put(sample);
    assert.equal(migrateCandidateObjects(migrate).migrated,false);
    assert.equal(old.prepare('SELECT count(*) AS n FROM candidate_row_blocks').get()!.n,1);
    const reopened = new DatabaseSync(path, {readOnly:true});
    try {
      for (const sample of samples) {
        assert.deepEqual(Buffer.from(select.get(hash(sample))!.bytes as Uint8Array),sample);
        assert.deepEqual(Buffer.from(reopened.prepare('SELECT bytes FROM candidate_objects WHERE sha256=?').get(hash(sample))!.bytes as Uint8Array),sample);
      }
    } finally {reopened.close();}
  } finally {old.close();migrate.close();}
});

test('migration rolls back all structure if a historical object fails its original digest', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(legacy);
    db.prepare('INSERT INTO candidate_objects VALUES(?,?,?)').run('invalid',1,Buffer.from('x'));
    assert.throws(()=>migrateCandidateObjects(db),/已签发摘要/u);
    assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name='candidate_objects'").get()!.type,'table');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='candidate_row_blocks'").get()!.n,0);
  } finally {db.close();}
});
