import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { BackendCheckpoint, BackendHistoryMessage } from '../../../contracts/backend.js';
import { CoreError } from '../../../platform/runtime/errors.js';
import type { ChatMessage, ConversationAttachmentRef, ConversationPlugin, ConversationState, ConversationStatus, ConversationSummary, ConversationVisibility, CoreEvent, DraftState, MessageHistoryPage, PendingInput, RunSummary, SendReceipt, ThinkingLevel } from '../../../contracts/contracts.js';
import type { FileReference } from '../../../platform/resources/files.js';
import { CoreDatabase } from '../../../platform/state/database.js';
import type { FrozenRunConfiguration } from '../../../contracts/ui-contracts.js';
import { ConversationDisplayMetadataRepository } from '../conversation-display-metadata.js';

export interface ConversationRow {
  id: string; title: string; plugin_id: ConversationPlugin; backend_id: string; project_id: string | null; selected_branch_id: string; status: ConversationStatus;
  visibility: ConversationVisibility; archived_at: string | null; deleted_at: string | null;
  error: string | null; sequence: number; tree_revision: number; generation: number; queue_paused: number;
  direct_message_count: number;
  thinking_level: ThinkingLevel | null;
  created_at: string; updated_at: string;
}
export interface BranchRow {
  id: string; conversation_id: string; head_message_id: string | null; session_ref: string | null;
  checkpoint_json: string | null; checkpoint_head_id: string | null; created_at: string; updated_at: string;
}
export interface MessageRow {
  id: string; conversation_id: string; parent_id: string | null; run_id: string | null;
  role: 'user' | 'assistant'; text: string; status: ChatMessage['status']; created_at: string;
  native_json: string | null; native_context_json: string | null; raw_stop_reason: string | null; failure_code: string | null;
  usage_json: string | null;
  attachment_refs_json: string;
}
export interface CommandRow {
  id: string; conversation_id: string; branch_id: string; request_id: string; payload_hash: string;
  kind: 'send' | 'queue' | 'steer' | 'interrupt' | 'edit' | 'retry' | 'compact' | 'completion'; text: string; state: SendReceipt['status'];
  run_id: string | null; input_message_id: string | null; source_message_id: string | null; target_run_id: string | null;
  generation: number; created_at: string; updated_at: string; error: string | null;
  attachment_refs_json: string;
  thinking_level: ThinkingLevel | null;
  configuration_json: string | null;
  queue_order: number | null;
}
export interface RunRow {
  id: string; conversation_id: string; branch_id: string; command_id: string; task_id: string | null;
  state: RunSummary['state']; generation: number; owner_epoch: string; session_ref: string | null;
  kind: RunSummary['kind']; compaction_json: string | null;
  thinking_level: ThinkingLevel | null;
  configuration_json: string | null;
  started_at: string; settled_at: string | null; raw_stop_reason: string | null; failure_code: string | null;
}
export interface SendRequestRow {
  request_id: string; conversation_id: string; branch_id: string;
  mode: 'send' | 'queue' | 'steer' | 'interrupt';
  text: string; attachment_refs_json: string; draft_key: string; draft_revision: number; expected_run_id: string | null;
  digest: string; state: 'frozen' | 'accepted' | 'rejected' | 'abandoned';
  route_json: string;
  thinking_level: ThinkingLevel; configuration_json: string; dependency_json: string;
  command_id: string | null; run_id: string | null; task_id: string | null;
  error_code: string | null; error: string | null;
  created_at: string; updated_at: string; accepted_at: string | null;
}
export type SendRequestAttentionRow = SendRequestRow & { command_exists: string | null };
interface DraftRow { key: string; conversation_id: string; branch_id: string; kind: string; target_id: string;
  text: string; revision: number; updated_at: string; attachment_refs_json: string }

// 仅界面阅读查询联结冻结运行名；模型 history() 的消息查询保持原语义。
const frozenAgentName = "CASE WHEN json_valid(r.configuration_json) THEN json_extract(r.configuration_json,'$.agentDisplayName') END";

