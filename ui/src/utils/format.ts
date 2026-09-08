import { format, formatDistanceToNow, differenceInDays, isToday, isPast, isFuture, parseISO } from 'date-fns';

function parseDate(date: string | Date): Date {
  if (date instanceof Date) return date;
  return parseISO(date);
}

export function formatDate(date: string | Date): string {
  try {
    return format(parseDate(date), 'MMM d');
  } catch {
    return '';
  }
}

export function formatRelativeDate(date: string | Date): string {
  try {
    const d = parseDate(date);
    const diff = differenceInDays(d, new Date());
    if (isToday(d)) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    if (diff > 0) return `in ${diff} days`;
    return `${Math.abs(diff)} days ago`;
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
    const diff = differenceInDays(d, new Date());
    if (diff <= 3) return 'due-soon';
    if (isFuture(d)) return 'upcoming';
    return 'none';
  } catch {
    return 'none';
  }
}

export function formatPriorityLabel(p: string): string {
  const labels: Record<string, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
  };
  return labels[p] ?? p;
}

export function formatStatusLabel(s: string): string {
  const labels: Record<string, string> = {
    backlog: 'Backlog',
    ready: 'Ready',
    in_progress: 'In Progress',
    blocked: 'Blocked',
    review: 'Review',
    done: 'Done',
    in_review: 'Needs Review',
    approved: 'Approved',
    archived: 'Archived',
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
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

export function formatRelativeTime(date: string | Date): string {
  try {
    return formatDistanceToNow(parseDate(date), { addSuffix: true });
  } catch {
    return '';
  }
}
