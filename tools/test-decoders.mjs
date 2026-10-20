// Decodes synthetic FT8 / FT4 slots and keyed CW with the decoder cores as inlined in
// dist/PlutoNano.html (worker / worklet code run in Node with small shims).
// Usage: node tools/test-decoders.mjs [page.html]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(process.argv[2] || 'dist/PlutoNano.html', 'utf8');
const tag = (id) => { const m = new RegExp(`<script type="text/plain" id="${id}">([\\s\\S]*?)</script>`).exec(html); if (!m) throw new Error(id); return m[1]; };
const b64 = (id) => { const b = Buffer.from(tag(id).trim(), 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };

// ---- FT8 / FT4: worker code in a vm context ----
async function ft8Test(ft4) {
  const out = [];
  const ctx = { postMessage: (m) => out.push(m), WebAssembly, TextDecoder, TextEncoder, Float32Array, Uint8Array, DataView, Promise, console };
  vm.createContext(ctx);
  vm.runInContext(tag('ft8-worker-src'), ctx);
  const send = (m) => ctx.onmessage({ data: m });
  await send({ type: 'wasm', bytes: b64('ft8core-wasm') });
  if (ft4) await send({ type: 'init', ft4: true });
  const msgs = ['CQ JA1ZZZ PM95', 'JA2YYY JA1ZZZ -12', 'JA1ZZZ JA2YYY R-08'];
  const freqs = [800, 1400, 2100];
  const rate = 12000, slot = ft4 ? 7.5 : 15, N = Math.round(rate * slot);
  const audio = new Float32Array(N);
  let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < N; i++) { const u = rnd() || 1e-9, v = rnd(); audio[i] = 0.05 * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  for (let k = 0; k < msgs.length; k++) {
    await send({ type: 'encode', id: k, text: msgs[k] });
    const enc = out.pop();
    if (enc.rc) throw new Error('encode ' + msgs[k]);
    const w = ft8Wave(enc.tones, freqs[k], rate, 0.02, ft4);
    const at = Math.round(0.5 * rate);
    for (let i = 0; i < w.length && at + i < N; i++) audio[at + i] += w[i];
  }
  await send({ type: 'reset' });
  for (let p = 0; p < N; p += 1920) await send({ type: 'samples', s: audio.slice(p, p + 1920) });
  await send({ type: 'decode', slot: 0, mode: ft4 ? 'FT4' : 'FT8' });
  const r = out.pop();
  console.log(ft4 ? 'FT4' : 'FT8', r.list.map((x) => `${x.snr.toFixed(0)} ${x.dt.toFixed(1)} ${x.freq.toFixed(0)} ${x.text}`));
  return msgs.every((m) => r.list.some((x) => x.text === m));
}

// WSJT-X style GFSK (from the FTX-1 Controller js/ft8.js)
function ft8Wave(tones, f0, rate, amp = 1, ft4 = false) {
  const nsps = Math.round(rate * (ft4 ? 0.048 : 0.16)), n = tones.length * nsps;
  const erf = (x) => { const sg = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
    return sg * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
  const K = Math.PI * Math.sqrt(2 / Math.log(2)), bt = ft4 ? 1 : 2, hpk = (2 * Math.PI) / nsps;
  const pulse = new Float32Array(3 * nsps);
  for (let i = 0; i < pulse.length; i++) { const t = i / nsps - 1.5; pulse[i] = (erf(K * bt * (t + 0.5)) - erf(K * bt * (t - 0.5))) / 2; }
  const dphi = new Float64Array(n + 2 * nsps).fill((2 * Math.PI * f0) / rate);
  tones.forEach((tone, s) => { for (let j = 0; j < 3 * nsps; j++) dphi[j + s * nsps] += hpk * tone * pulse[j]; });
  for (let j = 0; j < 2 * nsps; j++) { dphi[j] += hpk * pulse[j + nsps] * tones[0]; dphi[j + tones.length * nsps] += hpk * pulse[j] * tones[tones.length - 1]; }
  const out = new Float32Array(n); let phi = 0;
  for (let k = 0; k < n; k++) { out[k] = amp * Math.sin(phi); phi = (phi + dphi[k + nsps]) % (2 * Math.PI); }
  return out;
}

// ---- CW: worklet code with AudioWorkletProcessor shims ----
async function cwTest() {
  let Proc = null; const posted = [];
  const ctx = { sampleRate: 48000, currentTime: 0, WebAssembly, Math, Uint16Array, Uint32Array, Uint8Array, Float32Array, console,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => posted.push(m) }; } },
    registerProcessor: (n, c) => { Proc = c; } };
  vm.createContext(ctx);
  vm.runInContext(tag('cw-worklet-src'), ctx);
  const p = new Proc();
  await p.onMessage({ type: 'wasm', bytes: b64('cwcore-wasm') });
  p.onMessage({ type: 'reset' });
  const code = { A: '.-', C: '-.-.', D: '-..', E: '.', J: '.---', K: '-.-', Q: '--.-', Z: '--..', 1: '.----', T: '-', S: '...' };
  const text = 'CQ CQ DE JA1ZZZ JA1ZZZ K', dot = 1.2 / 20, fs = 48000;
  const marks = []; let t = 0.5;
  for (const w of text.split(' ')) { for (const ch of w) { for (const e of code[ch]) { const d = e === '.' ? dot : 3 * dot; marks.push([t, t + d]); t += d + dot; } t += 2 * dot; } t += 4 * dot; }
  const N = Math.round((t + 2) * fs), x = new Float32Array(N);
  for (const [a, b] of marks) for (let i = Math.round(a * fs); i < b * fs; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 700 * i / fs);
  for (let i = 0; i < N; i++) x[i] += (Math.random() - 0.5) * 0.02;
  for (let i = 0; i < N; i += 128) { ctx.currentTime = i / fs; p.process([[x.subarray(i, i + 128)]]); }
  p.onMessage({ type: 'drain' });
  let s = '', wpm = 0, tone = 0;
  for (const m of posted) if (m.type === 'frame') { for (let i = 0; i < m.status[4]; i++) s += String.fromCharCode(m.chars[i * 8 + 4]); wpm = m.status[5]; tone = m.status[6]; }
  console.log('CW', JSON.stringify(s), wpm, 'WPM', tone, 'Hz');
  return s.includes('JA1ZZZ');
}

const res = [await ft8Test(false), await ft8Test(true), await cwTest()];
console.log(res.every(Boolean) ? 'PASS' : 'FAIL', res);
if (!res.every(Boolean)) process.exit(1);
