import { TemporaryRetention } from './temporary-retention.js';
import type { ResourceBindings, ResourceReference } from './bindings.js';
import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, sep } from 'node:path';
import type { CoreDatabase } from '../state/database.js';
import { inspectPath, PermissionService, samePathIdentity, type OperationScope, type PathIdentity } from '../security/permissions.js';

export type FileReferenceSource = 'user-selected' | 'user-attached' | 'generated';
export type FileReferenceStatus = 'available' | 'changed' | 'missing' | 'unavailable';
export interface FileRelations { conversationId?: string; taskId?: string; artifactId?: string }
export interface FileReference {
  id: string;
  resource?: ResourceReference;
  source: FileReferenceSource;
  displayName: string;
  invocationPath: string;
  canonicalPath: string;
  device: string;
  inode: string;
  size: number;
  mtimeMs: number;
  mtimeNs: string;
  kind: 'file' | 'directory';
  identity: PathIdentity;
  version: number;
  status: FileReferenceStatus;
  relations: { kind: 'conversation' | 'task' | 'artifact'; id: string }[];
  createdAt: number;
  updatedAt: number;
}
export interface FileObservation {
  reference: FileReference;
  status: FileReferenceStatus;
  current: PathIdentity | null;
}
export interface FileReferenceFilter extends FileRelations { limit?: number }
export class FileReferenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'FileReferenceError'; }
}
type StoredReference = Omit<FileReference, 'relations'>;

const SCHEMA = `
CREATE TABLE file_references (
  id TEXT PRIMARY KEY, invocation_path TEXT NOT NULL, metadata TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('available','changed','missing','unavailable')),
  version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE file_reference_relations (
  file_id TEXT NOT NULL REFERENCES file_references(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('conversation','task','artifact')), relation_id TEXT NOT NULL,
  PRIMARY KEY(file_id,kind,relation_id)
);
CREATE INDEX file_reference_relation_lookup ON file_reference_relations(kind,relation_id);
CREATE INDEX file_reference_path_lookup ON file_references(invocation_path);
`;

/** 文件引用只保存用户明确选取的对象及关系；内容读取统一经过 Core 权限服务。 */
export class FileReferenceService {
  private readonly database: CoreDatabase;
  private readonly permissions: PermissionService;
  private readonly now: () => number;
  private readonly resources?: ResourceBindings;
  private retention?: TemporaryRetention;

  constructor(options: { database: CoreDatabase; permissions: PermissionService; now?: () => number; resources?: ResourceBindings }) {
    this.database = options.database;
    this.permissions = options.permissions;
    this.now = options.now ?? Date.now;
    this.resources = options.resources;
    this.database.migrate('files', 1, SCHEMA);
  }

  configureTemporaryRetention(root: string, additionalReferenceGuard?: (path: string) => boolean) { this.retention = new TemporaryRetention(this.database, root, this.now, additionalReferenceGuard); }
  startTemporaryRetention() { this.retention?.start(); }
  closeTemporaryRetention() { this.retention?.close(); }
  temporaryRetentionStatus() { return this.retention?.status() ?? null; }
  retireTemporaryDirectory(path: string, taskId: string, identity: PathIdentity) { return this.retention?.retire(path, taskId, identity) ?? null; }
  hasReferenceWithin(path: string): boolean {
    const prefix = path + sep, db = this.database.connection;
    if (db.prepare(`SELECT 1 FROM file_references WHERE invocation_path=? OR substr(invocation_path,1,?)=?
      OR json_extract(metadata,'$.canonicalPath')=? OR substr(json_extract(metadata,'$.canonicalPath'),1,?)=? LIMIT 1`)
      .get(path, prefix.length, prefix, path, prefix.length, prefix)) return true;
    const resource = this.resources?.reference(path);
    if (!resource) return false;
    const relativePrefix = resource.relative + '/';
    return !!db.prepare(`SELECT 1 FROM file_references WHERE json_extract(metadata,'$.resource.root')=?
      AND json_extract(metadata,'$.resource.identity')=? AND (json_extract(metadata,'$.resource.relative')=?
      OR substr(json_extract(metadata,'$.resource.relative'),1,?)=?) LIMIT 1`)
      .get(resource.root, resource.identity, resource.relative, relativePrefix.length, relativePrefix);
  }


