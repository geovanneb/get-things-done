import { en } from '../../../server/src/i18n/en';
import { translator, type Translate } from '../../../server/src/i18n/messages';
import type { Locale } from '../../../server/src/i18n/locale';

let active: Translate = translator(en);
let activeLocale: Locale = 'en';

/** For code outside React (helpers, labels built on demand). Components use `useLanguage`, which also re-renders them. */
export const tr = ((...args: unknown[]) => (active as unknown as (...values: unknown[]) => string)(...args)) as unknown as Translate;
export const currentLocale = (): Locale => activeLocale;
/** "a, b and c" in the interface language. Not in this TypeScript target's library, but in every supported browser. */
export function listText(items: string[], locale: Locale = activeLocale): string {
  const { ListFormat } = Intl as unknown as { ListFormat: new (locale: string, options: { style: string; type: string }) => { format(list: string[]): string } };
  return new ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
}

export function setCurrentLanguage(t: Translate, locale: Locale): void {
  active = t;
  activeLocale = locale;
}
