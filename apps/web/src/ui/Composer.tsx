import { useCanvasContainer } from './canvas';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowUp, Check, ChevronDown, ChevronRight, ChevronUp, CornerDownRight, FileText, Pencil, Plus, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { DropdownMenu, Popover } from 'radix-ui';
import type { ConversationAttachmentRef, PendingInput, ThinkingLevel } from '../../../../contracts/contracts';
import { RequestError } from '../api';
import { hasNativeFileBridge, resolveNativeFilePaths } from '../platform-api';
import { AttachmentUploadError, attachmentSlotCount, draftRefsForDisplay } from '../useConversation';
import type { Chat } from './ConversationList';
import { ControlTooltip, ErrorNote, IconButton, errorDetail, thinkingLabel, useWords } from './Controls';
import { usePreferences } from './Preferences';

type AttachmentTarget = ReturnType<Chat['captureAttachmentTarget']>;
export type PendingAttachmentView = {
  id: string;
  file: File;
  state: 'resolving' | 'waiting' | 'receiving' | 'linking' | 'failed';
  error?: string;
  unconfirmed?: boolean;
  acceptedRef?: ConversationAttachmentRef;
  /** 桥解析失败时没有值；null 表示明确没有本机路径。 */
  path?: string | null;
};
type Upload = PendingAttachmentView & { target: AttachmentTarget };
type AttachmentScope = Pick<AttachmentTarget, 'conversationId' | 'branchId'>;
const sameScope = (a: AttachmentScope, b: AttachmentScope | null) => !!b && a.conversationId === b.conversationId && a.branchId === b.branchId;

