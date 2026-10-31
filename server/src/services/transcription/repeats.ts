/** This many times in a row is a model stuck in a loop: people repeat themselves less, and it is never a number. */
const LOOP = 6;
const LONGEST_PIECE = 40;
const BETWEEN = /[\s,.、，。]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;
const WORD_CHARACTER = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u;

/** How many times `piece` stands at `from`, with spaces or commas between, and where that ends. */
function repeats(text: string, piece: string, from: number): { count: number; end: number } {
  let count = 0;
  let end = from;
  let at = from;
  while (text.startsWith(piece, at)) {
    count++;
    at += piece.length;
    end = at;
    while (at < text.length && BETWEEN.test(text[at]!)) at++;
  }
  return { count, end: at === text.length ? at : end };
}

/**
 * On noise a model can write the same words over and over. One of them stays, with a note saying so, so the reader
 * knows text was left out. Numbers are never touched, and a piece starts at a word, so words themselves stay whole.
 */
export function markRepeats(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    let found: { piece: string; count: number; end: number } | null = null;
    if (!BETWEEN.test(text[i]!) && !(i > 0 && WORD_CHARACTER.test(text[i - 1]!) && WORD_CHARACTER.test(text[i]!))) {
      for (let size = 2; size <= LONGEST_PIECE && i + size <= text.length && !found; size++) {
        const piece = text.slice(i, i + size);
        if (!LETTER.test(piece) || DIGIT.test(piece) || BETWEEN.test(piece.at(-1)!)) continue;
        const run = repeats(text, piece, i);
        if (run.count >= LOOP) found = { piece, ...run };
      }
    }
    if (found) {
      out += `${found.piece} [repeated ${found.count} times]`;
      i = found.end;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}
