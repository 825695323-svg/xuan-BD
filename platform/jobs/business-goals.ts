import { createHash, randomUUID } from 'node:crypto';
import type { BackendInput } from '../../contracts/backend.js';
import type { CoreDatabase } from '../state/database.js';
import type { JsonValue } from '../../contracts/task-contracts.js';

export type BusinessGoalEffect = 'upload' | 'ingest' | 'publish';
export interface BusinessGoalBudget {
  maxModelRequests: number;
  deadlineAt: number;
  maxRows: number;
  maxObjectBytes: number;
  maxTotalBytes: number;
}
export interface BusinessGoalContract {
  objective: string;
  contract: JsonValue;
  completionConditions: { id: string; stepKey: string; description: string }[];
}
export interface BusinessGoal extends BusinessGoalContract {
  id: string;
  conversationId: string;
  branchId: string;
  rootInputId: string;
  currentInputId: string;
  revision: number;
  state: 'active' | 'frozen' | 'completed';
  budget: BusinessGoalBudget;
  modelRequests: number;
  totalBytes: number;
  restrictions: { inputId: string; effect: BusinessGoalEffect; quote: string }[];
}
export interface BusinessStep {
  id: string;
  goalId: string;
  key: string;
  action: string;
  argsDigest: string;
  attempt: number;
  requestId: string;
  state: 'reserved' | 'submitted' | 'needs_confirmation' | 'succeeded' | 'failed' | 'unknown';
  external: Record<string, string>;
  result: JsonValue | null;
  history: { attempt: number; requestId: string; argsDigest: string; state: string; external: Record<string, string>; result: JsonValue | null }[];
}
export interface BusinessGoalOptions {
  database: CoreDatabase;
  isRunActive(runId: string, generation: number): boolean;
  now?: () => number;
  /** 仅受信宿主设置，创建后不能借新消息、引导或重启提高。 */
  budget?: Partial<BusinessGoalBudget>;
  verifyOperatorReceipt?: (receipt: { approvalId: string; actorId: string }, confirmationId: string, input: Readonly<BackendInput>) => boolean;
  verifySemanticAnswer?: (receipt: { sourceRecordId: string; questionId: string }, confirmationId: string,
    input: Readonly<BackendInput>, evidence: BusinessConfirmationEvidence) => boolean;
}
export interface BusinessStepInput {
  goalId: string;
  revision: number;
  key: string;
  action: string;
  args: JsonValue;
  effects?: BusinessGoalEffect[];
  rows?: number;
  objectBytes?: number;
  totalBytes?: number;
}
export type BusinessConfirmationEvidence = { messageId: string; quote: string; start?: number; end?: number };

export class BusinessGoalError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BusinessGoalError'; }
}

interface Command { id: string; conversation_id: string; branch_id: string; run_id: string | null; input_message_id: string | null;
  generation: number; text: string; kind: string; state: string }
interface GoalRow { id: string; conversation_id: string; branch_id: string; root_input_id: string; current_input_id: string;
  revision: number; state: BusinessGoal['state']; specification: string; budget: string; model_requests: number; total_bytes: number; restrictions: string }
interface StepRow { id: string; goal_id: string; step_key: string; action: string; args_digest: string; attempt: number;
  request_id: string; state: BusinessStep['state']; external: string; result: string | null; history: string; confirmation_revision: number | null }
interface ConfirmationRow { id: string; goal_id: string; step_id: string; request_input_id: string; created_revision: number; state: string }

const SCHEMA = `
CREATE TABLE business_goals (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), branch_id TEXT NOT NULL REFERENCES branches(id),
 root_input_id TEXT NOT NULL UNIQUE REFERENCES commands(id), current_input_id TEXT NOT NULL REFERENCES commands(id),
 revision INTEGER NOT NULL, state TEXT NOT NULL, specification TEXT NOT NULL, budget TEXT NOT NULL,
 model_requests INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0, restrictions TEXT NOT NULL DEFAULT '[]',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX business_goals_branch ON business_goals(conversation_id,branch_id,created_at);
CREATE TABLE business_goal_inputs (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, input_id TEXT NOT NULL UNIQUE REFERENCES commands(id),
 conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL, digest TEXT NOT NULL,
 goal_id TEXT REFERENCES business_goals(id), accepted_at INTEGER NOT NULL
);
CREATE TABLE business_goal_requests (
 run_id TEXT NOT NULL, generation INTEGER NOT NULL, request_index INTEGER NOT NULL, input_id TEXT NOT NULL REFERENCES commands(id),
 goal_id TEXT REFERENCES business_goals(id), accepted_at INTEGER NOT NULL,
 PRIMARY KEY(run_id,generation,request_index)
);
CREATE TABLE business_goal_steps (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES business_goals(id), step_key TEXT NOT NULL,
 action TEXT NOT NULL, args_digest TEXT NOT NULL, attempt INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL, external TEXT NOT NULL DEFAULT '{}', result TEXT, history TEXT NOT NULL DEFAULT '[]',
 confirmation_revision INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(goal_id,step_key)
);
CREATE TABLE business_goal_confirmations (
 id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES business_goals(id), step_id TEXT NOT NULL REFERENCES business_goal_steps(id),
 request_input_id TEXT NOT NULL REFERENCES commands(id), created_revision INTEGER NOT NULL, prompt TEXT NOT NULL,
 state TEXT NOT NULL, reply_input_id TEXT REFERENCES commands(id), evidence TEXT, created_at INTEGER NOT NULL, confirmed_at INTEGER
);
`;
const EFFECTS: BusinessGoalEffect[] = ['upload', 'ingest', 'publish'];
const MAX_OBJECT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_OBJECT_BYTES;

