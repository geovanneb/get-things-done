import { useLanguage } from '@/i18n/LanguageProvider';
import { createContext, isValidElement, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate } from 'react-router-dom';
import MentionIcon from './MentionIcon';
import type { MentionType } from './MentionIcon';
import { usePageApi } from '@/hooks/usePageApi';
import { apiFor } from '@/utils/api';
import { useAppState } from '@/store';
import { REFERENCE_ID, hrefReference, referenceResolver, remarkReferences, type ReferenceTarget } from '@/utils/references';

function mentionType(href: string): MentionType | null {
  const h = href.replace(/^\//, '');
  if (h.startsWith('stakeholders/')) return 'stakeholder';
  if (h.startsWith('context/') || h.startsWith('context-updates/')) return 'context';
  if (h.startsWith('outputs/')) return 'template';
  if (h.startsWith('tasks/') || h.startsWith('routines/') || h.startsWith('TASK-') || h.startsWith('RT-')) return 'task';
  if (h.startsWith('meetings/') || h.startsWith('MQ-') || /^CU-.*-M-\d+$/.test(h)) return 'meeting';
  if (h.startsWith('STK-') || h.startsWith('GRP-') || h.startsWith('ORG-')) return 'stakeholder';
  if (h.startsWith('CTX-')) return 'context';
  if (h.startsWith('CU-')) return 'context';
  return null;
}

// Chips ask through one resolver per workspace, so every chip on the page shares its batches and answers, and an
// answer from one workspace is never shown in another. Requests carry that workspace, so the server refuses them
// once another one is open instead of answering for it.
const resolvers = new Map<string, ReturnType<typeof referenceResolver>>();
function resolverFor(workspace: string) {
  let resolve = resolvers.get(workspace);
  if (!resolve) {
    const api = apiFor(workspace);
    resolve = referenceResolver((path, body) => api.post(path, body));
    resolvers.set(workspace, resolve);
  }
  return resolve;
}

// Answers are asked again when the window comes back into view, and when the workspace's files change (the live
// data versions): a chip for a file deleted meanwhile then shows it.
let epoch = 0;
const listeners = new Set<() => void>();
function refreshAll() {
  for (const r of resolvers.values()) r.invalidate();
  epoch += 1;
  listeners.forEach((l) => l());
}
let watching = false;
function subscribe(listener: () => void) {
  if (!watching && typeof window !== 'undefined') {
    watching = true;
    window.addEventListener('focus', refreshAll);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshAll(); });
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const seenVersions = new Map<string, string>();

function useTarget(ref: string, active: boolean): { answered: boolean; target: ReferenceTarget | null } {
  const api = usePageApi();
  const { workspace, dataVersions } = useAppState();
  // A page that belongs to one workspace says so; elsewhere it is the open workspace.
  const key = api.workspace ?? workspace?.path ?? null;
  const tick = useSyncExternalStore(subscribe, () => epoch, () => epoch);
  const versions = [dataVersions.tasks, dataVersions.stakeholders, dataVersions.context, dataVersions.outputs, dataVersions['context-updates'], dataVersions.routines].join('.');
  const [answer, setAnswer] = useState<{ for: string; target: ReferenceTarget | null } | null>(null);
  const id = `${key}\u0000${ref}`;
  useEffect(() => {
    if (!active || !key) return;
    const resolve = resolverFor(key);
    // The first chip to see newer data drops the answers kept for this workspace.
    if (seenVersions.has(key) && seenVersions.get(key) !== versions) resolve.invalidate();
    seenVersions.set(key, versions);
    let live = true;
    void resolve(ref).then((t) => { if (live) setAnswer({ for: id, target: t }); });
    return () => {
      live = false;
    };
  }, [ref, key, id, active, tick, versions]);
  // Never an answer given for another reference or workspace.
  return answer && answer.for === id ? { answered: true, target: answer.target } : { answered: false, target: null };
}

/** The latest chip activation on the page: a chip whose lookup answers later navigates only if it is still this one. */
let lastActivation = 0;

/** Called after a chip opened its item, with its address (the chat uses it to step aside for a dialog or a phone). */
const ReferenceOpened = createContext<((route: string) => void) | undefined>(undefined);

/**
 * A chip for a workspace item: icon by type, opens the item in the app, with its title on hover. It opens only the
 * address the workspace confirmed: nothing is guessed from a file name (a file may carry another id than its name).
 *
 * `explicit` is an @-mention someone wrote: a chip at once, which, clicked before its lookup answered, opens the
 * item once it has (and nothing if it is not there), and is struck through when the item is gone. A reference found
 * in the text is plain text until the workspace confirms it, and stays so when the item is not there or the lookup
 * failed.
 */
function MentionChip({ refKey, explicit, display, children }: {
  refKey: string;
  explicit: boolean;
  display: string;
  children: ReactNode;
}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const opened = useContext(ReferenceOpened);
  const { answered, target } = useTarget(refKey, true);
  const missing = target ? !target.exists : false;
  const route = target?.exists ? target.route : null;
  // A click while the lookup is going: it opens the item when the answer comes, unless another chip was activated
  // since (only the latest activation on the page may navigate).
  const [waiting, setWaiting] = useState<number | null>(null);
  useEffect(() => {
    if (waiting === null || !answered) return;
    setWaiting(null);
    if (route && waiting === lastActivation) { navigate(route); opened?.(route); }
  }, [waiting, answered, route, navigate, opened]);
  const wait = () => setWaiting(++lastActivation);
  if (!explicit && !target?.exists) return <>{children}</>;
  if (answered && !route && !missing) return <>{children}</>;
  const type = target?.type ?? mentionType(refKey);
  const title = missing ? t('markdownRenderer.notFound', { href: display }) : target?.label && target.label !== display ? `${target.label}\n${display}` : display;
  return (
    <a
      href={route ?? undefined}
      // Without an address while the lookup goes, a chip is still a control the keyboard reaches.
      role={route ? undefined : 'link'}
      tabIndex={route ? undefined : 0}
      className={`mention-chip${type ? ` mention-chip--${type}` : ''}${missing ? ' mention-chip--missing' : ''}`}
      title={title}
      aria-disabled={missing || undefined}
      aria-busy={(!answered && waiting !== null) || undefined}
      onClick={(e) => {
        // A new tab or window (modifier keys) opens the confirmed address as any link does.
        if (route && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) return;
        e.preventDefault();
        if (missing) return;
        if (!route) { if (!answered) wait(); return; }
        lastActivation++;
        navigate(route);
        opened?.(route);
      }}
      onKeyDown={(e) => {
        if (route || e.key !== 'Enter') return;
        e.preventDefault();
        if (!answered && !missing) wait();
      }}
    >
      {type && <MentionIcon type={type} size={12} />}
      {children}
    </a>
  );
}

/** The text of a link's label, through any formatting in it (`[**@Name**](…)`). */
function textOf(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(children)) return textOf(children.props.children);
  return '';
}

