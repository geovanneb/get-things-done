/**
 * Workspace files are written by people and agents as well as by the app, and request bodies are not typed at
 * runtime. These read a value in the shape the rest of the app relies on, and refuse a request that sends another.
 */

/** A list of text: a list keeps its text items, one text value is a list of one, anything else is empty. */
export function textList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return typeof value === 'string' && value.trim() ? [value] : [];
}

/** A one-line value as text: `title: 2026` in YAML is a number, and a title is still "2026". Empty when there is none. */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** Refuses (400) a request whose named fields are present and not text. `null` and a missing field are left to the caller. */
export function requireText(body: unknown, fields: readonly string[]): void {
  if (!body || typeof body !== 'object') return;
  for (const field of fields) {
    const value = (body as Record<string, unknown>)[field];
    if (value !== undefined && value !== null && typeof value !== 'string') throw badRequest(`Invalid ${field}: it must be text.`);
  }
}

/** Refuses (400) a request whose named fields are present and not lists. */
export function requireList(body: unknown, fields: readonly string[]): void {
  if (!body || typeof body !== 'object') return;
  for (const field of fields) {
    const value = (body as Record<string, unknown>)[field];
    if (value !== undefined && value !== null && !Array.isArray(value)) throw badRequest(`Invalid ${field}: it must be a list.`);
  }
}
