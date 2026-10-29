import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError } from '../../platform/jobs/tasks.js';
import type { ConversationUserCycleBinding } from '../../modules/collection/conversation-data-cycle.js';
import type { GenericDatabaseBinding, GenericEnvelope } from './generic-transport.js';
type DatabaseRequest = Pick<WfdEnvelope, 'instance_id' | 'request_id' | 'operation' | 'arguments'>;
import { canonicalWfdJson, wfdSha256, type WfdEnvelope, type WfdRecord } from './wfd-transport.js';

/** Endpoint is deliberately absent: rediscovery may change it without changing this identity. */
export interface DatabaseLineIdentity {
  connectionId: string; instanceId: string; principalId: string; mode: string; purpose: string;
  protocol: string; protocolRevision: string; schemaSha256: string; credentialReference: string; runtimeRoot: string;
  libraryRoot?: string; storageBindingSha256?: string; storageId?: string; harnessRootId?: string;
}
export interface DatabaseLineVerification {
  identity: DatabaseLineIdentity; capabilities: WfdRecord;
  fixedRead: { state: 'verified'; datasetId: string; snapshotId: string; sha256: string }
    | { state: 'empty'; datasetIds: string[]; reason: string };
}
export interface DatabaseLineRegistration {
  identity: DatabaseLineIdentity;
  /** Only a host-authenticated, freshly discovered adapter may be registered here. */
  binding?: ConversationUserCycleBinding;
  generic?: GenericDatabaseBinding;
  verify(): Promise<DatabaseLineVerification>;
}
type Selection = { revision: number; connectionId: string; previousConnectionId: string | null; pendingId: string | null };
type BindingRow = { connection_id: string; identity_sha256: string };
const fail = (code: string, message: string): never => { throw new TaskError(code, message); };
const digest = (identity: DatabaseLineIdentity) => wfdSha256(canonicalWfdJson(identity));
function validateIdentity(identity: DatabaseLineIdentity) {
  const required = ['connectionId', 'instanceId', 'principalId', 'mode', 'purpose', 'protocol', 'protocolRevision', 'schemaSha256', 'credentialReference', 'runtimeRoot'];
  if (required.some(key => typeof identity[key as keyof DatabaseLineIdentity] !== 'string' || !identity[key as keyof DatabaseLineIdentity])
    || Object.values(identity).some(value => typeof value !== 'string' || !value.length)
    || !/^[a-f0-9]{64}$/.test(identity.schemaSha256) || !isAbsolute(identity.runtimeRoot)
    || (identity.libraryRoot !== undefined && !isAbsolute(identity.libraryRoot))
    || (identity.storageBindingSha256 !== undefined && !/^[a-f0-9]{64}$/.test(identity.storageBindingSha256))) fail('DATABASE_LINE_INVALID', '线路需要完整、可核的身份、绝对位置及模式/保管摘要。');
}
const sameLogicalIdentity = (left: DatabaseLineIdentity, right: DatabaseLineIdentity) =>
  ['connectionId', 'instanceId', 'principalId', 'mode', 'purpose', 'protocol', 'protocolRevision', 'schemaSha256', 'credentialReference']
    .every(key => left[key as keyof DatabaseLineIdentity] === right[key as keyof DatabaseLineIdentity])
    && (left.harnessRootId === undefined || left.harnessRootId === right.harnessRootId);

