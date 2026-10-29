import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentQuestion } from '../../../../contracts/agent-question-contracts';
import { answerQuestion, dismissQuestion, getQuestions, RequestError } from '../api';
import type { Chat } from './ConversationList';
import { ErrorNote, errorDetail, useWords } from './Controls';

function QuestionCard({ question, chat, onUpdate }: { question: AgentQuestion; chat: Chat; onUpdate(value: AgentQuestion): void }) {
  const words = useWords();
  const [answer, setAnswer] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [unconfirmed, setUnconfirmed] = useState(false);
  const attempt = useRef<{ answer: string; requestId: string } | null>(null);
  async function submit() {
    if (busy || !answer.trim() || !chat.canQueue) return;
    setBusy(true); setError(null);
    const input = attempt.current ?? { answer: answer.trim(), requestId: crypto.randomUUID() };
    attempt.current = input;
    try {
      const result = await answerQuestion(question.id, input.answer, input.requestId);
      if (result.receipt.status === 'failed' || result.receipt.status === 'cancelled') throw new RequestError('回答尚未进入执行，请核对待发输入。', 200);
      setUnconfirmed(false); attempt.current = null; onUpdate(result.question);
    } catch (failure) {
      const unknown = failure instanceof RequestError && (failure.status === null || failure.status >= 500 || (failure.status >= 200 && failure.status < 300));
      setUnconfirmed(unknown); if (!unknown) attempt.current = null;
      setError(errorDetail(failure));
    } finally { setBusy(false); }
  }
  async function skip() {
    if (busy || unconfirmed || !chat.canManageQueue) return;
    setBusy(true); setError(null);
    try { onUpdate(await dismissQuestion(question.id)); }
    catch (failure) { setError(errorDetail(failure)); }
    finally { setBusy(false); }
  }
  return <form className="agent-question" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <p className="agent-question-prompt">{question.question}</p>
    {question.options.length > 0 && <div className="agent-question-options">{question.options.map((option, index) => <button type="button" className="text-button" key={index} aria-pressed={answer === option} disabled={busy || unconfirmed || !chat.canQueue} onClick={() => setAnswer(option)}>{option}</button>)}</div>}
    <label className="agent-question-answer"><span>{words('你的回答', 'Your answer')}</span><textarea rows={2} value={answer} maxLength={32_000} disabled={busy || unconfirmed || !chat.canQueue} onChange={(event) => setAnswer(event.currentTarget.value)} /></label>
    {error && <ErrorNote detail={error}>{unconfirmed ? words('回答结果待核，重试会沿用原回答。', 'The answer is unconfirmed. Retrying keeps the original answer.') : words('回答尚未完成，输入已保留。', 'The answer did not complete. Your input is preserved.')}</ErrorNote>}
    <div className="agent-question-actions"><button type="button" className="text-button" disabled={busy || unconfirmed || !chat.canManageQueue} onClick={() => void skip()}>{words('跳过', 'Skip')}</button>
      <button type="submit" className="primary-button" disabled={busy || !answer.trim() || !chat.canQueue}>{busy ? words('提交中…', 'Submitting…') : unconfirmed ? words('核对回答', 'Check answer') : words('提交回答', 'Submit answer')}</button></div>
  </form>;
}

export default function QuestionCards({ chat }: { chat: Chat }) {
  const words = useWords(), state = chat.conversation!;
  const [questions, setQuestions] = useState<AgentQuestion[]>([]), [error, setError] = useState<string | null>(null);
  const receive = useCallback((incoming: AgentQuestion[]) => setQuestions((current) => {
    const next = new Map(current.map((question) => [question.id, question]));
    for (const question of incoming) {
      const previous = next.get(question.id);
      if (!previous || previous.updatedAt < question.updatedAt || (previous.updatedAt === question.updatedAt && previous.status === 'pending' && question.status !== 'pending')) next.set(question.id, question);
    }
    return [...next.values()];
  }), []);
  useEffect(() => {
    if (chat.connection !== 'connected') return;
    let disposed = false, fetching = false;
    async function load() {
      if (fetching) return;
      fetching = true;
      try { const incoming = await getQuestions(state.conversationId, state.branchId); if (!disposed) { receive(incoming); setError(null); } }
      catch (failure) { if (!disposed) setError(errorDetail(failure)); }
      finally { fetching = false; }
    }
    void load(); const timer = window.setInterval(() => void load(), 3_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [state.conversationId, state.branchId, chat.connection, receive]);
  return <section className="agent-questions" aria-label={words('待回答问题', 'Questions awaiting answers')}>
    {questions.filter((question) => question.status === 'pending').map((question) => <QuestionCard key={question.id} question={question} chat={chat} onUpdate={(value) => receive([value])} />)}
    {error && <ErrorNote detail={error}>{words('待回答问题暂时无法更新。', 'Questions could not be updated.')}</ErrorNote>}
  </section>;
}
