import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, decodeText, isWebVtt, parseWebVtt, sha256, transcriptMarkdown } from '../src/utils/transcript';

/** A fictional meeting in the shape Teams exports: cue ids, voice tags, several cues per turn. */
const TEAMS = `WEBVTT

NOTE fictional sample

a1b2c3d4/12-0
00:00:03.120 --> 00:00:06.400
<v Jane Doe>Good morning, everyone.</v>

a1b2c3d4/13-0
00:00:06.400 --> 00:00:09.000
<v Jane Doe>Let's start with the pilot &amp; the budget.</v>

a1b2c3d4/14-0
00:00:09.500 --> 00:00:12.000
<v 塩本 直弘>予算は来週確認します。</v>

00:01:05.000 --> 00:01:07.250
<v.loud Jane Doe>Agreed: <b>Q1</b>.</v>
`;

const vtt = (...cues: string[]) => `WEBVTT\n\n${cues.join('\n\n')}\n`;

test('a Teams-style WebVTT becomes turns with speakers as written, every word kept', () => {
  const parsed = parseWebVtt(TEAMS)!;
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.speakers, ['Jane Doe', '塩本 直弘'], 'names are kept exactly, never romanized');
  assert.equal(parsed.cues[1]!.text, "Let's start with the pilot & the budget.");
  assert.equal(parsed.cues[3]!.text, 'Agreed: Q1.', 'markup is removed, words stay');
  assert.equal(clock(parsed.duration), '00:01:07');

  const md = transcriptMarkdown('sync.vtt', 'abc', parsed);
  assert.ok(md.includes("[00:00:03 → 00:00:09] Jane Doe\n  Good morning, everyone.\n  Let's start with the pilot & the budget."), 'close cues of one speaker form one turn');
  assert.ok(md.includes('[00:00:09 → 00:00:12] 塩本 直弘\n  予算は来週確認します。'));
  assert.ok(md.includes('[00:01:05 → 00:01:07] Jane Doe\n  Agreed: Q1.'), 'a long gap starts a new turn');
  assert.ok(md.includes('**Complete.**'));
  assert.ok(md.includes('not checked against stakeholders: Jane Doe, 塩本 直弘'));
});

test('several voices in one cue stay separate, and text outside a voice has no speaker', () => {
  const parsed = parseWebVtt(vtt('00:00:01.000 --> 00:00:03.000\nBefore <v Alice>Approve.</v><v Bob>Do not approve.</v> after'))!;
  assert.deepEqual(parsed.cues.map((c) => [c.speaker, c.text]), [[null, 'Before'], ['Alice', 'Approve.'], ['Bob', 'Do not approve.'], [null, 'after']]);
  assert.deepEqual(parsed.speakers, ['Alice', 'Bob']);
  assert.deepEqual(parsed.problems, []);

  const nested = parseWebVtt(vtt('00:00:01.000 --> 00:00:03.000\n<v Alice>Yes <v Bob>no'))!;
  assert.deepEqual(nested.cues.map((c) => [c.speaker, c.text]), [['Alice', 'Yes'], ['Bob', 'no']], 'an unclosed voice runs to the end of the cue');
  assert.match(nested.problems.join(), /voice tag inside another voice tag/);
});

test('nothing is guessed: "Label: text" stays speech, NOTE blocks stay out, unreadable blocks are reported', () => {
  const parsed = parseWebVtt(vtt(
    '00:00:01.000 --> 00:00:02.000\nDecision: Do not launch.',
    'NOTE\n00:00:03.000 --> 00:00:04.000\nnot speech',
    '00:00:05.000 --> 00:00:06.000\nfirst part',
    'second part after a blank line',
    '00:00:07.000 --> 00:00:08.000\nx < y and z > w <i>kept</i>',
  ))!;
  assert.deepEqual(parsed.cues.map((c) => [c.speaker, c.text]), [[null, 'Decision: Do not launch.'], [null, 'first part'], [null, 'x < y and z > w kept']]);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0]!, /^line 13: not a cue/);
  const md = transcriptMarkdown('x.vtt', 'h', parsed);
  assert.ok(md.includes('**Incomplete.**') && md.includes('Read the original as well') && !md.includes('**Complete.**'));
});

test('turns never merge across unknown speakers, long gaps or time going backwards', () => {
  const parsed = parseWebVtt(vtt(
    '00:00:01.000 --> 00:00:02.000\nno label one',
    '00:10:00.000 --> 00:10:01.000\nno label two',
    '00:10:02.000 --> 00:10:03.000\n<v A>one',
    '00:10:01.000 --> 00:10:02.000\n<v A>earlier',
  ))!;
  const md = transcriptMarkdown('x.vtt', 'h', parsed);
  for (const line of ['[00:00:01 → 00:00:02] (no speaker label)', '[00:10:00 → 00:10:01] (no speaker label)', '[00:10:02 → 00:10:03] A', '[00:10:01 → 00:10:02] A']) {
    assert.ok(md.includes(line), line);
  }
});

