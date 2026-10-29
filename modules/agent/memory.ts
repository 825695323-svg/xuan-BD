import { createHash, randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { MemoryCategory, MemoryContext, MemoryForgetPreview, MemoryInput, MemoryRecord, MemoryScope, MemorySource, MemoryStatus } from '../../contracts/memory-contracts.js';

export class MemoryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'MemoryError'; }
}
const categories: readonly MemoryCategory[] = ['identity', 'profile', 'preference', 'decision', 'experience', 'project'];
const searchSchema = `
CREATE VIRTUAL TABLE memory_search_index USING fts5(record_id UNINDEXED, version UNINDEXED, topic_tokens, text_tokens, tokenize='unicode61');
CREATE TABLE memory_search_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), initialized INTEGER NOT NULL);
INSERT INTO memory_search_state VALUES(1,0);
`;
interface SearchOptions { category?: MemoryCategory; includeInactive?: boolean; scopeKeys?: string[]; modelOnly?: boolean; limit: number }
const schema = `
CREATE TABLE memories (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL, category TEXT NOT NULL, claim TEXT NOT NULL,
 scope_key TEXT NOT NULL, scope_json TEXT NOT NULL, topic TEXT NOT NULL, text TEXT NOT NULL,
 status TEXT NOT NULL, model_allowed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX memories_search ON memories(status,category,scope_key,topic);
CREATE TABLE memory_versions (
 record_id TEXT NOT NULL REFERENCES memories(id), version INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
 created_at TEXT NOT NULL, PRIMARY KEY(record_id,version)
);
CREATE TABLE memory_sources (
 record_id TEXT NOT NULL REFERENCES memories(id), version INTEGER NOT NULL,
 source_key TEXT NOT NULL, source_json TEXT NOT NULL, PRIMARY KEY(record_id,version,source_key)
);
CREATE INDEX memory_source_lookup ON memory_sources(source_key);
CREATE TABLE memory_exclusions (source_key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE memory_requests (request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, record_id TEXT NOT NULL REFERENCES memories(id));
`;
interface Row {
 id: string; version: number; category: MemoryCategory; claim: MemoryRecord['claim']; scope_key: string;
 scope_json: string; topic: string; text: string; status: MemoryStatus; model_allowed: number; created_at: string; updated_at: string;
}

