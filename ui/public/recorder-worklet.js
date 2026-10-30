// Runs on the browser's audio thread. Turns the microphone into 16-bit mono blocks of about half a second, the audio
// the server stores as it arrives. The context runs at 16 kHz, so there is nothing to resample here.
/* global AudioWorkletProcessor, registerProcessor */
const FRAMES = 8000;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Int16Array(FRAMES);
    this.filled = 0;
    this.peak = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data !== 'stop') return;
      this.send();
      this.stopped = true;
      this.port.postMessage({ done: true });
    };
  }

  send() {
    if (this.filled === 0) return;
    const samples = this.block.slice(0, this.filled).buffer;
    this.port.postMessage({ samples, peak: this.peak }, [samples]);
    this.filled = 0;
    this.peak = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[i];
      mixed /= channels.length;
      const clipped = Math.max(-1, Math.min(1, mixed));
      this.peak = Math.max(this.peak, Math.abs(clipped));
      this.block[this.filled++] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
      if (this.filled === FRAMES) this.send();
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
