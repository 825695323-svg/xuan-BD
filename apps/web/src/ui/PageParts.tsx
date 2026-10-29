import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePreferences } from './Preferences';

export function useRemote<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(false);
  const refresh = useCallback(async () => {
    if (live.current) { setLoading(true); setError(null); }
    try { const next = await load(); if (live.current) setValue(next); }
    catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (live.current) setLoading(false); }
  }, [load]);
  useEffect(() => { live.current = true; void refresh(); return () => { live.current = false; }; }, [refresh]);
  return { value, loading, error, refresh };
}

export function ErrorNotice({ error, message }: { error: string | null; message?: string }) {
  const { t } = usePreferences();
  if (!error) return null;
  return <div className="ui-error" role="alert"><p>{message ?? t('common.error')}</p>
    <details><summary>{t('common.errorDetails')}</summary><p>{error}</p></details></div>;
}

export function Section({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return <section className="settings-group"><h2>{title}</h2>{note && <p className="ui-muted group-note">{note}</p>}{children}</section>;
}

export function Field({ label, children, note, htmlFor }: { label: string; children: ReactNode; note?: string; htmlFor?: string }) {
  return <div className="settings-row"><div className="settings-row-label">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
    {note && <p className="ui-muted">{note}</p>}</div><div className="settings-row-control">{children}</div></div>;
}

export function KeyValues({ entries }: { entries: Array<[string, ReactNode]> }) {
  return <dl className="ui-key-values">{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>;
}

export function JsonDetails({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  return <details className="ui-json-details" open={open || undefined}><summary>{title}</summary>
    <pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre></details>;
}

export function ReferenceActions({ reference, onBring, note }: { reference: string; onBring: () => void; note?: string }) {
  const { t } = usePreferences();
  const [notice, setNotice] = useState<string | null>(null);
  return <div className="ui-reference-actions"><div className="ui-action-row">
    <button type="button" className="ui-primary" onClick={onBring}>{t('common.bring')}</button>
    <button type="button" onClick={() => void navigator.clipboard.writeText(reference).then(() => setNotice(t('common.copied')),
      () => setNotice(t('common.copyFailed')))}>{t('common.copy')}</button></div>
    <p className="ui-muted">{notice ?? note ?? t('common.referenceOnly')}</p></div>;
}
