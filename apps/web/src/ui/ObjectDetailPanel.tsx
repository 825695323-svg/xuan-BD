import type { ReactNode } from 'react';

export type DetailTone = 'ready' | 'warning' | 'blocked' | 'neutral';

/**
 * 三栏业务页第三栏的统一外壳：头部（名称 + 主要状态）、摘要、主体、诊断。
 * 只统一容器、间距、标题与状态呈现；各业务页内部字段仍由各自组件决定。
 * 不新增读取、不发起动作、不写入任何状态。
 */
export function ObjectDetailPanel({ label, header, summary, diagnostics, children, className }: {
  /** 无障碍名称，例如"来源详情"。 */
  label: string;
  header: ReactNode;
  /** 当前对象最重要的几条信息，固定在主体之上。 */
  summary?: ReactNode;
  /** 默认折叠的技术与审计信息。 */
  diagnostics?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return <aside className={`object-detail${className ? ` ${className}` : ''}`} aria-label={label}>
    {header}
    <div className="object-detail-scroll">
      {summary ? <section className="object-detail-summary" aria-label={label}>{summary}</section> : null}
      <div className="object-detail-content">{children}</div>
    </div>
    {diagnostics}
  </aside>;
}

export function DetailHeader({ title, status, tone = 'neutral', meta, badge }: {
  title: ReactNode;
  /** 主要状态：只放一个，避免同一件事在页面里反复出现。 */
  status?: ReactNode;
  tone?: DetailTone;
  meta?: ReactNode;
  badge?: ReactNode;
}) {
  return <header className="object-detail-head">
    <div className="object-detail-title-row">
      <h2 className="object-detail-title">{title}</h2>
      {status ? <span className="object-detail-status" data-tone={tone}>{status}</span> : null}
      {badge ? <span className="object-detail-badge">{badge}</span> : null}
    </div>
    {meta ? <p className="object-detail-meta">{meta}</p> : null}
  </header>;
}

/** 摘要行：左侧标签、右侧值，最多放三条，超出部分应进主体。 */
export function DetailFacts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return <dl className="object-detail-facts">
    {items.map((item) => <div key={item.label}>
      <dt>{item.label}</dt><dd>{item.value}</dd>
    </div>)}
  </dl>;
}

/** 主体分区：小标题 + 说明 + 内容。 */
export function DetailSection({ title, note, children }: { title: ReactNode; note?: ReactNode; children: ReactNode }) {
  return <section className="object-detail-section">
    <div className="object-detail-section-head">
      <h3>{title}</h3>
      {note ? <span>{note}</span> : null}
    </div>
    {children}
  </section>;
}

/** 默认折叠：检查历史、长日志、源码与设计台账只在这里出现。 */
export function DetailDiagnostics({ label, count, children }: {
  label: ReactNode;
  count?: ReactNode;
  children: ReactNode;
}) {
  return <details className="object-detail-diagnostics">
    <summary>
      <span>{label}</span>
      {count !== undefined ? <span className="object-detail-diagnostics-count">{count}</span> : null}
    </summary>
    <div className="object-detail-diagnostics-body">{children}</div>
  </details>;
}
