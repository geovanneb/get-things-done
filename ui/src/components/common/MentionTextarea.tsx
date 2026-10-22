import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import ReactDOM from 'react-dom';
import {
  filterMentions,
  loadMentionCandidates,
  mentionMarkdown,
  MENTION_TYPE_LABELS,
  MENTION_TYPE_ORDER,
} from '@/utils/mentions';
import type { MentionCandidate, MentionType } from '@/utils/mentions';
import MentionIcon from './MentionIcon';

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  autoFocus?: boolean;
  placeholder?: string;
  style?: CSSProperties;
}

/** `@` at the start or after whitespace/`(`, followed by the query typed so far. */
const TRIGGER_RE = /(?:^|[\s(])@([^\n@[\]()]{0,40})$/;
const PER_GROUP_IN_ALL = 5;
const POPUP_WIDTH = 360;
/** Pixel offset of a caret position inside a textarea, measured with a hidden mirror element. */
function caretOffset(textarea: HTMLTextAreaElement, position: number): { top: number; left: number; height: number } {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const props = [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'textTransform', 'wordSpacing', 'tabSize',
  ] as const;
  for (const p of props) mirror.style[p] = style[p];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const result = {
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    height: marker.offsetHeight || parseFloat(style.lineHeight) || 18,
  };
  document.body.removeChild(mirror);
  return result;
}

export default function MentionTextarea({ value, onChange, rows = 6, autoFocus, placeholder, style }: MentionTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<MentionType | 'all'>('all');
  const [active, setActive] = useState(0);
  const [candidates, setCandidates] = useState<MentionCandidate[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const open = trigger !== null;

  const detectTrigger = useCallback(() => {
    const el = ref.current;
    if (!el || el.selectionStart !== el.selectionEnd) { setTrigger(null); return; }
    const caret = el.selectionStart;
    const match = TRIGGER_RE.exec(el.value.slice(0, caret));
    if (!match) { setTrigger(null); setDismissedAt(null); return; }
    const start = caret - match[1].length - 1;
    if (start === dismissedAt) { setTrigger(null); return; }
    if (!trigger || trigger.start !== start) setTypeFilter('all');
    if (!trigger || trigger.start !== start || trigger.query !== match[1]) setActive(0);
    setTrigger({ start, query: match[1] });
  }, [dismissedAt, trigger]);

  useEffect(() => {
    if (!open || candidates) return;
    loadMentionCandidates()
      .then((items) => { setCandidates(items); setLoadError(false); })
      .catch(() => setLoadError(true));
  }, [open, candidates]);

  // Runs in the same commit as the new value, so fast typing after a pick lands after the mention.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pendingCaret.current !== null && document.activeElement === el) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
    }
    pendingCaret.current = null;
  }, [value]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el || !trigger) { setPos(null); return; }
    const rect = el.getBoundingClientRect();
    const caret = caretOffset(el, trigger.start);
    const top = rect.top + caret.top + caret.height + 4;
    const left = Math.min(rect.left + caret.left, window.innerWidth - POPUP_WIDTH - 8);
    setPos({ top, left: Math.max(8, left) });
  }, [open, trigger, value]);

  const results = useMemo(() => {
    if (!candidates || !trigger) return [];
    const matches = filterMentions(candidates, trigger.query, typeFilter);
    if (typeFilter !== 'all') return matches.slice(0, 50);
    const perGroup = new Map<MentionType, number>();
    return matches.filter((c) => {
      const n = perGroup.get(c.type) ?? 0;
      perGroup.set(c.type, n + 1);
      return n < PER_GROUP_IN_ALL;
    });
  }, [candidates, trigger, typeFilter]);

  const hiddenCounts = useMemo(() => {
    if (!candidates || !trigger || typeFilter !== 'all') return new Map<MentionType, number>();
    const totals = new Map<MentionType, number>();
    for (const c of filterMentions(candidates, trigger.query, 'all')) totals.set(c.type, (totals.get(c.type) ?? 0) + 1);
    for (const [t, n] of totals) totals.set(t, Math.max(0, n - PER_GROUP_IN_ALL));
    return totals;
  }, [candidates, trigger, typeFilter]);

  useEffect(() => {
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !item) return;
    if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop - 28;
    else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
    }
  }, [active]);

  const close = () => {
    if (trigger) setDismissedAt(trigger.start);
    setTrigger(null);
  };

  const insert = (c: MentionCandidate) => {
    const el = ref.current;
    if (!el || !trigger) return;
    const caret = el.selectionStart;
    const before = value.slice(0, trigger.start);
    const after = value.slice(caret);
    const text = mentionMarkdown(c) + (after.startsWith(' ') ? '' : ' ');
    onChange(before + text + after);
    setTrigger(null);
    pendingCaret.current = before.length + text.length;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(results[active]); }
  };

  const chip = (t: MentionType | 'all', label: string) => (
    <button
      key={t}
      type="button"
      onMouseDown={(e) => { e.preventDefault(); setTypeFilter(t); setActive(0); }}
      style={{
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        padding: '3px 8px',
        borderRadius: 999,
        border: '1px solid var(--color-border)',
        background: typeFilter === t ? 'var(--color-accent-subtle)' : 'transparent',
        color: typeFilter === t ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );

  const popup = open && pos ? ReactDOM.createPortal(
    <div
      role="listbox"
      aria-label="Mention a file"
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: POPUP_WIDTH,
        maxHeight: 340,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        zIndex: 2000,
        fontFamily: 'var(--font-sans)',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: 8, borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        {chip('all', 'All')}
        {MENTION_TYPE_ORDER.map((t) => chip(t, t === 'template' ? 'Templates' : MENTION_TYPE_LABELS[t]))}
      </div>

      <div ref={listRef} style={{ position: 'relative', overflowY: 'auto', padding: '4px 0', minHeight: 0 }}>
        {loadError && <div style={emptyStyle}>Could not load the list. Try again in a moment.</div>}
        {!loadError && !candidates && <div style={emptyStyle}>Loading...</div>}
        {candidates && results.length === 0 && (
          <div style={emptyStyle}>No matches for “{trigger?.query}”</div>
        )}
        {results.map((c, i) => {
          const header = i === 0 || results[i - 1].type !== c.type;
          const isLastOfGroup = i === results.length - 1 || results[i + 1].type !== c.type;
          const more = hiddenCounts.get(c.type) ?? 0;
          return (
            <div key={`${c.type}:${c.path}`}>
              {header && <div style={groupHeaderStyle}>{MENTION_TYPE_LABELS[c.type]}</div>}
              <div
                role="option"
                aria-selected={i === active}
                data-index={i}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); insert(c); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  cursor: 'pointer',
                  background: i === active ? 'var(--color-surface-hover)' : 'transparent',
                }}
              >
                <span style={{ color: 'var(--color-text-muted)', display: 'flex' }}><MentionIcon type={c.type} /></span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.label}
                  </span>
                  {c.detail && (
                    <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.detail}
                    </span>
                  )}
                </span>
              </div>
              {isLastOfGroup && more > 0 && (
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); setTypeFilter(c.type); setActive(0); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '4px 10px 6px 36px',
                    fontSize: 'var(--text-xs)', color: 'var(--color-accent)', background: 'transparent',
                    border: 'none', cursor: 'pointer',
                  }}
                >
                  Show {more} more
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ padding: '6px 10px', borderTop: '1px solid var(--color-border)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', flexShrink: 0 }}>
        ↑↓ to move · Enter to insert · Esc to close
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); requestAnimationFrame(detectTrigger); }}
        onKeyDown={handleKeyDown}
        onKeyUp={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') detectTrigger(); }}
        onClick={detectTrigger}
        onBlur={() => setTrigger(null)}
        onScroll={() => { if (open) setTrigger((t) => (t ? { ...t } : t)); }}
        aria-autocomplete="list"
        aria-expanded={open}
        style={style}
      />
      {popup}
    </>
  );
}

const emptyStyle: CSSProperties = {
  padding: '10px 12px',
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text-muted)',
};

const groupHeaderStyle: CSSProperties = {
  padding: '8px 10px 4px',
  fontSize: 'var(--text-xs)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--color-text-muted)',
};