export function hasDirectoryDrop(event: { dataTransfer: DataTransfer }) {
  return [...event.dataTransfer.items].some((item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory === true);
}

function pendingStatus(item: PendingAttachmentView, words: (zh: string, en: string) => string): string {
  if (item.state === 'resolving') return words('正在读取原文件路径 · 尚未发送', 'Resolving local path · Not sent');
  if (item.state === 'waiting') return words('等待接入 · 尚未发送', 'Waiting to add · Not sent');
  if (item.state === 'receiving') return words('正在加入草稿 · 尚未发送', 'Adding to draft · Not sent');
  if (item.state === 'linking') return words('正在保存草稿关联 · 尚未发送', 'Saving draft link · Not sent');
  if (item.state === 'failed' && item.path === undefined) return words('未能取得原文件路径 · 尚未发送', 'Could not resolve local path · Not sent');
  if (item.acceptedRef) return words('原件已接入 · 草稿关联待核 · 尚未发送', 'Source added · Draft link unconfirmed · Not sent');
  if (item.unconfirmed) return words('接收结果待核 · 尚未发送', 'Receipt unconfirmed · Not sent');
  return words('接收失败 · 尚未发送', 'Could not receive file · Not sent');
}

export function AttachmentList({ refs, pending = [], onRemove, onRemovePending, onRetryPending, onRetryDraftLink, disabled, draft = false }: {
  refs: readonly ConversationAttachmentRef[];
  pending?: readonly PendingAttachmentView[];
  onRemove?(id: string): void;
  onRemovePending?(id: string): void;
  onRetryPending?(id: string): void;
  onRetryDraftLink?(id: string): void;
  disabled?: boolean;
  draft?: boolean;
}) {
  const words = useWords();
  if (!refs.length && !pending.length) return null;
  return <ul className="attachment-list" aria-label={draft ? words('草稿附件', 'Draft attachments') : words('消息附件', 'Message attachments')}>
    {refs.map((ref) => <li className="attachment-item" key={`${ref.fileRefId}:${ref.version}`}><FileText size={17} aria-hidden="true" /><div className="attachment-copy"><span title={ref.displayName}>{ref.displayName ?? words('原件引用', 'Source reference')}</span>
      <small>{draft ? words('已加入草稿 · 尚未发送', 'Added to draft · Not sent') : words('任务输入引用', 'Task input reference')}</small></div>
      {onRemove && <IconButton label={`${words('移除附件', 'Remove attachment')} · ${ref.displayName ?? ref.fileRefId}`} disabled={disabled} onClick={() => onRemove(ref.fileRefId)}><X size={14} /></IconButton>}
    </li>)}
    {pending.map((item) => <li className="attachment-item" data-failed={item.state === 'failed'} key={item.id}>
      <FileText size={17} aria-hidden="true" /><div className="attachment-copy"><span title={item.file.name}>{item.file.name}</span>
        <small>{pendingStatus(item, words)}</small>
        {item.error && <details><summary>{words('查看原因', 'View reason')}</summary><p>{item.error}</p></details>}</div>
      {item.state === 'failed' && !item.unconfirmed && !item.acceptedRef && onRetryPending && <IconButton label={item.path === undefined ? words('重试读取原文件路径', 'Retry reading local path') : words('重试接收', 'Retry receiving')} onClick={() => onRetryPending(item.id)}><RefreshCw size={14} /></IconButton>}
      {item.state === 'failed' && item.acceptedRef && onRetryDraftLink && <IconButton label={words('重试保存草稿关联', 'Retry saving draft link')} onClick={() => onRetryDraftLink(item.id)}><RefreshCw size={14} /></IconButton>}
      {item.state !== 'receiving' && item.state !== 'linking' && onRemovePending && <IconButton label={`${words('移除此待接收项', 'Remove pending file')} · ${item.file.name}`} onClick={() => onRemovePending(item.id)}><X size={14} /></IconButton>}
    </li>)}
  </ul>;
}

function ModelSelector({ chat }: { chat: Chat }) {
  const words = useWords();
  const { preferences, updatePreferences, saving, loading, ready, error } = usePreferences();
  const [open, setOpen] = useState(false), [section, setSection] = useState<'overview' | 'models' | 'levels'>('overview'), [notice, setNotice] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const canvas = useCanvasContainer();
  const configured = ready && (chat.health?.configured || chat.health?.backend === 'demo');
  const modelName = (id: string) => chat.health?.model === id ? (chat.health.displayName ?? id) : id;
  const name = configured && preferences.modelId ? modelName(preferences.modelId) : words('未配置', 'Not configured');
  const configuredModelId = configured ? chat.health?.model ?? null : null;
  const supported = chat.conversation?.thinking?.supportedLevels ?? [];
  const level = thinkingLabel(preferences.thinkingLevel);
  useEffect(() => { if (!open) return; const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('[data-menu-item]:not(:disabled)')?.focus()); return () => cancelAnimationFrame(frame); }, [section, open]);
  async function choose(patch: { modelId?: string; thinkingLevel?: ThinkingLevel }) {
    setNotice(null);
    try { await updatePreferences(patch); setSection('overview'); setNotice(words('已保存，将用于下一轮。', 'Saved. Applies to the next run.')); }
    catch (failure) { setNotice(words('偏好未保存，仍使用原值。', 'Preferences were not saved. The previous values remain active.')); }
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-menu-item]:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault(); const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  }
  return <Popover.Root open={open} onOpenChange={(value) => { setOpen(value); if (value) { setSection('overview'); setNotice(null); } }}>
    <ControlTooltip label={`${name} · ${level}`}><Popover.Trigger asChild><button type="button" className="model-trigger" disabled={!ready || loading || saving} aria-label={`${words('模型与推理等级', 'Model and reasoning level')} · ${name} ${level}`}>
      <span className="model-trigger-name">{name}</span><span className="model-trigger-level">{level}</span><ChevronDown size={14} aria-hidden="true" />
    </button></Popover.Trigger></ControlTooltip>
    <Popover.Portal container={canvas ?? undefined}><Popover.Content ref={panel} className="model-popover" side="top" align="end" sideOffset={12} collisionPadding={12} collisionBoundary={canvas ?? undefined} onKeyDown={menuKeys}
      onOpenAutoFocus={(event) => { event.preventDefault(); requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('[data-menu-item]')?.focus()); }}>
      {section === 'overview' ? <div className="model-overview">
        <button type="button" className="model-overview-row" data-menu-item onClick={() => setSection('models')}><span>{words('模型', 'Model')}</span><span className="model-row-value">{name}</span><ChevronRight size={16} /></button>
        <button type="button" className="model-overview-row" data-menu-item onClick={() => setSection('levels')}><span>{words('推理等级', 'Reasoning level')}</span><span className="model-row-value">{level}</span><ChevronRight size={16} /></button>
      </div> : <div className="model-selection"><div className="model-selection-heading"><IconButton label={words('返回', 'Back')} data-menu-item onClick={() => setSection('overview')}><ArrowLeft size={17} /></IconButton><span>{section === 'models' ? words('模型', 'Model') : words('推理等级', 'Reasoning level')}</span></div>
        {section === 'models' ? configuredModelId ? <button type="button" className="model-option" data-menu-item aria-pressed={configuredModelId === preferences.modelId} disabled={saving || loading} onClick={() => void choose({ modelId: configuredModelId })}><span>{modelName(configuredModelId)}</span>{configuredModelId === preferences.modelId && <Check size={16} />}</button>
          : <p className="popover-empty">{words('当前没有已配置模型。', 'No model is configured.')}</p>
          : (['off', 'low', 'high', 'max'] as ThinkingLevel[]).map((value) => <button type="button" className="model-option" data-menu-item key={value} aria-pressed={preferences.thinkingLevel === value} disabled={saving || loading || !supported.includes(value)} onClick={() => void choose({ thinkingLevel: value })}>
            <span>{thinkingLabel(value)}</span>{preferences.thinkingLevel === value && <Check size={16} />}
          </button>)}
      </div>}
      {(notice || error) && <p className="model-notice" role="status">{notice ?? words('偏好暂时无法保存，请核对设置。', 'Preferences could not be saved. Check settings.')}</p>}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

