import { randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../../platform/state/database.js';
import { memoryHash } from './memory.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import type { ContextLedgerInput, ContextLedgerRecord } from '../../contracts/memory-contracts.js';
import type { FrozenRunConfiguration } from '../../contracts/ui-contracts.js';

const SCHEMA = `
CREATE TABLE context_ledger (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), generation INTEGER NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversations(id), ordinal INTEGER NOT NULL,
 phase TEXT NOT NULL CHECK(phase='prepared'), manifest_json TEXT NOT NULL, manifest_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(run_id,generation,ordinal)
);
CREATE INDEX context_ledger_run ON context_ledger(run_id,generation,ordinal);
`;
interface Row { id: string; run_id: string; generation: number; conversation_id: string; ordinal: number; phase: 'prepared'; manifest_json: string; manifest_hash: string; created_at: string }
export class ContextLedgerError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'ContextLedgerError'; }
}

/** 仅持有上下文准备清单及摘要。正文、原文、私有来源与供应方接收状态均不写入此账本。 */
export class ContextLedgerService {
  constructor(private readonly options: {
    database: CoreDatabase;
    isRunActive: (runId: string, generation: number, conversationId: string) => boolean;
    now?: () => number;
  }) { options.database.migrate('context_ledger', 1, SCHEMA); }
  private get db() { return this.options.database.connection; }

