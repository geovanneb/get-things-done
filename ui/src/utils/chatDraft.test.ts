/**
 * The unsent chat message kept when the panel closes by itself (on a phone, after a context update was made from
 * the chat). Run with `npm run test:chat-draft --workspace=ui`.
 */
import { draftKey, keepDraft, restoreDraft } from './chatDraft';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const here = draftKey('/work/alpha', 'chat-1');
const kept = keepDraft({ key: here, text: 'What changed in the last meeting?' });
check('words typed but not sent are kept', kept?.text === 'What changed in the last meeting?');
check('an empty or blank box keeps nothing', keepDraft({ key: here, text: '  \n' }) === null && keepDraft(null) === null);
check('they come back in the same workspace and chat', restoreDraft(kept, here, '') === 'What changed in the last meeting?');
check('not in another workspace', restoreDraft(kept, draftKey('/work/beta', 'chat-1'), '') === null);
check('not in another chat', restoreDraft(kept, draftKey('/work/alpha', 'chat-2'), '') === null);
check('a chat not started yet has its own key', draftKey('/work/alpha', null) !== here && draftKey('/work/alpha', null) === draftKey('/work/alpha', undefined));
check('words already in the box are never replaced', restoreDraft(kept, here, 'new words') === null);
check('nothing kept, nothing restored', restoreDraft(null, here, '') === null);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll chat draft checks passed');
