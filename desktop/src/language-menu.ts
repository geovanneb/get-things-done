// The language menu a page may show in the menu bar during a recording, checked before the main process uses it.
// Kept apart from bridge.ts, which needs Electron, so it can be tested on its own.

/** A spoken language the live transcript suggests: an opaque id to answer with, a code and a name to show. */
export interface SuggestedLanguage { id: string; language: string; label: string; mode: 'mismatch' | 'auto' }

/** The language menu a page may show in the menu bar: short lists of plain language codes and names, nothing else. */
export interface SpokenLanguageMenu { current: string; options: { id: string; label: string }[]; suggested?: SuggestedLanguage }

export function parseLanguageMenu(value: unknown): SpokenLanguageMenu | null {
  const { current, options, suggested } = (value ?? {}) as Partial<SpokenLanguageMenu>;
  const code = (id: unknown): id is string => typeof id === 'string' && /^[a-z]{2,4}$/.test(id);
  // Plain text for the menu and the notification: no control characters.
  const plain = (text: string) => [...text].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
  const label = (text: unknown): text is string => typeof text === 'string' && text.length > 0 && text.length <= 40 && plain(text);
  if (!code(current) || !Array.isArray(options) || options.length > 12) return null;
  if (!options.every((o) => code(o?.id) && label(o.label))) return null;
  // A suggestion that does not read as one is left out; the menu itself still shows.
  const offer = suggested && typeof suggested.id === 'string' && /^[\w-]{1,64}$/.test(suggested.id) && code(suggested.language) && suggested.language !== 'auto' && label(suggested.label)
    && (suggested.mode === 'mismatch' || suggested.mode === 'auto')
    ? { id: suggested.id, language: suggested.language, label: suggested.label, mode: suggested.mode } : undefined;
  return { current, options: options.map(({ id, label }) => ({ id, label })), ...(offer ? { suggested: offer } : {}) };
}
