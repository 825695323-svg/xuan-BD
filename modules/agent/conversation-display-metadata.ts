import { CoreError } from '../../platform/runtime/errors.js';
import type { ConversationDisplayMetadata, ConversationPlugin, ConversationVisibility } from '../../contracts/contracts.js';
import type { CoreDatabase } from '../../platform/state/database.js';

interface MetadataRow { pinned_at: string | null; group_name: string | null; revision: number }

/** 会话展示组织独立持久化，不修改核心会话、项目、草稿或运行记录。 */
export class ConversationDisplayMetadataRepository {
  constructor(private readonly database: CoreDatabase) {
    database.migrate('conversation_display_metadata', 1, `CREATE TABLE conversation_display_metadata (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
      pinned_at TEXT, group_name TEXT, revision INTEGER NOT NULL CHECK(revision >= 0)
    );`);
  }

  get(conversationId: string): ConversationDisplayMetadata {
    const row = this.database.connection.prepare('SELECT pinned_at,group_name,revision FROM conversation_display_metadata WHERE conversation_id=?').get(conversationId) as MetadataRow | undefined;
    return { pinnedAt: row?.pinned_at ?? null, group: row?.group_name ?? null, revision: row?.revision ?? 0 };
  }

  update(conversationId: string, pluginId: ConversationPlugin, value: unknown): ConversationDisplayMetadata {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CoreError('INVALID_METADATA', '会话展示设置必须是对象。', 400);
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some(key => !['revision', 'pinned', 'group'].includes(key))
      || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0
      || (!Object.hasOwn(body, 'pinned') && !Object.hasOwn(body, 'group'))
      || (Object.hasOwn(body, 'pinned') && typeof body.pinned !== 'boolean')
      || (Object.hasOwn(body, 'group') && body.group !== null && (typeof body.group !== 'string' || !body.group.trim()
        || body.group.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(body.group)))) {
      throw new CoreError('INVALID_METADATA', '固定状态需为布尔值，分组需为1到80个字符；移除分组请使用null。', 400);
    }
    return this.database.transaction(() => {
      const conversation = this.database.connection.prepare('SELECT plugin_id,visibility FROM conversations WHERE id=?').get(conversationId) as { plugin_id: ConversationPlugin; visibility: ConversationVisibility } | undefined;
      if (!conversation || conversation.plugin_id !== pluginId) throw new CoreError('NOT_FOUND', '当前会话列表中不存在此会话。', 404);
      if (conversation.visibility === 'trashed') throw new CoreError('CONVERSATION_READ_ONLY', '请先恢复会话，再更改固定或分组。', 409);
      if (body.pinned === true && conversation.visibility !== 'active') throw new CoreError('CONVERSATION_READ_ONLY', '请先恢复会话，再固定到当前会话列表。', 409);
      const current = this.get(conversationId);
      if (body.revision !== current.revision) throw new CoreError('METADATA_CONFLICT', '会话展示设置已变化，请重新核对列表后再操作。', 409);
      const pinnedAt = body.pinned === true ? current.pinnedAt ?? new Date().toISOString() : body.pinned === false ? null : current.pinnedAt;
      const group = Object.hasOwn(body, 'group') ? (typeof body.group === 'string' ? body.group.trim() : null) : current.group;
      if (pinnedAt === current.pinnedAt && group === current.group) return current;
      const next = { pinnedAt, group, revision: current.revision + 1 };
      this.database.connection.prepare(`INSERT INTO conversation_display_metadata(conversation_id,pinned_at,group_name,revision) VALUES(?,?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET pinned_at=excluded.pinned_at,group_name=excluded.group_name,revision=excluded.revision`)
        .run(conversationId, next.pinnedAt, next.group, next.revision);
      return next;
    });
  }
}
