import assert from 'node:assert/strict';
import { consentFor, speakerRows, speechLength, voiceTag } from './voiceprints';

const people = [{ id: 'STK-0001', name: 'Jane Doe' }, { id: 'STK-0002', name: 'Kim Park' }];
const base = { labels: ['Speaker 1', 'Speaker 2', 'Speaker 3'], names: [], suggestions: [], rememberable: ['Speaker 1', 'Speaker 2'], people, prints: [], enabled: true };

// A suggestion shows for an unnamed speaker, with the stakeholder's current name.
const suggested = speakerRows({ ...base, suggestions: [{ label: 'Speaker 2', ref: 'STK-0002', score: 0.91 }] });
assert.deepEqual(suggested[1]!.suggestion, { label: 'Speaker 2', ref: 'STK-0002', score: 0.91, name: 'Kim Park' });
assert.equal(suggested[0]!.suggestion, null);

// Never for a named speaker, nor for someone who is no longer a stakeholder.
const named = speakerRows({ ...base, names: [{ label: 'Speaker 2', name: 'Jane Doe', ref: 'STK-0001' }], suggestions: [{ label: 'Speaker 2', ref: 'STK-0002', score: 0.91 }] });
assert.equal(named[1]!.suggestion, null, 'a named speaker gets no suggestion');
assert.equal(speakerRows({ ...base, suggestions: [{ label: 'Speaker 1', ref: 'STK-0009', score: 0.9 }] })[0]!.suggestion, null, 'a person who is gone is never suggested');
assert.equal(speakerRows({ ...base, suggestions: [{ label: 'Speaker 1', ref: 'me', score: 0.9 }] })[0]!.suggestion?.name, 'you');

// Remembering: only a speaker named with a stakeholder, with speech of their own, whose voice is not remembered yet.
assert.equal(named[1]!.canRemember, true);
assert.equal(speakerRows({ ...base, names: [{ label: 'Speaker 1', name: 'Sam Rot' }] })[0]!.canRemember, false, 'a typed name is not a stakeholder');
assert.equal(speakerRows({ ...base, names: [{ label: 'Speaker 3', name: 'Jane Doe', ref: 'STK-0001' }] })[2]!.canRemember, false, 'no speech of their own');
const already = speakerRows({ ...base, names: [{ label: 'Speaker 1', name: 'Jane Doe', ref: 'STK-0001' }], prints: [{ ref: 'STK-0001', damaged: false }] })[0]!;
assert.equal(already.canRemember, false, 'remembered already: later naming adds to it by itself');
assert.equal(already.remembered, true);
assert.equal(speakerRows({ ...base, enabled: false, names: [{ label: 'Speaker 1', name: 'Jane Doe', ref: 'STK-0001' }] })[0]!.canRemember, false, 'off in Settings');

// Tags, worst first.
assert.deepEqual(voiceTag({ damaged: true, stakeholder: true, stale_model: false, ready: true }), { text: 'Cannot be read', warning: true });
assert.deepEqual(voiceTag({ damaged: false, stakeholder: false, stale_model: false, ready: true }), { text: 'No longer a stakeholder', warning: true });
assert.deepEqual(voiceTag({ damaged: false, stakeholder: true, stale_model: true, ready: true }), { text: 'Made with an older speaker model', warning: true });
assert.deepEqual(voiceTag({ damaged: false, stakeholder: true, stale_model: false, ready: false }), { text: 'Voice remembered, needs more speech', warning: false });
assert.deepEqual(voiceTag({ damaged: false, stakeholder: true, stale_model: false, ready: true }), { text: 'Voice remembered', warning: false });

assert.equal(consentFor('{person} agreed. Ask {person}.', 'Kim Park'), 'Kim Park agreed. Ask Kim Park.');
assert.equal(speechLength(45.4), '45 s');
assert.equal(speechLength(125), '2 min 5 s');
assert.equal(speechLength(120), '2 min');
console.log('voiceprints: ok');

