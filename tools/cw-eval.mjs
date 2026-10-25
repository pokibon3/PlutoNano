// CW decoder accuracy on cw_decoder4's test recordings (web/tools/*.mp3 / .m4a) and synthetic overs, in these paths:
//   web   cw_decoder4's web page / aletest.mjs: input band-pass (Q 3) at the tone, 8 kHz straight into the core
//   pn    this app, audio straight in: 48 kHz float through the CW worklet as inlined in dist/PlutoNano.html, no band-pass
//   rx    this app's receiver: the audio on USB (data) -> CW receiver (500 Hz filter, the tone tuned to the CW pitch)
//         -> worklet
//   pnb   pn with cw_decoder4/web's input band-pass
//   rxb   rx with cw_decoder4/web's input band-pass (Q 3, following the tone) in front of the worklet
// each with NR off (A, Goertzel) and on (E, ALE amplitude). The level table scales the receiver's output.
// Usage: node tools/cw-eval.mjs [path/to/cw_decoder4/web/tools] [--paths web,rx,rxb] [--bw 500] [--keep-tone] [--show]
// Needs ffmpeg.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const DSP = require('../src/dsp.js');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DIR = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--'))) || '../cw_decoder4/web/tools';
const PATHS = opt('--paths', 'web,rx,rxb').split(',');
const BW = +opt('--bw', 500);
const NOAGC = argv.includes('--no-agc');     // rx: the receiver's AGC off (its output then scaled with --peak)
const PEAK = opt('--peak', NOAGC ? '-6' : null);  // rx: scale the receiver's output to this peak (dBFS)
if (NOAGC) DSP.AGC.prototype.process = () => {};
const KEEP = argv.includes('--keep-tone');   // rx: tune so the tone stays at its pitch (default: tuned to the CW pitch)
const html = readFileSync('dist/PlutoNano.html', 'utf8');
const tag = (id) => { const m = new RegExp(`<script type="text/plain" id="${id}">([\\s\\S]*?)</script>`).exec(html); if (!m) throw new Error(id); return m[1]; };
const wasm = (() => { const b = Buffer.from(tag('cwcore-wasm').trim(), 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); })();
const AR = 48000, R8 = 8000, DET = { A: 0, E: 4 };

// ---- decoders ----
// pn / rx: the worklet at 48 kHz (it resamples to 8 kHz itself); bpf: cw_decoder4/web's input band-pass in front, its
// centre on the tone AUTO reports (web/app.js bpfCenter)
async function worklet(x, det, bpf) {
  let Proc = null; const posted = [];
  const ctx = { sampleRate: AR, currentTime: 0, WebAssembly, Math, Uint16Array, Uint32Array, Uint8Array, Float32Array, console,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => posted.push(m) }; } },
    registerProcessor: (n, c) => { Proc = c; } };
  vm.createContext(ctx);
  vm.runInContext(tag('cw-worklet-src'), ctx);
  const p = new Proc();
  await p.onMessage({ type: 'wasm', bytes: wasm.slice(0) });
  p.onMessage({ type: 'reset' });
  p.onMessage({ type: 'det', mode: DET[det] });
  let s = '', tone = 0, fc = 0, b0, b2, a1, a2, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const blk = new Float32Array(128);
  for (let i = 0; i < x.length; i += 128) {
    ctx.currentTime = i / AR;
    let inp = x.subarray(i, i + 128);
    if (bpf) {
      const f = tone >= 400 && tone <= 1200 ? tone : 700;
      if (Math.abs(f - fc) >= 1) {
        fc = f;
        const w = 2 * Math.PI * fc / AR, al = Math.sin(w) / (2 * 3), a0 = 1 + al;
        b0 = al / a0; b2 = -al / a0; a1 = -2 * Math.cos(w) / a0; a2 = (1 - al) / a0;
      }
      const o = blk.subarray(0, inp.length);
      for (let j = 0; j < inp.length; j++) { const v = b0 * inp[j] + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = inp[j]; y2 = y1; y1 = v; o[j] = v; }
      inp = o;
    }
    p.process([[inp]]);
    if (posted.length) flush();
  }
  p.onMessage({ type: 'drain' });
  flush();
  function flush() {
    for (const m of posted) if (m.type === 'frame') { for (let i = 0; i < m.status[4]; i++) s += String.fromCharCode(m.chars[i * 8 + 4]); tone = m.status[6]; }
    posted.length = 0;
  }
  return { text: s.replace(/\s+/g, ' ').trim(), tone };
}
// web: 12-bit counts at 8 kHz straight into the core, as aletest.mjs
async function core(counts, det) {
  const { instance } = await WebAssembly.instantiate(wasm.slice(0), { env: { cos: Math.cos, sin: Math.sin } });
  const e = instance.exports;
  e.__wasm_call_ctors?.(); e.cw_init(); e.cw_reset(); e.cw_set_tone(5); e.cw_set_det(DET[det]);
  const mem = () => e.memory.buffer, cap = e.cw_in_cap();
  let got = '';
  for (let off = 0; off < counts.length; off += R8 / 4) {
    const chunk = counts.subarray(off, Math.min(off + R8 / 4, counts.length));
    for (let o = 0; o < chunk.length; o += cap) {
      const n = Math.min(cap, chunk.length - o);
      new Uint16Array(mem(), e.cw_in_ptr(), n).set(chunk.subarray(o, o + n));
      e.cw_push(n); e.cw_run();
    }
    e.cw_poll(0xFFFFFFFF, 0);
    const n = new Uint32Array(mem(), e.cw_status_ptr(), 18)[4];
    const raw = new Uint8Array(mem(), e.cw_chars_ptr(), n * 8);
    for (let i = 0; i < n; i++) got += String.fromCharCode(raw[i * 8 + 4]);
  }
  return { text: got.replace(/\s+/g, ' ').trim(), tone: new Uint32Array(mem(), e.cw_status_ptr(), 18)[6] };
}

