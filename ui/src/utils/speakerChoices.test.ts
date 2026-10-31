import assert from 'node:assert/strict';
import { speakerChoices } from './speakerChoices';
import type { Stakeholder } from '@/types';

const people = [{ id: 'STK-0001', name: 'Jane Doe' }, { id: 'STK-0002', name: 'Kim Park' }, { id: 'STK-0003', name: 'Kim Park' }] as Stakeholder[];
const choices = speakerChoices([{ name: 'Kim Park', ref: 'STK-0002' }, { name: 'Sam Rot' }], people);
assert.deepEqual(choices.map((c) => c.option), ['Kim Park (STK-0002)', 'Sam Rot', 'Jane Doe (STK-0001)', 'Kim Park (STK-0003)'], 'expected people first, each once, two people of one name apart');
assert.deepEqual(choices[1]!.person, { name: 'Sam Rot' }, 'someone who is no stakeholder stays a name');
assert.deepEqual(speakerChoices([], []), []);
const renamed = speakerChoices([{ name: 'Alex Vale', ref: 'STK-0001' }], [{ id: 'STK-0001', name: 'Alex River' }] as Stakeholder[]);
assert.deepEqual(renamed.map((c) => c.option), ['Alex River (STK-0001)'], 'a stakeholder renamed since is offered once, by the name they have now');
assert.deepEqual(speakerChoices([{ name: 'Gone', ref: 'STK-0009' }], []).map((c) => c.option), ['Gone (STK-0009)'], 'the name entered, when the stakeholder is not found');
console.log('speaker choices: ok');