/** This stores connection identities and switch intents, never a second business-progress ledger. */
export class DatabaseLineService {
  private readonly lines = new Map<string, DatabaseLineRegistration>();
  private readonly businessLedgers = new Map<string, CoreDatabase>();
  private conversationAuthority: Parameters<ConversationUserCycleBinding['attachConversationAuthority']>[0] | undefined;
  constructor(private readonly options: { database: CoreDatabase; initialConnectionId: string; lines: readonly DatabaseLineRegistration[] }) {
    options.database.migrate('database_line_selection', 1, `
      CREATE TABLE database_line_identities(connection_id TEXT PRIMARY KEY,identity_json TEXT NOT NULL,identity_sha256 TEXT NOT NULL);
      CREATE TABLE database_line_selection(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,
        connection_id TEXT NOT NULL,previous_connection_id TEXT,pending_id TEXT);
      CREATE TABLE database_line_changes(id TEXT PRIMARY KEY,expected_revision INTEGER NOT NULL,from_connection_id TEXT NOT NULL,
        to_connection_id TEXT NOT NULL,state TEXT NOT NULL,verification_json TEXT,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE database_task_lines(task_id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,identity_sha256 TEXT NOT NULL);
      CREATE TABLE database_request_lines(request_id TEXT PRIMARY KEY,task_id TEXT,connection_id TEXT NOT NULL,identity_sha256 TEXT NOT NULL);`);
    options.database.migrate('database_line_locations', 1, `
      CREATE TABLE database_line_identity_history(identity_sha256 TEXT PRIMARY KEY,connection_id TEXT NOT NULL,identity_json TEXT NOT NULL);
      CREATE TABLE database_line_relocations(old_sha256 TEXT PRIMARY KEY,new_sha256 TEXT NOT NULL,connection_id TEXT NOT NULL,change_id TEXT NOT NULL);`);
    options.database.migrate('database_line_business_ledgers', 1, 'CREATE TABLE database_line_business_ledgers(path TEXT PRIMARY KEY);');
    for (const input of options.lines) {
      const identity = structuredClone(input.identity);
      validateIdentity(identity);
      this.assertLine({ ...input, identity });
      if (this.lines.has(identity.connectionId)) fail('DATABASE_LINE_DUPLICATE', '连接编号重复，不能隐式覆盖。');
      const saved = this.db.prepare('SELECT identity_sha256,identity_json FROM database_line_identities WHERE connection_id=?').get(identity.connectionId);
      if (saved && saved.identity_sha256 !== digest(identity)) {
        const pending = this.db.prepare("SELECT c.* FROM database_line_changes c JOIN database_line_selection s ON s.pending_id=c.id WHERE s.singleton=1 AND c.state LIKE 'maintenance%' AND c.from_connection_id=?").get(identity.connectionId);
        if (!pending || !sameLogicalIdentity(JSON.parse(String(saved.identity_json)) as DatabaseLineIdentity, identity)) fail('DATABASE_LINE_IDENTITY_CHANGED', '已登记连接身份发生变化；只有明确维护下同一实例的位置修订可待核，不能改绑逻辑身份。');
      }
      if (saved) this.db.prepare('INSERT OR IGNORE INTO database_line_identity_history VALUES(?,?,?)').run(String(saved.identity_sha256), identity.connectionId, String(saved.identity_json));
      this.db.prepare('INSERT OR IGNORE INTO database_line_identities VALUES(?,?,?)').run(identity.connectionId, canonicalWfdJson(identity), digest(identity));
      this.db.prepare('INSERT OR IGNORE INTO database_line_identity_history VALUES(?,?,?)').run(digest(identity), identity.connectionId, canonicalWfdJson(identity));
      this.lines.set(identity.connectionId, { ...input, identity: Object.freeze(identity) });
    }
    this.assertLine(this.registered(options.initialConnectionId));
    this.db.prepare('INSERT OR IGNORE INTO database_line_selection VALUES(1,1,?,NULL,NULL)').run(options.initialConnectionId);
    this.assertLine(this.registered(this.selection().connectionId));
    // A saved selection or pending intent is authoritative after restart; never reset to the default.
    this.adoptLegacyRequests();
  }
  private get db() { return this.options.database.connection; }
  private selection(): Selection {
    const row = this.db.prepare('SELECT * FROM database_line_selection WHERE singleton=1').get()!;
    return { revision: Number(row.revision), connectionId: String(row.connection_id), previousConnectionId: row.previous_connection_id === null ? null : String(row.previous_connection_id), pendingId: row.pending_id === null ? null : String(row.pending_id) };
  }
  private registered(connectionId: string) {
    const line = this.lines.get(connectionId);
    if (!line) return fail('DATABASE_LINE_UNAVAILABLE', '原连接未装配或当前不可用；没有回退到其他线路。');
    return line;
  }
  private assertLine(line: DatabaseLineRegistration) {
    const { mode, purpose } = line.identity;
    if (!['user_test', 'production'].includes(mode) || purpose !== mode) fail('DATABASE_LINE_PURPOSE_MISMATCH', '数据库连接必须保留自身已登记的模式与用途。');
    if (mode === 'production' && (line.binding || line.generic)) fail('DATABASE_LINE_PRODUCTION_READ_ONLY', '正式连接当前只接受独立空只读合同，不能装配测试写入端口。');
  }
  attachBusinessDatabase(database: CoreDatabase) {
    if (database === this.options.database || [...this.businessLedgers.values()].includes(database)) return;
    const key = database.path === ':memory:' ? 'memory:' + randomUUID() : resolve(database.path);
    database.connection.prepare('SELECT 1').get();
    this.businessLedgers.set(key, database);
    if (database.path !== ':memory:') this.db.prepare('INSERT OR IGNORE INTO database_line_business_ledgers VALUES(?)').run(key);
    this.adoptLegacyRequests();
    this.captureAcceptedTasks(database);
  }
  private missingBusinessLedgers(): string[] {
    return this.db.prepare('SELECT path FROM database_line_business_ledgers').all().map(row => String(row.path)).filter(path => !this.businessLedgers.has(path));
  }
  private ledgerDatabases(requireReady = true) {
    if (requireReady && this.missingBusinessLedgers().length) fail('DATABASE_LINE_LEDGER_UNAVAILABLE', '原业务账尚未由受信所有者挂齐，保持封闭，不从其他状态库猜测未决结果。');
    return [this.options.database, ...this.businessLedgers.values()];
  }
  status() {
    const selected = this.selection();
    const pending = selected.pendingId ? this.db.prepare('SELECT * FROM database_line_changes WHERE id=?').get(selected.pendingId) : null;
    return { ...selected, selected: this.lines.get(selected.connectionId)?.identity ?? null,
      registered: [...this.lines.values()].map(line => ({ ...line.identity, businessBound: !!line.binding, genericBound: !!line.generic })), pending: pending ?? null,
      businessLedgerReady: this.missingBusinessLedgers().length === 0, missingBusinessLedgers: this.missingBusinessLedgers(),
      dispatchBlocked: selected.pendingId !== null || this.missingBusinessLedgers().length !== 0, activeTaskIds: this.activeTaskIds(selected.connectionId), unresolved: this.pendingRequests(selected.connectionId, false).map(item => ({ id: item.id, state: item.state, requestId: item.envelope.request_id, instanceId: item.envelope.instance_id, operation: item.envelope.operation })) };
  }
  async verifySelected(input: { expectedRevision: number }) {
    this.ledgerDatabases();
    const selected = this.selection();
    if (selected.revision !== input.expectedRevision) fail('DATABASE_LINE_REVISION_CONFLICT', '只读核验需要当前选择修订。');
    const line = this.registered(selected.connectionId); this.assertLine(line);
    const verification = await line.verify(); this.assertVerification(line, verification);
    const after = this.selection();
    if (after.revision !== selected.revision || after.connectionId !== selected.connectionId || after.pendingId !== selected.pendingId) fail('DATABASE_LINE_REVISION_CONFLICT', '实际核验期间线路或维护意图已经变化。');
    return { ...this.status(), verification };
  }
  preview(input: { connectionId: string; expectedRevision: number }) {
    const selection = this.selection(), candidate = this.registered(input.connectionId);
    this.assertLine(candidate);
    if (selection.revision !== input.expectedRevision) fail('DATABASE_LINE_REVISION_CONFLICT', '线路选择已变化，请重新读取后再明确选择。');
    return { ...selection, from: this.registered(selection.connectionId).identity, to: candidate.identity,
      pending: this.pendingRequests(selection.connectionId).map(item => ({ id: item.id, state: item.state, requestId: item.envelope.request_id, instanceId: item.envelope.instance_id, operation: item.envelope.operation })), activeTaskIds: this.activeTaskIds(selection.connectionId), dataMoved: false };
  }
  /** Persist the freeze before any awaited query; concurrent selections cannot both acquire it. */
  async switch(input: { connectionId: string; expectedRevision: number }) {
    const candidate = this.registered(input.connectionId), changeId = randomUUID();
    this.assertLine(candidate);
    this.options.database.transaction(() => {
      const selected = this.selection();
      if (selected.revision !== input.expectedRevision) fail('DATABASE_LINE_REVISION_CONFLICT', '线路修订已变化。');
      if (selected.pendingId) fail('DATABASE_LINE_SWITCH_PENDING', '前次默认连接核对或维护仍待完成。');
      for (const database of this.ledgerDatabases()) this.captureAcceptedTasks(database);
      this.db.prepare('INSERT INTO database_line_changes VALUES(?,?,?,?,\'checking\',NULL,NULL,?,?)')
        .run(changeId, selected.revision, selected.connectionId, candidate.identity.connectionId, Date.now(), Date.now());
      this.db.prepare('UPDATE database_line_selection SET pending_id=? WHERE singleton=1').run(changeId);
    });
    return this.complete(changeId, false);
  }
  async beginMaintenance(input: { expectedRevision: number; connectionId: string }) {
    const line = this.registered(input.connectionId), id = randomUUID();
    this.assertLine(line);
    this.options.database.transaction(() => {
      const selected = this.selection();
      if (selected.revision !== input.expectedRevision || selected.connectionId !== input.connectionId) fail('DATABASE_LINE_REVISION_CONFLICT', '维护线路须为当前选择及修订。');
      if (selected.pendingId) fail('DATABASE_LINE_SWITCH_PENDING', '已有待核维护或切换。');
      this.db.prepare("INSERT INTO database_line_changes VALUES(?,?,?,?, 'maintenance',NULL,NULL,?,?)").run(id, selected.revision, input.connectionId, input.connectionId, Date.now(), Date.now());
      this.db.prepare('UPDATE database_line_selection SET pending_id=? WHERE singleton=1').run(id);
    });
    try { await this.reconcile(line); } catch {
      this.db.prepare("UPDATE database_line_changes SET state='maintenance-blocked',error_code='DATABASE_LINE_UNRESOLVED',updated_at=? WHERE id=?").run(Date.now(), id);
    }
    const status = this.status();
    return { ...status, maintenanceReady: status.businessLedgerReady && status.activeTaskIds.length === 0 && status.unresolved.length === 0 };
  }
  replaceMaintainedLine(input: { changeId: string; line: DatabaseLineRegistration }) {
    const selected = this.selection(), change = this.db.prepare('SELECT state FROM database_line_changes WHERE id=?').get(input.changeId);
    if (selected.pendingId !== input.changeId || !String(change?.state).startsWith('maintenance') || input.line.identity.connectionId !== selected.connectionId) fail('DATABASE_LINE_CHANGE_NOT_PENDING', '只有当前持久维护可替换同一连接的发现和位置。');
    const previous = this.registered(selected.connectionId);
    validateIdentity(input.line.identity);
    this.assertLine(input.line);
    if (!sameLogicalIdentity(previous.identity, input.line.identity)) fail('DATABASE_LINE_IDENTITY_CHANGED', '受控重启或位置维护不能更换实例、主体、协议或用途。');
    if (input.line.binding && this.conversationAuthority) input.line.binding.attachConversationAuthority(this.conversationAuthority);
    this.db.prepare('INSERT OR IGNORE INTO database_line_identity_history VALUES(?,?,?)').run(digest(input.line.identity), selected.connectionId, canonicalWfdJson(input.line.identity));
    this.lines.set(selected.connectionId, { ...input.line, identity: Object.freeze(structuredClone(input.line.identity)) });
  }
  async finishMaintenance(input: { changeId: string }) {
    const selected = this.selection(), change = this.db.prepare('SELECT * FROM database_line_changes WHERE id=?').get(input.changeId);
    if (selected.pendingId !== input.changeId || !String(change?.state).startsWith('maintenance')) fail('DATABASE_LINE_CHANGE_NOT_PENDING', '不是当前持久维护意图。');
    const line = this.registered(selected.connectionId);
    try { await this.reconcile(line); } catch { fail('DATABASE_LINE_UNRESOLVED', '原实例尚不可核，维护封闭保持。'); }
    if (this.activeTaskIds(selected.connectionId).length || this.pendingRequests(selected.connectionId).length) fail('DATABASE_LINE_UNRESOLVED', '维护后的原任务或请求仍未核清。');
    const verification = await line.verify(); this.assertVerification(line, verification);
    this.options.database.transaction(() => {
      const now = this.selection();
      if (now.pendingId !== input.changeId || now.revision !== selected.revision) fail('DATABASE_LINE_REVISION_CONFLICT', '维护意图已变化。');
      const previous = this.db.prepare('SELECT identity_json,identity_sha256 FROM database_line_identities WHERE connection_id=?').get(selected.connectionId)!;
      if (!sameLogicalIdentity(JSON.parse(String(previous.identity_json)) as DatabaseLineIdentity, line.identity)) fail('DATABASE_LINE_IDENTITY_CHANGED', '位置维护不能更换实例、主体或协议身份。');
      if (previous.identity_sha256 !== digest(line.identity)) {
        this.db.prepare('INSERT INTO database_line_relocations VALUES(?,?,?,?)').run(String(previous.identity_sha256), digest(line.identity), selected.connectionId, input.changeId);
        this.db.prepare('UPDATE database_line_identities SET identity_json=?,identity_sha256=? WHERE connection_id=?').run(canonicalWfdJson(line.identity), digest(line.identity), selected.connectionId);
      }
      this.db.prepare("UPDATE database_line_changes SET state='maintenance-completed',verification_json=?,updated_at=? WHERE id=?").run(canonicalWfdJson(verification), Date.now(), input.changeId);
      this.db.prepare('UPDATE database_line_selection SET pending_id=NULL WHERE singleton=1').run();
    });
    return { ...this.status(), verification };
  }
  async rollback(input: { expectedRevision: number }) {
    const selected = this.selection();
    if (!selected.previousConnectionId) fail('DATABASE_LINE_NO_ROLLBACK', '没有已记录的前一条线路。');
    return this.switch({ connectionId: selected.previousConnectionId!, expectedRevision: input.expectedRevision });
  }
  /** A crash in checking never silently selects either side; explicit recovery verifies again. */
  async recover(input: { changeId: string; action: 'complete' | 'abort' }) {
    if (this.selection().pendingId !== input.changeId) fail('DATABASE_LINE_CHANGE_NOT_PENDING', '不是当前待核切换。');
    const change = this.db.prepare('SELECT state FROM database_line_changes WHERE id=?').get(input.changeId);
    if (input.action === 'complete') return String(change?.state).startsWith('maintenance') ? this.finishMaintenance({ changeId: input.changeId }) : this.complete(input.changeId, true);
    const selection = this.selection();
    if (String(change?.state).startsWith('maintenance')) {
      const line = this.registered(selection.connectionId);
      const saved = this.db.prepare('SELECT identity_sha256 FROM database_line_identities WHERE connection_id=?').get(selection.connectionId)!;
      if (saved.identity_sha256 !== digest(line.identity)) fail('DATABASE_LINE_MAINTENANCE_VERIFY_REQUIRED', '位置已经变化，必须完成原实例的实际核验后解封，不能直接取消维护。');
      this.assertVerification(line, await line.verify());
      if (this.pendingRequests(selection.connectionId).length || this.activeTaskIds(selection.connectionId).length) fail('DATABASE_LINE_UNRESOLVED', '原实例仍有未决事实或活动任务，不能解除维护封闭。');
    }
    this.closeChange(input.changeId, 'aborted', 'MAINTENANCE_ABORT');
    return this.status();
  }
  private async complete(changeId: string, _recovering: boolean) {
    const change = this.db.prepare('SELECT * FROM database_line_changes WHERE id=?').get(changeId)!;
    try {
      const previous = this.registered(String(change.from_connection_id)), candidate = this.registered(String(change.to_connection_id));
      this.assertLine(previous); this.assertLine(candidate);
      const verification = await candidate.verify();
      this.assertVerification(candidate, verification);
      this.options.database.transaction(() => {
        const selected = this.selection();
        if (selected.pendingId !== changeId || selected.revision !== Number(change.expected_revision) || selected.connectionId !== change.from_connection_id) fail('DATABASE_LINE_REVISION_CONFLICT', '切换核对期间选择已经变化。');
        for (const database of this.ledgerDatabases()) this.captureAcceptedTasks(database);
        this.db.prepare('UPDATE database_line_selection SET revision=revision+1,previous_connection_id=connection_id,connection_id=?,pending_id=NULL WHERE singleton=1').run(candidate.identity.connectionId);
        this.db.prepare('UPDATE database_line_changes SET state=\'committed\',verification_json=?,updated_at=? WHERE id=?').run(canonicalWfdJson(verification), Date.now(), changeId);
      });
      return { ...this.status(), verification };
    } catch (error) {
      // Failure is an explicit rejected change, unless recovery itself lost its durable owner.
      if (this.selection().pendingId === changeId) {
        const code = error instanceof TaskError ? error.code : 'DATABASE_LINE_VERIFY_FAILED';
        if (code === 'DATABASE_LINE_UNRESOLVED') this.db.prepare("UPDATE database_line_changes SET state='blocked',error_code=?,updated_at=? WHERE id=?").run(code, Date.now(), changeId);
        else this.closeChange(changeId, 'rejected', code);
      }
      throw error;
    }
  }
  private closeChange(id: string, state: string, code: string) {
    this.options.database.transaction(() => {
      if (this.selection().pendingId !== id) fail('DATABASE_LINE_REVISION_CONFLICT', '切换所有者已变化。');
      this.db.prepare('UPDATE database_line_changes SET state=?,error_code=?,updated_at=? WHERE id=?').run(state, code, Date.now(), id);
      this.db.prepare('UPDATE database_line_selection SET pending_id=NULL WHERE singleton=1').run();
    });
  }
  private assertVerification(line: DatabaseLineRegistration, verification: DatabaseLineVerification) {
    if (digest(verification.identity) !== digest(line.identity)) fail('DATABASE_LINE_IDENTITY_MISMATCH', '实际鉴权身份与目标线路登记不一致。');
    const c = verification.capabilities;
    if (c.instance_id !== line.identity.instanceId || c.principal_id !== line.identity.principalId || c.mode !== line.identity.mode
      || c.protocol_schema_sha256 !== line.identity.schemaSha256 || c.schema_version !== line.identity.protocol
      || c.schema_revision !== line.identity.protocolRevision || c.purpose !== line.identity.purpose || !Array.isArray(c.operations) || !c.operations.includes('capabilities.search')) fail('DATABASE_LINE_CAPABILITIES_MISMATCH', '实际能力未证明实例、主体、模式摘要与权限。');
    if (line.identity.mode === 'production' && (c.production_enabled !== true || c.write_enabled !== false
      || c.admission_profile !== 'production-empty-read-only/v1' || !Array.isArray(c.capabilities) || c.capabilities.length !== 0
      || (c.operations as unknown[]).some(operation => !['capabilities.search', 'data.jobs.get', 'data.read', 'data.snapshots.resolve', 'data.coverage'].includes(String(operation))))) fail('DATABASE_LINE_PRODUCTION_READ_ONLY', '正式连接未证明当前独立空只读准入，不能作为新任务默认。');
    if (verification.fixedRead.state === 'verified') {
      if (!verification.fixedRead.datasetId || !verification.fixedRead.snapshotId || /^(latest|current)$/i.test(verification.fixedRead.snapshotId)
        || !/^[a-f0-9]{64}$/.test(verification.fixedRead.sha256)) fail('DATABASE_LINE_READ_UNVERIFIED', '切换需要具体快照及实际固定读回摘要。');
    } else if (!verification.fixedRead.reason || !Array.isArray(verification.fixedRead.datasetIds) || !Array.isArray(c.capabilities)
      || c.capabilities.some(item => !item || typeof item !== 'object' || (item as WfdRecord).head_snapshot_id !== null
        || (Array.isArray((item as WfdRecord).snapshot_ids) && ((item as WfdRecord).snapshot_ids as unknown[]).length))) fail('DATABASE_LINE_READ_UNVERIFIED', '空实例必须明确返回无固定快照的实际核对范围，不能伪造读回通过。');
  }
  /** 受信任务受理后即冻结连接；默认核验期间的新受理任务仍归原默认。 */
  captureAcceptedTask(task: { id: string; action: string; args: unknown }): void {
    if (this.db.prepare('SELECT 1 FROM database_task_lines WHERE task_id=?').get(task.id)) return;
    const input = task.args && typeof task.args === 'object' ? (task.args as WfdRecord).input : undefined;
    const snapshot = task.action === 'tools.call' && input && typeof input === 'object' && (input as WfdRecord).kind === 'snapshot';
    if (!['data.submit', 'results.publish', 'data.candidates.submit'].includes(task.action) && !snapshot) return;
    if (snapshot && ![...this.lines.values()].some(line => line.binding)) return;
    const line = snapshot ? (() => {
      const matches = [...this.lines.values()].filter(line => line.binding?.reader.getDeclaration(input as never));
      if (matches.length !== 1) return fail('DATABASE_LINE_REFERENCE_AMBIGUOUS', '金融任务固定输入必须能唯一核到原实例。');
      return matches[0]!;
    })() : this.registered(this.selection().connectionId);
    this.assertLine(line);
    this.db.prepare('INSERT INTO database_task_lines VALUES(?,?,?)').run(task.id, line.identity.connectionId, digest(line.identity));
  }
  captureAcceptedTasks(database: CoreDatabase): void {
    if (!this.hasTable('tasks', database)) return;
    for (const row of database.connection.prepare("SELECT id,action,args FROM tasks WHERE action IN ('data.submit','results.publish','tools.call','data.candidates.submit')").all()) {
      this.captureAcceptedTask({ id: String(row.id), action: String(row.action), args: JSON.parse(String(row.args)) });
    }
  }
  bindTask(taskId: string) {
    this.ledgerDatabases();
    let row = this.db.prepare('SELECT * FROM database_task_lines WHERE task_id=?').get(taskId) as BindingRow | undefined;
    if (!row) {
      const selected = this.selection();
      if (selected.pendingId) fail('DATABASE_LINE_DISPATCH_FROZEN', '线路核对中，不派发新的数据库任务。');
      const line = this.registered(selected.connectionId);
      this.db.prepare('INSERT INTO database_task_lines VALUES(?,?,?)').run(taskId, selected.connectionId, digest(line.identity));
      row = { connection_id: selected.connectionId, identity_sha256: digest(line.identity) };
    }
    return this.bound(row);
  }
  bindDerivedTask(taskId: string, originalTaskId: string) {
    const row = this.db.prepare('SELECT * FROM database_task_lines WHERE task_id=?').get(originalTaskId) as BindingRow | undefined;
    if (!row) return fail('DATABASE_LINE_REQUEST_UNBOUND', '续接须有原任务固定线路，不能采用当前全局默认。');
    const line = this.bound(row), selected = this.selection();
    if (selected.pendingId && line.identity.connectionId === selected.connectionId) fail('DATABASE_LINE_DISPATCH_FROZEN', '原线路正在维护核对，不派发业务续接。');
    const saved = this.db.prepare('SELECT * FROM database_task_lines WHERE task_id=?').get(taskId) as BindingRow | undefined;
    if (saved && (saved.connection_id !== row.connection_id || saved.identity_sha256 !== row.identity_sha256)) fail('DATABASE_LINE_REQUEST_REBOUND', '续接任务不能换绑另一实例。');
    this.db.prepare('INSERT OR IGNORE INTO database_task_lines VALUES(?,?,?)').run(taskId, row.connection_id, row.identity_sha256);
    return line;
  }
  private financialLine(taskId: string) {
    const saved = this.db.prepare('SELECT * FROM database_task_lines WHERE task_id=?').get(taskId) as BindingRow | undefined;
    if (saved) return this.bound(saved);
    const task = this.hasTable('tasks') ? this.db.prepare('SELECT args FROM tasks WHERE id=?').get(taskId) : undefined;
    const args = task ? JSON.parse(String(task.args)) as WfdRecord : null;
    if (args && args.input && typeof args.input === 'object' && (args.input as WfdRecord).kind === 'snapshot') {
      const matches = [...this.lines.values()].filter(line => line.binding?.reader.getDeclaration(args.input as never));
      if (matches.length !== 1) fail('DATABASE_LINE_REFERENCE_AMBIGUOUS', '金融任务固定输入必须能唯一核到原实例，不能按当前选择补猜。');
      if (this.selection().pendingId) fail('DATABASE_LINE_DISPATCH_FROZEN', '切换核对中不派发新金融任务。');
      const line = matches[0]!;
      this.db.prepare('INSERT INTO database_task_lines VALUES(?,?,?)').run(taskId, line.identity.connectionId, digest(line.identity));
      return line;
    }
    return this.bindTask(taskId);
  }
  private bound(row: BindingRow) {
    const line = this.registered(row.connection_id);
    this.assertLine(line);
    if (digest(line.identity) !== row.identity_sha256) {
      let hash = row.identity_sha256, verified = false;
      for (let depth = 0; depth < 32; depth++) {
        const relocation = this.db.prepare('SELECT new_sha256 FROM database_line_relocations WHERE old_sha256=? AND connection_id=?').get(hash, row.connection_id);
        if (!relocation) break;
        hash = String(relocation.new_sha256);
        if (hash === digest(line.identity)) { verified = true; break; }
      }
      const pending = this.db.prepare("SELECT c.id FROM database_line_changes c JOIN database_line_selection s ON s.pending_id=c.id WHERE c.state LIKE 'maintenance%' AND c.from_connection_id=?").get(row.connection_id);
      const original = this.db.prepare('SELECT identity_json FROM database_line_identity_history WHERE identity_sha256=? AND connection_id=?').get(row.identity_sha256, row.connection_id);
      if (!verified && !(pending && original && sameLogicalIdentity(JSON.parse(String(original.identity_json)) as DatabaseLineIdentity, line.identity))) fail('DATABASE_LINE_IDENTITY_CHANGED', '原任务连接不可核；未获证实的位置变更不能串线。');
    }
    return line;
  }
  pinRequest(envelope: DatabaseRequest, taskId: string) {
    const line = this.bindTask(taskId);
    const selected = this.selection();
    const maintenance = selected.pendingId ? this.db.prepare('SELECT state,from_connection_id FROM database_line_changes WHERE id=?').get(selected.pendingId) : undefined;
    if (String(maintenance?.state).startsWith('maintenance') && maintenance?.from_connection_id === line.identity.connectionId) fail('DATABASE_LINE_DISPATCH_FROZEN', '原连接仍在维护核对中，不派发新的外部请求。');
    if (envelope.instance_id !== line.identity.instanceId) fail('DATABASE_LINE_INSTANCE_MISMATCH', '新请求不是任务冻结的原实例。');
    const old = this.db.prepare('SELECT * FROM database_request_lines WHERE request_id=?').get(envelope.request_id) as BindingRow | undefined;
    if (old && (old.connection_id !== line.identity.connectionId || old.identity_sha256 !== digest(line.identity))) fail('DATABASE_LINE_REQUEST_REBOUND', '原请求不能改绑另一条线路。');
    this.db.prepare('INSERT OR IGNORE INTO database_request_lines VALUES(?,?,?,?)').run(envelope.request_id, taskId, line.identity.connectionId, digest(line.identity));
  }
  forEnvelope(envelope: DatabaseRequest) {
    const row = this.db.prepare('SELECT * FROM database_request_lines WHERE request_id=?').get(envelope.request_id) as BindingRow | undefined;
    if (!row) return fail('DATABASE_LINE_REQUEST_UNBOUND', '原外部请求缺少固定连接记录，拒绝使用当前全局线路猜测。');
    const line = this.bound(row);
    if (envelope.instance_id !== line.identity.instanceId) fail('DATABASE_LINE_INSTANCE_MISMATCH', '原封闭请求的实例与固定连接不符。');
    return line;
  }
  private hasTable(name: string, database = this.options.database) { return !!database.connection.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(name); }
  private adoptLegacyRequests() {
    for (const database of this.ledgerDatabases(false)) for (const table of ['conversation_data_cycles', 'conversation_result_publications']) {
      if (!this.hasTable(table, database)) continue;
      for (const row of database.connection.prepare(`SELECT request_id,envelope_json FROM ${table}`).all()) {
        const envelope = JSON.parse(String(row.envelope_json)) as WfdEnvelope;
        if (this.db.prepare('SELECT 1 FROM database_request_lines WHERE request_id=?').get(String(row.request_id))) continue;
        const candidates = [...this.lines.values()].filter(line => line.identity.instanceId === envelope.instance_id);
        if (candidates.length !== 1) fail('DATABASE_LINE_LEGACY_UNBOUND', '历史请求必须能唯一核到原实例连接，不能按当前线路补猜。');
        const line = candidates[0]!;
        const taskId = typeof envelope.arguments.processing_task_id === 'string' ? envelope.arguments.processing_task_id : null;
        if (taskId) {
          const savedTask = this.db.prepare('SELECT * FROM database_task_lines WHERE task_id=?').get(taskId) as BindingRow | undefined;
          if (savedTask && savedTask.connection_id !== line.identity.connectionId) fail('DATABASE_LINE_LEGACY_UNBOUND', '历史请求与原任务冻结连接不一致，保持原实例待核。');
          this.db.prepare('INSERT OR IGNORE INTO database_task_lines VALUES(?,?,?)').run(taskId, line.identity.connectionId, digest(line.identity));
        }
        this.db.prepare('INSERT INTO database_request_lines VALUES(?,?,?,?)').run(String(row.request_id), taskId, line.identity.connectionId, digest(line.identity));
      }
    }
  }
  private activeTaskIds(connectionId: string): string[] {
    const ids = this.db.prepare('SELECT task_id FROM database_task_lines WHERE connection_id=?').all(connectionId).map(row => String(row.task_id));
    const active = new Set<string>();
    for (const database of this.ledgerDatabases(false)) {
      if (!this.hasTable('tasks', database)) continue;
      for (const id of ids) {
        const task = database.connection.prepare('SELECT status FROM tasks WHERE id=?').get(id);
        if (task && !['succeeded', 'failed', 'cancelled'].includes(String(task.status))) active.add(id);
      }
    }
    return [...active];
  }
  private pendingRequests(connectionId: string, requireReady = true) {
    const pending: { database: CoreDatabase; table: string; id: string; envelope: WfdEnvelope; state: string }[] = [];
    for (const database of this.ledgerDatabases(requireReady)) for (const table of ['conversation_data_cycles', 'conversation_result_publications', 'candidate_submissions']) {
      if (!this.hasTable(table, database)) continue;
      for (const row of database.connection.prepare(`SELECT id,envelope_json,state FROM ${table} WHERE state NOT IN ('verified','failed','rejected','cancelled')`).all()) {
        const envelope = JSON.parse(String(row.envelope_json)) as WfdEnvelope;
        const line = this.forEnvelope(envelope);
        if (line.identity.connectionId === connectionId) pending.push({ database, table, id: String(row.id), envelope, state: String(row.state) });
      }
    }
    return pending;
  }
  private async reconcile(line: DatabaseLineRegistration) {
    for (const item of this.pendingRequests(line.identity.connectionId)) {
      if (item.table === 'candidate_submissions') {
        if (!line.generic) fail('DATABASE_LINE_UNRESOLVED', '原通用协议未装配，未决结果保持原身份待核。');
        const result = await line.generic!.call({ protocol_version: 3, contract_version: 'wfd.data-service/v1', instance_id: line.identity.instanceId,
          request_id: 'line-query:' + randomUUID(), operation: 'data.jobs.get', arguments: item.envelope.operation === 'data.submit' ? { request_id: item.envelope.request_id } : { submission_id: item.envelope.arguments.submission_id } });
        if (result.state !== 'not_found') item.database.connection.prepare('UPDATE candidate_submissions SET receipt_json=?,state=?,updated_at=? WHERE id=?').run(canonicalWfdJson(result), String(result.state), Date.now(), item.id);
        continue;
      }
      const binding = line.binding;
      if (!binding) fail('DATABASE_LINE_UNRESOLVED', '原线路业务端口不可用，未决结果保持原身份待核。');
      const receipt = item.table === 'conversation_data_cycles'
        ? await binding!.port.lookup(String(item.envelope.arguments.handoff_id))
        : await (() => { const target = binding!.publicationTargets.find(target => target.port.target.datasetId === item.envelope.arguments.dataset_id);
          if (!target) fail('DATABASE_LINE_UNRESOLVED', '原发布目标当前不可取回。');
          return target!.port.lookup(String(item.envelope.arguments.publication_id)); })();
      // committed is still blocked until the normal origin-scoped status path verifies its fixed read.
      item.database.connection.prepare(`UPDATE ${item.table} SET receipt_json=?,state=?,updated_at=? WHERE id=?`).run(canonicalWfdJson(receipt), String(receipt.state), Date.now(), item.id);
    }
  }
  genericStatus() {
    const selected = this.selection(), line = this.registered(selected.connectionId);
    return { available: !!line.generic && !selected.pendingId, connectionId: line.identity.connectionId, instanceId: line.identity.instanceId, purpose: line.identity.purpose,
      schemaSha256: line.generic?.contractDigest ?? null, maintenance: !!selected.pendingId };
  }
  genericCurrent(): GenericDatabaseBinding {
    this.ledgerDatabases();
    if (this.selection().pendingId) return fail('DATABASE_LINE_DISPATCH_FROZEN', '原数据库线路处于核对维护中。');
    return this.registered(this.selection().connectionId).generic ?? fail('DATABASE_LINE_GENERIC_UNBOUND', '当前实例尚无已发现的通用材料合同。');
  }
  genericForTask(taskId: string): GenericDatabaseBinding { return this.bindTask(taskId).generic ?? fail('DATABASE_LINE_GENERIC_UNBOUND', '原任务线路没有通用材料合同。'); }
  genericForEnvelope(envelope: GenericEnvelope): GenericDatabaseBinding { return this.forEnvelope(envelope).generic ?? fail('DATABASE_LINE_GENERIC_UNBOUND', '原请求线路的通用材料合同不可用。'); }
  businessBinding(): ConversationUserCycleBinding | undefined {
    return [...this.lines.values()].some(line => line.binding) ? this.binding() : undefined;
  }
  binding(): ConversationUserCycleBinding {
    const service = this, current = () => {
      const line = service.registered(service.selection().connectionId);
      if (!line.binding) return fail('DATABASE_LINE_BUSINESS_UNBOUND', '所选实例尚无获准业务目标，未借用测试合同。');
      return line.binding;
    };
    const required = (line: DatabaseLineRegistration) => line.binding ?? fail('DATABASE_LINE_BUSINESS_UNBOUND', '原线路的业务合同未装配。');
    const all = () => [...service.lines.values()].flatMap(line => line.binding ? [line.binding] : []);
    const declarations = (reference: Parameters<ConversationUserCycleBinding['reader']['getDeclaration']>[0]) => {
      const found = all().map(binding => binding.reader.getDeclaration(reference)).filter(item => item !== null);
      if (found.length > 1) fail('DATABASE_LINE_REFERENCE_AMBIGUOUS', '固定引用在多个实例中不唯一，不能按全局线路猜测。');
      return found[0] ?? null;
    };
    return {
      get port() { return current().port; }, get reader(): ConversationUserCycleBinding['reader'] { return {
        readSnapshot(reference, context) { return required(service.financialLine(context.task.id)).reader.readSnapshot(reference, context); },
        get snapshotBinding() { return all()[0]?.reader.snapshotBinding ?? fail('DATABASE_LINE_BUSINESS_UNBOUND', '没有已装配金融读取合同。'); }, get snapshotCapabilities() { return all().flatMap(binding => binding.reader.snapshotCapabilities); },
        registerCommittedSnapshot(registration) {
          const matches = [...service.lines.values()].filter(line => line.identity.instanceId === registration.receipt.instance_id);
          if (matches.length !== 1) fail('DATABASE_LINE_INSTANCE_MISMATCH', '固定读回必须对应唯一原实例。');
          return required(matches[0]!).reader.registerCommittedSnapshot(registration);
        }, getDeclaration: declarations, listDeclarations() { return all().flatMap(binding => binding.reader.listDeclarations()); },
      }; },
      get principalId() { return current().principalId; }, get instanceId() { return current().instanceId; },
      get capabilities() { return all().flatMap(binding => binding.capabilities); }, get publicationTargets() { return service.lines.get(service.selection().connectionId)?.binding?.publicationTargets ?? []; },
      provenanceForOriginal(sha) { return current().provenanceForOriginal?.(sha); },
      bindFinancialTask(taskId, origin) { required(service.financialLine(taskId)).bindFinancialTask(taskId, origin); },
      assertFinancialTaskReadable(context) { required(service.financialLine(context.task.id)).assertFinancialTaskReadable(context); },
      attachConversationAuthority(check) {
        if (service.conversationAuthority) fail('WFD_AUTHORITY_ALREADY_BOUND', '会话权限检查已绑定。');
        service.conversationAuthority = check; for (const binding of all()) binding.attachConversationAuthority(check);
      },
      forTask(taskId) { return required(service.bindTask(taskId)); },
      forEnvelope(envelope) { return required(service.forEnvelope(envelope)); },
      pinRequest(envelope, taskId) { service.pinRequest(envelope, taskId); },
      attachBusinessDatabase(database) { service.attachBusinessDatabase(database); },
    };
  }
}