function ContextIndicator({ chat }: { chat: Chat }) {
  const words = useWords();
  const canvas = useCanvasContainer();
  const state = chat.conversation, context = state?.contextUsage;
  const latest = state?.messages.findLast((message) => message.role === 'assistant' && message.usage);
  const usage = latest?.usage;
  const unchangedCompaction = state?.lastRun?.kind === 'compaction' && state.lastRun.state === 'succeeded' && state.lastRun.compaction?.changed === false;
  const comparable = !!usage && !!context && (latest?.runId === state?.lastRun?.id || unchangedCompaction)
    && usage.modelId === context.modelId && usage.provider === context.provider;
  const tokens = comparable ? usage!.inputTokens + usage!.outputTokens : context?.totalUpperBound;
  const percent = tokens !== undefined && context?.contextWindow ? Math.round(tokens / context.contextWindow * 1000) / 10 : null;
  const label = percent === null ? words('上下文用量', 'Context usage') : words(`上下文已用 ${percent}%`, `${percent}% of context used`);
  const k = (value: number) => `${Math.round(value / 1000)}k`;
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const show = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(true), 120); };
  const hide = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(false), 80); };
  return <Popover.Root open={open} onOpenChange={setOpen}><Popover.Trigger asChild>
    <button type="button" className="context-trigger" aria-label={label} onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide} onClick={(event) => event.preventDefault()}>
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="3" opacity=".28" />
        {percent !== null && <circle className={percent >= 80 ? 'context-arc is-high' : percent >= 50 ? 'context-arc is-mid' : 'context-arc'} cx="10" cy="10" r="7.2" fill="none" strokeWidth="3" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - Math.max(6, Math.min(100, percent))} transform="rotate(-90 10 10)" />}</svg>
    </button>
  </Popover.Trigger><Popover.Portal container={canvas ?? undefined}><Popover.Content className="ui-menu context-popover" side="top" align="center" sideOffset={8} collisionPadding={12} collisionBoundary={canvas ?? undefined} onPointerEnter={show} onPointerLeave={hide} onOpenAutoFocus={(event) => event.preventDefault()}>
    {percent === null
      ? <p className="context-line subtle">{words('暂无估算', 'No estimate')}</p>
      : <p className="context-line">{`${percent}% / ${context ? k(context.contextWindow) : '—'}`}</p>}
  </Popover.Content></Popover.Portal></Popover.Root>;
}

function QueueEntry({ input, chat, dispatchBlocked }: { input: PendingInput; chat: Chat; dispatchBlocked: boolean }) {
  const words = useWords();
  const [edit, setEdit] = useState<{ text: string; expectedText: string } | null>(null);
  const removable = (input.state === 'queued' || input.state === 'held') && !(chat.isRunning && input.kind === 'steer' && input.state === 'held');
  const editable = removable && input.kind !== 'steer';
  async function save() {
    if (!edit?.text.trim() || !editable || !chat.canManageQueue) return;
    try { await chat.editQueuedInput(input.id, edit.text, edit.expectedText); setEdit(null); }
    catch { /* Keep the local edit until its result can be confirmed. */ }
  }
  return <div className="queue-entry"><span className="queue-mode">{input.state === 'steering' ? words('引导中', 'Guiding') : input.state === 'held' ? words('已暂停', 'Paused') : input.kind === 'steer' ? words('引导', 'Guide') : words('排队', 'Queued')}</span><span className="queue-text" title={input.text}>{input.text}</span>
    <div className="queue-actions"><button type="button" className="queue-guide text-button" disabled={!editable || !chat.canSteerQueued || dispatchBlocked || !!edit} onClick={() => void chat.steerQueuedInput(input.id).catch(() => {})}><CornerDownRight size={15} aria-hidden="true" />{words('引导', 'Guide')}</button>
      <IconButton label={words('修改此条输入', 'Edit this input')} disabled={!chat.canManageQueue || !editable || !!edit} onClick={() => setEdit({ text: input.text, expectedText: input.text })}><Pencil size={14} /></IconButton>
      <IconButton label={words('删除此条输入', 'Delete this input')} disabled={!chat.canManageQueue || !removable} onClick={() => void chat.queueAction(input.id)}><Trash2 size={14} /></IconButton>
    </div>
    {edit && <div className="queue-editor"><textarea aria-label={words('修改排队消息', 'Edit queued message')} autoFocus rows={2} maxLength={32_000} value={edit.text} disabled={!editable || chat.actionPending} onChange={(event) => setEdit({ ...edit, text: event.currentTarget.value })} onKeyDown={(event) => { if (event.key === 'Escape' && !chat.actionPending) { event.preventDefault(); setEdit(null); } }} />
      {!editable && <p role="status">{words('这条输入已提交处理，无法继续修改。', 'This input has been submitted for processing and cannot be edited.')}</p>}
      <div className="queue-edit-actions"><button type="button" className="text-button" disabled={chat.actionPending} onClick={() => setEdit(null)}>{words('取消', 'Cancel')}</button><button type="button" className="text-button" disabled={!chat.canManageQueue || !editable || !edit.text.trim()} onClick={() => void save()}>{words('保存', 'Save')}</button></div>
    </div>}
  </div>;
}

