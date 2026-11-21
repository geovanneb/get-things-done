import { TONE_COLOR, type PendingAction } from '../../hooks/usePendingActions';

/**
 * The mark beside a sidebar item: a dot in the tone's colour with the count, or only the dot in the item's corner when
 * the sidebar is collapsed. An `activity` item gets a quiet ring with no count, in both. The item's own label and title
 * carry the words ("2 meetings in progress"), so the mark itself is hidden from screen readers.
 */
export default function PendingMark({ pending, corner = false }: { pending: PendingAction; corner?: boolean }) {
  const activity = pending.tone === 'activity';
  const dot = (
    <span
      aria-hidden="true"
      data-tone={pending.tone}
      className={`gtd-nav-dot${activity ? ' gtd-nav-dot--activity' : ''}${corner ? ' gtd-nav-dot--corner' : ''}`}
      style={activity ? undefined : { background: TONE_COLOR[pending.tone] }}
    />
  );
  if (corner || activity) return dot;
  return <span className="gtd-nav-mark">{dot}{pending.count}</span>;
}
