import { tr } from '@/i18n/current';
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
  if (m < 1) return tr('transcriptionSpeed.underAMinute');
  if (m < 90) return tr('transcriptionSpeed.aboutMin', { m: Math.round(m) });
  return tr('transcriptionSpeed.aboutHours', { value: Math.round(m / 6) / 10 });
}

/** One line for a model's card. */
export function describeSpeed(realtime: number): { line: string; live: 'yes' | 'maybe' | 'no' } {
  const hour = minutes(60 / realtime);
  const live = realtime >= LIVE_X ? 'yes' : realtime >= AFTER_X ? 'maybe' : 'no';
  // Rules of thumb for the room a video call needs next to it, not measurements of one.
  const liveText = live === 'yes' ? tr('transcriptionSpeed.likelyEnoughRoomToTranscribe')
    : live === 'maybe' ? tr('transcriptionSpeed.transcribingWhileRecordingMaySlow')
      : tr('transcriptionSpeed.likelyTooSlowToTranscribe');
  return { line: tr('transcriptionSpeed.onThisComputerAboutReal', { realtime, hour, liveText }), live };
}

/**
 * The model to suggest for this computer: the first measured one in the catalog's order (most accurate first) that
 * gets an hour done in 15 minutes, else the fastest measured. Null until a model was measured.
 */
export function recommendModel(models: { id: string; name: string; speed: { realtime_x: number } | null; gpu?: unknown }[]): { id: string; name: string; reason: string } | null {
  // A GPU model is chosen by its own test, not recommended next to the CPU ones.
  models = models.filter((m) => !m.gpu);
  const measured = models.filter((m) => m.speed);
  if (measured.length === 0) return null;
  const quick = measured.find((m) => m.speed!.realtime_x >= AFTER_X);
  if (quick) return { id: quick.id, name: quick.name, reason: measured.length < models.length ? tr('transcriptionSpeed.theMostAccurateOfThe') : tr('transcriptionSpeed.theMostAccurateOneThat') };
  const fastest = measured.reduce((a, b) => (b.speed!.realtime_x > a.speed!.realtime_x ? b : a));
  return { id: fastest.id, name: fastest.name, reason: tr('transcriptionSpeed.theFastestOneTestedNone') };
}

/**
 * Below this, a GPU model is not offered with a button for the live transcript: it leaves too little headroom to follow
 * a meeting, before a call even shares the graphics chip. Not a call-safe threshold; that comes from measurements next
 * to a call.
 */
export const GPU_LIVE_X = 2;

/**
 * A GPU model that showed here it runs on the graphics chip, offered for the live transcript while another live model
 * (or none) is chosen. Null when there is nothing to offer.
 */
export function gpuLiveOffer(models: { id: string; name: string; installed: boolean; gpu?: unknown; gpu_ready?: boolean; speed: { realtime_x: number } | null }[], liveModel: string | null): { id: string; name: string; realtime_x: number } | null {
  const ready = models.find((m) => m.gpu && m.gpu_ready && m.installed && m.speed);
  return ready && ready.id !== liveModel ? { id: ready.id, name: ready.name, realtime_x: ready.speed!.realtime_x } : null;
}
