import { en } from './en';
import type { Locale } from './locale';

export type MessageKey = keyof typeof en;
export type PluralMessage = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Catalog = { [K in MessageKey]: (typeof en)[K] extends string ? string : PluralMessage };
type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;
export type Arguments<K extends MessageKey> = (typeof en)[K] extends string
  ? [Placeholders<(typeof en)[K] & string>] extends [never] ? [] : [Record<Placeholders<(typeof en)[K] & string>, string | number | null | undefined>]
  : (typeof en)[K] extends { other: infer Other extends string } ? [{ count: number } & Record<Exclude<Placeholders<Other>, 'count'>, string | number | null | undefined>] : never;
export type PlainMessageKey = { [K in MessageKey]: Arguments<K> extends [] ? K : never }[MessageKey];
export type Translate = <K extends MessageKey>(key: K, ...args: Arguments<K>) => string;

/** Named interpolation and whole plural forms only, not an ICU parser. React escapes the returned text. */
export function translator(catalog: Catalog, locale: Locale = 'en'): Translate {
  return ((key: MessageKey, values: Record<string, string | number | null | undefined> = {}) => {
    const message = catalog[key] || en[key];
    const text = typeof message === 'string' ? message : plural(locale, Number(values.count), message);
    return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? '') : placeholder);
  }) as Translate;
}

/** Whole plural messages, selected using the locale's rules (no English singular assumptions). */
export function plural(locale: Locale, count: number, forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }): string {
  return (forms[new Intl.PluralRules(locale).select(count)] ?? forms.other).split('{count}').join(new Intl.NumberFormat(locale).format(count));
}

export async function loadCatalog(locale: Locale): Promise<Catalog> {
  switch (locale) {
    case 'ja': return (await import('./ja')).default;
    case 'pt-BR': return (await import('./pt-BR')).default;
    case 'es-419': return (await import('./es-419')).default;
    default: return en;
  }
}