// ---- signal paths (input: float audio at 48 kHz, the recording's level) ----
function bandpass(x, fs, f0, q) {
  const w = 2 * Math.PI * f0 / fs, al = Math.sin(w) / (2 * q), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = -2 * Math.cos(w) / a0, a2 = (1 - al) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
const toCounts = (x) => Uint16Array.from(x, (v) => Math.max(0, Math.min(4095, Math.round(2048 + v * 2048))));
function web(x48, hz) {
  const d = new DSP.RDecim(DSP.lowpass(AR, 3600, 800, 'hamming'), 6), y = new Float32Array(x48.length);
  const n = d.process(x48, x48.length, y);
  return toCounts(bandpass(y.subarray(0, n), R8, hz, 3));
}
// USB (data) transmitter -> IQ -> CW receiver tuned so the tone at hz is heard at the CW pitch
const FS = 240e3, L = 5, OFFSET = 50e3;
function rx(x48, hz) {
  const txm = new DSP.Transmitter({ fs: FS, L, mode: 'USB', bandwidth: 3000, data: true });
  const r = new DSP.Receiver({ fs: FS, offset: OFFSET + (KEEP ? DSP.CW_PITCH : hz), mode: 'CW', bandwidth: BW, deemph: 0, audioRate: AR });
  // the receiver runs before the over (its AGC settled): the first 5 s once more ahead, its output dropped
  const warm = Math.min(x48.length, 5 * AR), m = 480, out = new Float32Array(x48.length + m);
  let ph = 0, k = -Math.ceil(warm / m) * m;
  for (let p = -Math.ceil(warm / m) * m; p < x48.length; p += m) {
    const a = new Float32Array(m); a.set(x48.subarray(p < 0 ? p + Math.ceil(warm / m) * m : p, (p < 0 ? p + Math.ceil(warm / m) * m : p) + m));
    const iq = txm.process(a, m), n = iq.length / 2;
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const I = iq[2 * i] / 32768, Q = iq[2 * i + 1] / 32768, c = Math.cos(ph), s = Math.sin(ph);
      re[i] = I * c - Q * s; im[i] = I * s + Q * c;
      ph = (ph + 2 * Math.PI * OFFSET / FS) % (2 * Math.PI);
    }
    const o = r.process(re, im, n);
    for (let i = 0; i < o.length && k < out.length; i += 2, k++) if (k >= 0) out[k] = o[i];
  }
  return out.subarray(0, Math.max(0, k));
}
// scale: the receiver's output scaled to that peak (dBFS), for the level table
async function run(path, x48, hz, det, scale) {
  if (path === 'web') return core(web(x48, hz), det);
  if (path === 'pn' || path === 'pnb') return worklet(x48, det, path === 'pnb');
  if (scale === undefined && PEAK !== null) scale = +PEAK;
  let y = (x48.rx ||= rx(x48, hz));
  if (scale !== undefined) {
    let pk = 0;
    for (const v of y) pk = Math.max(pk, Math.abs(v));
    const k = Math.pow(10, scale / 20) / pk;
    y = y.map((v) => v * k);
  }
  return worklet(y, det, path === 'rxb');
}