  record(input: ContextLedgerInput): ContextLedgerRecord {
    const normalized = validateInput(input);
    return this.options.database.transaction(() => {
      this.assertActive(normalized);
      this.assertCurrentRecords(normalized);
      const row = this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS next FROM context_ledger WHERE run_id=? AND generation=?').get(normalized.runId, normalized.generation)!;
      const id = randomUUID(), ordinal = Number(row.next), createdAt = new Date(this.options.now?.() ?? Date.now()).toISOString();
      const manifestHash = digestOperationArgs(normalized);
      this.assertActive(normalized);
      this.db.prepare('INSERT INTO context_ledger VALUES(?,?,?,?,?,?,?,?,?)').run(id, normalized.runId, normalized.generation, normalized.conversationId, ordinal, 'prepared', JSON.stringify(normalized), manifestHash, createdAt);
      return { ...normalized, id, ordinal, phase: 'prepared', manifestHash, createdAt };
    });
  }
  get(id: string): ContextLedgerRecord {
    validId(id);
    const row = this.db.prepare('SELECT * FROM context_ledger WHERE id=?').get(id) as unknown as Row | undefined;
    if (!row) throw new ContextLedgerError('CONTEXT_LEDGER_NOT_FOUND', '没有此上下文准备记录。', 404);
    const manifest = validateInput(JSON.parse(row.manifest_json) as ContextLedgerInput);
    if (digestOperationArgs(manifest) !== row.manifest_hash || manifest.runId !== row.run_id || manifest.generation !== row.generation || manifest.conversationId !== row.conversation_id || row.phase !== 'prepared') throw new ContextLedgerError('CONTEXT_LEDGER_INTEGRITY', '上下文准备记录与登记摘要不一致。');
    return { ...manifest, id: row.id, ordinal: row.ordinal, phase: 'prepared', manifestHash: row.manifest_hash, createdAt: row.created_at };
  }
  list(runId: string, limit = 100): ContextLedgerRecord[] {
    validId(runId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ContextLedgerError('CONTEXT_LEDGER_INVALID', '上下文账本查询数量无效。', 400);
    return this.db.prepare('SELECT id FROM context_ledger WHERE run_id=? ORDER BY generation DESC,ordinal DESC LIMIT ?').all(runId, limit).map((row) => this.get(String(row.id)));
  }
  private assertActive(input: ContextLedgerInput): void {
    let active = false;
    try { active = this.options.isRunActive(input.runId, input.generation, input.conversationId) === true; } catch { /* owner不可用即拒绝登记 */ }
    const run = this.db.prepare('SELECT conversation_id,generation FROM runs WHERE id=?').get(input.runId);
    if (!active || !run || run.conversation_id !== input.conversationId || Number(run.generation) !== input.generation) throw new ContextLedgerError('CONTEXT_LEDGER_STALE_RUN', '旧运行或不匹配的会话不能登记新上下文。');
  }
  private assertCurrentRecords(input: ContextLedgerInput): void {
    const conversation = this.db.prepare('SELECT project_id FROM conversations WHERE id=?').get(input.conversationId);
    const scopes = new Set(['global', `conversation:${input.conversationId}`, ...(conversation?.project_id ? [`project:${String(conversation.project_id)}`] : [])]);
    for (const record of input.memoryRecords) {
      const current = this.db.prepare('SELECT version,text,status,model_allowed,scope_key,category,topic FROM memories WHERE id=?').get(record.id);
      if (!current || Number(current.version) !== record.version || current.status !== 'confirmed' || Number(current.model_allowed) !== 1 || !scopes.has(String(current.scope_key)) || memoryHash(current.text) !== record.contentHash) throw new ContextLedgerError('CONTEXT_LEDGER_MEMORY_CHANGED', '记忆已修改、停用、删除或不属于当前作用域，需要重新构造上下文。');
      if (this.db.prepare("SELECT 1 FROM memories WHERE scope_key=? AND category=? AND topic=? AND status='conflict' LIMIT 1").get(current.scope_key!, current.category!, current.topic!)) throw new ContextLedgerError('CONTEXT_LEDGER_MEMORY_CHANGED', '记忆主题存在待解决冲突，需要重新构造上下文。');
    }
    const snapshot = this.db.prepare('SELECT configuration_json FROM runs WHERE id=?').get(input.runId);
    if (snapshot?.configuration_json) {
      const frozen = JSON.parse(String(snapshot.configuration_json)) as FrozenRunConfiguration;
      if (digestOperationArgs(frozen.personaRecords) !== digestOperationArgs(input.personaRecords)) {
        throw new ContextLedgerError('CONTEXT_LEDGER_PERSONA_CHANGED', '本轮人设清单与已接收的固定版本不一致。');
      }
      const rows = input.personaRecords.map(record => {
        const version = this.db.prepare('SELECT definition_json,digest FROM personal_resource_versions WHERE resource_id=? AND version=?').get(record.id, record.version);
        if (!version || version.digest !== record.digest || digestOperationArgs(JSON.parse(String(version.definition_json))) !== record.digest) {
          throw new ContextLedgerError('CONTEXT_LEDGER_PERSONA_CHANGED', '本轮固定人设的原版本或摘要无法核对。');
        }
        return JSON.parse(String(version.definition_json)) as { kind: string; profileId: string };
      });
      if (rows.length && (rows[0]!.kind !== 'persona' || rows.slice(1).some(row => row.kind === 'persona' || row.profileId !== rows[0]!.profileId))) {
        throw new ContextLedgerError('CONTEXT_LEDGER_PERSONA_CHANGED', '本轮固定人设与关联规则的归属不一致。');
      }
      return;
    }
    if (!input.personaRecords.length) return;
    const selection = this.db.prepare('SELECT persona_id,persona_version FROM persona_selection WHERE singleton=1').get();
    const selected = input.personaRecords.find((record) => record.id === selection?.persona_id && record.version === Number(selection?.persona_version));
    if (!selected) throw new ContextLedgerError('CONTEXT_LEDGER_PERSONA_CHANGED', '默认人格选择已变化，需要重新构造上下文。');
    const rows = input.personaRecords.map((record) => {
      const current = this.db.prepare(`SELECT r.enabled,r.latest_version,v.digest,json_extract(v.definition_json,'$.kind') AS kind,json_extract(v.definition_json,'$.profileId') AS profile_id
        FROM personal_resource_versions v JOIN personal_resources r ON r.id=v.resource_id WHERE v.resource_id=? AND v.version=?`).get(record.id, record.version);
      if (!current || Number(current.enabled) !== 1 || current.digest !== record.digest) throw new ContextLedgerError('CONTEXT_LEDGER_PERSONA_CHANGED', '人格或个人规则版本已失效，需要重新构造上下文。');
      if (current.kind !== 'persona' && Number(current.latest_version) !== record.version) throw new ContextLedgerError('CONTEXT_LEDGER_PERSONA_CHANGED', '关联身份或工作规则已修订，需要重新构造上下文。');
      return { id: record.id, kind: String(current.kind), profile_id: String(current.profile_id) };
    });
    const persona = rows.find((record) => record.id === selected.id);
    if (persona?.kind !== 'persona' || rows.some((record) => record.profile_id !== persona.profile_id || (record.kind === 'persona' && record.id !== selected.id))) throw new ContextLedgerError('CONTEXT_LEDGER_PERSONA_CHANGED', '上下文人格与关联身份、规则不匹配。');
  }
}

function validateInput(input: ContextLedgerInput): ContextLedgerInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContextLedgerError('CONTEXT_LEDGER_INVALID', '上下文准备记录格式无效。', 400);
  validId(input.runId); validId(input.conversationId);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !Array.isArray(input.memoryRecords) || input.memoryRecords.length > 256 || !Array.isArray(input.personaRecords) || input.personaRecords.length > 30) throw new ContextLedgerError('CONTEXT_LEDGER_INVALID', '上下文版本清单或运行代次无效。', 400);
  const memoryRecords = input.memoryRecords.map((record) => { validReference(record, record?.contentHash); return { id: record.id, version: record.version, contentHash: record.contentHash }; });
  const personaRecords = input.personaRecords.map((record) => { validReference(record, record?.digest); return { id: record.id, version: record.version, digest: record.digest }; });
  if (new Set(memoryRecords.map(({ id }) => id)).size !== memoryRecords.length || new Set(personaRecords.map(({ id }) => id)).size !== personaRecords.length) throw new ContextLedgerError('CONTEXT_LEDGER_INVALID', '同一次上下文不能包含相同资源的多个版本。', 400);
  return { runId: input.runId, generation: input.generation, conversationId: input.conversationId, memoryRecords, personaRecords };
}
function validId(value: string): void { if (typeof value !== 'string' || !value || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ContextLedgerError('CONTEXT_LEDGER_INVALID', '上下文记录编号无效。', 400); }
function validReference(value: { id: string; version: number } | null | undefined, hash: string): void {
  if (!value || typeof value !== 'object') throw new ContextLedgerError('CONTEXT_LEDGER_INVALID', '上下文资源引用无效。', 400);
  validId(value.id);
  if (!Number.isSafeInteger(value.version) || value.version < 1 || typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)) throw new ContextLedgerError('CONTEXT_LEDGER_INVALID', '上下文引用需要确定版本和摘要。', 400);
}
