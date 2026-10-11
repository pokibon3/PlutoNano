// Exercises src/pluto.js against real hardware using node-usb's WebUSB.
import { createRequire } from 'node:module';
import { WebUSB } from 'usb';

const require = createRequire(import.meta.url);
const Pluto = require('../src/pluto.js');

const usb = new WebUSB({ allowAllDevices: true });
const pluto = await Pluto.getPaired(usb);
if (!pluto) { console.error('Pluto not found'); process.exit(1); }

await pluto.open();
console.log('devices:', pluto.devices.map((d) => `${d.id}=${d.name}(${d.channels.length})`).join(' '));
console.log('rx channels:', pluto.rxDev.channels.map((c) => `${c.number}:${c.id}/${c.index}`).join(' '));
console.log('LO range:', await pluto.getRange(Pluto.RX_LO, 'frequency_available'));
console.log('BW range:', await pluto.getRange(Pluto.RX, 'rf_bandwidth_available'));
console.log('SR range:', await pluto.getRange(Pluto.RX, 'sampling_frequency_available'));

await pluto.setFrequency(80e6);
await pluto.setSampleRate(2.4e6);
await pluto.setBandwidth(2e6);
await pluto.setGainMode('slow_attack');
console.log('LO', await pluto.getFrequency(), 'SR', await pluto.getSampleRate(),
  'BW', await pluto.getBandwidth(), 'gain', await pluto.getGain());

const N = 65536;
await pluto.startRx(N);
const t0 = performance.now();
let total = 0, last;
for (let i = 0; i < 40; i++) {
  last = await pluto.readRx();
  total += last.length / 2;
}
const dt = (performance.now() - t0) / 1000;
console.log(`read ${total} samples in ${dt.toFixed(2)}s = ${(total / dt / 1e6).toFixed(2)} MSPS`);
let pwr = 0, maxv = 0;
for (let i = 0; i < last.length; i++) { pwr += last[i] * last[i]; maxv = Math.max(maxv, Math.abs(last[i])); }
console.log('rms', Math.sqrt(pwr / last.length).toFixed(1), 'max', maxv, 'first IQ', Array.from(last.subarray(0, 8)));

// Retune while streaming.
await pluto.setFrequency(433.92e6);
last = await pluto.readRx();
console.log('after retune LO', await pluto.getFrequency(), 'RSSI', await pluto.getRssi());

await pluto.close();
console.log('ok');
