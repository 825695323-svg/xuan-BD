import type { CoreDatabase } from '../../platform/state/database.js';
import { TaskError, type TaskService } from '../../platform/jobs/tasks.js';
import type { TaskCompletionClaim } from '../../contracts/task-contracts.js';

export interface ConversationCompletionOrigin {
  conversationId: string;
  branchId: string;
  sourceCommandId: string;
  sourceMessageId: string;
  sourceGeneration: number;
  configurationDigest: string;
}
export type CompletionDisposition = 'accepted' | 'duplicate' | 'stale' | 'busy' | 'stopped';
interface BindingRow { cursor: number; task_id: string; origin_json: string; state: string }

/** Delivery is a projection of task_events. Receiving and acknowledging share the core transaction. */
export class ConversationTaskCompletions {
  private readonly consumerId = 'conversation-task-completion/v1';
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private scheduled = false;
  private draining = false;
  private lastError: string | null = null;
  private lastRowId = 0;

  constructor(private readonly options: {
    database: CoreDatabase;
    tasks: TaskService;
    captureOrigin(commandId: string): ConversationCompletionOrigin;
    receive(origin: ConversationCompletionOrigin, completion: TaskCompletionClaim): CompletionDisposition;
    afterCommit(): void;
  }) {
    options.database.migrate('conversation-task-completions', 1, `
      CREATE TABLE conversation_task_completions (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), origin_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', event_sequence INTEGER,
        disposition TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
    this.unsubscribe = options.tasks.subscribe(() => this.notify());
    // Local delivery leases only; no model requests or external job polling occur here.
    this.timer = setInterval(() => this.notify(), 1000);
    this.timer.unref();
    this.notify();
  }

  bind(taskId: string, commandId: string): void {
    if (this.closed) throw new TaskError('COMPLETION_CLOSED', '任务完成通知已关闭。');
    const task = this.options.tasks.get(taskId), origin = this.options.captureOrigin(commandId);
    if (task.ownerRole !== 'personal' || task.conversationId !== origin.conversationId || task.runtimeId === 'pi') {
      throw new TaskError('COMPLETION_ORIGIN_MISMATCH', '完成通知只能关联原会话的非模型任务。');
    }
    const serialized = JSON.stringify(origin);
    const previous = this.options.database.connection.prepare('SELECT origin_json FROM conversation_task_completions WHERE task_id=?').get(taskId);
    if (previous && previous.origin_json !== serialized) throw new TaskError('COMPLETION_ORIGIN_CONFLICT', '任务已固定到另一原始请求，不能重绑。');
    this.options.database.connection.prepare(`INSERT OR IGNORE INTO conversation_task_completions
      (task_id,origin_json,state,created_at,updated_at) VALUES(?,?,'pending',?,?)`).run(taskId, serialized, Date.now(), Date.now());
    this.notify();
  }

  status() {
    return { pending: Number(this.options.database.connection.prepare("SELECT COUNT(*) AS n FROM conversation_task_completions WHERE state='pending'").get()?.n ?? 0),
      lastError: this.lastError, closed: this.closed };
  }

  notify(): void {
    if (this.closed || this.scheduled || this.draining) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (!this.closed) this.drain(); });
  }

  drain(): void {
    if (this.closed || this.draining) return;
    this.draining = true;
    try {
      // A bounded batch; the lease tick continues a backlog without a model polling loop.
      const rows = this.options.database.connection.prepare("SELECT rowid AS cursor,task_id,origin_json,state FROM conversation_task_completions WHERE state='pending' AND rowid>? ORDER BY rowid LIMIT 100").all(this.lastRowId) as unknown as BindingRow[];
      if (!rows.length) this.lastRowId = 0;
      for (const row of rows) {
        this.lastRowId = row.cursor;
        const claim = this.options.tasks.claimCompletion(this.consumerId, { taskId: row.task_id, leaseMs: 1000 });
        if (!claim) continue;
        const disposition = this.options.database.transaction(() => {
          const disposition = this.options.receive(JSON.parse(row.origin_json) as ConversationCompletionOrigin, claim);
          if (disposition === 'busy') {
            this.options.tasks.releaseCompletion(this.consumerId, claim.sequence, claim.claimId);
            return disposition;
          }
          this.options.database.connection.prepare("UPDATE conversation_task_completions SET state='settled',event_sequence=?,disposition=?,updated_at=? WHERE task_id=? AND state='pending'")
            .run(claim.sequence, disposition, Date.now(), row.task_id);
          this.options.tasks.ackCompletion(this.consumerId, claim.sequence, claim.claimId);
          return disposition;
        });
        if (disposition === 'accepted' || disposition === 'duplicate') this.options.afterCommit();
      }
      this.lastError = null;
    } catch (error) {
      // Failed storage never acknowledges delivery. A new host can reclaim the lease.
      this.lastError = error instanceof TaskError ? error.code : 'COMPLETION_DELIVERY_FAILED';
    } finally { this.draining = false; }
  }

  dispose(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
  }
}
