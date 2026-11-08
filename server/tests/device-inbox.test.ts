import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deviceId, generateIdentity, open, proof, seal, sharedKey, type Identity } from '../src/services/deviceInbox/crypto';
import { DeviceInbox } from '../src/services/deviceInbox';
import { InboxServer, inboxPath, isLocalAddress } from '../src/services/deviceInbox/inboxServer';
import { MeetingDigestService } from '../src/services/meetingDigestService';

/** A home and a workspace of their own, because the inbox keeps its keys under the home folder. */
async function sandbox(t: { after: (fn: () => Promise<void> | void) => void }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gtd-inbox-'));
  const home = process.env.HOME;
  const workspace = process.env.ESB_WORKSPACE_PATH;
  process.env.HOME = dir;
  process.env.ESB_WORKSPACE_PATH = path.join(dir, 'workspace');
  for (const d of ['tasks/active', 'context-updates', '.situation-board/routines']) {
    await fsp.mkdir(path.join(dir, 'workspace', d), { recursive: true });
  }
  t.after(async () => {
    process.env.HOME = home;
    if (workspace === undefined) delete process.env.ESB_WORKSPACE_PATH;
    else process.env.ESB_WORKSPACE_PATH = workspace;
    await fsp.rm(dir, { recursive: true, force: true });
  });
}

/** Stands in for Meetlaud, doing what the iPhone does. */
class Phone {
  readonly identity: Identity = generateIdentity();
  key: Buffer = Buffer.alloc(0);
  constructor(readonly base: string) {}
  get id() { return deviceId(this.identity.publicKey); }

  async pair(code: { code: string; public_key: string }, usedCode = code.code) {
    const secret = Buffer.from(usedCode, 'base64');
    const response = await fetch(`${this.base}/v1/pair`, {
      method: 'POST',
      body: JSON.stringify({
        phone_public: this.identity.publicKey.toString('base64'),
        phone_name: 'Test iPhone',
        proof: proof(secret, this.identity.publicKey).toString('base64'),
      }),
    });
    if (response.status === 200) {
      const mac = Buffer.from(code.public_key, 'base64');
      const answer = await response.json() as { proof: string };
      assert.equal(answer.proof, proof(secret, mac, this.identity.publicKey).toString('base64'), 'The computer proves it saw the code');
      this.key = sharedKey(this.identity.privateKey, mac);
    }
    return response.status;
  }

  async call(route: string, value: unknown, key = this.key) {
    const response = await fetch(`${this.base}${route}`, {
      method: 'POST', headers: { 'X-Device': this.id }, body: seal(key, Buffer.from(JSON.stringify(value)), route),
    });
    if (response.status !== 200) return { status: response.status, value: null };
    const plain = open(key, Buffer.from(await response.arrayBuffer()), `answer:${route}`);
    return { status: 200, value: JSON.parse(plain.toString()) };
  }

  async chunk(item: string, index: number, offset: number, data: Buffer, context?: string) {
    const route = `/v1/items/${item}/files/${index}`;
    const response = await fetch(`${this.base}${route}?offset=${offset}`, {
      method: 'PUT', headers: { 'X-Device': this.id }, body: seal(this.key, data, context ?? `${route}?offset=${offset}`),
    });
    if (response.status !== 200) return { status: response.status, received: -1 };
    const plain = open(this.key, Buffer.from(await response.arrayBuffer()), `answer:${route}`);
    return { status: 200, received: (JSON.parse(plain.toString()) as { received: number }).received };
  }
}

const meeting = (audio: Buffer, id = randomUUID()) => ({
  id, title: 'Weekly sync', date: '2026-11-07',
  files: [{ name: 'recording.wav', size: audio.length, sha256: createHash('sha256').update(audio).digest('hex') }],
});

