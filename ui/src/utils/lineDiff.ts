/**
 * Line diff for reviewing proposed context changes: what the agent wants a file to become, against what it is now.
 * Context notes are small, so a plain longest-common-subsequence table is fast enough and easy to trust.
 */

export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string; oldNo?: number; newNo?: number };

/** A run of lines to show, or a run of unchanged lines folded away. */
export type DiffBlock = { kind: 'lines'; lines: DiffLine[] } | { kind: 'fold'; count: number; lines: DiffLine[] };

/** Above this many cells (old lines x new lines) the table is too big; the diff falls back to remove-all/add-all. */
const MAX_CELLS = 4_000_000;

function splitLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // a final newline is not an extra empty line
  return lines;
}

export function diffLines(before: string | null, after: string | null): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // Common head and tail are cheap to match and make the table much smaller.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: 'same', text: a[i]!, oldNo: i + 1, newNo: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    midA.forEach((text, i) => out.push({ kind: 'remove', text, oldNo: start + i + 1 }));
    midB.forEach((text, j) => out.push({ kind: 'add', text, newNo: start + j + 1 }));
  } else {
    // lcs[i][j] = length of the common subsequence of midA[i..] and midB[j..]
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: 'same', text: midA[i]!, oldNo: start + i + 1, newNo: start + j + 1 });
        i++; j++;
      } else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
        // Removals before additions, as git shows them.
        out.push({ kind: 'remove', text: midA[i]!, oldNo: start + i + 1 });
        i++;
      } else {
        out.push({ kind: 'add', text: midB[j]!, newNo: start + j + 1 });
        j++;
      }
    }
  }

  const shift = b.length - a.length;
  for (let i = endA; i < a.length; i++) out.push({ kind: 'same', text: a[i]!, oldNo: i + 1, newNo: i + 1 + shift });
  return out;
}

/** Keeps `context` unchanged lines around each change and folds longer unchanged runs. */
export function foldUnchanged(lines: DiffLine[], context = 3): DiffBlock[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, i) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const blocks: DiffBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const shown = keep[i];
    let j = i;
    while (j < lines.length && keep[j] === shown) j++;
    const run = lines.slice(i, j);
    // Folding fewer than 4 lines saves no space; show them.
    if (shown || run.length < 4) blocks.push({ kind: 'lines', lines: run });
    else blocks.push({ kind: 'fold', count: run.length, lines: run });
    i = j;
  }
  // Merge neighbouring visible runs so the view renders one table per hunk.
  return blocks.reduce<DiffBlock[]>((acc, block) => {
    const last = acc[acc.length - 1];
    if (last && last.kind === 'lines' && block.kind === 'lines') last.lines.push(...block.lines);
    else acc.push(block.kind === 'lines' ? { kind: 'lines', lines: [...block.lines] } : block);
    return acc;
  }, []);
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'remove') removed++;
  }
  return { added, removed };
}