/** 只保存目标与派发门；仍由原 Pi 会话推理、原任务服务执行。 */
export class BusinessGoalService {
  private readonly now: () => number;
  constructor(private readonly options: BusinessGoalOptions) {
    this.now = options.now ?? Date.now;
    options.database.migrate('business_goals', 1, SCHEMA);
    options.database.migrate('business_goal_resumptions', 1, `CREATE TABLE business_goal_resumptions (
      goal_id TEXT NOT NULL REFERENCES business_goals(id), input_id TEXT NOT NULL REFERENCES commands(id),
      revision INTEGER NOT NULL, evidence TEXT NOT NULL, resumed_at INTEGER NOT NULL, PRIMARY KEY(goal_id,input_id));`);
  }
  private get db() { return this.options.database.connection; }

  /** 核心在真实命令落库后同步调用；inTransaction 避免与原接收事务嵌套。 */
  observeAcceptedInput(commandId: string, options: { inTransaction?: boolean } = {}): void {
    const observe = () => {
      const command = this.command(commandId);
      if (command.kind === 'compact') return;
      if (!['accepted', 'queued', 'held', 'steering', 'consumed'].includes(command.state)) fail('GOAL_INPUT_NOT_ACCEPTED', '目标修订必须来自核心实际接收的输入。');
      const digest = hash({ conversationId: command.conversation_id, branchId: command.branch_id, text: command.text, kind: command.kind });
      const previous = this.db.prepare('SELECT digest FROM business_goal_inputs WHERE input_id=?').get(command.id);
      if (previous) {
        if (previous.digest !== digest) {
          // 原核心明确继续未消费的 steer 时将其改为 queue；用户正文和消息意图仍是同一条。
          const heldSteer = command.kind === 'queue' && previous.digest === hash({ conversationId: command.conversation_id,
            branchId: command.branch_id, text: command.text, kind: 'steer' });
          if (!heldSteer) fail('GOAL_INPUT_CHANGED', '同一核心输入身份的正文发生变化。');
          this.db.prepare('UPDATE business_goal_inputs SET digest=? WHERE input_id=?').run(digest, command.id);
        }
        return;
      }
      this.db.prepare('INSERT INTO business_goal_inputs(input_id,conversation_id,branch_id,digest,accepted_at) VALUES(?,?,?,?,?)')
        .run(command.id, command.conversation_id, command.branch_id, digest, this.now());
      for (const row of this.db.prepare("SELECT * FROM business_goals WHERE conversation_id=? AND branch_id=? AND state<>'completed'")
        .all(command.conversation_id, command.branch_id) as unknown as GoalRow[]) {
        const restrictions = reviseRestrictions(parse<BusinessGoal['restrictions']>(row.restrictions), command);
        this.db.prepare("UPDATE business_goals SET current_input_id=?,revision=revision+1,state='frozen',restrictions=?,updated_at=? WHERE id=?")
          .run(command.id, JSON.stringify(restrictions), this.now(), row.id);
      }
    };
    if (options.inTransaction) observe(); else this.options.database.transaction(observe);
  }

  /** 每个真实新意图单独建目标；查询、继续和重试不能制造新预算。 */
  ensureGoal(input: Readonly<BackendInput>, specification: BusinessGoalContract, budget?: Partial<BusinessGoalBudget>): BusinessGoal {
    this.validateInput(input, true);
    validateSpecification(specification);
    this.observeAcceptedInput(input.inputId);
    const goalId = this.options.database.transaction(() => {
      const attached = this.db.prepare('SELECT goal_id FROM business_goal_inputs WHERE input_id=?').get(input.inputId);
      if (attached?.goal_id) return String(attached.goal_id);
      const command = this.command(input.inputId);
      const old = this.db.prepare("SELECT * FROM business_goals WHERE conversation_id=? AND branch_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1")
        .get(input.conversationId, input.branchId) as unknown as GoalRow | undefined;
      const pending = explicitNewIntent(command) ? null : this.pendingGoal(input);
      if (pending || isContinuationOrQuery(command) || (old && revisionDirective(command))) {
        if (pending) {
          this.bindInput(pending.id, input.inputId); this.backfillRequests(pending.id, input.inputId); return pending.id;
        }
        if (!old || old.state === 'completed') fail('GOAL_CONTINUATION_NOT_FOUND', '此输入是查询、继续或重试，不能建立新的业务预算；请按原目标核对。');
        this.bindInput(old.id, input.inputId);
        this.backfillRequests(old.id, input.inputId);
        return old.id;
      }
      const id = randomUUID(), now = this.now();
      const frozenBudget = validateBudget({ maxModelRequests: 8, deadlineAt: now + 15 * 60_000, maxRows: 512,
        maxObjectBytes: MAX_OBJECT_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, ...this.options.budget, ...budget }, now);
      this.db.prepare(`INSERT INTO business_goals(id,conversation_id,branch_id,root_input_id,current_input_id,revision,state,specification,budget,restrictions,created_at,updated_at)
        VALUES(?,?,?,?,?,1,'active',?,?,?,?,?)`).run(id, input.conversationId, input.branchId, input.inputId, input.inputId,
        JSON.stringify(specification), JSON.stringify(frozenBudget), JSON.stringify(denials(command)), now, now);
      this.bindInput(id, input.inputId);
      this.backfillRequests(id, input.inputId);
      return id;
    });
    const goal = this.get(goalId);
    if (budget && Object.entries(budget).some(([key, value]) => goal.budget[key as keyof BusinessGoalBudget] !== value)) {
      fail('GOAL_BUDGET_FROZEN', '已有目标预算已固定，不能借续接或引导增加。');
    }
    this.assertBudget(goal);
    return goal;
  }