  register(input: { path: string; source: FileReferenceSource; displayName?: string } & FileRelations): FileReference {
    return this.database.transaction(() => this.registerInTransaction(input));
  }

  registerInTransaction(input: { path: string; source: FileReferenceSource; displayName?: string } & FileRelations): FileReference {
    if (!this.database.connection.isTransaction) throw new FileReferenceError('TRANSACTION_REQUIRED', '文件引用须在所属核心事务内登记。');
    if (!['user-selected', 'user-attached', 'generated'].includes(input.source)) throw new FileReferenceError('INVALID_SOURCE', '文件引用需要明确来源。');
    const identity = inspectPath(input.path);
    const relations = relationEntries(input);
    const now = this.now();
    const reference = referenceFromIdentity(randomUUID(), identity, {
      source: input.source, displayName: input.displayName ?? basename(identity.invocationPath), createdAt: now, updatedAt: now, version: 1,
    });
    const resource = this.resources?.reference(reference.invocationPath);
    if (resource) reference.resource = resource;
    if (!reference.displayName.trim() || reference.displayName.length > 512) throw new FileReferenceError('INVALID_NAME', '文件展示名称无效。');
    this.database.connection.prepare('INSERT INTO file_references VALUES(?,?,?,?,?,?,?)')
      .run(reference.id, reference.invocationPath, JSON.stringify(reference), 'available', 1, now, now);
    this.insertRelations(reference.id, relations);
    return this.getRef(reference.id);
  }

  getRef(id: string): FileReference {
    const row = this.database.connection.prepare('SELECT * FROM file_references WHERE id=?').get(id);
    if (!row) throw new FileReferenceError('FILE_REF_NOT_FOUND', '没有找到此文件引用。');
    let metadata: StoredReference;
    try { metadata = JSON.parse(String(row.metadata)) as StoredReference; } catch { throw new FileReferenceError('INVALID_FILE_RECORD', '文件引用记录无法读取。'); }
    if (metadata.resource) {
      if (!this.resources) throw new FileReferenceError('RESOURCE_UNBOUND', '此文件需要受信宿主的资源绑定。');
      const path = this.resources.resolve(metadata.resource);
      const oldPath = metadata.invocationPath, oldCanonical = metadata.canonicalPath;
      metadata = { ...metadata, invocationPath: path, canonicalPath: path, identity: { ...metadata.identity,
        invocationPath: path, canonicalPath: path, ancestor: { ...metadata.identity.ancestor,
          canonicalPath: metadata.identity.ancestor.canonicalPath === oldPath || metadata.identity.ancestor.canonicalPath === oldCanonical ? path : metadata.identity.ancestor.canonicalPath } } };
    }
    const relations = this.database.connection.prepare('SELECT kind,relation_id FROM file_reference_relations WHERE file_id=? ORDER BY kind,relation_id').all(id)
      .map((relation) => ({ kind: String(relation.kind) as FileReference['relations'][number]['kind'], id: String(relation.relation_id) }));
    return structuredClone({ ...metadata, status: String(row.status) as FileReferenceStatus, version: Number(row.version), updatedAt: Number(row.updated_at), relations });
  }

  getRefs(filter: FileReferenceFilter = {}): FileReference[] { return this.selectRefs(filter); }

