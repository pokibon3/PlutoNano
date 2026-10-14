// Audio output: a ring buffer of interleaved stereo frames fed directly by
// the DSP worker over a MessagePort. Reports its fill level (in frames) so
// the worker can trim its resampler.

class PlutoPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = Math.round(sampleRate * 2);
    this.buf = new Float32Array(this.cap * 2);
    this.r = 0; this.w = 0; this.fill = 0;
    this.target = Math.round(sampleRate * 0.12);
    this.primed = false;
    this.tick = 0;
    this.src = null;
    this.port.onmessage = (e) => {
      if (e.data && e.data.port) {
        this.src = e.data.port;
        this.src.onmessage = (ev) => this.push(ev.data);
      } else if (e.data && e.data.reset) {
        this.r = this.w = this.fill = 0;
        this.primed = false;
      }
    };
  }

  push(a) {
    const cap = this.cap, buf = this.buf, n = a.length >> 1;
    for (let i = 0; i < n; i++) {
      if (this.fill >= cap) { this.r = (this.r + 1) % cap; this.fill--; }
      buf[2 * this.w] = a[2 * i];
      buf[2 * this.w + 1] = a[2 * i + 1];
      this.w = (this.w + 1) % cap;
      this.fill++;
    }
    // A stall on the output side (device glitch, busy system) can pile up
    // seconds of audio that the rate trim would take minutes to drain,
    // making every retune sound late. Skip ahead instead.
    if (this.fill > this.target * 3) {
      this.r = (this.r + this.fill - this.target) % cap;
      this.fill = this.target;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0].length;
    const oL = out[0], oR = out[1] || out[0];
    if (!this.primed && this.fill >= this.target) this.primed = true;
    if (this.primed && this.fill >= L) {
      const buf = this.buf, cap = this.cap;
      let r = this.r;
      for (let i = 0; i < L; i++) {
        oL[i] = buf[2 * r];
        oR[i] = buf[2 * r + 1];
        r = r + 1 === cap ? 0 : r + 1;
      }
      this.r = r;
      this.fill -= L;
    } else {
      if (this.primed) this.primed = false;
      for (let c = 0; c < out.length; c++) out[c].fill(0);
    }
    if (this.src && ++this.tick % 16 === 0) this.src.postMessage({ fill: this.fill, target: this.target });
    return true;
  }
}

registerProcessor('pluto-player', PlutoPlayer);
