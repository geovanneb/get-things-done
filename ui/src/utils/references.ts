/**
 * References to workspace items in Markdown the assistant wrote: bare ids (`TASK-2026-0001`, `STK-0001`) and
 * workspace paths (`tasks/active/TASK-2026-0001/task.md`, `context/risks/x/note.md`), in plain text or inline code.
 * `remarkReferences` turns them into links the renderer shows as chips; the server says where each one opens
 * (POST /api/mentions/resolve), and `referenceResolver` batches and caches those requests.
 *
 * Only the Markdown tree is changed, never the text: fenced code, existing links and anything that is not a known
 * id or a safe path under a known workspace folder stay as written.
 */

/** The ids the dashboard opens by themselves (the formats in the workspace schemas). */
export const REFERENCE_ID = /^(?:TASK-\d{4}-\d{4}|STK-\d{4}|GRP-\d{4}|ORG-\d{4}|CU-\d{4}-\d{4}(?:-M-\d{2,3})?|MQ-\d{4}-\d{4}|RT-\d{4}|CTX-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
/** The workspace folders a path may point into: the same list the server accepts. */
export const REFERENCE_ROOTS = ['tasks', 'context', 'stakeholders', 'outputs', 'meetings', 'context-updates', 'routines'];
/** The server resolves at most this many references in one request. */
export const RESOLVE_BATCH = 50;

const ID_SOURCE = 'TASK-\\d{4}-\\d{4}|STK-\\d{4}|GRP-\\d{4}|ORG-\\d{4}|CU-\\d{4}-\\d{4}(?:-M-\\d{2,3})?|MQ-\\d{4}-\\d{4}|RT-\\d{4}|CTX-[a-z0-9]+(?:-[a-z0-9]+)*';
// A path: a known root, then anything up to a space, a bracket, a quote or Japanese punctuation. Only at the start of
// the text or after a space, an opening bracket or quote, emphasis or other script: never when it continues a longer
// path or address (`/Users/x/tasks/…`, `~/tasks/…`, `https://x/tasks/…`, `../tasks/…`). An id: not inside a longer
// word, id or path.
const TOKEN = new RegExp(
  `(?<=^|[\\s(\\[{"'\`*_>]|[\\u0080-\\uffff])(\\/?(?:context-updates|${REFERENCE_ROOTS.filter((r) => r !== 'context-updates').join('|')})\\/[^\\s<>()[\\]{}"'\`|、。，．！？：；「」『』（）【】]+)`
  + `|(?<![\\w\\-/.])(${ID_SOURCE})(?![\\w\\-/])`,
  'g',
);

/**
 * A workspace path as written in text, made clean: punctuation that ends the sentence is not part of it, and Japanese
 * text right after a file name (`note.mdを参照`) or an id folder is not either. Null when it is not a path the app may
 * follow: `..` or `.` segments, empty segments, a backslash or colon, or not under a known root.
 */
export function cleanPath(raw: string): string | null {
  let text = raw.replace(/[.,;:!?]+$/, '');
  const slash = text.lastIndexOf('/');
  const last = text.slice(slash + 1);
  // Other script right after a file's extension (`報告.mdを参照`), with no further dot, is the sentence going on.
  const named = /^(.+\.[A-Za-z0-9]{1,6})[\u0080-\uffff][^.]*$/.exec(last);
  // So is other script right after an id folder (`TASK-2026-0001にあります`).
  const folder = /^([\x21-\x7e]+?)[\u0080-\uffff]/.exec(last);
  if (named) text = text.slice(0, slash + 1) + named[1];
  else if (folder && REFERENCE_ID.test(folder[1]!)) text = text.slice(0, slash + 1) + folder[1];
  text = text.replace(/[.,;:!?]+$/, '');
  return safePath(text);
}

/** The path without its leading or trailing slash, or null when it is not one the app may follow. */
export function safePath(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!text || text.length > 500 || /[\\:\u0000-\u001f\u007f]/.test(text)) return null;
  const parts = text.replace(/^\//, '').replace(/\/$/, '').split('/');
  if (parts.length < 2 || parts.some((p) => !p || p === '.' || p === '..')) return null;
  if (!REFERENCE_ROOTS.includes(parts[0]!)) return null;
  return parts.join('/');
}

/** A whole code span that is one reference, as the reference itself, or null. */
export function wholeReference(value: string): string | null {
  const text = value.trim();
  if (REFERENCE_ID.test(text)) return text;
  // The code span marks where the path ends, so a file name may have spaces in it (`…/Board brief.pdf`).
  return safePath(text);
}

export interface TextPart {
  text: string;
  /** The id or workspace path (no leading slash) this part refers to. */
  ref?: string;
}

/** Whether a position is inside a URL-like word: one with a scheme (`x://`) or starting with `www.`. */
function inAddress(text: string, at: number): boolean {
  let from = at;
  while (from > 0 && !/\s/.test(text[from - 1]!)) from--;
  const word = text.slice(from, at);
  return /[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word) || /^[(<"']?www\./i.test(word);
}

/** A run of text split into plain parts and references, in order; joined back it is the same text. */
export function splitReferences(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index!;
    // Nothing inside an address that was not autolinked (`ftp://host/?item=STK-0001`, `www.example.test/STK-0001`).
    if (inAddress(text, start)) continue;
    let token = m[0];
    let ref: string | null;
    if (m[1]) {
      ref = cleanPath(token);
      if (ref) token = token.slice(0, token.indexOf(ref) + ref.length);
    } else {
      ref = token;
    }
    if (!ref) continue;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: token, ref });
    at = start + token.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/**
 * Whether an in-app address opens as a dialog over the page (a task, a context note): the chat steps aside for it,
 * since a dialog takes the keyboard and the pointer, and comes back when the dialog closes.
 */
export function opensDialog(route: string): boolean {
  return route.startsWith('/board/task/') || /^\/context\?(.*&)?note=/.test(route);
}

/** The reference a link's href names (Markdown links reach the renderer percent-encoded). */
export function hrefReference(href: string): string | null {
  let text: string;
  try { text = decodeURIComponent(href); } catch { return null; }
  const bare = text.replace(/^\//, '');
  return REFERENCE_ID.test(bare) ? bare : safePath(text);
}

// The few Markdown tree shapes this step reads and writes (mdast).
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdNode[];
  data?: { hProperties?: Record<string, string> };
}

/** The link node for one reference: its text (or code) stays as written; the chip comes from the renderer. */
function referenceLink(ref: string, child: MdNode): MdNode {
  // The address is only a placeholder: the chip opens what the workspace confirms for `data-reference`.
  return { type: 'link', url: `/${ref}`, title: null, children: [child], data: { hProperties: { dataReference: ref } } };
}

// Nodes whose text is never linked: links already, and definitions. Fenced code and HTML have no children.
const SKIP = new Set(['link', 'linkReference', 'definition', 'footnoteDefinition']);

function linkify(node: MdNode): void {
  if (!node.children || SKIP.has(node.type)) return;
  const out: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && child.value) {
      for (const part of splitReferences(child.value)) {
        const text: MdNode = { type: 'text', value: part.text };
        out.push(part.ref ? referenceLink(part.ref, text) : text);
      }
    } else if (child.type === 'inlineCode' && child.value) {
      const ref = wholeReference(child.value);
      out.push(ref ? referenceLink(ref, child) : child);
    } else {
      linkify(child);
      out.push(child);
    }
  }
  node.children = out;
}

