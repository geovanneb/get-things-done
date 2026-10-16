/**
 * Formatting for Insights.
 *
 * The unit that matters here is *hours*, not days. In a workspace where an
 * agent turns a task around in twenty minutes, "0 days" is both true and
 * useless, which is exactly what the old screen showed.
 */

/** A duration in hours, rendered at whatever scale reads naturally. */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return '--';
  if (hours < 1 / 60) return '< 1 min';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

/** A 0-1 rate as a whole percentage. */
export function formatRate(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '--' : `${Math.round(rate * 100)}%`;
}

/** Day counts, with a word for the near ones. */
export function formatDays(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

/** Short axis date like "Sep 8". */
export function formatShortDate(dateStr: string): string {
  const iso = dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dateStr.slice(5, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
