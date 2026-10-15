// Synthetic checks for src/dsp.js: FM/AM/USB tones recovered at the right pitch.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DSP = require('../src/dsp.js');

function tonePitch(x, rate) {
  const n = 1 << Math.floor(Math.log2(x.length));
  const fft = new DSP.FFT(n), re = new Float32Array(n), im = new Float32Array(n);
  const w = DSP.makeWindow('bh', n);
  for (let i = 0; i < n; i++) re[i] = x[x.length - n + i] * w[i];
  fft.transform(re, im);
  let best = 1, bp = 0, tot = 0;
  for (let i = 1; i < n / 2; i++) { const p = re[i] ** 2 + im[i] ** 2; tot += p; if (p > bp) { bp = p; best = i; } }
  let peak = 0; for (let i = best - 3; i <= best + 3; i++) peak += re[i] ** 2 + im[i] ** 2;
  return { hz: best * rate / n, snr: 10 * Math.log10(peak / (tot - peak + 1e-20)) };
}

const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

function run(mode, gen, bw, fs = 2.4e6, offset = 300e3, stereo) {
  const rx = new DSP.Receiver({ fs, offset, mode, bandwidth: bw, deemph: 0, audioRate: 48000 });
  const N = 131072, blocks = 20, out = [];
  let ph = 0, t0 = 0;
  let busy = 0;
  for (let b = 0; b < blocks; b++) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++, t0++) {
      const [a, dphi] = gen(t0 / fs);
      ph += 2 * Math.PI * (offset / fs) + dphi;
      re[i] = a * Math.cos(ph) * 0.5 + (Math.random() - 0.5) * 0.01;
      im[i] = a * Math.sin(ph) * 0.5 + (Math.random() - 0.5) * 0.01;
      // Strong interferer 1 MHz away must be rejected.
      re[i] += 0.3 * Math.cos(2 * Math.PI * -0.7e6 * t0 / fs);
      im[i] += 0.3 * Math.sin(2 * Math.PI * -0.7e6 * t0 / fs);
    }
    { const s = performance.now(); const a = rx.process(re, im, N); busy += performance.now() - s; out.push(...a); }
  }
  const cpu = busy / 10 / (blocks * N / fs);
  const L = Float32Array.from(out.filter((_, i) => i % 2 === 0));
  const R = Float32Array.from(out.filter((_, i) => i % 2 === 1));
  const r = tonePitch(L, 48000);
  if (stereo) {
    const tail = (x) => x.subarray(x.length >> 1);
    const rr = tonePitch(R, 48000);
    console.log(`${stereo.padEnd(10)} locked ${rx.stereoLocked}  L ${r.hz.toFixed(0)} Hz rms ${rms(tail(L)).toFixed(3)}  R ${rr.hz.toFixed(0)} Hz rms ${rms(tail(R)).toFixed(3)}  CPU ${cpu.toFixed(0)}%`);
    return;
  }
  console.log(`${mode.padEnd(4)} audio ${L.length} samp (expect ${Math.round(blocks * N / fs * 48000)})  tone ${r.hz.toFixed(0)} Hz  SNR ${r.snr.toFixed(1)} dB  CPU ${cpu.toFixed(0)}% of realtime  ifRate ${rx.ifRate}`);
}

const fs = 2.4e6;
run("WFM", (t) => [1, 2 * Math.PI * 75e3 * 0.5 * Math.sin(2 * Math.PI * 1000 * t) / fs], 200e3);
// Stereo MPX: (L+R) + (L-R)*sin(2wt) + pilot sin(wt), 75 kHz full deviation.
const mpx = (l, r, pilot = true) => (t) => {
  const L = l(t), R = r(t), w = 2 * Math.PI * 19000 * t;
  const x = 0.45 * (L + R) + 0.45 * (L - R) * Math.sin(2 * w) + (pilot ? 0.1 * Math.sin(w) : 0);
  return [1, 2 * Math.PI * 75e3 * x / fs];
};
const tone = (f) => (t) => Math.sin(2 * Math.PI * f * t);
const zero = () => 0;
run('WFM', mpx(tone(1000), zero), 200e3, fs, 300e3, 'L only');
run('WFM', mpx(zero, tone(400)), 200e3, fs, 300e3, 'R only');
run('WFM', mpx(tone(1000), tone(400)), 200e3, fs, 300e3, 'L1k R400');
run('WFM', mpx(tone(1000), zero, false), 200e3, fs, 300e3, 'no pilot');
run('NFM', (t) => [1, 2 * Math.PI * 3e3 * Math.sin(2 * Math.PI * 700 * t) / fs], 12.5e3);
run('AM', (t) => [1 + 0.6 * Math.sin(2 * Math.PI * 1200 * t), 0], 10e3);
run('USB', () => [1, 2 * Math.PI * 1500 / fs], 2.8e3);
run('LSB', () => [1, -2 * Math.PI * 900 / fs], 2.8e3);
run('CW', () => [1, 0], 500); // carrier on the VFO -> 700 Hz tone
run('CW', () => [1, 2 * Math.PI * 1500 / fs], 500); // 1.5 kHz off: outside the filter

