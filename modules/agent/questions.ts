import { randomUUID } from 'node:crypto';
import type { AgentQuestion } from '../../contracts/agent-question-contracts.js';
import type { BackendInput } from '../../contracts/backend.js';
import type { SendReceipt } from '../../contracts/contracts.js';
import { CoreError } from '../../platform/runtime/errors.js';
import type { CoreDatabase } from '../../platform/state/database.js';
import type { PersonalCore } from './runtime/core.js';
import { commandReceipt, type CommandRow } from './state/store.js';

interface QuestionRow {
  id: string; conversation_id: string; branch_id: string; run_id: string; generation: number;
  input_id: string; message_id: string; tool_call_id: string; question: string; options_json: string;
  status: AgentQuestion['status']; answer: string | null; request_id: string | null; receipt_json: string | null;
  created_at: number; updated_at: number;
}

/** 用户回答是同一会话中的新输入；问题和选项均不授予操作权限。 */
export class AgentQuestionService {
  constructor(private readonly database: CoreDatabase, private readonly core: PersonalCore) {
    database.migrate('agent_questions', 1, `CREATE TABLE agent_questions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      branch_id TEXT NOT NULL REFERENCES branches(id), run_id TEXT NOT NULL REFERENCES runs(id), generation INTEGER NOT NULL,
      input_id TEXT NOT NULL REFERENCES commands(id), message_id TEXT NOT NULL REFERENCES messages(id), tool_call_id TEXT NOT NULL,
      question TEXT NOT NULL, options_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','answered','dismissed')),
      answer TEXT, request_id TEXT, receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(run_id,generation,tool_call_id)
    ); CREATE INDEX agent_questions_branch ON agent_questions(conversation_id,branch_id,created_at);`);
  }
  private get db() { return this.database.connection; }

