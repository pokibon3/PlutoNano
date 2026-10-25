// Decoder and digital-mode checks on synthetic signals, with the decoder cores as inlined in
// dist/PlutoNano.html (worker / worklet code run in Node with small shims):
//   - FT8 / FT4: three overlapping messages in one slot of audio
//   - CW: keyed 700 Hz audio
//   - FT8 / FT4 transmit -> receive: ft8Wave -> USB modulator (data mode) -> USB receiver -> decoder
//   - CW transmit -> receive: key events -> CW modulator -> CW receiver -> decoder
// Usage: node tools/test-decoders.mjs [page.html]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const DSP = require('../src/dsp.js');
const html = readFileSync(process.argv[2] || 'dist/PlutoNano.html', 'utf8');
const tag = (id) => { const m = new RegExp(`<script type="text/plain" id="${id}">([\\s\\S]*?)</script>`).exec(html); if (!m) throw new Error(id); return m[1]; };
const b64 = (id) => { const b = Buffer.from(tag(id).trim(), 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
const { ft8Wave } = vm.runInNewContext(readFileSync(new URL('../src/decoders.js', import.meta.url), 'utf8') + ';PlutoDecoders', { Math, Float32Array, Float64Array, EventTarget });

let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());

// ---- FT8 / FT4 worker in a vm context ----
async function ft8Worker(ft4) {
  const out = [];
  const ctx = { postMessage: (m) => out.push(m), WebAssembly, TextDecoder, TextEncoder, Float32Array, Uint8Array, DataView, Promise, console };
  vm.createContext(ctx);
  vm.runInContext(tag('ft8-worker-src'), ctx);
  const send = async (m) => { await ctx.onmessage({ data: m }); return out.pop(); };
  await send({ type: 'wasm', bytes: b64('ft8core-wasm') });
  if (ft4) await send({ type: 'init', ft4: true });
  return {
    encode: (text) => send({ type: 'encode', id: 1, text }),
    // audio at 12 kHz, one slot from its start
    async decode(audio) {
      await send({ type: 'reset' });
      for (let p = 0; p < audio.length; p += 1920) await send({ type: 'samples', s: audio.slice(p, p + 1920) });
      return (await send({ type: 'decode', slot: 0, mode: ft4 ? 'FT4' : 'FT8' })).list;
    },
  };
}
const show = (name, list) => console.log(name, list.map((x) => `${x.snr.toFixed(0)} ${x.dt.toFixed(1)} ${x.freq.toFixed(0)} ${x.text}`));

async function ft8Test(ft4) {
  const w = await ft8Worker(ft4);
  const msgs = ['CQ JA1ZZZ PM95', 'JA2YYY JA1ZZZ -12', 'JA1ZZZ JA2YYY R-08'], freqs = [800, 1400, 2100];
  const rate = 12000, N = Math.round(rate * (ft4 ? 7.5 : 15)), audio = new Float32Array(N);
  for (let i = 0; i < N; i++) audio[i] = 0.05 * gauss();
  for (let k = 0; k < msgs.length; k++) {
    const s = ft8Wave((await w.encode(msgs[k])).tones, freqs[k], rate, 0.02, ft4), at = Math.round(0.5 * rate);
    for (let i = 0; i < s.length && at + i < N; i++) audio[at + i] += s[i];
  }
  const list = await w.decode(audio);
  show(ft4 ? 'FT4 RX' : 'FT8 RX', list);
  return msgs.every((m) => list.some((x) => x.text === m));
}

// ---- radio path: modulator at fs -> IQ (12-bit DAC scale, offset from the receiver LO, noise) -> receiver ----
const FS = 240e3, L = 5, AR = 48000, OFFSET = 50e3;
function radio(mode, bandwidth, feed, seconds, noise) {
  const txm = new DSP.Transmitter({ fs: FS, L, mode, bandwidth, data: mode === 'USB' });
  const rx = new DSP.Receiver({ fs: FS, offset: OFFSET, mode, bandwidth, deemph: 0, audioRate: AR });
  feed(txm);
  const m = 480, blocks = Math.ceil(seconds * AR / m), out = [];
  let ph = 0;
  for (let b = 0; b < blocks; b++) {
    const iq = txm.process(mode === 'USB' ? txm.audioAt(b * m, m) : null, m), n = iq.length / 2;
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const I = iq[2 * i] / 32768, Q = iq[2 * i + 1] / 32768, c = Math.cos(ph), s = Math.sin(ph);
      re[i] = I * c - Q * s + noise * gauss(); im[i] = I * s + Q * c + noise * gauss();
      ph = (ph + 2 * Math.PI * OFFSET / FS) % (2 * Math.PI);
    }
    const a = rx.process(re, im, n);
    for (let i = 0; i < a.length; i += 2) out.push(a[i]);
  }
  return Float32Array.from(out);
}

