import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stopServer } from '../src/server-lifecycle';

class Child extends EventEmitter {
  messages: unknown[] = [];
  kills = 0;
  kill() { this.kills++; this.emit('killed'); return true; }
  postMessage(message: unknown) { this.messages.push(message); }
}

test('graceful shutdown waits for exit and cancels forced kill', async () => {
  const child = new Child();
  let complete = false;
  const stop = stopServer(child, 10).then(() => { complete = true; });
  assert.deepEqual(child.messages, [{ type: 'shutdown' }]);
  await Promise.resolve();
  assert.equal(complete, false);
  child.emit('exit');
  await stop;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(child.kills, 0);
});

test('forced shutdown still waits for process exit before installation can proceed', async () => {
  const child = new Child();
  const killed = new Promise<void>((resolve) => child.once('killed', resolve));
  let complete = false;
  const stop = stopServer(child, 1).then(() => { complete = true; });
  await killed;
  await Promise.resolve();
  assert.equal(child.kills, 1);
  assert.equal(complete, false);
  child.emit('exit');
  await stop;
  assert.equal(complete, true);
});

test('shutdown without a running server completes', async () => {
  await stopServer(null);
});
