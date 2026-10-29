/**
 * One-line YAML string values for the files the app writes by hand (workspace.yaml, profile front matter).
 * A JSON string is a valid double-quoted YAML scalar, so quotes and backslashes in names stay intact.
 */
export function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

/** Reads a value written by quoteYaml, and the older unescaped `"…"` or `'…'` form. */
export function unquoteYaml(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // An older file with an unescaped quote inside: fall through.
    }
  }
  return value.replace(/^["']|["']$/g, '');
}
