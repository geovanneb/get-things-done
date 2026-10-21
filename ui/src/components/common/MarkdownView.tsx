import { lazy, Suspense } from 'react';

const MarkdownRenderer = lazy(() => import('./MarkdownRenderer'));

interface MarkdownViewProps {
  /** Markdown source. Empty content shows `emptyText`. */
  content: string | null | undefined;
  /** Shown in muted italics when there is no content. */
  emptyText?: string;
  /** Smaller type for secondary content (cards, side panels). */
  compact?: boolean;
}

/**
 * Renders workspace Markdown (task bodies, notes, profile sections, text deliverables) the way
 * an editor preview does: headings, lists, tables, task lists, code and links.
 *
 * The renderer is loaded on first use; until then the raw text is shown, as before.
 */
export default function MarkdownView({ content, emptyText = 'No content', compact = false }: MarkdownViewProps) {
  if (!content || !content.trim()) {
    return <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>{emptyText}</span>;
  }
  return (
    <div className={compact ? 'markdown-view markdown-view--compact' : 'markdown-view'}>
      <Suspense fallback={<div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>}>
        <MarkdownRenderer content={content} />
      </Suspense>
    </div>
  );
}
