/**
 * What the context update importer is about to save, worked out before anything is written: the update's title and
 * the materials it gets, and where the user goes once it is saved.
 */

/** The title the importer sends: the one typed, or the first file's name without its extension. */
export function importTitle(title: string, files: readonly { name: string }[]): string {
  return title.trim() || (files[0] ? files[0].name.replace(/\.[^.]+$/, '') : '');
}

/** The longest title the server keeps (`ContextUpdateService.create`). */
export const MAX_TITLE = 200;

/** The material date the server records: the one sent, or today's UTC date when none is (`ContextUpdateService.create`). */
export function savedSourceDate(sourceDate: string, now = new Date()): string {
  return sourceDate || now.toISOString().slice(0, 10);
}

/**
 * The title the server saves for what the importer sends, exactly as `ContextUpdateService.create` makes it: trimmed,
 * cut to 200 characters, and `Update <date>` when nothing is left. The fallback is the server's own (English) text.
 */
export function savedTitle(title: string, files: readonly { name: string }[], sourceDate: string, now = new Date()): string {
  return importTitle(title, files).trim().slice(0, MAX_TITLE) || `Update ${savedSourceDate(sourceDate, now)}`;
}

export interface ImportPlan {
  /** The title the update will have. */
  title: string;
  /** The files' names, in the order they are uploaded. */
  files: string[];
  /** Pasted text is saved as one more file in the update. */
  pastedText: boolean;
}

export function importPlan(title: string, files: readonly { name: string }[], text: string, sourceDate: string, now = new Date()): ImportPlan {
  return { title: savedTitle(title, files, sourceDate, now), files: files.map((f) => f.name), pastedText: text.trim().length > 0 };
}

/**
 * Where to go after an update was made for a given workspace: its page, pinned to that workspace. The page's reads
 * and a retried upload then name it, so a switch in another tab is refused instead of reaching the other workspace's
 * update with the same id.
 */
export function importedUpdateLocation(updateId: string, workspacePath: string): { to: string; state: { workspace: string } } {
  return { to: `/context/updates/${updateId}`, state: { workspace: workspacePath } };
}
