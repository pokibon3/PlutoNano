// FT8: resample the RX audio to 12 kHz in the audio thread and hand it to the main thread in blocks.
// A windowed-sinc low-pass (5 kHz) runs before the fractional resampler, so any input rate works.
class Ft8Resampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 12000;
    const taps = 63, fc = 5000 / sampleRate;
    this.h = new Float32Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const m = i - (taps - 1) / 2;
      const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
      this.h[i] = sinc * w; sum += this.h[i];
    }
    for (let i = 0; i < taps; i++) this.h[i] /= sum;
    this.hist = new Float32Array(taps * 2); this.hp = 0;
    this.prev = 0; this.phase = 0;
    this.out = new Float32Array(1920); this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const h = this.h, T = h.length, hist = this.hist;
    for (let i = 0; i < ch.length; i++) {
      hist[this.hp] = hist[this.hp + T] = ch[i];
      this.hp = (this.hp + 1) % T;
      let y = 0;
      for (let k = 0; k < T; k++) y += h[k] * hist[this.hp + k];
      // linear interpolation between filtered samples at the 12 kHz output instants
      this.phase += 1;
      while (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const f = 1 - this.phase; // fraction of the way from prev to y
        this.out[this.n++] = this.prev + (y - this.prev) * f;
        if (this.n === this.out.length) { this.port.postMessage({ t: currentTime, s: this.out }, [this.out.buffer]); this.out = new Float32Array(1920); this.n = 0; }
      }
      this.prev = y;
    }
    return true;
  }
}
registerProcessor('ft8-resampler', Ft8Resampler);
