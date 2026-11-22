import { useContext, type ComponentProps, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { BusinessSidebar, WorkspaceSidebarSlot } from './BusinessSidebar';
import {
  SidebarContent, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, useSidebar,
} from './admin/sidebar';
import './CatalogSidebar.css';

export function CatalogSidebar({ label, search, children }: { label: string; search: ReactNode; children: ReactNode }) {
  const workspace = useContext(WorkspaceSidebarSlot) !== null;
  const panel = <BusinessSidebar workspace={workspace} className="catalog-workspace-sidebar" aria-label={label}>
    <nav className="catalog-navigation" aria-label={label}>
      <SidebarHeader className="catalog-search">{search}</SidebarHeader>
      <SidebarContent className="catalog-sidebar-content">
        <SidebarGroup><SidebarMenu>{children}</SidebarMenu></SidebarGroup>
      </SidebarContent>
    </nav>
  </BusinessSidebar>;
  return workspace ? panel : <SidebarProvider enableKeyboardShortcut={false}>{panel}</SidebarProvider>;
}

export function CatalogCategory({ label, active, expanded, children, className = '', ...props }:
  Omit<ComponentProps<'button'>, 'children'> & { label: string; active?: boolean; expanded?: boolean; children?: ReactNode }) {
  return <SidebarMenuItem>
    <SidebarMenuButton type="button" className={`data-nav-item ${className}`} tooltip={label}
      isActive={active} aria-current={active ? 'true' : undefined} aria-expanded={expanded} {...props}>
      {expanded !== undefined && <ChevronDown aria-hidden="true" className="catalog-chevron" />}
      <span>{label}</span>
    </SidebarMenuButton>
    {children}
  </SidebarMenuItem>;
}

export function CatalogChildren({ children, ...props }: ComponentProps<'ul'>) {
  return <SidebarMenuSub {...props}>{children}</SidebarMenuSub>;
}

export function CatalogRow({ label, meta, badge, ready, state, selected, onSelect }:
  { label: string; meta?: string; badge?: ReactNode; ready?: boolean; state?: string; selected: boolean; onSelect(): void }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return <SidebarMenuSubItem>
    <SidebarMenuSubButton asChild isActive={selected}>
      <button type="button" className="object-card catalog-row" aria-current={selected ? 'true' : undefined} onClick={() => {
        onSelect();
        if (isMobile) setOpenMobile(false);
      }}>
        <span className="object-card-main">
          <span className="object-card-title">{label}</span>
          {meta && <span className="object-card-meta" title={meta}>{meta}</span>}
        </span>
        {badge !== undefined && <span className="object-card-state" data-ok={ready} data-state={state}>{badge}</span>}
      </button>
    </SidebarMenuSubButton>
  </SidebarMenuSubItem>;
}
