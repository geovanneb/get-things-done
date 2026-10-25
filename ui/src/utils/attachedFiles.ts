/** One group in a Files list: the top level (`folder` is '') or the files directly in one subfolder. */
export interface FileGroup<T> { folder: string; items: T[] }

/**
 * Groups files by the folder they are directly in: top-level files first, then one group per folder,
 * sorted by path. Each folder appears once, even when the list interleaves it with a subfolder
 * ("a/a.txt", "a/b/x.txt", "a/z.txt"); "a/" and "a/b/" are separate groups. Order within a group is kept.
 */
export function groupByFolder<T extends { name: string }>(files: T[]): FileGroup<T>[] {
  const byFolder = new Map<string, T[]>();
  for (const f of files) {
    const slash = f.name.lastIndexOf('/');
    const folder = slash === -1 ? '' : f.name.slice(0, slash);
    const items = byFolder.get(folder);
    if (items) items.push(f); else byFolder.set(folder, [f]);
  }
  return [...byFolder.keys()]
    .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map((folder) => ({ folder, items: byFolder.get(folder)! }));
}
