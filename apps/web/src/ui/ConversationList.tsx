import { useRef, useState } from 'react';
import { Archive, Folder, FolderMinus, GitBranchPlus, List, MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2, Undo2, X } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ConversationSummary, ConversationVisibility } from '../../../../contracts/contracts';
import type { useConversation } from '../useConversation';
import { ControlTooltip, ErrorNote, IconButton, Modal, errorDetail, useWords } from './Controls';
import './ConversationList.css';
import { useCanvasContainer } from './canvas';
import { MorphIcon } from './MorphIcon';

export type Chat = ReturnType<typeof useConversation>;
type Management = { kind: 'rename' | 'trash' | 'group'; item: ConversationSummary };

function focusConversation(id: string, more = false) {
  const row = [...document.querySelectorAll<HTMLElement>('.conversation-sidebar [data-conversation-id]')].find(node => node.dataset.conversationId === id);
  row?.querySelector<HTMLButtonElement>(more ? '.conversation-more' : '.conversation-item')?.focus({ preventScroll: true });
}

function Item({ item, chat, onManage, onFork }: { item: ConversationSummary; chat: Chat; onManage(request: Management): void; onFork(): void }) {
  const words = useWords();
  const container = useCanvasContainer();
  const [open, setOpen] = useState(false);
  const focusOrigin = useRef<'item' | 'more'>('item'), dialogOpened = useRef(false), outsideInteraction = useRef(false);
  const busy = chat.managementPending || chat.newPending;
  const running = item.status === 'RUNNING' || item.status === 'STOPPING';
  const title = item.title || words('新会话', 'New conversation');
  const status = item.status === 'RUNNING' ? words('运行中', 'Running') : item.status === 'STOPPING' ? words('正在停止', 'Stopping') : item.status === 'ERROR' ? words('本轮未完成', 'Run incomplete') : '';
  const metadata = item.displayMetadata ?? { pinnedAt: null, group: null, revision: 0 };
  const manage = (kind: Management['kind']) => { dialogOpened.current = true; onManage({ kind, item }); };
  const fork = async () => { try { await chat.forkConversation(item.conversationId); } catch { /* 列表显示服务端未确认状态。 */ } finally { onFork(); } };
  const update = async (patch: { pinned?: boolean; group?: null }) => {
    try { await chat.updateDisplayMetadata(item.conversationId, { revision: metadata.revision, ...patch }); }
    catch { /* 保留服务端确认状态；列表统一显示失败信息。 */ }
    finally { requestAnimationFrame(() => focusConversation(item.conversationId, focusOrigin.current === 'more')); }
  };
  return <DropdownMenu.Root open={open} modal={false} onOpenChange={(next) => { if (next) { dialogOpened.current = false; outsideInteraction.current = false; } setOpen(next); }}><div className="conversation-row" data-conversation-id={item.conversationId} data-active={item.conversationId === chat.selectedId}
    onContextMenu={(event) => { event.preventDefault(); if (!busy) { focusOrigin.current = event.target instanceof Element && !!event.target.closest('.conversation-more') ? 'more' : 'item'; outsideInteraction.current = false; dialogOpened.current = false; setOpen(true); } }} onKeyDown={(event) => {
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { event.preventDefault(); if (!busy) { outsideInteraction.current = false; dialogOpened.current = false; setOpen(true); } }
    }}>
    <ControlTooltip label={`${title} · ${new Date(item.updatedAt).toLocaleString()}`}><button type="button" className="conversation-item" aria-current={item.conversationId === chat.selectedId ? 'page' : undefined} disabled={busy}
      onFocus={() => { focusOrigin.current = 'item'; }} onClick={() => chat.selectConversation(item.conversationId)}>
      <span className="conversation-title">{title}{metadata.group && <span className="conversation-organization" title={metadata.group}><Folder size={11} aria-hidden="true" /><span>{metadata.group}</span></span>}</span>
      {metadata.pinnedAt && item.visibility === 'active' && <Pin size={12} className="conversation-pin" aria-label={words('已固定', 'Pinned')} />}{status && <span className="conversation-state" data-error={item.status === 'ERROR'} aria-label={status} title={status} />}
    </button></ControlTooltip>
    <DropdownMenu.Trigger asChild><IconButton label={`${words('会话操作', 'Conversation actions')} · ${title}`} className="conversation-more" disabled={busy} onFocus={() => { focusOrigin.current = 'more'; }}><MoreHorizontal size={16} /></IconButton></DropdownMenu.Trigger>
  </div><DropdownMenu.Portal container={container ?? undefined}><DropdownMenu.Content className="ui-menu" align="end" sideOffset={4} collisionPadding={10}
    onInteractOutside={() => { outsideInteraction.current = true; }} onCloseAutoFocus={(event) => {
      event.preventDefault();
      if (!dialogOpened.current && !outsideInteraction.current) requestAnimationFrame(() => focusConversation(item.conversationId, focusOrigin.current === 'more'));
    }}>
    <DropdownMenu.Item className="ui-menu-item" disabled={!chat.canForkConversation(item.conversationId)} onSelect={() => void fork()}><GitBranchPlus size={15} />{words('新建分支', 'New branch')}</DropdownMenu.Item>
    <DropdownMenu.Separator className="menu-separator" />
    {item.visibility === 'active' && <DropdownMenu.Item className="ui-menu-item" onSelect={() => void update({ pinned: !metadata.pinnedAt })}>{metadata.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />}{metadata.pinnedAt ? words('取消固定', 'Unpin') : words('固定会话', 'Pin conversation')}</DropdownMenu.Item>}
    {item.visibility !== 'trashed' && <><DropdownMenu.Item className="ui-menu-item" onSelect={() => manage('group')}><Folder size={15} />{metadata.group ? words('更改分组', 'Change group') : words('设置分组', 'Set group')}</DropdownMenu.Item>
      {metadata.group && <DropdownMenu.Item className="ui-menu-item" onSelect={() => void update({ group: null })}><FolderMinus size={15} />{words('移除分组', 'Remove from group')}</DropdownMenu.Item>}
      <DropdownMenu.Separator className="menu-separator" /></>}
    <DropdownMenu.Item className="ui-menu-item" onSelect={() => manage('rename')}><Pencil size={15} />{words('重命名', 'Rename')}</DropdownMenu.Item>
    {item.visibility === 'active' ? <DropdownMenu.Item className="ui-menu-item" disabled={running} onSelect={() => void chat.changeVisibility(item.conversationId, 'archived').catch(() => {})}><Archive size={15} />{words('归档', 'Archive')}</DropdownMenu.Item>
      : <DropdownMenu.Item className="ui-menu-item" onSelect={() => void chat.changeVisibility(item.conversationId, 'active').catch(() => {})}><Undo2 size={15} />{words('恢复会话', 'Restore conversation')}</DropdownMenu.Item>}
    {item.visibility !== 'trashed' && <><DropdownMenu.Separator className="menu-separator" /><DropdownMenu.Item className="ui-menu-item danger-text" disabled={running} onSelect={() => manage('trash')}><Trash2 size={15} />{words('删除', 'Delete')}</DropdownMenu.Item></>}
  </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>;
}

