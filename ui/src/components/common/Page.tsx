import React from 'react';

export type PageWidth = 'narrow' | 'default' | 'wide' | 'full';

/**
 * The frame of every routed view: width, gutters and the vertical gap between sections.
 * See docs/design-system.md, "Page layout".
 *
 *  narrow   forms, settings, a profile, a single record (reading width)
 *  default  lists, tables and card grids
 *  wide     dashboards with side-by-side panels
 *  full     boards, split views and canvases; with `flush`, the view owns its padding
 */
export default function Page({
  width = 'default',
  flush,
  children,
  className,
  style,
  ...rest
}: {
  width?: PageWidth;
  flush?: boolean;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const classes = ['gtd-page', `gtd-page--${width}`, flush && 'gtd-page--flush', className].filter(Boolean).join(' ');
  return (
    <div {...rest} className={classes} style={style}>
      {children}
    </div>
  );
}

/**
 * The top of a page, under the app header. The app header already shows the page title
 * as the page's only h1, so this holds what the title does not say:
 * a one-line description, the page actions (primary last, on the right) and an optional
 * toolbar row of filters and search.
 */
export function PageHeader({
  description,
  actions,
  toolbar,
  children,
}: {
  description?: React.ReactNode;
  actions?: React.ReactNode;
  toolbar?: React.ReactNode;
  /** Extra content beside the description, such as a heading for a sub-view. */
  children?: React.ReactNode;
}) {
  return (
    <div className="gtd-page-header">
      {(description || children) && (
        <div className="gtd-page-header__text">
          {children}
          {description && <p className="gtd-page-header__description">{description}</p>}
        </div>
      )}
      {actions && <div className="gtd-page-header__actions">{actions}</div>}
      {toolbar && <div className="gtd-page-header__toolbar">{toolbar}</div>}
    </div>
  );
}

/**
 * A titled group of cards or rows on a page, without a surface of its own
 * ("Built-in", "Your routines"). The title is an h2; cards inside use headingLevel 3.
 * When the group needs a border, use Card instead.
 */
export function Section({
  title,
  description,
  actions,
  id,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  id?: string;
  children: React.ReactNode;
}) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--space-2) var(--space-4)' }}>
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 id={headingId} style={{ fontSize: 'var(--text-md)', fontWeight: 600, lineHeight: 'var(--leading-tight)', color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {title}
          </h2>
          {description && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)', lineHeight: 'var(--leading-normal)', maxWidth: 'var(--measure)' }}>{description}</p>}
        </div>
        {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}
