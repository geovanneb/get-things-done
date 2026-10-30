import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemAudioSupport } from '../src/systemAudio';

test("the computer's sound is offered on Windows and on macOS 14.2 or later only", () => {
  assert.equal(systemAudioSupport('win32', '10.0.26100'), 'yes');
  assert.equal(systemAudioSupport('darwin', '23.2.0'), 'yes', 'macOS 14.2');
  assert.equal(systemAudioSupport('darwin', '27.2.0'), 'yes');
  assert.match(systemAudioSupport('darwin', '23.1.0'), /macOS 14\.2 or later/, 'macOS 14.1');
  assert.match(systemAudioSupport('darwin', '22.6.0'), /macOS 14\.2 or later/, 'macOS 13');
  assert.match(systemAudioSupport('linux', '6.8.0'), /not available/);
});
