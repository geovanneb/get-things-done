import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryWords, searchMeeting } from '../src/services/meetingSearch';

// Snippets show the text as it was written around the real hit, also when folding (NFKC + lower case) changes the
// length or the position of what comes before it. Each expected value is the returned snippet itself, so the cut,
// the trimming and the `…` on each side are all checked.

/** The first snippet for a query in one notes line (or a transcript copy). */
function snippet(text: string, query: string): string {
  const hit = searchMeeting('m', [{ file: 'notes.md', text }], queryWords(query));
  assert.ok(hit, `no hit for ${query}`);
  return hit.snippets[0]!.text;
}

const family = '👨‍👩‍👧';

test('a half-width katakana word before the hit (ｶﾞ folds to one character) does not move the cut', () => {
  assert.equal(snippet(`${'ｶﾞ'.repeat(100)} budget ${'x'.repeat(100)}`, 'budget'), `…${'ｶﾞ'.repeat(45)} budget ${'x'.repeat(83)}…`);
  assert.equal(snippet('新しいｶﾞｲﾄﾞです', 'ガイド'), '新しいｶﾞｲﾄﾞです', 'the original, not the folded ガイド');
});

test('a ligature (ﬁ folds to two characters) before or around the hit', () => {
  assert.equal(snippet(`${'ﬁ'.repeat(150)} budget`, 'budget'), `…${'ﬁ'.repeat(89)} budget`);
  assert.equal(snippet('The ﬁle is here', 'file'), 'The ﬁle is here');
  assert.equal(snippet('The ﬁle is here', 'ile'), 'The ﬁle is here', 'a word starting inside the ligature');
});

test('ﬁ and ｶﾞ: the same length after folding, but the hit is somewhere else', () => {
  const text = `${'ﬁ'.repeat(100)} budget ${'ｶﾞ'.repeat(100)}`;
  assert.equal(text.length, text.normalize('NFKC').toLowerCase().length);
  assert.equal(snippet(text, 'budget'), `…${'ﬁ'.repeat(89)} budget ${'ｶﾞ'.repeat(42)}…`, 'and the end is not cut inside ｶﾞ');
});

test('İ, which lower case turns into two characters', () => {
  assert.equal(snippet(`${'İ'.repeat(120)} budget`, 'budget'), `…${'İ'.repeat(89)} budget`);
  assert.equal(snippet('Meet in İstanbul next week.', 'İstanbul'), 'Meet in İstanbul next week.');
});

test('combining marks stay with their letter, and the text keeps its own form', () => {
  assert.equal(snippet(`w é${'z'.repeat(88)} budget`, 'budget'), `…é${'z'.repeat(88)} budget`);
  assert.equal(snippet('Lunch at the Café Rose.', 'café'), 'Lunch at the Café Rose.', 'not composed into é');
});

test('surrogate pairs and emoji sequences are never cut in half', () => {
  assert.equal(snippet(`${'😀'.repeat(100)} budget`, 'budget'), `…${'😀'.repeat(45)} budget`);
  assert.equal(snippet(`${family.repeat(30)} budget`, 'budget'), `…${family.repeat(12)} budget`);
  assert.equal(snippet(`budget ${family.repeat(30)}`, 'budget'), `budget ${family.repeat(11)}…`);
});

test('flags keep their pairs, however far back the run of flags starts', () => {
  const jp = '🇯🇵';
  assert.equal(snippet(`${jp.repeat(150)}budget ${jp.repeat(150)}`, 'budget'), `…${jp.repeat(23)}budget ${jp.repeat(21)}…`);
  assert.equal(snippet(`${(jp + family).repeat(40)} budget`, 'budget'), `…${family}${(jp + family).repeat(7)} budget`);
  assert.equal(snippet(`budget ${(family + '🇯🇵🇺🇸').repeat(20)}`, 'budget'), `budget ${(family + '🇯🇵🇺🇸').repeat(5)}${family}…`);
  // Marks attached to a flag stay with it, at the end and at the start of a snippet.
  assert.equal(snippet(`budget${' '.repeat(82)}${jp}\u0301tail`, 'budget'), `budget${' '.repeat(82)}${jp}\u0301…`);
  assert.equal(snippet(`head${jp}\u0301${' '.repeat(87)}budget`, 'budget'), `…${jp}\u0301${' '.repeat(87)}budget`);
  // A run before the word too long to count from its start: cut at the word rather than guess how the flags pair up.
  assert.equal(snippet(`${jp.repeat(5000)}budget ${jp.repeat(5000)}`, 'budget'), `…budget ${jp.repeat(21)}…`);
});

test('ideographic spaces are trimmed at a cut and match a typed space', () => {
  assert.equal(snippet('会議　メモ', 'メモ'), '会議　メモ');
  assert.equal(snippet(`${'あ'.repeat(10)}${'　'.repeat(95)}予算`, '予算'), '…予算');
});

test('a transcript turn over several lines is cut around the hit in the joined text', () => {
  const copy = ['```text', '[00:00:01 → 00:00:09] Speaker 1', `  ${'ｶﾞ'.repeat(60)}`, '  the budget is here', '```', ''].join('\n');
  assert.equal(snippet(copy, 'budget'), `…${'ｶﾞ'.repeat(43)} the budget is here`);
});

test('a word found only in the speaker name shows the turn from its start, as written', () => {
  const copy = ['```text', '[00:00:01 → 00:00:09] Kim Park', `  ${'ｶﾞ'.repeat(100)}`, '```', ''].join('\n');
  const hit = searchMeeting('m', [{ file: 'a.vtt', text: copy }], ['kim'])!;
  assert.deepEqual([hit.snippets[0]!.speaker, hit.snippets[0]!.text], ['Kim Park', `${'ｶﾞ'.repeat(45)}…`]);
});

test('a long run with no safe place to split it is still cut at the hit', () => {
  for (const n of [5000, 500_000]) {
    assert.equal(snippet(`x${'ｶﾞ'.repeat(n)} budget ${'ｶﾞ'.repeat(10)}`, 'budget'), `…${'ｶﾞ'.repeat(45)} budget ${'ｶﾞ'.repeat(10)}`, `${n}`);
  }
});

test('a 1 MB line is cut around the hit quickly, with a snippet of the usual size', () => {
  const filler = 'Meeting ｶﾞｲﾄﾞ notes ＡＢＣ １２３ 会議　メモ ﬁle café ΟΣ 😀 ';
  const text = `${filler.repeat(20000)}ＢＵＤＧＥＴ ${filler.repeat(10)}`;
  assert.ok(text.length > 900_000);
  const t0 = performance.now();
  const cut = snippet(text, 'budget');
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  assert.ok(cut.startsWith('…') && cut.endsWith('…') && cut.length <= 200, cut);
  const shown = cut.slice(1, -1);
  const at = text.indexOf(shown);
  const hit = text.indexOf('ＢＵＤＧＥＴ');
  assert.ok(at >= 0 && Math.abs(at - (hit - 90)) <= 2, `starts at ${at}, hit at ${hit}`);
  assert.ok(shown.includes('ＢＵＤＧＥＴ'));
  // The same without a hit in the text itself (a speaker match): the start, not the whole line.
  const bySpeaker = searchMeeting('m', [{ file: 'a.vtt', text: ['```text', '[00:00:01 → 00:00:09] Kim Park', `  ${text}`, '```', ''].join('\n') }], ['kim'])!;
  assert.ok(bySpeaker.snippets[0]!.text.length <= 100);
});
