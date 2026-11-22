import { createContext, useContext, useLayoutEffect, type ComponentProps, type ReactNode } from 'react';
import { Sidebar } from './admin/sidebar';

type BusinessSidebarProps = ComponentProps<'div'> & { workspace?: boolean };

// A workbench directory is declared by its page but rendered before the peer
// Inset. Registration keeps their actual DOM order without moving portal nodes.
export const WorkspaceSidebarSlot = createContext<{ register(content: ReactNode): void; restoreMobileFocus(event: Event): void } | null>(null);

function WorkspaceSidebar({ className = '', ...props }: ComponentProps<'div'>) {
  const slot = useContext(WorkspaceSidebarSlot);
  useLayoutEffect(() => {
    if (!slot) return;
    slot.register(<Sidebar variant="inset" collapsible="icon" mobileOnCloseAutoFocus={slot.restoreMobileFocus}
      className={`bd-workspace-sidebar ${className.split(/\s+/).filter(name => name !== 'data-nav').join(' ')}`} {...props} />);
  });
  useLayoutEffect(() => () => slot?.register(null), [slot]);
  return null;
}

/** Pages own the directory content; workbench pages dock it at the shell seam. */
export function BusinessSidebar({ workspace, className = '', ...props }: BusinessSidebarProps) {
  if (workspace) return <WorkspaceSidebar className={className} {...props} />;
  return <Sidebar collapsible="none" role="complementary" className={`bd-business-sidebar ${className}`} {...props} />;
}

// The shell provides its original Admin Header only to pages that own a directory.
export const BusinessPageHeaderContext = createContext<ReactNode>(null);
export function BusinessPageHeader() {
  return useContext(BusinessPageHeaderContext);
}
