import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search } from 'lucide-react';
import type { TaskRecord } from '../../../../contracts/task-contracts';
import { IconButton, useWords } from './Controls';
import { TaskState } from './TaskResults';
import { useWorkspaceObject } from './workspace-context';
import './WorkspaceLayout.css';

/**
 * 四栏工作区框架：原导航（Shell 保留） + 子目录栏 + 业务详情区 + Agent 工作台。
 *
 * 本阶段只提供容器、展开收起与尺寸调整；不读取子目录数据、不接管任务流、不新增会话状态。
 * 所有尺寸只影响布局，不写入任何私有接口或数据库。
 */

export interface WorkspaceLayoutValues {
  subnavOpen: boolean;
  subnavWidth: number;
  agentOpen: boolean;
  agentWidth: number;
  /** 会话区在 Agent 工作台内的占比。 */
  agentSplit: number;
  taskCollapsed: boolean;
}

const STORAGE_KEY = 'xuan.workspace.layout.v2';
const DEFAULT_LAYOUT: WorkspaceLayoutValues = {
  subnavOpen: true, subnavWidth: 216, agentOpen: true, agentWidth: 400, agentSplit: 0.7, taskCollapsed: false,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function readLayout(): WorkspaceLayoutValues {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return DEFAULT_LAYOUT;
    const value = raw as Partial<WorkspaceLayoutValues>;
    return {
      subnavOpen: typeof value.subnavOpen === 'boolean' ? value.subnavOpen : DEFAULT_LAYOUT.subnavOpen,
      subnavWidth: typeof value.subnavWidth === 'number' ? clamp(value.subnavWidth, 180, 320) : DEFAULT_LAYOUT.subnavWidth,
      agentOpen: typeof value.agentOpen === 'boolean' ? value.agentOpen : DEFAULT_LAYOUT.agentOpen,
      agentWidth: typeof value.agentWidth === 'number' ? clamp(value.agentWidth, 360, 760) : DEFAULT_LAYOUT.agentWidth,
      agentSplit: typeof value.agentSplit === 'number' ? clamp(value.agentSplit, 0.35, 0.85) : DEFAULT_LAYOUT.agentSplit,
      taskCollapsed: typeof value.taskCollapsed === 'boolean' ? value.taskCollapsed : DEFAULT_LAYOUT.taskCollapsed,
    };
  } catch { return DEFAULT_LAYOUT; }
}

/** 拖动分隔条只回报增量；键盘方向键同样可用。 */
function Splitter({ axis, label, onDelta }: { axis: 'x' | 'y'; label: string; onDelta(delta: number): void }) {
  const last = useRef(0);
  const read = (event: { clientX: number; clientY: number }) => axis === 'x' ? event.clientX : event.clientY;
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    className={`workspace-splitter workspace-splitter--${axis}`}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      last.current = read(event);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const current = read(event);
      onDelta(current - last.current);
      last.current = current;
    }}
    onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 32 : 8;
      const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp', forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (event.key !== back && event.key !== forward) return;
      event.preventDefault();
      onDelta(event.key === back ? -step : step);
    }} />;
}

function SubDirectoryPanel({ title, open, width, onToggle }: { title: string; open: boolean; width: number; onToggle(): void }) {
  const words = useWords();
  const [query, setQuery] = useState('');
  if (!open) return <aside className="workspace-rail workspace-rail--subnav" aria-label={title}>
    <button type="button" className="workspace-rail-button" aria-label={words('展开子目录', 'Show subdirectory')} onClick={onToggle}>
      <ChevronRight size={15} aria-hidden="true" /><span>{words('目录', 'Directory')}</span>
    </button>
  </aside>;
  return <aside className="workspace-subnav" style={{ width }} aria-label={title}>
    <header className="workspace-panel-head">
      <span className="workspace-panel-title">{title}</span>
      <IconButton label={words('收起子目录', 'Hide subdirectory')} onClick={onToggle}><ChevronLeft size={15} /></IconButton>
    </header>
    <div className="workspace-search">
      <Search size={14} aria-hidden="true" />
      <input type="search" value={query} aria-label={words('搜索子目录', 'Search subdirectory')}
        placeholder={words('搜索…', 'Search…')} onChange={(event) => setQuery(event.currentTarget.value)} />
    </div>
    <div className="workspace-subnav-list" role="list" aria-label={words('子目录列表', 'Subdirectory list')}>
      <p className="workspace-empty">{query.trim()
        ? words('本阶段尚未接入子目录对象，搜索暂不返回结果。', 'Subdirectory objects are not wired in this phase, so search returns nothing yet.')
        : words('本页尚未接入子目录对象。', 'No subdirectory objects are wired for this page yet.')}</p>
    </div>
  </aside>;
}

const ACTIVE_TASK_STATES = ['ready', 'running', 'waiting_approval', 'pausing', 'cancelling', 'blocked', 'needs_review'];

function TaskRow({ task }: { task: TaskRecord }) {
  const note = task.progress?.message ?? task.blockedReason ?? task.result?.summary ?? null;
  return <article className="agent-task-row" data-state={task.status}>
    <div className="agent-task-head"><span className="agent-task-title">{task.title}</span><TaskState task={task} /></div>
    {note && <p className="agent-task-note">{note}</p>}
  </article>;
}