const schema = `
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, backend_id TEXT NOT NULL, project_id TEXT, selected_branch_id TEXT NOT NULL,
 plugin_id TEXT NOT NULL DEFAULT 'pi' CHECK(plugin_id IN ('pi','direct')),
 direct_message_count INTEGER NOT NULL DEFAULT 0 CHECK(direct_message_count >= 0),
 status TEXT NOT NULL DEFAULT 'IDLE', error TEXT, sequence INTEGER NOT NULL DEFAULT 0,
 tree_revision INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
 queue_paused INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 visibility TEXT NOT NULL DEFAULT 'active' CHECK(visibility IN ('active','archived','trashed')),
 archived_at TEXT, deleted_at TEXT, thinking_level TEXT
);
CREATE INDEX conversations_visibility ON conversations(visibility,updated_at);
CREATE INDEX conversations_plugin_visibility ON conversations(plugin_id,visibility,updated_at);
CREATE TABLE branches (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), head_message_id TEXT,
 session_ref TEXT, checkpoint_json TEXT, checkpoint_head_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), parent_id TEXT REFERENCES messages(id),
 run_id TEXT, role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL,
 status TEXT NOT NULL, created_at TEXT NOT NULL, finalized_at TEXT, native_json TEXT, native_context_json TEXT,
 usage_json TEXT, raw_stop_reason TEXT, failure_code TEXT, attachment_refs_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX messages_conversation ON messages(conversation_id);
CREATE TABLE drafts (
 key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), branch_id TEXT NOT NULL REFERENCES branches(id),
 kind TEXT NOT NULL, target_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 0, retired_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 attachment_refs_json TEXT NOT NULL DEFAULT '[]',
 UNIQUE(conversation_id, branch_id, kind, target_id)
);
CREATE TABLE commands (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), branch_id TEXT NOT NULL REFERENCES branches(id),
 request_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
 state TEXT NOT NULL, run_id TEXT, input_message_id TEXT, source_message_id TEXT, target_run_id TEXT,
 generation INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
 attachment_refs_json TEXT NOT NULL DEFAULT '[]', thinking_level TEXT, configuration_json TEXT, queue_order INTEGER
);
CREATE INDEX commands_pending ON commands(conversation_id, branch_id, state, created_at);
CREATE TABLE runs (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), branch_id TEXT NOT NULL REFERENCES branches(id),
 command_id TEXT NOT NULL REFERENCES commands(id), task_id TEXT, kind TEXT NOT NULL DEFAULT 'chat', compaction_json TEXT,
 state TEXT NOT NULL, generation INTEGER NOT NULL,
 owner_epoch TEXT NOT NULL, session_ref TEXT, started_at TEXT NOT NULL, settled_at TEXT, raw_stop_reason TEXT, failure_code TEXT, thinking_level TEXT, configuration_json TEXT
);
CREATE UNIQUE INDEX runs_one_active ON runs(conversation_id) WHERE state IN ('starting','running','stopping');
CREATE TABLE events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 run_id TEXT, sequence INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(conversation_id, sequence)
);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`;

