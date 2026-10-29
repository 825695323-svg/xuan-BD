import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 核心模块共用一个事务连接；事件只在事务成功后向外发布。 */
export class CoreDatabase {
  readonly connection: DatabaseSync;
  private depth = 0;
  private closed = false;

  constructor(readonly path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.connection = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.connection.exec('CREATE TABLE IF NOT EXISTS schema_versions (module TEXT PRIMARY KEY, version INTEGER NOT NULL)');
  }

  transaction<T>(work: () => T): T {
    if (this.depth) throw new Error('核心事务不能隐式嵌套。');
    this.connection.exec('BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = work();
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        if (result instanceof Promise) void result.catch(() => {});
        throw new Error('数据库事务内不能等待外部异步动作。');
      }
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.connection.exec('ROLLBACK'); } catch { /* 提交失败可能已结束事务。 */ }
      throw error;
    } finally { this.depth -= 1; }
  }

  migrate(module: string, version: number, schema: string): void {
    const row = this.connection.prepare('SELECT version FROM schema_versions WHERE module = ?').get(module);
    const current = Number(row?.version ?? 0);
    if (current > version) throw new Error(`当前程序不能读取较新的 ${module} 数据格式。`);
    if (current === version) return;
    this.transaction(() => {
      this.connection.exec(schema);
      this.connection.prepare('INSERT INTO schema_versions(module, version) VALUES (?, ?) ON CONFLICT(module) DO UPDATE SET version=excluded.version').run(module, version);
    });
  }

  close(): void {
    if (this.closed) return;
    this.connection.close();
    this.closed = true;
  }
}
