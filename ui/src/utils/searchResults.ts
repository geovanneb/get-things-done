/**
 * How the search overlay lays out results: grouped by type, groups in the order their best result came. Each item
 * carries its position in that displayed order, so the highlight, the mouse and Enter all mean the same row.
 */
export interface ResultGroup<T> {
  type: string;
  items: Array<{ result: T; index: number }>;
}

export function arrangeResults<T extends { type: string }>(results: T[]): { groups: ResultGroup<T>[]; ordered: T[] } {
  const byType = new Map<string, T[]>();
  for (const r of results) {
    const list = byType.get(r.type);
    if (list) list.push(r);
    else byType.set(r.type, [r]);
  }
  const groups: ResultGroup<T>[] = [];
  const ordered: T[] = [];
  for (const [type, items] of byType) {
    groups.push({ type, items: items.map((result) => ({ result, index: ordered.push(result) - 1 })) });
  }
  return { groups, ordered };
}

/** Keeps the highlighted row inside the list after it changes: the first row, or none when the list is empty. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/**
 * Tells whether a search is still the latest one. A slower answer to an earlier query must not replace newer results,
 * and nothing may arrive after the search was cleared or the overlay closed.
 */
export function latestOnly() {
  let current = 0;
  return {
    start(): number {
      current += 1;
      return current;
    },
    /** Makes every search started so far stale (cleared query, closed overlay). */
    cancel(): void {
      current += 1;
    },
    isLatest(id: number): boolean {
      return id === current;
    },
  };
}
