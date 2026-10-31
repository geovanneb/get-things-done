import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_TTL_MS, RecordingCommands } from '../src/recording-commands';

test('a menu command is taken once by the page', () => {
  const commands = new RecordingCommands(() => 1000);
  assert.equal(commands.take(), null, 'nothing waits at first');
  commands.leave('open');
  assert.equal(commands.take(), 'open');
  assert.equal(commands.take(), null, 'a second listener never acts on the same click');
});

test('a newer command replaces one the page has not taken', () => {
  const commands = new RecordingCommands(() => 1000);
  commands.leave('open');
  commands.leave('stop');
  assert.equal(commands.take(), 'stop');
});

test('a language never replaces a Stop, and goes with its recording', () => {
  let now = 1000;
  const commands = new RecordingCommands(() => now);
  commands.leave('stop');
  commands.leave('language:ja');
  assert.equal(commands.take(), 'stop');
  commands.leave('language:ja');
  commands.leave('language:en');
  assert.equal(commands.take(), 'language:en');
  commands.leave('language:ja');
  commands.dropLanguage();
  assert.equal(commands.take(), null);
  commands.leave('stop');
  commands.dropLanguage();
  assert.equal(commands.take(), 'stop');
  commands.leave('stop');
  now += COMMAND_TTL_MS + 1;
  commands.leave('language:ko');
  assert.equal(commands.take(), 'language:ko', 'a Stop too old to count');
});

test('a command left long ago does not open the dialog out of nowhere', () => {
  let now = 1000;
  const commands = new RecordingCommands(() => now);
  commands.leave('open');
  now += COMMAND_TTL_MS + 1;
  assert.equal(commands.take(), null);
  commands.leave('open');
  now += COMMAND_TTL_MS;
  assert.equal(commands.take(), 'open', 'still in time at the limit');
});
