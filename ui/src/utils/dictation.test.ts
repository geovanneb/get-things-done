/**
 * Unit tests for dictation. Run with: npm run test:dictation --workspace=ui
 */
import { clock, dictationModels, pickDictationModel, wavFile, withDictation } from './dictation';
import type { Transcription, TranscriptionModel } from '../types';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const model = (id: string, extra: Partial<TranscriptionModel> = {}) => ({ id, name: `Fictional ${id}`, installed: true, ...extra }) as TranscriptionModel;
const overview = (models: TranscriptionModel[], chosen = 'turbo', effective?: string) =>
  ({ models, settings: { model: chosen }, ...(effective ? { effective_model: effective } : {}) }) as unknown as Transcription;

// Which models are offered.
const list = dictationModels(overview([
  model('turbo'),
  model('large'),
  model('missing', { installed: false }),
  model('gpu-untested', { gpu: { cpu: 'turbo' } }),
  model('gpu-ready', { gpu: { cpu: 'turbo' }, gpu_ready: true }),
]));
check('only downloaded models, and a GPU model only once it ran on the GPU here', JSON.stringify(list.map((m) => m.id)) === JSON.stringify(['turbo', 'large', 'gpu-ready']), JSON.stringify(list));
check('nothing downloaded, or the list could not be read: no model', dictationModels(overview([model('turbo', { installed: false })])).length === 0 && dictationModels(null).length === 0);

// Which one is chosen.
const two = [{ id: 'turbo', name: 'T' }, { id: 'large', name: 'L' }];
check('the one this browser used last', pickDictationModel(two, overview([], 'turbo'), 'large') === 'large');
check('a remembered model that was removed is not used', pickDictationModel(two, overview([], 'turbo'), 'gone') === 'turbo');
check('else the model transcriptions run with', pickDictationModel(two, overview([], 'gpu-untested', 'large'), null) === 'large');
check('else the one chosen in Settings', pickDictationModel(two, overview([], 'large'), null) === 'large');
check('else the first downloaded one', pickDictationModel(two, overview([], 'not-downloaded'), null) === 'turbo');
check('none downloaded: none', pickDictationModel([], overview([]), 'turbo') === null);

// The clip the server reads.
const wav = wavFile([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])]);
const view = new DataView(wav.buffer);
const text = (at: number, n: number) => String.fromCharCode(...wav.slice(at, at + n));
check('a WAV header: RIFF, WAVE, PCM 16-bit mono at 16 kHz', text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE' && text(12, 4) === 'fmt '
  && view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 && view.getUint32(24, true) === 16000 && view.getUint16(34, true) === 16);
check('lengths match the audio', view.getUint32(4, true) === 36 + 6 && text(36, 4) === 'data' && view.getUint32(40, true) === 6 && wav.length === 50);
check('the blocks in order after the header', JSON.stringify([...wav.slice(44)]) === JSON.stringify([1, 2, 3, 4, 5, 6]));
check('no audio: a valid empty clip', wavFile([]).length === 44);

// Adding the text to the field.
check('an empty field gets the text', withDictation('', '  Fictional goal.  ') === 'Fictional goal.');
check('a blank field gets the text', withDictation('  \n', 'Fictional goal.') === 'Fictional goal.');
check('after text, a space apart', withDictation('First idea.', 'Second idea.') === 'First idea. Second idea.');
check('after a space or a new line, nothing more', withDictation('First idea.\n', 'Second.') === 'First idea.\nSecond.' && withDictation('First ', 'Second.') === 'First Second.');
check('nothing heard: the field is unchanged', withDictation('Kept.', '   ') === 'Kept.');

check('a clock', clock(0) === '0:00' && clock(9.9) === '0:09' && clock(75) === '1:15' && clock(300) === '5:00');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll dictation checks passed');
