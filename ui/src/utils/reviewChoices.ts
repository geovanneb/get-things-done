/**
 * Review choices (proposal decisions, meeting record confirmations) are saved one by one while the server
 * may also send a fresh copy of the update. These helpers keep the newest choice the user made: a refresh
 * never overwrites a choice still being saved, and a failed save only undoes its own choice.
 */

/** The choice to show: the local one when the user made it, even when it is null ("cleared"). */
export function shownChoice<T>(local: Record<string, T>, id: string, server: T): T {
  return Object.prototype.hasOwnProperty.call(local, id) ? local[id]! : server;
}

/** The server's choices, except for those still being saved, which keep the user's local value. */
export function mergeServerChoices<T>(local: Record<string, T>, server: Record<string, T>, pending: ReadonlySet<string>): Record<string, T> {
  const next = { ...server };
  for (const id of pending) if (Object.prototype.hasOwnProperty.call(local, id)) next[id] = local[id]!;
  return next;
}

/**
 * Tracks the latest save per choice. `start` returns a ticket; only the latest ticket for an id may apply
 * the server's answer or roll back, so an older response never undoes a newer click.
 */
export class PendingChoices {
  private latest = new Map<string, number>();
  private next = 0;

  start(id: string): number {
    const ticket = ++this.next;
    this.latest.set(id, ticket);
    return ticket;
  }

  isLatest(id: string, ticket: number): boolean {
    return this.latest.get(id) === ticket;
  }

  finish(id: string, ticket: number): void {
    if (this.isLatest(id, ticket)) this.latest.delete(id);
  }

  ids(): Set<string> {
    return new Set(this.latest.keys());
  }

  get size(): number {
    return this.latest.size;
  }
}
