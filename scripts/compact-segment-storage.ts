/** 显式既有片段库压缩；默认只读预览，不发现运行根、不创建数据库。 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ensureSegmentSchema, segmentStorage } from '../modules/collection/segments/store.js';

function inspect(db: DatabaseSync) {
  for (const name of ['doc_segments', 'doc_segments_fts', 'doc_index_versions', 'doc_index_members']) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name=? AND type='table'").get(name))
      throw new Error(`所选既有库缺少 ${name}，不会初始化或改写。`);
  }
  const check = db.prepare('PRAGMA quick_check').get();
  if (check?.quick_check !== 'ok') throw new Error('所选既有片段库未通过 SQLite 完整性核对。');
  const count = (table: string) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
  const fts = db.prepare("SELECT sql FROM sqlite_schema WHERE name='doc_segments_fts'").get();
  return { segments: count('doc_segments'), indexVersions: count('doc_index_versions'),
    membershipRows: count('doc_index_members'), ftsStoresContent: !/contentless_delete\s*=\s*1/iu.test(String(fts?.sql ?? '')) };
}

export function compactSegmentStorage(options: { databasePath: string; apply?: boolean; vacuum?: boolean }) {
  const path = options.databasePath;
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path || !lstatSync(path).isFile())
    throw new Error('需要明确选择已存在、无符号链接的片段数据库绝对路径。');
  if (options.vacuum && !options.apply) throw new Error('--vacuum 须同时显式指定 --apply。');
  const beforeBytes = statSync(path).size;
  const db = new DatabaseSync(path, { readOnly: !options.apply, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const before = inspect(db);
    if (!options.apply) return { status: 'planned', applied: false, databasePath: path, beforeBytes, before,
      changes: ['全量索引共享固定片段序号上界，任意选集保持准确成员', '去掉 FTS 词项正文，保留倒排词项与 BM25 统计'],
      note: '应用时保持片段、文档时间、旧索引ID与引用；不备份、不删除原件；物理文件回收另用 --apply --vacuum。' };
    ensureSegmentSchema(db);
    if (options.vacuum) db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const after = segmentStorage(db);
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('压缩后片段库完整性核对未通过。');
    return { status: 'compacted', applied: true, vacuumed: !!options.vacuum, databasePath: path,
      beforeBytes, afterBytes: statSync(path).size, before, after };
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let databasePath: string | undefined, apply = false, vacuum = false;
    for (const arg of process.argv.slice(2)) {
      if (arg.startsWith('--database=') && databasePath === undefined) databasePath = arg.slice('--database='.length);
      else if (arg === '--apply' && !apply) apply = true;
      else if (arg === '--vacuum' && !vacuum) vacuum = true;
      else throw new Error('用法：node --import tsx scripts/compact-segment-storage.ts --database=既有片段库绝对路径 [--apply [--vacuum]]');
    }
    if (!databasePath) throw new Error('必须显式选择 --database；不会发现或初始化运行库。');
    console.log(JSON.stringify(compactSegmentStorage({ databasePath, apply, vacuum }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', message: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  }
}