async function ft8RadioTest(ft4) {
  const w = await ft8Worker(ft4);
  const msg = 'JA2YYY JA1ZZZ RR73', enc = await w.encode(msg);
  // as the app: 0.5 s of silence, then the waveform at the modulator rate
  const wave = ft8Wave(enc.tones, 1500, AR, 0.9, ft4), lead = Math.round(0.5 * AR);
  const audio = radio('USB', 3000, (t) => {
    t.audioAt = (p, m) => { const a = new Float32Array(m); for (let i = 0; i < m; i++) { const k = p + i - lead; a[i] = k >= 0 && k < wave.length ? wave[k] : 0; } return a; };
  }, ft4 ? 7.5 : 15, 0.02);
  // 48 kHz -> 12 kHz
  const dec = new DSP.RDecim(DSP.lowpass(AR, 5000, 1000, 'hamming'), 4), a12 = new Float32Array(audio.length);
  const n = dec.process(audio, audio.length, a12);
  const list = await w.decode(a12.subarray(0, n));
  show(ft4 ? 'FT4 TX->RX' : 'FT8 TX->RX', list);
  return list.some((x) => x.text === msg && Math.abs(x.freq - 1500) < 10 && Math.abs(x.dt) < 0.3);
}

// ---- CW worklet with AudioWorkletProcessor shims ----
async function cwDecode(x) {
  let Proc = null; const posted = [];
  const ctx = { sampleRate: AR, currentTime: 0, WebAssembly, Math, Uint16Array, Uint32Array, Uint8Array, Float32Array, console,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => posted.push(m) }; } },
    registerProcessor: (n, c) => { Proc = c; } };
  vm.createContext(ctx);
  vm.runInContext(tag('cw-worklet-src'), ctx);
  const p = new Proc();
  await p.onMessage({ type: 'wasm', bytes: b64('cwcore-wasm') });
  p.onMessage({ type: 'reset' });
  p.onMessage({ type: 'det', mode: 4 });  // NR on, as the app's default
  for (let i = 0; i < x.length; i += 128) { ctx.currentTime = i / AR; p.process([[x.subarray(i, i + 128)]]); }
  p.onMessage({ type: 'drain' });
  let s = '', wpm = 0, tone = 0;
  for (const m of posted) if (m.type === 'frame') { for (let i = 0; i < m.status[4]; i++) s += String.fromCharCode(m.chars[i * 8 + 4]); wpm = m.status[5]; tone = m.status[6]; }
  return { s, wpm, tone };
}
const CODE = { A: '.-', C: '-.-.', D: '-..', E: '.', J: '.---', K: '-.-', Q: '--.-', Z: '--..', 1: '.----' };
function marks(text, wpm, t0) {
  const dot = 1.2 / wpm, out = [];
  let t = t0;
  for (const w of text.split(' ')) { for (const ch of w) { for (const e of CODE[ch]) { const d = e === '.' ? dot : 3 * dot; out.push([t, t + d]); t += d + dot; } t += 2 * dot; } t += 4 * dot; }
  return { out, end: t };
}
const CW_TEXT = 'CQ CQ DE JA1ZZZ JA1ZZZ K';

async function cwTest() {
  const { out, end } = marks(CW_TEXT, 20, 0.5), N = Math.round((end + 2) * AR), x = new Float32Array(N);
  for (const [a, b] of out) for (let i = Math.round(a * AR); i < b * AR; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 700 * i / AR);
  for (let i = 0; i < N; i++) x[i] += 0.01 * gauss();
  const r = await cwDecode(x);
  console.log('CW RX', JSON.stringify(r.s), r.wpm, 'WPM', r.tone, 'Hz');
  return r.s.includes('JA1ZZZ');
}

async function cwRadioTest() {
  const { out, end } = marks(CW_TEXT, 20, 0.5);
  const audio = radio('CW', 500, (t) => { for (const [a, b] of out) { t.keyAt(true, Math.round(a * AR)); t.keyAt(false, Math.round(b * AR)); } }, end + 2, 0.02);
  const r = await cwDecode(audio);
  console.log('CW TX->RX', JSON.stringify(r.s), r.wpm, 'WPM', r.tone, 'Hz');
  return r.s.includes('JA1ZZZ');
}

const res = [await ft8Test(false), await ft8Test(true), await cwTest(), await ft8RadioTest(false), await ft8RadioTest(true), await cwRadioTest()];
console.log(res.every(Boolean) ? 'PASS' : 'FAIL', res);
if (!res.every(Boolean)) process.exit(1);
