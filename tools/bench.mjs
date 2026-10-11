import { createRequire } from 'node:module';
import { WebUSB } from 'usb';
const require = createRequire(import.meta.url);
const Pluto = require('../src/pluto.js');
const p = await (await Pluto.getPaired(new WebUSB({ allowAllDevices: true }))).open();
for (const sr of [5e6, 10e6, 20e6, 30.72e6]) {
  await p.setSampleRate(sr);
  for (const N of [65536, 262144]) {
    await p.startRx(N);
    await p.readRx();
    const t0 = performance.now(); let tot = 0;
    while (performance.now() - t0 < 1500) tot += (await p.readRx()).length / 2;
    const dt = (performance.now() - t0) / 1000;
    console.log(`SR ${sr / 1e6} N ${N}: ${(tot / dt / 1e6).toFixed(2)} MSPS`);
    await p.stopRx();
  }
}
// Retune + read latency for sweep mode.
await p.setSampleRate(20e6);
await p.startRx(16384);
const t0 = performance.now();
for (let i = 0; i < 50; i++) { await p.setFrequency(100e6 + i * 16e6); await p.readRx(); await p.readRx(); }
console.log('retune+2 reads:', ((performance.now() - t0) / 50).toFixed(1), 'ms/step');
await p.close();