// ---- the speakers panel ----
import { NOT_NAMED, personOf, personOptions, personValue, secondsOfTime, SOMEONE_ELSE, speakerEvidence, speakersSummary } from './voiceprints';

const ev = speakerEvidence([
  { time: '00:00:00', speaker: 'Speaker 1', text: 'Welcome back.' },
  { time: '00:00:07', speaker: 'Speaker 2', text: 'I shared the table.' },
  { time: '00:00:20', text: 'Not clear whose.' },
  { time: '00:00:27', speaker: 'Speaker 1', text: 'That matches.' },
]);
assert.deepEqual(ev.get('Speaker 1'), { first: { time: '00:00:00', text: 'Welcome back.' }, count: 2 });
assert.equal(ev.get('Speaker 2')?.count, 1);
assert.equal(secondsOfTime('01:02:03'), 3723);
assert.equal(secondsOfTime('02:03'), 123);
assert.equal(secondsOfTime('soon'), null);

const choices = [
  { option: 'Kim Park (STK-0002)', person: { name: 'Kim Park', ref: 'STK-0002' } },
  { option: 'Sam Rot', person: { name: 'Sam Rot' } },
  { option: 'Jane Doe (STK-0001)', person: { name: 'Jane Doe', ref: 'STK-0001' } },
];
const opts = personOptions({ label: 'Speaker 1', choices, expected: new Set(['STK-0002', 'name:sam rot']), names: [{ label: 'Speaker 2', name: 'Jane Doe', ref: 'STK-0001' }, { label: 'Speaker 1', name: 'Pat Typed' }] });
assert.deepEqual(opts.map((o) => [o.value, o.label, o.group]), [
  [NOT_NAMED, 'Not named yet', undefined],
  ['ref:me', 'You', 'Expected at this meeting'],
  ['ref:STK-0002', 'Kim Park (STK-0002)', 'Expected at this meeting'],
  ['name:Sam Rot', 'Sam Rot', 'Expected at this meeting'],
  ['ref:STK-0001', 'Jane Doe (STK-0001) · also Speaker 2', 'Other stakeholders'],
  ['name:Pat Typed', 'Pat Typed', 'Named by hand'],
  [SOMEONE_ELSE, 'Someone else…', undefined],
], 'expected people first, you among them, who is taken says so, a typed name stays');
const withMe = personOptions({ label: 'Speaker 1', choices: [{ option: 'Alex Morgan', person: { name: 'Alex Morgan', ref: 'me' } }], expected: new Set(['me']), names: [] });
assert.deepEqual(withMe[1], { value: 'ref:me', label: 'Alex Morgan (you)', group: 'Expected at this meeting' });
assert.deepEqual(personOf('ref:STK-0002', choices, []), { name: 'Kim Park', ref: 'STK-0002' });
assert.deepEqual(personOf('ref:me', choices, []), { name: 'Me', ref: 'me' });
assert.deepEqual(personOf('name:Pat Typed', choices, [{ label: 'Speaker 1', name: 'Pat Typed' }]), { name: 'Pat Typed' });
assert.equal(personOf(NOT_NAMED, choices, []), null);
assert.equal(personOf(SOMEONE_ELSE, choices, []), null);
assert.equal(personValue({ name: 'Kim Park', ref: 'STK-0002' }), 'ref:STK-0002');

assert.equal(speakersSummary([{ named: undefined, suggestion: { label: 'Speaker 1', ref: 'me', score: 0.9, name: 'you' } }, { named: { label: 'Speaker 2', name: 'Kim' }, suggestion: null }, { named: undefined, suggestion: null }]), '3 speakers · 1 named · 1 suggestion to review');
assert.equal(speakersSummary([{ named: { label: 'Speaker 1', name: 'Kim' }, suggestion: null }]), '1 speaker · all named');
console.log('speakers panel: ok');
