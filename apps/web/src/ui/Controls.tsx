import { useCallback, useEffect, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { DropdownMenu, Tooltip } from 'radix-ui';
import { CanvasContext, useCanvasContainer } from './canvas';
import { usePreferences } from './Preferences';

export function useWords() {
  const { locale } = usePreferences();
  return useCallback((zh: string, en: string) => locale === 'en' ? en : zh, [locale]);
}

export function ControlTooltip({ label, children, side = 'top' }: { label: string; children: ReactElement; side?: 'top' | 'right' }) {
  const container = useCanvasContainer();
  return <Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger><Tooltip.Portal container={container ?? undefined}>
    <Tooltip.Content className="control-tooltip" side={side} sideOffset={7} collisionPadding={10}>{label}</Tooltip.Content>
  </Tooltip.Portal></Tooltip.Root>;
}

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <ControlTooltip label={label} side={className.includes('nav-button') ? 'right' : 'top'}><button type="button" className={`icon-button ${className}`} aria-label={label} {...props}>{children}</button></ControlTooltip>;
}

export function SelectMenu<T extends string>({ label, value, options, disabled, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; disabled?: boolean; onChange(value: T): void;
}) {
  const current = options.find((option) => option.value === value)?.label ?? '';
  const container = useCanvasContainer();
  return <DropdownMenu.Root><ControlTooltip label={label}><DropdownMenu.Trigger asChild>
    <button type="button" className="select-trigger" aria-label={label} disabled={disabled}>
      <span>{current}</span><ChevronDown size={16} aria-hidden="true" />
    </button>
  </DropdownMenu.Trigger></ControlTooltip><DropdownMenu.Portal container={container ?? undefined}>
    <DropdownMenu.Content className="ui-menu select-menu" align="end" sideOffset={6} collisionPadding={10}>
      {options.map((option) => <DropdownMenu.Item key={option.value} className="ui-menu-item select-menu-item" onSelect={() => onChange(option.value)}>
        <span>{option.label}</span>{option.value === value && <Check size={15} aria-hidden="true" />}
      </DropdownMenu.Item>)}
    </DropdownMenu.Content>
  </DropdownMenu.Portal></DropdownMenu.Root>;
}

export function Modal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose(): void; busy?: boolean }) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const words = useWords();
  useEffect(() => { dialog?.showModal(); return () => dialog?.close(); }, [dialog]);
  return <dialog ref={setDialog} className="ui-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={(event) => { if (event.target !== event.currentTarget || busy) return; const r = event.currentTarget.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); }}>
    <CanvasContext.Provider value={dialog}><div className="dialog-heading"><h2>{title}</h2><IconButton label={words('关闭', 'Close')} onClick={onClose} disabled={busy}><X size={18} /></IconButton></div>
    {children}</CanvasContext.Provider>
  </dialog>;
}

export function ErrorNote({ children, detail }: { children: ReactNode; detail?: string | null }) {
  const words = useWords();
  return <div className="error-note" role="alert"><p>{children}</p>{detail && <details><summary>{words('查看错误详情', 'Error details')}</summary><p>{detail}</p></details>}</div>;
}

export const errorDetail = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const thinkingLabel = (level: string | null | undefined): string => ({ off: 'Off', low: 'Low', high: 'High', max: 'Max' }[level ?? 'high'] ?? 'High');
