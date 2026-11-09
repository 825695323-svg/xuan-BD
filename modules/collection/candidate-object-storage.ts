import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// 旧进程继续使用原三列接口。每份加工证据保留独立的头尾和原始字节顺序，
// 仅共享在原字节中逐字找到的完整行数组。非规范或二进制对象仍整体存放。
const schema = `
CREATE TABLE candidate_row_blocks(id INTEGER PRIMARY KEY, body BLOB NOT NULL);
CREATE INDEX candidate_row_block_length ON candidate_row_blocks(length(body));
CREATE TABLE candidate_object_layouts(
 sha256 TEXT PRIMARY KEY, byte_length INTEGER NOT NULL, head BLOB NOT NULL,
 block_id INTEGER REFERENCES candidate_row_blocks(id), tail BLOB);
CREATE VIEW candidate_objects AS SELECT l.sha256,l.byte_length,
 CASE WHEN l.block_id IS NULL THEN l.head ELSE CAST(l.head || b.body || l.tail AS BLOB) END AS bytes
 FROM candidate_object_layouts l LEFT JOIN candidate_row_blocks b ON b.id=l.block_id;

-- 通过内部写视图传递已经抽取的数组，避免在拆分和查重的每一步重新解析整件 JSON。
CREATE VIEW candidate_row_input(sha256,byte_length,whole,body) AS SELECT NULL,NULL,NULL,NULL WHERE 0;
CREATE TRIGGER candidate_row_input_insert INSTEAD OF INSERT ON candidate_row_input BEGIN
 INSERT INTO candidate_row_blocks(body)
 SELECT NEW.body WHERE length(NEW.body)>=65536 AND substr(NEW.body,1,1)=X'5B' AND instr(NEW.whole,NEW.body)>0
 AND NOT EXISTS(SELECT 1 FROM candidate_row_blocks WHERE length(body)=length(NEW.body) AND body=NEW.body);
 INSERT INTO candidate_object_layouts(sha256,byte_length,head,block_id,tail)
 SELECT NEW.sha256,NEW.byte_length,
   CASE WHEN b.id IS NULL THEN NEW.whole ELSE substr(NEW.whole,1,instr(NEW.whole,b.body)-1) END,
   b.id,CASE WHEN b.id IS NOT NULL THEN substr(NEW.whole,instr(NEW.whole,b.body)+length(b.body)) END
 FROM (SELECT 1) LEFT JOIN candidate_row_blocks b
 ON length(b.body)=length(NEW.body) AND b.body=NEW.body AND instr(NEW.whole,b.body)>0;
END;
CREATE TRIGGER candidate_object_insert INSTEAD OF INSERT ON candidate_objects
WHEN NOT EXISTS(SELECT 1 FROM candidate_object_layouts WHERE sha256=NEW.sha256) BEGIN
 INSERT INTO candidate_row_input SELECT NEW.sha256,NEW.byte_length,NEW.bytes,
 CASE WHEN length(NEW.bytes)>=65536 AND substr(NEW.bytes,1,1)=X'7B' AND json_valid(CAST(NEW.bytes AS TEXT))
      THEN CAST(json_extract(CAST(NEW.bytes AS TEXT),'$.rows') AS BLOB) END;
END;`;

const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function relationType(db: DatabaseSync) {
  return db.prepare("SELECT type FROM sqlite_master WHERE name='candidate_objects'").get()?.type;
}

/** 只有空表在服务装配时升级。有业务数据的旧库须显式进入维护操作。 */
export function initializeCandidateSharing(db: DatabaseSync) {
  if (relationType(db) === 'table' && !db.prepare('SELECT 1 FROM candidate_objects LIMIT 1').get()) migrateCandidateObjects(db, true);
}

/** 原表和每一个已签发内容摘要在同一写事务中核对；失败回滚全部结构和对象。 */
export function migrateCandidateObjects(db: DatabaseSync, emptyOnly = false) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const type = relationType(db);
    if (type !== 'table' && !(type === 'view' && db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='candidate_object_insert'").get())) {
      throw new Error('未找到受支持的已登记候选对象存储。');
    }
    let objects = 0, bytes = 0;
    if (type === 'table' && emptyOnly && db.prepare('SELECT 1 FROM candidate_objects LIMIT 1').get()) {
      db.exec('COMMIT');
      return { migrated: false, objects, bytes };
    }
    if (type === 'table') {
      db.exec('ALTER TABLE candidate_objects RENAME TO candidate_objects_before_sharing');
      db.exec(schema);
      const insert = db.prepare('INSERT INTO candidate_objects VALUES(?,?,?)');
      const get = db.prepare('SELECT bytes FROM candidate_objects WHERE sha256=?');
      for (const row of db.prepare('SELECT sha256,byte_length,bytes FROM candidate_objects_before_sharing').iterate()) {
        const original = row.bytes;
        if (!(original instanceof Uint8Array) || original.length !== row.byte_length || sha256(original) !== row.sha256) throw new Error('旧候选对象的字节与已签发摘要不符。');
        insert.run(row.sha256, row.byte_length, original);
        const stored = get.get(row.sha256)?.bytes;
        if (!(stored instanceof Uint8Array) || !Buffer.from(original.buffer, original.byteOffset, original.byteLength).equals(stored)) throw new Error('新布局未能逐字还原候选对象。');
        objects++; bytes += original.length;
      }
      db.exec('DROP TABLE candidate_objects_before_sharing');
    }
    db.exec('COMMIT');
    return { migrated: type === 'table', objects, bytes };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