/** 存储权威消息树和运行记录，不依赖 Pi、界面组件或模型供应方。 */
export class ConversationStore {
  readonly displayMetadata: ConversationDisplayMetadataRepository;
  constructor(readonly database: CoreDatabase) {
    const current = Number(database.connection.prepare('SELECT version FROM schema_versions WHERE module=?').get('conversation')?.version ?? 0);
    const migration = current === 0 ? schema
      : `${current < 2 ? 'ALTER TABLE messages ADD COLUMN native_context_json TEXT;' : ''}
         ${current < 3 ? 'ALTER TABLE conversations ADD COLUMN project_id TEXT;' : ''}`;
    database.migrate('conversation', 11, `${migration}${current > 0 && current < 4
      ? "ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'; ALTER TABLE runs ADD COLUMN compaction_json TEXT;" : ''}${current > 0 && current < 5
      ? "ALTER TABLE conversations ADD COLUMN visibility TEXT NOT NULL DEFAULT 'active' CHECK(visibility IN ('active','archived','trashed')); ALTER TABLE conversations ADD COLUMN archived_at TEXT; ALTER TABLE conversations ADD COLUMN deleted_at TEXT; CREATE INDEX conversations_visibility ON conversations(visibility,updated_at);" : ''}${current > 0 && current < 6
      ? 'ALTER TABLE commands ADD COLUMN target_run_id TEXT;' : ''}${current > 0 && current < 7
      ? "ALTER TABLE conversations ADD COLUMN plugin_id TEXT NOT NULL DEFAULT 'pi' CHECK(plugin_id IN ('pi','direct')); ALTER TABLE conversations ADD COLUMN direct_message_count INTEGER NOT NULL DEFAULT 0 CHECK(direct_message_count >= 0); CREATE INDEX conversations_plugin_visibility ON conversations(plugin_id,visibility,updated_at);" : ''}${current > 0 && current < 8
      ? "ALTER TABLE messages ADD COLUMN attachment_refs_json TEXT NOT NULL DEFAULT '[]'; ALTER TABLE drafts ADD COLUMN attachment_refs_json TEXT NOT NULL DEFAULT '[]'; ALTER TABLE commands ADD COLUMN attachment_refs_json TEXT NOT NULL DEFAULT '[]';" : ''}${current > 0 && current < 9
      ? 'ALTER TABLE conversations ADD COLUMN thinking_level TEXT; ALTER TABLE commands ADD COLUMN thinking_level TEXT; ALTER TABLE runs ADD COLUMN thinking_level TEXT;' : ''}${current > 0 && current < 10
      ? 'ALTER TABLE commands ADD COLUMN configuration_json TEXT; ALTER TABLE runs ADD COLUMN configuration_json TEXT;' : ''}${current > 0 && current < 11
      ? 'ALTER TABLE commands ADD COLUMN queue_order INTEGER;' : ''}`);
    this.displayMetadata = new ConversationDisplayMetadataRepository(database);
    database.migrate('conversation-forks', 1, `CREATE TABLE conversation_forks (
      request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES conversations(id),
      source_revision INTEGER NOT NULL, target_id TEXT NOT NULL REFERENCES conversations(id)
    );`);
    // 派发前冻结的请求身份；commands.request_id 仍是受理事实的唯一权威。
    const sendRequestVersion = Number(database.connection.prepare('SELECT version FROM schema_versions WHERE module=?').get('conversation-send-requests')?.version ?? 0);
    database.migrate('conversation-send-requests', 2, sendRequestVersion === 0 ? `CREATE TABLE conversation_send_requests (
      request_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      branch_id TEXT NOT NULL REFERENCES branches(id),
      mode TEXT NOT NULL CHECK(mode IN ('send','queue','steer','interrupt')),
      text TEXT NOT NULL,
      attachment_refs_json TEXT NOT NULL DEFAULT '[]',
      draft_key TEXT NOT NULL,
      draft_revision INTEGER NOT NULL CHECK(draft_revision >= 0),
      expected_run_id TEXT,
      digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('frozen','accepted','rejected','abandoned')),
      route_json TEXT NOT NULL DEFAULT '{"kind":"model","ruleId":null,"ruleRevision":null,"action":null,"subjectDigest":null,"versionsDigest":null}',
      thinking_level TEXT NOT NULL,
      configuration_json TEXT NOT NULL,
      dependency_json TEXT NOT NULL,
      command_id TEXT,
      run_id TEXT,
      task_id TEXT,
      error_code TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE INDEX conversation_send_requests_attention ON conversation_send_requests(conversation_id,state,created_at);
    CREATE INDEX conversation_send_requests_digest ON conversation_send_requests(conversation_id,branch_id,mode,digest);`
      : `ALTER TABLE conversation_send_requests ADD COLUMN route_json TEXT NOT NULL DEFAULT '{"kind":"model","ruleId":null,"ruleRevision":null,"action":null,"subjectDigest":null,"versionsDigest":null}';`);
  }

  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.database.connection.prepare(sql).get(...params) as T | undefined;
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.database.connection.prepare(sql).all(...params) as T[];
  }
  execute(sql: string, ...params: SQLInputValue[]): void { this.database.connection.prepare(sql).run(...params); }

  conversation(id: string): ConversationRow {
    const row = this.one<ConversationRow>('SELECT * FROM conversations WHERE id=?', id);
    if (!row) throw new CoreError('NOT_FOUND', '会话不存在。', 404);
    return row;
  }
  branch(id: string): BranchRow {
    const row = this.one<BranchRow>('SELECT * FROM branches WHERE id=?', id);
    if (!row) throw new CoreError('NOT_FOUND', '会话分支不存在。', 404);
    return row;
  }
  message(id: string): MessageRow {
    const row = this.one<MessageRow>('SELECT * FROM messages WHERE id=?', id);
    if (!row) throw new CoreError('NOT_FOUND', '消息不存在。', 404);
    return row;
  }
  command(id: string): CommandRow {
    const row = this.one<CommandRow>('SELECT * FROM commands WHERE id=?', id);
    if (!row) throw new CoreError('NOT_FOUND', '输入记录不存在。', 404);
    return row;
  }
  run(id: string): RunRow {
    const row = this.one<RunRow>('SELECT * FROM runs WHERE id=?', id);
    if (!row) throw new CoreError('NOT_FOUND', '运行记录不存在。', 404);
    return row;
  }
  sendRequest(requestId: string): SendRequestRow | undefined {
    return this.one<SendRequestRow>('SELECT * FROM conversation_send_requests WHERE request_id=?', requestId);
  }
  attentionSendRequests(conversationId: string): SendRequestAttentionRow[] {
    return this.all<SendRequestAttentionRow>(`SELECT r.*, c.id AS command_exists FROM conversation_send_requests r
      LEFT JOIN commands c ON c.request_id=r.request_id AND c.conversation_id=r.conversation_id AND c.branch_id=r.branch_id
      WHERE r.conversation_id=? AND (r.state IN ('frozen','rejected')
        OR (r.state='accepted' AND c.id IS NULL AND r.task_id IS NULL))
      ORDER BY r.created_at DESC,r.rowid DESC LIMIT 20`, conversationId);
  }
  insertSendRequest(row: SendRequestRow): void {
    this.execute(`INSERT INTO conversation_send_requests(request_id,conversation_id,branch_id,mode,text,attachment_refs_json,
      draft_key,draft_revision,expected_run_id,digest,state,route_json,thinking_level,configuration_json,dependency_json,
      command_id,run_id,task_id,error_code,error,created_at,updated_at,accepted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.request_id, row.conversation_id, row.branch_id, row.mode, row.text,
    row.attachment_refs_json, row.draft_key, row.draft_revision, row.expected_run_id, row.digest, row.state, row.route_json, row.thinking_level,
    row.configuration_json, row.dependency_json, row.command_id, row.run_id, row.task_id, row.error_code, row.error,
    row.created_at, row.updated_at, row.accepted_at);
  }
  acceptSendRequest(requestId: string, commandId: string, runId: string | null, taskId: string | null): void {
    const now = new Date().toISOString();
    this.execute(`UPDATE conversation_send_requests SET state='accepted',command_id=COALESCE(command_id,?),run_id=COALESCE(run_id,?),
      task_id=COALESCE(?,task_id),accepted_at=COALESCE(accepted_at,?),updated_at=?,error_code=NULL,error=NULL
      WHERE request_id=? AND state IN ('frozen','rejected','accepted')`, commandId, runId, taskId, now, now, requestId);
  }
  rejectSendRequest(requestId: string, code: string, message: string): void {
    this.execute(`UPDATE conversation_send_requests SET state='rejected',error_code=?,error=?,updated_at=?
      WHERE request_id=? AND state IN ('frozen','rejected')`, code, message, new Date().toISOString(), requestId);
  }
  abandonSendRequest(requestId: string): number {
    return Number(this.database.connection.prepare(`UPDATE conversation_send_requests SET state='abandoned',updated_at=?
      WHERE request_id=? AND state IN ('frozen','rejected')`).run(new Date().toISOString(), requestId).changes);
  }

  /** 只核对显式选择的登记引用，不扫描会话的其他文件，也不读取原件。 */
  validateAttachmentRefs(conversationId: string, value: unknown): ConversationAttachmentRef[] {
    return normalizeAttachmentRefs(value).map((ref) => {
      const hasFiles = this.one("SELECT name FROM sqlite_master WHERE type='table' AND name='file_references'");
      const file = hasFiles ? this.one<{ metadata: string; version: number; status: string }>(`SELECT f.metadata,f.version,f.status
        FROM file_references f JOIN file_reference_relations r ON r.file_id=f.id
        WHERE f.id=? AND r.kind='conversation' AND r.relation_id=?`, ref.fileRefId, conversationId) : undefined;
      if (!file) throw new CoreError('ATTACHMENT_NOT_FOUND', '附件未登记在当前会话中，请重新挂载。', 404);
      const metadata = JSON.parse(file.metadata) as Pick<FileReference, 'source' | 'kind'>;
      if (!['user-attached', 'user-selected'].includes(metadata.source) || metadata.kind !== 'file') {
        throw new CoreError('INVALID_ATTACHMENT_SOURCE', '只接受用户明确挂载的普通文件。', 400);
      }
      if (file.version !== ref.version) throw new CoreError('STALE_ATTACHMENT', '附件版本已变化，请重新挂载当前版本。');
      if (file.status !== 'available') throw new CoreError('ATTACHMENT_UNAVAILABLE', '附件已变化或不可用，请先核对原件。');
      return ref;
    });
  }

  createConversation(backendId: string, title = '新会话', pluginId: ConversationPlugin = 'pi'): ConversationState {
    const id = this.database.transaction(() => this.insertConversation(backendId, title, pluginId));
    return this.state(id);
  }

  private insertConversation(backendId: string, title: string, pluginId: ConversationPlugin): string {
    if (pluginId !== 'pi' && pluginId !== 'direct') throw new CoreError('INVALID_PLUGIN', '请选择智能对话或本机直接执行。', 400);
    const id = randomUUID(), branchId = randomUUID(), now = new Date().toISOString();
    this.execute('INSERT INTO conversations(id,title,plugin_id,backend_id,selected_branch_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, title.trim().slice(0, 120) || '新会话', pluginId, pluginId === 'direct' ? 'direct' : backendId, branchId, now, now);
    this.execute('INSERT INTO branches(id,conversation_id,created_at,updated_at) VALUES(?,?,?,?)', branchId, id, now, now);
    this.ensureDraft(id, branchId);
    return id;
  }

  forkConversation(sourceId: string, request?: { id: string; revision: number }): ConversationState {
    const id = this.database.transaction(() => {
      const source = this.conversation(sourceId), branch = this.branch(source.selected_branch_id);
      const rows = this.all<MessageRow>('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid', sourceId);
      const path = selectPath(this.displayMessages(sourceId, rows), branch.head_message_id);
      const byId = new Map(rows.map(row => [row.id, row]));
      const id = this.insertConversation(source.backend_id, `${source.title.slice(0, 110)} · 分支`, source.plugin_id);
      const target = this.conversation(id), ids = new Map(path.map(message => [message.id, randomUUID()]));
      this.execute('UPDATE conversations SET project_id=?,thinking_level=? WHERE id=?', source.project_id, source.thinking_level, id);
      for (const message of path) {
        const mapped = ids.get(message.id)!, row = byId.get(message.id)!;
        this.execute(`INSERT INTO messages(id,conversation_id,parent_id,run_id,role,text,status,created_at,finalized_at,native_json,native_context_json,usage_json,raw_stop_reason,failure_code,attachment_refs_json)
          SELECT ?,?,?,NULL,role,text,status,created_at,finalized_at,native_json,native_context_json,usage_json,raw_stop_reason,failure_code,attachment_refs_json FROM messages WHERE id=?`,
        mapped, id, message.parentId ? ids.get(message.parentId)! : null, message.id);
        if (!row.native_json && message.thinking) this.appendEvent(id, 'THINKING_DELTA', { messageId: mapped, delta: message.thinking });
        for (const ref of message.attachmentRefs ?? []) this.execute(`INSERT OR IGNORE INTO file_reference_relations(file_id,kind,relation_id)
          SELECT file_id,'conversation',? FROM file_reference_relations WHERE file_id=? AND kind='conversation' AND relation_id=?`, id, ref.fileRefId, sourceId);
      }
      const head = branch.head_message_id ? ids.get(branch.head_message_id)! : null;
      this.execute('UPDATE branches SET head_message_id=? WHERE id=?', head, target.selected_branch_id);
      this.appendEvent(id, 'CONVERSATION_UPDATED', { messageId: head });
      if (request) this.execute('INSERT INTO conversation_forks(request_id,source_id,source_revision,target_id) VALUES(?,?,?,?)', request.id, sourceId, request.revision, id);
      return id;
    });
    return this.state(id);
  }

  list(view: ConversationVisibility = 'active', query = '', pluginId: ConversationPlugin = 'pi'): ConversationSummary[] {
    // 核心先于本机消息服务初始化；仅在表已存在且确实搜索正文时引用它。
    const searchDirectMessages = pluginId === 'direct' && query !== ''
      && !!this.one("SELECT name FROM sqlite_master WHERE type='table' AND name='direct_messages'");
    const directSearch = searchDirectMessages ? ` OR EXISTS (
      SELECT 1 FROM direct_messages d WHERE d.conversation_id=c.id
      AND (instr(lower(d.text),lower(?))>0 OR instr(lower(COALESCE(d.response,'')),lower(?))>0)
    )` : '';
    return this.all<ConversationRow & { message_count: number; active_run_id: string | null; pinned_at: string | null; group_name: string | null; display_revision: number | null }>(`
      SELECT c.*, d.pinned_at, d.group_name, d.revision AS display_revision, CASE WHEN c.plugin_id='direct' THEN c.direct_message_count
        ELSE (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) END AS message_count,
      (SELECT r.id FROM runs r WHERE r.conversation_id=c.id AND r.state IN ('starting','running','stopping')) AS active_run_id
      FROM conversations c LEFT JOIN conversation_display_metadata d ON d.conversation_id=c.id
      WHERE c.plugin_id=? AND c.visibility=? AND (?='' OR instr(lower(c.title),lower(?))>0 OR EXISTS (
        SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND instr(lower(m.text),lower(?))>0
      )${directSearch}) ORDER BY CASE WHEN c.visibility='active' AND d.pinned_at IS NOT NULL THEN 0 ELSE 1 END,
      CASE WHEN c.visibility='active' THEN d.pinned_at END DESC, c.updated_at DESC, c.rowid DESC
    `, pluginId, view, query, query, query, ...(searchDirectMessages ? [query, query] : [])).map((row) => ({ conversationId: row.id, title: row.title, pluginId: row.plugin_id, backendId: row.backend_id, projectId: row.project_id,
      visibility: row.visibility, sequence: row.sequence,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}), ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}), status: row.status,
      activeRunId: row.active_run_id, updatedAt: row.updated_at, messageCount: row.message_count,
      displayMetadata: { pinnedAt: row.pinned_at, group: row.group_name, revision: row.display_revision ?? 0 } }));
  }

  state(id: string, supportsCompaction = false, historyLimit?: number): ConversationState {
    const c = this.conversation(id), branch = this.branch(c.selected_branch_id);
    const page = historyLimit === undefined ? undefined : this.historyPage(id, branch.id, undefined, historyLimit);
    const messages = page?.messages ?? this.displayMessages(id, this.all<MessageRow & { agent_display_name: string | null }>(`
      SELECT m.*, ${frozenAgentName} AS agent_display_name FROM messages m LEFT JOIN runs r ON r.id=m.run_id AND r.conversation_id=m.conversation_id
      WHERE m.conversation_id=? ORDER BY m.rowid`, id));
    const run = this.one<RunRow>('SELECT * FROM runs WHERE conversation_id=? AND branch_id=? ORDER BY rowid DESC LIMIT 1', id, branch.id);
    const active = this.one<RunRow>("SELECT * FROM runs WHERE conversation_id=? AND branch_id=? AND state IN ('starting','running','stopping')", id, branch.id);
    let contextEvent = run && this.one<{ payload_json: string }>("SELECT payload_json FROM events WHERE conversation_id=? AND run_id=? AND json_type(payload_json,'$.contextUsage')='object' ORDER BY sequence DESC LIMIT 1", id, run.id);
    if (!contextEvent && run?.kind === 'compaction' && run.state === 'succeeded'
      && run.compaction_json && (JSON.parse(run.compaction_json) as { changed?: boolean }).changed === false) {
      contextEvent = this.one<{ payload_json: string }>(`SELECT e.payload_json FROM events e JOIN runs r ON r.id=e.run_id
        WHERE e.conversation_id=? AND r.branch_id=? AND json_type(e.payload_json,'$.contextUsage')='object'
        AND json_extract(e.payload_json,'$.contextUsage.modelId')=json_extract(?,'$.modelId')
        AND json_extract(e.payload_json,'$.contextUsage.provider')=json_extract(?,'$.provider')
        ORDER BY e.sequence DESC LIMIT 1`, id, branch.id, run.configuration_json, run.configuration_json);
    }
    const contextUsage = contextEvent ? (JSON.parse(contextEvent.payload_json) as CoreEvent).contextUsage : undefined;
    const queue = this.all<CommandRow>("SELECT * FROM commands WHERE conversation_id=? AND branch_id=? AND kind IN ('queue','steer','interrupt') AND state IN ('queued','steering','held','failed') ORDER BY COALESCE(queue_order,rowid),rowid", id, branch.id);
    return {
      conversationId: id, title: c.title, pluginId: c.plugin_id, backendId: c.backend_id, projectId: c.project_id,
      supportsCompaction: c.plugin_id === 'pi' && supportsCompaction,
      visibility: c.visibility,
      ...(c.archived_at ? { archivedAt: c.archived_at } : {}), ...(c.deleted_at ? { deletedAt: c.deleted_at } : {}),
      branchId: branch.id, headId: branch.head_message_id,
      treeRevision: c.tree_revision, updatedAt: c.updated_at, sessionRef: branch.session_ref,
      status: c.status, activeRunId: active?.id ?? null, messages: page ? messages : selectPath(messages, branch.head_message_id), messageTree: messages,
      directMessageCount: c.plugin_id === 'direct' ? c.direct_message_count : 0,
      branches: this.all<BranchRow>('SELECT * FROM branches WHERE conversation_id=? ORDER BY rowid', id).map((b) => ({ id: b.id, headId: b.head_message_id, createdAt: b.created_at })),
      draft: this.draft(id, branch.id),
      queue: queue.map((q) => ({ id: q.id, text: q.text, attachmentRefs: readAttachmentRefs(q.attachment_refs_json), kind: q.kind as PendingInput['kind'], state: q.state as PendingInput['state'], createdAt: q.created_at, error: q.error })),
      queuePaused: Boolean(c.queue_paused), lastRun: run ? toRun(run) : null, error: c.error, sequence: c.sequence,
      ...(contextUsage ? { contextUsage } : {}),
      ...(page ? { history: { before: page.before, hasMore: page.hasMore,
        totalMessages: this.one<{ count: number }>('SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?', id)!.count,
        branchMessages: this.branchLength(id, branch.head_message_id).count } } : {}),
    };
  }

  historyPage(conversationId: string, branchId: string, before?: string, limit = 40): MessageHistoryPage {
    validateHistoryLimit(limit);
    const conversation = this.conversation(conversationId), branch = this.branch(branchId);
    if (branch.conversation_id !== conversationId || conversation.selected_branch_id !== branchId) {
      throw new CoreError('HISTORY_CONFLICT', '阅读分支已变化，请重新加载当前会话。');
    }
    const cursor = before === undefined ? undefined : readHistoryCursor(before);
    if (cursor && (cursor.conversationId !== conversationId || cursor.branchId !== branchId)) {
      throw new CoreError('INVALID_CURSOR', '历史游标不属于当前会话和分支。', 400);
    }
    const lineage = this.branchLength(conversationId, branch.head_message_id, cursor?.messageId);
    if (cursor && !lineage.includesCursor) throw new CoreError('HISTORY_CONFLICT', '历史游标已不属于当前分支，请重新加载会话。');
    const startId = cursor ? this.message(cursor.messageId).parent_id : branch.head_message_id;
    type PageRow = DisplayMessageRow & { depth: number; agent_display_name: string | null };
    const columns = 'id,parent_id,run_id,role,text,status,created_at,raw_stop_reason,failure_code,attachment_refs_json,native_json,usage_json';
    const rows = startId ? this.all<PageRow>(`WITH RECURSIVE path(${columns},depth) AS (
      SELECT ${columns},0 FROM messages WHERE id=? AND conversation_id=?
      UNION ALL SELECT ${columns.split(',').map((column) => `m.${column}`).join(',')},p.depth+1
      FROM messages m JOIN path p ON m.id=p.parent_id WHERE m.conversation_id=? AND p.depth<?
    ) SELECT p.*, ${frozenAgentName} AS agent_display_name FROM path p LEFT JOIN runs r ON r.id=p.run_id AND r.conversation_id=?
      ORDER BY p.depth LIMIT ?`, startId, conversationId, conversationId, limit, conversationId, limit + 1) : [];
    const hasMore = rows.length > limit, messages = this.displayMessages(conversationId, rows.slice(0, limit).reverse());
    return { conversationId, branchId, messages, hasMore,
      before: hasMore && messages[0] ? historyCursor(conversationId, branchId, messages[0].id) : null, sequence: conversation.sequence };
  }

  private displayMessages(conversationId: string, rows: readonly DisplayMessageRow[]): ChatMessage[] {
    const messages = rows.map(toMessage);
    const pending = new Map(messages.filter((message, index) => message.role === 'assistant' && !rows[index]!.native_json).map(message => [message.id, message]));
    if (!pending.size) return messages;
    const messageIds = [...pending.keys()];
    const events = this.all<{ payload_json: string }>(`SELECT payload_json FROM events WHERE conversation_id=? AND type='THINKING_DELTA'
      AND json_extract(payload_json,'$.messageId') IN (${messageIds.map(() => '?').join(',')}) ORDER BY sequence`, conversationId, ...messageIds);
    for (const row of events) {
      const event = JSON.parse(row.payload_json) as CoreEvent, message = event.messageId ? pending.get(event.messageId) : undefined;
      if (message && event.delta) message.thinking = (message.thinking ?? '') + event.delta;
    }
    return messages;
  }

  private branchLength(conversationId: string, headId: string | null, cursorId?: string): { count: number; includesCursor: number } {
    if (!headId) return { count: 0, includesCursor: 0 };
    const path = this.one<{ count: number; roots: number; includesCursor: number }>(`WITH RECURSIVE ancestry(id,parent_id) AS (
      SELECT id,parent_id FROM messages WHERE id=? AND conversation_id=?
      UNION SELECT m.id,m.parent_id FROM messages m JOIN ancestry p ON m.id=p.parent_id WHERE m.conversation_id=?
    ) SELECT COUNT(*) AS count,SUM(parent_id IS NULL) AS roots,MAX(id=?) AS includesCursor FROM ancestry`, headId, conversationId, conversationId, cursorId ?? '');
    if (!path || path.roots !== 1) throw new CoreError('HISTORY_CORRUPT', '此分支的历史关系不完整，不能推测缺失消息。', 409);
    return path;
  }

  history(conversationId: string, headId: string | null): BackendHistoryMessage[] {
    const rows = this.all<MessageRow>('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid', conversationId);
    const path = selectPath(rows.map(toMessage), headId);
    const byId = new Map(rows.map((m) => [m.id, m]));
    return path.map((message) => ({ ...message,
      ...(byId.get(message.id)?.native_json ? { nativeMessage: JSON.parse(byId.get(message.id)!.native_json!) as unknown } : {}),
      ...(byId.get(message.id)?.native_context_json ? { nativeFollowing: JSON.parse(byId.get(message.id)!.native_context_json!) as unknown[] } : {}) }));
  }

  checkpoint(branch: BranchRow, historyHead: string | null, backendId?: string): BackendCheckpoint | undefined {
    if (branch.checkpoint_head_id !== historyHead || !branch.checkpoint_json) return undefined;
    const checkpoint = JSON.parse(branch.checkpoint_json) as BackendCheckpoint;
    return backendId && checkpoint.backendId !== backendId ? undefined : checkpoint;
  }

  saveCheckpoint(branchId: string, headId: string | null, checkpoint: BackendCheckpoint): void {
    this.execute('UPDATE branches SET checkpoint_json=?,checkpoint_head_id=?,session_ref=? WHERE id=?', JSON.stringify(checkpoint), headId, checkpoint.sessionRef, branchId);
  }

  ensureDraft(conversationId: string, branchId: string, kind = 'main', targetId = '', attachmentRefs: ConversationAttachmentRef[] = []): DraftState {
    const key = `${conversationId}:${branchId}:${kind}:${targetId}`;
    this.execute('INSERT OR IGNORE INTO drafts(key,conversation_id,branch_id,kind,target_id,updated_at,attachment_refs_json) VALUES(?,?,?,?,?,?,?)', key, conversationId, branchId, kind, targetId, new Date().toISOString(), JSON.stringify(attachmentRefs));
    return this.draft(conversationId, branchId, key);
  }

  draft(conversationId: string, branchId: string, key = `${conversationId}:${branchId}:main:`): DraftState {
    const row = this.one<DraftRow>('SELECT * FROM drafts WHERE key=? AND conversation_id=? AND branch_id=?', key, conversationId, branchId);
    if (!row) throw new CoreError('DRAFT_NOT_FOUND', '草稿不存在或不属于当前分支。', 404);
    return { key: row.key, text: row.text, attachmentRefs: readAttachmentRefs(row.attachment_refs_json), revision: row.revision, updatedAt: row.updated_at };
  }

  updateDraft(conversationId: string, key: string, text: string, revision: number, attachmentRefs: ConversationAttachmentRef[] = []): DraftState {
    const row = this.one<DraftRow>('SELECT * FROM drafts WHERE key=? AND conversation_id=?', key, conversationId);
    if (!row) throw new CoreError('DRAFT_NOT_FOUND', '草稿不存在或不属于当前会话。', 404);
    const current = this.draft(conversationId, row.branch_id, key);
    if (current.revision !== revision) {
      const error = new CoreError('DRAFT_CONFLICT', '草稿已在其他请求中更新，当前输入仍保留。');
      Object.assign(error, { draft: current });
      throw error;
    }
    this.execute('UPDATE drafts SET text=?,attachment_refs_json=?,revision=revision+1,updated_at=? WHERE key=? AND revision=?', text, JSON.stringify(attachmentRefs), new Date().toISOString(), key, revision);
    return this.draft(conversationId, row.branch_id, key);
  }

  retireDraft(conversationId: string, branchId: string, draft: { key: string; revision: number } | undefined,
    accepted: { kind: 'main' | 'edit'; targetId: string; text: string; attachmentRefs?: ConversationAttachmentRef[] }): void {
    if (!draft) return;
    this.execute(`UPDATE drafts SET text='',attachment_refs_json='[]',revision=revision+1,retired_revision=revision+1,updated_at=?
      WHERE key=? AND conversation_id=? AND branch_id=? AND kind=? AND target_id=? AND revision=? AND text=? AND attachment_refs_json=?`,
    new Date().toISOString(), draft.key, conversationId, branchId, accepted.kind, accepted.targetId, draft.revision, accepted.text, JSON.stringify(accepted.attachmentRefs ?? []));
  }

  appendEvent(conversationId: string, type: CoreEvent['type'], fields: Partial<Omit<CoreEvent, 'type' | 'conversationId' | 'sequence' | 'timestamp'>> = {}): CoreEvent {
    const now = new Date().toISOString();
    this.execute('UPDATE conversations SET sequence=sequence+1,updated_at=? WHERE id=?', now, conversationId);
    const event: CoreEvent = { type, conversationId, runId: null, messageId: null, ...fields,
      sequence: this.conversation(conversationId).sequence, timestamp: now };
    this.execute('INSERT INTO events(conversation_id,run_id,sequence,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', conversationId, event.runId, event.sequence, type, JSON.stringify(event), now);
    return event;
  }
}

export function commandReceipt(row: CommandRow): SendReceipt { return { commandId: row.id, runId: row.run_id, status: row.state }; }

export function readAttachmentRefs(value: string): ConversationAttachmentRef[] { return JSON.parse(value) as ConversationAttachmentRef[]; }

export function normalizeAttachmentRefs(value: unknown): ConversationAttachmentRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new CoreError('INVALID_ATTACHMENTS', '附件需为不超过32项的引用数组。', 400);
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new CoreError('INVALID_ATTACHMENTS', '附件引用无效。', 400);
    const ref = entry as Record<string, unknown>;
    if (Object.keys(ref).some((key) => !['fileRefId', 'version', 'category', 'displayName'].includes(key))
      || typeof ref.fileRefId !== 'string' || !ref.fileRefId || ref.fileRefId.length > 160 || /[\u0000-\u001f\u007f]/.test(ref.fileRefId)
      || !Number.isSafeInteger(ref.version) || Number(ref.version) < 1 || !['unclassified', 'data', 'tool'].includes(String(ref.category))
      || (ref.displayName !== undefined && (typeof ref.displayName !== 'string' || !ref.displayName.trim()
        || ref.displayName.length > 512 || /[\u0000-\u001f\u007f]/.test(ref.displayName)))) {
      throw new CoreError('INVALID_ATTACHMENTS', '附件需要有效文件编号、版本和数据或工具分类。', 400);
    }
    if (seen.has(ref.fileRefId)) throw new CoreError('INVALID_ATTACHMENTS', '同一文件不能在一条输入中重复挂载。', 400);
    seen.add(ref.fileRefId);
    return { fileRefId: ref.fileRefId, version: Number(ref.version), category: ref.category as ConversationAttachmentRef['category'],
      ...(ref.displayName === undefined ? {} : { displayName: ref.displayName as string }) };
  });
}

type DisplayMessageRow = Pick<MessageRow, 'id' | 'parent_id' | 'run_id' | 'role' | 'text' | 'status' | 'created_at' | 'raw_stop_reason' | 'failure_code' | 'attachment_refs_json' | 'native_json' | 'usage_json'> & { agent_display_name?: string | null };
function toMessage(row: DisplayMessageRow): ChatMessage {
  const native = row.native_json ? JSON.parse(row.native_json) as { role?: string; content?: Array<{ type?: string; thinking?: string; redacted?: boolean }>; model?: string; provider?: string } : undefined;
  const thinking = row.role === 'assistant' && native?.role === 'assistant' && Array.isArray(native.content)
    ? native.content.filter(part => part.type === 'thinking' && part.redacted !== true && typeof part.thinking === 'string').map(part => part.thinking).join('') : undefined;
  const usage = row.role === 'assistant' && row.usage_json ? JSON.parse(row.usage_json) as { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } : undefined;
  const validUsage = usage && [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0].every(value => Number.isFinite(value) && value >= 0);
  return { id: row.id, parentId: row.parent_id, runId: row.run_id, role: row.role, text: row.text, status: row.status,
    ...(thinking ? { thinking } : {}),
    ...(validUsage ? { usage: { inputTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), outputTokens: usage.outputTokens, uncachedInputTokens: usage.inputTokens,
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}), ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      ...(typeof native?.model === 'string' ? { modelId: native.model } : {}), ...(typeof native?.provider === 'string' ? { provider: native.provider } : {}) } } : {}),
    createdAt: row.created_at, attachmentRefs: readAttachmentRefs(row.attachment_refs_json), ...(row.raw_stop_reason ? { rawStopReason: row.raw_stop_reason } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.role === 'assistant' && typeof row.agent_display_name === 'string' && row.agent_display_name.trim()
      ? { agentDisplayName: row.agent_display_name } : {}) };
}

export function validateHistoryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new CoreError('INVALID_LIMIT', '每次读取需为1到200条消息。', 400);
}
function historyCursor(conversationId: string, branchId: string, messageId: string): string {
  return Buffer.from(JSON.stringify({ version: 1, conversationId, branchId, messageId })).toString('base64url');
}
function readHistoryCursor(value: string): { conversationId: string; branchId: string; messageId: string } {
  if (typeof value !== 'string' || value.length > 1_024 || !/^[\w-]+$/.test(value)) throw new CoreError('INVALID_CURSOR', '历史游标无效。', 400);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version === 1
      && 'conversationId' in parsed && typeof parsed.conversationId === 'string'
      && 'branchId' in parsed && typeof parsed.branchId === 'string'
      && 'messageId' in parsed && typeof parsed.messageId === 'string') return parsed as { conversationId: string; branchId: string; messageId: string };
  } catch { /* 游标只定位已有消息，不能替代分支归属核对。 */ }
  throw new CoreError('INVALID_CURSOR', '历史游标无效。', 400);
}

/** 从已提交快照生成界面窗口，避免实时事件再读到更晚的数据库版本。 */
export function windowConversationState(state: ConversationState, limit: number): ConversationState {
  validateHistoryLimit(limit);
  const messages = state.messages.slice(-limit), hasMore = !!state.history?.hasMore || state.messages.length > limit;
  return { ...state, messages, messageTree: messages, history: {
    before: hasMore && messages[0] ? historyCursor(state.conversationId, state.branchId, messages[0].id) : null,
    hasMore, totalMessages: state.history?.totalMessages ?? state.messageTree.length,
    branchMessages: state.history?.branchMessages ?? state.messages.length,
  } };
}
function toRun(row: RunRow): RunSummary {
  const frozen = row.configuration_json ? JSON.parse(row.configuration_json) as FrozenRunConfiguration : undefined;
  const configuration = frozen ? (({ personaText: _text, internalAgentRulesText: _rulesText, ...publicConfiguration }) => publicConfiguration)(frozen) : undefined;
  return { id: row.id, conversationId: row.conversation_id, branchId: row.branch_id, kind: row.kind, state: row.state,
    ...(row.compaction_json ? { compaction: JSON.parse(row.compaction_json) as RunSummary['compaction'] } : {}),
    ...(row.thinking_level ? { thinkingLevel: row.thinking_level } : {}),
    ...(configuration ? { configuration } : {}),
    generation: row.generation, startedAt: row.started_at, settledAt: row.settled_at,
    rawStopReason: row.raw_stop_reason, failureCode: row.failure_code };
}
function selectPath(messages: ChatMessage[], headId: string | null): ChatMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const path: ChatMessage[] = [], seen = new Set<string>();
  let id = headId;
  while (id) {
    const message = byId.get(id);
    if (!message || seen.has(id)) throw new Error('会话消息树损坏，不能推测历史。');
    seen.add(id); path.push(message); id = message.parentId;
  }
  return path.reverse();
}
