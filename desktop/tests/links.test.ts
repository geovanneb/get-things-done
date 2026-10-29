import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { classifyLink } from '../src/links';
import { findFreePort } from '../src/port';

const origin = 'http://127.0.0.1:3001';

test('links to the app stay in the app', () => {
  assert.equal(classifyLink('http://127.0.0.1:3001/board', origin), 'app');
  assert.equal(classifyLink('http://127.0.0.1:3001/api/workspace/files/tasks/demo.md?download=1', origin), 'app');
});

test('web pages and e-mail go to the system apps', () => {
  assert.equal(classifyLink('https://github.com/anthropics/skills', origin), 'external');
  assert.equal(classifyLink('mailto:alex@northwind.example', origin), 'external');
  // Another local server is not the app.
  assert.equal(classifyLink('http://127.0.0.1:3002/', origin), 'external');
  assert.equal(classifyLink('http://localhost:3001/', origin), 'external');
});

test('other schemes are blocked', () => {
  for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'vscode://file/x', 'data:text/html,hi', 'not a url']) {
    assert.equal(classifyLink(url, origin), 'block', url);
  }
});

test('findFreePort keeps a free preferred port and skips a busy one', async () => {
  const blocker = net.createServer();
  const busy = await new Promise<number>((resolve) => {
    blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port));
  });
  try {
    assert.notEqual(await findFreePort(busy), busy);
  } finally {
    blocker.close();
  }
  const free = await findFreePort(busy);
  assert.equal(free, busy);
});
