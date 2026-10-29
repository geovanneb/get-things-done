/**
 * Unit tests for the desktop bridge and its browser fallback. Run with `npm run test:desktop-bridge --workspace=ui`.
 */
import { isDesktopApp, openWorkspaceFolder, pickFolder } from './desktop';

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

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll desktop bridge checks passed');
}

void main();
