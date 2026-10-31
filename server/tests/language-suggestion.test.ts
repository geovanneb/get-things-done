import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectedLanguage, LanguageEvidence, type HeardPart } from '../src/services/transcription/languageSuggestion';

const has = (codes: string[]) => (language: string) => codes.includes(language);
const part = (start: number, seconds: number, detected: string | null): HeardPart => ({ start, end: start + seconds, detected });

test('a set language: a run of parts in another one is suggested, from where the run started', () => {
  const e = new LanguageEvidence(has(['en', 'ja']));
  assert.equal(e.add(part(0, 10, 'en'), 'en'), null);
  assert.equal(e.add(part(11, 2, 'ja'), 'en'), null, 'one part is not enough');
  assert.equal(e.add(part(14, 3, 'ja'), 'en'), null);
  const s = e.add(part(18, 4, 'ja'), 'en');
  assert.deepEqual([s?.language, s?.mode, s?.since], ['ja', 'mismatch', 11]);
  assert.equal(e.add(part(23, 2, 'ja'), 'en')?.id, s!.id, 'the same suggestion while the run goes on');
  assert.equal(e.add(part(26, 3, 'en'), 'en'), null, 'speech in the set language again: it goes');
});

test('a wrong short part, a gap or an unknown part breaks a run; two long parts are enough', () => {
  const e = new LanguageEvidence(has(['en', 'ja']));
  e.add(part(0, 2, 'ja'), 'en');
  e.add(part(3, 2, 'ja'), 'en');
  e.add(part(6, 1.8, null), 'en');
  assert.equal(e.add(part(8, 5, 'ja'), 'en'), null, 'an unknown part started it again');
  e.add(part(14, 3, 'ja'), 'en');
  assert.equal(e.add(part(60, 3, 'ja'), 'en'), null, 'a long pause started it again');
  const long = new LanguageEvidence(has(['en', 'ja']));
  long.add(part(0, 12, 'ja'), 'en');
  assert.equal(long.add(part(13, 12, 'ja'), 'en')?.language, 'ja', 'two long parts of continuous speech');
});

test('only languages the transcribing model has; "Keep" mutes one for the recording; a change clears it', () => {
  const e = new LanguageEvidence(has(['en', 'ja']));
  for (let t = 0; t < 30; t += 5) assert.equal(e.add(part(t, 4, 'ko'), 'en'), null, 'Korean is not offered by a model without it');
  for (let t = 30; t < 45; t += 5) e.add(part(t, 4, 'ja'), 'en');
  const s = e.suggestion!;
  assert.equal(e.keep('not-the-id'), false);
  assert.equal(e.keep(s.id), true);
  for (let t = 45; t < 90; t += 5) assert.equal(e.add(part(t, 4, 'ja'), 'en'), null, 'kept: not offered again');
  const f = new LanguageEvidence(has(['en', 'ja']));
  for (let t = 0; t < 15; t += 5) f.add(part(t, 4, 'ja'), 'en');
  assert.ok(f.suggestion);
  f.reset();
  assert.equal(f.suggestion, null);
});

