import { useState } from 'react';
import type { CSSProperties } from 'react';
import MarkdownView from './MarkdownView';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  autoFocus?: boolean;
  placeholder?: string;
  /** Extra styles for the textarea (the preview takes the same minimum height). */
  textareaStyle?: CSSProperties;
}

/** A Markdown textarea with a Write / Preview switch, like an editor's preview pane. */
export default function MarkdownEditor({ value, onChange, rows = 8, autoFocus, placeholder, textareaStyle }: MarkdownEditorProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const minHeight = `${rows * 1.5 + 1.5}em`;

  const tabStyle = (active: boolean): CSSProperties => ({
    fontSize: 'var(--text-xs)',
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 'var(--radius-sm)',
    color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
    background: active ? 'var(--color-surface-active)' : 'transparent',
  });

  return (
    <div>
      <div role="tablist" aria-label="Markdown editor" style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <button type="button" role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')} style={tabStyle(tab === 'write')}>
          Write
        </button>
        <button type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')} style={tabStyle(tab === 'preview')}>
          Preview
        </button>
      </div>
      {tab === 'write' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          autoFocus={autoFocus}
          placeholder={placeholder}
          style={{
            width: '100%',
            padding: '10px',
            fontSize: 'var(--text-base)',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text)',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 'var(--radius-md)',
            outline: 'none',
            resize: 'vertical',
            lineHeight: 1.5,
            ...textareaStyle,
          }}
        />
      ) : (
        <div
          style={{
            minHeight,
            padding: '10px 12px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface)',
          }}
        >
          <MarkdownView content={value} emptyText="Nothing to preview" />
        </div>
      )}
    </div>
  );
}
