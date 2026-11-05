import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
function compile(file, requireFn, globals = {}) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(root + file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(js, { exports, require: requireFn, ...globals });
  return exports;
}
// Run the real component with deterministic hooks, audio messages and timers, without a microphone.
async function scenario(mode) {
  const slots = [],
    effects = [],
    requests = [];
  let cursor = 0,
    cleanup,
    interval,
    timeout,
    now = 0,
    timeoutCleared = false;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (v) => (slots[i] = typeof v === 'function' ? v(slots[i]) : v)];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useCallback(fn) {
      cursor++;
      return fn;
    },
    useEffect(fn) {
      const i = cursor++;
      if (!(i in slots)) {
        slots[i] = true;
        effects.push(fn);
      }
    },
  };
  const jsx = (type, props) => ({ type, props });
  const utils = compile('ui/src/utils/dictation.ts', () => {}, {
    Uint8Array,
    DataView,
    localStorage: { getItem: () => null },
  });
  const overview = {
    models: [{ id: 'whisper-large-v3-turbo', name: 'Test', installed: true }],
    settings: { model: 'whisper-large-v3-turbo' },
  };
  class AudioContext {
    sampleRate = 16000;
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() {
      return { connect() {} };
    }
    createGain() {
      return { gain: {}, connect() {} };
    }
    close() {
      return Promise.resolve();
    }
  }
  const node = { port: { postMessage() {}, onmessage: null }, connect() {} };
  function AudioWorkletNode() {
    return node;
  }
  const mod = compile(
    'ui/src/components/common/DictateButton.tsx',
    (name) => {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name.endsWith('/Button')) return { default: 'Button' };
      if (name.endsWith('/Input')) return { Select: 'Select' };
      if (name.endsWith('/api')) return { apiGet: async () => overview, errorMessage: () => 'Error' };
      if (name.endsWith('/desktop')) return { microphoneAccess: async () => 'granted' };
      if (name.endsWith('/RecordingParts')) return { MicIcon: 'MicIcon', RecordingPill: 'RecordingPill' };
      if (name.endsWith('/dictation')) return utils;
      throw Error(name);
    },
    {
      Uint8Array,
      ArrayBuffer,
      Blob,
      AbortController,
      window: { isSecureContext: true },
      navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
      AudioContext,
      AudioWorkletNode,
      Date: { now: () => now },
      setInterval: (fn) => ((interval = fn), 1),
      clearInterval() {},
      setTimeout: (fn) => ((timeout = fn), 2),
      clearTimeout() {
        timeoutCleared = true;
      },
      fetch: async (_url, opts) => {
        requests.push(opts);
        return { ok: true, json: async () => ({ text: 'Fictional words' }) };
      },
    },
  );
  const render = () => {
    cursor = 0;
    return mod.default({ fieldName: 'test', onText() {} });
  };
  const find = (t, type) => {
    if (!t) return;
    if (t.type === type) return t;
    for (const child of [t.props?.children].flat(Infinity)) {
      if (typeof child === 'object') {
        const r = find(child, type);
        if (r) return r;
      }
    }
  };
  render();
  cleanup = effects[0]();
  await new Promise(setImmediate);
  find(render(), 'Button').props.onClick();
  await new Promise(setImmediate);
  if (mode === 'auto-stop') {
    // A single normal timer tick 100 ms after the nominal five-minute limit.
    now = 300100;
    node.port.onmessage({ data: { samples: new ArrayBuffer(300.1 * 16000 * 2) } });
    interval();
    node.port.onmessage({ data: { done: true } });
  } else {
    node.port.onmessage({ data: { samples: new ArrayBuffer(32000) } });
    find(render(), 'RecordingPill').props.onStop();
    const lateMessage = node.port.onmessage;
    if (mode === 'close-during-stop') {
      cleanup(); // Close the form before the worklet acknowledges Stop.
      assert.equal(node.port.onmessage, null);
      assert.equal(timeoutCleared, true);
    } else if (mode === 'normal-stop') {
      lateMessage({ data: { samples: new ArrayBuffer(16000) } });
      lateMessage({ data: { done: true } });
    }
    // Even a callback already queued before cancellation must not upload.
    timeout();
    lateMessage({ data: { done: true } });
  }
  await new Promise(setImmediate);
  cleanup();
  return requests;
}
test('a late automatic stop uploads at most five minutes of audio', async () => {
  const requests = await scenario('auto-stop');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.size, 44 + 300 * 16000 * 2);
  const header = new DataView(await requests[0].body.arrayBuffer());
  assert.equal(header.getUint32(40, true) / header.getUint32(28, true), 300);
});

test('closing during Stop cancels the fallback and ignores late worklet replies', async () => {
  assert.equal((await scenario('close-during-stop')).length, 0);
});

test('normal Stop includes the final block and uploads only once', async () => {
  const requests = await scenario('normal-stop');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.size, 44 + 32000 + 16000);
});

test('a missing worklet acknowledgement uses the fallback only once', async () => {
  const requests = await scenario('fallback');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.size, 44 + 32000);
});