test('Auto: the first two minutes, then each complete five minutes; the latest speech must agree', () => {
  const e = new LanguageEvidence(has(['en', 'ja']));
  let s = null;
  for (let t = 0; t < 110; t += 10) s = e.add(part(t, 9, 'ja'), 'auto');
  assert.equal(s, null, 'not before two minutes of speech');
  for (let t = 110; t < 160; t += 10) s = e.add(part(t, 9, 'ja'), 'auto');
  assert.deepEqual([s?.language, s?.mode], ['ja', 'auto']);
  // English now: a suggestion of Japanese does not stay while English is spoken.
  e.add(part(160, 9, 'en'), 'auto');
  assert.equal(e.add(part(170, 9, 'en'), 'auto'), null);

  // 100 s Japanese and 20 s English first: the first two minutes are not clear, and 80 s more Japanese is no
  // complete five-minute window yet.
  const late = new LanguageEvidence(has(['en', 'ja']));
  for (let t = 0; t < 100; t += 10) late.add(part(t, 10, 'ja'), 'auto');
  for (let t = 100; t < 120; t += 10) late.add(part(t, 10, 'en'), 'auto');
  for (let t = 120; t < 200; t += 10) assert.equal(late.add(part(t, 10, 'ja'), 'auto'), null, `at ${t}`);
  for (let t = 200; t < 430; t += 10) late.add(part(t, 10, 'ja'), 'auto');
  assert.equal(late.suggestion?.language, 'ja', 'a complete five minutes of Japanese');

  const mixed = new LanguageEvidence(has(['en', 'ja']));
  for (let t = 0; t < 700; t += 10) assert.equal(mixed.add(part(t, 9, t % 30 === 0 ? 'en' : 'ja'), 'auto'), null, 'a third in English');
  const unknown = new LanguageEvidence(has(['en', 'ja']));
  for (let t = 0; t < 700; t += 10) assert.equal(unknown.add(part(t, 9, t % 50 === 0 ? null : 'ja'), 'auto'), null, 'unknown parts count against it');
});

test('a suggestion goes after a long pause, with or without speech after it, and when the model loses the language', () => {
  const e = new LanguageEvidence(has(['en', 'ja']));
  for (let t = 1; t < 16; t += 5) e.add(part(t, 4, 'ja'), 'en');
  const first = e.suggestion!;
  assert.equal(first.since, 1);
  assert.equal(e.add(part(100, 4, 'ja'), 'en'), null, 'speech after a long pause starts a new run, and the old offer goes');
  for (let t = 104; t < 120; t += 5) e.add(part(t, 4, 'ja'), 'en');
  assert.notEqual(e.suggestion?.id, first.id, 'a new offer, from the new run');
  assert.equal(e.suggestion?.since, 100);
  assert.equal(e.expire(125), e.suggestion, 'a short silence keeps it');
  assert.equal(e.expire(200), null, 'a long silence ends it');

  let models = ['en', 'ja'];
  const changing = new LanguageEvidence((l) => models.includes(l));
  for (let t = 0; t < 15; t += 5) changing.add(part(t, 4, 'ja'), 'en');
  assert.ok(changing.suggestion);
  models = ['en'];
  assert.equal(changing.add(part(15, 4, 'ja'), 'en'), null, 'the model in Settings no longer has it');
});

test('detected languages as models report them', () => {
  assert.equal(detectedLanguage('<|ja|>'), 'ja');
  assert.equal(detectedLanguage('en'), 'en');
  for (const bad of ['<|nospeech|>', '', undefined, 42, '<|EMO_UNKNOWN|>', 'ja-JP']) assert.equal(detectedLanguage(bad), null);
});

test('Auto judges exactly the first two minutes, also when a part crosses the mark', () => {
  // 13 s English, 106 s Japanese, then a 10 s Japanese part across 120 s: the first two minutes are 89% Japanese.
  const e = new LanguageEvidence(has(['en', 'ja']));
  e.add(part(0, 13, 'en'), 'auto');
  let t = 14;
  for (let left = 106; left > 0; left -= 10) { e.add(part(t, Math.min(10, left), 'ja'), 'auto'); t += 11; }
  assert.equal(e.add(part(t, 10, 'ja'), 'auto'), null, 'not clear in the first two minutes');
  // The next window is the five minutes after them, [120, 420) of speech: Japanese throughout, so it is suggested
  // with the part that completes it, and not before. 129 s heard so far; 29 parts of 10 s reach 419 s.
  for (let i = 0; i < 29; i++) { t += 11; assert.equal(e.add(part(t, 10, 'ja'), 'auto'), null, `at ${129 + (i + 1) * 10} s of speech`); }
  t += 11;
  assert.equal(e.add(part(t, 1, 'ja'), 'auto')?.language, 'ja', 'exactly at 420 s of speech the window is complete');
});
