import { createHash, randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../../platform/state/database.js';
import { digestOperationArgs } from '../../platform/security/permissions.js';
import { TaskError, type TaskExecutionContext } from '../../platform/jobs/tasks.js';
import type { AgentSkillAttemptScope, AgentSkillBinding, AgentSkillDefinition, AgentSkillRecord, AgentSkillResource, AgentSkillRunBinding, AgentSkillRunScope, AgentSkillSource, AgentSkillTaskArgs } from '../../contracts/agent-skill-contracts.js';

const SCHEMA = `
CREATE TABLE agent_skills (
 id TEXT PRIMARY KEY, latest_version INTEGER NOT NULL, enabled INTEGER NOT NULL,
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE agent_skill_versions (
 skill_id TEXT NOT NULL REFERENCES agent_skills(id), version INTEGER NOT NULL,
 title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL,
 source_json TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(skill_id,version)
);
CREATE TABLE agent_skill_bindings (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES task_runs(id), attempt_id TEXT NOT NULL UNIQUE REFERENCES task_attempts(id),
 generation INTEGER NOT NULL, skill_id TEXT NOT NULL, skill_version INTEGER NOT NULL,
 digest TEXT NOT NULL, source_json TEXT NOT NULL, args_digest TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(skill_id,skill_version) REFERENCES agent_skill_versions(skill_id,version),
 UNIQUE(task_id,generation)
);
CREATE INDEX agent_skill_bindings_task ON agent_skill_bindings(task_id,generation);
`;
interface SkillRow { id: string; latest_version: number; enabled: number; revision: number; enable_revision: number; created_at: string; updated_at: string }
interface VersionRow { skill_id: string; version: number; title: string; description: string; body: string; source_json: string; digest: string; created_at: string; package_json: string }
interface BindingRow { id: string; task_id: string; run_id: string; attempt_id: string; generation: number; skill_id: string; skill_version: number; digest: string; source_json: string; args_digest: string; created_at: string }
interface TaskRow { id: string; runtime_id: string; action: string; args: string; current_run_id: string | null; current_attempt_id: string | null; generation: number; status: string }
interface RunBindingRow { id: string; conversation_id: string; branch_id: string; run_id: string; generation: number; skill_id: string; skill_version: number; digest: string; source_json: string; enable_revision: number; created_at: string }
export interface AgentSkillServiceOptions {
  database: CoreDatabase;
  isTaskRunActive(runId: string, generation: number): boolean;
  isConversationRunActive?: (runId: string, generation: number) => boolean;
  /** 核对当前动作可用性；声明依赖不会授予工具或权限。 */
  isToolAvailable?: (action: string) => boolean;
  now?: () => number;
}
export class AgentSkillError extends TaskError {
  constructor(code: string, message: string) { super(code, message); this.name = 'AgentSkillError'; }
}

/** 核心保存完整指令与不可变版本，Pi 只消费本次明确选定、已绑定尝试的发送视图。 */
export class AgentSkillService {
  private readonly now: () => number;
  constructor(private readonly options: AgentSkillServiceOptions) {
    this.now = options.now ?? Date.now;
    const current = Number(options.database.connection.prepare('SELECT version FROM schema_versions WHERE module=?').get('agent_skills')?.version ?? 0);
    if (current < 1) options.database.migrate('agent_skills', 1, SCHEMA);
    if (current < 2) options.database.migrate('agent_skills', 2, "ALTER TABLE agent_skill_versions ADD COLUMN package_json TEXT NOT NULL DEFAULT '{}';");
    options.database.migrate('agent_skills', 3, `ALTER TABLE agent_skills ADD COLUMN enable_revision INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE agent_skill_run_bindings (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id), generation INTEGER NOT NULL,
        skill_id TEXT NOT NULL, skill_version INTEGER NOT NULL, digest TEXT NOT NULL, source_json TEXT NOT NULL,
        enable_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(skill_id,skill_version) REFERENCES agent_skill_versions(skill_id,version),
        UNIQUE(run_id,generation,skill_id));`);
  }
  private get db() { return this.options.database.connection; }

  register(input: AgentSkillDefinition): AgentSkillRecord {
    return this.options.database.transaction(() => this.registerInTransaction(input));
  }
  /** 供受控目录导入器在共同核心事务内登记，不开启嵌套事务。 */
  registerInTransaction(input: AgentSkillDefinition): AgentSkillRecord {
    if (!this.db.isTransaction) throw new AgentSkillError('AGENT_SKILL_TRANSACTION_REQUIRED', '指令技能登记需要核心事务。');
    const definition = validateDefinition(input), digest = definitionDigest(definition);
      const previous = this.db.prepare('SELECT * FROM agent_skill_versions WHERE skill_id=? AND version=?').get(definition.id, definition.version) as unknown as VersionRow | undefined;
      if (previous) {
        if (previous.digest !== digest || definitionDigest(fromVersion(previous)) !== digest) throw new AgentSkillError('AGENT_SKILL_VERSION_CONFLICT', '同一技能版本的正文或来源不能改写，请创建新版本。');
        return this.get(definition.id, definition.version);
      }
      const current = this.db.prepare('SELECT * FROM agent_skills WHERE id=?').get(definition.id) as unknown as SkillRow | undefined;
      if (current && definition.version <= current.latest_version) throw new AgentSkillError('AGENT_SKILL_VERSION_ORDER', '新技能版本必须大于当前版本。');
      const now = new Date(this.now()).toISOString();
      if (input.enabled === true && definition.unsupportedReasons?.length) throw new AgentSkillError('AGENT_SKILL_UNAVAILABLE', definition.unsupportedReasons.join('；'));
      if (!current) this.db.prepare('INSERT INTO agent_skills(id,latest_version,enabled,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(definition.id, definition.version, input.enabled === false ? 0 : 1, 1, now, now);
      else this.db.prepare('UPDATE agent_skills SET latest_version=?,revision=revision+1,updated_at=? WHERE id=?').run(definition.version, now, definition.id);
      const { resources, originalBody, adaptationNotes, requiresTools, unsupportedReasons } = definition;
      const packageData = { ...(resources === undefined ? {} : { resources }), ...(originalBody === undefined ? {} : { originalBody }),
        ...(adaptationNotes === undefined ? {} : { adaptationNotes }), ...(requiresTools === undefined ? {} : { requiresTools }), ...(unsupportedReasons === undefined ? {} : { unsupportedReasons }) };
      this.db.prepare('INSERT INTO agent_skill_versions(skill_id,version,title,description,body,source_json,digest,created_at,package_json) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(definition.id, definition.version, definition.title, definition.description, definition.body, JSON.stringify(definition.source), digest, now, JSON.stringify(packageData));
    return this.get(definition.id, definition.version);
  }
  registerImportedInTransaction(input: AgentSkillDefinition): AgentSkillRecord {
    const row = this.db.prepare('SELECT latest_version FROM agent_skills WHERE id=?').get(input.id);
    const version = Number(row?.latest_version ?? 0);
    if (version && definitionDigest(validateDefinition({ ...input, version })) === this.get(input.id, version).digest) return this.get(input.id, version);
    return this.registerInTransaction({ ...input, version: version + 1 });
  }

  list(): AgentSkillRecord[] { return (this.db.prepare('SELECT id FROM agent_skills ORDER BY id').all() as { id: string }[]).map((row) => this.get(row.id)); }
  get(id: string, version?: number): AgentSkillRecord {
    validSkillId(id);
    if (version !== undefined) validVersion(version);
    const skill = this.db.prepare('SELECT * FROM agent_skills WHERE id=?').get(id) as unknown as SkillRow | undefined;
    if (!skill) throw new AgentSkillError('AGENT_SKILL_NOT_FOUND', '没有此核心指令技能。');
    const stored = this.db.prepare('SELECT * FROM agent_skill_versions WHERE skill_id=? AND version=?').get(id, version ?? skill.latest_version) as unknown as VersionRow | undefined;
    if (!stored) throw new AgentSkillError('AGENT_SKILL_NOT_FOUND', '没有此技能版本，请明确选择已登记版本。');
    const definition = fromVersion(stored);
    if (definitionDigest(definition) !== stored.digest) throw new AgentSkillError('AGENT_SKILL_INTEGRITY', '技能正文与已保存版本摘要不一致。');
    const missingTools = this.missingTools(definition), reason = this.dependencyReason(definition);
    return { ...definition, digest: stored.digest, enabled: !!skill.enabled, readable: !!skill.enabled && !definition.unsupportedReasons?.length,
      missingTools, available: !!skill.enabled && !reason,
      unavailableReason: reason ?? (skill.enabled ? null : '此指令技能已停用。'), currentRevision: skill.revision, latest: stored.version === skill.latest_version,
      createdAt: stored.created_at, updatedAt: skill.updated_at };
  }
  versions(id: string): AgentSkillRecord[] {
    this.get(id);
    return (this.db.prepare('SELECT version FROM agent_skill_versions WHERE skill_id=? ORDER BY version DESC').all(id) as { version: number }[]).map((row) => this.get(id, row.version));
  }
  setEnabled(id: string, enabled: boolean, expectedRevision: number): AgentSkillRecord {
    validSkillId(id);
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new AgentSkillError('AGENT_SKILL_INVALID', '技能可用性或预期版本无效。');
    this.options.database.transaction(() => {
      const current = this.get(id);
      if (current.currentRevision !== expectedRevision) throw new AgentSkillError('AGENT_SKILL_REVISION_CONFLICT', '技能状态已变化，请重新核对后再更新。');
      if (enabled && current.unsupportedReasons?.length) throw new AgentSkillError('AGENT_SKILL_UNAVAILABLE', current.unsupportedReasons.join('；'));
      if (current.enabled === enabled) return;
      const result = this.db.prepare('UPDATE agent_skills SET enabled=?,revision=revision+1,enable_revision=enable_revision+1,updated_at=? WHERE id=? AND revision=?')
        .run(enabled ? 1 : 0, new Date(this.now()).toISOString(), id, expectedRevision);
      if (result.changes !== 1) throw new AgentSkillError('AGENT_SKILL_REVISION_CONFLICT', '技能状态已变化，请重新核对后再更新。');
    });
    return this.get(id);
  }

  resources(id: string, version?: number): AgentSkillResource[] { return structuredClone(this.get(id, version).resources ?? []); }
  readResource(id: string, version: number, path: string): AgentSkillResource {
    validResourcePath(path);
    const skill = this.get(id, version);
    if (!skill.readable) throw new AgentSkillError('AGENT_SKILL_UNAVAILABLE', skill.unavailableReason ?? '此技能暂不可读取。');
    const resource = skill.resources?.find((entry) => entry.path === path);
    if (!resource) throw new AgentSkillError('AGENT_SKILL_RESOURCE_NOT_FOUND', '此文本资源未在所选技能版本中登记；脚本和目录外文件不能读取。');
    return structuredClone(resource);
  }
  resourcesForAttempt(scope: AgentSkillAttemptScope, path: string): AgentSkillResource {
    this.instructionsForAttempt(scope);
    const selected = this.getBinding(scope.attemptId)!;
    const result = this.readResource(selected.skillId, selected.skillVersion, path);
    this.assertAttempt(scope);
    return result;
  }

  /** 首次读取固定该运行的版本；新版本只供新选择使用，不替换当前选择。 */
  bindRun(scope: AgentSkillRunScope, id: string, version: number): AgentSkillRunBinding {
    return this.options.database.transaction(() => {
      this.assertConversationRun(scope);
      const skill = this.get(id, version);
      if (!skill.readable) throw new AgentSkillError('AGENT_SKILL_UNAVAILABLE', '此技能已停用或文本尚未通过审核。');
      const previous = this.getRunBinding(scope, id);
      if (previous) {
        if (previous.skillVersion !== version) throw new AgentSkillError('AGENT_SKILL_BINDING_CONFLICT', '同一会话运行已经选定另一技能版本，请在新运行中选择。');
        this.skillForRun(scope, id);
        return previous;
      }
      const state = this.db.prepare('SELECT enable_revision FROM agent_skills WHERE id=?').get(id)!;
      this.db.prepare('INSERT INTO agent_skill_run_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), scope.conversationId, scope.branchId, scope.runId, scope.generation, id, version,
          skill.digest, JSON.stringify(skill.source), state.enable_revision, new Date(this.now()).toISOString());
      return this.getRunBinding(scope, id)!;
    });
  }
  /** 只读历史绑定不授予当前读取资格。 */
  getRunBinding(scope: AgentSkillRunScope, id: string): AgentSkillRunBinding | null {
    const row = this.db.prepare('SELECT * FROM agent_skill_run_bindings WHERE run_id=? AND generation=? AND skill_id=?')
      .get(scope.runId, scope.generation, id) as unknown as RunBindingRow | undefined;
    return row ? { id: row.id, conversationId: row.conversation_id, branchId: row.branch_id, runId: row.run_id,
      generation: row.generation, skillId: row.skill_id, skillVersion: row.skill_version, digest: row.digest,
      source: JSON.parse(row.source_json) as AgentSkillSource, enableRevision: row.enable_revision, createdAt: row.created_at } : null;
  }
  listForRun(scope: AgentSkillRunScope): AgentSkillRecord[] {
    this.assertConversationRun(scope);
    return this.list().filter(skill => skill.readable).map(skill => this.getRunBinding(scope, skill.id) ? this.skillForRun(scope, skill.id) : skill);
  }
  skillForRun(scope: AgentSkillRunScope, id: string): AgentSkillRecord {
    this.assertConversationRun(scope);
    const selected = this.getRunBinding(scope, id);
    if (!selected || selected.conversationId !== scope.conversationId || selected.branchId !== scope.branchId) throw new AgentSkillError('AGENT_SKILL_NOT_BOUND', '当前会话运行尚未选定此技能。');
    const skill = this.get(id, selected.skillVersion), state = this.db.prepare('SELECT enable_revision FROM agent_skills WHERE id=?').get(id)!;
    if (!skill.readable || selected.digest !== skill.digest || selected.enableRevision !== Number(state.enable_revision)
      || digestOperationArgs(selected.source) !== digestOperationArgs(skill.source)) throw new AgentSkillError('AGENT_SKILL_UNAVAILABLE', '当前技能选择已失效；停用后重新启用也不能复活旧运行选择。');
    return skill;
  }
  private assertConversationRun(scope: AgentSkillRunScope): void {
    if (!Number.isSafeInteger(scope.generation) || scope.generation < 1 || this.options.isConversationRunActive?.(scope.runId, scope.generation) !== true) throw new AgentSkillError('AGENT_SKILL_RUN_INACTIVE', '技能读取需要当前核心拥有的活动会话运行。');
    const run = this.db.prepare('SELECT conversation_id,branch_id,generation,state FROM runs WHERE id=?').get(scope.runId);
    if (!run || run.conversation_id !== scope.conversationId || run.branch_id !== scope.branchId || Number(run.generation) !== scope.generation
      || !['starting', 'running'].includes(String(run.state))) throw new AgentSkillError('AGENT_SKILL_RUN_INACTIVE', '技能选择与当前会话、分支或运行代次不一致。');
  }

  validateTaskArgs(input: unknown): AgentSkillTaskArgs {
    if (!object(input) || Object.keys(input).some((key) => key !== 'prompt' && key !== 'skill') || typeof input.prompt !== 'string'
      || !input.prompt.trim() || input.prompt.length > 32_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.prompt)
      || typeof input.skill !== 'string') throw new AgentSkillError('AGENT_SKILL_ARGS_INVALID', '指令技能任务需要明确的技能版本和文字请求。');
    const selected = parseSelection(input.skill), skill = this.get(selected.id, selected.version);
    if (!skill.readable) throw new AgentSkillError('AGENT_SKILL_UNAVAILABLE', '所选指令技能已停用。');
    return { skill: `${skill.id}@${skill.version}`, prompt: input.prompt };
  }

  /** 必须在该任务尝试开始后、会话发送前落盘；不能用聊天上下文或技能名称推测选择。 */
  bindAttempt(context: TaskExecutionContext): AgentSkillBinding {
    const scope = { taskId: context.task.id, runId: context.runId, attemptId: context.attemptId, generation: context.generation };
    return this.options.database.transaction(() => {
      context.signal.throwIfAborted();
      const task = this.assertAttempt(scope), args = this.validateTaskArgs(JSON.parse(task.args));
      if (digestOperationArgs(args) !== digestOperationArgs(context.task.args)) throw new AgentSkillError('AGENT_SKILL_BINDING_CONFLICT', '任务上下文与核心技能意图不一致。');
      const selected = parseSelection(args.skill), skill = this.get(selected.id, selected.version), argsDigest = digestOperationArgs(args);
      const previous = this.db.prepare('SELECT * FROM agent_skill_bindings WHERE attempt_id=?').get(scope.attemptId) as unknown as BindingRow | undefined;
      if (previous) {
        if (previous.task_id !== scope.taskId || previous.run_id !== scope.runId || previous.generation !== scope.generation
          || previous.skill_id !== skill.id || previous.skill_version !== skill.version || previous.digest !== skill.digest || previous.args_digest !== argsDigest) {
          throw new AgentSkillError('AGENT_SKILL_BINDING_CONFLICT', '同一任务尝试的技能选择不能替换。');
        }
        return binding(previous);
      }
      const id = randomUUID(), now = new Date(this.now()).toISOString();
      this.db.prepare('INSERT INTO agent_skill_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, scope.taskId, scope.runId, scope.attemptId, scope.generation, skill.id, skill.version, skill.digest, JSON.stringify(skill.source), argsDigest, now);
      return this.getBinding(scope.attemptId)!;
    });
  }
  /** 历史选择事实，只读查询不会授予本次发送或执行资格。 */
  getBinding(attemptId: string): AgentSkillBinding | null {
    const row = this.db.prepare('SELECT * FROM agent_skill_bindings WHERE attempt_id=?').get(attemptId) as unknown as BindingRow | undefined;
    return row ? binding(row) : null;
  }

  /** 宿主须先核对 chatRun.task_id / 当前Task尝试 / piTaskRequestId 三方映射，再调用。 */
  instructionsForAttempt(scope: AgentSkillAttemptScope): string {
    const task = this.assertAttempt(scope), selected = this.getBinding(scope.attemptId);
    const args = this.validateTaskArgs(JSON.parse(task.args)), token = parseSelection(args.skill);
    if (!selected || selected.taskId !== scope.taskId || selected.runId !== scope.runId || selected.generation !== scope.generation
      || selected.skillId !== token.id || selected.skillVersion !== token.version || selected.argsDigest !== digestOperationArgs(args)) throw new AgentSkillError('AGENT_SKILL_NOT_BOUND', '本次任务尝试尚未保存明确技能选择。');
    const skill = this.get(selected.skillId, selected.skillVersion);
    if (!skill.readable || skill.digest !== selected.digest || digestOperationArgs(skill.source) !== digestOperationArgs(selected.source)) throw new AgentSkillError('AGENT_SKILL_UNAVAILABLE', '本次技能版本或来源已失效。');
    this.assertAttempt(scope);
    const metadata = JSON.stringify({ id: skill.id, version: skill.version, digest: skill.digest, source: skill.source });
    const resources = (skill.resources ?? []).map(({ path, kind }) => ({ path, kind }));
    return `本次用户已明确选择以下指令技能。正文已由核心完整加载，无需再次读取 SKILL.md；来源标识只是文档记录，不是可访问路径。\n技能只提供处理方法，不增加文件、工具、脚本、扩展、网络或凭据权限；实际动作仍须遵守核心审批。\n原文和未导入的脚本不能作为执行依据。附属文本只能通过当前可用的 core_skill_resource（技能参考文本读取）工具按登记相对路径读取；资源较长时使用返回的 nextOffset（下一段位置）继续读取。\n\n已选技能版本：${metadata}\n已登记附属文本：${JSON.stringify(resources)}\n\n${skill.body}`;
  }

  private dependencyReason(definition: AgentSkillDefinition): string | null {
    if (definition.unsupportedReasons?.length) return definition.unsupportedReasons.join('；');
    const missing = this.missingTools(definition);
    return missing.length ? '所需核心动作当前不可用：' + missing.join('、') : null;
  }
  private missingTools(definition: AgentSkillDefinition): string[] {
    return (definition.requiresTools ?? []).filter((action) => { try { return this.options.isToolAvailable?.(action) !== true; } catch { return true; } });
  }

  private assertAttempt(scope: AgentSkillAttemptScope): TaskRow {
    if (!Number.isSafeInteger(scope.generation) || scope.generation < 1 || !this.options.isTaskRunActive(scope.runId, scope.generation)) throw new AgentSkillError('AGENT_SKILL_RUN_INACTIVE', '所选技能的任务尝试已经停止或更换。');
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(scope.taskId) as unknown as TaskRow | undefined;
    if (!task || task.runtime_id !== 'pi' || task.action !== 'pi.skill' || task.current_run_id !== scope.runId
      || task.current_attempt_id !== scope.attemptId || task.generation !== scope.generation || !['running', 'waiting_approval'].includes(task.status)) {
      throw new AgentSkillError('AGENT_SKILL_RUN_INACTIVE', '本次技能与当前核心任务尝试不匹配。');
    }
    return task;
  }
}

function parseSelection(value: string): { id: string; version: number } {
  const match = /^([a-z0-9-]+)@([1-9][0-9]*)$/u.exec(value);
  if (!match) throw new AgentSkillError('AGENT_SKILL_ARGS_INVALID', '请明确选择已有的技能编号与版本。');
  validSkillId(match[1]!); const version = Number(match[2]); validVersion(version);
  return { id: match[1]!, version };
}
function validateDefinition(input: AgentSkillDefinition): Omit<AgentSkillDefinition, 'enabled'> {
  if (!object(input)) throw new AgentSkillError('AGENT_SKILL_INVALID', '技能记录无效。');
  validSkillId(input.id); validVersion(input.version);
  const title = line(input.title, 120), description = line(input.description, 1024);
  if (typeof input.body !== 'string' || !input.body.trim() || Buffer.byteLength(input.body, 'utf8') > 24_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.body) || typeof input.enabled !== 'undefined' && typeof input.enabled !== 'boolean') throw new AgentSkillError('AGENT_SKILL_INVALID', '技能正文为空、超限或包含无效字符。');
  if (!object(input.source) || !['builtin', 'user'].includes(input.source.kind)) throw new AgentSkillError('AGENT_SKILL_INVALID', '技能来源必须明确登记。');
  const source: AgentSkillSource = { kind: input.source.kind, identifier: line(input.source.identifier, 300), revision: line(input.source.revision, 300) };
  const resources = input.resources === undefined ? undefined : validateResources(input.resources);
  if (input.originalBody !== undefined && (typeof input.originalBody !== 'string' || Buffer.byteLength(input.originalBody, 'utf8') > 131_072 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(input.originalBody))) throw new AgentSkillError('AGENT_SKILL_INVALID', '技能来源原文无效。');
  const strings = (value: string[] | undefined, limit: number): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 30) throw new AgentSkillError('AGENT_SKILL_INVALID', '技能依赖或适配说明无效。');
    return [...new Set(value.map((entry) => line(entry, limit)))];
  };
  const adaptationNotes = strings(input.adaptationNotes, 1000), requiresTools = strings(input.requiresTools, 100), unsupportedReasons = strings(input.unsupportedReasons, 1000);
  return { id: input.id, version: input.version, title, description, body: input.body.replace(/\r\n?/gu, '\n').trim(), source,
    ...(resources === undefined ? {} : { resources }), ...(input.originalBody === undefined ? {} : { originalBody: input.originalBody }),
    ...(adaptationNotes === undefined ? {} : { adaptationNotes }), ...(requiresTools === undefined ? {} : { requiresTools }), ...(unsupportedReasons === undefined ? {} : { unsupportedReasons }) };
}
function definitionDigest(definition: Omit<AgentSkillDefinition, 'enabled'>): string { return digestOperationArgs(definition); }
function fromVersion(row: VersionRow): Omit<AgentSkillDefinition, 'enabled'> {
  const packageData: unknown = JSON.parse(row.package_json ?? '{}');
  if (!object(packageData) || Object.keys(packageData).some((key) => !['resources', 'originalBody', 'adaptationNotes', 'requiresTools', 'unsupportedReasons'].includes(key))) throw new AgentSkillError('AGENT_SKILL_INTEGRITY', '技能文本包格式无效。');
  return validateDefinition({ ...packageData, id: row.skill_id, version: row.version, title: row.title, description: row.description, body: row.body, source: JSON.parse(row.source_json) as AgentSkillSource } as AgentSkillDefinition);
}
export function skillResourceDigest(body: string): string { return createHash('sha256').update(body, 'utf8').digest('hex'); }
function validResourcePath(path: string): void {
  if (typeof path !== 'string' || path.length > 512 || !/^(references|templates|assets)\/.+\.(md|markdown|txt)$/iu.test(path)
    || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
    || /(?:credential|secret|password|api[-_]?key|token|\.env)/iu.test(path)) throw new AgentSkillError('AGENT_SKILL_RESOURCE_INVALID', '附属文本路径必须在登记的参考、模板或文本资源目录中。');
}
function validateResources(input: AgentSkillResource[]): AgentSkillResource[] {
  if (!Array.isArray(input) || input.length > 100) throw new AgentSkillError('AGENT_SKILL_INVALID', '技能附属文本清单无效。');
  let size = 0;
  const paths = new Set<string>();
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new AgentSkillError('AGENT_SKILL_INVALID', '技能附属文本无效。');
    validResourcePath(entry.path);
    if (paths.has(entry.path)) throw new AgentSkillError('AGENT_SKILL_RESOURCE_INVALID', '附属文本路径不能重复。');
    paths.add(entry.path);
    if (typeof entry.body !== 'string' || Buffer.byteLength(entry.body, 'utf8') > 131_072 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(entry.body)
      || entry.digest !== skillResourceDigest(entry.body) || !['reference', 'template', 'asset'].includes(entry.kind)) throw new AgentSkillError('AGENT_SKILL_RESOURCE_INVALID', '附属文本内容、类别或摘要无效。');
    size += Buffer.byteLength(entry.body, 'utf8');
    if (size > 1_048_576) throw new AgentSkillError('AGENT_SKILL_RESOURCE_INVALID', '单个技能的附属文本超过体积限制。');
    return { path: entry.path, body: entry.body, digest: entry.digest, kind: entry.kind };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function binding(row: BindingRow): AgentSkillBinding {
  return { id: row.id, taskId: row.task_id, runId: row.run_id, attemptId: row.attempt_id, generation: row.generation,
    skillId: row.skill_id, skillVersion: row.skill_version, digest: row.digest, source: JSON.parse(row.source_json) as AgentSkillSource, argsDigest: row.args_digest, createdAt: row.created_at };
}
function validSkillId(id: string): void {
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || id.length > 64) throw new AgentSkillError('AGENT_SKILL_INVALID', '技能编号需要小写字母、数字与单个连字符。');
}
function validVersion(version: number): void { if (!Number.isSafeInteger(version) || version < 1) throw new AgentSkillError('AGENT_SKILL_INVALID', '技能版本必须是正整数。'); }
function line(value: string, limit: number): string { if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw new AgentSkillError('AGENT_SKILL_INVALID', '技能文字字段无效。'); return value.trim(); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