  get(goalId: string): BusinessGoal {
    const row = this.row(goalId);
    return { ...parse<BusinessGoalContract>(row.specification), id: row.id, conversationId: row.conversation_id, branchId: row.branch_id,
      rootInputId: row.root_input_id, currentInputId: row.current_input_id, revision: Number(row.revision), state: row.state,
      budget: parse<BusinessGoalBudget>(row.budget), modelRequests: Number(row.model_requests), totalBytes: Number(row.total_bytes),
      restrictions: parse<BusinessGoal['restrictions']>(row.restrictions) };
  }
  forInput(input: Readonly<BackendInput>): BusinessGoal | null {
    this.validateInput(input, false);
    if (this.command(input.inputId).kind === 'compact') {
      const goal = this.db.prepare("SELECT id FROM business_goals WHERE conversation_id=? AND branch_id=? AND state<>'completed' ORDER BY created_at DESC,rowid DESC LIMIT 1")
        .get(input.conversationId, input.branchId);
      return goal ? this.get(String(goal.id)) : null;
    }
    const row = this.db.prepare('SELECT goal_id FROM business_goal_inputs WHERE input_id=?').get(input.inputId);
    return row?.goal_id ? this.get(String(row.goal_id)) : null;
  }

  /** 只接受核心实际收到的明确续接；查询及待确认不会自动激活，合同与预算不变。 */
  resumeAcceptedInput(input: Readonly<BackendInput>): BusinessGoal | null {
    this.validateInput(input, true);
    const goal = this.forInput(input);
    if (!goal || goal.state !== 'frozen' || !explicitContinuation(this.command(input.inputId))) return goal;
    return this.options.database.transaction(() => {
      const current = this.assertCurrent(input, goal.id, goal.revision);
      if (this.db.prepare("SELECT 1 FROM business_goal_confirmations WHERE goal_id=? AND state='pending'").get(goal.id)) return current;
      const evidence = this.messageEvidence(input, { messageId: input.messageId, quote: input.text, start: 0, end: input.text.length });
      this.db.prepare('INSERT INTO business_goal_resumptions VALUES(?,?,?,?,?)')
        .run(goal.id, input.inputId, goal.revision, JSON.stringify(evidence), this.now());
      this.db.prepare("UPDATE business_goals SET state='active',updated_at=? WHERE id=? AND revision=? AND current_input_id=?")
        .run(this.now(), goal.id, goal.revision, input.inputId);
      return this.get(goal.id);
    });
  }

  /** 可在现有 model_requests 接受账本之前调用；创建前接受的请求会在 ensureGoal 回填。 */
  reserveModelRequest(input: Readonly<BackendInput>, requestIndex: number, options: { inTransaction?: boolean } = {}): void {
    this.validateInput(input, false);
    integer(requestIndex, 1, 100, 'GOAL_REQUEST_INVALID');
    const reserve = () => {
      if (this.db.prepare('SELECT 1 FROM business_goal_requests WHERE run_id=? AND generation=? AND request_index=?')
        .get(input.runId, input.generation, requestIndex)) fail('GOAL_REQUEST_REPLAY', '同一模型请求不得重复接受。');
      let goal = this.forInput(input);
      // 同一运行里的旧输入仍属于原目标，冻结外部写并不丢失模型累计计数。
      const command = this.command(input.inputId);
      if (!goal && !explicitNewIntent(command)) {
        const row = this.db.prepare(`SELECT i.goal_id FROM business_goal_inputs i JOIN commands c ON c.id=i.input_id
          WHERE c.run_id=? AND i.goal_id IS NOT NULL ORDER BY i.sequence DESC LIMIT 1`).get(input.runId);
        if (row?.goal_id) goal = this.get(String(row.goal_id));
      }
      const pending = goal || explicitNewIntent(command) ? null : this.pendingGoal(input);
      if (!goal && (pending || isContinuationOrQuery(command) || revisionDirective(command))) {
        const row = pending ?? this.db.prepare("SELECT id FROM business_goals WHERE conversation_id=? AND branch_id=? AND state<>'completed' ORDER BY created_at DESC,rowid DESC LIMIT 1")
          .get(input.conversationId, input.branchId);
        if (row) {
          goal = this.get(String(row.id)); this.bindInput(goal.id, input.inputId); this.backfillRequests(goal.id, input.inputId);
          goal = this.get(goal.id);
        }
      }
      if (goal) { this.assertBudget(goal); if (goal.modelRequests >= goal.budget.maxModelRequests) fail('GOAL_REQUEST_BUDGET_EXCEEDED', '业务目标已用完固定的模型请求预算。'); }
      this.db.prepare('INSERT INTO business_goal_requests VALUES(?,?,?,?,?,?)')
        .run(input.runId, input.generation, requestIndex, input.inputId, goal?.id ?? null, this.now());
      if (goal) this.db.prepare('UPDATE business_goals SET model_requests=model_requests+1,updated_at=? WHERE id=?').run(this.now(), goal.id);
    };
    if (options.inTransaction) reserve(); else this.options.database.transaction(reserve);
  }