function ConversationQueue({ chat, dispatchBlocked }: { chat: Chat; dispatchBlocked: boolean }) {
  const words = useWords(), state = chat.conversation;
  const inputs = state?.queue.filter((input) => ['queued', 'held', 'steering'].includes(input.state)) ?? [];
  if (!inputs.length) return null;
  return <section className="conversation-queue" aria-label={words('待发输入', 'Pending inputs')}>
    <div className="queue-heading"><span>{words(`待发输入 ${inputs.length} 条`, `${inputs.length} pending inputs`)}{state?.queuePaused ? words(' · 已暂停', ' · Paused') : ''}</span>
      {state?.queuePaused && <button type="button" className="text-button" disabled={!chat.canManageQueue || dispatchBlocked || chat.stopPending || state.status === 'STOPPING'} onClick={() => void chat.queueAction()}>{words('继续待发', 'Resume queue')}</button>}</div>
    <div className="queue-inputs">{inputs.map((input) => <QueueEntry key={input.id} input={input} chat={chat} dispatchBlocked={dispatchBlocked} />)}</div>
  </section>;
}

/** 跨页面/重启找回的原请求；只显示待核或明确未受理项，受理结果回原任务或队列。 */
function SendRecovery({ chat }: { chat: Chat }) {
  const words = useWords();
  const requests = chat.sendRequests.filter((request) => request.state === 'frozen' || request.state === 'rejected' || request.state === 'unknown');
  if (!requests.length) return null;
  const stateLabel = (state: string) => state === 'frozen' ? words('尚未受理', 'Not accepted')
    : state === 'rejected' ? words('明确未受理', 'Definitely not accepted') : words('受理事实待核', 'Acceptance unverified');
  const modeLabel = (mode: string) => mode === 'queue' ? words('排队', 'Queue') : mode === 'steer' ? words('引导', 'Guide')
    : mode === 'interrupt' ? words('打断后发送', 'Interrupt and send') : words('发送', 'Send');
  return <section className="send-recovery" aria-label={words('原发送请求', 'Original send requests')}>
    {requests.map((request) => {
      const otherBranch = request.branchId !== chat.conversation?.branchId;
      const canContinue = !otherBranch && (request.state === 'frozen' || request.state === 'rejected');
      return <div className="send-recovery-row" key={request.requestId}>
        <div className="send-recovery-copy">
          <strong>{stateLabel(request.state)}</strong>
          <span>{modeLabel(request.mode)} · {request.text.length > 80 ? `${request.text.slice(0, 80)}…` : request.text}</span>
          <small>{otherBranch ? words('原请求属于其他分支，请先回到原分支再核对。', 'The original request belongs to another branch. Return to it first.')
            : request.error ?? words('原请求编号已保留；不会自动发送草稿。', 'The original request ID is preserved. Drafts are never sent automatically.')}</small>
        </div>
        <div className="send-recovery-actions">
          <button type="button" className="text-button" disabled={chat.actionPending} onClick={() => void chat.checkSendRequest(request.requestId).catch(() => {})}>{words('查询原请求', 'Check request')}</button>
          {canContinue && <button type="button" className="text-button" disabled={chat.actionPending} onClick={() => void chat.retrySendRequest(request.requestId).catch(() => {})}>{words('按原请求继续', 'Continue request')}</button>}
          {request.state !== 'unknown' && !otherBranch && <button type="button" className="text-button" disabled={chat.actionPending} onClick={() => void chat.abandonSendRequest(request.requestId).catch(() => {})}>{words('放弃', 'Abandon')}</button>}
        </div>
      </div>;
    })}
  </section>;
}