// ---- sources ----
function load(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-ac', '1', '-ar', String(AR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
}
let rng = 12345;
const rnd = () => { rng = (rng + 0x6D2B79F5) >>> 0; let t = rng; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
  O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', '/': '-..-.' };
// aletest.mjs's synth(): SNR against white noise over the 4 kHz band of 8 kHz audio. Made at 48 kHz with the same
// noise density (sigma x sqrt(6)); the worklet's and web's 8 kHz decimation keep only that band
function synth(text, { wpm = 20, tone = 700, snr = 20, amp = 0.3 }) {
  const unit = 1.2 / wpm, keys = [[0, 0.5]];
  let first = true;
  for (const ch of text) {
    if (ch === ' ') { keys.push([0, 7 * unit]); first = true; continue; }
    if (!first) keys.push([0, 3 * unit]);
    first = false;
    MORSE[ch].split('').forEach((el, i) => { if (i) keys.push([0, unit]); keys.push([1, el === '.' ? unit : 3 * unit]); });
  }
  keys.push([0, 1.0]);
  const n = Math.round(keys.reduce((a, [, d]) => a + d, 0) * AR), env = new Float64Array(n);
  let pos = 0;
  for (const [on, d] of keys) { const len = Math.round(d * AR); if (on) env.fill(1, pos, Math.min(n, pos + len)); pos += len; }
  const rn = 240, nr = amp / Math.pow(10, snr / 20) * Math.sqrt(AR / R8), x = new Float32Array(n);   // 5 ms edges
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += env[i] - (i >= rn ? env[i - rn] : 0); x[i] = amp * (acc / rn) * Math.sin(2 * Math.PI * tone * i / AR) + nr * gauss(); }
  return x;
}

// ---- scoring (aletest.mjs) ----
function accuracy(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.max(0, 1 - prev[b.length] / a.length);
}
function accuracyPrefix(truth, got) {
  let prev = Array.from({ length: got.length + 1 }, (_, j) => j), best = 0;
  for (let i = 1; i <= truth.length; i++) {
    const cur = [i];
    for (let j = 1; j <= got.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (truth[i - 1] === got[j - 1] ? 0 : 1));
    prev = cur;
    best = Math.max(best, 1 - cur[got.length] / Math.max(i, got.length));
  }
  return best;
}
const ALICE = 'ALICE WAS BEGINNING TO GET VERY TIRED OF SITTING BY HER SISTER ON THE BANK, AND OF HAVING NOTHING TO DO: ONCE OR TWICE ' +
  'SHE HAD PEEPED INTO THE BOOK HER SISTER WAS READING, BUT IT HAD NO PICTURES OR CONVERSATIONS IN IT, AND WHAT IS THE USE OF A BOOK, ' +
  'THOUGHT ALICE WITHOUT PICTURES OR CONVERSATIONS?';
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const COLS = PATHS.flatMap((p) => ['A', 'E'].map((d) => [p, d]));
const head = (t) => console.log(`\n== ${t}\n${''.padEnd(34)}${COLS.map(([p, d]) => `${p}/${d}`.padStart(12)).join('')}`);
const line = (name, cells) => console.log(`${name.padEnd(34)}${cells.map((c) => String(c).padStart(12)).join('')}`);
const show = [];

// the tone: AUTO's pick on the plain audio (as aletest.mjs's ref section)
const toneOf = async (x) => (await worklet(x, 'A')).tone || 700;
async function row(name, x, hz, score) {
  const cells = [];
  for (const [p, d] of COLS) { const r = await run(p, x, hz, d); cells.push(score(r.text)); if (argv.includes('--show')) show.push(`${name} ${p}/${d}: ${r.text}`); }
  line(name, cells);
}