  /** 旧接线已写 model_requests 时使用此回填；不会重复扣减，也不会重置余额。 */
  backfillAcceptedRequests(goalId: string, inputId: string): BusinessGoal {
    this.options.database.transaction(() => {
      const goal = this.get(goalId), command = this.command(inputId);
      if (goal.conversationId !== command.conversation_id || goal.branchId !== command.branch_id) fail('GOAL_SCOPE_MISMATCH', '模型请求不能跨会话或分支归入目标。');
      this.backfillRequests(goalId, inputId);
    });
    const goal = this.get(goalId); this.assertBudget(goal); return goal;
  }

  assertCurrent(input: Readonly<BackendInput>, goalId: string, revision: number, effects: readonly BusinessGoalEffect[] = []): BusinessGoal {
    this.validateInput(input, true);
    const goal = this.get(goalId);
    if (goal.conversationId !== input.conversationId || goal.branchId !== input.branchId || goal.currentInputId !== input.inputId
      || goal.revision !== revision) fail('GOAL_REVISION_CONFLICT', '真实用户输入或目标修订已经变化，派发前需核对当前目标。');
    if (goal.state === 'completed') fail('GOAL_COMPLETED', '此业务目标已经完成，不能追加动作。');
    if (effects.some(effect => !EFFECTS.includes(effect))) fail('GOAL_EFFECT_INVALID', '业务动作的外部影响类型无效。');
    if (effects.length && goal.state !== 'active') fail('GOAL_WRITES_FROZEN', '收到新用户输入后，相关外部写入已冻结，须核对待确认项。');
    const restriction = goal.restrictions.find(item => effects.includes(item.effect));
    if (restriction) fail('GOAL_USER_RESTRICTION', `用户限制尚未解除：${restriction.quote}`);
    this.assertBudget(goal);
    return goal;
  }

  /** 新 tool_call_id 只拿到旧步骤；未知或在途结果不自动重派。 */
  reserveStep(input: Readonly<BackendInput>, request: BusinessStepInput): { step: BusinessStep; shouldDispatch: boolean } {
    return this.options.database.transaction(() => {
      const goal = this.assertCurrent(input, request.goalId, request.revision, request.effects ?? []);
      textField(request.key, 160); textField(request.action, 160);
      const argsDigest = hash(request.args);
      const existing = this.db.prepare('SELECT * FROM business_goal_steps WHERE goal_id=? AND step_key=?').get(goal.id, request.key) as unknown as StepRow | undefined;
      if (existing) {
        if (existing.action !== request.action) fail('GOAL_STEP_CONFLICT', '稳定步骤不能换成另一项动作。');
        if (existing.state !== 'needs_confirmation' || existing.confirmation_revision !== goal.revision) {
          if (existing.args_digest !== argsDigest) fail('GOAL_STEP_CONFLICT', '同一稳定步骤参数发生变化，不能用新调用编号覆盖。');
          return { step: this.getStep(existing.id), shouldDispatch: false };
        }
      }
      const encodedArgsBytes = Buffer.byteLength(JSON.stringify(request.args));
      const rows = request.rows ?? 0, objectBytes = request.objectBytes ?? encodedArgsBytes, totalBytes = request.totalBytes ?? objectBytes;
      integer(rows, 0, goal.budget.maxRows, 'GOAL_ROW_BUDGET_EXCEEDED');
      integer(objectBytes, encodedArgsBytes, goal.budget.maxObjectBytes, 'GOAL_OBJECT_BUDGET_EXCEEDED');
      integer(totalBytes, objectBytes, goal.budget.maxTotalBytes - goal.totalBytes, 'GOAL_BYTE_BUDGET_EXCEEDED');
      const id = existing?.id ?? randomUUID(), attempt = existing ? existing.attempt + 1 : 1, requestId = `business-step:${id}:${attempt}`;
      if (attempt > 8 || (!existing && Number(this.db.prepare('SELECT count(*) AS count FROM business_goal_steps WHERE goal_id=?').get(goal.id)!.count) >= 32)) {
        fail('GOAL_STEP_BUDGET_EXCEEDED', '此目标已达到固定步骤或确认尝试上限。');
      }
      if (existing) {
        const history = parse<BusinessStep['history']>(existing.history);
        history.push({ attempt: existing.attempt, requestId: existing.request_id, argsDigest: existing.args_digest,
          state: existing.state, external: parse(existing.external), result: existing.result === null ? null : parse(existing.result) });
        this.db.prepare(`UPDATE business_goal_steps SET args_digest=?,attempt=?,request_id=?,state='reserved',external='{}',result=NULL,
          history=?,confirmation_revision=NULL,updated_at=? WHERE id=?`).run(argsDigest, attempt, requestId, JSON.stringify(history), this.now(), id);
      } else this.db.prepare(`INSERT INTO business_goal_steps(id,goal_id,step_key,action,args_digest,attempt,request_id,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'reserved',?,?)`).run(id, goal.id, request.key, request.action, argsDigest, attempt, requestId, this.now(), this.now());
      this.db.prepare('UPDATE business_goals SET total_bytes=total_bytes+?,updated_at=? WHERE id=?').run(totalBytes, this.now(), goal.id);
      return { step: this.getStep(id), shouldDispatch: true };
    });
  }

  getStep(stepId: string): BusinessStep {
    const row = this.stepRow(stepId);
    return { id: row.id, goalId: row.goal_id, key: row.step_key, action: row.action, argsDigest: row.args_digest, attempt: row.attempt,
      requestId: row.request_id, state: row.state, external: parse(row.external), result: row.result === null ? null : parse(row.result), history: parse(row.history) };
  }

