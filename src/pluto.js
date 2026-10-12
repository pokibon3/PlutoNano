// ADALM-Pluto driver over WebUSB.
//
// Speaks the IIOD text protocol that libiio's USB backend uses: the device
// exposes a vendor interface named "IIO" with pairs of bulk endpoints
// ("pipes"). Pipe 0 carries context/attribute commands, pipe 1 streams RX.
// Works with navigator.usb in the browser and node-usb's WebUSB in Node.

(function (root) {
  'use strict';

  const VENDOR_ID = 0x0456;
  const PRODUCT_ID = 0xb673;

  const CMD_RESET_PIPES = 0;
  const CMD_OPEN_PIPE = 1;
  const CMD_CLOSE_PIPE = 2;

  const LINE_LEN = 1024;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Serializes async operations on one pipe.
  class Queue {
    constructor() { this.tail = Promise.resolve(); }
    run(fn) {
      const p = this.tail.then(fn, fn);
      this.tail = p.catch(() => {});
      return p;
    }
  }

  class Pipe {
    constructor(dev, id, epIn, epOut) {
      this.dev = dev;
      this.id = id;
      this.epIn = epIn;
      this.epOut = epOut;
      this.queue = new Queue();
    }

    // Adds the pipe and endpoint to transfer errors, which are otherwise opaque.
    async xfer(dir, arg) {
      const ep = dir === 'in' ? this.epIn : this.epOut;
      try {
        return dir === 'in' ? await this.dev.transferIn(ep, arg) : await this.dev.transferOut(ep, arg);
      } catch (e) {
        throw new Error(`${e.message} (pipe ${this.id}, ${dir} ep ${ep})`);
      }
    }

    // Resets the data toggle on both ends. The pipe's endpoints are
    // recreated on the device by OPEN_PIPE, but the host keeps its old
    // toggle state, which Chrome on macOS reports as a transfer error.
    async clearHalt() {
      if (!this.dev.clearHalt) return;
      await this.dev.clearHalt('in', this.epIn).catch(() => {});
      await this.dev.clearHalt('out', this.epOut).catch(() => {});
    }

    async write(bytes) {
      const r = await this.xfer('out', bytes);
      if (r.status !== 'ok') throw new Error(`transferOut ${r.status}`);
    }

    async readLine() {
      // The server sends each reply line as its own USB transfer.
      for (;;) {
        const r = await this.xfer('in', LINE_LEN);
        if (r.status !== 'ok') throw new Error(`transferIn ${r.status}`);
        const s = dec.decode(r.data).replace(/^\n+/, '');
        if (s.length) return s;
      }
    }

    async readInt() {
      const line = await this.readLine();
      const v = parseInt(line, 10);
      if (Number.isNaN(v)) throw new Error(`bad reply: ${JSON.stringify(line)}`);
      return v;
    }

    async readExact(len, out, offset = 0) {
      const dst = out || new Uint8Array(len);
      let got = 0;
      while (got < len) {
        // Request whole 512-byte packets so a full packet never overflows.
        const want = Math.ceil((len - got) / 512) * 512;
        const r = await this.xfer('in', want);
        if (r.status !== 'ok') throw new Error(`transferIn ${r.status}`);
        const chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        const n = Math.min(chunk.length, len - got);
        dst.set(chunk.subarray(0, n), offset + got);
        got += n;
      }
      return dst;
    }

    async exec(cmd) {
      await this.write(enc.encode(cmd));
      return this.readInt();
    }
  }

  // Minimal parser for the PRINT context XML: device ids, names and channels.
  function parseContext(xml) {
    const devices = [];
    const devRe = /<device\s+([^>]*)>([\s\S]*?)<\/device>/g;
    const attr = (s, k) => {
      const m = new RegExp(`\\b${k}="([^"]*)"`).exec(s);
      return m ? m[1] : null;
    };
    let m;
    while ((m = devRe.exec(xml))) {
      const dev = { id: attr(m[1], 'id'), name: attr(m[1], 'name'), channels: [] };
      const chnRe = /<channel\s+([^>]*?)(\/>|>([\s\S]*?)<\/channel>)/g;
      let c;
      while ((c = chnRe.exec(m[2]))) {
        const body = c[3] || '';
        const scan = /<scan-element\s+([^>]*)\/>/.exec(body);
        let index = -1, shift = 0, format = null;
        if (scan) {
          index = parseInt(attr(scan[1], 'index'), 10);
          format = attr(scan[1], 'format');
          const sm = />>(\d+)/.exec(format || '');
          shift = sm ? parseInt(sm[1], 10) : 0;
        }
        dev.channels.push({
          id: attr(c[1], 'id'),
          type: attr(c[1], 'type'),
          index, shift, format,
        });
      }
      // Same ordering as libiio's reorder_channels(): it defines mask bits.
      dev.channels.sort((a, b) => {
        if (a.index < 0 && b.index < 0) return 0;
        if (a.index < 0) return 1;
        if (b.index < 0) return -1;
        return a.index - b.index || a.shift - b.shift;
      });
      dev.channels.forEach((ch, i) => { ch.number = i; });
      devices.push(dev);
    }
    return devices;
  }

  class Pluto {
    constructor(usbDevice) {
      this.usb = usbDevice;
      this.pipes = [];
      this.devices = [];
      this.rx = null;
    }

    static async request(usb = root.navigator && root.navigator.usb) {
      const d = await usb.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] });
      return new Pluto(d);
    }

    static async getPaired(usb = root.navigator && root.navigator.usb) {
      const list = await usb.getDevices();
      const d = list.find((x) => x.vendorId === VENDOR_ID && x.productId === PRODUCT_ID);
      return d ? new Pluto(d) : null;
    }

    async control(request, value) {
      const r = await this.usb.controlTransferOut({
        requestType: 'vendor', recipient: 'interface',
        request, value, index: this.iface,
      });
      if (r.status !== 'ok') throw new Error(`control ${request} ${r.status}`);
    }

    async open() {
      const d = this.usb;
      if (!d.opened) await d.open();
      if (!d.configuration) await d.selectConfiguration(1);

      // The IIO interface is named "IIO", but Chrome on macOS leaves
      // interfaceName null, and its class is not vendor-specific (0x02).
      // Fall back to the only interface with several interleaved IN/OUT pipes.
      const isPipes = (alt) => alt.endpoints.length >= 4 && alt.endpoints.length % 2 === 0 &&
        alt.endpoints.every((e, i) => e.direction === (i % 2 ? 'out' : 'in'));
      let found = null;
      for (const itf of d.configuration.interfaces) {
        for (const alt of itf.alternates) {
          if (alt.interfaceName === 'IIO') { found = { itf, alt }; break; }
          if (!found && isPipes(alt)) found = { itf, alt };
        }
        if (found && found.alt.interfaceName === 'IIO') break;
      }
      if (!found) {
        const desc = d.configuration.interfaces.map((i) => i.alternates.map((a) =>
          `#${i.interfaceNumber} ${a.interfaceName || '?'} cls=${a.interfaceClass} ep=${a.endpoints.length}`).join(' ')).join(', ');
        throw new Error(`IIO interface not found (config ${d.configuration.configurationValue}: ${desc})`);
      }
      this.iface = found.itf.interfaceNumber;
      await d.claimInterface(this.iface);

      // Endpoints come as interleaved IN/OUT couples, one couple per pipe.
      const eps = found.alt.endpoints;
      for (let i = 0; i + 1 < eps.length; i += 2) {
        this.pipes.push(new Pipe(d, i / 2, eps[i].endpointNumber, eps[i + 1].endpointNumber));
      }
      if (this.pipes.length < 2) throw new Error('need two IIO pipes');

      await this.control(CMD_RESET_PIPES, 0);
      await this.control(CMD_OPEN_PIPE, 0);
      await this.pipes[0].clearHalt();

      const ctl = this.pipes[0];
      const xml = await ctl.queue.run(async () => {
        const len = await ctl.exec('PRINT\r\n');
        if (len < 0) throw new Error(`PRINT failed: ${len}`);
        const buf = (await ctl.readExact(len + 1)).subarray(0, len);
        return dec.decode(buf);
      });
      this.xml = xml;
      this.devices = parseContext(xml);
      this.phy = this.findDevice('ad9361-phy');
      this.rxDev = this.findDevice('cf-ad9361-lpc');
      if (!this.phy || !this.rxDev) throw new Error('AD936x devices not found');
      return this;
    }

    findDevice(name) {
      return this.devices.find((x) => x.name === name || x.id === name) || null;
    }

    attrCmd(verb, dev, chan, attr) {
      if (chan) {
        return `${verb} ${dev.id} ${chan.output ? 'OUTPUT' : 'INPUT'} ${chan.id} ${attr}`;
      }
      return `${verb} ${dev.id} ${attr}`;
    }

    readAttr(dev, chan, attr) {
      const p = this.pipes[0];
      return p.queue.run(async () => {
        const n = await p.exec(this.attrCmd('READ', dev, chan, attr) + '\r\n');
        if (n < 0) throw new Error(`READ ${attr}: ${n}`);
        const buf = await p.readExact(n + 1);
        return dec.decode(buf.subarray(0, n)).replace(/\0+$/, '');
      });
    }

    writeAttr(dev, chan, attr, value) {
      const p = this.pipes[0];
      const data = enc.encode(String(value));
      return p.queue.run(async () => {
        await p.write(enc.encode(this.attrCmd('WRITE', dev, chan, attr) + ` ${data.length}\r\n`));
        await p.write(data);
        const r = await p.readInt();
        if (r < 0) throw new Error(`WRITE ${attr}=${value}: ${r}`);
        return r;
      });
    }

    // ---- AD9361/4 convenience ----
    phyRead(chan, attr) { return this.readAttr(this.phy, chan, attr); }
    phyWrite(chan, attr, v) { return this.writeAttr(this.phy, chan, attr, v); }

    static get RX() { return { id: 'voltage0', output: false }; }
    static get RX_LO() { return { id: 'altvoltage0', output: true }; }

    setFrequency(hz) { return this.phyWrite(Pluto.RX_LO, 'frequency', Math.round(hz)); }
    async getFrequency() { return parseInt(await this.phyRead(Pluto.RX_LO, 'frequency'), 10); }
    setSampleRate(sps) { return this.phyWrite(Pluto.RX, 'sampling_frequency', Math.round(sps)); }
    async getSampleRate() { return parseInt(await this.phyRead(Pluto.RX, 'sampling_frequency'), 10); }
    setBandwidth(hz) { return this.phyWrite(Pluto.RX, 'rf_bandwidth', Math.round(hz)); }
    async getBandwidth() { return parseInt(await this.phyRead(Pluto.RX, 'rf_bandwidth'), 10); }
    setGainMode(mode) { return this.phyWrite(Pluto.RX, 'gain_control_mode', mode); }
    setGain(db) { return this.phyWrite(Pluto.RX, 'hardwaregain', String(Math.round(db))); }
    async getGain() { return parseFloat(await this.phyRead(Pluto.RX, 'hardwaregain')); }
    // Reference clock (nominally 40 MHz). Telling the driver its true
    // frequency corrects the LO and sample rate for crystal error.
    setXoCorrection(hz) { return this.phyWrite(null, 'xo_correction', Math.round(hz)); }
    async getXoCorrection() { return parseInt(await this.phyRead(null, 'xo_correction'), 10); }
    async getRssi() { return parseFloat(await this.phyRead(Pluto.RX, 'rssi')); }
    async getRange(chan, attr) {
      const s = await this.phyRead(chan, attr);
      const m = /\[\s*(\S+)\s+(\S+)\s+(\S+)\s*\]/.exec(s);
      return m ? { min: +m[1], step: +m[2], max: +m[3] } : null;
    }

    // Number of kernel DMA blocks queued behind the stream. Fewer blocks means
    // less stale data after a retune; must be set before startRx().
    setKernelBuffers(count) {
      const p = this.pipes[0];
      return p.queue.run(async () => {
        const r = await p.exec(`SET ${this.rxDev.id} BUFFERS_COUNT ${count}\r\n`);
        if (r < 0) throw new Error(`BUFFERS_COUNT failed: ${r}`);
      });
    }

    // ---- RX streaming on pipe 1 ----
    async startRx(samples) {
      if (this.rx) await this.stopRx();
      const dev = this.rxDev;
      const words = Math.ceil(dev.channels.length / 32);
      const mask = new Uint32Array(words);
      for (const ch of dev.channels) {
        if (ch.index >= 0 && (ch.id === 'voltage0' || ch.id === 'voltage1') && ch.type === 'input') {
          mask[ch.number >> 5] |= 1 << (ch.number & 31);
        }
      }
      let maskHex = '';
      for (let i = words - 1; i >= 0; i--) maskHex += (mask[i] >>> 0).toString(16).padStart(8, '0');

      const p = this.pipes[1];
      await this.control(CMD_OPEN_PIPE, p.id);
      await p.clearHalt();
      await p.queue.run(async () => {
        const r = await p.exec(`OPEN ${dev.id} ${samples} ${maskHex}\r\n`);
        if (r < 0) throw new Error(`OPEN failed: ${r}`);
        await p.exec('TIMEOUT 2000\r\n');
      });
      this.rx = { samples, bytes: samples * 4, words };
    }

    // Returns interleaved I/Q as Int16Array (12-bit samples in 16-bit words).
    readRx() {
      const p = this.pipes[1];
      const rx = this.rx;
      if (!rx) return Promise.reject(new Error('RX not started'));
      return p.queue.run(async () => {
        const out = new Uint8Array(rx.bytes);
        await p.write(enc.encode(`READBUF ${this.rxDev.id} ${rx.bytes}\r\n`));
        let got = 0, first = true;
        while (got < rx.bytes) {
          const n = await p.readInt();
          if (n < 0) throw new Error(`READBUF failed: ${n}`);
          if (n === 0) break;
          if (first) { await p.readExact(rx.words * 8 + 1); first = false; }
          await p.readExact(n, out, got);
          got += n;
        }
        return new Int16Array(out.buffer, 0, got >> 1);
      });
    }

    async stopRx() {
      if (!this.rx) return;
      const p = this.pipes[1];
      this.rx = null;
      try {
        await p.queue.run(() => p.exec(`CLOSE ${this.rxDev.id}\r\n`));
      } finally {
        await this.control(CMD_CLOSE_PIPE, p.id).catch(() => {});
      }
    }

    async close() {
      try { await this.stopRx(); } catch (e) { /* device may be gone */ }
      try { await this.control(CMD_RESET_PIPES, 0); } catch (e) {}
      try { await this.usb.releaseInterface(this.iface); } catch (e) {}
      try { await this.usb.close(); } catch (e) {}
    }
  }

  Pluto.parseContext = parseContext;
  Pluto.VENDOR_ID = VENDOR_ID;
  Pluto.PRODUCT_ID = PRODUCT_ID;

  if (typeof module !== 'undefined' && module.exports) module.exports = Pluto;
  else root.Pluto = Pluto;
})(typeof self !== 'undefined' ? self : globalThis);
