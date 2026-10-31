// Exercises src/rtlsdr.js against a real RTL-SDR using node-usb's WebUSB.
import { createRequire } from 'node:module';
import { WebUSB } from 'usb';

const require = createRequire(import.meta.url);
const RtlSdr = require('../src/rtlsdr.js');

const usb = new WebUSB({ allowAllDevices: true });
const rtl = await RtlSdr.getPaired(usb);
if (!rtl) { console.error('RTL-SDR not found'); process.exit(1); }

let t = performance.now();
await rtl.open();
console.log(`open ${(performance.now() - t).toFixed(0)} ms, rate ${rtl.rate}, IF ${rtl.intFreq}`);

await rtl.setSampleRate(2.4e6);
await rtl.setGainMode('slow_attack');
t = performance.now();
await rtl.setFrequency(80e6);
console.log(`tune ${(performance.now() - t).toFixed(1)} ms, rate ${await rtl.getSampleRate()}, gain(AGC) ${(await rtl.getGain()).toFixed(1)} dB`);

// Strongest bins of an averaged spectrum, as offsets from the LO.
function peaks(blocks, fs, n = 4) {
  const N = 1024, pow = new Float64Array(N);
  for (const iq of blocks) {
    for (let f = 0; f + 2 * N <= iq.length; f += 2 * N * 8) {
      for (let k = 0; k < N; k += 4) {          // coarse DFT: every 4th bin
        let re = 0, im = 0;
        for (let i = 0; i < N; i++) {
          const a = -2 * Math.PI * k * i / N, x = iq[f + 2 * i], y = iq[f + 2 * i + 1];
          re += x * Math.cos(a) - y * Math.sin(a);
          im += x * Math.sin(a) + y * Math.cos(a);
        }
        pow[k] += re * re + im * im;
      }
    }
  }
  const bins = [];
  for (let k = 0; k < N; k += 4) bins.push({ hz: ((k + N / 2) % N - N / 2) * fs / N, db: 10 * Math.log10(pow[k] + 1) });
  const floor = bins.map((b) => b.db).sort((a, b) => a - b)[bins.length >> 1];
  return { floor, top: bins.filter((b) => Math.abs(b.hz) > 20e3).sort((a, b) => b.db - a.db).slice(0, n) };
}

async function capture(label, reads = 30) {
  await rtl.startRx(65536);
  const t0 = performance.now();
  let total = 0, last = [];
  for (let i = 0; i < reads; i++) {
    const iq = await rtl.readRx();
    total += iq.length / 2;
    if (i >= reads - 4) last.push(iq);
  }
  const dt = (performance.now() - t0) / 1000;
  await rtl.stopRx();
  let p = 0, mx = 0, dc = 0;
  const b = last[last.length - 1];
  for (let i = 0; i < b.length; i++) { p += b[i] * b[i]; mx = Math.max(mx, Math.abs(b[i])); dc += b[i]; }
  const { floor, top } = peaks(last, rtl.rate);
  // A healthy stream is noise; a stalled demodulator makes the device repeat one short buffer.
  let period = 0;
  outer: for (let q = 2; q < b.length - 128; q += 2) {
    for (let k = 0; k < 128; k++) if (b[q + k] !== b[k]) continue outer;
    period = q / 2; break;
  }
  console.log(`${label}: ${(total / dt / 1e6).toFixed(3)} MSPS, rms ${Math.sqrt(p / b.length).toFixed(0)}, max ${mx}, dc ${(dc / b.length).toFixed(1)}, lo tag ${(b.lo / 1e6).toFixed(3)} MHz${period ? `, STALE (repeats every ${period} samples)` : ''}`);
  console.log('   peaks (dB over floor):', top.map((x) => `${(x.hz / 1e3).toFixed(0)}k ${(x.db - floor).toFixed(1)}`).join(', '));
}

await capture('FM 80.0 MHz AGC');
await rtl.setGainMode('manual');
await rtl.setGain(30);
await capture('FM 80.0 MHz manual 30 dB');
await rtl.setFrequency(1090e6);
await capture('1090 MHz');
t = performance.now();
await rtl.setFrequency(7.1e6);
console.log(`direct sampling switch ${(performance.now() - t).toFixed(0)} ms, direct=${rtl.direct}`);
await rtl.setGainMode('slow_attack');
await capture('HF 7.1 MHz (direct Q)');
await rtl.setFrequency(21.2e6);
await capture('HF 21.2 MHz (direct Q, 2nd zone)');
t = performance.now();
await rtl.setFrequency(145e6);
console.log(`back to tuner ${(performance.now() - t).toFixed(0)} ms, direct=${rtl.direct}`);
await capture('145 MHz');
await rtl.setPpm(1);
await rtl.setBiasTee(false);
await rtl.close();
console.log('ok');
