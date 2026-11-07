/**
 * Unit tests for choosing notes to share. Run with `npm run test:context-share --workspace=ui`.
 */
import { shareableNotes } from './contextShare';
import type { ContextNote } from '@/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const note = (id: string, title: string, sensitivity?: unknown) => ({ id, title, category: 'company', tags: [], relevance: 'optional', created_at: '', updated_at: '', sensitivity }) as ContextNote;
const notes = [note('a', 'Beta', 'shareable'), note('b', 'Alpha', 'shareable'), note('c', 'Gamma', 'internal'), note('d', 'Delta'), note('e', 'Eps', 'Shareable')];

const all = shareableNotes(notes, '');
check('only notes labelled exactly shareable are offered, sorted by title', all.shareable.map((n) => n.id).join() === 'b,a' && all.others === 3, JSON.stringify(all));
check('search narrows the offer', shareableNotes(notes, 'bet').shareable.map((n) => n.id).join() === 'a');

if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('All context share checks passed');