// Spectrum: tone at +300 kHz lands on the right bin.
const sp = new DSP.Spectrum(8192, 'bh');
const iq = new Int16Array(8192 * 2);
for (let i = 0; i < 8192; i++) { iq[2 * i] = 1000 * Math.cos(2 * Math.PI * 300e3 * i / fs); iq[2 * i + 1] = 1000 * Math.sin(2 * Math.PI * 300e3 * i / fs); }
sp.addFrame(iq, 0);
const db = sp.take();
let bi = 0; for (let i = 0; i < db.length; i++) if (db[i] > db[bi]) bi = i;
console.log('spectrum peak bin', bi, 'freq', ((bi - 4096) * fs / 8192 / 1e3).toFixed(1), 'kHz', 'level', db[bi].toFixed(1), 'dBFS (expect', (20 * Math.log10(1000 / 2048)).toFixed(1) + ')');

// TX: modulate a tone with Transmitter, demodulate with Receiver at the
// carrier (offset 0), and check pitch, occupied bandwidth and CPU.
function txLoop(mode, bw, toneHz, opts = {}) {
  const L = 50, r = fs / L;
  const tx = new DSP.Transmitter({ fs, L, mode, bandwidth: bw, micGain: opts.gain ?? 3 });
  const rx = new DSP.Receiver({ fs, offset: 0, mode, bandwidth: bw, deemph: 0, audioRate: 48000 });
  const m = 4800, blocks = 12, out = [];
  const spec = new DSP.Spectrum(8192, 'bh');
  let t = 0, busy = 0;
  if (mode === 'CW') { tx.keyAt(true, 1000); tx.keyAt(false, 30000); tx.keyAt(true, 34000); }
  for (let b = 0; b < blocks; b++) {
    const a = new Float32Array(m);
    for (let i = 0; i < m; i++, t++) a[i] = 0.3 * Math.sin(2 * Math.PI * toneHz * t / r);
    const s = performance.now();
    const iq = tx.process(a, m);
    busy += performance.now() - s;
    if (b === blocks - 1) for (let i = 0; i + 8192 <= iq.length / 2; i += 8192) spec.addFrame(iq, i);
    const re = new Float32Array(iq.length / 2), im = new Float32Array(iq.length / 2);
    for (let i = 0; i < re.length; i++) { re[i] = iq[2 * i] / 32768; im[i] = iq[2 * i + 1] / 32768; }
    out.push(...rx.process(re, im, re.length));
  }
  const Lch = Float32Array.from(out.filter((_, i) => i % 2 === 0));
  const p = tonePitch(Lch, 48000);
  // Occupied bandwidth: span holding 99% of the power.
  const db = spec.take(), pw = Array.from(db, (d) => 10 ** (d / 10)), tot = pw.reduce((x, y) => x + y, 0);
  const binHz = fs / 8192;
  let lo = 0, hi = pw.length - 1, cut = 0;
  while (cut + pw[lo] < tot * 0.005) cut += pw[lo++];
  cut = 0; while (cut + pw[hi] < tot * 0.005) cut += pw[hi--];
  const f = (i) => ((i - 4096) * binHz / 1e3).toFixed(1);
  const cpu = busy / 10 / (blocks * m / r);
  console.log(`TX ${mode.padEnd(4)} tone ${p.hz.toFixed(0)} Hz SNR ${p.snr.toFixed(1)} dB  99% power ${f(lo)}..${f(hi)} kHz  CPU ${cpu.toFixed(0)}%`);
}
txLoop('NFM', 15e3, 1000);
txLoop('AM', 6e3, 1000);
txLoop('USB', 2.4e3, 1000);
txLoop('LSB', 2.4e3, 1000);
txLoop('CW', 500, 0);
