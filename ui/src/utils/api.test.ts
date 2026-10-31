import assert from 'node:assert/strict';
import { handleResponse } from './api';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const messageOf = (err: unknown) => (err as Error).message;

// The API's error handler sends { error: err.name, message: err.message }; the
// class name is "Error", so the message has to win.
await assert.rejects(
  handleResponse(jsonResponse(400, { error: 'Error', message: 'Invalid max_meetings: use a whole number from 1 to 20' })),
  (err) => messageOf(err) === 'Invalid max_meetings: use a whole number from 1 to 20',
  'the message wins over a generic error name',
);

await assert.rejects(
  handleResponse(jsonResponse(409, { error: 'Another recording is open ("Crash test meeting"): finish or discard it first' })),
  (err) => messageOf(err) === 'Another recording is open ("Crash test meeting"): finish or discard it first',
  'a body that only has error still surfaces',
);

await assert.rejects(
  handleResponse(new Response('not json', { status: 502, statusText: 'Bad Gateway' })),
  (err) => messageOf(err) === 'HTTP 502: Bad Gateway',
  'a non-JSON body falls back to the HTTP status',
);