/** Remark plugin: workspace ids and paths in text and inline code become reference links (`data-reference`). */
export function remarkReferences() {
  return (tree: unknown) => linkify(tree as MdNode);
}

export interface ReferenceTarget {
  exists: boolean;
  route: string | null;
  label?: string;
  type?: 'stakeholder' | 'context' | 'template' | 'task' | 'meeting';
}

type Post = (path: string, body: unknown) => Promise<{ targets?: Record<string, ReferenceTarget> }>;

/**
 * Where references open, asked of the server in batches: every reference asked for in the same tick goes in one
 * request (at most RESOLVE_BATCH each), and an answer is reused for `ttlMs`. A failed request answers null and is
 * asked again next time. Expired answers are dropped as new ones are asked for; `invalidate` drops them all (the
 * workspace changed, or the window came back into view).
 */
export function referenceResolver(post: Post, options: { ttlMs?: number; now?: () => number; schedule?: (run: () => void) => void } = {}) {
  const ttl = options.ttlMs ?? 15_000;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run) => { setTimeout(run, 0); });
  const cache = new Map<string, { at: number; answer: Promise<ReferenceTarget | null> }>();
  let waiting = new Map<string, (target: ReferenceTarget | null) => void>();

  const prune = () => {
    const at = now();
    for (const [ref, hit] of cache) if (at - hit.at >= ttl) cache.delete(ref);
  };

  const flush = () => {
    const batch = waiting;
    waiting = new Map();
    prune();
    const refs = [...batch.keys()];
    for (let i = 0; i < refs.length; i += RESOLVE_BATCH) {
      const chunk = refs.slice(i, i + RESOLVE_BATCH);
      post('/api/mentions/resolve', { refs: chunk }).then(
        (res) => chunk.forEach((ref) => batch.get(ref)!(res?.targets?.[ref] ?? null)),
        () => chunk.forEach((ref) => { cache.delete(ref); batch.get(ref)!(null); }),
      );
    }
  };

  const resolve = (ref: string): Promise<ReferenceTarget | null> => {
    const hit = cache.get(ref);
    if (hit && now() - hit.at < ttl) return hit.answer;
    const answer = new Promise<ReferenceTarget | null>((done) => {
      if (!waiting.size) schedule(flush);
      waiting.set(ref, done);
    });
    cache.set(ref, { at: now(), answer });
    return answer;
  };
  return Object.assign(resolve, {
    invalidate: () => cache.clear(),
    /** How many answers are kept (for tests). */
    size: () => cache.size,
  });
}
