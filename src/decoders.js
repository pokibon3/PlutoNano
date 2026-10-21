// CW / FT8 / FT4 decoders on the demodulated audio, and the FT8 / FT4 message encoder
// and waveform for transmitting, taken from the FTX-1 Controller
// (js/cwdecoder.js, js/ft8.js). The cores are WebAssembly (src/cwdec/, src/ft8/); the
// build inlines them as base64 and the worklet / worker sources as text, so nothing is fetched.

const PlutoDecoders = (function () {
  'use strict';

  const text = (id) => document.getElementById(id).textContent;
  const blobUrl = (id) => URL.createObjectURL(new Blob([text(id)], { type: 'text/javascript' }));
  const wasmBytes = (id) => {
    const s = atob(text(id).trim()), b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b.buffer;
  };

  // Loads the worklet module in script tag `id` into ctx once.
  // file:// pages cannot load worklets from blob: URLs, but data: URLs work.
  const loaded = new WeakMap();
  async function addWorklet(ctx, id) {
    const done = loaded.get(ctx) || new Set();
    loaded.set(ctx, done);
    if (done.has(id)) return;
    const code = text(id);
    let err = null;
    for (const url of ['data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(code))), blobUrl(id)]) {
      try { await ctx.audioWorklet.addModule(url); done.add(id); return; } catch (e) { err = e; }
    }
    throw err;
  }

  // ---------------- CW ----------------
  // Signal chain: demodulated audio -> worklet (8 kHz, wasm core). cw_decoder4/web puts a band-pass (Q 3, following
  // the tone) in front, standing in for the firmware's analog one; here the receiver's own CW / SSB filter does that,
  // and the extra band-pass made filtered noise look like a tone (garbage between overs, little left at low level).
  // The decoder keeps what the core's frames carry: text, spectrum, scope columns, input level (drawn by cwview.js
  // as cw_decoder4's web page does).

  // status[] indices (cw_decoder4 web/wasm/api.cpp cw_status_t)
  const ST = {
    scopeTotal: 0, scopeFirst: 1, scopeLost: 2, scopeN: 3, charN: 4,
    wpm: 5, toneHz: 6, toneIdx: 7, toneAuto: 8, peakHz: 9, gateBw: 10,
    periodQ8: 11, colMsX10: 12, inputPeak: 13, inputPct: 14,
    mode: 15, gate: 16, clip: 17,
  };
  const SPEC_BINS = 65;   // bin 0..64, 31.25 Hz each (8 kHz / 256)
  const SR = 8192;        // scope column ring (as cw_decoder4 web/app.js)

  // JIS X 0201 kana -> full-width katakana (same table as cw_decoder4 display.cpp)
  const KANA_CP = [
    0x3002, 0x300C, 0x300D, 0x3001, 0x30FB, 0x30F2,
    0x30A1, 0x30A3, 0x30A5, 0x30A7, 0x30A9,
    0x30E3, 0x30E5, 0x30E7, 0x30C3, 0x30FC,
    0x30A2, 0x30A4, 0x30A6, 0x30A8, 0x30AA,
    0x30AB, 0x30AD, 0x30AF, 0x30B1, 0x30B3,
    0x30B5, 0x30B7, 0x30B9, 0x30BB, 0x30BD,
    0x30BF, 0x30C1, 0x30C4, 0x30C6, 0x30C8,
    0x30CA, 0x30CB, 0x30CC, 0x30CD, 0x30CE,
    0x30CF, 0x30D2, 0x30D5, 0x30D8, 0x30DB,
    0x30DE, 0x30DF, 0x30E0, 0x30E1, 0x30E2,
    0x30E4, 0x30E6, 0x30E8,
    0x30E9, 0x30EA, 0x30EB, 0x30EC, 0x30ED,
    0x30EF, 0x30F3, 0x309B, 0x309C,
  ];
  const DAKUTEN_OK = new Set([
    0x30A6, 0x30AB, 0x30AD, 0x30AF, 0x30B1, 0x30B3, 0x30B5, 0x30B7, 0x30B9, 0x30BB, 0x30BD,
    0x30BF, 0x30C1, 0x30C4, 0x30C6, 0x30C8, 0x30CF, 0x30D2, 0x30D5, 0x30D8, 0x30DB,
  ]);
  const HANDAKUTEN_OK = new Set([0x30CF, 0x30D2, 0x30D5, 0x30D8, 0x30DB]);

  function codepointOf(ch) {
    if (ch === 5) return 0x300C; // ホレ -> 「
    if (ch === 6) return 0x300D; // ラタ -> 」
    if (ch >= 0xA1 && ch <= 0xDF) return KANA_CP[ch - 0xA1];
    if (ch < 0x80) return ch;
    return 0x2A; // '*'
  }

  class CwDecoder extends EventTarget {
    constructor() {
      super();
      this.ctx = null;
      this.node = null;
      this.status = null;
      this.chars = [];
      this.gain = 1;
      this.spec = new Uint16Array(SPEC_BINS);
      // scope columns (min / max raw, envelope, key gate), numbered from the core's running column count
      this.sMn = new Int16Array(SR); this.sMx = new Int16Array(SR);
      this.sMag = new Uint16Array(SR); this.sGate = new Uint8Array(SR);
      this.sTotal = 0;
      this.ticker = [];  // decoded characters at the scope column they ended on, { ch, col }
      this.inRate = 0; this.inRateMs = 0; this.lastPushed = -1; this.lastT = 0; // input rate (8000 sps when nothing is lost)
      this.lastClip = 0; this.clipMs = 0;
    }

    get active() { return !!this.node; }
    get text() { return String.fromCodePoint(...this.chars); }
    get wpm() { return this.status?.[ST.wpm] || 0; }
    get toneHz() { return this.status?.[ST.toneHz] || 0; }
    get toneAuto() { return !!this.status?.[ST.toneAuto]; }
    get jp() { return !!this.status?.[ST.mode]; }
    get gate() { return !!this.status?.[ST.gate]; }

    async start(ctx, src) {
      this.stop();
      if (!ctx.audioWorklet) throw new Error('AudioWorklet が使えません');
      await addWorklet(ctx, 'cw-worklet-src');
      // explicit mono: the stereo audio is mixed down
      const node = new AudioWorkletNode(ctx, 'cw-processor', {
        numberOfInputs: 1, numberOfOutputs: 1,
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      const ready = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('cwcore.wasm の読み込みに失敗しました')), 10000);
        node.port.onmessage = (e) => {
          if (e.data.type === 'ready') { clearTimeout(t); resolve(); }
          else if (e.data.type === 'frame') this._onFrame(e.data);
        };
      });
      const bytes = wasmBytes('cwcore-wasm');
      node.port.postMessage({ type: 'wasm', bytes }, [bytes]);
      node.port.postMessage({ type: 'gain', value: this.gain });
      // the worklet outputs nothing, but some engines only call process() when it reaches the destination
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink).connect(ctx.destination);
      src.connect(node);
      this.ctx = ctx; this.src = src; this.node = node; this.sink = sink;
      await ready;
      node.port.postMessage({ type: 'reset' });
      // the core restarts its column count and input counter
      this.sTotal = 0; this.ticker = []; this.lastPushed = -1; this.inRate = 0;
      this.dispatchEvent(new Event('state'));
    }

    stop() {
      if (!this.node) return;
      // flush the character still pending, then detach
      this.node.port.postMessage({ type: 'drain' });
      for (const n of [this.node, this.sink]) { try { n.disconnect(); } catch (e) { /* ignore */ } }
      try { this.src.disconnect(this.node); } catch (e) { /* ignore */ }
      this.node = this.ctx = this.src = null;
      this.dispatchEvent(new Event('state'));
    }

    toggleMode() { this.node?.port.postMessage({ type: 'toggleMode' }); }
    cycleTone() { this.node?.port.postMessage({ type: 'cycleTone' }); }
    setGain(db) { this.gain = Math.pow(10, db / 20); this.node?.port.postMessage({ type: 'gain', value: this.gain }); }
    clear() { this.chars = []; this.ticker = []; this.dispatchEvent(new Event('text')); }

    _onFrame(m) {
      this.status = m.status;
      this.spec = m.spec;
      // scope columns into the ring
      const n = m.status[ST.scopeN], first = m.colFirst, dv = new DataView(m.cols.buffer);
      for (let i = 0; i < n; i++) {
        const o = i * m.stride, k = (first + i) % SR;
        this.sMn[k] = dv.getInt16(o, true); this.sMx[k] = dv.getInt16(o + 2, true);
        this.sMag[k] = dv.getUint16(o + 4, true); this.sGate[k] = m.cols[o + 6];
      }
      if (n) this.sTotal = first + n;
      const nc = m.status[ST.charN];
      if (nc) {
        const cv = new DataView(m.chars.buffer);
        for (let i = 0; i < nc; i++) {
          const ch = m.chars[i * 8 + 4];
          this._putChar(ch);
          if (ch !== 0x20) this.ticker.push({ ch, col: cv.getUint32(i * 8, true) });
        }
        if (this.ticker.length > 96) this.ticker = this.ticker.slice(-96);
        this.dispatchEvent(new Event('text'));
      }
      // input rate from the frame-to-frame increase (below 8000: the audio thread is dropping input)
      if (this.lastPushed >= 0 && m.t > this.lastT) {
        const d = m.pushed - this.lastPushed, dt = m.t - this.lastT;
        if (d > 0) { const r = d / dt; this.inRate = this.inRate ? this.inRate + (r - this.inRate) * 0.1 : r; this.inRateMs = performance.now(); }
      }
      this.lastPushed = m.pushed; this.lastT = m.t;
      const clip = m.status[ST.clip];
      if (clip !== this.lastClip) { this.lastClip = clip; this.clipMs = performance.now(); }
    }

    _putChar(byte) {
      const cp = codepointOf(byte);
      // merge dakuten / handakuten into the previous kana (カ + ゛ -> ガ)
      if ((cp === 0x309B || cp === 0x309C) && this.chars.length) {
        const prev = this.chars[this.chars.length - 1];
        let comb = 0;
        if (cp === 0x309B && DAKUTEN_OK.has(prev)) comb = prev === 0x30A6 ? 0x30F4 : prev + 1;
        else if (cp === 0x309C && HANDAKUTEN_OK.has(prev)) comb = prev + 2;
        if (comb) { this.chars[this.chars.length - 1] = comb; return; }
      }
      this.chars.push(cp);
      if (this.chars.length > 4000) this.chars = this.chars.slice(-3000);
    }
  }

  // ---------------- FT8 / FT4 ----------------
  // 12 kHz resampling in an AudioWorklet, ft8_lib (WebAssembly) in a Worker, slots aligned to the PC clock
  // (FT8: 15 s, UTC :00 / :15 / :30 / :45; FT4: 7.5 s). Decoding starts 14.4 s (FT8) / 6.3 s (FT4) into each slot.
  // Transmit: the same Worker packs a message into tones; ft8Wave() makes the GFSK audio.
  const MODES = { FT8: { slot: 15000, decodeAt: 14400 }, FT4: { slot: 7500, decodeAt: 6300 } };

  // Channel waveform as WSJT-X's gen_ft8wave / gen_ft4wave: Gaussian-smoothed frequency (BT 2 for FT8, 1 for FT4),
  // continuous phase, tone spacing = symbol rate. FT8: 79 tones, raised-cosine ramps over 1/8 symbol at both ends.
  // FT4: 105 tones whose first and last are ramp symbols (the decoder's encode_tones fills them with the neighbouring
  // tone), ramped over the whole symbol.
  function ft8Wave(tones, f0, rate, amp = 1, ft4 = false) {
    const nsps = Math.round(rate * (ft4 ? 0.048 : 0.16)), n = tones.length * nsps;
    const erf = (x) => { // Abramowitz-Stegun 7.1.26
      const sg = Math.sign(x); x = Math.abs(x);
      const t = 1 / (1 + 0.3275911 * x);
      return sg * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
    };
    const K = Math.PI * Math.sqrt(2 / Math.log(2)), bt = ft4 ? 1 : 2, hpk = (2 * Math.PI) / nsps;
    const pulse = new Float32Array(3 * nsps);
    for (let i = 0; i < pulse.length; i++) { const t = i / nsps - 1.5; pulse[i] = (erf(K * bt * (t + 0.5)) - erf(K * bt * (t - 0.5))) / 2; }
    // phase increment per sample; the first and last tones are extended by a dummy symbol on each side
    const dphi = new Float64Array(n + 2 * nsps).fill((2 * Math.PI * f0) / rate);
    tones.forEach((tone, s) => { for (let j = 0; j < 3 * nsps; j++) dphi[j + s * nsps] += hpk * tone * pulse[j]; });
    for (let j = 0; j < 2 * nsps; j++) {
      dphi[j] += hpk * pulse[j + nsps] * tones[0];
      dphi[j + tones.length * nsps] += hpk * pulse[j] * tones[tones.length - 1];
    }
    const out = new Float32Array(n), nr = ft4 ? nsps : Math.round(nsps / 8);
    let phi = 0;
    for (let k = 0; k < n; k++) {
      out[k] = amp * Math.sin(phi);
      phi = (phi + dphi[k + nsps]) % (2 * Math.PI);
    }
    for (let i = 0; i < nr; i++) { const w = (1 - Math.cos((Math.PI * i) / nr)) / 2; out[i] *= w; out[n - 1 - i] *= w; }
    return out;
  }

  class Ft8Decoder extends EventTarget {
    constructor() {
      super();
      this.node = null; this.ctx = null;
      this.worker = new Worker(blobUrl('ft8-worker-src'));
      const bytes = wasmBytes('ft8core-wasm');
      this.worker.postMessage({ type: 'wasm', bytes }, [bytes]);
      this.worker.onmessage = ({ data: m }) => {
        if (m.type === 'decoded') this._decoded(m);
        else if (m.type === 'encoded') { this.encodes.get(m.id)?.(m); this.encodes.delete(m.id); }
      };
      this.encodes = new Map(); this.encId = 0;
      this.mode = 'FT8';
      this.cur = -1; this.collecting = false; this.decodedSlot = -1;
      this.txSlot = -1; // a slot we transmit in is not decoded (the RX audio then holds our own signal)
      // ms from the air to the audio reaching the decoder (IQ block + playback buffer); slots are shifted by it
      this.delay = 0;
      this.timer = null;
    }
    get active() { return !!this.node; }
    get slot() { return MODES[this.mode].slot; }
    get ft4() { return this.mode === 'FT4'; }
    // switch protocol: the core is re-initialised and the slot being collected is dropped
    setMode(mode) {
      if (!MODES[mode] || mode === this.mode) return;
      this.mode = mode;
      this.worker.postMessage({ type: 'init', ft4: this.ft4 });
      this.cur = -1; this.collecting = false; this.txSlot = -1;
    }

    async start(ctx, src) {
      this.stop();
      await addWorklet(ctx, 'ft8-worklet-src');
      const node = new AudioWorkletNode(ctx, 'ft8-resampler', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
      node.port.onmessage = ({ data }) => { if (this.collecting) this.worker.postMessage({ type: 'samples', s: data.s }, [data.s.buffer]); };
      const sink = ctx.createGain(); sink.gain.value = 0;
      src.connect(node); node.connect(sink).connect(ctx.destination);
      this.ctx = ctx; this.src = src; this.node = node; this.sink = sink;
      this.cur = -1; this.collecting = false;
      this.timer = setInterval(() => this._tick(), 50);
      this.dispatchEvent(new Event('state'));
    }
    stop() {
      if (!this.node) return;
      clearInterval(this.timer);
      for (const n of [this.node, this.sink]) { try { n.disconnect(); } catch (e) { /* ignore */ } }
      try { this.src.disconnect(this.node); } catch (e) { /* ignore */ }
      this.node = this.ctx = this.src = null;
      this.dispatchEvent(new Event('state'));
    }
    // message text -> { rc, text (as received), tones (Uint8Array, null when rc != 0) }
    encode(text) {
      const id = ++this.encId;
      return new Promise((res) => { this.encodes.set(id, res); this.worker.postMessage({ type: 'encode', id, text }); });
    }
    // seconds into the current slot (for the progress bar)
    get secInSlot() { return ((Date.now() - this.delay) % this.slot) / 1000; }

    _tick() {
      const SLOT = this.slot, now = Date.now() - this.delay, slot = Math.floor(now / SLOT), t = now % SLOT;
      if (slot !== this.cur) {
        // new slot: collect from its beginning; a slot joined part-way (start-up) is skipped
        this.cur = slot;
        this.collecting = t < 1000;
        this.worker.postMessage({ type: 'reset' });
      }
      if (this.collecting && t >= MODES[this.mode].decodeAt && this.decodedSlot !== slot && this.txSlot !== slot) {
        this.decodedSlot = slot;
        this.worker.postMessage({ type: 'decode', slot, mode: this.mode });
      }
    }
    _decoded(m) {
      if (m.mode !== this.mode) return; // decoded before a protocol switch
      const utc = new Date(m.slot * this.slot).toISOString().slice(11, 19).replace(/:/g, '');
      // S/N and DT come from the decoder's fine synchronisation, on WSJT-X's scales
      const rows = m.list.map((r) => ({ slot: m.slot, utc, snr: Math.round(r.snr), dt: r.dt, freq: Math.round(r.freq), text: r.text }))
        .sort((a, b) => a.freq - b.freq);
      this.dispatchEvent(new CustomEvent('decoded', { detail: { slot: m.slot, utc, rows, blocks: m.blocks } }));
    }
  }

  return { CwDecoder, Ft8Decoder, ft8Wave, addWorklet, ST, codepointOf };
})();