/** Whether the text is finished: mentions in an answer still being written wait. */
const Settled = createContext(true);

/**
 * Links. Defined once, outside the renderer: a new component on every render would mount every link again, and a
 * chip that has the keyboard focus would lose it whenever the page around it changes.
 */
function Anchor({ node: _node, href, children, ...props }: ComponentProps<'a'> & { node?: unknown }) {
  const settled = useContext(Settled);
  const found = (props as Record<string, unknown>)['data-reference'];
  if (typeof found === 'string' && href) {
    // A reference found in the text: a chip once the workspace says it is there.
    return (
      <MentionChip refKey={found} explicit={false} display={found}>
        {children}
      </MentionChip>
    );
  }
  // @-mention of a workspace item, by path (`[@Name](/stakeholders/people/stk-0001.md)`, also without the leading
  // slash) or id (`[@Name](TASK-2026-0001)`): the same references as in the text.
  const ref = href && textOf(children).startsWith('@') ? hrefReference(href) : null;
  if (ref) {
    if (!settled) return <>{children}</>;
    return (
      <MentionChip refKey={ref} explicit display={REFERENCE_ID.test(ref) ? ref : `/${ref}`}>
        {children}
      </MentionChip>
    );
  }
  return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

function Table({ node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  return (
    <div className="markdown-view__table-wrap">
      <table {...props} />
    </div>
  );
}

const COMPONENTS = { a: Anchor, table: Table };
const PLAIN = [remarkGfm];
const WITH_REFERENCES = [remarkGfm, remarkReferences];

/**
 * The actual Markdown renderer, split into its own chunk (loaded lazily by MarkdownView) so the
 * Markdown libraries do not grow the main bundle.
 *
 * Raw HTML in the source is not rendered (react-markdown's default), so a note can never inject
 * markup into the dashboard. Links open in a new tab, except @-mentions of workspace items, which are chips. With
 * `references` (the chat's answers), bare ids and workspace paths become chips too. Until `settled` (an answer
 * still being written), mentions are plain text and nothing is looked up.
 */
export default function MarkdownRenderer({ content, references = false, settled = true, onReferenceOpened }: {
  content: string;
  references?: boolean;
  settled?: boolean;
  onReferenceOpened?: (route: string) => void;
}) {
  return (
    <ReferenceOpened.Provider value={onReferenceOpened}>
      <Settled.Provider value={settled}>
        <ReactMarkdown remarkPlugins={references && settled ? WITH_REFERENCES : PLAIN} components={COMPONENTS}>
          {content}
        </ReactMarkdown>
      </Settled.Provider>
    </ReferenceOpened.Provider>
  );
}
