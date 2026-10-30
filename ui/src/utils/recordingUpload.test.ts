/**
 * Unit tests for the recording uploader. Run with: npm run test:recording-upload --workspace=ui
 */
import { RecordingUploader, type SendResult } from './recordingUpload';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const bytes = (n: number, value = 1) => new Uint8Array(n).fill(value);

/** A fictional server: stores what arrives, and answers from a script when there is one. */
function server(script: (offset: number, block: Uint8Array) => SendResult | null = () => null) {
  const stored: number[] = [];
  const send = async (offset: number, block: Uint8Array): Promise<SendResult> => {
    const scripted = script(offset, block);
    if (scripted) return scripted;
    if (offset !== stored.length) return { ok: false, retry: false, message: 'gap', offset: stored.length };
    stored.push(...block);
    return { ok: true, offset: stored.length };
  };
  return { stored, send };
}
const noWait = async () => {};

async function main(): Promise<void> {
  const plain = server();
  const uploader = new RecordingUploader({ send: plain.send, sleep: noWait, maxBlock: 4 });
  uploader.add(bytes(6, 1));
  uploader.add(bytes(4, 2));
  check('what is captured waits until it is stored', uploader.captured === 10 && uploader.saved === 0 && uploader.unsaved === 10);
  await uploader.flush();
  check('blocks arrive in order, split to the limit', plain.stored.join('') === '1111112222' && uploader.saved === 10 && uploader.unsaved === 0);

  // The network drops: nothing is lost, and the same bytes are sent again.
  let drops = 3;
  const flaky = server(() => (drops-- > 0 ? { ok: false, retry: true } : null));
  const waits: number[] = [];
  const retrying = new RecordingUploader({ send: flaky.send, sleep: async (ms) => { waits.push(ms); }, maxBlock: 4 });
  retrying.add(bytes(6));
  await retrying.flush();
  check('a failed send is retried, waiting longer each time', waits.join(',') === '1000,2000,4000' && flaky.stored.length === 6);

  // A thrown fetch counts as a retry too.
  let thrown = false;
  const offline = new RecordingUploader({
    send: async (_o, block) => { if (!thrown) { thrown = true; throw new Error('offline'); } return { ok: true, offset: block.length }; },
    sleep: noWait,
  });
  offline.add(bytes(4));
  await offline.flush();
  check('a network error is retried', offline.saved === 4 && !offline.failed);

  // The reply was lost after the server stored it.
  let lost = true;
  const ahead = server();
  const lostReply = new RecordingUploader({
    send: async (offset, block) => {
      const result = await ahead.send(offset, block);
      if (lost) { lost = false; return { ok: false, retry: false, message: 'gap', offset: 4 }; }
      return result;
    },
    sleep: noWait, maxBlock: 4,
  });
  lostReply.add(bytes(8));
  await lostReply.flush();
  check('bytes the server already has are not sent again', lostReply.saved === 8 && !lostReply.failed && ahead.stored.length === 8);

  // A refusal stops it, with the reason, and keeps what was saved.
  let count = 0;
  const refused = new RecordingUploader({
    send: async (_o, block) => (++count === 2 ? { ok: false, retry: false, message: 'The disk is full' } : { ok: true, offset: block.length }),
    sleep: noWait, maxBlock: 4,
  });
  refused.add(bytes(8));
  await refused.flush();
  refused.add(bytes(2));
  check('a refusal stops recording, says why and keeps the count of what was saved', refused.failed === 'The disk is full' && refused.saved === 4 && refused.captured === 8);

  // A server that says it holds less than was acknowledged is never papered over.
  const behind = new RecordingUploader({
    send: async (offset) => (offset === 0 ? { ok: true, offset: 4 } : { ok: false, retry: false, message: 'Audio is missing', offset: 0 }),
    sleep: noWait, maxBlock: 4,
  });
  behind.add(bytes(8));
  await behind.flush();
  check('a server behind what it acknowledged stops the recording', behind.failed === 'Audio is missing' && behind.saved === 4);

  // The server stays away for too long: recording stops visibly, not silently.
  const full = new RecordingUploader({ send: async () => ({ ok: false, retry: true }), sleep: noWait, maxBacklog: 6 });
  full.add(bytes(4));
  full.add(bytes(4));
  check('a full backlog stops the recording, with the reason', Boolean(full.failed?.includes('too long')) && full.captured === 4);

  // The backlog fills while a send is out; its reply still counts, and nothing breaks.
  let answer!: (r: SendResult) => void;
  const slow = new RecordingUploader({ send: () => new Promise((r) => { answer = r; }), sleep: noWait, maxBacklog: 6, maxBlock: 4 });
  slow.add(bytes(4));
  const pending = slow.flush();
  slow.add(bytes(4));
  answer({ ok: true, offset: 4 });
  await pending;
  check('a reply after the backlog filled is counted and does not break', Boolean(slow.failed) && slow.saved === 4 && slow.unsaved === 0);

  // Cancelled while waiting to retry: nothing is sent after that.
  let sends = 0;
  const cancelled = new RecordingUploader({ send: async () => { sends++; return { ok: false, retry: true }; }, sleep: async () => { cancelled.cancel(); } });
  cancelled.add(bytes(4));
  await cancelled.flush();
  cancelled.add(bytes(4));
  check('after cancel nothing is sent or kept', sends === 1 && cancelled.unsaved === 0);

  // Two flushes at once share one run.
  let calls = 0;
  const once = new RecordingUploader({ send: async (_o, block) => { calls++; return { ok: true, offset: block.length }; }, sleep: noWait });
  once.add(bytes(4));
  await Promise.all([once.flush(), once.flush()]);
  check('two flushes at once send a block once', calls === 1);

  console.log(failures ? `\n${failures} failed` : '\nAll recording upload tests passed');
  process.exit(failures ? 1 : 0);
}

void main();
