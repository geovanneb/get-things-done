import { useMemo, useState } from 'react';
import { diffLines, foldUnchanged, type DiffLine } from '@/utils/lineDiff';

const rowStyle = (kind: DiffLine['kind']): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: '40px 40px 16px 1fr',
  background: kind === 'add' ? 'var(--color-success-subtle)' : kind === 'remove' ? 'var(--color-critical-subtle)' : 'transparent',
  color: 'var(--color-text)',
});

const numStyle: React.CSSProperties = { textAlign: 'right', paddingRight: 6, color: 'var(--color-text-muted)', userSelect: 'none' };

function Row({ line }: { line: DiffLine }) {
  const sign = line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ';
  const signColor = line.kind === 'add' ? 'var(--color-success)' : line.kind === 'remove' ? 'var(--color-critical)' : 'var(--color-text-muted)';
  return (
    <div style={rowStyle(line.kind)}>
      <span style={numStyle}>{line.oldNo ?? ''}</span>
      <span style={numStyle}>{line.newNo ?? ''}</span>
      {/* The sign carries the meaning for people who cannot tell the colours apart, and for screen readers. */}
      <span aria-label={line.kind === 'add' ? 'added' : line.kind === 'remove' ? 'removed' : undefined} style={{ color: signColor, fontWeight: 700, userSelect: 'none' }}>{sign}</span>
      <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingRight: 8 }}>{line.text || ' '}</span>
    </div>
  );
}

/** Unified line diff, current file on the left numbers, proposed on the right; long unchanged runs fold away. */
export default function DiffView({ before, after }: { before: string | null; after: string | null }) {
  const blocks = useMemo(() => foldUnchanged(diffLines(before, after)), [before, after]);
  const [opened, setOpened] = useState<Set<number>>(() => new Set());

  if (blocks.every((b) => b.kind === 'lines' && b.lines.every((l) => l.kind === 'same'))) {
    return <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>No difference from the current file.</p>;
  }

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', lineHeight: 1.6, maxHeight: 480, overflowY: 'auto', background: 'var(--color-surface)' }}>
      {blocks.map((block, i) => {
        if (block.kind === 'lines' || opened.has(i)) {
          return <div key={i}>{block.lines.map((line, j) => <Row key={j} line={line} />)}</div>;
        }
        return (
          <button key={i} type="button" onClick={() => setOpened((prev) => new Set(prev).add(i))}
            style={{ display: 'block', width: '100%', padding: '3px 12px', border: 'none', borderTop: '1px solid var(--color-border)', borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-accent)', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-xs)', textAlign: 'left', cursor: 'pointer' }}>
            Show {block.count} unchanged lines
          </button>
        );
      })}
    </div>
  );
}