  /** 受信执行层保存实际任务/提交/快照身份；即使用户已经修订也必须保留迟到事实。 */
  recordStepExternal(stepId: string, requestId: string, external: Record<string, string>): BusinessStep {
    return this.options.database.transaction(() => {
      const step = this.stepRow(stepId); this.assertAttempt(step, requestId);
      const saved = parse<Record<string, string>>(step.external);
      for (const [key, value] of Object.entries(external)) {
        textField(key, 100); textField(value, 500);
        if (saved[key] && saved[key] !== value) fail('GOAL_EXTERNAL_ID_CONFLICT', '同一步骤尝试的外部身份不一致，不能覆盖原身份。');
        saved[key] = value;
      }
      this.db.prepare("UPDATE business_goal_steps SET external=?,state=CASE WHEN state='reserved' THEN 'submitted' ELSE state END,updated_at=? WHERE id=?")
        .run(JSON.stringify(saved), this.now(), stepId);
      return this.getStep(stepId);
    });
  }
  finishStep(stepId: string, requestId: string, state: 'succeeded' | 'failed' | 'unknown', result: JsonValue): BusinessStep {
    return this.options.database.transaction(() => {
      const step = this.stepRow(stepId); this.assertAttempt(step, requestId);
      if (Buffer.byteLength(JSON.stringify(result)) > this.get(step.goal_id).budget.maxObjectBytes) fail('GOAL_OBJECT_BUDGET_EXCEEDED', '步骤证据超过固定单对象上限。');
      if (step.state === 'succeeded' && (state !== 'succeeded' || JSON.stringify(result) !== step.result)) fail('GOAL_RESULT_CONFLICT', '已确认成功的步骤不能由迟到结果覆盖。');
      this.db.prepare('UPDATE business_goal_steps SET state=?,result=?,updated_at=? WHERE id=?').run(state, JSON.stringify(result), this.now(), stepId);
      return this.getStep(stepId);
    });
  }

  requestConfirmation(input: Readonly<BackendInput>, goalId: string, revision: number, stepId: string, prompt: string): { id: string; goal: BusinessGoal } {
    return this.options.database.transaction(() => {
      const goal = this.assertCurrent(input, goalId, revision), step = this.stepRow(stepId);
      if (step.goal_id !== goalId || ['unknown', 'succeeded'].includes(step.state)) fail('GOAL_CONFIRMATION_INVALID', '未知外部结果须按原身份核对，不能用普通确认重放。');
      textField(prompt, 2000);
      const prior = this.db.prepare("SELECT id FROM business_goal_confirmations WHERE step_id=? AND state='pending'").get(stepId);
      if (prior) return { id: String(prior.id), goal };
      const id = randomUUID();
      this.db.prepare("INSERT INTO business_goal_confirmations(id,goal_id,step_id,request_input_id,created_revision,prompt,state,created_at) VALUES(?,?,?,?,?,?,'pending',?)")
        .run(id, goalId, stepId, input.inputId, revision, prompt, this.now());
      this.db.prepare("UPDATE business_goal_steps SET state='needs_confirmation',updated_at=? WHERE id=?").run(this.now(), stepId);
      this.db.prepare("UPDATE business_goals SET state='frozen',updated_at=? WHERE id=?").run(this.now(), goalId);
      return { id, goal: this.get(goalId) };
    });
  }

  /** 只能引用核心当前真实用户消息；原文肯定句不等于解除以前的禁止项。 */
  confirmWithUserMessage(input: Readonly<BackendInput>, confirmationId: string, evidence: BusinessConfirmationEvidence): BusinessGoal {
    this.validateInput(input, true);
    const command = this.command(input.inputId);
    const verified = this.messageEvidence(input, evidence);
    if (!affirmative(command.text)) fail('GOAL_CONFIRMATION_REQUIRED', '此回复没有明确确认或继续待确认任务，相关外部写入继续冻结。');
    return this.acceptConfirmation(input, confirmationId, { kind: 'user-message', ...verified });
  }

  /** 语义回答由已有受控语义模块核证后续接，不能以模型提案中的 confirmed 字段代替。 */
  confirmSemanticAnswer(input: Readonly<BackendInput>, confirmationId: string, evidence: BusinessConfirmationEvidence,
    receipt: { sourceRecordId: string; questionId: string }): BusinessGoal {
    this.validateInput(input, true);
    const verified = this.messageEvidence(input, evidence);
    textField(receipt.sourceRecordId, 200); textField(receipt.questionId, 200);
    if (this.options.verifySemanticAnswer?.(receipt, confirmationId, input, verified) !== true) {
      fail('GOAL_SEMANTIC_RECEIPT_INVALID', '语义回答须由真实语义记录核证问题、原句及当前用户消息身份。');
    }
    return this.acceptConfirmation(input, confirmationId, { kind: 'verified-semantic-answer', ...verified, ...receipt });
  }

