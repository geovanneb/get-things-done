import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { AddressInfo } from 'node:net';
import express from 'express';
import multer from 'multer';
import { errorHandler } from '../src/middleware/errorHandler';

/** The upload setup the routes use (memory storage, a size limit, one "file" field), with a tiny limit. */
async function uploadServer(t: { after: (fn: () => void) => void }, limit: number) {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: limit } });
  const app = express();
  const received: number[] = [];
  app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) { res.status(400).json({ error: 'Bad Request', message: 'No file uploaded' }); return; }
    if (req.file.originalname === 'refused.txt') throw Object.assign(new Error('Invalid attachment name'), { statusCode: 400 });
    received.push(req.file.size);
    res.status(201).json({ size: req.file.size });
  });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`, received, port: (server.address() as AddressInfo).port };
}

function form(field: string, bytes: number, filename = 'a.txt') {
  const body = new FormData();
  body.append(field, new Blob([Buffer.alloc(bytes, 'x')]), filename);
  return body;
}

test('the size limit is the largest size accepted: one byte more is 413', async (t) => {
  const { url } = await uploadServer(t, 4);
  assert.equal((await fetch(url, { method: 'POST', body: form('file', 4) })).status, 201);
  assert.equal((await fetch(url, { method: 'POST', body: form('file', 0) })).status, 201);
  assert.equal((await fetch(url, { method: 'POST', body: form('file', 5) })).status, 413);
});

test('a missing file is 400 and a file in another field is 400', async (t) => {
  const { url } = await uploadServer(t, 4);
  assert.equal((await fetch(url, { method: 'POST', body: new FormData() })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', body: form('other', 1) })).status, 400);
});

test('an error after the whole upload was read still gets an answer', async (t) => {
  const { url } = await uploadServer(t, 4);
  const res = await fetch(url, { method: 'POST', body: form('file', 1, 'refused.txt'), signal: AbortSignal.timeout(3000) });
  assert.equal(res.status, 400);
});

test('a cancelled upload saves nothing and is not logged as a server error', async (t) => {
  const { received, port } = await uploadServer(t, 1024);
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  await new Promise<void>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write('POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: multipart/form-data; boundary=X\r\n' +
        'Content-Length: 1000\r\n\r\n--X\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\npartial');
      setTimeout(() => { socket.destroy(); setTimeout(resolve, 200); }, 100);
    });
  });
  assert.deepEqual(received, []);
  assert.ok(!logged.some((line) => line.includes('-> 500')), logged.join('\n'));
});
