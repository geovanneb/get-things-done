/**
 * The microphone and, when it is recorded too, the computer's own sound, mixed into one recording. A compressor keeps
 * two people talking at once from clipping. Each source gets its own meter, so the page can show that both arrive.
 */
export interface Meters {
  /** The loudest sound of each source since it was last read, 0 to 1. */
  microphone: () => number;
  system: (() => number) | null;
}

function meter(context: AudioContext, source: AudioNode): () => number {
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return () => {
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const v of samples) peak = Math.max(peak, Math.abs(v));
    return peak;
  };
}

export function mixSources(context: AudioContext, into: AudioNode, microphone: MediaStream, system: MediaStream | null): Meters {
  const mic = context.createMediaStreamSource(microphone);
  if (!system) {
    mic.connect(into);
    return { microphone: meter(context, mic), system: null };
  }
  const mix = context.createDynamicsCompressor();
  mix.threshold.value = -12;
  mix.ratio.value = 4;
  mix.connect(into);
  const other = context.createMediaStreamSource(system);
  mic.connect(mix);
  other.connect(mix);
  return { microphone: meter(context, mic), system: meter(context, other) };
}
