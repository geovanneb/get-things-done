import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
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
