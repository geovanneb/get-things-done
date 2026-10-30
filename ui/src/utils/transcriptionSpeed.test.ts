/**
 * Unit tests for what a measured speed means. Run with: npm run test:transcription-speed --workspace=ui
 */
import { describeSpeed, recommendModel } from './transcriptionSpeed';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const fast = describeSpeed(83);
check('a fast model is fine to run while recording', fast.live === 'yes' && fast.line.includes('under a minute'), fast.line);
const mid = describeSpeed(5);
check('a middling one may slow a call', mid.live === 'maybe' && mid.line.includes('about 12 min'), mid.line);
const slow = describeSpeed(2.2);
check('a slow one is too slow for live, and says how long an hour takes', slow.live === 'no' && slow.line.includes('about 27 min'), slow.line);
check('very slow is said in hours', describeSpeed(0.5).line.includes('about 2 hours'), describeSpeed(0.5).line);

const whisper = { id: 'whisper', name: 'Whisper', speed: null as { realtime_x: number } | null };
const sense = { id: 'sense', name: 'SenseVoice', speed: null as { realtime_x: number } | null };
check('nothing measured, nothing recommended', recommendModel([whisper, sense]) === null);
check('the accurate one when it is quick enough', recommendModel([{ ...whisper, speed: { realtime_x: 6 } }, { ...sense, speed: { realtime_x: 80 } }])?.id === 'whisper');
check('the next one when the accurate one is too slow', recommendModel([{ ...whisper, speed: { realtime_x: 2.2 } }, { ...sense, speed: { realtime_x: 80 } }])?.id === 'sense');
check('the fastest when all are slow', recommendModel([{ ...whisper, speed: { realtime_x: 0.5 } }, { ...sense, speed: { realtime_x: 3 } }])?.id === 'sense');
check('only one measured: that one if it is quick', recommendModel([whisper, { ...sense, speed: { realtime_x: 80 } }])?.id === 'sense');

console.log(failures ? `\n${failures} failed` : '\nAll transcription speed tests passed');
process.exit(failures ? 1 : 0);
