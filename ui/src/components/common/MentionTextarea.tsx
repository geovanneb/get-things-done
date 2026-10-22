import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { apiGet } from '@/utils/api';
import MentionIcon from './MentionIcon';

export interface MentionCandidate {
  type: 'stakeholder' | 'template' | 'context' | 'task';
  id: string;
  label: string;
  detail?: string;
  href: string;
  confidentiality?: string;
}

const GROUPS: { type: MentionCandidate['type']; title: string }[] = [
  { type: 'stakeholder', title: 'Stakeholders' },
  { type: 'template', title: 'Output templates' },
  { type: 'context', title: 'Context notes' },
  { type: 'task', title: 'Tasks' },
];

/** In the "All" tab, at most this many results per type; the rest sit behind "Show N more". */
const PER_GROUP_IN_ALL = 5;

/** `@` (or full-width `＠`) at the start of the text or after a space / bracket, then the query typed so far. */
const TRIGGER = /(^|[\s(（])[@＠]([^\s@＠[\]()]{0,40})$/;

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  autoFocus?: boolean;
  placeholder?: string;
  style?: CSSProperties;
}

/**
 * A textarea that opens a picker when you type `@`, and inserts the choice as a Markdown link,
 * e.g. `[@Jane Doe](/stakeholders/people/stk-0001.md)`.
 *
 * While an IME is composing (Japanese, Chinese, Korean input) the picker neither opens nor reacts
 * to keys, so Enter confirms the conversion instead of picking an item.
 */
export default function MentionTextarea({ value, onChange, rows = 6, autoFocus, placeholder, style }: MentionTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [all, setAll] = useState<MentionCandidate[]>([]);
  const [typeFilter, setTypeFilter] = useState<MentionCandidate['type'] | 'all'>('all');
  const [active, setActive] = useState(0);

  // What is on screen: one type in full, or up to PER_GROUP_IN_ALL per type in "All"
  const results =
    typeFilter === 'all'
      ? GROUPS.flatMap((g) => all.filter((c) => c.type === g.type).slice(0, PER_GROUP_IN_ALL))
      : all.filter((c) => c.type === typeFilter);
  const hidden = (type: MentionCandidate['type']) =>
    typeFilter === 'all' ? Math.max(0, all.filter((c) => c.type === type).length - PER_GROUP_IN_ALL) : 0;

  // Search (debounced) while the picker is open
  useEffect(() => {
    if (!trigger) return;
    const t = setTimeout(() => {
      apiGet<MentionCandidate[]>(`/api/mentions?q=${encodeURIComponent(trigger.query)}&limit=50`)
        .then((r) => {
          // Keep the on-screen order (grouped) so arrow keys follow what the user sees
          setAll(GROUPS.flatMap((g) => r.filter((c) => c.type === g.type)));
          setActive(0);
        })
        .catch(() => setAll([]));
    }, 120);
    return () => clearTimeout(t);
  }, [trigger?.query, trigger?.start]); // eslint-disable-line react-hooks/exhaustive-deps

  const detect = (text: string, caret: number) => {
    if (composing.current) return;
    const m = TRIGGER.exec(text.slice(0, caret));
    const next = m ? { start: caret - m[2].length - 1, query: m[2] } : null;
    if (!next || next.start !== trigger?.start) setTypeFilter('all'); // a new @ starts on "All"
    setTrigger(next);
  };

  const pick = (c: MentionCandidate) => {
    if (!trigger || !ref.current) return;
    const caret = ref.current.selectionStart ?? value.length;
    const label = c.type === 'task' ? c.id : c.label;
    const link = `[@${label}](${c.href}) `;
    const next = value.slice(0, trigger.start) + link + value.slice(caret);
    onChange(next);
    setTrigger(null);
    const pos = trigger.start + link.length;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!trigger || composing.current || e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // close the picker, not the surrounding modal
      setTrigger(null);
      return;
    }
    if (results.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(results[active]);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        autoFocus={autoFocus}
        placeholder={placeholder}
        style={style}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => detect(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
        onBlur={() => setTimeout(() => setTrigger(null), 150)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          detect(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length);
        }}
        aria-autocomplete="list"
        aria-expanded={!!trigger}
      />
      {trigger && (
        <div
          role="listbox"
          aria-label="Mention a stakeholder, template, context note or task"
          className="mention-picker"
        >
          <div className="mention-picker__tabs" role="tablist" aria-label="Filter by type">
            {([{ type: 'all', title: 'All' }, ...GROUPS] as { type: MentionCandidate['type'] | 'all'; title: string }[]).map((t) => (
              <button
                key={t.type}
                type="button"
                role="tab"
                aria-selected={typeFilter === t.type}
                className={typeFilter === t.type ? 'mention-picker__tab is-active' : 'mention-picker__tab'}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setTypeFilter(t.type);
                  setActive(0);
                }}
              >
                {t.title}
              </button>
            ))}
          </div>
          {results.length === 0 ? (
            <div className="mention-picker__empty">No matches</div>
          ) : (
            GROUPS.map((g) => {
              const items = results.filter((c) => c.type === g.type);
              if (items.length === 0) return null;
              return (
                <div key={g.type}>
                  <div className="mention-picker__group">
                    <MentionIcon type={g.type} size={12} />
                    {g.title}
                  </div>
                  {items.map((c) => {
                    const idx = results.indexOf(c);
                    return (
                      <div
                        key={c.type + c.href}
                        role="option"
                        aria-selected={idx === active}
                        className={idx === active ? 'mention-picker__item is-active' : 'mention-picker__item'}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          pick(c);
                        }}
                        onMouseEnter={() => setActive(idx)}
                      >
                        <span className="mention-picker__label">{c.label}</span>
                        <span className="mention-picker__id">{c.id}</span>
                        {c.detail && <span className="mention-picker__detail">{c.detail}</span>}
                        {c.confidentiality && (
                          <span className="mention-picker__conf" title="This task is marked confidential or restricted">
                            {c.confidentiality}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {hidden(g.type) > 0 && (
                    <button
                      type="button"
                      className="mention-picker__more"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setTypeFilter(g.type);
                        setActive(0);
                      }}
                    >
                      Show {hidden(g.type)} more
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
