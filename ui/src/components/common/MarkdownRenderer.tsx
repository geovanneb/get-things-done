import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate } from 'react-router-dom';
import MentionIcon from './MentionIcon';
import type { MentionType } from './MentionIcon';
import { apiGet } from '@/utils/api';

function mentionType(href: string): MentionType | null {
  const h = href.replace(/^\//, '');
  if (h.startsWith('stakeholders/')) return 'stakeholder';
  if (h.startsWith('context/')) return 'context';
  if (h.startsWith('outputs/')) return 'template';
  if (h.startsWith('tasks/')) return 'task';
  return null;
}

/** A mention chip: icon by type, opens the item in the app, struck through if the file is gone. */
function MentionChip({ href, route, children }: { href: string; route: string; children: ReactNode }) {
  const navigate = useNavigate();
  const [missing, setMissing] = useState(false);
  const type = mentionType(href);
  useEffect(() => {
    let live = true;
    apiGet<{ exists: boolean }>(`/api/mentions/resolve?href=${encodeURIComponent(href)}`)
      .then((r) => live && setMissing(!r.exists))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [href]);
  return (
    <a
      href={route}
      className={`mention-chip${type ? ` mention-chip--${type}` : ''}${missing ? ' mention-chip--missing' : ''}`}
      title={missing ? `Not found: ${href}` : href}
      onClick={(e) => {
        e.preventDefault();
        if (!missing) navigate(route);
      }}
    >
      {type && <MentionIcon type={type} size={12} />}
      {children}
    </a>
  );
}

/** In-app route for an @-mention link (`[@Name](/stakeholders/people/stk-0001.md)`), or null. */
function mentionRoute(rawHref: string | undefined): string | null {
  // Early mentions were written without the leading slash; treat them as workspace-root paths.
  const href = rawHref && /^(stakeholders|context|outputs|tasks)\//.test(rawHref) ? `/${rawHref}` : rawHref;
  if (!href || !href.startsWith('/')) return null;
  const task = href.match(/^\/tasks\/[^/]+\/(TASK-\d{4}-\d{4})\//);
  if (task) return `/board/task/${task[1]}`;
  const stk = href.match(/^\/stakeholders\/[^/]+\/([a-z]+-\d+)\.md$/i);
  if (stk) return `/stakeholders/${stk[1].toUpperCase()}`;
  if (href.startsWith('/context/')) return '/context';
  if (href.startsWith('/outputs/')) return '/outputs';
  return null;
}

function textOf(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  return '';
}

/**
 * The actual Markdown renderer, split into its own chunk (loaded lazily by MarkdownView) so the
 * Markdown libraries do not grow the main bundle.
 *
 * Raw HTML in the source is not rendered (react-markdown's default), so a note can never inject
 * markup into the dashboard. Links open in a new tab.
 */
export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, href, children, ...props }) => {
          const route = textOf(children).startsWith('@') ? mentionRoute(href) : null;
          if (route && href) {
            // @-mention: a chip that opens the item inside the app
            return (
              <MentionChip href={href} route={route}>
                {children}
              </MentionChip>
            );
          }
          return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
        },
        table: ({ node: _node, ...props }) => (
          <div className="markdown-view__table-wrap">
            <table {...props} />
          </div>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
