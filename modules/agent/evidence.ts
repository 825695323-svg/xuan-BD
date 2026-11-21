import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CoreDatabase } from '../../platform/state/database.js';
import { CoreError } from '../../platform/runtime/errors.js';

export interface EvidenceScope { conversationId: string; branchId: string; subject: string; modelDigest: string }
export interface EvidenceSource { callId: string; runId: string; inputId: string; messageId: string }
export interface EvidenceReference { evidenceId: string; sha256: string; totalBytes: number; format: 'utf8' }
export interface EvidencePage extends EvidenceReference { text: string; startByte: number; endByte: number; nextCursor: string | null; done: boolean }
interface Row { id: string; scope_json: string; source_json: string; sha256: string; body: Uint8Array; total_bytes: number }
export const MAX_RETAINED_EVIDENCE_BYTES = 16 * 1024 * 1024;
export const MAX_EVIDENCE_PAGE_BYTES = 12_000;
const scopeText = (scope: EvidenceScope) => JSON.stringify([scope.conversationId, scope.branchId, scope.subject, scope.modelDigest]);
export const evidenceDigest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const invalid = () => new CoreError('INVALID_EVIDENCE', '证据身份、摘要或分页坐标不匹配，请重新核对原引用。', 409);

/** 仅保存已经获准分享的文本原件；任务、授权与副作用仍由原账本持有。 */
export class AgentEvidenceService {
  private readonly secret: Buffer;
  constructor(private readonly database: CoreDatabase) {
    database.migrate('agent_evidence', 1, `CREATE TABLE agent_evidence (
      id TEXT PRIMARY KEY,scope_json TEXT NOT NULL,source_json TEXT NOT NULL,sha256 TEXT NOT NULL,
      body BLOB NOT NULL,total_bytes INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE agent_evidence_secret (id INTEGER PRIMARY KEY CHECK(id=1),value BLOB NOT NULL);`);
    database.connection.prepare('INSERT OR IGNORE INTO agent_evidence_secret VALUES(1,?)').run(randomBytes(32));
    this.secret = Buffer.from(database.connection.prepare('SELECT value FROM agent_evidence_secret WHERE id=1').get()!.value as Uint8Array);
  }
  retain(scope: EvidenceScope, source: EvidenceSource, text: string): EvidenceReference {
    if (typeof text !== 'string') throw invalid();
    const body = Buffer.from(text, 'utf8');
    if (body.toString('utf8') !== text) throw invalid();
    if (body.length > MAX_RETAINED_EVIDENCE_BYTES) throw new CoreError('EVIDENCE_TOO_LARGE', '此证据超出本机有界保管上限，需使用原产物的专用读取入口。', 413);
    const sha256 = evidenceDigest(text), owner = scopeText(scope), origin = JSON.stringify(source);
    const id = 'ev-' + evidenceDigest(JSON.stringify([owner, origin, sha256]));
    this.database.connection.prepare('INSERT OR IGNORE INTO agent_evidence VALUES(?,?,?,?,?,?,?)')
      .run(id, owner, origin, sha256, body, body.length, Date.now());
    return { evidenceId: id, sha256, totalBytes: body.length, format: 'utf8' };
  }
  source(scope: EvidenceScope, id: string): EvidenceSource { return JSON.parse(this.row(scope, id).source_json) as EvidenceSource; }
  cursorFor(scope: EvidenceScope, reference: { evidenceId: string; sha256: string }, offset: number): string {
    const encoded = Buffer.from(JSON.stringify([reference.evidenceId, reference.sha256, scopeText(scope), offset])).toString('base64url');
    return encoded + '.' + createHmac('sha256', this.secret).update(encoded).digest('base64url');
  }
  decodeCursorOffset(scope: EvidenceScope, reference: { evidenceId: string; sha256: string }, cursor: string): number | null {
    if (typeof cursor !== 'string' || cursor.length > 4096) return null;
    const parts = cursor.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]
      || !/^[A-Za-z0-9_-]+$/u.test(parts[0]) || !/^[A-Za-z0-9_-]+$/u.test(parts[1])) return null;
    const [encoded, signature] = parts;
    const expected = createHmac('sha256', this.secret).update(encoded).digest(), provided = Buffer.from(signature, 'base64url');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== reference.evidenceId || parsed[1] !== reference.sha256
      || parsed[2] !== scopeText(scope) || typeof parsed[3] !== 'number' || !Number.isSafeInteger(parsed[3]) || parsed[3] < 0) return null;
    return parsed[3];
  }
  expectedPage(scope: EvidenceScope, reference: { evidenceId: string; sha256: string }, start: number, limit = 8000): EvidencePage | null {
    const retained = this.inspectRetained(scope, reference);
    if (!retained) return null;
    return this.slicePage(Buffer.from(retained.text, 'utf8'), reference, scope, start, limit);
  }
  read(scope: EvidenceScope, request: { evidenceId: string; sha256: string; cursor?: string; offset?: number; maxBytes?: number },
    assertAccess: (source: EvidenceSource) => void): EvidencePage {
    const row = this.row(scope, request.evidenceId), source = JSON.parse(row.source_json) as EvidenceSource;
    assertAccess(source);
    if (request.sha256 !== row.sha256) throw invalid();
    let start = request.offset ?? 0;
    if (request.cursor !== undefined) {
      if (request.offset !== undefined) throw invalid();
      const decoded = this.decodeCursorOffset(scope, { evidenceId: row.id, sha256: row.sha256 }, request.cursor);
      if (decoded === null) throw invalid();
      start = decoded;
    }
    const limit = request.maxBytes ?? 8000;
    const body = Buffer.from(row.body);
    if (body.length !== row.total_bytes || createHash('sha256').update(body).digest('hex') !== row.sha256) throw invalid();
    const result = this.slicePage(body, { evidenceId: row.id, sha256: row.sha256 }, scope, start, limit);
    if (!result) throw invalid();
    assertAccess(source);
    return result;
  }
  private slicePage(body: Buffer, reference: { evidenceId: string; sha256: string }, scope: EvidenceScope,
    start: number, limit: number): EvidencePage | null {
    if (!Number.isSafeInteger(start) || start < 0 || start > body.length
      || !Number.isSafeInteger(limit) || limit < 4 || limit > 8000
      || start < body.length && (body[start]! & 0xc0) === 0x80) return null;
    let end = Math.min(body.length, start + limit);
    const page = (): EvidencePage => {
      while (end < body.length && (body[end]! & 0xc0) === 0x80) end -= 1;
      const cursor = this.cursorFor(scope, reference, end);
      return { evidenceId: reference.evidenceId, sha256: reference.sha256, totalBytes: body.length, format: 'utf8',
        text: body.subarray(start, end).toString('utf8'),
        startByte: start, endByte: end, nextCursor: end < body.length ? cursor : null, done: end === body.length };
    };
    let result = page();
    while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_EVIDENCE_PAGE_BYTES && end > start) {
      end = start + Math.floor((end - start) * 0.8); result = page();
    }
    if (!result.done && end <= start) return null;
    return result;
  }
  inspectRetained(scope: EvidenceScope, reference: { evidenceId: string; sha256: string }): { source: EvidenceSource; text: string } | null {
    try {
      const row = this.row(scope, reference.evidenceId);
      if (row.sha256 !== reference.sha256) return null;
      const body = Buffer.from(row.body);
      if (body.length !== row.total_bytes || createHash('sha256').update(body).digest('hex') !== row.sha256) return null;
      const text = body.toString('utf8');
      if (Buffer.byteLength(text, 'utf8') !== row.total_bytes) return null;
      return { source: JSON.parse(row.source_json) as EvidenceSource, text };
    } catch { return null; }
  }
  private row(scope: EvidenceScope, id: string): Row {
    const row = this.database.connection.prepare('SELECT * FROM agent_evidence WHERE id=?').get(id) as unknown as Row | undefined;
    if (!row || row.scope_json !== scopeText(scope) || row.id !== 'ev-' + evidenceDigest(JSON.stringify([row.scope_json, row.source_json, row.sha256]))) throw invalid();
    return row;
  }
}
