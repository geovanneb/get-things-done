/**
 * Suggests the spoken language during a recording, from the language the live model detected in each part.
 *
 * One part can be wrong (a short remark, a name), so a suggestion needs a run of parts: measured with SenseVoice,
 * which reports the real language of a part even when another one is set. Two cases:
 * - A language is set and a run of parts sounds like another one: "This sounds like Japanese", switching from where
 *   that run started, so what was already said is transcribed in it after the meeting too.
 * - Auto, and nearly all speech is one language: "Most speech sounds like Japanese", setting it from now on.
 * Pure: the live job feeds it parts and tells it about changes; it holds no audio and no text.
 */

/** A part the live model decoded: where its speech is (without the context around it) and what it sounded like. */
export interface HeardPart { start: number; end: number; detected: string | null }

export interface Suggestion {
  id: string;
  language: string;
  /** `mismatch`: switch from `since`. `auto`: set it from now on. */
  mode: 'mismatch' | 'auto';
  /** Seconds of audio where the run in `language` started; for `auto`, the end of the evidence. */
  since: number;
}

/** A run counts from three parts and 8 seconds of speech, or from two long parts. */
const RUN_PARTS = 3;
const RUN_SECONDS = 8;
const LONG_RUN_PARTS = 2;
const LONG_RUN_SECONDS = 20;
/** A pause this long ends a run, and a suggestion with it: the next speech may be someone else, or something else. */
const RUN_GAP_SECONDS = 30;
/** In Auto: the first two minutes of speech are judged once, then each complete five minutes. */
const AUTO_FIRST_SECONDS = 120;
const AUTO_WINDOW_SECONDS = 300;
const AUTO_SHARE = 0.9;
/** In Auto, the latest speech must agree: a suggestion is never made, or kept, while another language is spoken. */
const AUTO_RECENT_SECONDS = 20;
const AUTO_RECENT_SHARE = 0.8;

/** A part of speech in Auto, placed on the time line of speech alone (`from`, `to`), and where it ends in the audio. */
interface Heard { from: number; to: number; language: string | null; end: number }

export class LanguageEvidence {
  private run: { language: string; start: number; end: number; parts: number; seconds: number } | null = null;
  /** In Auto: speech since the last change, newest last, kept to the longest window. */
  private heard: Heard[] = [];
  /** Seconds of speech heard since the last change, and where the next window to judge ends. */
  private total = 0;
  private nextJudged = AUTO_FIRST_SECONDS;
  private muted = new Set<string>();
  private current: Suggestion | null = null;
  private counter = 0;

  /**
   * `supported`: whether the model that transcribes after the meeting has the language; asked again for each part,
   * so a change in Settings counts. `id`: a fresh id for each suggestion, so an answer refers to the one shown.
   */
  constructor(private readonly supported: (language: string) => boolean, private readonly id: () => string = () => String(++this.counter)) {}

  get suggestion(): Suggestion | null {
    return this.current;
  }

  /**
   * A decoded part, with the language asked for at its start (`auto` or a code). Returns the suggestion, which may
   * be new, unchanged or gone (null).
   */
  add(part: HeardPart, asked: string): Suggestion | null {
    const seconds = Math.max(0, part.end - part.start);
    if (!Number.isFinite(seconds) || seconds === 0) return this.current;
    if (this.current && !this.supported(this.current.language)) this.current = null;
    if (asked === 'auto') return this.addAuto(part, seconds);
    // A part in the set language, or one without a detection, ends the run; and the suggestion it made goes.
    if (!part.detected || part.detected === asked) {
      this.run = null;
      if (this.current?.mode === 'mismatch') this.current = null;
      return this.current;
    }
    const continues = this.run && this.run.language === part.detected && part.start - this.run.end <= RUN_GAP_SECONDS;
    if (!continues && this.current?.mode === 'mismatch') this.current = null;
    this.run = continues
      ? { ...this.run!, end: part.end, parts: this.run!.parts + 1, seconds: this.run!.seconds + seconds }
      : { language: part.detected, start: part.start, end: part.end, parts: 1, seconds };
    const { language, parts, seconds: heard, start } = this.run;
    const enough = (parts >= RUN_PARTS && heard >= RUN_SECONDS) || (parts >= LONG_RUN_PARTS && heard >= LONG_RUN_SECONDS);
    if (!this.current && enough && !this.muted.has(language) && this.supported(language)) {
      this.current = { id: this.id(), language, mode: 'mismatch', since: start };
    }
    return this.current;
  }

