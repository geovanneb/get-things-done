import * as fsp from 'fs/promises';

/**
 * A streaming reader for WAV files: the format the transcription worker reads. Recordings in other formats are
 * converted to WAV first. Files can be hours long (an 8-hour meeting is about 900 MB at 16 kHz), so the audio is
 * read in chunks and never held in memory whole.
 */

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  encoding: 'pcm' | 'float';
  /** Where the samples start, and how many bytes of them there are. */
  dataOffset: number;
  dataBytes: number;
  /** Length in seconds. */
  duration: number;
}

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

export class WavError extends Error {}

/** Reads the header: the format chunk and where the data chunk is. Throws a WavError for anything it cannot read. */
export async function readWavFormat(file: string): Promise<WavFormat> {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (offset: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    };
    const head = await read(0, 12);
    if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new WavError('Not a WAV file.');
    let fmt: Omit<WavFormat, 'dataOffset' | 'dataBytes' | 'duration'> | null = null;
    let offset = 12;
    // Chunks in any order; at most a few hundred, so a damaged file cannot keep the reader busy.
    for (let n = 0; n < 512 && offset + 8 <= size; n++) {
      const header = await read(offset, 8);
      const id = header.toString('ascii', 0, 4);
      const length = header.readUInt32LE(4);
      const body = offset + 8;
      if (id === 'fmt ') {
        const f = await read(body, Math.min(length, 40));
        if (f.length < 16) throw new WavError('The WAV format chunk is too short.');
        let tag = f.readUInt16LE(0);
        const channels = f.readUInt16LE(2);
        const sampleRate = f.readUInt32LE(4);
        const bitsPerSample = f.readUInt16LE(14);
        if (tag === EXTENSIBLE && f.length >= 26) tag = f.readUInt16LE(24);
        const encoding = tag === PCM ? 'pcm' : tag === FLOAT ? 'float' : null;
        if (!encoding) throw new WavError(`This WAV encoding (${tag}) is not supported; use PCM or 32-bit float.`);
        if (encoding === 'pcm' && ![16, 24, 32].includes(bitsPerSample)) throw new WavError(`${bitsPerSample}-bit PCM WAV is not supported.`);
        if (encoding === 'float' && bitsPerSample !== 32) throw new WavError(`${bitsPerSample}-bit float WAV is not supported.`);
        if (channels < 1 || channels > 16) throw new WavError(`A WAV file with ${channels} channels is not supported.`);
        if (sampleRate < 4000 || sampleRate > 384000) throw new WavError(`A sample rate of ${sampleRate} Hz is not supported.`);
        fmt = { sampleRate, channels, bitsPerSample, encoding };
      } else if (id === 'data') {
        if (!fmt) throw new WavError('The WAV data comes before its format.');
        // A recorder that stopped early may leave the length unset or too large: the data then runs to the end.
        const available = size - body;
        const blockAlign = fmt.channels * (fmt.bitsPerSample / 8);
        const dataBytes = Math.floor(Math.min(length === 0xffffffff || length === 0 ? available : length, available) / blockAlign) * blockAlign;
        return { ...fmt, dataOffset: body, dataBytes, duration: dataBytes / blockAlign / fmt.sampleRate };
      }
      offset = body + length + (length % 2);
    }
    throw new WavError('The WAV file has no audio data.');
  } finally {
    await handle.close();
  }
}

/**
 * The audio as mono float samples, a chunk at a time (about `seconds` long each). Channels are averaged; nothing
 * is resampled here.
 */
export async function* wavChunks(file: string, format: WavFormat, seconds = 1): AsyncGenerator<Float32Array> {
  const bytes = format.bitsPerSample / 8;
  const frame = bytes * format.channels;
  const framesPerChunk = Math.max(1, Math.round(format.sampleRate * seconds));
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(framesPerChunk * frame);
    for (let done = 0; done < format.dataBytes;) {
      const want = Math.min(buffer.length, format.dataBytes - done);
      const { bytesRead } = await handle.read(buffer, 0, want, format.dataOffset + done);
      if (bytesRead <= 0) break;
      const frames = Math.floor(bytesRead / frame);
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < format.channels; c++) sum += sample(buffer, i * frame + c * bytes, format);
        out[i] = sum / format.channels;
      }
      done += frames * frame;
      if (frames > 0) yield out;
      if (bytesRead < want) break;
    }
  } finally {
    await handle.close();
  }
}

function sample(buffer: Buffer, at: number, format: WavFormat): number {
  if (format.encoding === 'float') return buffer.readFloatLE(at);
  if (format.bitsPerSample === 16) return buffer.readInt16LE(at) / 32768;
  if (format.bitsPerSample === 24) return buffer.readIntLE(at, 3) / 8388608;
  return buffer.readInt32LE(at) / 2147483648;
}
