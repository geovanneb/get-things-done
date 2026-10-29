// Where a link or navigation from the dashboard may go. Kept free of Electron imports so it can be tested with plain Node.

export type LinkDecision =
  /** Same server: stay in the app (a new window for target="_blank", e.g. an attachment preview). */
  | 'app'
  /** Web page or e-mail: hand it to the system browser or mail app. */
  | 'external'
  /** Anything else (file:, javascript:, custom schemes): ignore it. */
  | 'block';

export function classifyLink(url: string, appOrigin: string): LinkDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'block';
  }
  if (parsed.origin === appOrigin) return 'app';
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') return 'external';
  return 'block';
}
