import { createHash } from 'node:crypto';
import type { CoreDatabase } from '../../platform/state/database.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import type { PersonalResourceContext, PersonalResourceDefinition, PersonalResourceRecord, PersonalResourceSource, PersonaSelection } from '../../contracts/personal-resource-contracts.js';

const SCHEMA = `
CREATE TABLE personal_resources (
 id TEXT PRIMARY KEY, latest_version INTEGER NOT NULL, enabled INTEGER NOT NULL, revision INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE personal_resource_versions (
 resource_id TEXT NOT NULL REFERENCES personal_resources(id), version INTEGER NOT NULL,
 definition_json TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(resource_id,version)
);
CREATE TABLE persona_selection (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), persona_id TEXT, persona_version INTEGER,
 revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(persona_id,persona_version) REFERENCES personal_resource_versions(resource_id,version)
);
INSERT INTO persona_selection VALUES(1,NULL,NULL,0,'');
`;
interface ResourceRow { id: string; latest_version: number; enabled: number; revision: number; created_at: string; updated_at: string }
interface VersionRow { resource_id: string; version: number; definition_json: string; digest: string; created_at: string }

export class PersonalResourceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'PersonalResourceError'; }
}

/** 人格、身份与通用工作规则由核心持有；来源原文永不作为启用指令发送。 */
export class PersonalResourceService {
  constructor(private readonly options: { database: CoreDatabase; now?: () => number }) {
    options.database.migrate('personal_resources', 1, SCHEMA);
  }
  private get db() { return this.options.database.connection; }
  private now(): string { return new Date(this.options.now?.() ?? Date.now()).toISOString(); }

