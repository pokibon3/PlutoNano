// Fake navigator.usb with a simulated Pluto speaking the IIOD protocol.
// Injected by tools/browser-check.mjs --mock to exercise the full browser
// pipeline (USB driver, worker DSP, audio, rendering) without hardware.
(() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const XML = '<?xml version="1.0"?><context name="usb">' +
    '<device id="iio:device0" name="ad9361-phy">' +
    '<channel id="voltage0" type="input"><attribute name="sampling_frequency"/></channel>' +
    '<channel id="altvoltage0" name="RX_LO" type="output"><attribute name="frequency"/></channel>' +
    '</device>' +
    '<device id="iio:device3" name="cf-ad9361-lpc">' +
    '<channel id="voltage0" type="input"><scan-element index="0" format="le:S12/16&gt;&gt;0"/></channel>' +
    '<channel id="voltage1" type="input"><scan-element index="1" format="le:S12/16&gt;&gt;0"/></channel>' +
    '</device>' +
    '<device id="iio:device2" name="cf-ad9361-dds-core-lpc">' +
    '<channel id="voltage0" type="output"><scan-element index="0" format="le:S16/16&gt;&gt;0"/></channel>' +
    '<channel id="voltage1" type="output"><scan-element index="1" format="le:S16/16&gt;&gt;0"/></channel>' +
    '<channel id="altvoltage0" type="output"/>' +
    '</device></context>';

  const attrs = {
    'altvoltage0/frequency': '80000000',
    'altvoltage0/frequency_available': '[70000000 1 6000000000]',
    'voltage0/sampling_frequency': '2400000',
    'voltage0/rf_bandwidth': '2400000',
    'voltage0/hardwaregain': '50.000000 dB',
    'voltage0/gain_control_mode': 'slow_attack',
    'voltage0/rssi': '87.25 dB',
  };

  // Simulated RF scene: absolute-frequency signals.
  const stations = [
    { f: 80.0e6, kind: 'fm', amp: 0.3, tone: 1000 },
    { f: 80.7e6, kind: 'fm', amp: 0.12, tone: 600 },
    { f: 79.4e6, kind: 'cw', amp: 0.05 },
    { f: 145.0e6, kind: 'cw', amp: 0.08 },
    { f: 433.92e6, kind: 'cw', amp: 0.1 },
    // Keyed Morse for the CW decoder: "CQ CQ DE JA1ZZZ K" at 20 WPM, repeated.
    { f: 144.05e6, kind: 'morse', amp: 0.05, key: morseKeying('CQ CQ DE JA1ZZZ K', 20) },
  ];

  // On/off timeline in seconds: dot = 1.2 / wpm, dash 3, gaps 1 / 3 / 7 dots.
  function morseKeying(text, wpm) {
    const code = { A: '.-', C: '-.-.', D: '-..', E: '.', J: '.---', K: '-.-', Q: '--.-', Z: '--..', 1: '.----' };
    const dot = 1.2 / wpm, marks = [];
    let t = 0;
    for (const w of text.split(' ')) {
      for (const ch of w) {
        for (const el of code[ch]) { const d = el === '.' ? dot : 3 * dot; marks.push([t, t + d]); t += d + dot; }
        t += 2 * dot;
      }
      t += 4 * dot;
    }
    return { marks, period: t + 7 * dot };
  }
  const keyed = (k, sec) => { const x = sec % k.period; return k.marks.some(([a, b]) => x >= a && x < b); };
  let t = 0;
  const phases = stations.map(() => 0);

  function genIQ(samples) {
    const fs = +attrs['voltage0/sampling_frequency'];
    const lo = +attrs['altvoltage0/frequency'];
    const out = new Int16Array(samples * 2);
    for (let i = 0; i < samples; i++) {
      let re = (Math.random() - 0.5) * 0.004, im = (Math.random() - 0.5) * 0.004;
      for (let s = 0; s < stations.length; s++) {
        const st = stations[s], off = st.f - lo;
        if (Math.abs(off) > fs / 2) continue;
        if (st.kind === 'morse' && !keyed(st.key, t / fs)) continue;
        let dphi = 2 * Math.PI * off / fs;
        if (st.kind === 'fm') dphi += 2 * Math.PI * 50e3 * Math.sin(2 * Math.PI * st.tone * t / fs) / fs;
        phases[s] += dphi;
        re += st.amp * Math.cos(phases[s]);
        im += st.amp * Math.sin(phases[s]);
      }
      out[2 * i] = re * 2047;
      out[2 * i + 1] = im * 2047;
      t++;
    }
    for (let s = 0; s < phases.length; s++) phases[s] %= 2 * Math.PI;
    return new Uint8Array(out.buffer);
  }

  class Pipe {
    constructor() { this.q = []; this.waiters = []; this.pendingWrite = null; }
    push(b) { this.q.push(typeof b === 'string' ? enc.encode(b) : b); this.flush(); }
    flush() {
      while (this.q.length && this.waiters.length) {
        const { len, resolve } = this.waiters.shift();
        let c = this.q[0];
        if (c.length > len) { this.q[0] = c.subarray(len); c = c.subarray(0, len); } else this.q.shift();
        resolve({ status: 'ok', data: new DataView(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength)) });
      }
    }
    read(len) { return new Promise((resolve) => { this.waiters.push({ len, resolve }); this.flush(); }); }
  }

  function keyOf(parts) {
    // READ dev [INPUT|OUTPUT chan] attr
    if (parts.length >= 4 && (parts[2] === 'INPUT' || parts[2] === 'OUTPUT')) {
      // TX data channels share ids with RX ones (voltage0).
      const tx = parts[2] === 'OUTPUT' && /^voltage/.test(parts[3]) ? 'tx-' : '';
      return tx + parts[3] + '/' + parts[4];
    }
    return parts[2];
  }

  const pipes = [new Pipe(), new Pipe(), new Pipe()];
  // TX statistics for tools/browser-check.mjs.
  const txStats = window.__mockTx = { blocks: 0, samples: 0, peak: 0 };

  function handle(p, text) {
    if (p.pendingWrite) {
      attrs[p.pendingWrite] = text.replace(/\0+$/, '');
      p.push(text.length + '\n');
      p.pendingWrite = null;
      return;
    }
    const line = text.trim();
    const parts = line.split(' ');
    switch (parts[0]) {
      case 'PRINT': { const b = enc.encode(XML); p.push(b.length + '\n'); p.push(b); p.push('\n'); break; }
      case 'READ': {
        const v = enc.encode((attrs[keyOf(parts)] ?? '0') + '\0');
        p.push(v.length + '\n'); p.push(v); p.push('\n');
        break;
      }
      case 'WRITE': p.pendingWrite = keyOf(parts); break;
      case 'WRITEBUF': {
        p.txLeft = p.txTotal = +parts[2];
        p.push(parts[2] + '\n');
        break;
      }
      case 'READBUF': {
        const bytes = +parts[2];
        const fs = +attrs['voltage0/sampling_frequency'];
        const samples = bytes / 4;
        const delay = Math.min(200, samples / fs * 1000);
        setTimeout(() => { p.push(bytes + '\n'); p.push('00000003\n'); p.push(genIQ(samples)); }, delay);
        break;
      }
      default: p.push('0\n');
    }
  }

  const device = {
    vendorId: 0x0456, productId: 0xb673, productName: 'PlutoSDR (mock)', serialNumber: 'MOCK0001',
    opened: false, configuration: null,
    async open() { this.opened = true; this.configuration = this._cfg; },
    async selectConfiguration() { this.configuration = this._cfg; },
    async claimInterface() {}, async releaseInterface() {},
    async close() { this.opened = false; },
    async controlTransferOut() { return { status: 'ok' }; },
    async transferOut(ep, data) {
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
      const p = pipes[ep - 1];
      if (p.txLeft) {
        // WRITEBUF payload: take it at the sample rate.
        const iq = new Int16Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
        for (let i = 0; i < iq.length; i++) txStats.peak = Math.max(txStats.peak, Math.abs(iq[i]));
        p.txLeft -= u8.length;
        if (p.txLeft <= 0) {
          const bytes = p.txTotal;
          p.txLeft = 0;
          txStats.blocks++;
          txStats.samples += bytes / 4;
          setTimeout(() => p.push(bytes + '\n'), bytes / 4 / +attrs['voltage0/sampling_frequency'] * 1000);
        }
        return { status: 'ok', bytesWritten: u8.length };
      }
      handle(p, dec.decode(u8));
      return { status: 'ok', bytesWritten: u8.length };
    },
    transferIn(ep, len) { return pipes[ep - 1].read(len); },
    _cfg: {
      interfaces: [{
        interfaceNumber: 3,
        alternates: [{
          interfaceName: 'IIO', interfaceClass: 0xff,
          endpoints: [
            { endpointNumber: 1, direction: 'in' }, { endpointNumber: 1, direction: 'out' },
            { endpointNumber: 2, direction: 'in' }, { endpointNumber: 2, direction: 'out' },
            { endpointNumber: 3, direction: 'in' }, { endpointNumber: 3, direction: 'out' },
          ],
        }],
      }],
    },
  };

  const usb = new EventTarget();
  usb.getDevices = async () => [device];
  usb.requestDevice = async () => device;
  Object.defineProperty(Navigator.prototype, 'usb', { get: () => usb, configurable: true });
  window.__mockAttrs = attrs;
})();