export default function Composer({ chat, dispatchBlocked, controlUnconfirmed = false, hidden = false }: { chat: Chat; dispatchBlocked: boolean; controlUnconfirmed?: boolean; hidden?: boolean }) {
  const words = useWords();
  const { sendShortcut, loading: preferencesLoading, ready: preferencesReady, saving: preferencesSaving } = usePreferences();
  const [uploads, setUploads] = useState<Upload[]>([]), [dragging, setDragging] = useState(false), [sendError, setSendError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'input' | 'send'>('input');
  const fileInput = useRef<HTMLInputElement>(null), textInput = useRef<HTMLTextAreaElement>(null), fileTarget = useRef<AttachmentTarget | null>(null), dragDepth = useRef(0), receiving = useRef(false), attachmentBusy = useRef(new Set<string>()), submitLocks = useRef(new Set<string>()), composition = useRef(false);
  const chatRef = useRef(chat); chatRef.current = chat;
  const uploadsRef = useRef(uploads); uploadsRef.current = uploads;
  const activeTarget = chat.conversation ? { conversationId: chat.conversation.conversationId, branchId: chat.conversation.branchId } : null;
  const activeScope = activeTarget ? `${activeTarget.conversationId}:${activeTarget.branchId}` : null;
  const scopeRef = useRef(activeScope); scopeRef.current = activeScope;
  const currentUploads = uploads.filter((upload) => sameScope(upload.target, activeTarget));
  const visibleDraftRefs = draftRefsForDisplay(chat.draft?.attachmentRefs ?? [], currentUploads);
  const writable = !!chat.draft && !chat.readOnly && !chat.managementPending && !chat.storageFrozen;
  const modeAvailable = chat.unconfirmedSend ? chat.canRetrySend : chat.isRunning ? chat.canQueue : chat.canSend;
  const sendReady = writable && modeAvailable && !chat.attachmentPending && !currentUploads.length && !dispatchBlocked && !controlUnconfirmed && preferencesReady && !preferencesLoading && !preferencesSaving;
  const pendingCommand = useRef<string | null>(null);
  const slashQuery = (chat.draft?.text ?? '').match(/^\/(\S*)$/)?.[1]?.toLowerCase() ?? null;
  const slashCommands = [
    { id: 'compact', label: '/compact', aliases: ['compact', '压缩', '压缩上下文'], hint: words('压缩上下文', 'Compact context'), enabled: chat.canCompact,
      run: () => { chat.setDraftText(''); void chat.compact().catch(() => {}); } },
    { id: 'new-source', label: '/new-source', aliases: ['new-source', 'newsource', '采集源', '建卡', '新建采集源'], hint: words('新建采集源卡片', 'New source card'), enabled: true,
      run: () => {
        const text = words(
          '我要新建一个采集源卡片。先问我是哪个站点，不要猜；确认后再按建卡技能去搜索官网地址、logo、登录页和需要的 Cookie 名与固定操作，然后建卡。',
          'I want to add a source card. Ask me which site first instead of guessing; after I confirm, follow the card skill to look up the homepage, logo, login page, cookie names and operations, then create the card.');
        pendingCommand.current = text;
        chat.setDraftText(text);
      } },
  ];
  const slash = slashQuery === null ? null
    : slashCommands.filter((command) => command.aliases.some((alias) => alias.startsWith(slashQuery)));
  const sendLabel = chat.unconfirmedSend ? words('核对发送', 'Check send') : chat.isRunning ? words('排队发送', 'Queue message') : words('发送', 'Send');
  const hasInput = !!chat.draft?.text.trim() || !!chat.draft?.attachmentRefs.length || !!currentUploads.length;
  const showStop = chat.isRunning && !hasInput && !chat.unconfirmedSend;
  const stopLabel = chat.stopPending || chat.conversation?.status === 'STOPPING' ? words('正在停止', 'Stopping') : words('停止本轮', 'Stop current run');
  const primaryLabel = showStop ? stopLabel : sendLabel;
  const canvas = useCanvasContainer();
  const hasPendingFiles = uploads.length > 0;

  useEffect(() => {
    if (!hasPendingFiles) return;
    const protect = (event: BeforeUnloadEvent) => {
      if (!uploadsRef.current.length) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [hasPendingFiles]);

  /**
   * 加号与拖放共用此入口：先固定目标，再按同一批实际 File 对象向本机桥取路径。
   * 没有桥时直接上传；桥存在但解析失败时留在失败态，不静默改成上传。
   */
  const enqueue = useCallback((files: File[], target: AttachmentTarget) => {
    if (!files.length) return;
    const active = chatRef.current.conversation;
    const targetRefs = active && active.conversationId === target.conversationId && active.branchId === target.branchId
      ? chatRef.current.draft?.attachmentRefs ?? [] : [];
    const queued = uploadsRef.current.filter((upload) => sameScope(upload.target, target));
    if (attachmentSlotCount(targetRefs, queued) + files.length > 32) throw new Error('每份草稿最多附加 32 个原件，请分次提交。');
    setSendError(null);
    const native = hasNativeFileBridge();
    const items: Upload[] = files.map((file) => ({ id: crypto.randomUUID(), file, target,
      state: native ? 'resolving' : 'waiting', path: native ? undefined : null }));
    setUploads((current) => [...current, ...items]);
    if (!native) return;
    void resolveNativeFilePaths(files).then((paths) => {
      const byId = new Map(items.map((item, index) => [item.id, paths ? paths[index] ?? null : null]));
      setUploads((current) => current.map((item) => {
        const path = byId.get(item.id);
        return path === undefined || item.state !== 'resolving' ? item : { ...item, state: 'waiting', path };
      }));
    }).catch((failure: unknown) => {
      const ids = new Set(items.map((item) => item.id));
      setUploads((current) => current.map((item) => ids.has(item.id) && item.state === 'resolving'
        ? { ...item, state: 'failed', path: undefined, error: errorDetail(failure), unconfirmed: false } : item));
    });
  }, []);
  useEffect(() => {
    if (receiving.current) return;
    const next = uploads.find((upload) => upload.state === 'waiting' && upload.path !== undefined);
    if (!next) return;
    receiving.current = true;
    attachmentBusy.current.add(next.id);
    setUploads((current) => current.map((item) => item.id === next.id ? { ...item, state: 'receiving' } : item));
    void chatRef.current.receiveAttachments([{ file: next.file, path: next.path ?? null }], next.target).then(() => {
      setUploads((current) => current.filter((item) => item.id !== next.id));
    }).catch((failure: unknown) => {
      const unconfirmed = failure instanceof AttachmentUploadError ? failure.failures.some((item) => item.unconfirmed) : failure instanceof RequestError && (failure.status === null || failure.status >= 500);
      const acceptedRef = failure instanceof AttachmentUploadError ? failure.failures[0]?.accepted : undefined;
      setUploads((current) => current.map((item) => item.id === next.id ? { ...item, state: 'failed', error: errorDetail(failure), unconfirmed, acceptedRef } : item));
    }).finally(() => { receiving.current = false; attachmentBusy.current.delete(next.id); setUploads((current) => [...current]); });
  }, [uploads]);
  useEffect(() => {
    if (!chat.draft || chat.draft.dirty || chat.draft.saving || chat.draft.error || chat.draft.conflict) return;
    const known = new Set(chat.draft.attachmentRefs.map((ref) => ref.fileRefId));
    if (uploads.some((upload) => sameScope(upload.target, activeTarget) && upload.acceptedRef && known.has(upload.acceptedRef.fileRefId)))
      setUploads((current) => current.filter((upload) => !sameScope(upload.target, activeTarget) || !upload.acceptedRef || !known.has(upload.acceptedRef.fileRefId)));
  }, [chat.draft, chat.selectedId, chat.conversation?.branchId, uploads]);
  useEffect(() => { const input = textInput.current; if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 188)}px`; } }, [chat.draft?.text, chat.selectedId]);
  useEffect(() => { setSendError(null); }, [chat.selectedId, chat.conversation?.branchId, chat.isRunning]);

  useEffect(() => {
    const text = pendingCommand.current;
    if (!text || chat.draft?.text !== text) return;
    pendingCommand.current = null;
    void submit();
  }, [chat.draft?.text]);

  async function submit(mode: 'queue' | 'interrupt' = 'queue') {
    const scope = activeScope;
    if (!scope || submitLocks.current.has(scope) || !sendReady || (mode === 'interrupt' && (!chat.canInterrupt || chat.unconfirmedSend)) || uploadsRef.current.some((upload) => sameScope(upload.target, activeTarget))) return;
    if (!chat.draft?.text.trim()) { if (chat.draft?.attachmentRefs.length) { setErrorKind('input'); setSendError(words('请补一句希望如何处理这些文件，再发送。', 'Add a short instruction for these files before sending.')); } return; }
    submitLocks.current.add(scope); setSendError(null);
    try { await chat.send(chat.isRunning ? mode : undefined); }
    catch (failure) { if (scopeRef.current === scope) { setErrorKind('send'); setSendError(errorDetail(failure)); } }
    finally { submitLocks.current.delete(scope); }
  }
  function addFiles() {
    try { fileTarget.current = chat.captureAttachmentTarget(); fileInput.current?.click(); }
    catch (failure) { setErrorKind('input'); setSendError(errorDetail(failure)); }
  }
  function retryResolve(id: string) {
    const item = uploadsRef.current.find((upload) => upload.id === id);
    if (!item || item.state !== 'failed' || item.path !== undefined) return;
    setUploads((current) => current.map((upload) => upload.id === id ? { ...upload, state: 'resolving', error: undefined } : upload));
    void resolveNativeFilePaths([item.file]).then((paths) => {
      const path = paths ? paths[0] ?? null : null;
      setUploads((current) => current.map((upload) => upload.id === id && upload.state === 'resolving' ? { ...upload, state: 'waiting', path } : upload));
    }).catch((failure: unknown) => {
      setUploads((current) => current.map((upload) => upload.id === id && upload.state === 'resolving'
        ? { ...upload, state: 'failed', error: errorDetail(failure), unconfirmed: false } : upload));
    });
  }
  function retryPending(id: string) {
    const item = uploadsRef.current.find((upload) => upload.id === id);
    if (!item || item.unconfirmed || item.acceptedRef) return;
    if (item.path === undefined) { retryResolve(id); return; }
    setUploads((current) => current.map((upload) => upload.id === id
      ? { ...upload, state: 'waiting', error: undefined, acceptedRef: undefined } : upload));
  }
  async function retryDraftLink(id: string) {
    const item = uploadsRef.current.find((upload) => upload.id === id);
    if (!item?.acceptedRef || attachmentBusy.current.has(id)) return;
    attachmentBusy.current.add(id);
    setUploads((current) => current.map((upload) => upload.id === id ? { ...upload, state: 'linking', error: undefined } : upload));
    try {
      await chatRef.current.retryAttachmentBinding(item.acceptedRef, item.target);
      setUploads((current) => current.filter((upload) => upload.id !== id));
    } catch (failure) {
      setUploads((current) => current.map((upload) => upload.id === id ? { ...upload, state: 'failed', error: errorDetail(failure) } : upload));
    } finally { attachmentBusy.current.delete(id); }
  }
  function removePending(id: string) {
    const item = uploadsRef.current.find((upload) => upload.id === id);
    if (!item || attachmentBusy.current.has(id) || item.state === 'receiving' || item.state === 'linking') return;
    if (item.acceptedRef && !chatRef.current.removeDraftAttachment(item.acceptedRef.fileRefId, item.target)) {
      setErrorKind('input');
      setSendError(words('草稿暂时无法移除该附件，请稍后重试。', 'The draft attachment could not be removed right now. Try again shortly.'));
      return;
    }
    setUploads((current) => current.filter((upload) => upload.id !== id));
  }
  function isFileDrag(event: { dataTransfer: DataTransfer }) { return event.dataTransfer.types.includes('Files'); }
  function isUrlDrag(event: { dataTransfer: DataTransfer }) { return event.dataTransfer.types.includes('text/uri-list') || /^https?:\/\//i.test(event.dataTransfer.getData('text/plain').trim()); }
  return <div className="composer-zone" hidden={hidden}>
    <ConversationQueue chat={chat} dispatchBlocked={dispatchBlocked || controlUnconfirmed} />
    <SendRecovery chat={chat} />
    {!!slash?.length && <div className="slash-menu" role="listbox">
      {slash.map((command) => <button type="button" className="slash-item" key={command.id} disabled={!command.enabled} onClick={command.run}>
        <code>{command.label}</code><span>{command.hint}</span>
      </button>)}
    </div>}
    <form className="composer" data-dragging={dragging} data-running={chat.isRunning} aria-label={words('会话输入', 'Conversation composer')} onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onDragEnter={(event) => { if (!isFileDrag(event)) return; event.preventDefault(); dragDepth.current++; setDragging(true); }}
      onDragLeave={(event) => { if (!isFileDrag(event)) return; event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDragOver={(event) => { if (isUrlDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; return; } if (!isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = writable ? 'copy' : 'none'; }}
      onDrop={(event) => { if (isUrlDrag(event) && !isFileDrag(event)) { event.preventDefault(); setErrorKind('input'); setSendError(words('网址不会自动下载。请在消息中说明需要访问的范围。', 'URLs are not downloaded on drop. Describe the intended access in your message.')); return; } if (!isFileDrag(event)) return; event.preventDefault(); dragDepth.current = 0; setDragging(false);
        if (hasDirectoryDrop(event)) { setErrorKind('input'); setSendError(words('文件夹不能加入会话，请拖入文件。', 'Folders cannot be added. Drop files instead.')); return; }
        try { if (!writable) throw new Error(words('当前草稿暂时无法接收文件。', 'This draft cannot receive files right now.')); enqueue([...event.dataTransfer.files], chat.captureAttachmentTarget()); }
        catch (failure) { setErrorKind('input'); setSendError(errorDetail(failure)); }
      }}>
      {dragging && <div className="drop-target" aria-hidden="true">{words('松开以加入草稿', 'Drop to add to draft')}</div>}
      <AttachmentList refs={visibleDraftRefs} pending={currentUploads} onRemove={chat.removeDraftAttachment}
        onRemovePending={removePending} onRetryPending={retryPending} onRetryDraftLink={(id) => void retryDraftLink(id)}
        disabled={chat.actionPending || !writable} draft />
      <textarea ref={textInput} className="composer-input" aria-label={words('消息', 'Message')} placeholder={words('说点什么，或拖入文件…', 'Send a message or drop files…')} rows={2} maxLength={32_000} value={chat.draft?.text ?? ''} disabled={!writable}
        onChange={(event) => chat.setDraftText(event.currentTarget.value)} onBlur={chat.saveDraftNow} onCompositionStart={() => { composition.current = true; }} onCompositionEnd={() => { composition.current = false; }}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && slash?.length) { event.preventDefault(); slash[0].run(); return; }
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composition.current) return;
          const matches = sendShortcut === 'mod-enter' ? event.metaKey || event.ctrlKey : !event.metaKey && !event.ctrlKey && !event.altKey;
          if (matches) { event.preventDefault(); void submit(); }
        }} />
      <div className="composer-toolbar"><div className="composer-leading"><IconButton label={words('添加文件', 'Add files')} className="attach-trigger" disabled={!writable || !chat.canAttach || chat.actionPending} onClick={addFiles}><Plus size={21} strokeWidth={1.6} /></IconButton></div>
        <div className="composer-trailing"><ContextIndicator chat={chat} /><ModelSelector chat={chat} />
          <div className="composer-send-controls">
            {chat.isRunning && hasInput && !chat.unconfirmedSend && <DropdownMenu.Root><DropdownMenu.Trigger asChild><IconButton className="send-options-trigger" label={words('发送选项', 'Send options')} disabled={!sendReady}><ChevronDown size={14} /></IconButton></DropdownMenu.Trigger>
              <DropdownMenu.Portal container={canvas ?? undefined}><DropdownMenu.Content className="ui-menu" side="top" align="end" sideOffset={8} collisionPadding={12} collisionBoundary={canvas ?? undefined}>
                <DropdownMenu.Item className="ui-menu-item" disabled={!chat.canQueue} onSelect={() => void submit('queue')}><ArrowUp size={15} />{words('排队发送', 'Queue message')}</DropdownMenu.Item>
                <DropdownMenu.Item className="ui-menu-item" disabled={!chat.canInterrupt} onSelect={() => void submit('interrupt')}><Square size={13} />{words('打断后发送', 'Interrupt and send')}</DropdownMenu.Item>
              </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
            <ControlTooltip label={primaryLabel}><button type={showStop ? 'button' : 'submit'} className="send-button icon-button" aria-label={primaryLabel} disabled={showStop ? !chat.canStop : !sendReady || !hasInput} onClick={showStop ? () => void chat.stop() : undefined}>
              {showStop ? <Square size={14} fill="currentColor" strokeWidth={0} aria-hidden="true" /> : <ArrowUp size={20} strokeWidth={2} aria-hidden="true" />}
            </button></ControlTooltip>
          </div>
        </div></div>
      <input type="file" ref={fileInput} multiple hidden onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = '';
        const target = fileTarget.current;
        fileTarget.current = null;
        if (!target) return;
        try { enqueue(files, target); }
        catch (failure) { setErrorKind('input'); setSendError(errorDetail(failure)); }
      }} />
    </form>
    {chat.draft?.conflict && <div className="draft-conflict" role="alert"><p>{words('草稿在其他页面已有新版本，当前输入已保留。', 'This draft has a newer version in another window. Your current input is preserved.')}</p><div>
      <button type="button" className="text-button" onClick={() => chat.resolveDraftConflict('local')}>{words('保留当前输入', 'Keep current input')}</button><button type="button" className="text-button" onClick={() => chat.resolveDraftConflict('saved')}>{words('载入已保存草稿', 'Load saved draft')}</button></div></div>}
    {sendError && <ErrorNote detail={sendError}>{errorKind === 'send' ? chat.unconfirmedSend ? words('发送结果待核，原请求身份与草稿已保留。', 'Send outcome unconfirmed. The original request identity and draft are preserved.') : words('发送未完成，草稿内容已保留。', 'Sending did not complete. Your draft is preserved.') : words('尚未提交，草稿内容已保留。', 'Nothing was submitted. Your draft is preserved.')}</ErrorNote>}
    {chat.draft?.error && <div className="draft-save-error" role="alert">{words('草稿尚未确认保存。', 'Draft save is unconfirmed.')}<button type="button" className="text-button" onClick={chat.saveDraftNow}>{words('重试保存', 'Retry save')}</button></div>}

  </div>;
}
