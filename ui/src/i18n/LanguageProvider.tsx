import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { detectLocale, isPreference, type LanguagePreference, type Locale } from '../../../server/src/i18n/locale';
import { en } from '../../../server/src/i18n/en';
import { loadCatalog, translator, type Translate } from '../../../server/src/i18n/messages';
import { apiGet, apiPut } from '../utils/api';
import { desktopBridge } from '../utils/desktop';
import { setCurrentLanguage } from './current';

interface LanguageState {
  locale: Locale;
  detected: Locale;
  preference: LanguagePreference;
  t: Translate;
  loading: boolean;
  saving: boolean;
  error: 'load' | 'save' | null;
  refresh(): void;
  change(value: LanguagePreference): Promise<void>;
}
const LanguageContext = createContext<LanguageState>({ locale: 'en', detected: 'en', preference: 'auto', t: translator(en), loading: true, saving: false, error: null, refresh() {}, async change() {} });
export const useLanguage = () => useContext(LanguageContext);

async function preferredLanguages(): Promise<readonly string[]> {
  try {
    const native = await desktopBridge()?.preferredLanguages?.();
    if (Array.isArray(native) && native.length && native.every(value => typeof value === 'string')) return native;
  } catch { /* An older desktop bridge can still use browser detection. */ }
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/** Personal setting lives on the server; a window resolves Automatic using its own host. */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<LanguageState, 'refresh' | 'change'>>({ locale: 'en', detected: 'en', preference: 'auto', t: translator(en), loading: true, saving: false, error: null });
  const revision = useRef(0);
  const live = useRef(false);
  const saving = useRef(false);
  const apply = useCallback(async (preference: LanguagePreference, request: number) => {
    const detected = detectLocale(await preferredLanguages());
    const locale = preference === 'auto' ? detected : preference;
    const catalog = await loadCatalog(locale);
    if (!live.current || request !== revision.current) return;
    document.documentElement.lang = locale;
    const t = translator(catalog, locale);
    setCurrentLanguage(t, locale);
    setState(current => current.locale === locale && current.detected === detected && current.preference === preference && !current.loading && !current.saving && !current.error
      ? current : { locale, detected, preference, t, loading: false, saving: false, error: null });
  }, []);
  const refresh = useCallback(async () => {
    if (saving.current) return;
    const request = ++revision.current;
    try {
      const response = await apiGet<{ language: unknown }>('/api/app/language');
      if (!isPreference(response.language)) throw new Error('Invalid language preference');
      await apply(response.language, request);
    } catch {
      if (live.current && request === revision.current) setState(current => ({ ...current, loading: false, error: 'load' }));
    }
  }, [apply]);
  const change = useCallback(async (preference: LanguagePreference) => {
    if (saving.current || !isPreference(preference)) return;
    saving.current = true;
    const request = ++revision.current;
    setState(current => ({ ...current, saving: true, error: null }));
    try {
      // Ensure the catalog is available before committing the preference.
      await loadCatalog(preference === 'auto' ? detectLocale(await preferredLanguages()) : preference);
      const response = await apiPut<{ language: unknown }>('/api/app/language', { language: preference });
      if (!isPreference(response.language)) throw new Error('Invalid language preference');
      await apply(response.language, request);
    } catch {
      if (live.current && request === revision.current) setState(current => ({ ...current, saving: false, error: 'save' }));
    } finally { saving.current = false; }
  }, [apply]);
  useEffect(() => {
    live.current = true;
    void refresh();
    const refreshVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', refreshVisible);
    window.addEventListener('languagechange', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    // Different browser ports and the desktop utility process do not share localStorage or SSE.
    const timer = window.setInterval(refreshVisible, 15_000);
    const invalidate = () => { revision.current++; };
    return () => {
      live.current = false;
      invalidate();
      clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      window.removeEventListener('languagechange', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [refresh]);
  return <LanguageContext.Provider value={{ ...state, refresh, change }}>{children}</LanguageContext.Provider>;
}
