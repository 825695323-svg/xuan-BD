import type { ReactNode } from 'react';
import { Cable, Rss, Square } from 'lucide-react';
import { IconButton, useWords } from './Controls';
import { MorphIcon } from './MorphIcon';
import { usePreferences } from './Preferences';

export type Page = 'conversations' | 'capture' | 'api-sources' | 'database' | 'tools' | 'settings';

export function Shell({ page, onNavigate, children, onStopAll, stoppingAll, hasActiveTasks, globallyStopped, onRefresh, onResume, onRejectedDrop }: {
  page: Page; onNavigate(page: Page): void; children: ReactNode;
  onStopAll(): void; stoppingAll: boolean; hasActiveTasks: boolean; globallyStopped: boolean;
  onRefresh(): void; onResume(): void; onRejectedDrop(kind: 'url' | 'file'): void;
}) {
  const words = useWords(), { t } = usePreferences();
  const nav = [{ id: 'conversations' as const, label: t('nav.conversations'), icon: <MorphIcon name="message-square" size={18} strokeWidth={1.6} /> },
    { id: 'capture' as const, label: t('nav.capture'), icon: <Rss size={17} strokeWidth={1.6} aria-hidden="true" /> },
    { id: 'api-sources' as const, label: t('nav.apiSources'), icon: <Cable size={17} strokeWidth={1.6} aria-hidden="true" /> },
    { id: 'tools' as const, label: t('nav.tools'), icon: <MorphIcon name="blocks" size={18} strokeWidth={1.6} /> },
    { id: 'database' as const, label: t('nav.database'), icon: <MorphIcon name="database" size={18} strokeWidth={1.6} /> }];
  return <div className="app-shell" data-page={page} onDragOver={(event) => { if (event.dataTransfer.types.includes('text/uri-list') || event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDrop={(event) => { if (event.defaultPrevented) return; if (event.dataTransfer.types.includes('text/uri-list')) { event.preventDefault(); onRejectedDrop('url'); } else if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); onRejectedDrop('file'); } }}>
    <header className="app-header" />
    <nav className="global-nav" aria-label={words('主导航', 'Main navigation')}>
      <div className="nav-main">{nav.map(({ id, label, icon }) => <IconButton key={id} label={label} className="nav-button" aria-current={page === id ? 'page' : undefined} onClick={() => onNavigate(id)}>{icon}</IconButton>)}</div>
      <div className="nav-bottom"><div className="run-controls">
        {hasActiveTasks && <IconButton label={words('全部停止', 'Stop all')} className="nav-button stop-button" disabled={stoppingAll} onClick={onStopAll}><Square size={16} fill="currentColor" /></IconButton>}
        {globallyStopped && <IconButton label={words('恢复新增派发', 'Resume new dispatches')} className="nav-button" disabled={stoppingAll} onClick={onResume}><MorphIcon name="play" size={15} /></IconButton>}
        <IconButton label={words('核对状态', 'Check status')} className="nav-button" onClick={onRefresh}><MorphIcon name="refresh-cw" size={17} strokeWidth={1.6} /></IconButton>
      </div><IconButton label={t('nav.settings')} className="nav-button" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}><MorphIcon name={page === 'settings' ? 'sliders-horizontal' : 'settings'} size={18} strokeWidth={1.6} /></IconButton></div>
    </nav>
    <main className="page-host">{children}</main>
  </div>;
}
