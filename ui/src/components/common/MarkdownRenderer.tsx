import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate } from 'react-router-dom';

/** In-app route for an @-mention link (`[@Name](/stakeholders/people/stk-0001.md)`), or null. */
function mentionRoute(href: string | undefined): string | null {
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
  const navigate = useNavigate();
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, href, children, ...props }) => {
          const route = textOf(children).startsWith('@') ? mentionRoute(href) : null;
          if (route) {
            // @-mention: a chip that opens the item inside the app
            return (
              <a
                href={route}
                className="mention-chip"
                title={href}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(route);
                }}
              >
                {children}
              </a>
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