  /** 数据页按登记元数据检索；每次只取一页，不扫描或观察文件系统。 */
  listPage(options: { group: 'materials' | 'outputs'; query?: string; after?: { createdAt: number; id: string }; limit?: number }) {
    const limit = options.limit ?? 50, query = options.query ?? '';
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new FileReferenceError('INVALID_LIMIT', '文件列表每页须在 1 到 50 条之间。');
    if (!['materials', 'outputs'].includes(options.group) || typeof query !== 'string' || query.length > 256) throw new FileReferenceError('INVALID_SEARCH', '文件查询无效。');
    const after = options.after;
    if (after && (!Number.isSafeInteger(after.createdAt) || typeof after.id !== 'string' || !after.id || after.id.length > 160)) throw new FileReferenceError('INVALID_CURSOR', '文件列表游标无效。');
    const parameters: (string | number)[] = [query, query];
    let where = `json_extract(metadata,'$.source') ${options.group === 'outputs' ? '=' : '!='} 'generated'
      AND (instr(lower(json_extract(metadata,'$.displayName')),lower(?))>0 OR instr(lower(id),lower(?))>0)`;
    if (after) { where += ' AND (created_at<? OR (created_at=? AND id>?))'; parameters.push(after.createdAt, after.createdAt, after.id); }
    const rows = this.database.connection.prepare(`SELECT id,created_at FROM file_references WHERE ${where} ORDER BY created_at DESC,id LIMIT ?`).all(...parameters, limit + 1);
    const visible = rows.slice(0, limit), last = visible.at(-1);
    return { items: visible.map(row => this.getRef(String(row.id))),
      next: rows.length > limit && last ? { createdAt: Number(last.created_at), id: String(last.id) } : null };
  }

  /** 搜索已登记的引用，不扫描用户的文件系统。 */
  searchRefs(query: string, filter: FileReferenceFilter = {}): FileReference[] {
    if (typeof query !== 'string' || query.length > 1024) throw new FileReferenceError('INVALID_SEARCH', '文件查询无效。');
    return this.selectRefs(filter, query);
  }

  link(id: string, relations: FileRelations): FileReference {
    this.getRef(id);
    const entries = relationEntries(relations);
    this.database.transaction(() => this.insertRelations(id, entries));
    return this.getRef(id);
  }

  /** 更新观察状态，保留原对象身份供后续核对。 */
  observe(id: string): FileObservation {
    const observation = this.inspectReference(this.getRef(id));
    this.database.transaction(() => {
      this.database.connection.prepare('UPDATE file_references SET status=?,updated_at=? WHERE id=? AND version=?')
        .run(observation.status, this.now(), id, observation.reference.version);
    });
    return { ...observation, reference: this.getRef(id) };
  }

  /** 不改变基线；目标、链接、内容版本变更时拒绝使用旧引用。 */
  verify(id: string): FileReference {
    const observation = this.inspectReference(this.getRef(id));
    if (observation.status !== 'available') {
      throw new FileReferenceError(observation.status === 'missing' ? 'FILE_MISSING' : observation.status === 'changed' ? 'FILE_CHANGED' : 'FILE_UNAVAILABLE',
        observation.status === 'missing' ? '文件已不存在。' : '文件对象或路径已变化，请重新选择或核对。');
    }
    return { ...observation.reference, status: 'available' };
  }

  /** 登记已完成、已核对的同一文件移动；本方法不移动文件。 */
  updateAfterMove(id: string, input: { newPath: string; expectedVersion: number }): FileReference {
    const previous = this.getRef(id);
    if (input.expectedVersion !== previous.version) throw new FileReferenceError('STALE_FILE_REF', '文件引用已被更新。');
    const current = inspectPath(input.newPath);
    if (current.invocationPath === previous.invocationPath) throw new FileReferenceError('MOVE_NOT_CONFIRMED', '文件位置没有变化。');
    const object = current.object;
    if (!object || object.device !== previous.device || object.inode !== previous.inode || object.kind !== previous.kind
      || (object.kind === 'file' && (object.size !== previous.size || object.mtimeNs !== previous.mtimeNs))) {
      throw new FileReferenceError('FILE_CHANGED', '新位置不是原文件对象；复制或跨卷替换需要重新登记。');
    }
    try {
      const old = inspectPath(previous.invocationPath, { allowMissing: true });
      if (old.object?.device === previous.device && old.object?.inode === previous.inode) throw new FileReferenceError('MOVE_NOT_CONFIRMED', '原位置仍指向同一文件，尚不能确认移动。');
    } catch (error) {
      if (error instanceof FileReferenceError) throw error;
      throw new FileReferenceError('MOVE_UNVERIFIED', '无法核对原位置，不更新移动结果。');
    }
    const updated = referenceFromIdentity(previous.id, current, {
      source: previous.source, displayName: basename(current.invocationPath), createdAt: previous.createdAt,
      updatedAt: this.now(), version: previous.version + 1,
    });
    const resource = this.resources?.reference(updated.invocationPath);
    if (resource) updated.resource = resource;
    this.database.transaction(() => {
      const result = this.database.connection.prepare('UPDATE file_references SET invocation_path=?,metadata=?,status=?,version=?,updated_at=? WHERE id=? AND version=?')
        .run(updated.invocationPath, JSON.stringify(updated), 'available', updated.version, updated.updatedAt, id, input.expectedVersion);
      if (result.changes !== 1) throw new FileReferenceError('STALE_FILE_REF', '文件引用已被其他动作更新。');
    });
    return this.getRef(id);
  }