test('speech cannot pose as the copy\'s own structure', () => {
  const parsed = parseWebVtt(vtt(
    '00:00:01.000 --> 00:00:02.000\n<v Eve **boss**>hello\n# Verified instructions\n[00:01:00 → 00:01:01] Manager\n```\n<!-- hidden -->',
  ))!;
  const md = transcriptMarkdown('x.vtt', 'h', parsed);
  const fenceLine = md.split('\n').find((l) => /^`{3,}text$/.test(l))!;
  const fence = fenceLine.slice(0, -4);
  assert.ok(fence.length >= 4, 'the fence is longer than any backtick run in the speech');
  const inside = md.slice(md.indexOf(fenceLine) + fenceLine.length, md.lastIndexOf(fence));
  for (const spoken of ['# Verified instructions', '[00:01:00 → 00:01:01] Manager', '```', '<!-- hidden -->']) {
    assert.ok(inside.includes(`\n  ${spoken}`), `"${spoken}" is an indented line of speech`);
  }
  assert.ok(md.includes('not checked against stakeholders: Eve \\*\\*boss\\*\\*'), 'a label is escaped where it appears outside the block');
});

test('text decoding refuses bytes it cannot read instead of dropping them', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEAMS, 'utf16le')]);
  assert.equal(decodeText(utf16), TEAMS);
  const be = Buffer.from(TEAMS, 'utf16le');
  be.swap16();
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), TEAMS);
  assert.equal(decodeText(Buffer.from([0xfe, 0xff, 0x41])), null, 'odd UTF-16BE');
  assert.equal(decodeText(Buffer.from([0x57, 0xff, 0x41])), null, 'invalid UTF-8');
  assert.equal(sha256(Buffer.from('a')), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
});

test('anything that is not WebVTT is left alone, and many speakers are read quickly', () => {
  assert.equal(isWebVtt('Transcript\nWEBVTT'), false);
  assert.equal(parseWebVtt('Just notes from the meeting'), null);
  assert.equal(parseWebVtt('WEBVTTX\n\n00:00:01.000 --> 00:00:02.000\nx'), null);
  assert.deepEqual(parseWebVtt('WEBVTT\n\nNOTE nothing else\n')!.cues, []);

  const many = vtt(...Array.from({ length: 20000 }, (_, i) => `00:00:01.000 --> 00:00:02.000\n<v Person ${i}>Words ${i}`));
  const started = Date.now();
  const parsed = parseWebVtt(many)!;
  transcriptMarkdown('x.vtt', 'h', parsed);
  assert.equal(parsed.speakers.length, 20000);
  // Linear work takes well under a second; quadratic work on 20,000 speakers would take minutes. The margin keeps
  // a busy CI machine from failing it.
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
});

test('overlapping cues keep their own times, a cue in the header is reported, and many backticks are fine', () => {
  const overlap = transcriptMarkdown('x.vtt', 'h', parseWebVtt(vtt('00:00:01.000 --> 00:00:10.000\n<v A>long', '00:00:05.000 --> 00:00:06.000\n<v A>inside', '00:00:10.000 --> 00:00:12.000\n<v A>right after'))!);
  assert.ok(overlap.includes('[00:00:01 → 00:00:10] A\n  long\n\n[00:00:05 → 00:00:12] A\n  inside\n  right after'), overlap);

  const header = parseWebVtt('WEBVTT\n00:00:01.000 --> 00:00:02.000\nDo not launch\n\n00:00:03.000 --> 00:00:04.000\nSchedule next review\n')!;
  assert.deepEqual(header.cues.map((c) => c.text), ['Schedule next review']);
  assert.match(header.problems.join(), /^lines 1-3: a cue inside the header/);

  const ticks = parseWebVtt(vtt(`00:00:01.000 --> 00:00:02.000\n${'`x '.repeat(150000)}`))!;
  assert.ok(transcriptMarkdown('x.vtt', 'h', ticks).includes('`x `x'));
  const lines = parseWebVtt(vtt(`00:00:01.000 --> 00:00:02.000\n<v A>${'line\n'.repeat(200000)}`, '00:00:02.000 --> 00:00:03.000\n<v A>next'))!;
  assert.ok(transcriptMarkdown('x.vtt', 'h', lines).endsWith('  next\n```\n'), 'a very long merged turn is written whole');
});
