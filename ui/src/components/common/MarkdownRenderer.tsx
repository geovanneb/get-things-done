import { useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavigate } from 'react-router-dom';
import MentionIcon from './MentionIcon';
import { mentionTypeForPath, resolveMentionRoute } from '@/utils/mentions';
import type { MentionType } from '@/utils/mentions';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

function decodePath(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return decodeURI(href).replace(/^\.\//, '');
  } catch {
    return null;
  }
}

function MentionChip({ type, relPath, label }: { type: MentionType; relPath: string; label: string }) {
  const navigate = useNavigate();
  const [missing, setMissing] = useState(false);
  const open = async (e: MouseEvent) => {
    e.preventDefault();
    const route = await resolveMentionRoute(relPath).catch(() => null);
    if (route) navigate(route);
    else setMissing(true);
  };
  return (
    <a
      href={relPath}
      onClick={open}
      className={`mention-chip mention-chip--${type}${missing ? ' mention-chip--missing' : ''}`}
      title={missing ? `Not found: ${relPath}` : relPath}
    >
      <MentionIcon type={type} size={12} />
      {label}
    </a>
  );
}

/**
 * The actual Markdown renderer, split into its own chunk (loaded lazily by MarkdownView) so the
 * Markdown libraries do not grow the main bundle.
 *
 * Raw HTML in the source is not rendered (react-markdown's default), so a note can never inject
 * markup into the dashboard. Links open in a new tab, except `[@Label](path)` mentions, which
 * render as chips that navigate inside the app.
 */
export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => {
          const label = textOf(props.children);
          const relPath = decodePath(props.href);
          const type = relPath ? mentionTypeForPath(relPath) : null;
          if (label.startsWith('@') && relPath && type) {
            return <MentionChip type={type} relPath={relPath} label={label.slice(1)} />;
          }
          return <a {...props} target="_blank" rel="noreferrer noopener" />;
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