function ManagementDialog({ request, chat, onClose }: { request: Management; chat: Chat; onClose(): void }) {
  const words = useWords();
  const [title, setTitle] = useState(request.kind === 'group' ? request.item.displayMetadata?.group ?? '' : request.item.title), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const rename = request.kind === 'rename', group = request.kind === 'group', textInput = rename || group;
  async function submit() {
    if (busy || (textInput && !title.trim())) return;
    setBusy(true); setError(null);
    try { if (rename) await chat.renameConversation(request.item.conversationId, title);
      else if (group) await chat.updateDisplayMetadata(request.item.conversationId, { revision: request.item.displayMetadata?.revision ?? 0, group: title });
      else await chat.changeVisibility(request.item.conversationId, 'trashed'); onClose(); }
    catch (failure) { setError(errorDetail(failure)); }
    finally { setBusy(false); }
  }
  const existingGroups = [...new Set(chat.conversations.map(item => item.displayMetadata?.group).filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b));
  return <Modal title={rename ? words('重命名会话', 'Rename conversation') : group ? words('设置会话分组', 'Set conversation group') : words('删除会话？', 'Delete conversation?')} onClose={onClose} busy={busy}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {textInput ? <label className="field-label">{group ? words('分组名称', 'Group name') : words('会话名称', 'Conversation name')}<input type="text" autoFocus value={title} maxLength={group ? 80 : 120} list={group ? 'conversation-group-names' : undefined} required disabled={busy} onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }} /></label>
        : <p>{words(`“${request.item.title}”将移到最近删除。原件、正式数据与任务记录仍按各自规则保留。`, `“${request.item.title}” will move to Recently deleted. Source files, formal data and task records retain their own retention rules.`)}</p>}
      {group && <datalist id="conversation-group-names">{existingGroups.map(name => <option key={name} value={name} />)}</datalist>}
      {error && <ErrorNote detail={error}>{words('操作未完成，当前内容已保留。', 'The action did not complete. Your content is preserved.')}</ErrorNote>}
      <div className="dialog-actions"><button type="button" className="text-button" disabled={busy} onClick={onClose}>{words('取消', 'Cancel')}</button>
        <button type="submit" className={textInput ? 'primary-button' : 'danger-button'} disabled={busy || (textInput && !title.trim())}>{busy ? words('保存中…', 'Saving…') : textInput ? words('保存', 'Save') : words('移到最近删除', 'Move to Recently deleted')}</button></div>
    </form>
  </Modal>;
}

