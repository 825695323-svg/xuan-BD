import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Search } from 'lucide-react';

/**
 * 业务页面的统一展示原语。只负责外观与可访问性，不持有业务数据、路由或状态。
 * 主题颜色来自 styles.css 的语义变量；新页面不能在这里维护第二套主题。
 */
export function PageSearch({ label, placeholder = label, value, onChange, compact = false, disabled = false }: {
  label: string; placeholder?: string; value: string; onChange(value: string): void; compact?: boolean; disabled?: boolean;
}) {
  return <div className={`data-search ui-page-search${compact ? ' data-nav-search' : ''}`}>
    <Search size={15} aria-hidden="true" />
    <input type="search" value={value} aria-label={label} placeholder={placeholder} disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)} />
  </div>;
}

export function PageHeading({ title, description, level = 'h2', actions }: {
  title: ReactNode; description?: ReactNode; level?: 'h2' | 'h3'; actions?: ReactNode;
}) {
  const Heading = level;
  return <header className="ui-page-heading">
    <div className="ui-page-heading-copy">
      <Heading className="ui-page-heading-title">{title}</Heading>
      {description ? <p className="ui-page-heading-description">{description}</p> : null}
    </div>
    {actions ? <div className="ui-page-heading-actions">{actions}</div> : null}
  </header>;
}

export function PageEmpty({ children, state = 'empty' }: {
  children: ReactNode; state?: 'empty' | 'loading' | 'unavailable';
}) {
  return <p className="data-empty ui-page-empty" data-state={state}
    role={state === 'empty' ? undefined : 'status'}>{children}</p>;
}

export function PageActions({ children, align = 'start', className = '' }: {
  children: ReactNode; align?: 'start' | 'end'; className?: string;
}) {
  return <div className={`ui-page-actions${className ? ` ${className}` : ''}`} data-align={align}>{children}</div>;
}

export function PageButton({ variant = 'quiet', className = '', children, ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'quiet' | 'primary' | 'danger'; children: ReactNode }) {
  const styleClass = variant === 'primary' ? 'primary-button' : variant === 'danger' ? 'danger-button' : 'text-button';
  return <button {...props} type={props.type ?? 'button'} className={`${styleClass}${className ? ` ${className}` : ''}`}>{children}</button>;
}

export function PageField({ label, hint, children, className = '' }: {
  label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string;
}) {
  return <label className={`field-label ui-page-field${className ? ` ${className}` : ''}`}>
    <span className="ui-page-field-label">{label}</span>
    {children}
    {hint ? <span className="ui-page-field-hint">{hint}</span> : null}
  </label>;
}
