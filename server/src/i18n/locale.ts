/** Pure locale policy shared by hosts. Automatic is a preference, never a resolved language. */
export const languages = { en: 'English', ja: '日本語', 'pt-BR': 'Português (Brasil)', 'es-419': 'Español (Latinoamérica)' } as const;
export type Locale = keyof typeof languages;
export type LanguagePreference = Locale | 'auto';
export function isPreference(value: unknown): value is LanguagePreference {
  return value === 'auto' || (typeof value === 'string' && Object.prototype.hasOwnProperty.call(languages, value));
}
export function detectLocale(preferences: readonly string[]): Locale {
  for (const preference of preferences) {
    try {
      const tag = Intl.getCanonicalLocales(preference)[0];
      if (!tag) continue;
      if (Object.prototype.hasOwnProperty.call(languages, tag)) return tag as Locale;
      const base = tag.split('-')[0];
      const match = (Object.keys(languages) as Locale[]).find(locale => locale.split('-')[0] === base);
      if (match) return match;
    } catch { /* Invalid tags from older hosts are not language preferences. */ }
  }
  return 'en';
}