export function WorkspaceLayout({ title, pageKey, contextLabel, agent, children, tasks = [], showDirectory = true, showAgent = true }: {
  title: string; pageKey: string; contextLabel: string; agent: ReactNode; children: ReactNode;
  tasks?: readonly TaskRecord[]; showDirectory?: boolean; showAgent?: boolean;
}) {
  const words = useWords();
  const object = useWorkspaceObject(pageKey);
  const [layout, setLayout] = useState<WorkspaceLayoutValues>(readLayout);
  const body = useRef<HTMLDivElement>(null);
  const update = (patch: Partial<WorkspaceLayoutValues>) => setLayout((current) => ({ ...current, ...patch }));

  // 窄屏下工作台是覆盖式抽屉：不沿用桌面端保存的展开状态，避免首次进入就遮住内容。
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1180px)').matches);
  const [narrowAgentOpen, setNarrowAgentOpen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1180px)');
    const sync = () => { setNarrow(query.matches); setNarrowAgentOpen(false); };
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  const agentOpen = narrow ? narrowAgentOpen : layout.agentOpen;
  const setAgentOpen = (value: boolean) => { if (narrow) setNarrowAgentOpen(value); else update({ agentOpen: value }); };

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch { /* 仅布局偏好。 */ }
  }, [layout]);

  const conversationStyle = layout.taskCollapsed ? { flex: '1 1 auto' } : { flex: `0 0 ${(layout.agentSplit * 100).toFixed(2)}%` };
  // 只显示当前会话的真实任务；模型对话本身（runtimeId=pi）不算任务中心条目。
  const conversationTasks = tasks.filter((task) => task.runtimeId !== 'pi');
  const activeTasks = conversationTasks.filter((task) => ACTIVE_TASK_STATES.includes(task.status));
  const recentTasks = conversationTasks.filter((task) => !ACTIVE_TASK_STATES.includes(task.status)).slice(-6).reverse();
  const contextText = [contextLabel, object?.detail, object?.label].filter(Boolean).join(' · ');

  return <div className="workspace" data-agent-open={showAgent && agentOpen}>
    {showDirectory && <SubDirectoryPanel title={title} open={layout.subnavOpen} width={layout.subnavWidth} onToggle={() => update({ subnavOpen: !layout.subnavOpen })} />}
    <div className="workspace-content">{children}</div>
    {showAgent && agentOpen && <Splitter axis="x" label={words('调整 Agent 工作台宽度', 'Resize agent workspace')}
      onDelta={(delta) => update({ agentWidth: clamp(layout.agentWidth - delta, 360, 760) })} />}
    {showAgent && !agentOpen && <aside className="workspace-rail workspace-rail--agent" aria-label={words('Agent 工作台', 'Agent workspace')}>
      <button type="button" className="workspace-rail-button" aria-label={words('展开 Agent 工作台', 'Show agent workspace')} onClick={() => setAgentOpen(true)}>
        <ChevronLeft size={15} aria-hidden="true" /><span>Agent</span>
      </button>
    </aside>}
    {showAgent && <aside className="workspace-agent" data-open={agentOpen} style={{ width: agentOpen ? layout.agentWidth : undefined }} aria-hidden={!agentOpen}>
      <header className="workspace-panel-head">
        <span className="workspace-panel-title">{words('Agent 工作台', 'Agent workspace')}</span>
        <IconButton label={words('收起 Agent 工作台', 'Hide agent workspace')} onClick={() => setAgentOpen(false)}><ChevronRight size={15} /></IconButton>
      </header>
      <p className="agent-context">{words('上下文', 'Context')} · {contextText}</p>
      <div className="workspace-agent-body" ref={body}>
        <div className="agent-conversation" style={conversationStyle}>{agent}</div>
        {!layout.taskCollapsed && <Splitter axis="y" label={words('调整会话与任务中心高度', 'Resize conversation and task center')}
          onDelta={(delta) => { const height = body.current?.clientHeight ?? 0; if (height > 0) update({ agentSplit: clamp(layout.agentSplit + delta / height, 0.35, 0.85) }); }} />}
        <section className="agent-tasks" data-collapsed={layout.taskCollapsed} style={layout.taskCollapsed ? undefined : { flex: '1 1 auto' }}>
          <header className="agent-tasks-head">
            <span className="workspace-panel-title">{words('任务中心', 'Task center')}{activeTasks.length ? ` · ${activeTasks.length}` : ''}</span>
            <IconButton label={layout.taskCollapsed ? words('展开任务中心', 'Show task center') : words('收起任务中心', 'Hide task center')}
              onClick={() => update({ taskCollapsed: !layout.taskCollapsed })}>
              {layout.taskCollapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </IconButton>
          </header>
          {!layout.taskCollapsed && <div className="agent-tasks-list">
            {!conversationTasks.length && <p className="workspace-empty">{words('当前会话还没有任务记录。', 'No tasks for this conversation yet.')}</p>}
            {!!activeTasks.length && <p className="agent-tasks-group">{words(`运行中 ${activeTasks.length} 项`, `${activeTasks.length} active`)}</p>}
            {activeTasks.map((task) => <TaskRow key={task.id} task={task} />)}
            {!!recentTasks.length && <p className="agent-tasks-group">{words('最近任务', 'Recent')}</p>}
            {recentTasks.map((task) => <TaskRow key={task.id} task={task} />)}
          </div>}
        </section>
      </div>
    </aside>}
    {showAgent && agentOpen && <button type="button" className="workspace-scrim" aria-label={words('关闭 Agent 工作台', 'Close agent workspace')} onClick={() => setAgentOpen(false)} />}
    {/* 预留：右键「问一问」的全局挂载位置；本阶段不提取上下文、不提交任务。 */}
    <div className="workspace-context-host" data-workspace-context-host hidden />
  </div>;
}
