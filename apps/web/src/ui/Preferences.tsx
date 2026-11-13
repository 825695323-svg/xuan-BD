import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { uiApi, type UiPreferences } from '../ui-runtime-api';
import { translator, type InterfaceLanguage, type Translate } from './labels';
import lightTheme from './config/codex-theme-v1-light.json';
import darkTheme from './config/codex-theme-v1-dark.json';
import './preferences.css';

export type Preferences = UiPreferences;
export type PreferencePatch = Partial<Omit<Preferences, 'revision' | 'updatedAt'>>;
interface PreferencesContextValue {
  preferences: Preferences;
  locale: InterfaceLanguage;
  sendShortcut: Preferences['sendShortcut'];
  resolvedTheme: 'light' | 'dark';
  t: Translate;
  loading: boolean;
  ready: boolean;
  saving: boolean;
  error: string | null;
  updatePreferences(patch: PreferencePatch): Promise<void>;
  reloadPreferences(): Promise<void>;
}
const initial: Preferences = { revision: 0, theme: 'system', language: 'zh-CN', fontScale: 1,
  sendShortcut: 'enter', modelId: null, thinkingLevel: 'high', updatedAt: '' };
const PreferencesContext = createContext<PreferencesContextValue | null>(null);
export const themeDefinitions = { light: lightTheme, dark: darkTheme };

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(initial);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef<Preferences>(initial);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const live = useRef(false);
  const loaded = useRef(false);
  const resolvedTheme = preferences.theme === 'system' ? (systemDark ? 'dark' : 'light') : preferences.theme;
  const t = useMemo(() => translator(preferences.language), [preferences.language]);

  const reloadPreferences = useCallback(async () => {
    if (pending.current) return;
    if (live.current) setLoading(true);
    try {
      const value = await uiApi.preferences();
      if (!live.current || pending.current) return;
      saved.current = value;
      loaded.current = true;
      setPreferences(value);
      setError(null);
    } catch (failure) {
      if (live.current) setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally {
      if (live.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number) => {
      try { await reloadPreferences(); }
      catch {
        if (!cancelled && attempt < 2) timer = setTimeout(() => void load(attempt + 1), 300 * (attempt + 1));
      }
    };
    void load(0);
    const onFocus = () => { if (!loaded.current && !pending.current) void reloadPreferences().catch(() => undefined); };
    window.addEventListener('focus', onFocus);
    return () => { live.current = false; cancelled = true; clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [reloadPreferences]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const definition = themeDefinitions[resolvedTheme];
    root.dataset.theme = resolvedTheme;
    root.dataset.themePreference = preferences.theme;
    root.lang = preferences.language;
    root.style.colorScheme = resolvedTheme;
    root.style.setProperty('--surface', definition.theme.surface);
    root.style.setProperty('--ink', definition.theme.ink);
    root.style.setProperty('--accent', definition.theme.accent);
    root.style.setProperty('--theme-contrast', String(definition.theme.contrast));
    root.style.setProperty('--diff-added', definition.theme.semanticColors.diffAdded);
    root.style.setProperty('--diff-removed', definition.theme.semanticColors.diffRemoved);
    root.style.setProperty('--skill-color', definition.theme.semanticColors.skill);
    root.style.setProperty('--font-scale', String(preferences.fontScale));
    root.style.fontSize = `${15 * preferences.fontScale}px`;
  }, [preferences.theme, preferences.language, preferences.fontScale, resolvedTheme]);

  const updatePreferences = useCallback((patch: PreferencePatch) => {
    pending.current += 1;
    if (live.current) setSaving(true);
    const operation = queue.current.catch(() => undefined).then(async () => {
      if (!loaded.current) {
        const failure = new Error('Preferences have not been loaded.');
        if (live.current) setError(failure.message);
        throw failure;
      }
      if (live.current) { setPreferences({ ...saved.current, ...patch }); setError(null); }
      try {
        const value = await uiApi.savePreferences({ revision: saved.current.revision, ...patch });
        saved.current = value;
        if (live.current) setPreferences(value);
      } catch (failure) {
        if (live.current) {
          setPreferences(saved.current);
          setError(failure instanceof Error ? failure.message : String(failure));
        }
        throw failure;
      }
    }).finally(() => {
      pending.current -= 1;
      if (live.current && !pending.current) setSaving(false);
    });
    queue.current = operation;
    return operation;
  }, []);

  return <PreferencesContext.Provider value={{ preferences, locale: preferences.language, sendShortcut: preferences.sendShortcut,
    resolvedTheme, t, loading, ready: loaded.current, saving, error, updatePreferences, reloadPreferences }}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('PreferencesProvider is required.');
  return value;
}
