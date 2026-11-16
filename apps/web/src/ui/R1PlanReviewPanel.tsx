import { useEffect, useRef, useState } from 'react';
import type { R1RequestView } from '../../../../contracts/r1-contracts';
import { r1Api } from '../r1-api';
import { localDataGeneration } from '../local-data-context';
import { prepareReviewedR1Set, prepareReviewedR1Output, r1ConfirmationKey, reviewR1Plan, submitReviewedR1Request,
  type R1PlanReview, type R1ReviewPort } from '../r1-plan-review';
import { ErrorNote, errorDetail, useWords } from './Controls';
import { PageActions, PageButton, PageEmpty, PageField, PageHeading } from './PageUI';
import { R1DuplicateResult } from './R1DuplicateResult';
import './R1PlanReviewPanel.css';

interface Ticket { requestId: string; planId: string; outputId: string; kind?: 'output' | 'set'; awaitingReceipt: boolean }
const reasonText: Record<string, [string, string]> = {
  R1_OUTPUT_NOT_READY: ['输出的处理、用途或发布目标尚未满足。', 'Processing, purpose or target is not ready.'],
  R1_MULTI_SOURCE_UNSUPPORTED: ['此入口只支持单原件输出，不会取第一份原件代替全部。', 'This path requires one original per output.'],
  R1_COLLECTION_CONFIRMATION_REQUIRED: ['此输出属于关联集合，须从下方整组准备，不能单独提交。', 'Use whole-set preparation for grouped outputs; do not split dependencies.'],
  R1_OUTPUT_INTEGRITY: ['步骤记录、依赖或产物完整性尚未确认。', 'Step records, dependencies or artifacts are incomplete.'],
  R1_SEMANTIC_UNRESOLVED: ['语义核对尚未通过。', 'Semantic checks have not passed.'],
  R1_TARGET_UNCONFIRMED: ['冻结目标或父快照无法核对。', 'The frozen target or parent snapshot cannot be verified.'],
  R1_SOURCE_EDITOR_REQUIRED: ['该计划需要原单输出编辑器补齐来源声明。', 'Use the existing single-output editor to complete its source declaration.'],
  R1_SOURCE_UNCONFIRMED: ['缺少随计划冻结的完整来源声明。', 'A complete frozen source declaration is missing.'],
};
function readTicket(key: string | null): Ticket | null {
  if (!key || typeof window === 'undefined') return null;
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const t = value as Record<string, unknown>;
    return [t.requestId, t.planId, t.outputId].every(item => typeof item === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(item))
      && (t.kind === undefined || t.kind === 'output' || t.kind === 'set') && typeof t.awaitingReceipt === 'boolean' ? t as unknown as Ticket : null;
  } catch { return null; }
}

