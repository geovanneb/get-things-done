import { useState } from 'react';
import type { CSSProperties } from 'react';
import MarkdownView from './MarkdownView';
import MentionTextarea from './MentionTextarea';
import { SegmentedControl } from './Tabs';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  autoFocus?: boolean;
  placeholder?: string;
  /** Extra styles for the textarea (the preview takes the same minimum height). */
  textareaStyle?: CSSProperties;
  /** Typing `@` opens a picker for stakeholders, templates, context notes and tasks. */
  mentions?: boolean;
  /** Ties a Field label to the textarea. */
  id?: string;
}

/** A Markdown textarea with a Write / Preview switch, like an editor's preview pane. */
export default function MarkdownEditor({ value, onChange, rows = 8, autoFocus, placeholder, textareaStyle, mentions, id }: MarkdownEditorProps) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const minHeight = `${rows * 1.5 + 1.5}em`;

  const baseTextareaStyle: CSSProperties = { fontFamily: 'var(--font-mono)' };

  return (
    <div>
      <SegmentedControl label="Markdown editor" value={tab} onChange={setTab} style={{ marginBottom: 6 }}
        options={[{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }]} />
      {tab === 'write' && mentions ? (
        <MentionTextarea
          value={value}
          onChange={onChange}
          rows={rows}
          autoFocus={autoFocus}
          placeholder={placeholder}
          id={id}
          className="gtd-control"
          style={{ ...baseTextareaStyle, ...textareaStyle }}
        />
      ) : tab === 'write' ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          autoFocus={autoFocus}
          placeholder={placeholder}
          id={id}
          className="gtd-control"
          style={{ ...baseTextareaStyle, ...textareaStyle }}
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