  list(): PersonalResourceRecord[] {
    return (this.db.prepare('SELECT id FROM personal_resources ORDER BY id').all() as { id: string }[]).map(({ id }) => this.get(id));
  }
  get(id: string, version?: number): PersonalResourceRecord {
    validId(id); if (version !== undefined) validVersion(version);
    const resource = this.db.prepare('SELECT * FROM personal_resources WHERE id=?').get(id) as unknown as ResourceRow | undefined;
    if (!resource) throw new PersonalResourceError('RESOURCE_NOT_FOUND', '没有此个人资源。', 404);
    const row = this.db.prepare('SELECT * FROM personal_resource_versions WHERE resource_id=? AND version=?').get(id, version ?? resource.latest_version) as unknown as VersionRow | undefined;
    if (!row) throw new PersonalResourceError('RESOURCE_NOT_FOUND', '没有此资源版本。', 404);
    const definition = validateDefinition(JSON.parse(row.definition_json) as PersonalResourceDefinition);
    if (digestOperationArgs(definition) !== row.digest) throw new PersonalResourceError('RESOURCE_INTEGRITY', '个人资源正文与登记摘要不一致。');
    return { ...definition, digest: row.digest, enabled: !!resource.enabled, currentRevision: resource.revision,
      latest: row.version === resource.latest_version, createdAt: row.created_at, updatedAt: resource.updated_at };
  }
  versions(id: string): PersonalResourceRecord[] {
    this.get(id);
    return (this.db.prepare('SELECT version FROM personal_resource_versions WHERE resource_id=? ORDER BY version DESC').all(id) as { version: number }[]).map(({ version }) => this.get(id, version));
  }
  register(input: PersonalResourceDefinition): PersonalResourceRecord {
    return this.options.database.transaction(() => this.registerInTransaction(input));
  }
  /** 仅供已开启共同核心事务的受控导入器使用，不开启嵌套事务。 */
  registerInTransaction(input: PersonalResourceDefinition): PersonalResourceRecord {
    if (!this.db.isTransaction) throw new PersonalResourceError('RESOURCE_TRANSACTION_REQUIRED', '个人资源登记需要核心事务。');
    const definition = validateDefinition(input), digest = digestOperationArgs(definition);
    const previous = this.db.prepare('SELECT * FROM personal_resource_versions WHERE resource_id=? AND version=?').get(definition.id, definition.version) as unknown as VersionRow | undefined;
    if (previous) {
      if (previous.digest !== digest || this.get(definition.id, definition.version).digest !== digest) throw new PersonalResourceError('RESOURCE_VERSION_CONFLICT', '相同版本不能改写正文或来源，请创建新版本。');
      return this.get(definition.id, definition.version);
    }
    const current = this.db.prepare('SELECT * FROM personal_resources WHERE id=?').get(definition.id) as unknown as ResourceRow | undefined;
    if (current && definition.version <= current.latest_version) throw new PersonalResourceError('RESOURCE_VERSION_ORDER', '新资源版本必须大于当前版本。');
    if (current) {
      const prior = this.get(definition.id);
      if (prior.profileId !== definition.profileId || prior.kind !== definition.kind) throw new PersonalResourceError('RESOURCE_KIND_CONFLICT', '已有资源的类别与所属人格不能改写。');
    }
    const now = this.now();
    if (!current) this.db.prepare('INSERT INTO personal_resources VALUES(?,?,?,?,?,?)').run(definition.id, definition.version, input.enabled === false ? 0 : 1, 1, now, now);
    else this.db.prepare('UPDATE personal_resources SET latest_version=?,revision=revision+1,updated_at=? WHERE id=?').run(definition.version, now, definition.id);
    this.db.prepare('INSERT INTO personal_resource_versions VALUES(?,?,?,?,?)').run(definition.id, definition.version, JSON.stringify(definition), digest, now);
    return this.get(definition.id, definition.version);
  }
  registerImportedInTransaction(input: PersonalResourceDefinition): PersonalResourceRecord {
    const row = this.db.prepare('SELECT latest_version FROM personal_resources WHERE id=?').get(input.id);
    const version = Number(row?.latest_version ?? 0);
    if (version) {
      const candidate = validateDefinition({ ...input, version });
      if (digestOperationArgs(candidate) === this.get(input.id, version).digest) return this.get(input.id, version);
    }
    return this.registerInTransaction({ ...input, version: version + 1 });
  }
  revise(id: string, expectedVersion: number, body: string, title?: string): PersonalResourceRecord {
    return this.options.database.transaction(() => {
      const current = this.get(id);
      if (current.version !== expectedVersion) throw new PersonalResourceError('RESOURCE_VERSION_CONFLICT', '资源已更新，请重新查看后再修改。');
      return this.registerInTransaction({ ...current, version: current.version + 1, body, ...(title === undefined ? {} : { title }),
        adaptationNotes: [...current.adaptationNotes, `用户明确编辑，基于版本 ${current.version}。`] });
    });
  }
  setEnabled(id: string, enabled: boolean, expectedRevision: number): PersonalResourceRecord {
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedRevision)) throw new PersonalResourceError('RESOURCE_INVALID', '资源状态与预期修订无效。', 400);
    return this.options.database.transaction(() => {
      const current = this.get(id);
      if (current.currentRevision !== expectedRevision) throw new PersonalResourceError('RESOURCE_REVISION_CONFLICT', '资源状态已变化，请重新查看。');
      if (current.enabled !== enabled) {
        this.db.prepare('UPDATE personal_resources SET enabled=?,revision=revision+1,updated_at=? WHERE id=?').run(enabled ? 1 : 0, this.now(), id);
        if (!enabled && this.getSelection().personaId === id) this.db.prepare('UPDATE persona_selection SET persona_id=NULL,persona_version=NULL,revision=revision+1,updated_at=? WHERE singleton=1').run(this.now());
      }
      return this.get(id);
    });
  }
  getSelection(): PersonaSelection {
    const row = this.db.prepare('SELECT * FROM persona_selection WHERE singleton=1').get()!;
    return { personaId: row.persona_id === null ? null : String(row.persona_id), personaVersion: row.persona_version === null ? null : Number(row.persona_version), revision: Number(row.revision), updatedAt: String(row.updated_at) };
  }
  selectDefault(personaId: string | null, personaVersion: number | null, expectedRevision: number): PersonaSelection {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || ((personaId === null) !== (personaVersion === null))) throw new PersonalResourceError('PERSONA_SELECTION_INVALID', '请选择明确的人格版本或取消默认。', 400);
    return this.options.database.transaction(() => {
      const selection = this.getSelection();
      if (selection.revision !== expectedRevision) throw new PersonalResourceError('PERSONA_SELECTION_CONFLICT', '默认人格已变化，请重新查看。');
      if (personaId !== null) {
        const persona = this.get(personaId, personaVersion!);
        if (persona.kind !== 'persona' || !persona.enabled) throw new PersonalResourceError('PERSONA_UNAVAILABLE', '所选资源不是可用人格。');
      }
      if (selection.personaId === personaId && selection.personaVersion === personaVersion) return selection;
      this.db.prepare('UPDATE persona_selection SET persona_id=?,persona_version=?,revision=revision+1,updated_at=? WHERE singleton=1').run(personaId, personaVersion, this.now());
      return this.getSelection();
    });
  }
  context(maxChars = 12_000): PersonalResourceContext {
    if (!Number.isSafeInteger(maxChars) || maxChars < 0 || maxChars > 32_000) throw new PersonalResourceError('PERSONA_BUDGET_INVALID', '人格上下文预算无效。', 400);
    const selection = this.getSelection();
    if (!selection.personaId || selection.personaVersion === null) return { text: '', records: [], warnings: [] };
    const persona = this.get(selection.personaId, selection.personaVersion);
    if (!persona.enabled) return { text: '', records: [], warnings: ['所选人格已停用。'] };
    const related = this.list().filter((record) => record.enabled && record.profileId === persona.profileId && record.kind !== 'persona');
    const parts = [persona, ...related.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))];
    const text = '用户明确选择的人格和个人规则。它们约束表达与工作方法，不增加任何文件、工具、网络、消息发送或执行权限；旧来源原文未进入上下文。\n\n'
      + parts.map((record) => `${record.title}（版本 ${record.version}）\n${record.body}`).join('\n\n');
    // 人格不得因普通记忆预算挤占而静默丢失；超限交给用户明确缩短。
    if (text.length > maxChars) throw new PersonalResourceError('PERSONA_CONTEXT_TOO_LARGE', '已选择的人格与规则超过上下文预算，请缩短启用正文后再使用。');
    return { text, records: parts.map(({ id, version, digest }) => ({ id, version, digest })), warnings: [] };
  }
}