  private messageEvidence(input: Readonly<BackendInput>, evidence: BusinessConfirmationEvidence): BusinessConfirmationEvidence & { start: number; end: number } {
    const command = this.command(input.inputId);
    if (evidence.messageId !== input.messageId) fail('GOAL_CONFIRMATION_EVIDENCE', '确认依据必须是本次核心实际收到的用户消息。');
    const quote = evidence.quote;
    const start = evidence.start ?? command.text.indexOf(quote), end = evidence.end ?? start + quote.length;
    if (!quote || start < 0 || end <= start || command.text.slice(start, end) !== quote
      || (evidence.start === undefined && command.text.indexOf(quote, start + 1) !== -1)) fail('GOAL_CONFIRMATION_EVIDENCE', '确认原句或位置与真实消息不符。');
    const message = this.db.prepare("SELECT role,text,conversation_id FROM messages WHERE id=?").get(input.messageId);
    if (!message || message.role !== 'user' || message.text !== command.text || message.conversation_id !== input.conversationId) {
      fail('GOAL_CONFIRMATION_EVIDENCE', '确认依据尚未成为核心正式保存的真实用户消息。');
    }
    return { ...evidence, start, end };
  }

  /** 只供本机已认证人工确认处理器调用，绝不直接暴露为模型工具或浏览器布尔字段。 */
  confirmByOperator(input: Readonly<BackendInput>, confirmationId: string, operatorReceipt: { approvalId: string; actorId: string }): BusinessGoal {
    textField(operatorReceipt.approvalId, 200); textField(operatorReceipt.actorId, 200);
    if (this.options.verifyOperatorReceipt?.(operatorReceipt, confirmationId, input) !== true) fail('GOAL_OPERATOR_RECEIPT_INVALID', '人工确认须由本机已认证处理器核验真实审批回执。');
    return this.acceptConfirmation(input, confirmationId, { kind: 'local-operator', ...operatorReceipt }, true);
  }

  complete(input: Readonly<BackendInput>, goalId: string, revision: number): BusinessGoal {
    return this.options.database.transaction(() => {
      const goal = this.assertCurrent(input, goalId, revision);
      if (goal.state !== 'active') fail('GOAL_CONFIRMATION_REQUIRED', '目标被真实新输入冻结后，须核对当前修订才能确认整项目标完成。');
      for (const condition of goal.completionConditions) {
        const step = this.db.prepare("SELECT state,result FROM business_goal_steps WHERE goal_id=? AND step_key=?").get(goalId, condition.stepKey);
        if (!step || step.state !== 'succeeded' || step.result === null) fail('GOAL_COMPLETION_UNVERIFIED', '完成条件尚无受信执行层保存的成功步骤与证据。');
      }
      this.db.prepare("UPDATE business_goals SET state='completed',updated_at=? WHERE id=?").run(this.now(), goalId);
      return this.get(goalId);
    });
  }

  private acceptConfirmation(input: Readonly<BackendInput>, confirmationId: string, evidence: JsonValue, operator = false): BusinessGoal {
    this.validateInput(input, true);
    return this.options.database.transaction(() => {
      const confirmation = this.db.prepare('SELECT * FROM business_goal_confirmations WHERE id=?').get(confirmationId) as unknown as ConfirmationRow | undefined;
      if (!confirmation || confirmation.state !== 'pending') fail('GOAL_CONFIRMATION_INVALID', '没有相应的持久待确认记录。');
      const goal = this.get(confirmation.goal_id);
      if (goal.conversationId !== input.conversationId || goal.branchId !== input.branchId || goal.currentInputId !== input.inputId
        || (!operator && (confirmation.request_input_id === input.inputId || goal.revision <= confirmation.created_revision))) fail('GOAL_CONFIRMATION_INVALID', '确认必须来自同分支中新收到的对应用户输入。');
      this.assertBudget(goal);
      const attached = this.db.prepare('SELECT goal_id FROM business_goal_inputs WHERE input_id=?').get(input.inputId);
      if (attached?.goal_id && attached.goal_id !== goal.id) fail('GOAL_INTENT_CONFLICT', '此真实输入已属于另一项独立意图。');
      this.bindInput(goal.id, input.inputId); this.backfillRequests(goal.id, input.inputId);
      this.db.prepare("UPDATE business_goal_confirmations SET state='confirmed',reply_input_id=?,evidence=?,confirmed_at=? WHERE id=?")
        .run(input.inputId, JSON.stringify(evidence), this.now(), confirmationId);
      this.db.prepare('UPDATE business_goal_steps SET confirmation_revision=? WHERE id=?').run(goal.revision, confirmation.step_id);
      this.db.prepare("UPDATE business_goals SET state='active',updated_at=? WHERE id=?").run(this.now(), goal.id);
      const updated = this.get(goal.id); this.assertBudget(updated); return updated;
    });
  }