/** Multiple outputs are visible, but every action stays one explicit existing R1 request. No bulk submit loop. */
export function R1PlanReviewPanel({ port = r1Api }: { port?: R1ReviewPort }) {
  const words = useWords(), generation = localDataGeneration();
  const storageKey = generation === null ? null : `bd:r1-plan-review:${generation}`;
  const [ticket, setTicket] = useState<Ticket | null>(() => readTicket(storageKey));
  const [planId, setPlanId] = useState(() => readTicket(storageKey)?.planId ?? '');
  const [lookupId, setLookupId] = useState(() => readTicket(storageKey)?.requestId ?? '');
  const [review, setReview] = useState<R1PlanReview | null>(null), [selectedId, setSelectedId] = useState('');
  const [selectedSetId, setSelectedSetId] = useState('');
  const [view, setView] = useState<R1RequestView | null>(null), [confirmation, setConfirmation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const epoch = useRef(0), locked = useRef(false);
  const selected = review?.outputs.find(output => output.outputId === selectedId);
  const selectedSet = review?.sets.find(set => set.setId === selectedSetId);
  useEffect(() => () => { epoch.current++; }, []);
  useEffect(() => {
    epoch.current++; locked.current = false; setBusy(false); setReview(null); setView(null); setConfirmation(null);
    const saved = readTicket(storageKey); setTicket(saved); setPlanId(saved?.planId ?? ''); setLookupId(saved?.requestId ?? '');
    setError(null); setNotice(''); setSelectedId(''); setSelectedSetId('');
  }, [storageKey]);
  function remember(next: Ticket) {
    if (storageKey && typeof window !== 'undefined') {
      // Save the request identity before prepare. Storage failure must not create an untrackable write.
      window.sessionStorage.setItem(storageKey, JSON.stringify(next));
    }
    setTicket(next); setLookupId(next.requestId);
  }
  async function act(work: (current: () => boolean) => Promise<void>) {
    if (locked.current) return;
    locked.current = true; const token = ++epoch.current;
    const current = () => token === epoch.current;
    setBusy(true); setError(null); setNotice('');
    try { await work(current); }
    catch (failure) { if (current()) setError(errorDetail(failure)); }
    finally { if (current()) { locked.current = false; setBusy(false); } }
  }
  function receive(result: R1RequestView) {
    setView(result); setConfirmation(null); setLookupId(result.requestId);
    remember({ requestId: result.requestId, planId: result.planId, outputId: result.publicationSet?.setId ?? result.outputId, kind: result.publicationSet ? 'set' : 'output', awaitingReceipt: false });
  }
  function loadPlan() {
    setConfirmation(null); setView(null); setReview(null); setSelectedId(''); setSelectedSetId('');
    void act(async current => {
      const next = reviewR1Plan(await port.plan(planId.trim()));
      if (!current()) return;
      setReview(next);
      setNotice(words('仅查询已有计划，未执行加工、准备或发布。', 'Read-only plan loaded; no processing, preparation or publication was started.'));
    });
  }
  function prepare() {
    if (!selected?.eligible) return;
    setConfirmation(null);
    void act(async current => {
      if (ticket && ticket.awaitingReceipt && (ticket.kind === 'set' || ticket.planId !== selected.planId || ticket.outputId !== selected.outputId))
        throw new Error(words('上一准备回执未知，请先按原请求编号查询；不能直接创建另一请求。', 'Look up the unconfirmed original preparation before creating another request.'));
      const requestId = ticket?.kind !== 'set' && ticket?.planId === selected.planId && ticket.outputId === selected.outputId
        ? ticket.requestId : `web-r1-review-${crypto.randomUUID()}`;
      const next = { requestId, planId: selected.planId, outputId: selected.outputId, kind: 'output' as const, awaitingReceipt: false };
      remember(next);
      const guardedPort: R1ReviewPort = { ...port, prepare: input => {
        if (!current()) throw new Error('Review context changed before preparation.');
        remember({ ...next, awaitingReceipt: true });
        return port.prepare(input);
      } };
      const result = await prepareReviewedR1Output(guardedPort, selected, requestId);
      if (!current()) return;
      receive(result);
      setNotice(words('已冻结所选输出的准备文档，尚未提交。请核对下方目标、原文摘要和连接。', 'The selected output is prepared, not submitted. Review its target, document digest and connection below.'));
    });
  }
  function prepareSet() {
    if (!selectedSet?.eligible) return;
    setConfirmation(null);
    void act(async current => {
      const outputId = selectedSet.setId;
      if (ticket?.awaitingReceipt && (ticket.kind !== 'set' || ticket.planId !== selectedSet.planId || ticket.outputId !== outputId))
        throw new Error(words('上一准备回执未知，请先查询原请求。', 'Look up the pending preparation first.'));
      const requestId = ticket?.kind === 'set' && ticket.planId === selectedSet.planId && ticket.outputId === outputId
        ? ticket.requestId : `web-r1-set-${crypto.randomUUID()}`;
      const next = { requestId, planId: selectedSet.planId, outputId, kind: 'set' as const, awaitingReceipt: false };
      remember(next);
      const guarded: R1ReviewPort = { ...port, prepareSet: input => {
        if (!current() || !port.prepareSet) throw new Error('Review context changed before set preparation.');
        remember({ ...next, awaitingReceipt: true }); return port.prepareSet(input);
      } };
      const result = await prepareReviewedR1Set(guarded, selectedSet, requestId);
      if (!current()) return;
      receive(result);
      setNotice(words('整组文档已准备，尚未发布；请逐项核对成员并确认同一文档摘要。', 'Set prepared, not published. Review every member and the single document digest.'));
    });
  }
  function lookup() {
    setConfirmation(null); setView(null);
    void act(async current => {
      const result = await port.get(lookupId.trim());
      if (!current()) return;
      receive(result);
      setNotice(words('已读取原请求；没有创建新提交，也没有清除原失败状态。', 'Original request loaded without resubmission or clearing failures.'));
    });
  }
  function submit() {
    if (!view || confirmation !== r1ConfirmationKey(view)) return;
    const visible = view;
    setConfirmation(null); // Consume before awaiting, not after the side effect.
    void act(async current => {
      const guardedPort: R1ReviewPort = { ...port, submit: input => {
        if (!current()) throw new Error('Review context changed before submission.');
        return port.submit(input);
      } };
      await submitReviewedR1Request(guardedPort, visible);
      const result = await port.get(visible.requestId);
      if (!current()) return;
      receive(result);
      setNotice(words('提交动作已交给原 R1；以下仅显示已取得的服务端状态，尚在运行时请查询原请求。', 'The existing R1 owns the submission. The status below is only what the server has returned; query the original while it is running.'));
    });
  }
  function recover() {
    if (!view?.submitTaskId || port !== r1Api) return;
    const requestId = view.requestId; setConfirmation(null);
    void act(async current => {
      await r1Api.recover(requestId, `web-r1-review-lookup-${crypto.randomUUID()}`);
      const result = await port.get(requestId);
      if (current()) receive(result);
    });
  }
  const canConfirm = view && !view.requiresRecovery && (view.submitTaskId === null || view.state === 'send_failed')
    && ['prepared_profile_pending', 'send_failed'].includes(view.state);
  return <section className="r1-plan-review" aria-label={words('多输出审阅与逐项确认', 'Multi-output review and individual confirmation')}>
    <PageHeading title={words('多输出审阅与逐项确认', 'Multi-output review and individual confirmation')}
      description={words('读取已有计划。独立输出可逐项确认；已声明集合必须整组核对并用同一文档提交，不循环拆开发布。',
        'Inspect every output. Confirm independent outputs individually, or a declared set as one document, never as a submit loop.')} />
    <PageField label={words('处理计划编号', 'Processing plan ID')}>
      <input value={planId} disabled={busy} onChange={event => { setPlanId(event.currentTarget.value); setReview(null); setView(null); setConfirmation(null); setSelectedId(''); setSelectedSetId(''); }} />
    </PageField>
    <PageActions><PageButton disabled={busy || !planId.trim()} onClick={loadPlan}>{words('读取计划与质量', 'Read plan and quality')}</PageButton></PageActions>
    {error && <ErrorNote detail={error}>{words('本次操作未确认；请保留原请求编号核对。', 'The action is unconfirmed; preserve the original request ID.')}</ErrorNote>}
    {notice && <p role="status">{notice}</p>}
    {busy && <PageEmpty state="loading">{words('正在核对原请求…', 'Checking the original request…')}</PageEmpty>}
    {!review && !busy && <PageEmpty>{words('尚未读取计划；不会自动选择第一个输出。', 'No plan loaded. The first output is never selected automatically.')}</PageEmpty>}
    {review && <fieldset className="r1-plan-review-outputs" disabled={busy}>
      <legend>{words('选择一个输出进行审阅', 'Select an output to review')}</legend>
      {review.outputs.map(output => <label className="r1-plan-review-output" key={output.outputId} data-selected={output.outputId === selectedId}>
        <input type="radio" name="r1-plan-review-output" checked={output.outputId === selectedId}
          onChange={() => { setSelectedId(output.outputId); setSelectedSetId(''); setView(null); setConfirmation(null); }} />
        <span><strong>{output.outputId}</strong><span className="r1-plan-review-meta">{output.datasetId ?? '—'} / {output.outputKey ?? '—'} · {output.state}</span>
          <span>{output.eligible ? words('可申请准备，尚未授权发布', 'May prepare; publication not granted') : words('存在阻断项，可查看原因', 'Blocked; inspect reasons')}</span>
        </span>
      </label>)}
    </fieldset>}
    {!!review?.sets.length && <fieldset className="r1-plan-review-outputs" disabled={busy}>
      <legend>{words('关联发布集合', 'Declared publication sets')}</legend>
      {review.sets.map(set => <label className="r1-plan-review-output r1-plan-review-set" key={set.setId} data-selected={selectedSetId === set.setId}>
        <input type="radio" name="r1-plan-review-output" checked={selectedSetId === set.setId}
          onChange={() => { setSelectedSetId(set.setId); setSelectedId(''); setView(null); setConfirmation(null); }} />
        <span><strong>{set.setId}</strong><span className="r1-plan-review-meta">{set.outputIds.join(' + ')}</span>
          <span>{set.eligible ? words('全部成员可准备，尚未发布', 'Every member may prepare; not published') : words('集合受阻，不能删去失败成员', 'Set blocked; failed members cannot be dropped')}</span></span>
      </label>)}
    </fieldset>}
    {selectedSet && <section aria-label={words('整组发布审阅', 'Whole-set review')}>
      <PageHeading level="h3" title={selectedSet.setId} />
      <p>{words('本次整组成员', 'Exact members')}: {selectedSet.outputIds.join(' + ')}</p>
      <p>{words('所有成员共享一个父快照和一次人工确认。成员冲突使整组失败，不逐行跳过或部分提交。', 'All members share one parent and confirmation. Member conflicts block the whole set; no row skipping or partial submission.')}</p>
      {selectedSet.reasons.map(reason => <p className="danger-text" key={reason}>{reasonText[reason] ? words(...reasonText[reason]) : reason}</p>)}
      <PageActions><PageButton variant="primary" disabled={busy || !selectedSet.eligible || !port.prepareSet} onClick={prepareSet}>
        {words('仅准备整个集合', 'Prepare the whole set only')}</PageButton></PageActions>
    </section>}
    {selected && <section aria-label={words('所选输出详情', 'Selected output details')}>
      <PageHeading level="h3" title={selected.outputId} />
      <dl className="r1-plan-review-facts"><dt>{words('目标产品', 'Target')}</dt><dd>{selected.datasetId ?? '—'} / {selected.outputKey ?? '—'}</dd>
        <dt>{words('冻结父快照', 'Frozen parent snapshot')}</dt><dd>{selected.expectedSnapshotId ?? words('明确空基线或尚未核定，见阻断项', 'Empty or unconfirmed; see blockers')}</dd>
        <dt>{words('关联输出', 'Related outputs')}</dt><dd>{selected.relatedOutputIds.join(', ') || words('未发现跨输出步骤依赖', 'No cross-output step dependencies found')}</dd></dl>
      {selected.reasons.map(reason => <p className="danger-text" key={reason}>{reasonText[reason] ? words(...reasonText[reason]) : reason}</p>)}
      <details><summary>{words('证据与质量缺口', 'Evidence and quality gaps')} ({selected.gaps.length})</summary>
        {selected.gaps.map((gap, index) => <p key={index}>{gap}</p>)}</details>
      <PageActions><PageButton variant="primary" disabled={busy || !selected.eligible} onClick={prepare}>
        {words('仅准备所选输出', 'Prepare selected output only')}</PageButton></PageActions>
    </section>}
    <section aria-label={words('按原请求恢复视图', 'Restore original request view')}>
      <PageHeading level="h3" title={words('原请求与回执', 'Original request and receipt')} />
      <PageField label={words('原 R1 请求编号', 'Original R1 request ID')} hint={words('刷新或重开只读取原请求；不保存人工确认。', 'Refresh and reopen only read the original; confirmation is never persisted.')}>
        <input value={lookupId} disabled={busy} onChange={event => { setLookupId(event.currentTarget.value); setView(null); setConfirmation(null); }} />
      </PageField>
      <PageActions><PageButton disabled={busy || !lookupId.trim()} onClick={lookup}>{words('查询原请求', 'Query original request')}</PageButton></PageActions>
    </section>
    {view && <section aria-label={words('固定准备文档与人工确认', 'Frozen document and human confirmation')}>
      <dl className="r1-plan-review-facts">
        <dt>{words('实际状态', 'Server state')}</dt><dd><code>{view.state}</code></dd>
        <dt>{words('计划 / 输出', 'Plan / output')}</dt><dd>{view.planId} / {view.outputId}</dd>
        <dt>{words('目标', 'Target')}</dt><dd>{view.datasetId} / {view.outputKey}</dd>
        <dt>{words('连接 / 模式', 'Connection / mode')}</dt><dd>{view.connection.connectionId} / {view.connection.mode}</dd>
        <dt>{words('文档摘要', 'Document digest')}</dt><dd><code>{view.documentSha256}</code></dd>
        <dt>{words('记录数', 'Row count')}</dt><dd>{view.rowCount}</dd>
      </dl>
      <details><summary>{words('准备记录样本与原始结果', 'Prepared sample and original result')}</summary>
        <pre className="database-text-preview">{JSON.stringify({ previewRows: view.previewRows, error: view.error, local: view.local }, null, 2)}</pre>
      </details>
      {view.publicationSet && <section aria-label={words('集合逐成员回执', 'Per-member set receipts')}>
        <PageHeading level="h3" title={words('集合成员与结果', 'Set members and outcomes')} />
        {view.publicationSet.members.map(member => <div key={member.outputKey} className="r1-plan-review-output">
          <span><strong>{member.outputId}</strong><span className="r1-plan-review-meta">{member.outputKey} · {member.rowCount} {words('行', 'rows')} · {member.state}</span>
            <span>{member.snapshotId ?? words('尚无已核对快照', 'No verified snapshot yet')}</span>
            {member.errorCodes.map(code => <p key={code} className="danger-text">{code}</p>)}</span>
        </div>)}
      </section>}
      <R1DuplicateResult request={view} />
      {canConfirm && <PageField label={words('人工确认本次固定文档', 'Confirm this frozen document')}>
        <input type="checkbox" checked={confirmation === r1ConfirmationKey(view)} disabled={busy}
          onChange={event => setConfirmation(event.currentTarget.checked ? r1ConfirmationKey(view) : null)} />
        <span>{view.publicationSet ? words('我已核对全部集合成员、来源、目标、父快照、连接和文档摘要；确认一次提交整个集合。', 'I reviewed every member, source, target, parent, connection and digest. Confirm one whole-set submission.') : words('我已核对所选输出、来源、目标、连接和文档摘要；此次只提交这一独立输出。', 'I reviewed this output, source, target, connection and digest. Submit only this independent output.')}</span>
      </PageField>}
      <PageActions>
        <PageButton variant="primary" disabled={busy || !canConfirm || confirmation !== r1ConfirmationKey(view)} onClick={submit}>
          {view.publicationSet ? words('确认并提交整个集合', 'Confirm and submit the whole set') : words('确认并提交此输出', 'Confirm and submit this output')}</PageButton>
        <PageButton disabled={busy || !view.submitTaskId || port !== r1Api} onClick={recover}>{words('核对原回执与固定读回', 'Reconcile original receipt and fixed readback')}</PageButton>
      </PageActions>
      <p className="r1-plan-review-meta">{words('任务返回不等于全部发布成功。部分失败、冲突和未知回执按服务端原结果保留；此界面不改写为成功。',
        'Task completion does not mean every output published. Partial failure, conflicts and unknown receipts remain as returned by the server.')}</p>
    </section>}
  </section>;
}