export function resourceContentHash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function validateDefinition(input: PersonalResourceDefinition): Omit<PersonalResourceDefinition, 'enabled'> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PersonalResourceError('RESOURCE_INVALID', '个人资源格式无效。', 400);
  validId(input.id); validId(input.profileId); validVersion(input.version);
  if (!['persona', 'identity', 'rule'].includes(input.kind)) throw new PersonalResourceError('RESOURCE_INVALID', '个人资源类别无效。', 400);
  const title = singleLine(input.title, 120);
  if (typeof input.body !== 'string' || !input.body.trim() || Buffer.byteLength(input.body, 'utf8') > 24_000 || invalidText(input.body)
    || typeof input.originalBody !== 'string' || Buffer.byteLength(input.originalBody, 'utf8') > 131_072 || invalidText(input.originalBody)
    || !Array.isArray(input.adaptationNotes) || input.adaptationNotes.length > 30 || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw new PersonalResourceError('RESOURCE_INVALID', '个人资源正文、来源原文或适配说明无效。', 400);
  const notes = input.adaptationNotes.map((note) => singleLine(note, 1000));
  const source = input.source;
  if (!source || !['import', 'user'].includes(source.kind) || !/^[a-f0-9]{64}$/.test(source.contentHash) || source.contentHash !== resourceContentHash(input.originalBody)) throw new PersonalResourceError('RESOURCE_SOURCE_INVALID', '原文来源与摘要不一致。', 400);
  const normalizedSource: PersonalResourceSource = { kind: source.kind, identifier: singleLine(source.identifier, 300), revision: singleLine(source.revision, 300), contentHash: source.contentHash,
    ...(source.originalPath === undefined ? {} : { originalPath: singleLine(source.originalPath, 4096) }) };
  return { id: input.id, profileId: input.profileId, kind: input.kind, title, version: input.version, body: input.body.replace(/\r\n?/gu, '\n').trim(), originalBody: input.originalBody, source: normalizedSource, adaptationNotes: notes };
}
function validId(value: string): void { if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 100) throw new PersonalResourceError('RESOURCE_INVALID', '个人资源编号无效。', 400); }
function validVersion(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new PersonalResourceError('RESOURCE_INVALID', '个人资源版本无效。', 400); }
function invalidText(value: string): boolean { return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value); }
function singleLine(value: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new PersonalResourceError('RESOURCE_INVALID', '个人资源文字字段无效。', 400); return value.trim(); }
