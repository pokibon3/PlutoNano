// Exercises the TX path of src/pluto.js on real hardware at the minimum
// level (-89.75 dB attenuation): streams a tone 10 kHz above the TX LO
// while receiving at the same frequency, and reports what RX sees.
// Usage: node tools/test-tx.mjs [MHz] [atten dB] [seconds]   (default 433.5 MHz, -89.75 dB, 1.6 s)
import { createRequire } from 'node:module';
import { WebUSB } from 'usb';

const require = createRequire(import.meta.url);
const Pluto = require('../src/pluto.js');
const DSP = require('../src/dsp.js');

const f = (+process.argv[2] || 433.5) * 1e6;
const atten = Math.max(-89.75, Math.min(-20, +process.argv[3] || -89.75)); // never above -20 dB here
const fs = 2.4e6, N = 32768, tone = 10e3;
const usb = new WebUSB({ allowAllDevices: true });
const pluto = await Pluto.getPaired(usb);
if (!pluto) { console.error('Pluto not found'); process.exit(1); }
await pluto.open();
console.log('pipes', pluto.pipes.length, 'canTx', pluto.canTx);

const peak = async (label) => {
  const iq = await pluto.readRx();
  const spec = new DSP.Spectrum(4096, 'bh');
  for (let i = 0; i + 4096 <= iq.length / 2; i += 4096) spec.addFrame(iq, i);
  const db = spec.take();
  const bin = Math.round(tone / (fs / 4096)) + 2048;
  let floor = 0;
  for (let i = 100; i < 1100; i++) floor += db[i];
  console.log(`${label}: level at +10 kHz ${db[bin].toFixed(1)} dBFS, floor ${(floor / 1000).toFixed(1)} dBFS`);
};

await pluto.txIdle();
await pluto.setSampleRate(fs);
await pluto.setBandwidth(2e6);
await pluto.setFrequency(f);
await pluto.setGainMode('manual');
await pluto.setGain(60);
await pluto.setTxFrequency(f);
await pluto.startRx(65536);
await pluto.readRx();
await peak('TX idle  ');

// Tone at +10 kHz, amplitude 0.5 of full scale, MSB-aligned 12-bit.
const block = new Int16Array(N * 2);
let ph = 0;
const fill = () => {
  for (let i = 0; i < N; i++) {
    block[2 * i] = Math.round(Math.cos(ph) * 0.5 * 2047) << 4;
    block[2 * i + 1] = Math.round(Math.sin(ph) * 0.5 * 2047) << 4;
    ph += 2 * Math.PI * tone / fs;
  }
  ph %= 2 * Math.PI;
};
await pluto.setTxAttenuation(atten);
console.log('TX atten', await pluto.phyRead(Pluto.TX, 'hardwaregain'), 'TX LO', await pluto.phyRead(Pluto.TX_LO, 'frequency'),
  'port', await pluto.phyRead(Pluto.TX, 'rf_port_select'), 'ensm', await pluto.phyRead(null, 'ensm_mode'));
await pluto.setKernelBuffers(4, pluto.txDev);
await pluto.startTx(N);
const t0 = performance.now();
let sent = 0;
const writer = (async () => {
  const blocks = Math.round((+process.argv[4] || 1.6) * fs / N);
  for (let i = 0; i < blocks; i++) { fill(); sent += (await pluto.writeTx(block)) / 4; }
})();
await new Promise((r) => setTimeout(r, 500));
await pluto.readRx();
await peak(`TX ${atten}`);
await writer;
const dt = (performance.now() - t0) / 1000;
console.log(`wrote ${sent} samples in ${dt.toFixed(2)}s = ${(sent / dt / 1e6).toFixed(2)} MSPS`);
await pluto.stopTx();
await pluto.txIdle();
await pluto.readRx();
await peak('TX off   ');
await pluto.close();
console.log('ok');
