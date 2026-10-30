/**
 * What a measured speed means for the person using it. The test is clean continuous speech; a real meeting has pauses
 * but harder speech, and the two roughly cancel out: measured on a real 10-minute meeting, Whisper ran at 4.6× against
 * 4.9× in the test, SenseVoice at 96× against 86×. So the test's speed stands for an hour of meeting.
 */

/** Fast enough to transcribe while recording, with room left for a video call on the same computer. */
const LIVE_X = 10;
/** Fast enough that a long meeting's transcript is ready soon after it ends: an hour in 15 minutes. */
const AFTER_X = 4;

function minutes(m: number): string {
  if (m < 1) return 'under a minute';
  if (m < 90) return `about ${Math.round(m)} min`;
  return `about ${Math.round(m / 6) / 10} hours`;
}

/** One line for a model's card. */
export function describeSpeed(realtime: number): { line: string; live: 'yes' | 'maybe' | 'no' } {
  const hour = minutes(60 / realtime);
  const live = realtime >= LIVE_X ? 'yes' : realtime >= AFTER_X ? 'maybe' : 'no';
  // Rules of thumb for the room a video call needs next to it, not measurements of one.
  const liveText = live === 'yes' ? 'likely enough room to transcribe while recording'
    : live === 'maybe' ? 'transcribing while recording may slow a video call'
      : 'likely too slow to transcribe while recording next to a call';
  return { line: `On this computer: about ${realtime}× real time, so an hour of meeting takes ${hour}; by rule of thumb, ${liveText}. An estimate from a short sample: other work on the computer slows it.`, live };
}

/**
 * The model to suggest for this computer: the first measured one in the catalog's order (most accurate first) that
 * gets an hour done in 15 minutes, else the fastest measured. Null until a model was measured.
 */
export function recommendModel(models: { id: string; name: string; speed: { realtime_x: number } | null }[]): { id: string; name: string; reason: string } | null {
  const measured = models.filter((m) => m.speed);
  if (measured.length === 0) return null;
  const quick = measured.find((m) => m.speed!.realtime_x >= AFTER_X);
  if (quick) return { id: quick.id, name: quick.name, reason: measured.length < models.length ? 'the most accurate of the tested ones that is quick enough here' : 'the most accurate one that is quick enough on this computer' };
  const fastest = measured.reduce((a, b) => (b.speed!.realtime_x > a.speed!.realtime_x ? b : a));
  return { id: fastest.id, name: fastest.name, reason: 'the fastest one tested; none of them is quick on this computer' };
}