/** 个人记忆是独立的核心记录；没有自动提取、隐式文件扫描或模型写入入口。 */
export class MemoryService {
  private fullTextAvailable = true;
  constructor(private readonly options: {
    database: CoreDatabase;
    /** 只读、同步核对；仅明确返回 true 才承认来源仍有效。 */
    validateSource?: (source: MemorySource) => boolean;
    now?: () => Date;
  }) {
    options.database.migrate('memory', 1, schema);
    try {
      options.database.migrate('memory_search', 1, searchSchema);
      if (!this.db.prepare('SELECT initialized FROM memory_search_state WHERE singleton=1').get()?.initialized) this.rebuildSearchIndex();
    } catch (error) {
      // SQLite未编译全文模块时保留同样中文分词的确定性匹配，其他存储错误不得隐藏。
      if (!(error instanceof Error) || !/no such module:\s*fts5/iu.test(error.message)) throw error;
      this.fullTextAvailable = false;
    }
  }
  private get db() { return this.options.database.connection; }
  private now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }

  create(input: MemoryInput, requestId: string, options: { candidate?: boolean } = {}): MemoryRecord {
    const normalized = this.validateInput(input);
    if (options.candidate !== undefined && typeof options.candidate !== 'boolean') throw new MemoryError('INVALID_MEMORY', '候选状态需要明确布尔值。', 400);
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 200) throw new MemoryError('INVALID_REQUEST', '保存记忆需要稳定请求编号。', 400);
    const payloadHash = memoryHash({ input: normalized, candidate: !!options.candidate });
    const previous = this.db.prepare('SELECT * FROM memory_requests WHERE request_id=?').get(requestId);
    if (previous) {
      if (previous.payload_hash !== payloadHash) throw new MemoryError('REQUEST_CONFLICT', '同一请求编号不能用于不同记忆。');
      return this.get(String(previous.record_id));
    }
    const id = randomUUID(), now = this.now();
    this.options.database.transaction(() => {
      this.checkSources(normalized.sources);
      const conflict = this.conflicts(normalized);
      const status = conflict.length ? 'conflict' : options.candidate ? 'candidate' : 'confirmed';
      this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 1, normalized.category, normalized.claim,
        scopeKey(normalized.scope), JSON.stringify(normalized.scope), normalized.topic, normalized.text, status,
        normalized.modelAllowed ? 1 : 0, now, now);
      this.saveSources(id, 1, normalized.sources);
      this.saveVersion(id);
      this.db.prepare('INSERT INTO memory_requests VALUES(?,?,?)').run(requestId, payloadHash, id);
    });
    return this.get(id);
  }

  get(id: string): MemoryRecord {
    const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new MemoryError('MEMORY_NOT_FOUND', '没有找到此记忆。', 404);
    const sources = this.db.prepare('SELECT source_json FROM memory_sources WHERE record_id=? AND version=? ORDER BY source_key').all(id, row.version)
      .map((entry) => JSON.parse(String(entry.source_json)) as MemorySource);
    const record: MemoryRecord = { id: row.id, version: row.version, category: row.category, claim: row.claim,
      scope: JSON.parse(row.scope_json) as MemoryScope, topic: row.topic, text: row.text, status: row.status,
      modelAllowed: !!row.model_allowed, sources, createdAt: row.created_at, updatedAt: row.updated_at, conflictsWith: [] };
    if (record.status === 'conflict') record.conflictsWith = this.conflicts(record, id);
    return record;
  }

  list(options: { query?: string; category?: MemoryCategory; includeInactive?: boolean; scope?: MemoryScope; limit?: number } = {}): MemoryRecord[] {
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    if (!Number.isSafeInteger(limit) || (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 1024))
      || (options.category !== undefined && !categories.includes(options.category))) throw new MemoryError('INVALID_SEARCH', '记忆查询条件无效。', 400);
    const query = (options.query ?? '').trim();
    if (query) return this.rankedIds(query, { limit, category: options.category, includeInactive: options.includeInactive,
      ...(options.scope ? { scopeKeys: [scopeKey(options.scope)] } : {}) }).map(({ id }) => this.get(id));
    const rows = this.db.prepare(`SELECT id FROM memories WHERE status!='forgotten'
      ${options.includeInactive ? '' : "AND status IN ('confirmed','candidate','conflict')"}
      AND (?='' OR instr(lower(topic),lower(?))>0 OR instr(lower(text),lower(?))>0)
      AND (?='' OR category=?) AND (?='' OR scope_key=?) ORDER BY updated_at DESC,rowid DESC LIMIT ?`)
      .all(query, query, query, options.category ?? '', options.category ?? '', options.scope ? scopeKey(options.scope) : '', options.scope ? scopeKey(options.scope) : '', limit);
    return rows.map((row) => this.get(String(row.id)));
  }

  /** 兼容管理视图的查询接口；模型上下文另行强制作用域、许可及来源核验。 */
  search(query: string, options: { category?: MemoryCategory; includeInactive?: boolean; scope?: MemoryScope; limit?: number } = {}): MemoryRecord[] {
    return this.list({ ...options, query });
  }

  /** 派生索引可由当前核心记录重建，不能成为个人记忆真源。 */
  rebuildSearchIndex(): number {
    if (!this.fullTextAvailable) return 0;
    return this.options.database.transaction(() => {
      this.db.prepare('DELETE FROM memory_search_index').run();
      const records = this.db.prepare("SELECT id FROM memories WHERE status!='forgotten' ORDER BY id").all();
      for (const row of records) this.indexRecord(String(row.id));
      this.db.prepare('UPDATE memory_search_state SET initialized=1 WHERE singleton=1').run();
      return records.length;
    });
  }

  update(id: string, expectedVersion: number, input: MemoryInput): MemoryRecord {
    const normalized = this.validateInput(input);
    this.options.database.transaction(() => {
      const current = this.requireVersion(id, expectedVersion);
      if (!['confirmed', 'candidate', 'conflict'].includes(current.status)) throw new MemoryError('INVALID_MEMORY_STATE', '已拒绝或已替代的记忆不能通过编辑重新生效。');
      this.checkSources(normalized.sources, new Set([id]));
      const status = this.conflicts(normalized, id).length ? 'conflict' : current.status === 'confirmed' ? 'confirmed' : 'candidate';
      const updated = this.db.prepare('UPDATE memories SET version=version+1,category=?,claim=?,scope_key=?,scope_json=?,topic=?,text=?,status=?,model_allowed=?,updated_at=? WHERE id=? AND version=?')
        .run(normalized.category, normalized.claim, scopeKey(normalized.scope), JSON.stringify(normalized.scope), normalized.topic,
          normalized.text, status, normalized.modelAllowed ? 1 : 0, this.now(), id, expectedVersion);
      if (updated.changes !== 1) throw new MemoryError('MEMORY_VERSION_CONFLICT', '记忆已更新，请重新查看后再修改。');
      this.saveSources(id, expectedVersion + 1, normalized.sources);
      this.saveVersion(id);
    });
    return this.get(id);
  }

  confirm(id: string, expectedVersion: number): MemoryRecord {
    this.options.database.transaction(() => {
      const current = this.requireVersion(id, expectedVersion);
      if (!['candidate', 'conflict'].includes(current.status)) throw new MemoryError('INVALID_MEMORY_STATE', '只有候选或冲突记忆需要确认。');
      this.checkSources(current.sources, new Set([id]));
      if (this.conflicts(current, id).length) throw new MemoryError('MEMORY_CONFLICT', '此主题已有不同内容，请明确选择保留或更正哪条记录。');
      this.changeStatus(current, 'confirmed');
    });
    return this.get(id);
  }

  reject(id: string, expectedVersion: number): MemoryRecord {
    this.options.database.transaction(() => {
      const current = this.requireVersion(id, expectedVersion);
      if (!['candidate', 'conflict'].includes(current.status)) throw new MemoryError('INVALID_MEMORY_STATE', '只能拒绝待确认记忆。');
      this.changeStatus(current, 'rejected');
    });
    return this.get(id);
  }

  /** 更正冲突需要同时绑定被替代记录及新记录的版本，保留双方原版本。 */
  resolveConflict(id: string, expectedVersion: number, supersede: { id: string; version: number }[]): MemoryRecord {
    if (!Array.isArray(supersede) || supersede.some((record) => !record || typeof record.id !== 'string' || !record.id
      || !Number.isSafeInteger(record.version) || record.version < 1)) throw new MemoryError('INVALID_CONFLICT', '解决冲突需要明确记录及版本。', 400);
    this.options.database.transaction(() => {
      const current = this.requireVersion(id, expectedVersion);
      if (current.status !== 'conflict') throw new MemoryError('INVALID_MEMORY_STATE', '此记录没有待解决的冲突。');
      this.checkSources(current.sources, new Set([id]));
      const conflicts = this.conflicts(current, id).sort();
      const chosen = supersede.map((record) => record.id).sort();
      if (JSON.stringify(conflicts) !== JSON.stringify(chosen)) throw new MemoryError('CONFLICT_CHANGED', '冲突范围已变化，请重新查看后再选择。');
      for (const record of supersede) this.changeStatus(this.requireVersion(record.id, record.version), 'superseded');
      // 替代来源本身会使派生记录失效，不能提交刚刚失效的确认内容。
      this.checkSources(current.sources, new Set([id]));
      this.changeStatus(current, 'confirmed');
    });
    return this.get(id);
  }

  history(id: string): MemoryRecord[] {
    this.get(id);
    return this.db.prepare('SELECT snapshot_json FROM memory_versions WHERE record_id=? ORDER BY version').all(id)
      .map((row) => JSON.parse(String(row.snapshot_json)) as MemoryRecord);
  }

  context(options: { conversationId?: string; projectId?: string; query?: string; maxChars?: number } = {}): MemoryContext {
    const budget = options.maxChars ?? 6000;
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > 32_000) throw new MemoryError('INVALID_BUDGET', '记忆上下文预算无效。', 400);
    if (options.query !== undefined && typeof options.query !== 'string') throw new MemoryError('INVALID_SEARCH', '记忆查询内容无效。', 400);
    const scopeKeys = ['global', ...(options.conversationId !== undefined ? [scopeKey({ kind: 'conversation', id: options.conversationId })] : []),
      ...(options.projectId !== undefined ? [scopeKey({ kind: 'project', id: options.projectId })] : [])];
    const query = (options.query ?? '').slice(0, 8000).trim();
    const anchors = this.db.prepare(`SELECT id FROM memories WHERE status='confirmed' AND model_allowed=1 AND scope_key IN (${scopeKeys.map(() => '?').join(',')})
      ${query ? "AND category IN ('identity','preference')" : ''}
      ORDER BY CASE category WHEN 'identity' THEN 0 WHEN 'preference' THEN 1 ELSE 2 END,updated_at DESC,id LIMIT ?`).all(...scopeKeys, query ? 50 : 1000)
      .map((row) => String(row.id));
    const ranked = query ? this.rankedIds(query, { modelOnly: true, scopeKeys, limit: 1000 }) : [];
    const candidateIds = [...new Set([...anchors, ...ranked.map(({ id }) => id)])];
    const anchorSet = new Set(anchors), records = candidateIds.map((id) => this.get(id));
    const accepted: MemoryContext['records'] = [];
    const entries: string[] = [];
    let size = 0, anchorSize = 0, sourceWarnings = 0;
    const anchorBudget = query ? Math.min(2400, Math.floor(budget / 2)) : budget;
    const eligible = new Map<string, { record: MemoryRecord; line: string }>();
    for (const record of records) {
      if (this.isConflicted(record)) continue;
      try { this.checkSources(record.sources, new Set([record.id])); } catch { sourceWarnings++; continue; }
      const line = JSON.stringify({ id: record.id, version: record.version, category: record.category, claim: record.claim,
        scope: record.scope, topic: record.topic, text: record.text, updatedAt: record.updatedAt });
      eligible.set(record.id, { record, line });
    }
    const add = (id: string, anchored: boolean): void => {
      const item = eligible.get(id);
      if (!item || accepted.some((record) => record.id === id)) return;
      const cost = item.line.length + 1;
      if (size + cost > budget || (anchored && anchorSize + cost > anchorBudget)) return;
      entries.push(item.line); size += cost; if (anchored) anchorSize += cost;
      accepted.push({ id, version: item.record.version, contentHash: memoryHash(item.record.text) });
    };
    for (const id of anchors) add(id, true);
    for (const { id } of ranked) add(id, false);
    return { text: entries.join('\n'), records: accepted, omitted: records.length - accepted.length, sourceWarnings,
      retrieval: { mode: this.fullTextAvailable ? 'fts5-cjk-bigram' : 'lexical-cjk-bigram', matched: ranked.length,
        anchored: accepted.filter(({ id }) => anchorSet.has(id)).length } };
  }

  previewForget(id: string): MemoryForgetPreview {
    const initial = this.get(id);
    if (initial.status === 'forgotten') throw new MemoryError('ALREADY_FORGOTTEN', '此记录已经移除。');
    const recordIds = new Set([id]);
    const sourceKeys = new Set(this.db.prepare('SELECT source_key FROM memory_sources WHERE record_id=?').all(id).map((row) => String(row.source_key)));
    sourceKeys.add(`memory:${id}`);
    const pendingKeys = [...sourceKeys];
    const dependants = this.db.prepare("SELECT DISTINCT s.record_id FROM memory_sources s JOIN memories m ON m.id=s.record_id WHERE s.source_key=? AND m.status!='forgotten'");
    for (let index = 0; index < pendingKeys.length; index++) {
      for (const row of dependants.all(pendingKeys[index]!)) {
        const recordId = String(row.record_id);
        if (recordIds.has(recordId)) continue;
        recordIds.add(recordId);
        // 仅沿派生关系扩张；混合派生记录的其他独立来源不被连带排除。
        const key = `memory:${recordId}`;
        if (!sourceKeys.has(key)) { sourceKeys.add(key); pendingKeys.push(key); }
      }
    }
    const ids = [...recordIds].sort(), sources = [...sourceKeys].sort();
    const versions = Object.fromEntries(ids.map((recordId) => [recordId, this.get(recordId).version]));
    const retained = ['原始会话消息、任务和用户文件', '已导出的副本及现有备份', '已发送给模型服务的历史上下文',
      '记录编号、类别、作用域、时间及阻止再次摄入所需的来源编号和请求摘要', '上下文准备版本账本中的编号、版本与不可逆摘要（无正文）', '数据库物理介质和旧日志中的残留页'];
    return { recordIds: ids, versions, sourceKeys: sources, retained, digest: memoryHash({ ids, versions, sources }) };
  }

  forget(id: string, previewDigest: string): MemoryForgetPreview {
    let preview!: MemoryForgetPreview;
    this.options.database.transaction(() => {
      preview = this.previewForget(id);
      if (preview.digest !== previewDigest) throw new MemoryError('FORGET_PREVIEW_CHANGED', '删除范围已变化，请重新查看删除预览。');
      for (const key of preview.sourceKeys) this.db.prepare('INSERT OR IGNORE INTO memory_exclusions VALUES(?,?)').run(key, this.now());
      for (const recordId of preview.recordIds) {
        this.db.prepare("UPDATE memories SET text='',topic='',status='forgotten',model_allowed=0,version=version+1,updated_at=? WHERE id=?").run(this.now(), recordId);
        this.db.prepare('DELETE FROM memory_versions WHERE record_id=?').run(recordId);
        this.db.prepare('DELETE FROM memory_sources WHERE record_id=?').run(recordId);
        if (this.fullTextAvailable) this.db.prepare('DELETE FROM memory_search_index WHERE record_id=?').run(recordId);
      }
    });
    return preview;
  }

  export(): { format: 'mashiro-memory-v1'; exportedAt: string; records: MemoryRecord[] } {
    const ids = this.db.prepare("SELECT id FROM memories WHERE status!='forgotten' ORDER BY created_at,id").all();
    return { format: 'mashiro-memory-v1', exportedAt: this.now(), records: ids.map((row) => this.get(String(row.id))) };
  }

  private requireVersion(id: string, version: number): MemoryRecord {
    const record = this.get(id);
    if (!Number.isSafeInteger(version) || record.version !== version) throw new MemoryError('MEMORY_VERSION_CONFLICT', '记忆已更新，请重新查看后再修改。');
    if (record.status === 'forgotten') throw new MemoryError('ALREADY_FORGOTTEN', '已移除的记录不能重新写回。');
    return record;
  }
  private checkSources(sources: MemorySource[], ancestors = new Set<string>(), checked = new Set<string>()): void {
    if (ancestors.size > 256) throw new MemoryError('SOURCE_DEPTH', '记忆来源链过深，需要缩短并重新核对。');
    for (const source of sources) {
      if (this.db.prepare('SELECT 1 FROM memory_exclusions WHERE source_key=?').get(sourceKey(source))) throw new MemoryError('SOURCE_EXCLUDED', '此来源已被排除，不能再次摄入记忆。');
      if (source.kind === 'memory') {
        if (ancestors.has(source.id)) throw new MemoryError('SOURCE_CYCLE', '记忆来源包含循环引用。');
        const record = this.get(source.id);
        if (record.status !== 'confirmed' || this.isConflicted(record) || String(record.version) !== source.version || memoryHash(record.text) !== source.contentHash) {
          throw new MemoryError('SOURCE_CHANGED', '派生记忆来源已更改，需重新核对。');
        }
        const key = JSON.stringify([source.id, source.version, source.contentHash]);
        if (checked.has(key)) continue;
        this.checkSources(record.sources, new Set([...ancestors, source.id]), checked);
        checked.add(key);
      } else if (source.kind !== 'manual') {
        let valid = false;
        try {
          const outcome: unknown = this.options.validateSource?.(structuredClone(source));
          if (outcome instanceof Promise) void outcome.catch(() => {});
          valid = outcome === true;
        } catch { /* 核对不可用时不提交或注入。 */ }
        if (!valid) throw new MemoryError('SOURCE_CHANGED', '原始来源已变化或暂时无法核对。');
      }
    }
  }
  private validateInput(input: MemoryInput): MemoryInput {
    if (!input || typeof input !== 'object' || !categories.includes(input.category)
      || !['user_statement', 'observation', 'inference'].includes(input.claim)
      || typeof input.topic !== 'string' || !input.topic.trim() || input.topic.length > 120
      || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 12_000
      || (input.modelAllowed !== undefined && typeof input.modelAllowed !== 'boolean')
      || !Array.isArray(input.sources) || !input.sources.length || input.sources.length > 50) throw new MemoryError('INVALID_MEMORY', '记忆内容、类别或来源无效。', 400);
    scopeKey(input.scope);
    for (const source of input.sources) {
      if (!source || !['manual', 'message', 'file', 'task', 'memory'].includes(source.kind)
        || typeof source.id !== 'string' || !source.id.trim() || source.id.length > 300 || source.id.includes('\0')
        || typeof source.version !== 'string' || !source.version.trim() || source.version.length > 200 || source.version.includes('\0')
        || typeof source.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(source.contentHash)
        || typeof source.observedAt !== 'string' || source.observedAt.length > 100 || !Number.isFinite(Date.parse(source.observedAt))) {
        throw new MemoryError('INVALID_SOURCE', '记忆来源需要稳定编号、版本、摘要和观察时间。', 400);
      }
    }
    if (new Set(input.sources.map(sourceKey)).size !== input.sources.length) throw new MemoryError('INVALID_SOURCE', '记忆来源不能重复。', 400);
    return { category: input.category, claim: input.claim,
      scope: input.scope.kind === 'global' ? { kind: 'global' } : { kind: input.scope.kind, id: input.scope.id },
      topic: input.topic.trim(), text: input.text.trim(), modelAllowed: input.modelAllowed ?? false,
      sources: input.sources.map((source) => ({ kind: source.kind, id: source.id, version: source.version,
        contentHash: source.contentHash, observedAt: new Date(source.observedAt).toISOString() })).sort((a, b) => sourceKey(a) < sourceKey(b) ? -1 : 1) };
  }
  private conflicts(input: Pick<MemoryInput, 'scope' | 'category' | 'topic' | 'text'>, exceptId = ''): string[] {
    return this.db.prepare("SELECT id FROM memories WHERE scope_key=? AND category=? AND topic=? AND status='confirmed' AND text!=? AND id!=? ORDER BY id")
      .all(scopeKey(input.scope), input.category, input.topic, input.text, exceptId).map((row) => String(row.id));
  }
  private isConflicted(record: Pick<MemoryInput, 'scope' | 'category' | 'topic'>): boolean {
    return !!this.db.prepare("SELECT 1 FROM memories WHERE scope_key=? AND category=? AND topic=? AND status='conflict' LIMIT 1")
      .get(scopeKey(record.scope), record.category, record.topic);
  }
  private saveSources(id: string, version: number, sources: MemorySource[]): void {
    for (const source of sources) this.db.prepare('INSERT INTO memory_sources VALUES(?,?,?,?)').run(id, version, sourceKey(source), JSON.stringify(source));
  }
  private saveVersion(id: string): void {
    const record = this.get(id);
    this.db.prepare('INSERT INTO memory_versions VALUES(?,?,?,?)').run(id, record.version, JSON.stringify(record), record.updatedAt);
    this.indexRecord(id);
  }
  private indexRecord(id: string): void {
    if (!this.fullTextAvailable) return;
    this.db.prepare('DELETE FROM memory_search_index WHERE record_id=?').run(id);
    const record = this.db.prepare("SELECT id,version,topic,text FROM memories WHERE id=? AND status!='forgotten'").get(id);
    if (record) this.db.prepare('INSERT INTO memory_search_index(record_id,version,topic_tokens,text_tokens) VALUES(?,?,?,?)')
      .run(id, Number(record.version), memorySearchTokens(String(record.topic), true).join(' '), memorySearchTokens(String(record.text), true).join(' '));
  }
  private rankedIds(query: string, options: SearchOptions): Array<{ id: string; score: number }> {
    const tokens = memorySearchTokens(query, false).slice(0, 48);
    if (!tokens.length) return [];
    const clauses = ["m.status!='forgotten'"], parameters: Array<string | number> = [];
    if (options.modelOnly) clauses.push("m.status='confirmed'", 'm.model_allowed=1');
    else if (!options.includeInactive) clauses.push("m.status IN ('confirmed','candidate','conflict')");
    if (options.category) { clauses.push('m.category=?'); parameters.push(options.category); }
    if (options.scopeKeys) { clauses.push(`m.scope_key IN (${options.scopeKeys.map(() => '?').join(',')})`); parameters.push(...options.scopeKeys); }
    if (this.fullTextAvailable) {
      // FTS MATCH仅使用归一化后编码的词，查询语法与用户文本严格分开。
      const match = tokens.map((token) => `"${token}"`).join(' OR ');
      return this.db.prepare(`SELECT m.id,bm25(memory_search_index,0,0,6,1) AS score FROM memory_search_index
        JOIN memories m ON m.id=memory_search_index.record_id AND m.version=CAST(memory_search_index.version AS INTEGER)
        WHERE memory_search_index MATCH ? AND ${clauses.join(' AND ')} ORDER BY score,m.updated_at DESC,m.id LIMIT ?`)
        .all(match, ...parameters, options.limit).map((row) => ({ id: String(row.id), score: Number(row.score) }));
    }
    const rows = this.db.prepare(`SELECT m.id,m.topic,m.text,m.updated_at FROM memories m WHERE ${clauses.join(' AND ')} ORDER BY m.updated_at DESC,m.id`).all(...parameters);
    return rows.map((row) => {
      const topic = new Set(memorySearchTokens(String(row.topic), true)), text = new Set(memorySearchTokens(String(row.text), true));
      return { id: String(row.id), score: -tokens.reduce((score, token) => score + (topic.has(token) ? 6 : 0) + (text.has(token) ? 1 : 0), 0) };
    }).filter(({ score }) => score < 0).sort((a, b) => a.score - b.score).slice(0, options.limit);
  }
  private changeStatus(record: MemoryRecord, status: MemoryStatus): void {
    const updated = this.db.prepare('UPDATE memories SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(status, this.now(), record.id, record.version);
    if (updated.changes !== 1) throw new MemoryError('MEMORY_VERSION_CONFLICT', '记忆已更新，请重新查看后再修改。');
    this.saveSources(record.id, record.version + 1, record.sources);
    this.saveVersion(record.id);
  }
}

