import React from 'react';

/**
 * A titled surface that groups one part of a page. See docs/design-system.md, "Cards".
 *
 *  padding="md"       content with its own spacing: text, forms, charts (default)
 *  padding="compact"  dense cards in a grid
 *  padding="none"     a list or table that runs edge to edge; the header gets a divider
 *
 * Cards on a page are h2 sections; a card inside a card section uses headingLevel 3.
 */
export default function Card({
  title,
  description,
  actions,
  badge,
  footer,
  padding = 'md',
  headingLevel = 2,
  headingId,
  as: Tag = 'section',
  onClick,
  children,
  className,
  style,
  ...rest
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** A count or status beside the title. */
  badge?: React.ReactNode;
  footer?: React.ReactNode;
  padding?: 'md' | 'compact' | 'none';
  headingLevel?: 2 | 3;
  headingId?: string;
  as?: 'section' | 'article' | 'div' | 'li';
  children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const classes = [
    'gtd-card',
    padding === 'none' && 'gtd-card--flush',
    padding === 'compact' && 'gtd-card--compact',
    onClick && 'gtd-card--interactive',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const hasHeader = title || description || actions;
  return (
    <Tag {...rest} className={classes} style={style} onClick={onClick} aria-labelledby={title && headingId ? headingId : undefined}>
      {hasHeader && (
        <div className="gtd-card__header">
          <div className="gtd-card__heading">
            {title && (
              <Heading id={headingId} className="gtd-card__title">
                {title}
                {badge}
              </Heading>
            )}
            {description && <p className="gtd-card__description">{description}</p>}
          </div>
          {actions && <div className="gtd-card__actions">{actions}</div>}
        </div>
      )}
      {children !== undefined && children !== null && children !== false && <div className="gtd-card__body">{children}</div>}
      {footer && <div className="gtd-card__footer">{footer}</div>}
    </Tag>
  );
}

/** A responsive grid for equivalent cards (templates, agents): one column on a phone. */
export function CardGrid({ children, as: Tag = 'div', ...rest }: { children: React.ReactNode; as?: 'div' | 'ul' } & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag {...rest} className={['gtd-card-grid', rest.className].filter(Boolean).join(' ')} style={{ ...(Tag === 'ul' ? { listStyle: 'none' } : {}), ...rest.style }}>
      {children}
    </Tag>
  );
}