export default function ConversationList({ chat }: { chat: Chat }) {
  const words = useWords();
  const container = useCanvasContainer();
  const [management, setManagement] = useState<Management | null>(null), [groupFilter, setGroupFilter] = useState<string | null>(null);
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const dateGroups = [{ key: 'today', title: words('今天', 'Today'), items: [] as ConversationSummary[] }, { key: 'yesterday', title: words('昨天', 'Yesterday'), items: [] as ConversationSummary[] }, { key: 'earlier', title: words('更早', 'Earlier'), items: [] as ConversationSummary[] }];
  const pinned: ConversationSummary[] = [], namedGroups = new Map<string, ConversationSummary[]>();
  for (const item of chat.conversations) {
    if (chat.conversationView === 'active' && item.displayMetadata?.pinnedAt) pinned.push(item);
    else if (item.displayMetadata?.group && chat.conversationView !== 'trashed') {
      const name = item.displayMetadata.group, items = namedGroups.get(name) ?? []; items.push(item); namedGroups.set(name, items);
    } else { const time = new Date(item.updatedAt).getTime(); dateGroups[time >= midnight.getTime() ? 0 : time >= midnight.getTime() - 86_400_000 ? 1 : 2].items.push(item); }
  }
  pinned.sort((a, b) => b.displayMetadata!.pinnedAt!.localeCompare(a.displayMetadata!.pinnedAt!) || b.updatedAt.localeCompare(a.updatedAt) || a.conversationId.localeCompare(b.conversationId));
  const groups = [{ key: 'pinned', title: words('已固定', 'Pinned'), items: pinned },
    ...[...namedGroups].sort(([a], [b]) => a.localeCompare(b)).map(([name, items]) => ({ key: `group:${name}`, title: name, items })), ...dateGroups];
  const groupNames = [...namedGroups.keys()].sort((a, b) => a.localeCompare(b));
  const archived = chat.conversationView === 'archived';
  const visibleGroups = groupFilter ? [{ key: `filter:${groupFilter}`, title: groupFilter, items: namedGroups.get(groupFilter) ?? [] }] : groups;
  return <aside className="conversation-sidebar" aria-label={words('会话列表', 'Conversation list')}>
    <div className="sidebar-search-slot">
      <div className="data-search data-nav-search">
        <MorphIcon name="search" size={15} />
        <input type="search" aria-label={words('搜索会话', 'Search conversations')} placeholder={words('搜索会话…', 'Search conversations…')} value={chat.searchQuery} onChange={(event) => chat.setSearchQuery(event.currentTarget.value)} />
      </div>
    </div>
    <div className="sidebar-heading"><div>
      <IconButton label={archived ? words('返回会话列表', 'Back to conversations') : words('归档库', 'Archive library')} aria-pressed={archived} onClick={() => { chat.setConversationView(archived ? 'active' : 'archived'); setGroupFilter(null); }}><Archive size={17} /></IconButton>
      <DropdownMenu.Root><DropdownMenu.Trigger asChild><IconButton label={words('会话分组', 'Conversation groups')} aria-pressed={!!groupFilter}><Folder size={17} /></IconButton></DropdownMenu.Trigger>
        <DropdownMenu.Portal container={container ?? undefined}><DropdownMenu.Content className="ui-menu" align="end" sideOffset={4} collisionPadding={10}>
          <DropdownMenu.Item className="ui-menu-item" onSelect={() => setGroupFilter(null)}><List size={15} />{words('全部会话', 'All conversations')}</DropdownMenu.Item>
          {groupNames.map(name => <DropdownMenu.Item className="ui-menu-item" key={name} onSelect={() => setGroupFilter(name)}><Folder size={15} />{name}</DropdownMenu.Item>)}
          {!groupNames.length && <p className="popover-empty">{words('还没有分组；在会话的「⋯」里设置分组。', 'No groups yet. Set one from a conversation’s “…” menu.')}</p>}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
      <IconButton label={words('新建会话', 'New conversation')} disabled={chat.newPending || chat.managementPending || chat.storageFrozen} onClick={() => void chat.newConversation()} aria-busy={chat.newPending}><Plus size={20} /></IconButton>
    </div></div>
    {(chat.listError || chat.managementError) && <ErrorNote detail={chat.listError || chat.managementError}>{words('会话列表暂时无法更新。', 'The conversation list could not update.')}</ErrorNote>}
    <div className="conversation-list" aria-busy={chat.listLoading}>
      {visibleGroups.filter((group) => group.items.length).map((group) => <section className="conversation-group" key={group.key} data-conversation-section={group.key}><h3>{group.title}</h3>{group.items.map((item) => <Item key={item.conversationId} item={item} chat={chat} onManage={setManagement} onFork={() => setGroupFilter(null)} />)}</section>)}
      {!chat.conversations.length && <p className="list-empty" role="status">{chat.listLoading ? words('读取中…', 'Loading…') : chat.searchQuery ? words('没有匹配的会话', 'No matching conversations') : archived ? words('暂无已归档会话', 'No archived conversations') : words('暂无会话', 'No conversations yet')}</p>}
      {!!chat.conversations.length && groupFilter && !(namedGroups.get(groupFilter)?.length) && <p className="list-empty" role="status">{words('该分组暂无会话', 'No conversations in this group')}</p>}
    </div>
    {management && <ManagementDialog key={`${management.kind}:${management.item.conversationId}`} request={management} chat={chat} onClose={() => { const id = management.item.conversationId; setManagement(null); requestAnimationFrame(() => focusConversation(id)); }} />}
  </aside>;
}
