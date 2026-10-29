import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CoreDatabase } from '../../platform/state/database.js';
import { CoreError } from '../../platform/runtime/errors.js';

export interface EvidenceScope { conversationId: string; branchId: string; subject: string; modelDigest: string }
export interface EvidenceSource { callId: string; runId: string; inputId: string; messageId: string }
export interface EvidenceReference { evidenceId: string; sha256: string; totalBytes: number; format: 'utf8' }
export interface EvidencePage extends EvidenceReference { text: string; startByte: number; endByte: number; nextCursor: string | null; done: boolean }
interface Row { id: string; scope_json: string; source_json: string; sha256: string; body: Uint8Array; total_bytes: number }
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
    if (body.length > 16 * 1024 * 1024) throw new CoreError('EVIDENCE_TOO_LARGE', '此证据超出本机有界保管上限，需使用原产物的专用读取入口。', 413);
    const sha256 = evidenceDigest(text), owner = scopeText(scope), origin = JSON.stringify(source);
    const id = 'ev-' + evidenceDigest(JSON.stringify([owner, origin, sha256]));
    this.database.connection.prepare('INSERT OR IGNORE INTO agent_evidence VALUES(?,?,?,?,?,?,?)')
      .run(id, owner, origin, sha256, body, body.length, Date.now());
    return { evidenceId: id, sha256, totalBytes: body.length, format: 'utf8' };
  }
  source(scope: EvidenceScope, id: string): EvidenceSource { return JSON.parse(this.row(scope, id).source_json) as EvidenceSource; }
  read(scope: EvidenceScope, request: { evidenceId: string; sha256: string; cursor?: string; offset?: number; maxBytes?: number },
    assertAccess: (source: EvidenceSource) => void): EvidencePage {
    const row = this.row(scope, request.evidenceId), source = JSON.parse(row.source_json) as EvidenceSource;
    assertAccess(source);
    if (request.sha256 !== row.sha256) throw invalid();
    let start = request.offset ?? 0;
    if (request.cursor !== undefined) {
      if (request.offset !== undefined || request.cursor.length > 4096) throw invalid();
      const [encoded, signature, extra] = request.cursor.split('.');
      if (!encoded || !signature || extra) throw invalid();
      const expected = createHmac('sha256', this.secret).update(encoded).digest(), provided = Buffer.from(signature, 'base64url');
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw invalid();
      let cursor: unknown; try { cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw invalid(); }
      if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== row.id || cursor[1] !== row.sha256 || cursor[2] !== scopeText(scope)) throw invalid();
      start = cursor[3] as number;
    }
    const limit = request.maxBytes ?? 8000;
    if (!Number.isSafeInteger(start) || start < 0 || start > row.total_bytes || !Number.isSafeInteger(limit) || limit < 4 || limit > 8000) throw invalid();
    const body = Buffer.from(row.body);
    if (body.length !== row.total_bytes || createHash('sha256').update(body).digest('hex') !== row.sha256
      || start < body.length && (body[start]! & 0xc0) === 0x80) throw invalid();
    let end = Math.min(body.length, start + limit);
    const page = (): EvidencePage => {
      while (end < body.length && (body[end]! & 0xc0) === 0x80) end -= 1;
      const encoded = Buffer.from(JSON.stringify([row.id, row.sha256, scopeText(scope), end])).toString('base64url');
      const cursor = encoded + '.' + createHmac('sha256', this.secret).update(encoded).digest('base64url');
      return { evidenceId: row.id, sha256: row.sha256, totalBytes: body.length, format: 'utf8', text: body.subarray(start, end).toString('utf8'),
        startByte: start, endByte: end, nextCursor: end < body.length ? cursor : null, done: end === body.length };
    };
    let result = page();
    while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_EVIDENCE_PAGE_BYTES && end > start) {
      end = start + Math.floor((end - start) * 0.8); result = page();
    }
    if (!result.done && end <= start) throw invalid();
    assertAccess(source);
    return result;
  }
  private row(scope: EvidenceScope, id: string): Row {
    const row = this.database.connection.prepare('SELECT * FROM agent_evidence WHERE id=?').get(id) as unknown as Row | undefined;
    if (!row || row.scope_json !== scopeText(scope) || row.id !== 'ev-' + evidenceDigest(JSON.stringify([row.scope_json, row.source_json, row.sha256]))) throw invalid();
    return row;
  }
}
