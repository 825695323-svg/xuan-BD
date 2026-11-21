import type { ReactNode } from 'react';
import { IconButton } from './Controls';

type Shortcut = { id: string; label: string; icon: ReactNode };

/** Authorized BD adaptation of the Harness outer rail. BD supplies its own commands and leaves the Admin shell independent. */
export function WorkspaceShortcuts({ label, shortcuts, current, select, children }: {
  label: string; shortcuts: readonly Shortcut[]; current: string;
  select(id: string): void; children?: ReactNode;
}) {
  return <nav className="global-nav workspace-shortcuts" aria-label={label}>
    <div className="nav-main">{shortcuts.map(({ id, label: name, icon }) => (
      <IconButton key={id} label={name} className="nav-button" aria-current={current === id ? 'page' : undefined}
        onClick={() => select(id)}>{icon}</IconButton>
    ))}</div>
    {children}
  </nav>;
}
