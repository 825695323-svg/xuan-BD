import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Cable, ChartCandlestick, Rss, Square } from 'lucide-react';
import { IconButton, useWords } from './Controls';
import { MorphIcon } from './MorphIcon';
import { usePreferences } from './Preferences';
import { WorkspaceShortcuts } from './WorkspaceShortcuts';
import { BusinessPageHeaderContext, WorkspaceSidebarSlot } from './BusinessSidebar';
import { SidebarInset, SidebarProvider, useSidebar } from './admin/sidebar';
import { Header } from './admin/header';
import { Main } from './admin/main';

export type Page = 'research' | 'conversations' | 'capture' | 'api-sources' | 'database' | 'tools' | 'settings';

// Match the upstream 16rem / 3rem at its 16px root without changing BD's
// existing 15px typography on every page.
const workbenchSidebarWidths = { '--sidebar-width': '256px', '--sidebar-width-icon': '48px' } as CSSProperties;

export const isCatalogWorkbench = (page: string): boolean => page === 'capture' || page === 'api-sources' || page === 'tools';
const hasDirectory = (page: Page): boolean => page !== 'settings' && page !== 'conversations';

function AdminPageFrame({ pageTitle, directory, workspace, children }: { pageTitle: string; directory: boolean; workspace: boolean; children: ReactNode }) {
  const words = useWords();
  const { isMobile, open, openMobile } = useSidebar();
  const [workspaceSidebar, setWorkspaceSidebar] = useState<ReactNode>(null);
  const headerRef = useRef<HTMLElement>(null);
  const workspaceSlot = useMemo(() => ({
    register: setWorkspaceSidebar,
    restoreMobileFocus(event: Event) {
      const trigger = headerRef.current?.querySelector<HTMLButtonElement>('[data-slot="sidebar-trigger"]');
      if (!trigger?.isConnected || trigger.disabled) return;
      event.preventDefault();
      trigger.focus({ preventScroll: true });
    },
  }), []);
  const expanded = workspace && isMobile ? openMobile : open;
  const sidebarTrigger = workspace || (directory && !isMobile) ? {
    label: expanded ? words('收起页面目录', 'Collapse page sidebar') : words('展开页面目录', 'Expand page sidebar'),
    expanded,
  } : undefined;
  const header = <Header ref={headerRef} className={`app-header bd-admin-header${directory ? ' bd-directory-header' : ''}`}
    sidebarTrigger={sidebarTrigger}>
    <span className="shell-current-page">{pageTitle}</span>
  </Header>;
  if (workspace) return <>
    {workspaceSidebar}
    <SidebarInset className="bd-admin-inset bd-workspace-inset">
      {header}
      <Main id="content" fixed fluid className="bd-workspace-main">
        <WorkspaceSidebarSlot.Provider value={workspaceSlot}>{children}</WorkspaceSidebarSlot.Provider>
      </Main>
    </SidebarInset>
  </>;
  return <SidebarInset className="bd-admin-inset" data-bd-directory-open={directory ? open : undefined}>
    {!directory && header}
    <Main id="content" fixed fluid className="page-host">
      <BusinessPageHeaderContext.Provider value={directory ? header : null}>
        {children}
      </BusinessPageHeaderContext.Provider>
    </Main>
  </SidebarInset>;
}

export function Shell({ page, pageTitle, onNavigate, children, onStopAll, stoppingAll, hasActiveTasks, globallyStopped, onRefresh, onResume, onRejectedDrop }: {
  page: Page; pageTitle: string; onNavigate(page: Page): void; children: ReactNode;
  onStopAll(): void; stoppingAll: boolean; hasActiveTasks: boolean; globallyStopped: boolean;
  onRefresh(): void; onResume(): void; onRejectedDrop(kind: 'url' | 'file'): void;
}) {
  const words = useWords(), { t } = usePreferences();
  const workspace = page === 'research' || isCatalogWorkbench(page);
  const nav = [{ id: 'conversations' as const, label: t('nav.conversations'), icon: <MorphIcon name="message-square" size={18} strokeWidth={1.6} /> },
    { id: 'capture' as const, label: t('nav.capture'), icon: <Rss size={17} strokeWidth={1.6} aria-hidden="true" /> },
    { id: 'api-sources' as const, label: t('nav.apiSources'), icon: <Cable size={17} strokeWidth={1.6} aria-hidden="true" /> },
    { id: 'tools' as const, label: t('nav.tools'), icon: <MorphIcon name="blocks" size={18} strokeWidth={1.6} /> },
    { id: 'database' as const, label: t('nav.database'), icon: <MorphIcon name="database" size={18} strokeWidth={1.6} /> },
    { id: 'research' as const, label: t('nav.research'), icon: <ChartCandlestick size={17} strokeWidth={1.6} aria-hidden="true" /> }];
  return <div className="app-shell workspace-shortcuts-frame" data-page={page} onDragOver={(event) => { if (event.dataTransfer.types.includes('text/uri-list') || event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDrop={(event) => { if (event.defaultPrevented) return; if (event.dataTransfer.types.includes('text/uri-list')) { event.preventDefault(); onRejectedDrop('url'); } else if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); onRejectedDrop('file'); } }}>
    <WorkspaceShortcuts label={words('主导航', 'Main navigation')} shortcuts={nav} current={page}
      select={id => { const route = nav.find(entry => entry.id === id); if (route) onNavigate(route.id); }}>
      <div className="nav-bottom"><div className="run-controls">
        {hasActiveTasks && <IconButton label={words('全部停止', 'Stop all')} className="nav-button stop-button" disabled={stoppingAll} onClick={onStopAll}><Square size={16} fill="currentColor" /></IconButton>}
        {globallyStopped && <IconButton label={words('恢复新增派发', 'Resume new dispatches')} className="nav-button" disabled={stoppingAll} onClick={onResume}><MorphIcon name="play" size={15} /></IconButton>}
        <IconButton label={words('核对状态', 'Check status')} className="nav-button" onClick={onRefresh}><MorphIcon name="refresh-cw" size={17} strokeWidth={1.6} /></IconButton>
      </div><IconButton label={t('nav.settings')} className="nav-button" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}><MorphIcon name={page === 'settings' ? 'sliders-horizontal' : 'settings'} size={18} strokeWidth={1.6} /></IconButton></div>
    </WorkspaceShortcuts>
    <div className="workspace-shortcuts-original bd-admin-original">
      <SidebarProvider className={`bd-admin-provider${workspace ? ' bd-workspace-provider' : ''}`} style={workspace ? workbenchSidebarWidths : undefined} enableKeyboardShortcut={hasDirectory(page)}>
        <AdminPageFrame pageTitle={pageTitle} directory={!workspace && hasDirectory(page)} workspace={workspace}>{children}</AdminPageFrame>
      </SidebarProvider>
    </div>
  </div>;
}