  /** 只登记受控编辑已核验的新对象；文件修改及新字节摘要核验由原任务执行器完成。 */
  updateAfterEdit(id: string, input: { expectedVersion: number; identity: PathIdentity }): FileReference {
    const previous = this.getRef(id);
    if (previous.version !== input.expectedVersion) throw new FileReferenceError('STALE_FILE_REF', '文件引用已被其他动作更新。');
    const current = inspectPath(previous.invocationPath);
    if (previous.kind !== 'file' || current.object?.kind !== 'file' || current.links.length
      || current.canonicalPath !== previous.canonicalPath || !samePathIdentity(input.identity, current, true)) {
      throw new FileReferenceError('EDIT_UNVERIFIED', '编辑结果身份与已核验对象不符，不更新引用。');
    }
    const updated = referenceFromIdentity(previous.id, current, { source: previous.source, displayName: previous.displayName,
      createdAt: previous.createdAt, updatedAt: this.now(), version: previous.version + 1 });
    if (previous.resource) updated.resource = previous.resource;
    this.database.transaction(() => {
      const changed = this.database.connection.prepare('UPDATE file_references SET metadata=?,status=?,version=?,updated_at=? WHERE id=? AND version=?')
        .run(JSON.stringify(updated), 'available', updated.version, updated.updatedAt, id, input.expectedVersion);
      if (changed.changes !== 1) throw new FileReferenceError('STALE_FILE_REF', '文件引用已被其他动作更新。');
    });
    return this.getRef(id);
  }

  /** 保留已授权普通文件的原字节；打开句柄及读取前后均核同一登记对象。 */
  async readBytes(id: string, options: { operation: OperationScope; approvalId?: string; maxBytes?: number }): Promise<Buffer> {
    const reference = this.verify(id);
    if (reference.kind !== 'file') throw new FileReferenceError('NOT_A_FILE', '不能把目录当作文本文件读取。');
    const maxBytes = options.maxBytes ?? 2_000_000;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 268_435_456) throw new FileReferenceError('INVALID_LIMIT', '原字节读取上限需要在 1 到 268,435,456 字节之间；具体工具仍使用自身更小预算。');
    if (reference.size > maxBytes) throw new FileReferenceError('FILE_TOO_LARGE', '文件超出本次读取上限。');
    const capabilities = [{ action: 'read' as const, target: { kind: 'file' as const, path: reference.invocationPath } }];
    const authorize = () => this.permissions.assertAuthorized(options.operation, capabilities, { approvalId: options.approvalId });
    authorize();
    const handle = await open(reference.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      this.verify(id);
      assertHandleIdentity(await handle.stat({ bigint: true }), reference);
      authorize();
      const chunks: Buffer[] = [];
      let offset = 0;
      while (true) {
        const buffer = Buffer.alloc(Math.min(64_000, maxBytes + 1 - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        if (offset > maxBytes) throw new FileReferenceError('FILE_TOO_LARGE', '文件超出本次读取上限。');
        chunks.push(buffer.subarray(0, bytesRead));
      }
      assertHandleIdentity(await handle.stat({ bigint: true }), reference);
      this.verify(id);
      authorize();
      return Buffer.concat(chunks);
    } finally { await handle.close(); }
  }

  /** 文本入口沿用同一安全字节读取，再进行严格解码。 */
  async readText(id: string, options: { operation: OperationScope; approvalId?: string; maxBytes?: number }): Promise<string> {
    if ((options.maxBytes ?? 2_000_000) > 20_000_000) throw new FileReferenceError('INVALID_LIMIT', '文本读取上限仍为20,000,000字节；较大原件须走独立保管或转换。');
    const bytes = await this.readBytes(id, options);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new FileReferenceError('NOT_UTF8_TEXT', '文件不是有效 UTF-8 文本，请使用相应格式处理器。'); }
  }

