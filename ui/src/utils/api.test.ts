/**
 * Unit tests for the error message of a failed request. Run with `npm run test:api-errors --workspace=ui`.
 */
import { apiFor, errorMessage } from './api';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const fallback = 'HTTP 400: Bad Request';
const cases: [string, unknown, string][] = [
  ['the message, not the generic name', { error: 'Error', message: 'Invalid max_meetings: use a whole number from 1 to 20' }, 'Invalid max_meetings: use a whole number from 1 to 20'],
  ['the message, not the status name', { error: 'Bad Request', message: 'No file provided' }, 'No file provided'],
  ['a route that sends only error', { error: 'Invalid window: days must be 7, 30, 90 or all' }, 'Invalid window: days must be 7, 30, 90 or all'],
  ['an empty message falls back to error', { error: 'Not found', message: '' }, 'Not found'],
  ['nothing usable', { details: 1 }, fallback],
  ['not an object', 'oops', fallback],
  ['null', null, fallback],
];
for (const [name, body, expected] of cases) {
  const got = errorMessage(body, fallback);
  check(name, got === expected, got);
}

// Requests bound to a page's workspace (#246 follow-up): each says which; plain ones say nothing.
const sent: { url: string; header: string | null }[] = [];
(globalThis as { fetch: unknown }).fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
  sent.push({ url, header: init?.headers?.['X-GTD-Workspace'] ?? null });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
(async () => {
  const api = apiFor('/Users/demo/Northwind Labs');
  await api.get('/api/runner');
  await api.post('/api/context-updates/CU-2026-0001/approve', {});
  await api.put('/api/x', {});
  await api.patch('/api/x', {});
  await api.del('/api/context-updates/CU-2026-0001/materials/a.md');
  const enc = encodeURIComponent('/Users/demo/Northwind Labs');
  check('every request of the page says its workspace, also outside the update\'s own paths', sent.length === 5 && sent.every((r) => r.header === enc), JSON.stringify(sent));
  check('a link carries it in the address', api.link('/api/context-updates/CU-2026-0001/materials/a.md') === `/api/context-updates/CU-2026-0001/materials/a.md?workspace=${enc}`);
  sent.length = 0;
  const plain = apiFor(undefined);
  await plain.get('/api/runner');
  check('without a workspace, plain requests and links', sent[0]?.header === null && plain.link('/x') === '/x');
    if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll API checks passed.');
})();
