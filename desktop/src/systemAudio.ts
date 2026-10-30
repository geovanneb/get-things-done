import * as os from 'os';

/**
 * Whether the computer's own sound can be recorded: Windows, and macOS 14.2 or later (Core Audio taps, which macOS
 * gates behind its System Audio Recording permission). Darwin 23.2 is macOS 14.2.
 */
export function systemAudioSupport(platform = process.platform, release = os.release()): string {
  if (platform === 'win32') return 'yes';
  if (platform === 'darwin') {
    const [major = 0, minor = 0] = release.split('.').map(Number);
    return major > 23 || (major === 23 && minor >= 2) ? 'yes' : "Recording the computer's sound needs macOS 14.2 or later; only the microphone is recorded.";
  }
  return "Recording the computer's sound is not available on this system; only the microphone is recorded.";
}