  private inspectReference(reference: FileReference): FileObservation {
    try {
      const current = inspectPath(reference.invocationPath);
      return { reference, current, status: samePathIdentity(reference.identity, current, true) ? 'available' : 'changed' };
    } catch {
      // 允许缺失的观察能区分消失与拒绝访问、悬空链接或无法核对路径。
      try {
        const current = inspectPath(reference.invocationPath, { allowMissing: true });
        return { reference, current, status: current.exists ? 'changed' : 'missing' };
      } catch { return { reference, current: null, status: 'unavailable' }; }
    }
  }

  private selectRefs(filter: FileReferenceFilter, query?: string): FileReference[] {
    const entries = relationEntries(filter);
    const limit = filter.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new FileReferenceError('INVALID_LIMIT', '文件引用查询上限需要在 1 到 1,000 之间。');
    const clauses = entries.map(() => 'EXISTS (SELECT 1 FROM file_reference_relations r WHERE r.file_id=f.id AND r.kind=? AND r.relation_id=?)');
    const parameters: (string | number)[] = entries.flatMap((entry) => [entry.kind, entry.id]);
    if (query !== undefined) { clauses.push('(instr(lower(f.invocation_path),lower(?))>0 OR instr(lower(f.metadata),lower(?))>0)'); parameters.push(query, query); }
    parameters.push(limit);
    const rows = this.database.connection.prepare(`SELECT f.id FROM file_references f ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY f.created_at,f.id LIMIT ?`).all(...parameters);
    return rows.map((row) => this.getRef(String(row.id)));
  }

  linkInTransaction(id: string, relations: FileRelations): void {
    if (!this.database.connection.isTransaction) throw new FileReferenceError('TRANSACTION_REQUIRED', '文件引用关系须在所属核心事务内登记。');
    this.insertRelations(id, relationEntries(relations));
  }

  private insertRelations(id: string, entries: FileReference['relations']): void {
    const insert = this.database.connection.prepare('INSERT OR IGNORE INTO file_reference_relations VALUES(?,?,?)');
    for (const entry of entries) insert.run(id, entry.kind, entry.id);
  }
}

function relationEntries(input: FileRelations): FileReference['relations'] {
  const entries: FileReference['relations'] = [];
  for (const [field, kind] of [['conversationId', 'conversation'], ['taskId', 'task'], ['artifactId', 'artifact']] as const) {
    const id = input[field];
    if (id === undefined) continue;
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || id.includes('\0')) throw new FileReferenceError('INVALID_RELATION', '文件关系标识无效。');
    entries.push({ kind, id });
  }
  return entries;
}

function referenceFromIdentity(id: string, identity: PathIdentity, facts: Pick<StoredReference, 'source' | 'displayName' | 'createdAt' | 'updatedAt' | 'version'>): StoredReference {
  if (!identity.object) throw new FileReferenceError('FILE_MISSING', '无法登记不存在的文件。');
  const object = identity.object;
  return { id, ...facts, invocationPath: identity.invocationPath, canonicalPath: identity.canonicalPath,
    device: object.device, inode: object.inode, size: object.size, mtimeMs: object.mtimeMs, mtimeNs: object.mtimeNs,
    kind: object.kind, identity, status: 'available' };
}

function assertHandleIdentity(stat: BigIntStats, reference: FileReference): void {
  if (!stat.isFile() || String(stat.dev) !== reference.device || String(stat.ino) !== reference.inode
    || Number(stat.size) !== reference.size || String(stat.mtimeNs) !== reference.mtimeNs) {
    throw new FileReferenceError('FILE_CHANGED', '读取期间文件对象或内容版本已变化。');
  }
}
