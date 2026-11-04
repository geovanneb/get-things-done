/**
 * Unit tests for the desktop bridge and its browser fallback. Run with `npm run test:desktop-bridge --workspace=ui`.
 */
import { followDesktopUpdate, hasDesktopUpdates, isDesktopApp, openWorkspaceFolder, pickFolder, readDesktopUpdate, restartToUpdate } from './desktop';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const g = globalThis as Record<string, unknown>;
const calls: string[] = [];
g.fetch = async (url: string) => {
  calls.push(url);
  const body = url.endsWith('/pick-folder') ? { path: '/Users/demo/Northwind' } : { opened: true };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

async function main() {
  // Browser: no bridge, the server routes are used.
  check('a browser tab is not the desktop app', !isDesktopApp());
  check('the browser picker asks the server', (await pickFolder()) === '/Users/demo/Northwind' && calls.includes('/api/workspace/pick-folder'));
  await openWorkspaceFolder();
  check('the browser opens the folder through the server', calls.includes('/api/workspace/open'));

  // Desktop: the bridge is used and the server is not called.
  calls.length = 0;
  g.gtdDesktop = {
    version: 1,
    pickFolder: async () => 'C:\\Users\\demo\\Northwind',
    openWorkspaceFolder: async () => ({ opened: false, error: 'Folder not found' }),
  };
  check('the bridge marks the desktop app', isDesktopApp());
  check('the desktop picker uses the native dialog', (await pickFolder()) === 'C:\\Users\\demo\\Northwind');
  let error = '';
  try { await openWorkspaceFolder(); } catch (err) { error = (err as Error).message; }
  check('a failed open shows the reason', error === 'Folder not found', error);
  check('the desktop app does not call the server routes', calls.length === 0, calls.join(', '));

  // Something else on window named gtdDesktop is ignored.
  g.gtdDesktop = { pickFolder: 'nope' };
  check('an object without a version is not the bridge', !isDesktopApp());

  // The app's own update (#284): what the page accepts from the bridge.
  check('a ready update is read', JSON.stringify(readDesktopUpdate({ phase: 'ready', version: '0.11.0', percent: null, error: null, dismissed: '0.10.5' })) === JSON.stringify({ phase: 'ready', version: '0.11.0', percent: null, error: null, dismissed: '0.10.5' }));
  check('progress is kept between 0 and 100', readDesktopUpdate({ phase: 'downloading', version: '0.11.0', percent: 140.2 })?.percent === 100);
  check('an unknown phase or no object is no state', readDesktopUpdate({ phase: 'install-now' }) === null && readDesktopUpdate(null) === null && readDesktopUpdate('ready') === null);
  check('odd fields are dropped', readDesktopUpdate({ phase: 'error', version: 7, error: 'x'.repeat(400) })?.error === null);
  check('a browser has no desktop updates', !hasDesktopUpdates() && (await restartToUpdate()) === 'Only the desktop app restarts itself');
  const seen: string[] = [];
  let push: (s: unknown) => void = () => undefined;
  g.gtdDesktop = {
    version: 1,
    updateState: async () => ({ phase: 'downloading', version: '0.11.0', percent: 10 }),
    onUpdateState: (l: (s: unknown) => void) => { push = l; return () => { push = () => undefined; }; },
    restartToUpdate: async () => 'A transcription is running: restart to update when it is done',
  };
  const stop = followDesktopUpdate((s) => seen.push(`${s.phase}:${s.percent ?? ''}`));
  await new Promise((r) => setTimeout(r, 0));
  push({ phase: 'ready', version: '0.11.0' });
  push({ phase: 'bogus' });
  stop();
  push({ phase: 'idle' });
  check('the state now, then each change, until stopped', seen.join(',') === 'downloading:10,ready:', seen.join(','));
  check('a restart that has to wait says why', hasDesktopUpdates() && (await restartToUpdate()) === 'A transcription is running: restart to update when it is done');
  // A change pushed before the first answer arrives is newer: the late answer is dropped.
  let answer: (s: unknown) => void = () => undefined;
  const order: string[] = [];
  (g.gtdDesktop as Record<string, unknown>)['updateState'] = () => new Promise((r) => { answer = r; });
  const stop2 = followDesktopUpdate((s) => order.push(s.phase));
  push({ phase: 'ready', version: '0.11.0' });
  answer({ phase: 'downloading', version: '0.11.0', percent: 90 });
  await new Promise((r) => setTimeout(r, 0));
  stop2();
  check('an older first answer never replaces a newer pushed state', order.join(',') === 'ready', order.join(','));
  delete g.gtdDesktop;

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll desktop bridge checks passed');
}

void main();
