import React, { useRef } from 'react';

/**
 * Two ways to switch what a page shows. See docs/design-system.md, "Navigation".
 *
 *  Tabs              switch between views of a page (Kanban / List / Archive). Underlined,
 *                    full width, arrow keys move between tabs.
 *  SegmentedControl  pick one option that filters or formats the same content
 *                    (7 days / 30 days, Light / Dark). Compact, sits in a toolbar.
 */
export interface TabItem<T extends string> {
  id: T;
  label: React.ReactNode;
  /** A count shown after the label. */
  count?: number;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix,
  style,
}: {
  items: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** With an id prefix, each tab controls the panel `${idPrefix}-panel`. */
  idPrefix?: string;
  style?: React.CSSProperties;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + delta + items.length) % items.length;
    onChange(items[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="gtd-tabs" style={style}>
      {items.map((item, i) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.id}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className="gtd-tab"
            onClick={() => onChange(item.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {item.label}
            {item.count !== undefined && <CountBadge count={item.count} active={selected} />}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  style,
}: {
  options: ReadonlyArray<{ value: T; label: React.ReactNode; icon?: React.ReactNode; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  style?: React.CSSProperties;
}) {
  return (
    <div role="group" aria-label={label} className="gtd-segmented" style={style}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          title={o.title}
          className="gtd-segmented__option"
          onClick={() => onChange(o.value)}
        >
          {o.icon && <span aria-hidden="true" style={{ display: 'flex' }}>{o.icon}</span>}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A small count beside a tab, title or nav item. */
export function CountBadge({ count, active, tone = 'neutral', label }: { count: number; active?: boolean; tone?: 'neutral' | 'accent' | 'warning' | 'critical'; label?: string }) {
  const colors: Record<string, React.CSSProperties> = {
    neutral: active
      ? { background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }
      : { background: 'var(--color-surface-hover)', color: 'var(--color-text-muted)' },
    accent: { background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' },
    warning: { background: 'var(--color-warning-subtle)', color: 'var(--color-warning)' },
    critical: { background: 'var(--color-critical-subtle)', color: 'var(--color-critical)' },
  };
  return (
    <span
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 20,
        height: 18,
        padding: '0 6px',
        borderRadius: 'var(--radius-full)',
        fontSize: 'var(--text-xs)',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
        ...colors[tone],
      }}
    >
      {count}
    </span>
  );
}
