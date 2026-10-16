/**
 * Appearance preferences: colour theme, accent hue and text scale.
 *
 * All three are expressed as data attributes on <html>, which index.css reads to
 * redefine its design tokens. Preferences live in localStorage only — they are a
 * per-browser choice, not workspace data, so nothing is written to the workspace.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentName = 'blue' | 'violet' | 'teal' | 'green' | 'amber' | 'rose';
export type TextSize = 'small' | 'default' | 'large';

export const THEME_KEY = 'gtd:theme';
export const ACCENT_KEY = 'gtd:accent';
export const TEXT_SIZE_KEY = 'gtd:text-size';

export const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];
export const TEXT_SIZES: TextSize[] = ['small', 'default', 'large'];

/** Accent hue and chroma, mirroring the `[data-accent]` blocks in index.css. */
export const ACCENTS: Array<{ name: AccentName; label: string; hue: number; chroma: number }> = [
  { name: 'blue',   label: 'Blue',   hue: 255, chroma: 0.11 },
  { name: 'violet', label: 'Violet', hue: 295, chroma: 0.12 },
  { name: 'teal',   label: 'Teal',   hue: 195, chroma: 0.10 },
  { name: 'green',  label: 'Green',  hue: 155, chroma: 0.12 },
  { name: 'amber',  label: 'Amber',  hue: 70,  chroma: 0.13 },
  { name: 'rose',   label: 'Rose',   hue: 15,  chroma: 0.14 },
];

const ACCENT_NAMES = ACCENTS.map(a => a.name);

/** A swatch for the settings picker, readable against either surface. */
export function accentSwatch(name: AccentName): string {
  const accent = ACCENTS.find(a => a.name === name) ?? ACCENTS[0];
  return `oklch(0.58 ${accent.chroma} ${accent.hue})`;
}

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
  } catch {
    // Private mode or blocked storage — fall through to the default.
  }
  return fallback;
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The preference still applies for this session.
  }
}

export function readThemeMode(): ThemeMode {
  return readStored(THEME_KEY, THEME_MODES, 'system');
}

export function readAccent(): AccentName {
  return readStored(ACCENT_KEY, ACCENT_NAMES, 'blue');
}

export function readTextSize(): TextSize {
  return readStored(TEXT_SIZE_KEY, TEXT_SIZES, 'default');
}

export function storeThemeMode(mode: ThemeMode): void {
  writeStored(THEME_KEY, mode);
}

export function storeAccent(accent: AccentName): void {
  writeStored(ACCENT_KEY, accent);
}

export function storeTextSize(size: TextSize): void {
  writeStored(TEXT_SIZE_KEY, size);
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Turn a mode into the theme actually painted, resolving `system`. */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

export function applyAppearance(mode: ThemeMode, accent: AccentName, textSize: TextSize): void {
  const root = document.documentElement;
  root.dataset['theme'] = resolveTheme(mode);
  root.dataset['accent'] = accent;
  root.dataset['textSize'] = textSize;
}

/** Apply what is in localStorage. Called once before React renders. */
export function applyStoredAppearance(): void {
  applyAppearance(readThemeMode(), readAccent(), readTextSize());
}

/**
 * Re-apply when the OS flips between light and dark. Only matters while the mode
 * is `system`; the caller re-subscribes whenever the mode changes.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