const SEARCH_STOP_WORDS = new Set(['the', 'and', 'this', 'that', 'what', 'how', 'please', 'with', 'from', 'for', 'are', 'was', 'your', 'you', 'my', 'our', 'me', 'to', 'of', 'is', 'a', 'an',
  '请问', '一下', '我的', '帮我', '可以', '是否', '怎么', '什么', '现在', '我们', '这个', '那个', '我想', '有关', '当前', '之前', '需要']);
/** 中文双字词与拉丁词编码进普通FTS列；可替换索引，不把分词结果写成事实记忆。 */
export function memorySearchTokens(text: string, includeSingleCharacters = false): string[] {
  const normalized = text.normalize('NFKC').replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase();
  const tokens: string[] = [];
  const words = (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).flatMap((word) => word.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) ?? []);
  for (const word of words) {
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      const chars = [...word];
      if (chars.length === 1 || includeSingleCharacters) for (const char of chars) if (!'的了是在有和与吗呢我你他她它这那'.includes(char)) tokens.push('c' + Buffer.from(char).toString('hex'));
      for (let index = 0; index + 1 < chars.length; index++) {
        const pair = chars[index]! + chars[index + 1]!;
        if (!SEARCH_STOP_WORDS.has(pair)) tokens.push('h' + Buffer.from(pair).toString('hex'));
      }
    } else if (!SEARCH_STOP_WORDS.has(word)) tokens.push('w' + Buffer.from(word).toString('hex'));
  }
  return includeSingleCharacters ? tokens : [...new Set(tokens)];
}

export function memoryHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function manualMemorySource(text: string, id: string = randomUUID()): MemorySource {
  return { kind: 'manual', id, version: '1', contentHash: memoryHash(text), observedAt: new Date().toISOString() };
}
function sourceKey(source: MemorySource): string { return `${source.kind}:${source.id}`; }
function scopeKey(scope: MemoryScope): string {
  if (!scope || typeof scope !== 'object') throw new MemoryError('INVALID_SCOPE', '记忆作用域无效。', 400);
  if (scope.kind === 'global') return 'global';
  if (!['project', 'conversation'].includes(scope.kind) || typeof scope.id !== 'string' || !scope.id.trim() || scope.id.length > 200) {
    throw new MemoryError('INVALID_SCOPE', '项目或会话记忆需要明确作用域编号。', 400);
  }
  return `${scope.kind}:${scope.id}`;
}
