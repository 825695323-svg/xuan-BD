import { Monitor, Moon, SlidersHorizontal, Sun } from 'lucide-react';
import { usePreferences } from './Preferences';
import { SelectMenu, useWords } from './Controls';

const themes = [
  { id: 'light' as const, icon: Sun, zh: '浅色', en: 'Light' },
  { id: 'dark' as const, icon: Moon, zh: '深色', en: 'Dark' },
  { id: 'system' as const, icon: Monitor, zh: '跟随系统', en: 'System' },
];

export function SettingsPage() {
  const { t, preferences, updatePreferences, saving, error } = usePreferences();
  const words = useWords();
  return <div className="ui-settings-page">
    <nav className="settings-categories" aria-label={t('nav.settings')}>
      <button type="button" aria-current="page" className="is-selected">
        <SlidersHorizontal size={17} aria-hidden="true"/><span>{t('settings.general')}</span>
      </button>
    </nav>
    <div className="settings-panel"><div className="settings-inner">
      <section className="settings-section">
        <h2 className="settings-section-title">{words('语言', 'Language')}</h2>
        <div className="settings-row">
          <span className="settings-row-label">{words('界面语言', 'Interface language')}</span>
          <div className="settings-row-control">
            <SelectMenu label={words('界面语言', 'Interface language')} value={preferences.language} disabled={saving}
              options={[{ value: 'zh-CN', label: '中文' }, { value: 'en', label: 'English' }]}
              onChange={(value) => void updatePreferences({ language: value }).catch(() => undefined)} />
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h2 className="settings-section-title">{words('外观', 'Appearance')}</h2>
        <div className="theme-options" role="radiogroup" aria-label={words('外观', 'Appearance')}>
          {themes.map(({ id, icon: Icon, zh, en }) => <button key={id} type="button" role="radio" aria-checked={preferences.theme === id}
            className="theme-option" disabled={saving} onClick={() => void updatePreferences({ theme: id }).catch(() => undefined)}>
            <Icon size={20} strokeWidth={1.6} aria-hidden="true" /><span>{words(zh, en)}</span>
          </button>)}
        </div>
      </section>
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div></div>
  </div>;
}

export default SettingsPage;
