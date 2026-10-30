/**
 * Unit tests for the live transcript on the page. Run with: npm run test:live-transcript --workspace=ui
 */
import { clockOf, emptyLive, MAX_PIECES, mergeLive, type LivePiece } from './liveTranscript';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const piece = (i: number): LivePiece => ({ i, start: i, end: i + 1, text: `Words ${i}` });
const pieces = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => piece(from + k));

let s = mergeLive(emptyLive, 'a', pieces(0, 3), 3);
check('pieces are kept with where to read on', s.pieces.length === 3 && s.next === 3);
s = mergeLive(s, 'a', pieces(2, 5), 5);
check('a piece that arrives twice is kept once', s.pieces.map((p) => p.i).join() === '0,1,2,3,4' && s.next === 5);
s = mergeLive(s, 'a', [piece(7), piece(6)], 8);
check('out of order is put in order', s.pieces.map((p) => p.i).slice(-2).join() === '6,7' && s.next === 8);
s = mergeLive(s, 'a', [], 3);
check('an older answer never moves the cursor back', s.next === 8);
s = mergeLive(s, 'b', [piece(0)], 1);
check('another recording starts over', s.generation === 'b' && s.pieces.length === 1 && s.next === 1);
s = mergeLive(emptyLive, 'c', pieces(0, MAX_PIECES + 50), MAX_PIECES + 50);
check('only the latest are kept on the page, and reading goes on', s.pieces.length === MAX_PIECES && s.pieces[0]!.i === 50 && s.next === MAX_PIECES + 50);
check('the clock reads as a recording does', clockOf(65) === '1:05' && clockOf(3725) === '1:02:05' && clockOf(-1) === '0:00');

console.log(failures ? `\n${failures} failed` : '\nAll live transcript tests passed');
process.exit(failures ? 1 : 0);