  /** Share of `language` in the stretch of speech from `from` to `to` (a part on an edge counts for its part inside). */
  private share(language: string | null, from: number, to: number): number {
    let of = 0;
    for (const h of this.heard) {
      if (h.language !== language) continue;
      of += Math.max(0, Math.min(to, h.to) - Math.max(from, h.from));
    }
    return to > from ? of / (to - from) : 0;
  }

  /** The language of at least `needed` of the speech from `from` to `to`; unknown speech counts against all. */
  private clear(from: number, to: number, needed: number): string | null {
    const languages = new Set(this.heard.map((h) => h.language).filter((l): l is string => Boolean(l)));
    for (const language of languages) if (this.share(language, from, to) >= needed) return language;
    return null;
  }

  private addAuto(part: HeardPart, seconds: number): Suggestion | null {
    this.heard.push({ from: this.total, to: this.total + seconds, language: part.detected, end: part.end });
    this.total += seconds;
    // Enough to judge the latest window and the recent speech; older parts go.
    while (this.heard.length > 1 && this.heard[0]!.to < this.total - AUTO_WINDOW_SECONDS - AUTO_FIRST_SECONDS) this.heard.shift();
    const recent = (language: string) => this.share(language, Math.max(0, this.total - AUTO_RECENT_SECONDS), this.total) >= AUTO_RECENT_SHARE;
    // A suggestion stays only while what is said now agrees with it.
    if (this.current?.mode === 'auto' && !recent(this.current.language)) this.current = null;
    // Exactly the first two minutes of speech, then each complete five minutes after them, also when a part crosses
    // the mark.
    let candidate: string | null = null;
    while (this.total >= this.nextJudged) {
      const to = this.nextJudged;
      const from = to === AUTO_FIRST_SECONDS ? 0 : to - AUTO_WINDOW_SECONDS;
      candidate = this.clear(from, to, AUTO_SHARE);
      this.nextJudged = to + AUTO_WINDOW_SECONDS;
    }
    if (!this.current && candidate && recent(candidate) && !this.muted.has(candidate) && this.supported(candidate)) {
      this.current = { id: this.id(), language: candidate, mode: 'auto', since: part.end };
    }
    return this.current;
  }

  /**
   * Time passed with no part (silence, or no audio): a run, and the suggestion it made, end after a long pause, so
   * a Switch never reaches back to speech from long ago. `now` is seconds of audio read.
   */
  expire(now: number): Suggestion | null {
    if (this.run && now - this.run.end > RUN_GAP_SECONDS) {
      this.run = null;
      if (this.current?.mode === 'mismatch') this.current = null;
    }
    const last = this.heard.at(-1);
    if (this.current?.mode === 'auto' && (!last || now - last.end > RUN_GAP_SECONDS)) this.current = null;
    return this.current;
  }

  /** "Keep": this language is not offered again in this recording. */
  keep(id: string): boolean {
    if (this.current?.id !== id) return false;
    this.muted.add(this.current.language);
    this.current = null;
    this.run = null;
    return true;
  }

  /** The language changed (by hand or by a switch): evidence from before it says nothing about what is set now. */
  reset(): void {
    this.current = null;
    this.run = null;
    this.heard = [];
    this.total = 0;
    this.nextJudged = AUTO_FIRST_SECONDS;
  }
}

/** A detected language as the model reports it (`<|ja|>` from SenseVoice, `ja` from Whisper) as a plain code. */
export function detectedLanguage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/^<\|/, '').replace(/\|>$/, '').trim().toLowerCase();
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}
