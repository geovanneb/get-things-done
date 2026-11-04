import { execFile } from 'child_process';

const MAC_CONVERTER = '/usr/bin/afconvert';

/** Converts a recording to 16 kHz mono WAV with the Mac's own converter. Stops with `signal`. */
export function convertToWav(source: string, target: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('This recording format can be converted on a Mac only; use WAV on this computer.'));
  return new Promise((resolve, reject) => {
    execFile(MAC_CONVERTER, ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', source, target], { signal, timeout: 60 * 60 * 1000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(signal.aborted ? 'Cancelled.' : `The recording could not be converted: ${String(stderr || err.message).trim().split('\n').pop()}`));
      else resolve();
    });
  });
}