  create(input: BackendInput, toolCallId: string, question: string, options: string[] = []): AgentQuestion {
    if (typeof question !== 'string' || !question.trim() || question.trim().length > 2000
      || typeof toolCallId !== 'string' || !toolCallId.trim() || toolCallId.length > 200
      || !Array.isArray(options) || options.length > 6 || options.some(option => typeof option !== 'string' || !option.trim() || option.trim().length > 200)) {
      throw new CoreError('INVALID_QUESTION', '问题需为1到2000字，最多6个选项，每项1到200字。', 400);
    }
    const text = question.trim(), choices = options.map(option => option.trim());
    return this.database.transaction(() => {
      const run = this.core.store.run(input.runId), conversation = this.core.store.conversation(input.conversationId), command = this.core.store.command(input.inputId);
      if (!this.core.isRunActive(input.runId, input.generation) || run.kind !== 'chat'
        || run.conversation_id !== input.conversationId || run.branch_id !== input.branchId || run.generation !== input.generation
        || conversation.selected_branch_id !== input.branchId || conversation.generation !== input.generation
        || command.conversation_id !== input.conversationId || command.branch_id !== input.branchId
        || command.run_id !== input.runId || command.generation !== input.generation || command.input_message_id !== input.messageId
        || command.text !== input.text || !['accepted', 'consumed', 'steering'].includes(command.state)) {
        throw new CoreError('STALE_QUESTION_INPUT', '提问不属于当前会话仍有效的运行输入。');
      }
      const previous = this.db.prepare('SELECT * FROM agent_questions WHERE run_id=? AND generation=? AND tool_call_id=?').get(input.runId, input.generation, toolCallId) as unknown as QuestionRow | undefined;
      if (previous) {
        if (previous.input_id !== input.inputId || previous.message_id !== input.messageId || previous.question !== text || previous.options_json !== JSON.stringify(choices)) {
          throw new CoreError('QUESTION_CONFLICT', '同一工具调用的提问身份或内容不能改变。');
        }
        return toQuestion(previous);
      }
      const id = randomUUID(), now = Date.now();
      this.db.prepare(`INSERT INTO agent_questions(id,conversation_id,branch_id,run_id,generation,input_id,message_id,tool_call_id,question,options_json,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(id, input.conversationId, input.branchId, input.runId, input.generation, input.inputId, input.messageId, toolCallId, text, JSON.stringify(choices), now, now);
      return toQuestion(this.row(id));
    });
  }

  list(conversationId: string, branchId?: string): AgentQuestion[] {
    const conversation = this.core.store.conversation(conversationId), selected = conversation.selected_branch_id;
    if (branchId !== undefined && branchId !== selected) throw new CoreError('QUESTION_BRANCH_CHANGED', '会话分支已变化，请重新读取当前问题。');
    return (this.db.prepare('SELECT * FROM agent_questions WHERE conversation_id=? AND branch_id=? ORDER BY created_at,rowid').all(conversationId, selected) as unknown as QuestionRow[]).map(toQuestion);
  }

  answer(id: string, answer: string, requestId: string): { question: AgentQuestion; receipt: SendReceipt } {
    if (typeof answer !== 'string' || !answer.trim() || answer.trim().length > 28_000
      || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new CoreError('INVALID_QUESTION_ANSWER', '回答需为1到28000字，并保留有效请求身份。', 400);
    const row = this.row(id), text = answer.trim();
    if (row.status === 'dismissed') throw new CoreError('QUESTION_DISMISSED', '此问题已忽略，不会发送回答。');
    if (row.status === 'answered') {
      if (row.answer !== text) throw new CoreError('QUESTION_ANSWER_CONFLICT', '此问题已有不同回答，不能覆盖或重复发送。');
      return { question: toQuestion(row), receipt: JSON.parse(row.receipt_json!) as SendReceipt };
    }
    const message = `用户对问题的回答（仅补充信息，不构成操作授权）：\n问题：${row.question}\n回答：${text}`;
    // 固定问题身份覆盖发送已接受、问题状态尚未更新的崩溃窗口。
    const stableRequestId = `question-answer-${row.id}`;
    const previous = this.core.store.one<CommandRow>('SELECT * FROM commands WHERE request_id=?', stableRequestId);
    let receipt: SendReceipt;
    if (previous) {
      if (previous.conversation_id !== row.conversation_id || previous.branch_id !== row.branch_id || previous.text !== message) {
        throw new CoreError('QUESTION_ANSWER_CONFLICT', '原问题已有不同的回答请求，不能替换或重发。');
      }
      receipt = commandReceipt(previous);
    } else {
      const conversation = this.core.store.conversation(row.conversation_id);
      if (conversation.selected_branch_id !== row.branch_id) throw new CoreError('QUESTION_BRANCH_CHANGED', '请先回到提问所在分支，再发送回答。');
      receipt = this.core.sendMessage(row.conversation_id, message, stableRequestId,
        { mode: ['RUNNING', 'STOPPING'].includes(conversation.status) ? 'queue' : 'send' });
    }
    if (['failed', 'cancelled'].includes(receipt.status)) throw new CoreError('QUESTION_ANSWER_NOT_ACCEPTED', '原回答请求未被执行，问题仍保留，请核对原请求。');
    this.db.prepare("UPDATE agent_questions SET status='answered',answer=?,request_id=?,receipt_json=?,updated_at=? WHERE id=? AND status='pending'")
      .run(text, requestId, JSON.stringify(receipt), Date.now(), id);
    return { question: toQuestion(this.row(id)), receipt };
  }

  dismiss(id: string): AgentQuestion {
    this.row(id);
    this.db.prepare("UPDATE agent_questions SET status='dismissed',updated_at=? WHERE id=? AND status='pending'").run(Date.now(), id);
    return toQuestion(this.row(id));
  }

  private row(id: string): QuestionRow {
    if (typeof id !== 'string' || !id || id.length > 200) throw new CoreError('INVALID_QUESTION_ID', '问题身份无效。', 400);
    const row = this.db.prepare('SELECT * FROM agent_questions WHERE id=?').get(id) as unknown as QuestionRow | undefined;
    if (!row) throw new CoreError('QUESTION_NOT_FOUND', '没有找到此问题。', 404);
    return row;
  }
}

function toQuestion(row: QuestionRow): AgentQuestion {
  return { id: row.id, conversationId: row.conversation_id, branchId: row.branch_id, question: row.question,
    options: JSON.parse(row.options_json) as string[], status: row.status, answer: row.answer, createdAt: row.created_at, updatedAt: row.updated_at };
}
