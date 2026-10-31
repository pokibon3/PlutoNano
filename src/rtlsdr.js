// RTL-SDR (RTL2832U + R820T / R820T2, e.g. RTL-SDR Blog V3) driver over WebUSB.
//
// A port of the parts of librtlsdr (rtl-sdr.c, tuner_r82xx.c) this app needs:
// baseband init, sample rate, the R82xx tuner (PLL, filters, gain), direct
// sampling on the Q branch for HF (the V3's 0.5-28.8 MHz input) and the
// bias tee on GPIO 0. Exposes the same methods as pluto.js where they make
// sense, so the app drives either device.
// Works with navigator.usb in the browser and node-usb's WebUSB in Node.

(function (root) {
  'use strict';

  const FILTERS = [{ vendorId: 0x0bda, productId: 0x2838 }, { vendorId: 0x0bda, productId: 0x2832 }];

  // Register blocks.
  const DEMODB = 0, USBB = 1, SYSB = 2, IICB = 6;
  const USB_SYSCTL = 0x2000, USB_EPA_CTL = 0x2148, USB_EPA_MAXPKT = 0x2158;
  const DEMOD_CTL = 0x3000, GPO = 0x3001, GPOE = 0x3003, GPD = 0x3004, DEMOD_CTL_1 = 0x300b;

  const XTAL = 28.8e6;
  const TWO_POW22 = 4194304;
  const R82XX_ADDR = 0x34, R82XX_CHECK = 0x69;
  const R82XX_IF_FREQ = 3570000;
  const DIRECT_BELOW = 24e6;      // the V3 feeds HF into the Q-branch ADC
  const BULK_EP = 1;
  const IN_FLIGHT = 4, MAX_QUEUED = 8;

  const INIT_ARRAY = [
    0x83, 0x32, 0x75,             // 05 to 07
    0xc0, 0x40, 0xd6, 0x6c,       // 08 to 0b
    0xf5, 0x63, 0x75, 0x68,       // 0c to 0f
    0x6c, 0x83, 0x80, 0x00,       // 10 to 13
    0x0f, 0x00, 0xc0, 0x30,       // 14 to 17
    0x48, 0xcc, 0x60, 0x00,       // 18 to 1b
    0x54, 0xae, 0x4a, 0xc0,       // 1c to 1f
  ];
  // [MHz, open_d, rf_mux_ploy, tf_c, xtal_cap0p]
  const FREQ_RANGES = [
    [0, 0x08, 0x02, 0xdf], [50, 0x08, 0x02, 0xbe], [55, 0x08, 0x02, 0x8b], [60, 0x08, 0x02, 0x7b],
    [65, 0x08, 0x02, 0x69], [70, 0x08, 0x02, 0x58], [75, 0x00, 0x02, 0x44], [80, 0x00, 0x02, 0x44],
    [90, 0x00, 0x02, 0x34], [100, 0x00, 0x02, 0x34], [110, 0x00, 0x02, 0x24], [120, 0x00, 0x02, 0x24],
    [140, 0x00, 0x02, 0x14], [180, 0x00, 0x02, 0x13], [220, 0x00, 0x02, 0x13], [250, 0x00, 0x02, 0x11],
    [280, 0x00, 0x02, 0x00], [310, 0x00, 0x41, 0x00], [450, 0x00, 0x41, 0x00], [588, 0x00, 0x40, 0x00],
    [650, 0x00, 0x40, 0x00],
  ];
  // Gain steps in 0.1 dB.
  const LNA_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];
  const MIXER_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];
  const GAINS = [0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364, 372,
    386, 402, 421, 434, 439, 445, 480, 496];
  // The tuner's own AGC drives the LNA and mixer to maximum and clips the
  // ADC near strong stations, so AGC is done here instead: the manual gain
  // follows the level of the received blocks, a step at a time.
  const AGC_TARGET = 400, AGC_HIGH = 700, AGC_LOW = 200, AGC_CLIP = 0.002, AGC_HOLD_MS = 150;
  const IF_LPF = [1700000, 1600000, 1550000, 1450000, 1200000, 900000, 700000, 550000, 450000, 350000];
  const FILT_HP_BW1 = 350000, FILT_HP_BW2 = 380000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bitrev = (b) => {
    let r = 0;
    for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i);
    return r;
  };
  // 8-bit offset binary to the 12-bit scale pluto.js delivers (full scale ~2040).
  const U8_TO_I16 = new Int16Array(256).map((_, b) => (2 * b - 255) * 8);

  class Queue {
    constructor() { this.tail = Promise.resolve(); }
    run(fn) {
      const p = this.tail.then(fn, fn);
      this.tail = p.catch(() => {});
      return p;
    }
  }

  class RtlSdr {
    constructor(usbDevice) {
      this.usb = usbDevice;
      this.q = new Queue();
      this.rx = null;
      this.tx = null;
      this.ppm = 0;
      this.rate = 2048000;
      this.bw = 0;            // tuner IF bandwidth, 0 = follow the sample rate
      this.freq = 100e6;
      this.direct = false;
      this.manual = false;
      this.gain = 0;          // dB, manual gain
      this.agcIdx = GAINS.length >> 1;
      this.agcAt = 0;
      this.agcBusy = false;
      this.applied = 0;       // gain in effect, dB (see readRx)
      this.biasTee = false;
      this.regs = new Uint8Array(32);
      this.intFreq = R82XX_IF_FREQ;
      this.tuner = 'R820T';
    }

    static matches(d) { return FILTERS.some((f) => d.vendorId === f.vendorId && d.productId === f.productId); }

    static async request(usb = root.navigator && root.navigator.usb) {
      return new RtlSdr(await usb.requestDevice({ filters: FILTERS }));
    }

    static async getPaired(usb = root.navigator && root.navigator.usb) {
      const d = (await usb.getDevices()).find(RtlSdr.matches);
      return d ? new RtlSdr(d) : null;
    }

    get canTx() { return false; }
    get xtalCorr() { return XTAL * (1 + this.ppm * 1e-6); }

    // ---- RTL2832U register access ----
    async readArray(block, addr, len) {
      const r = await this.usb.controlTransferIn({
        requestType: 'vendor', recipient: 'device', request: 0, value: addr, index: block << 8,
      }, len);
      if (r.status !== 'ok') throw new Error(`control read ${block}:${addr.toString(16)} ${r.status}`);
      return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    }

    async writeArray(block, addr, data) {
      const r = await this.usb.controlTransferOut({
        requestType: 'vendor', recipient: 'device', request: 0, value: addr, index: (block << 8) | 0x10,
      }, Uint8Array.from(data));
      if (r.status !== 'ok') throw new Error(`control write ${block}:${addr.toString(16)} ${r.status}`);
    }

    async readReg(block, addr, len = 1) {
      const d = await this.readArray(block, addr, len);
      return len === 1 ? d[0] : d[0] | (d[1] << 8);
    }

    writeReg(block, addr, val, len = 1) {
      return this.writeArray(block, addr, len === 1 ? [val & 0xff] : [(val >> 8) & 0xff, val & 0xff]);
    }

    async demodWrite(page, addr, val, len = 1) {
      const data = len === 1 ? [val & 0xff] : [(val >> 8) & 0xff, val & 0xff];
      const r = await this.usb.controlTransferOut({
        requestType: 'vendor', recipient: 'device', request: 0, value: (addr << 8) | 0x20, index: 0x10 | page,
      }, Uint8Array.from(data));
      if (r.status !== 'ok') throw new Error(`demod write ${page}:${addr.toString(16)} ${r.status}`);
      await this.demodRead(0x0a, 0x01);
    }

    async demodRead(page, addr) {
      const r = await this.usb.controlTransferIn({
        requestType: 'vendor', recipient: 'device', request: 0, value: (addr << 8) | 0x20, index: page,
      }, 1);
      if (r.status !== 'ok') throw new Error(`demod read ${page}:${addr.toString(16)} ${r.status}`);
      return r.data.getUint8(0);
    }

    i2cRepeater(on) { return this.demodWrite(1, 0x01, on ? 0x18 : 0x10); }

    // ---- R82xx tuner over I2C (the repeater must be on) ----
    async tWrite(reg, vals) {
      for (let i = 0; i < vals.length; i += 7) {
        const chunk = vals.slice(i, i + 7);
        await this.writeArray(IICB, R82XX_ADDR, [reg + i, ...chunk]);
      }
      vals.forEach((v, i) => { this.regs[reg + i] = v; });
    }

    tWriteReg(reg, val) { return this.tWrite(reg, [val & 0xff]); }

    tWriteMask(reg, val, mask) {
      return this.tWriteReg(reg, (this.regs[reg] & ~mask) | (val & mask));
    }

    async tRead(len) {
      await this.writeArray(IICB, R82XX_ADDR, [0]);
      const d = await this.readArray(IICB, R82XX_ADDR, len);
      return Array.from(d, bitrev);
    }

    async tSetMux(freq) {
      const mhz = freq / 1e6;
      let i = 0;
      while (i < FREQ_RANGES.length - 1 && mhz >= FREQ_RANGES[i + 1][0]) i++;
      const [, openD, rfMux, tfC, cap0] = FREQ_RANGES[i];
      await this.tWriteMask(0x17, openD, 0x08);
      await this.tWriteMask(0x1a, rfMux, 0xc3);
      await this.tWriteReg(0x1b, tfC);
      await this.tWriteMask(0x10, cap0, 0x0b);   // XTAL_HIGH_CAP_0P
      await this.tWriteMask(0x08, 0x00, 0x3f);
      await this.tWriteMask(0x09, 0x00, 0x3f);
    }

    // Returns true when the PLL locked.
    async tSetPll(freq) {
      const vcoMin = 1770000, vcoMax = vcoMin * 2;   // kHz
      const freqKhz = Math.round(freq / 1000);
      const pllRef = this.xtalCorr;
      await this.tWriteMask(0x10, 0x00, 0x10);       // refdiv2 = 0
      await this.tWriteMask(0x1a, 0x00, 0x0c);       // PLL autotune 128 kHz
      await this.tWriteMask(0x12, 0x80, 0xe0);       // VCO current 100

      let mixDiv = 2, divNum = 0;
      while (mixDiv <= 64) {
        if (freqKhz * mixDiv >= vcoMin && freqKhz * mixDiv < vcoMax) {
          for (let d = mixDiv; d > 2; d >>= 1) divNum++;
          break;
        }
        mixDiv <<= 1;
      }
      if (mixDiv > 64) throw new Error(`R82xx: no divider for ${freq} Hz`);
      const data = await this.tRead(5);
      const vcoFine = (data[4] & 0x30) >> 4, vcoPowerRef = 2;
      if (vcoFine > vcoPowerRef) divNum--;
      else if (vcoFine < vcoPowerRef) divNum++;
      await this.tWriteMask(0x10, divNum << 5, 0xe0);

      const vco = freq * mixDiv;
      const div = Math.floor((pllRef + 65536 * vco) / (2 * pllRef));
      const nint = Math.floor(div / 65536), sdm = div % 65536;
      if (nint > 128 / vcoPowerRef - 1) throw new Error(`R82xx: no PLL values for ${freq} Hz`);
      const ni = Math.floor((nint - 13) / 4), si = nint - 4 * ni - 13;
      await this.tWriteReg(0x14, ni + (si << 6));
      await this.tWriteMask(0x12, sdm ? 0x00 : 0x08, 0x08);   // pw_sdm
      await this.tWriteReg(0x16, sdm >> 8);
      await this.tWriteReg(0x15, sdm & 0xff);

      let locked = false;
      for (let i = 0; i < 2 && !locked; i++) {
        await sleep(2);
        locked = !!((await this.tRead(3))[2] & 0x40);
        if (!locked && !i) await this.tWriteMask(0x12, 0x60, 0xe0);   // more VCO current
      }
      if (locked) await this.tWriteMask(0x1a, 0x08, 0x08);   // PLL autotune 8 kHz
      return locked;
    }

    async tSetFreq(freq) {
      const lo = freq + this.intFreq;
      await this.tSetMux(lo);
      if (!(await this.tSetPll(lo))) throw new Error(`R82xx: PLL not locked at ${(lo / 1e6).toFixed(3)} MHz`);
    }

    async tInit() {
      this.regs.fill(0);
      await this.tWrite(0x05, INIT_ARRAY);
      // set_tv_standard(): 6 MHz digital TV, filter calibration.
      await this.tWriteMask(0x0c, 0x00, 0x0f);
      await this.tWriteMask(0x13, 49, 0x3f);        // VER_NUM
      await this.tWriteMask(0x1d, 0x00, 0x38);
      this.intFreq = R82XX_IF_FREQ;
      const hpCor = 0x6b;
      let cal = 0;
      for (let i = 0; i < 2; i++) {
        await this.tWriteMask(0x0b, hpCor, 0x60);
        await this.tWriteMask(0x0f, 0x04, 0x04);    // cali clk on
        await this.tWriteMask(0x10, 0x00, 0x03);
        if (!(await this.tSetPll(56000e3))) throw new Error('R82xx: PLL not locked for calibration');
        await this.tWriteMask(0x0b, 0x10, 0x10);    // start trigger
        await this.tWriteMask(0x0b, 0x00, 0x10);
        await this.tWriteMask(0x0f, 0x00, 0x04);    // cali clk off
        cal = (await this.tRead(5))[4] & 0x0f;
        if (cal && cal !== 0x0f) break;
      }
      if (cal === 0x0f) cal = 0;
      await this.tWriteMask(0x0a, 0x10 | cal, 0x1f);
      await this.tWriteMask(0x0b, hpCor, 0xef);
      await this.tWriteMask(0x07, 0x00, 0x80);
      await this.tWriteMask(0x06, 0x10, 0x30);
      await this.tWriteMask(0x1e, 0x60, 0x60);
      await this.tWriteMask(0x05, 0x01, 0x80);
      await this.tWriteMask(0x1f, 0x00, 0x80);
      await this.tWriteMask(0x0f, 0x00, 0x80);
      await this.tWriteMask(0x19, 0x60, 0x60);
      // sysfreq_sel(): DVB-T.
      const mixerTop = 0x24;
      await this.tWriteMask(0x1d, 0xe5, 0xc7);
      await this.tWriteMask(0x1c, mixerTop, 0xf8);
      await this.tWriteReg(0x0d, 0x53);
      await this.tWriteReg(0x0e, 0x75);
      await this.tWriteMask(0x05, 0x00, 0x60);
      await this.tWriteMask(0x06, 0x00, 0x08);
      await this.tWriteMask(0x11, 0x38, 0x38);
      await this.tWriteMask(0x17, 0x30, 0x30);
      await this.tWriteMask(0x0a, 0x40, 0x60);
      await this.tWriteMask(0x1d, 0x00, 0x38);
      await this.tWriteMask(0x1c, 0x00, 0x04);
      await this.tWriteMask(0x06, 0x00, 0x40);
      await this.tWriteMask(0x1a, 0x30, 0x30);
      await sleep(250);
      await this.tWriteMask(0x1d, 0x18, 0x38);
      await this.tWriteMask(0x1c, mixerTop, 0x04);
      await this.tWriteMask(0x1e, 14, 0x1f);
      await this.tWriteMask(0x1a, 0x20, 0x30);
    }

    async tStandby() {
      const w = [[0x06, 0xb1], [0x05, 0x03], [0x07, 0x3a], [0x08, 0x40], [0x09, 0xc0], [0x0a, 0x36],
        [0x0c, 0x35], [0x0f, 0x68], [0x11, 0x03], [0x17, 0xf4], [0x19, 0x0c]];
      for (const [r, v] of w) await this.tWriteReg(r, v);
    }

    // IF filter; returns the new IF.
    async tSetBandwidth(bw) {
      let reg0a, reg0b, intFreq;
      if (bw > 7000000) { reg0a = 0x10; reg0b = 0x0b; intFreq = 4570000; }
      else if (bw > 6000000) { reg0a = 0x10; reg0b = 0x2a; intFreq = 4570000; }
      else if (bw > IF_LPF[0] + FILT_HP_BW1 + FILT_HP_BW2) { reg0a = 0x10; reg0b = 0x6b; intFreq = 3570000; }
      else {
        reg0a = 0x00; reg0b = 0x80; intFreq = 2300000;
        let real = 0;
        if (bw > IF_LPF[0] + FILT_HP_BW1) { bw -= FILT_HP_BW2; intFreq += FILT_HP_BW2; real += FILT_HP_BW2; }
        else reg0b |= 0x20;
        if (bw > IF_LPF[0]) { bw -= FILT_HP_BW1; intFreq += FILT_HP_BW1; real += FILT_HP_BW1; }
        else reg0b |= 0x40;
        let i = 0;
        while (i < IF_LPF.length && !(bw > IF_LPF[i])) i++;
        i = Math.max(0, i - 1);
        reg0b |= 15 - i;
        real += IF_LPF[i];
        intFreq -= Math.floor(real / 2);
      }
      await this.tWriteMask(0x0a, reg0a, 0x10);
      await this.tWriteMask(0x0b, reg0b, 0xef);
      this.intFreq = intFreq;
      return intFreq;
    }

    get curGain() { return this.manual ? this.gain : GAINS[this.agcIdx] / 10; }

    async tApplyGain() {
      await this.tWriteMask(0x05, 0x10, 0x10);   // LNA auto off
      await this.tWriteMask(0x07, 0x00, 0x10);   // mixer auto off
      await this.tWriteMask(0x0c, 0x08, 0x9f);   // VGA 16.3 dB
      const want = Math.round(this.curGain * 10);
      let total = 0, lna = 0, mix = 0;
      for (let i = 0; i < 15; i++) {
        if (total >= want) break;
        total += LNA_STEPS[++lna];
        if (total >= want) break;
        total += MIXER_STEPS[++mix];
      }
      await this.tWriteMask(0x05, lna, 0x0f);
      await this.tWriteMask(0x07, mix, 0x0f);
      this.applied = this.curGain;
    }

    // Software AGC: at most one gain change every AGC_HOLD_MS, towards
    // AGC_TARGET when a block is outside AGC_LOW..AGC_HIGH, down on clipping.
    agcBlock(rms, clipFrac) {
      if (this.manual || this.direct || this.agcBusy) return;
      const now = Date.now();
      if (now - this.agcAt < AGC_HOLD_MS) return;
      let db;
      if (clipFrac > AGC_CLIP) db = -6;
      else if (rms > AGC_HIGH || rms < AGC_LOW) db = 20 * Math.log10(AGC_TARGET / Math.max(rms, 1));
      else return;
      const want = GAINS[this.agcIdx] + Math.max(-12, Math.min(12, db)) * 10;
      let idx = 0;
      for (let i = 1; i < GAINS.length; i++) if (Math.abs(GAINS[i] - want) < Math.abs(GAINS[idx] - want)) idx = i;
      if (idx === this.agcIdx) idx += db > 0 ? 1 : -1;
      idx = Math.max(0, Math.min(GAINS.length - 1, idx));
      if (idx === this.agcIdx) return;
      this.agcIdx = idx;
      this.agcAt = now;
      this.agcBusy = true;
      this.q.run(async () => {
        if (this.manual || this.direct) return;
        await this.i2cRepeater(true);
        try { await this.tApplyGain(); } finally { await this.i2cRepeater(false); }
      }).catch(() => {}).finally(() => { this.agcBusy = false; });
    }

    // ---- demodulator ----
    async setIfFreq(freq) {
      const v = Math.trunc(-freq * TWO_POW22 / this.xtalCorr);
      await this.demodWrite(1, 0x19, (v >> 16) & 0x3f);
      await this.demodWrite(1, 0x1a, (v >> 8) & 0xff);
      await this.demodWrite(1, 0x1b, v & 0xff);
    }

    async setSampleFreqCorrection() {
      const offs = Math.trunc(-this.ppm * 16777216 / 1e6) & 0xffff;
      await this.demodWrite(1, 0x3f, offs & 0xff);
      await this.demodWrite(1, 0x3e, (offs >> 8) & 0x3f);
    }

    async setFir() {
      const fir = [-54, -36, -41, -40, -32, -14, 14, 53, 101, 156, 215, 273, 327, 372, 404, 421];
      const b = new Uint8Array(20);
      for (let i = 0; i < 8; i++) b[i] = fir[i] & 0xff;
      for (let i = 0; i < 8; i += 2) {
        const v0 = fir[8 + i], v1 = fir[8 + i + 1], k = 8 + i * 3 / 2;
        b[k] = (v0 >> 4) & 0xff;
        b[k + 1] = ((v0 << 4) & 0xf0) | ((v1 >> 8) & 0x0f);
        b[k + 2] = v1 & 0xff;
      }
      for (let i = 0; i < 20; i++) await this.demodWrite(1, 0x1c + i, b[i]);
    }

    async initBaseband() {
      await this.writeReg(USBB, USB_SYSCTL, 0x09);
      await this.writeReg(USBB, USB_EPA_MAXPKT, 0x0002, 2);
      await this.writeReg(USBB, USB_EPA_CTL, 0x1002, 2);
      await this.writeReg(SYSB, DEMOD_CTL_1, 0x22);
      await this.writeReg(SYSB, DEMOD_CTL, 0xe8);
      await this.demodWrite(1, 0x01, 0x14);         // reset demod
      await this.demodWrite(1, 0x01, 0x10);
      await this.demodWrite(1, 0x15, 0x00);         // no spectrum inversion / ACI
      await this.demodWrite(1, 0x16, 0x0000, 2);
      for (let i = 0; i < 6; i++) await this.demodWrite(1, 0x16 + i, 0x00);
      await this.setFir();
      await this.demodWrite(0, 0x19, 0x05);         // SDR mode, DAGC off
      await this.demodWrite(1, 0x93, 0xf0);
      await this.demodWrite(1, 0x94, 0x0f);
      await this.demodWrite(1, 0x11, 0x00);
      await this.demodWrite(1, 0x04, 0x00);         // RF / IF AGC loop off
      await this.demodWrite(0, 0x61, 0x60);         // PID filter off
      await this.demodWrite(0, 0x06, 0x80);         // default ADC_I / ADC_Q datapath
      await this.demodWrite(1, 0xb1, 0x1b);         // zero-IF, DC and IQ estimation
      await this.demodWrite(0, 0x0d, 0x83);         // no 4.096 MHz clock out
    }

    // Tuner path: low IF from the R82xx into the I ADC, spectrum inverted.
    async tunerMode() {
      await this.demodWrite(1, 0xb1, 0x1a);
      await this.demodWrite(0, 0x08, 0x4d);
      await this.demodWrite(0, 0x06, 0x80);
      await this.demodWrite(1, 0x15, 0x01);
      await this.demodWrite(0, 0x19, 0x05);
      await this.i2cRepeater(true);
      try {
        await this.tInit();
        const ifFreq = await this.tSetBandwidth(this.bw || this.rate);
        await this.tApplyGain();
        await this.setIfFreq(ifFreq);
      } finally { await this.i2cRepeater(false); }
      this.direct = false;
    }

    // Direct sampling of the Q-branch ADC (28.8 MSPS), the tuner asleep.
    async directMode() {
      await this.i2cRepeater(true);
      try { await this.tStandby(); } finally { await this.i2cRepeater(false); }
      await this.demodWrite(1, 0xb1, 0x1a);
      await this.demodWrite(0, 0x08, 0x4d);
      await this.demodWrite(0, 0x06, 0x90);         // swap I and Q: the Q input
      await this.demodWrite(0, 0x19, this.manual ? 0x05 : 0x25);   // RTL digital AGC
      this.direct = true;
      this.applied = this.manual ? 0 : null;
    }

    async open() {
      const d = this.usb;
      if (!d.opened) await d.open();
      if (!d.configuration) await d.selectConfiguration(1);
      await d.claimInterface(0);
      return this.q.run(async () => {
        try { await this.writeReg(USBB, USB_SYSCTL, 0x09); }
        catch (e) { if (d.reset) await d.reset(); }
        await this.initBaseband();
        await this.i2cRepeater(true);
        let id;
        try { id = (await this.readArray(IICB, R82XX_ADDR, 1).catch(() => [0]))[0]; }
        finally { await this.i2cRepeater(false); }
        if (id !== R82XX_CHECK) {
          throw new Error(`R820T / R820T2 チューナーが見つかりません（この RTL-SDR のチューナーには対応していません）`);
        }
        await this.setRate(this.rate);
        await this.tunerMode();
        await this.applyFreq(this.freq);
        return this;
      });
    }

    async setRate(sps) {
      if (sps <= 225000 || sps > 3200000 || (sps > 300000 && sps <= 900000)) throw new Error(`invalid sample rate ${sps}`);
      let ratio = Math.floor(XTAL * TWO_POW22 / sps) & 0x0ffffffc;
      const real = ratio | ((ratio & 0x08000000) << 1);
      this.rate = Math.floor(XTAL * TWO_POW22 / real);
      if (!this.direct) {
        await this.i2cRepeater(true);
        try { await this.setIfFreq(await this.tSetBandwidth(this.bw || this.rate)); }
        finally { await this.i2cRepeater(false); }
      }
      await this.demodWrite(1, 0x9f, (ratio >>> 16) & 0xffff, 2);
      await this.demodWrite(1, 0xa1, ratio & 0xffff, 2);
      await this.setSampleFreqCorrection();
      await this.demodWrite(1, 0x01, 0x14);
      await this.demodWrite(1, 0x01, 0x10);
    }

    async applyFreq(hz) {
      const wantDirect = hz < DIRECT_BELOW;
      if (wantDirect && !this.direct) await this.directMode();
      else if (!wantDirect && this.direct) await this.tunerMode();
      if (this.direct) {
        // Above Nyquist (14.4 MHz) the signal is the mirror image in the
        // second zone: tune to the alias and flip the spectrum back.
        const second = hz > XTAL / 2;
        await this.demodWrite(1, 0x15, second ? 0x01 : 0x00);
        await this.setIfFreq(second ? XTAL - hz : hz);
      } else {
        await this.i2cRepeater(true);
        try { await this.tSetFreq(hz); } finally { await this.i2cRepeater(false); }
      }
      this.freq = hz;
    }

    // ---- the pluto.js interface ----
    setFrequency(hz) {
      hz = Math.round(hz);
      return this.q.run(async () => {
        await this.applyFreq(hz);
        if (this.rx) this.rx.lo = hz;
      });
    }
    async getFrequency() { return this.freq; }
    setSampleRate(sps) {
      return this.q.run(async () => {
        await this.setRate(Math.round(sps));
        if (!this.direct) await this.applyFreq(this.freq);   // the IF may have moved with the filter
      });
    }
    async getSampleRate() { return this.rate; }
    setBandwidth(hz) {
      return this.q.run(async () => {
        this.bw = hz >= this.rate ? 0 : Math.round(hz);
        if (this.direct) return;
        await this.i2cRepeater(true);
        try { await this.setIfFreq(await this.tSetBandwidth(this.bw || this.rate)); }
        finally { await this.i2cRepeater(false); }
        await this.applyFreq(this.freq);
      });
    }
    async getBandwidth() { return this.bw || this.rate; }
    setGainMode(mode) {
      return this.q.run(async () => {
        this.manual = mode === 'manual';
        if (this.direct) {
          await this.demodWrite(0, 0x19, this.manual ? 0x05 : 0x25);
          this.applied = this.manual ? 0 : null;
          return;
        }
        await this.i2cRepeater(true);
        try { await this.tApplyGain(); } finally { await this.i2cRepeater(false); }
      });
    }
    setGain(db) {
      return this.q.run(async () => {
        this.gain = RtlSdr.nearestGain(db);
        if (this.direct || !this.manual) return;
        await this.i2cRepeater(true);
        try { await this.tApplyGain(); } finally { await this.i2cRepeater(false); }
      });
    }
    // Tuner gain in dB (LNA + mixer, as librtlsdr counts it). Direct
    // sampling bypasses the tuner.
    async getGain() { return this.direct ? 0 : this.curGain; }
    static nearestGain(db) {
      let best = GAINS[0];
      for (const g of GAINS) if (Math.abs(g / 10 - db) < Math.abs(best / 10 - db)) best = g;
      return best / 10;
    }
    static get GAINS() { return GAINS.map((g) => g / 10); }
    static get MIN_FREQ() { return 500e3; }
    static get MAX_FREQ() { return 1766e6; }
    static get DIRECT_BELOW() { return DIRECT_BELOW; }

    // Crystal error in ppm; corrects both the tuner PLL and the sample rate.
    setPpm(ppm) {
      return this.q.run(async () => {
        this.ppm = ppm;
        await this.setSampleFreqCorrection();
        await this.applyFreq(this.freq);
      });
    }

    // RTL-SDR Blog V3: 4.5 V on the antenna input, switched by GPIO 0.
    setBiasTee(on) {
      return this.q.run(async () => {
        const bit = 1;
        await this.writeReg(SYSB, GPD, (await this.readReg(SYSB, GPD)) & ~bit);
        await this.writeReg(SYSB, GPOE, (await this.readReg(SYSB, GPOE)) | bit);
        const v = await this.readReg(SYSB, GPO);
        await this.writeReg(SYSB, GPO, on ? v | bit : v & ~bit);
        this.biasTee = !!on;
      });
    }

    async setKernelBuffers() { /* pluto.js only */ }
    async txIdle() { /* receive only */ }

    // ---- streaming ----
    // Several bulk transfers stay queued so no samples are lost between
    // them. Each block carries the LO in effect when its transfer was
    // queued (.lo), so blocks captured before a retune are labelled.
    async startRx(samples) {
      if (this.rx) await this.stopRx();
      await this.q.run(async () => {
        await this.writeReg(USBB, USB_EPA_CTL, 0x1002, 2);
        await this.writeReg(USBB, USB_EPA_CTL, 0x0000, 2);
      });
      const rx = this.rx = { bytes: Math.ceil(samples * 2 / 512) * 512, lo: this.freq, ready: [], waiters: [], error: null, pending: new Set() };
      const submit = () => {
        if (this.rx !== rx) return;
        const lo = rx.lo;
        const p = this.usb.transferIn(BULK_EP, rx.bytes).then((r) => {
          rx.pending.delete(p);
          if (this.rx !== rx) return;
          if (r.status !== 'ok') throw new Error(`transferIn ${r.status}`);
          const u8 = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength & ~1);
          const iq = new Int16Array(u8.length);
          let pow = 0, clip = 0;
          for (let i = 0; i < u8.length; i++) {
            const v = iq[i] = U8_TO_I16[u8[i]];
            pow += v * v;
            if (v >= 2040 || v <= -2040) clip++;
          }
          iq.lo = lo;
          // The gain is tagged on completion: queued transfers are filled
          // with the newest samples, so a gain change shows up in them.
          iq.gain = this.applied;
          if (u8.length) this.agcBlock(Math.sqrt(pow / u8.length), clip / u8.length);
          submit();
          if (rx.waiters.length) rx.waiters.shift().resolve(iq);
          else {
            rx.ready.push(iq);
            if (rx.ready.length > MAX_QUEUED) rx.ready.shift();
          }
        }).catch((e) => {
          rx.pending.delete(p);
          if (this.rx !== rx) return;
          rx.error = e;
          for (const w of rx.waiters.splice(0)) w.reject(e);
        });
        rx.pending.add(p);
      };
      for (let i = 0; i < IN_FLIGHT; i++) submit();
    }

    // Interleaved I/Q as Int16Array on the pluto.js scale, tagged with .lo
    // and .gain (tuner gain in dB; null under the digital AGC of direct
    // sampling, where the level is not known).
    readRx() {
      const rx = this.rx;
      if (!rx) return Promise.reject(new Error('RX not started'));
      if (rx.ready.length) return Promise.resolve(rx.ready.shift());
      if (rx.error) return Promise.reject(rx.error);
      return new Promise((resolve, reject) => rx.waiters.push({ resolve, reject }));
    }

    async stopRx() {
      const rx = this.rx;
      if (!rx) return;
      this.rx = null;
      for (const w of rx.waiters.splice(0)) w.reject(new Error('RX stopped'));
      // Queued transfers complete as the device keeps streaming.
      await Promise.race([Promise.allSettled([...rx.pending]), sleep(500)]);
    }

    async close() {
      try { await this.stopRx(); } catch (e) { /* device may be gone */ }
      try { if (this.biasTee) await this.setBiasTee(false); } catch (e) {}
      try { await this.usb.releaseInterface(0); } catch (e) {}
      try { await this.usb.close(); } catch (e) {}
    }
  }

  RtlSdr.FILTERS = FILTERS;

  if (typeof module !== 'undefined' && module.exports) module.exports = RtlSdr;
  else root.RtlSdr = RtlSdr;
})(typeof self !== 'undefined' ? self : globalThis);
