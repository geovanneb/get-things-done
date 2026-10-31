/**
 * Unit tests for the error message of a failed request. Run with `npm run test:api-errors --workspace=ui`.
 */
import { errorMessage } from './api';

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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll API error checks passed.');
