import matter from 'gray-matter';
import yaml from 'js-yaml';

/**
 * YAML's default schema turns an unquoted day (`review_date: 2026-11-20`) into a Date at UTC midnight, which a save
 * then writes back as `2026-11-20T00:00:00.000Z`. Here a plain day (YYYY-MM-DD, no time part) in a date field stays
 * the text written, also with an explicit `!!timestamp` tag; a save quotes it, so it stays a day. Timestamp fields
 * (any key ending in `_at`) and every value with a time part still read as a Date exactly as before. Only the
 * timestamp type is replaced: the rest of the default safe schema (merge keys, `!!binary`, `!!set`, `!!omap`,
 * `!!pairs`) is unchanged.
 */
const TIMESTAMP = 'tag:yaml.org,2002:timestamp';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A plain day the YAML resolved as a timestamp, until its key decides what it becomes. Never leaves this module. */
class UnquotedDay {
  constructor(readonly day: string) {}
  // A day used as a mapping key is its text (js-yaml turns a key whose tag is plain Object into '[object Object]').
  get [Symbol.toStringTag](): string { return 'UnquotedDay'; }
  toString(): string { return this.day; }
}
// js-yaml 3 has no public handle on its timestamp type; reuse it so values with a time part read exactly as before.
const yamlTimestamp = (yaml.DEFAULT_SAFE_SCHEMA as unknown as { compiledImplicit?: Array<yaml.Type & { tag: string }> })
  .compiledImplicit?.find((t) => t.tag === TIMESTAMP);
if (!yamlTimestamp) throw new Error('js-yaml has no timestamp type to replace');
const dayAsText = new yaml.Type(TIMESTAMP, {
  kind: 'scalar',
  resolve: (data: unknown) => yamlTimestamp.resolve(data),
  construct: (data: string) => (DAY.test(data) ? new UnquotedDay(data) : yamlTimestamp.construct(data)),
});
const schema = new yaml.Schema({ include: [yaml.DEFAULT_SAFE_SCHEMA], implicit: [dayAsText] });

const options = {
  engines: {
    javascript: () => { throw new Error('Invalid frontmatter: executable languages are not supported'); },
    yaml: {
      parse: (str: string) => settleDays(yaml.safeLoad(str, { schema }), '', new Set()) as object,
      stringify: (data: object, opts?: yaml.DumpOptions) => yaml.safeDump(data, opts),
    },
  },
};

/**
 * Each unquoted day becomes what it was before in a timestamp field (`created_at`, `updated_at`, any `*_at`: the Date at
 * UTC midnight, so version tokens and validation are unchanged) and the day text everywhere else. In place, front
 * matter only; shared YAML anchors are visited once.
 */
function settleDays(value: unknown, key: string, seen: Set<object>): unknown {
  if (value instanceof UnquotedDay) return key.endsWith('_at') ? yamlTimestamp!.construct(value.day) : value.day;
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  if (Array.isArray(value)) {
    seen.add(value);
    for (let i = 0; i < value.length; i++) value[i] = settleDays(value[i], key, seen);
  } else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const k of Object.keys(record)) record[k] = settleDays(record[k], k, seen);
  }
  return value;
}

/** Explicit options disable gray-matter's unbounded content cache and its executable JS engine (including js aliases). */
export function parseMarkdown(raw: string) {
  return matter(raw, options);
}

export function stringifyMarkdown(content: string, data: Record<string, unknown>): string {
  return matter.stringify(content, data, options);
}
