import { randomUUID } from 'node:crypto';
import { CoreError } from '../../platform/runtime/errors.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { DirectChatEntry, DirectChatPage } from '../../contracts/direct-conversation-contracts.js';

interface Row {
  sequence: number; id: string; conversation_id: string; request_id: string; digest: string;
  text: string; response: string | null; task_id: string | null; created_at: string;
}
const entry = (row: Row): DirectChatEntry => ({ sequence: row.sequence, id: row.id, conversationId: row.conversation_id, requestId: row.request_id,
  text: row.text, response: row.response, taskId: row.task_id, createdAt: row.created_at });

/** 本机输入与任务引用由核心保存；不构造模型消息或模型检查点。 */
export class DirectConversationService {
  constructor(private readonly database: CoreDatabase) {
    database.migrate('direct_conversations', 1, `CREATE TABLE direct_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id), request_id TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL, text TEXT NOT NULL, response TEXT,
      task_id TEXT REFERENCES tasks(id), created_at TEXT NOT NULL,
      CHECK ((task_id IS NULL AND response IS NOT NULL) OR (task_id IS NOT NULL AND response IS NULL))
    ); CREATE INDEX direct_messages_conversation ON direct_messages(conversation_id,sequence);`);
  }
  previous(requestId: string, conversationId: string, digest: string): DirectChatEntry | null {
    const row = this.database.connection.prepare('SELECT * FROM direct_messages WHERE request_id=?').get(requestId) as unknown as Row | undefined;
    if (!row) return null;
    if (row.conversation_id !== conversationId || row.digest !== digest) throw new CoreError('REQUEST_CONFLICT', '此请求编号已经用于不同输入。');
    return entry(row);
  }
  record(input: { requestId: string; conversationId: string; digest: string; text: string; taskId?: string; response?: string }): DirectChatEntry {
    if (!this.database.connection.isTransaction) throw new CoreError('DIRECT_TRANSACTION_REQUIRED', '本机消息必须与输入接收一起保存。');
    const previous = this.previous(input.requestId, input.conversationId, input.digest);
    if (previous) return previous;
    const conversation = this.database.connection.prepare('SELECT plugin_id FROM conversations WHERE id=?').get(input.conversationId);
    if (conversation?.plugin_id !== 'direct') throw new CoreError('PLUGIN_MISMATCH', '本机消息只能保存在本机插件会话中。');
    if (input.taskId) {
      const task = this.database.connection.prepare('SELECT conversation_id,runtime_id FROM tasks WHERE id=?').get(input.taskId);
      if (task?.conversation_id !== input.conversationId || task.runtime_id !== 'direct') throw new CoreError('TASK_CONVERSATION_MISMATCH', '任务不属于当前本机会话。');
    }
    const id = randomUUID(), createdAt = new Date().toISOString();
    const write = this.database.connection.prepare(`INSERT INTO direct_messages(id,conversation_id,request_id,digest,text,response,task_id,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, input.conversationId, input.requestId, input.digest, input.text, input.response ?? null, input.taskId ?? null, createdAt);
    this.database.connection.prepare('UPDATE conversations SET direct_message_count=direct_message_count+2 WHERE id=?').run(input.conversationId);
    return { sequence: Number(write.lastInsertRowid), id, conversationId: input.conversationId, requestId: input.requestId, text: input.text, response: input.response ?? null, taskId: input.taskId ?? null, createdAt };
  }
  list(conversationId: string, before?: string, limit = 40): DirectChatPage {
    const conversation = this.database.connection.prepare('SELECT plugin_id FROM conversations WHERE id=?').get(conversationId);
    if (!conversation) throw new CoreError('CONVERSATION_NOT_FOUND', '会话不存在。', 404);
    if (conversation.plugin_id !== 'direct') throw new CoreError('PLUGIN_MISMATCH', '此会话不属于本机插件。', 400);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CoreError('INVALID_LIMIT', '每页消息数量无效。', 400);
    let cursor = Number.MAX_SAFE_INTEGER;
    if (before !== undefined) {
      const row = this.database.connection.prepare('SELECT sequence FROM direct_messages WHERE id=? AND conversation_id=?').get(before, conversationId);
      if (!row) throw new CoreError('INVALID_CURSOR', '本机历史游标不属于当前会话。', 400);
      cursor = Number(row.sequence);
    }
    const rows = this.database.connection.prepare('SELECT * FROM direct_messages WHERE conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?')
      .all(conversationId, cursor, limit + 1) as unknown as Row[];
    const selected = rows.slice(0, limit).reverse();
    return { conversationId, messages: selected.map(entry), hasMore: rows.length > limit, before: selected[0]?.id ?? null };
  }
}
