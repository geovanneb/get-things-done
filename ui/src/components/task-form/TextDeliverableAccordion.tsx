import React from 'react';

/** Inline expandable preview + copy for a TXT-format deliverable's generated content. */
export default function TextDeliverableAccordion({ filePath }: { filePath: string }) {
  const [open, setOpen] = React.useState(false);
  const [content, setContent] = React.useState<string | null>(null);
  const [fetching, setFetching] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const fetchContent = async () => {
    if (content !== null) return;
    setFetching(true);
    try {
      const res = await fetch(`/api/workspace/files/${filePath}`);
      setContent(await res.text());
    } finally {
      setFetching(false);
    }
  };

  const handleToggle = () => {
    if (!open) fetchContent();
    setOpen((v) => !v);
  };

  const handleCopy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div style={{
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-sm)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px',
        background: 'var(--color-surface)',
        cursor: 'pointer',
        userSelect: 'none',
      }} onClick={handleToggle}>
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', color: 'var(--color-text-muted)' }}
        >
          <path d="M3 2l4 3-4 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ flex: 1, fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
          Generated text
        </span>
        {content && (
          <button
            onClick={(e) => { e.stopPropagation(); handleCopy(); }}
            title="Copy text"
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 'var(--text-xs)', fontWeight: 600,
              color: copied ? 'var(--color-success)' : 'var(--color-accent)',
              border: `1px solid ${copied ? 'var(--color-success)' : 'var(--color-accent)'}`,
              borderRadius: 'var(--radius-sm)',
              padding: '2px 8px',
              background: 'transparent',
              cursor: 'pointer',
              flexShrink: 0,
              transition: 'all 0.12s',
            }}
          >
            {copied ? (
              <>
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path d="M2 6l2.5 2.5 5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Copied
              </>
            ) : (
              <>
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M2.5 7H2a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" stroke="currentColor" strokeWidth="1.2" />
                </svg>
                Copy
              </>
            )}
          </button>
        )}
      </div>
      {open && (
        <div style={{
          padding: '12px 14px',
          borderTop: '1px solid var(--color-border)',
          background: 'var(--color-bg)',
          maxHeight: 360,
          overflowY: 'auto',
        }}>
          {fetching ? (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>Loading...</span>
          ) : content ? (
            <pre style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-sans)',
              color: 'var(--color-text)',
              lineHeight: 1.65,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {content}
            </pre>
          ) : (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>Could not load content.</span>
          )}
        </div>
      )}
    </div>
  );
}