const TEXT = 'CQ CQ DE JA1ABC JA1ABC PSE K THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG 599 TU';
head(`合成 20WPM 700Hz (文字正解率、2 シード平均)、rx は CW ${BW} Hz フィルタ`);
for (const c of [{ snr: 10 }, { snr: 0 }, { snr: -3 }, { snr: -6 }, { snr: -8 }, { snr: -10 }, { snr: -3, wpm: 12 }, { snr: -3, wpm: 30 }, { snr: -3, wpm: 40 }]) {
  const sums = COLS.map(() => 0);
  for (const seed of [1, 2]) {
    rng = seed * 7919;
    const x = synth('VVV ' + TEXT, { tone: 700, ...c });
    for (let k = 0; k < COLS.length; k++) sums[k] += accuracy(TEXT, (await run(COLS[k][0], x, 700, COLS[k][1])).text.split(' ').slice(1).join(' '));
  }
  line(`${c.wpm || 20}WPM ${c.snr}dB`, sums.map((s) => pct(s / 2)));
}

head('正解文あり (全文の文字正解率)');
for (const [f, ref] of [['Vol20_Sig50_Noise100.mp3', 'Vol20_Sig50_Noise100.txt'], ['pota_qso.mp3', 'pota_qso.txt'], ['original.mp3', null]]) {
  const p = join(DIR, f);
  if (!existsSync(p)) continue;
  const x = load(p), hz = await toneOf(x);
  if (ref) {
    const truth = readFileSync(join(DIR, ref), 'utf8').toUpperCase().replace(/\s+/g, ' ').trim();
    await row(`${f} ${hz}Hz`, x, hz, (t) => pct(accuracy(truth, t)));
  } else await row(`${f} ${hz}Hz (Alice 冒頭)`, x, hz, (t) => pct(accuracyPrefix(ALICE, t)));
}

head('正解文なし (1 文字語の割合 / 文字数)');
for (const f of ['FS_sample.mp3', 'qsb_sample.mp3', 'qrm_sample.mp3']) {
  const p = join(DIR, f);
  if (!existsSync(p)) continue;
  const x = load(p), hz = await toneOf(x);
  await row(`${f} ${hz}Hz`, x, hz, (t) => { const w = t.split(' ').filter(Boolean); return `${pct(w.filter((v) => v.length === 1).length / Math.max(1, w.length))}/${w.join('').length}`; });
}

if (PATHS.some((p) => p.startsWith('rx'))) {
  const LV = [-5, -15, -25, -35], RX = COLS.filter(([p]) => p.startsWith('rx'));
  console.log(`\n== 入力レベル (受信出力のピーク dBFS、文字正解率)\n${''.padEnd(34)}${LV.map((l) => RX.map(([p, d]) => `${p}/${d} ${l}`.padStart(14)).join('')).join('')}`);
  const pk = [];
  for (const [f, ref] of [['Vol20_Sig50_Noise100.mp3', 'Vol20_Sig50_Noise100.txt'], ['pota_qso.mp3', 'pota_qso.txt']]) {
    const p = join(DIR, f);
    if (!existsSync(p)) continue;
    const x = load(p), hz = await toneOf(x);
    const truth = readFileSync(join(DIR, ref), 'utf8').toUpperCase().replace(/\s+/g, ' ').trim();
    const cells = [];
    for (const l of LV) for (const [pp, d] of RX) cells.push(pct(accuracy(truth, (await run(pp, x, hz, d, l)).text)));
    console.log(`${f.padEnd(34)}${cells.map((c) => c.padStart(14)).join('')}`);
    let m = 0;
    for (const v of x.rx) m = Math.max(m, Math.abs(v));
    pk.push(`${f} ${(20 * Math.log10(m)).toFixed(1)} dBFS`);
  }
  console.log(`(受信出力の実際のピーク: ${pk.join(', ')})`);
}

head('ノイズだけの偽文字 (文字/分)');
{
  rng = 99;
  const x = new Float32Array(60 * AR).map(() => 0.1 * Math.sqrt(AR / R8) * gauss());
  await row('合成白色ノイズ 60 秒', x, 700, (t) => t.replace(/ /g, '').length);
  const p = join(DIR, 'ノイズ7MHz(約10分).m4a');
  if (existsSync(p)) {
    const y = load(p), min = y.length / AR / 60;
    await row(`7MHz 実ノイズ ${min.toFixed(1)} 分`, y, 700, (t) => (t.replace(/ /g, '').length / min).toFixed(1));
  }
}
if (show.length) console.log('\n' + show.join('\n'));
