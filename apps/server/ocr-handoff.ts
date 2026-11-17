import { canonicalWfdJson, isWfdRecord, wfdSha256 } from '../../adapters/database/wfd-transport.js';
import { questionAnswerMessage } from '../../modules/agent/questions.js';
import { CoreError } from '../../platform/runtime/errors.js';
import type { ApplicationServices } from './services.js';
import { readOcrReviewPacket } from './ocr-review.js';

const fail = (): never => { throw new CoreError('OCR_HANDOFF_UNAVAILABLE', 'OCR 问题、会话来源或用户回答未能核对；未记录人工核实或事件资格。', 409); };
const parse = (raw: unknown): Record<string, unknown> => {
  try { const value = JSON.parse(String(raw)); if (isWfdRecord(value)) return value; } catch { /* fail closed */ }
  return fail();
};
const same = (a: unknown, b: unknown) => { try { return canonicalWfdJson(a) === canonicalWfdJson(b); } catch { return false; } };
const options = ['尚未核对', '无法确认，需要保留未知', '发现识别错误，需逐项说明'];
const reviewInstructions = '请人工对照本次固定 OCR 原图和识别观察，说明已核对的观察序号、区域、逐字结果及需要修正之处；未核对部分明确保留未知。';
const statementBoundary = '回答仅作为本会话的用户陈述，不证明识别准确、事件真实发生，也不授权发布；助手不得代答。';

/** Read-only handoff into the existing conversation question service. Nothing in
 * this projection answers a question, approves an action, or attests a fact. */
export async function readOcrReviewHandoff(services: ApplicationServices, materialId: string, taskId: string, questionId?: string) {
  const packet = await readOcrReviewPacket(services, materialId, taskId);
  const origin = services.modelTools.taskOrigin(taskId);
  if (!origin || origin.toolName !== 'perform_action') return fail();
  const current = services.core.getState(origin.conversationId);
  if (current.branchId !== origin.branchId || current.visibility !== 'active') return fail();
  const digest = wfdSha256(canonicalWfdJson({ schema: 'bd-ocr-human-handoff/1', taskId, source: packet.source,
    textReference: packet.textReference, evidenceReference: packet.evidenceReference,
    recognizer: packet.recognizer, coordinateUnit: packet.coordinateUnit,
    conversationId: origin.conversationId, branchId: origin.branchId, reviewInstructions, statementBoundary, options }));
  const question = `${reviewInstructions}\n材料：${materialId}\nOCR任务：${taskId}\n证据摘要：${digest}\n原图：${packet.original.url}\n核对包：/api/ui/materials/${encodeURIComponent(materialId)}/ocr-review/${encodeURIComponent(taskId)}\n${statementBoundary}`;
  const base = { schema: 'bd-ocr-human-handoff/1', digest, question, options: [...options],
    questionId: questionId ?? null, state: 'awaiting_question', response: null as null | {
      text: string; basis: 'user_statement'; deliveryState: string; commandId: string; messageId: string | null;
    }, eventEligibility: 'not_established', humanVerification: 'not_established',
    instructions: '仅通过现有 ask_user 提交原问题供用户回答；不得填写 confirmed 或把会话陈述当永久事实审计。' };
  if (questionId === undefined) return base;
  if (!/^[A-Za-z0-9_.:-]{1,200}$/u.test(questionId)) return fail();
  const db = services.database.connection;
  const row = db.prepare('SELECT * FROM agent_questions WHERE id=?').get(questionId);
  if (!row || row.conversation_id !== origin.conversationId || row.branch_id !== origin.branchId
    || row.question !== question || row.options_json !== JSON.stringify(options)) return fail();
  const call = db.prepare('SELECT * FROM model_tool_calls WHERE parent_run_id=? AND parent_generation=? AND tool_call_id=?')
    .get(row.run_id, row.generation, row.tool_call_id);
  if (!call || call.tool_name !== 'ask_user' || call.action !== 'model.question.ask' || call.state !== 'returned'
    || call.task_id !== null || call.ticket_json !== null || call.input_id !== row.input_id || call.message_id !== row.message_id
    || call.conversation_id !== row.conversation_id || call.branch_id !== row.branch_id) return fail();
  const args = parse(call.args_json), preview = parse(call.preview_json);
  if (typeof args.question !== 'string' || args.question.trim() !== question || !Array.isArray(args.options)
    || !same(args.options.map(item => typeof item === 'string' ? item.trim() : null), options)
    || !isWfdRecord(preview.question) || preview.question.id !== questionId || preview.ok !== true) return fail();
  const input = services.core.store.command(String(row.input_id)), run = services.core.store.run(String(row.run_id));
  const message = services.core.store.message(String(row.message_id));
  if (input.conversation_id !== row.conversation_id || input.branch_id !== row.branch_id || input.run_id !== row.run_id
    || input.generation !== row.generation || input.input_message_id !== row.message_id || ['cancelled', 'failed'].includes(input.state)
    || run.conversation_id !== row.conversation_id || run.branch_id !== row.branch_id || run.generation !== row.generation
    || message.role !== 'user' || message.conversation_id !== row.conversation_id || message.text !== input.text) return fail();
  // A later question must remain on the same real user-input ancestry, not just
  // carry a copied task ID in a different branch or unrelated conversation.
  let ancestor: string | null = message.id; const seen = new Set<string>();
  while (ancestor !== origin.messageId) {
    if (!ancestor || seen.has(ancestor) || seen.size >= 5000) return fail();
    seen.add(ancestor); const parent = services.core.store.message(ancestor);
    if (parent.conversation_id !== origin.conversationId) return fail();
    ancestor = parent.parent_id;
  }
  if (row.status === 'pending') return { ...base, state: 'awaiting_user' };
  if (row.status === 'dismissed') return { ...base, state: 'dismissed' };
  if (row.status !== 'answered' || typeof row.answer !== 'string' || !row.answer.trim()) return fail();
  const receipt = parse(row.receipt_json);
  const command = db.prepare('SELECT * FROM commands WHERE request_id=?').get(`question-answer-${questionId}`);
  if (!command || receipt.commandId !== command.id || command.conversation_id !== row.conversation_id
    || command.branch_id !== row.branch_id || !['send', 'queue'].includes(String(command.kind))
    || !['accepted', 'queued', 'steering', 'consumed', 'held'].includes(String(command.state))
    || command.text !== questionAnswerMessage(question, row.answer)) return fail();
  let messageId: string | null = null;
  if (command.input_message_id !== null) {
    const answer = services.core.store.message(String(command.input_message_id));
    if (answer.role !== 'user' || answer.conversation_id !== row.conversation_id || answer.text !== command.text) return fail();
    messageId = answer.id;
  } else if (!['accepted', 'queued', 'held'].includes(String(command.state))) return fail();
  // A queued response has not yet produced a user message. Preserve this actual
  // delivery state, and never turn "yes" or any answer into verification.
  return { ...base, state: 'user_statement_received', response: { text: row.answer, basis: 'user_statement' as const,
    deliveryState: String(command.state), commandId: String(command.id), messageId } };
}