const wav = (seconds = 1) => {
  const data = Buffer.alloc(16000 * 2 * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

async function running(t: { after: (fn: () => Promise<void> | void) => void }) {
  await sandbox(t);
  const inbox = new DeviceInbox(new MeetingDigestService(), 'Test computer');
  const code = await inbox.startPairing();
  t.after(() => inbox.stop());
  return { inbox, code, phone: new Phone(`http://127.0.0.1:${code.port}`) };
}

test('the same keys give the same results as on the iPhone', () => {
  // The same values are in Meetlaud's tests. If one side changes, the two stop understanding each other.
  const phone = Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex');
  const mac = Buffer.from('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb', 'hex');
  const macPublic = Buffer.from('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f', 'hex');
  const phonePublic = Buffer.from('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a', 'hex');
  const key = sharedKey(phone, macPublic);
  assert.deepEqual(key, sharedKey(mac, phonePublic));
  assert.equal(key.toString('hex'), '7cee7972f23efd4c8d462c2a03c3c170cefd7094cd0411a86a93c6c65e388709');
  const sealed = seal(key, Buffer.from('hello'), 'place', Buffer.alloc(12, 7));
  assert.equal(sealed.toString('hex'), '07070707070707070707070785897688a7e84e27bd1d533096160e6075ed906289');
  assert.equal(deviceId(phonePublic), '300c9c9603b92a4b39ed3958bf924011');
  assert.equal(proof(Buffer.alloc(16, 9), phonePublic).toString('hex'), '927e900179b981b9c691e9d014b41c9aa436f1d1116d3e39c2823fc89615434c');
  assert.equal(open(key, sealed, 'place').toString(), 'hello');
});

test('a seal is bound to its place, and any change is refused', () => {
  const key = randomBytes(32);
  const sealed = seal(key, Buffer.from('words'), '/v1/offer');
  assert.throws(() => open(key, sealed, '/v1/elsewhere'));
  const altered = Buffer.from(sealed);
  altered[14] ^= 1;
  assert.throws(() => open(key, altered, '/v1/offer'));
  assert.throws(() => open(randomBytes(32), sealed, '/v1/offer'));
});

test('a meeting travels from a paired phone into the queue', async (t) => {
  const { phone, inbox } = await running(t);
  assert.equal(await phone.pair(await pairing(inbox)), 200);
  const audio = wav();
  const item = meeting(audio);
  const offer = await phone.call('/v1/offer', { items: [item] });
  assert.deepEqual(offer.value.items[0], { id: item.id, complete: false, files: [0] });

  const middle = 20000;
  assert.equal((await phone.chunk(item.id, 0, 0, audio.subarray(0, middle))).received, middle);
  assert.equal((await phone.chunk(item.id, 0, middle, audio.subarray(middle))).received, audio.length);
  const done = await phone.call(`/v1/items/${item.id}/commit`, {});
  assert.equal(done.status, 200);

  const queued = (await new MeetingDigestService().readQueue()).meetings.find((entry) => entry.id === done.value.meeting_id);
  assert.equal(queued?.title, 'Weekly sync');
  assert.equal(queued?.status, 'queued');
  assert.equal((await inbox.status()).devices[0].name, 'Test iPhone');
});

test('an interrupted upload picks up where it stopped', async (t) => {
  const { phone, inbox } = await running(t);
  await phone.pair(await pairing(inbox));
  const audio = wav();
  const item = meeting(audio);
  await phone.call('/v1/offer', { items: [item] });
  await phone.chunk(item.id, 0, 0, audio.subarray(0, 1000));

  assert.equal((await phone.call(`/v1/items/${item.id}/commit`, {})).status, 422, 'An early commit keeps the partial upload resumable');
  const again = await phone.call('/v1/offer', { items: [item] });
  assert.deepEqual(again.value.items[0].files, [1000], 'The computer says how much it holds');
  assert.equal((await phone.chunk(item.id, 0, 0, audio.subarray(0, 1000))).received, 1000, 'An old offset adds nothing');
});

test('sending a delivered meeting again changes nothing', async (t) => {
  const { phone, inbox } = await running(t);
  await phone.pair(await pairing(inbox));
  const audio = wav();
  const item = meeting(audio);
  await phone.call('/v1/offer', { items: [item] });
  await phone.chunk(item.id, 0, 0, audio);
  const first = await phone.call(`/v1/items/${item.id}/commit`, {});
  const repeat = await phone.call(`/v1/items/${item.id}/commit`, {});
  assert.equal(repeat.value.meeting_id, first.value.meeting_id);
  assert.equal((await phone.call('/v1/offer', { items: [item] })).value.items[0].complete, true);
  assert.equal((await new MeetingDigestService().readQueue()).meetings.filter((entry) => entry.title === 'Weekly sync').length, 1);
});

test('a file that arrives damaged never reaches the queue', async (t) => {
  const { phone, inbox } = await running(t);
  await phone.pair(await pairing(inbox));
  const audio = wav();
  const item = meeting(audio);
  await phone.call('/v1/offer', { items: [item] });
  const wrong = Buffer.from(audio);
  wrong[100] ^= 1;
  await phone.chunk(item.id, 0, 0, wrong);
  assert.equal((await phone.call(`/v1/items/${item.id}/commit`, {})).status, 422);
  assert.equal((await new MeetingDigestService().readQueue()).meetings.length, 0);
});

test('a phone that never paired gets nothing', async (t) => {
  const { phone, inbox } = await running(t);
  await phone.pair(await pairing(inbox));
  const stranger = new Phone(phone.base);
  stranger.key = randomBytes(32);
  assert.equal((await stranger.call('/v1/offer', { items: [] })).status, 401);
  const claiming = new Phone(phone.base);
  Object.defineProperty(claiming, 'id', { value: phone.id });
  claiming.key = randomBytes(32);
  assert.equal((await claiming.call('/v1/offer', { items: [] })).status, 400, 'Knowing an id without its key opens nothing');
});

test('a removed phone can no longer send', async (t) => {
  const { phone, inbox } = await running(t);
  await phone.pair(await pairing(inbox));
  await inbox.removeDevice(phone.id);
  assert.equal((await phone.call('/v1/offer', { items: [] })).status, 401);
});

test('the wrong code pairs nothing, and a code works once', async (t) => {
  const { phone, inbox } = await running(t);
  const code = await pairing(inbox);
  assert.equal(await phone.pair(code, randomBytes(16).toString('base64')), 403);
  assert.equal((await inbox.status()).devices.length, 0);
  assert.equal(await phone.pair(code), 200);
  assert.equal(await new Phone(phone.base).pair(code), 403, 'The code is spent');
});

test('guessing a code stops after a few tries', async (t) => {
  const { phone, inbox } = await running(t);
  const code = await pairing(inbox);
  for (let attempt = 0; attempt < 5; attempt++) await new Phone(phone.base).pair(code, randomBytes(16).toString('base64'));
  assert.equal(await phone.pair(code), 403, 'Even the right code is refused after that');
});

test('nothing outside the local network is answered', () => {
  for (const address of ['10.0.0.2', '192.168.1.4', '172.20.10.3', '169.254.3.1', '::ffff:172.20.10.2', 'fe80::1', '127.0.0.1']) {
    assert.equal(isLocalAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '::ffff:1.1.1.1', '2001:4860::1', undefined]) {
    assert.equal(isLocalAddress(address), false, String(address));
  }
});

test('a name from a phone never leads outside the inbox folder', async (t) => {
  await sandbox(t);
  const device = 'a'.repeat(32);
  const item = randomUUID();
  const inside = inboxPath(device, item, 'audio.m4a');
  assert.equal(inside, path.join(os.homedir(), '.gtd', 'device-inbox', device, item, 'audio.m4a'));
  for (const [d, i, name] of [
    ['../../etc', item, 'a.txt'], ['A'.repeat(32), item, 'a.txt'], [device, '../x', 'a.txt'],
    [device, item, '../a.txt'], [device, item, '..'], [device, item, '.hidden'], [device, item, 'a/b.txt'], [device, item, ''],
  ]) {
    assert.throws(() => inboxPath(d, i, name), /Bad path/, `${d} ${i} ${name}`);
  }
});

test('turning it off stops listening, and it starts off', async (t) => {
  await sandbox(t);
  const inbox = new DeviceInbox(new MeetingDigestService(), 'Test computer');
  assert.deepEqual(await inbox.status(), { enabled: false, listening: false, devices: [] });
  const code = await inbox.startPairing();
  assert.equal((await inbox.status()).listening, true);
  await inbox.setEnabled(false);
  await assert.rejects(fetch(`http://127.0.0.1:${code.port}/v1/pair`, { method: 'POST', body: '{}' }));
});

test('the private key is only readable by the owner', async (t) => {
  await running(t);
  const stats = await fsp.stat(path.join(os.homedir(), '.gtd', 'device-inbox', 'state.json'));
  assert.equal(stats.mode & 0o077, 0);
});

test('the settings screen calls the API by its full path', async () => {
  // A path without /api answers with the dashboard's page, which the screen can only report as a failure.
  const source = await fsp.readFile(path.join(__dirname, '../../ui/src/components/settings/DeviceSettings.tsx'), 'utf8');
  const calls = [...source.matchAll(/api(?:Get|Post|Put|Delete)(?:<[^>]+>+)?\(['`]([^'`]+)/g)].map((match) => match[1]);
  assert.equal(calls.length, 5);
  for (const call of calls) assert.ok(call.startsWith('/api/devices'), call);
});

function pairing(inbox: DeviceInbox) {
  return inbox.startPairing();
}

test('simultaneous retries append a chunk only once', async (t) => {
  const { phone, inbox } = await running(t);
  await phone.pair(await pairing(inbox));
  const audio = wav();
  const item = meeting(audio);
  await phone.call('/v1/offer', { items: [item] });
  const piece = audio.subarray(0, 1000);
  // Hold appends briefly so overlapping requests all observe the same starting size.
  const fs = (await import('node:fs')).promises;
  const append = fs.appendFile;
  t.mock.method(fs, 'appendFile', async (...args: Parameters<typeof append>) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return append(...args);
  });
  const replies = await Promise.all(Array.from({ length: 12 }, () => phone.chunk(item.id, 0, 0, piece)));
  assert.ok(replies.every((r) => r.status === 200 && r.received === piece.length));
  assert.deepEqual(await fsp.readFile(inboxPath(phone.id, item.id, 'recording.wav')), piece);
});

test('simultaneous commits deliver one meeting', async (t) => {
  const { phone, inbox } = await running(t);
  await phone.pair(await pairing(inbox));
  const audio = wav();
  const item = meeting(audio);
  await phone.call('/v1/offer', { items: [item] });
  await phone.chunk(item.id, 0, 0, audio);
  const replies = await Promise.all(Array.from({ length: 6 }, () => phone.call(`/v1/items/${item.id}/commit`, {})));
  assert.ok(replies.every((r) => r.status === 200));
  assert.equal(new Set(replies.map((r) => r.value.meeting_id)).size, 1);
  assert.equal((await new MeetingDigestService().readQueue()).meetings.length, 1);
});

test('a damaged upload can be sent again after its checksum is refused', async (t) => {
  const { phone, inbox } = await running(t);
  await phone.pair(await pairing(inbox));
  const audio = wav();
  const item = meeting(audio);
  await phone.call('/v1/offer', { items: [item] });
  await phone.chunk(item.id, 0, 0, Buffer.alloc(audio.length));
  assert.equal((await phone.call(`/v1/items/${item.id}/commit`, {})).status, 422);
  const retry = await phone.call('/v1/offer', { items: [item] });
  assert.deepEqual(retry.value.items[0].files, [0]);
  await phone.chunk(item.id, 0, 0, audio);
  assert.equal((await phone.call(`/v1/items/${item.id}/commit`, {})).status, 200);
});

test('file names in one offer cannot alias the same file', async (t) => {
  const { phone, inbox } = await running(t);
  await phone.pair(await pairing(inbox));
  for (const name of ['recording.wav', 'RECORDING.WAV']) {
    const item = meeting(wav());
    item.files.push({ ...item.files[0], name });
    const response = await phone.call('/v1/offer', { items: [item] });
    assert.deepEqual(response.value.items, []);
    await assert.rejects(fsp.stat(inboxPath(phone.id, item.id)), { code: 'ENOENT' });
  }
});


test('concurrent enable requests start only one listener', async (t) => {
  await sandbox(t);
  const servers: InboxServer[] = [];
  const start = InboxServer.prototype.start;
  t.mock.method(InboxServer.prototype, 'start', async function (this: InboxServer, port: number) {
    servers.push(this);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return start.call(this, port);
  });
  const inbox = new DeviceInbox(new MeetingDigestService(), 'Test computer');
  t.after(async () => { await inbox.stop(); await Promise.all(servers.map((s) => s.stop())); });
  await inbox.status();
  await Promise.all(Array.from({ length: 4 }, () => inbox.setEnabled(true)));
  assert.equal(servers.length, 1);
  await inbox.setEnabled(false);
  assert.equal((await inbox.status()).listening, false);
});

test('an upload never appends through a file symlink', async (t) => {
  const { phone, inbox } = await running(t);
  await phone.pair(await pairing(inbox));
  const audio = wav();
  const item = meeting(audio);
  await phone.call('/v1/offer', { items: [item] });
  const outside = path.join(os.homedir(), 'outside.wav');
  await fsp.writeFile(outside, 'keep');
  await fsp.symlink(outside, inboxPath(phone.id, item.id, 'recording.wav'));
  assert.equal((await phone.chunk(item.id, 0, 4, audio.subarray(4))).status, 400);
  assert.equal(await fsp.readFile(outside, 'utf8'), 'keep');
});

test('cancelling a code also refuses a pairing request still sending its body', async (t) => {
  const { inbox, phone } = await running(t);
  const code = await pairing(inbox);
  const body = JSON.stringify({ phone_public: phone.identity.publicKey.toString('base64'), proof: proof(Buffer.from(code.code, 'base64'), phone.identity.publicKey).toString('base64') });
  const { request } = await import('node:http');
  let send!: import('node:http').ClientRequest;
  const answer = new Promise<number>((resolve, reject) => {
    send = request(`${phone.base}/v1/pair`, { method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode!); });
    send.on('error', reject);
    send.write(body.slice(0, 10));
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  inbox.cancelPairing();
  send.end(body.slice(10));
  assert.equal(await answer, 403);
  assert.equal((await inbox.status()).devices.length, 0);
});

test('two phones cannot spend the same pairing code concurrently', async (t) => {
  const { inbox, phone } = await running(t);
  const code = await pairing(inbox);
  const other = new Phone(phone.base);
  const replies = await Promise.all([phone.pair(code), other.pair(code)]);
  assert.deepEqual(replies.sort(), [200, 403]);
  assert.equal((await inbox.status()).devices.length, 1);
});

test('forgetting a phone refuses its request still sending a sealed body', async (t) => {
  const { inbox, phone } = await running(t);
  await phone.pair(await pairing(inbox));
  const item = meeting(wav());
  const sealed = seal(phone.key, Buffer.from(JSON.stringify({ items: [item] })), '/v1/offer');
  const { request } = await import('node:http');
  let send!: import('node:http').ClientRequest;
  const answer = new Promise<number>((resolve, reject) => {
    send = request(`${phone.base}/v1/offer`, { method: 'POST', headers: { 'X-Device': phone.id } }, (res) => { res.resume(); resolve(res.statusCode!); });
    send.on('error', reject);
    send.write(sealed.subarray(0, 10));
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await inbox.removeDevice(phone.id);
  send.end(sealed.subarray(10));
  assert.equal(await answer, 401);
  await assert.rejects(fsp.stat(inboxPath(phone.id, item.id)), { code: 'ENOENT' });
});

test('a rejected recording leaves no draft meetings or upload files behind on retries', async (t) => {
  const { inbox, phone } = await running(t);
  await phone.pair(await pairing(inbox));
  const audio = Buffer.from('not a WAV recording');
  const item = meeting(audio);
  await phone.call('/v1/offer', { items: [item] });
  await phone.chunk(item.id, 0, 0, audio);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await phone.call(`/v1/items/${item.id}/commit`, {})).status, 400);
    assert.equal((await new MeetingDigestService().readQueue()).meetings.length, 0);
  }
  assert.deepEqual(await fsp.readFile(inboxPath(phone.id, item.id, 'recording.wav')), audio);
});
