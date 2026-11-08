import { spawn, type ChildProcess } from 'node:child_process';

export const SERVICE_TYPE = '_gtd-inbox._tcp';

/**
 * Lets a paired phone find this computer, on a hotspot or a shared network, whatever address it was given. macOS
 * ships `dns-sd`, so this adds no dependency. Elsewhere there is no announcement, and a phone uses the addresses from
 * the pairing code instead.
 */
export function announce(name: string, port: number, fingerprint: string, launch = spawn): () => void {
  if (process.platform !== 'darwin') return () => {};
  let child: ChildProcess | null = launch('dns-sd', ['-R', name, SERVICE_TYPE, 'local', String(port), 'v=1', `fp=${fingerprint}`], { stdio: 'ignore' });
  child.on('error', () => { child = null; });
  return () => { child?.kill(); child = null; };
}
