import { es, ja, ptBR } from 'date-fns/locale';
import type { Locale as DateFnsLocale } from 'date-fns';
import type { Locale } from '../../../server/src/i18n/locale';
import { currentLocale, tr } from '@/i18n/current';
import { formatDistanceToNow, differenceInCalendarDays, isToday, isPast, isFuture, parseISO } from 'date-fns';

const DATE_LOCALES: Partial<Record<Locale, DateFnsLocale>> = { ja, 'pt-BR': ptBR, 'es-419': es };

function parseDate(date: string | Date): Date {
  if (date instanceof Date) return date;
  return parseISO(date);
}

export function formatDate(date: string | Date): string {
  try {
    return new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric' }).format(parseDate(date));
  } catch {
    return '';
  }
}

export function formatRelativeDate(date: string | Date): string {
  try {
    const d = parseDate(date);
    // Calendar days, as the labels say: 24-hour periods made last night "0 days ago" and tomorrow morning "0 days ago".
    const diff = differenceInCalendarDays(d, new Date());
    if (isToday(d)) return tr('format.today');
    if (diff === 1) return tr('format.tomorrow');
    if (diff === -1) return tr('format.yesterday');
    if (diff > 0) return tr('format.inDays', { diff });
    return tr('format.daysAgo', { abs: Math.abs(diff) });
  } catch {
    return '';
  }
}

export function formatDueStatus(dueDate: string): 'overdue' | 'due-today' | 'due-soon' | 'upcoming' | 'none' {
  if (!dueDate) return 'none';
  try {
    const d = parseISO(dueDate);
    if (isToday(d)) return 'due-today';
    if (isPast(d)) return 'overdue';
    const diff = differenceInCalendarDays(d, new Date());
    if (diff <= 3) return 'due-soon';
    if (isFuture(d)) return 'upcoming';
    return 'none';
  } catch {
    return 'none';
  }
}

/**
 * How a task list marks a due date: overdue once its day has passed, due soon from today through the next three
 * calendar days. Calendar days in local time, like formatDueStatus: a task due today is never overdue.
 */
export function dueHighlight(dueDate: string | undefined): 'overdue' | 'soon' | 'none' {
  const status = formatDueStatus(dueDate ?? '');
  if (status === 'overdue') return 'overdue';
  if (status === 'due-today' || status === 'due-soon') return 'soon';
  return 'none';
}

export function formatPriorityLabel(p: string): string {
  const labels: Record<string, string> = {
    critical: tr('attentionQueue.critical'),
    high: tr('attentionQueue.high'),
    medium: tr('attentionQueue.medium'),
    low: tr('attentionQueue.low'),
  };
  return labels[p] ?? p;
}

export function formatStatusLabel(s: string): string {
  const labels: Record<string, string> = {
    backlog: tr('routineEditor.backlog'),
    ready: tr('routineEditor.ready'),
    in_progress: tr('board.columnInProgress'),
    blocked: tr('renderer.blocked'),
    review: tr('shared.review'),
    done: tr('done'),
    in_review: tr('simulation.needsReview'),
    approved: tr('format.approved'),
    archived: tr('format.archived'),
  };
  return labels[s] ?? s;
}

export function getPriorityColor(p: string): string {
  const colors: Record<string, string> = {
    critical: 'var(--priority-critical)',
    high: 'var(--priority-high)',
    medium: 'var(--priority-medium)',
    low: 'var(--priority-low)',
  };
  return colors[p] ?? 'var(--color-text-muted)';
}

export function getStatusColor(s: string): string {
  const colors: Record<string, string> = {
    backlog: 'var(--color-text-muted)',
    ready: 'var(--color-info)',
    in_progress: 'var(--color-accent)',
    blocked: 'var(--color-critical)',
    review: 'var(--color-warning)',
    done: 'var(--color-success)',
    archived: 'var(--color-text-muted)',
  };
  return colors[s] ?? 'var(--color-text-muted)';
}

export function getInitials(name: string): string {
  // Data read from workspace files is not always what its type says.
  if (typeof name !== 'string' || !name.trim()) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

export function formatRelativeTime(date: string | Date): string {
  try {
    return formatDistanceToNow(parseDate(date), { addSuffix: true, locale: DATE_LOCALES[currentLocale()] });
  } catch {
    return '';
  }
}