  private validateInput(input: Readonly<BackendInput>, latest: boolean): void {
    const command = this.command(input.inputId);
    const run = this.db.prepare('SELECT conversation_id,branch_id,generation,state,kind,command_id FROM runs WHERE id=?').get(input.runId);
    const conversation = this.db.prepare('SELECT selected_branch_id,generation FROM conversations WHERE id=?').get(input.conversationId);
    const compact = command.kind === 'compact';
    const branch = compact ? this.db.prepare('SELECT head_message_id FROM branches WHERE id=? AND conversation_id=?').get(input.branchId, input.conversationId) : undefined;
    const head = compact ? this.db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(input.messageId) : undefined;
    const messageIdentityValid = compact ? run?.kind === 'compaction' && run.command_id === command.id
      && command.input_message_id === null && branch?.head_message_id === input.messageId && head?.conversation_id === input.conversationId
      : run?.kind === 'chat' && command.input_message_id === input.messageId;
    if (!this.options.isRunActive(input.runId, input.generation) || !run || !conversation
      || run.conversation_id !== input.conversationId || run.branch_id !== input.branchId || Number(run.generation) !== input.generation
      || !['starting', 'running'].includes(String(run.state)) || conversation.selected_branch_id !== input.branchId || Number(conversation.generation) !== input.generation
      || command.conversation_id !== input.conversationId || command.branch_id !== input.branchId || command.run_id !== input.runId
      || Number(command.generation) !== input.generation || !messageIdentityValid || command.text !== input.text
      || !['accepted', 'steering', 'consumed'].includes(command.state)) fail('GOAL_STALE_INPUT', '业务请求不属于当前核心持有的真实输入、分支和运行代次。');
    if (compact && latest) fail('GOAL_COMPACTION_NOT_INTENT', '原生上下文整理只沿用已有目标预算，不能建立业务意图或派发业务步骤。');
    if (latest) {
      const newest = this.db.prepare('SELECT input_id FROM business_goal_inputs WHERE conversation_id=? AND branch_id=? ORDER BY sequence DESC LIMIT 1')
        .get(input.conversationId, input.branchId);
      if (newest && newest.input_id !== input.inputId) fail('GOAL_REVISION_CONFLICT', '已经收到更新的真实用户输入，旧输入不能派发业务步骤。');
    }
  }
  private bindInput(goalId: string, inputId: string): void {
    this.db.prepare('UPDATE business_goal_inputs SET goal_id=? WHERE input_id=? AND (goal_id IS NULL OR goal_id=?)').run(goalId, inputId, goalId);
  }
  private pendingGoal(input: Readonly<BackendInput>): { id: string } | null {
    const rows = this.db.prepare(`SELECT DISTINCT g.id FROM business_goals g JOIN business_goal_confirmations c ON c.goal_id=g.id
      WHERE g.conversation_id=? AND g.branch_id=? AND g.state<>'completed' AND c.state='pending' LIMIT 2`)
      .all(input.conversationId, input.branchId);
    if (rows.length > 1) fail('GOAL_CONFIRMATION_AMBIGUOUS', '同分支有多个待确认目标，请按明确目标身份继续，不能建立新预算。');
    return rows.length ? { id: String(rows[0]!.id) } : null;
  }
  private backfillRequests(goalId: string, inputId: string): void {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_requests'").get();
    if (exists) for (const request of this.db.prepare("SELECT parent_run_id,parent_generation,request_index,accepted_at FROM model_requests WHERE input_id=? AND state='accepted'").all(inputId)) {
      this.db.prepare('INSERT OR IGNORE INTO business_goal_requests VALUES(?,?,?,?,?,?)')
        .run(String(request.parent_run_id), Number(request.parent_generation), Number(request.request_index), inputId, goalId, Number(request.accepted_at));
    }
    const conflict = this.db.prepare('SELECT 1 FROM business_goal_requests WHERE input_id=? AND goal_id IS NOT NULL AND goal_id<>?').get(inputId, goalId);
    if (conflict) fail('GOAL_INTENT_CONFLICT', '同一真实输入的模型请求不能在目标之间重复归属。');
    this.db.prepare('UPDATE business_goal_requests SET goal_id=? WHERE input_id=? AND goal_id IS NULL').run(goalId, inputId);
    const count = this.db.prepare('SELECT count(*) AS count FROM business_goal_requests WHERE goal_id=?').get(goalId)!;
    this.db.prepare('UPDATE business_goals SET model_requests=?,updated_at=? WHERE id=?').run(Number(count.count), this.now(), goalId);
  }
  private assertBudget(goal: BusinessGoal): void {
    if (this.now() >= goal.budget.deadlineAt) fail('GOAL_DEADLINE_EXCEEDED', '业务目标的固定截止时间已到，不能继续派发。');
    if (goal.modelRequests > goal.budget.maxModelRequests) fail('GOAL_REQUEST_BUDGET_EXCEEDED', '业务目标已超过固定的累计模型请求预算。');
    if (goal.totalBytes > goal.budget.maxTotalBytes) fail('GOAL_BYTE_BUDGET_EXCEEDED', '业务目标已超过固定总字节上限。');
  }
  private command(id: string): Command {
    const row = this.db.prepare('SELECT * FROM commands WHERE id=?').get(id) as unknown as Command | undefined;
    if (!row) fail('GOAL_INPUT_NOT_FOUND', '核心没有接收这条真实输入。'); return row;
  }
  private row(id: string): GoalRow {
    const row = this.db.prepare('SELECT * FROM business_goals WHERE id=?').get(id) as unknown as GoalRow | undefined;
    if (!row) fail('GOAL_NOT_FOUND', '业务目标不存在。'); return row;
  }
  private stepRow(id: string): StepRow {
    const row = this.db.prepare('SELECT * FROM business_goal_steps WHERE id=?').get(id) as unknown as StepRow | undefined;
    if (!row) fail('GOAL_STEP_NOT_FOUND', '业务步骤不存在。'); return row;
  }
  private assertAttempt(step: StepRow, requestId: string): void {
    if (step.request_id !== requestId) fail('GOAL_STALE_ATTEMPT', '迟到回执不属于此稳定步骤的当前尝试。');
  }
}

