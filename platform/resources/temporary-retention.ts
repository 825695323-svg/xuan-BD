import { lstatSync, rmSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';
import type { CoreDatabase } from '../state/database.js';
import { inspectPath, samePathIdentity, type PathIdentity } from '../security/permissions.js';

export const TEMPORARY_RETENTION_DAYS = 3;
const TTL = TEMPORARY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** 仅接收程序已结束使用的自有暂存；不能按文件年龄猜测可回收性。 */
export class TemporaryRetention {
  private readonly rootIdentity: PathIdentity;
  private timer?: ReturnType<typeof setInterval>;
  private lastError: string | null = null;
  constructor(private readonly database: CoreDatabase, readonly root: string, private readonly now: () => number = Date.now, private readonly additionalReferenceGuard?: (path: string) => boolean) {
    this.rootIdentity = inspectPath(root);
    if (this.rootIdentity.object?.kind !== 'directory' || this.rootIdentity.canonicalPath !== root || this.rootIdentity.links.length) throw Error('临时保留根必须是已核对的自有普通目录。');
    database.migrate('temporary_retention', 1, `CREATE TABLE temporary_retention (
      path TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), identity_json TEXT NOT NULL,
      released_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'retained',
      removed_at INTEGER, reason TEXT
    );`);
    database.migrate('temporary_retention_root_identity', 1, 'ALTER TABLE temporary_retention ADD COLUMN root_identity_json TEXT;');
  }
  retire(path: string, taskId: string, expected: PathIdentity) {
    this.assertRoot();
    if (dirname(path) !== this.root || !/^\.direct-[a-f0-9-]{36}$/u.test(basename(path))
      || !samePathIdentity(expected, inspectPath(path))) throw Error('只接受本次已核对的独立文件暂存目录。');
    const exists = this.database.connection.prepare('SELECT task_id,identity_json,expires_at FROM temporary_retention WHERE path=?').get(path);
    if (exists) {
      if (exists.task_id !== taskId || !samePathIdentity(JSON.parse(String(exists.identity_json)), expected)) throw Error('临时保留记录与原任务或目录身份冲突。');
      return { expiresAt: Number(exists.expires_at) };
    }
    const released = this.now(), expiresAt = released + TTL;
    this.database.connection.prepare('INSERT INTO temporary_retention(path,task_id,identity_json,released_at,expires_at,root_identity_json) VALUES(?,?,?,?,?,?)')
      .run(path, taskId, JSON.stringify(expected), released, expiresAt, JSON.stringify(this.rootIdentity));
    return { expiresAt };
  }
  start() {
    if (this.timer) return;
    this.sweep();
    this.timer = setInterval(() => { try { this.sweep(); this.lastError = null; } catch { this.lastError = '临时清理未确认，待下次核对。'; } }, 60 * 60 * 1000); this.timer.unref();
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  status() {
    const counts = this.database.connection.prepare('SELECT state,count(*) AS count FROM temporary_retention GROUP BY state').all();
    return { temporaryRetentionDays: TEMPORARY_RETENTION_DAYS, sweepIntervalHours: 1, cloudEvidenceExpires: false,
      authority: 'only explicitly released scratch; referenced files and unresolved tasks retained', lastError: this.lastError, counts };
  }
  sweep() {
    const db = this.database.connection;
    try { this.assertRoot(); }
    catch { return { removed: 0, blocked: 'root_identity_changed' }; }
    let removed = 0;
    const rows = db.prepare("SELECT * FROM temporary_retention WHERE state='retained' AND expires_at<=? ORDER BY expires_at LIMIT 200").all(this.now());
    for (const row of rows) {
      const path = String(row.path), task = db.prepare('SELECT status FROM tasks WHERE id=?').get(row.task_id);
      const reason = (message: string) => db.prepare('UPDATE temporary_retention SET reason=? WHERE path=?').run(message, path);
      if (!task || !['succeeded', 'failed', 'cancelled'].includes(String(task.status))) { reason('原任务尚未明确收束，保留恢复现场。'); continue; }
      if (this.additionalReferenceGuard?.(path)) { reason('仍有文件引用或其他状态库的引用尚不可核对。'); continue; }
      const prefix = path + sep;
      if (db.prepare(`SELECT 1 FROM file_references WHERE invocation_path=? OR substr(invocation_path,1,?)=?
        OR json_extract(metadata,'$.canonicalPath')=? OR substr(json_extract(metadata,'$.canonicalPath'),1,?)=? LIMIT 1`)
        .get(path, prefix.length, prefix, path, prefix.length, prefix)) { reason('目录内仍有持久文件引用。'); continue; }
      try {
        this.assertRoot();
        if (!row.root_identity_json || !samePathIdentity(JSON.parse(String(row.root_identity_json)), this.rootIdentity)) { reason('原暂存根身份与当前配置不符。'); continue; }
        if (dirname(path) !== this.root || !/^\.direct-[a-f0-9-]{36}$/u.test(basename(path))) { reason('目录不属于本实例暂存根。'); continue; }
        const actual = inspectPath(path, { allowMissing: true });
        if (actual.exists && (!samePathIdentity(JSON.parse(String(row.identity_json)), actual) || lstatSync(path).isSymbolicLink())) { reason('原目录对象身份已变化。'); continue; }
        if (actual.exists) rmSync(path, { recursive: true });
        if (inspectPath(path, { allowMissing: true }).exists) throw Error('删除后仍存在。');
        db.prepare("UPDATE temporary_retention SET state='removed',removed_at=?,reason=NULL WHERE path=?").run(this.now(), path); removed++;
      } catch { reason('本次清理未确认，保留记录供核对。'); }
    }
    return { removed, blocked: null };
  }
  private assertRoot() { if (!samePathIdentity(this.rootIdentity, inspectPath(this.root))) throw Error('临时目录根身份已变化。'); }
}
