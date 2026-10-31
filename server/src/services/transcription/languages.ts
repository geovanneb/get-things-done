/** The languages a model can be told to transcribe. "Auto" is not one of them: every model detects the language itself. */

export interface LanguageOption {
  id: string;
  label: string;
  /** Listed first, before the rest in alphabetical order. */
  common?: boolean;
}

const names = (ids: string[]) => ids.map((id) => {
  const label = NAMES[id];
  if (!label) throw new Error(`No name for language ${id}`);
  return { id, label };
});

/** The codes are the ones the models use, so Javanese is `jw` and Cantonese `yue`. */
const NAMES: Record<string, string> = {
  af: 'Afrikaans', am: 'Amharic', ar: 'Arabic', as: 'Assamese', az: 'Azerbaijani', ba: 'Bashkir', be: 'Belarusian', bg: 'Bulgarian',
  bn: 'Bengali', bo: 'Tibetan', br: 'Breton', bs: 'Bosnian', ca: 'Catalan', cs: 'Czech', cy: 'Welsh', da: 'Danish', de: 'German',
  el: 'Greek', en: 'English', es: 'Spanish', et: 'Estonian', eu: 'Basque', fa: 'Persian', fi: 'Finnish', fo: 'Faroese', fr: 'French',
  gl: 'Galician', gu: 'Gujarati', ha: 'Hausa', haw: 'Hawaiian', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', ht: 'Haitian Creole',
  hu: 'Hungarian', hy: 'Armenian', id: 'Indonesian', is: 'Icelandic', it: 'Italian', ja: 'Japanese', jw: 'Javanese', ka: 'Georgian',
  kk: 'Kazakh', km: 'Khmer', kn: 'Kannada', ko: 'Korean', la: 'Latin', lb: 'Luxembourgish', ln: 'Lingala', lo: 'Lao', lt: 'Lithuanian',
  lv: 'Latvian', mg: 'Malagasy', mi: 'Maori', mk: 'Macedonian', ml: 'Malayalam', mn: 'Mongolian', mr: 'Marathi', ms: 'Malay', mt: 'Maltese',
  my: 'Burmese', ne: 'Nepali', nl: 'Dutch', nn: 'Norwegian Nynorsk', no: 'Norwegian', oc: 'Occitan', pa: 'Punjabi', pl: 'Polish', ps: 'Pashto',
  pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sa: 'Sanskrit', sd: 'Sindhi', si: 'Sinhala', sk: 'Slovak', sl: 'Slovenian', sn: 'Shona',
  so: 'Somali', sq: 'Albanian', sr: 'Serbian', su: 'Sundanese', sv: 'Swedish', sw: 'Swahili', ta: 'Tamil', te: 'Telugu', tg: 'Tajik', th: 'Thai',
  tk: 'Turkmen', tl: 'Tagalog', tr: 'Turkish', tt: 'Tatar', uk: 'Ukrainian', ur: 'Urdu', uz: 'Uzbek', vi: 'Vietnamese', yi: 'Yiddish',
  yo: 'Yoruba', yue: 'Cantonese', zh: 'Chinese',
};

/** `common` first, in that order, then the others by name. */
function options(common: string[], others: string[]): LanguageOption[] {
  return [
    ...names(common).map((o) => ({ ...o, common: true })),
    ...names(others).sort((a, b) => a.label.localeCompare(b.label)),
  ];
}

const WHISPER_COMMON = ['en', 'ja', 'ko', 'vi'];
export const WHISPER_LANGUAGES = options(WHISPER_COMMON, Object.keys(NAMES).filter((id) => !WHISPER_COMMON.includes(id)));
export const SENSEVOICE_LANGUAGES = options(['en', 'ja', 'ko'], ['zh', 'yue']);

/** From `at` seconds of audio on, this language (`auto` too). A recording's list goes up in time. */
export interface LanguageChange { at: number; language: string }

/** Far more than anyone switches in a meeting: a list this long is something else going wrong. */
export const MAX_LANGUAGE_CHANGES = 200;

/** A language any model has, or `auto`. */
export const knownLanguage = (id: unknown): id is string => id === 'auto' || WHISPER_LANGUAGES.some((l) => l.id === id);

/** The language in force at `seconds` of audio. */
export function languageAt(start: string, changes: readonly LanguageChange[], seconds: number): string {
  let language = start;
  for (const change of changes) if (change.at <= seconds) language = change.language;
  return language;
}

/** The list after one more change: two at the same moment are one, the latest, and a change to the same language is none. */
export function withLanguageChange(start: string, changes: readonly LanguageChange[], change: LanguageChange): LanguageChange[] {
  const before = changes.filter((c) => c.at < change.at);
  return languageAt(start, before, change.at) === change.language ? before : [...before, change];
}

/** A list as saved in a manifest, only when all of it is sound. */
export function parseLanguageChanges(value: unknown): LanguageChange[] | null {
  if (!Array.isArray(value) || value.length > MAX_LANGUAGE_CHANGES) return null;
  let last = -1;
  const changes: LanguageChange[] = [];
  for (const item of value as unknown[]) {
    const { at, language } = (item ?? {}) as Partial<LanguageChange>;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at <= last || !knownLanguage(language)) return null;
    last = at;
    changes.push({ at, language });
  }
  return changes;
}