function parse<T>(value: string): T { return JSON.parse(value) as T; }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function fail(code: string, message: string): never { throw new BusinessGoalError(code, message); }
function integer(value: number, min: number, max: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code, '业务请求超过固定范围或数值无效。');
}
function textField(value: string, max: number): void {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail('GOAL_VALUE_INVALID', '业务目标文本或身份无效。');
}
function validateSpecification(value: BusinessGoalContract): void {
  textField(value.objective, 4000);
  if (!Array.isArray(value.completionConditions) || value.completionConditions.length < 1 || value.completionConditions.length > 16) fail('GOAL_VALUE_INVALID', '业务目标需要有界且可核对的完成条件。');
  const ids = new Set<string>();
  for (const item of value.completionConditions) {
    textField(item.id, 160); textField(item.stepKey, 160); textField(item.description, 1000);
    if (ids.has(item.id)) fail('GOAL_VALUE_INVALID', '完成条件身份不能重复。'); ids.add(item.id);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 32_000) fail('GOAL_VALUE_INVALID', '业务目标合同超过保存上限。');
}
function validateBudget(value: BusinessGoalBudget, now: number): BusinessGoalBudget {
  integer(value.maxModelRequests, 1, 8, 'GOAL_BUDGET_INVALID'); integer(value.deadlineAt, now + 1, Number.MAX_SAFE_INTEGER, 'GOAL_BUDGET_INVALID');
  integer(value.maxRows, 1, 512, 'GOAL_BUDGET_INVALID'); integer(value.maxObjectBytes, 1, MAX_OBJECT_BYTES, 'GOAL_BUDGET_INVALID');
  integer(value.maxTotalBytes, value.maxObjectBytes, MAX_TOTAL_BYTES, 'GOAL_BUDGET_INVALID'); return { ...value };
}
function denials(command: Command): BusinessGoal['restrictions'] {
  const result: BusinessGoal['restrictions'] = [];
  const negative = /(?:不|禁止|别|do\s+not|don't|no\s+)/i;
  for (const quote of command.text.split(/[，,。！？.!?\n；;]/)) {
    if (!negative.test(quote)) continue;
    for (const [effect, expression] of [['upload', /上传|外传|分享|upload|share/i], ['ingest', /入库|提交.*数据库|写.*数据库|ingest|database\s+write/i],
      ['publish', /发布|publish|保存.*(?:结果|计算|均线|吞没|指标)|(?:结果|计算|均线|吞没|指标).*保存/i]] as const) if (expression.test(quote)) result.push({ inputId: command.id, effect, quote: quote.trim() });
  }
  return result;
}
function isContinuationOrQuery(command: Command): boolean {
  return command.kind === 'retry' || (command.kind === 'steer' && !explicitNewIntent(command))
    || /(?:继续|恢复|重试)(?:刚才|之前|上次|这个|原来|同一|该)/.test(command.text)
    || /^(?:请\s*)?(?:重试|再试|重新执行|继续(?:刚才|之前|上次|这个|处理|执行|任务|吧|\s|[。！!]|$)|确认|同意|允许|可以|好[的吧]?|是(?:的|[。！!]|$)|对(?:的|[。！!]|$)|状态|进度|结果|查看|查询|现在.*(?:状态|进度)|怎么样|resume\b|continue\b|status\b)/i.test(command.text.trim());
}
function affirmative(text: string): boolean {
  return /^(?:请\s*)?(?:确认|同意|允许|继续|可以|好的|好吧|是的|对的|yes\b|confirm\b|continue\b)/i.test(text.trim())
    && !/^(?:请\s*)?(?:不要|别|不|取消|no\b)/i.test(text.trim());
}
function reviseRestrictions(previous: BusinessGoal['restrictions'], command: Command): BusinessGoal['restrictions'] {
  const result = [...previous];
  for (const [effect, expression] of [['upload', /(?:允许|可以|同意|确认)(?:现在|本次)?(?:上传|分享|外传)/],
    ['ingest', /(?:允许|可以|同意|确认)(?:现在|本次)?(?:入库|提交到数据库|写入数据库)/],
    ['publish', /(?:允许|可以|同意|确认)(?:现在|本次)?(?:发布|保存.*(?:结果|计算|均线|吞没|指标)|(?:结果|计算|均线|吞没|指标).*保存)/]] as const) {
    if (affirmative(command.text) && expression.test(command.text) && !denials(command).some(item => item.effect === effect)) {
      for (let index = result.length - 1; index >= 0; index--) if (result[index]!.effect === effect) result.splice(index, 1);
    }
  }
  const current = new Map(result.map(item => [item.effect, item]));
  for (const denial of denials(command)) current.set(denial.effect, denial);
  return [...current.values()];
}
function explicitNewIntent(command: Command): boolean {
  return /(?:新(?:的)?(?:独立)?任务|另一(?:个任务|份)|另外一份|独立任务|单独处理另一)/.test(command.text);
}
function revisionDirective(command: Command): boolean {
  return !explicitNewIntent(command) && (/^(?:请|帮我|麻烦)?(?:改用|改成|改为|调整刚才|修改刚才)/.test(command.text.trim())
    || (denials(command).length > 0 && !/(?:处理|加工|分析|计算|附件|数据)/.test(command.text)));
}

function explicitContinuation(command: Command): boolean {
  if (explicitNewIntent(command) || command.kind === 'compact') return false;
  const clauses = command.text.split(/[，,。！？!?\n；;]/u).map(value => value.trim()).filter(Boolean);
  if (!/^(?:请\s*)?(?:继续|恢复)(?:(?:刚才|之前|上次|原来|原|这个|该)(?:的)?(?:任务|计算|处理|执行)?|任务|处理|执行|吧)?$|^(?:resume|continue)$/iu.test(clauses[0] ?? '')) return false;
  return clauses.slice(1).every(text => denials({ ...command, text }).length > 0);
}
