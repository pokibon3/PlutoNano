// Fake navigator.usb with a simulated RTL-SDR (RTL2832U + R820T).
// Injected by tools/browser-check.mjs --mock when MOCK=tools/mock-rtl.js to
// exercise the app with src/rtlsdr.js without hardware: register writes are
// accepted, the tuner answers the probe and reports PLL lock, and the bulk
// endpoint streams 8-bit I/Q with a tone 100 kHz above the LO.
(() => {
  const bitrev = (b) => { let r = 0; for (let i = 0; i < 8; i++) r |= ((b >> i) & 1) << (7 - i); return r; };
  // R820T status registers as sent on the wire: the chip id (probed
  // unreversed), then bit-reversed PLL lock, and filter calibration code 5
  // with VCO fine tune 2.
  const TUNER = [0x69, 0x00, bitrev(0x40), 0x00, bitrev(0x25)];
  let rate = 2.4e6, phase = 0;
  const ok = (data) => ({ status: 'ok', data: data && new DataView(data.buffer) });

  const dev = {
    vendorId: 0x0bda, productId: 0x2838, productName: 'RTL2838UHIDIR', serialNumber: '00000001',
    opened: false, configuration: null,
    async open() { this.opened = true; this.configuration = { configurationValue: 1, interfaces: [] }; },
    async selectConfiguration() {},
    async claimInterface() {},
    async releaseInterface() {},
    async close() { this.opened = false; },
    async reset() {},
    async controlTransferIn(setup, len) {
      const block = setup.index >> 8;
      if (block === 6 && setup.value === 0x34) return ok(Uint8Array.from({ length: len }, (_, i) => TUNER[i] ?? 0));
      return ok(new Uint8Array(len));
    },
    async controlTransferOut(setup, data) {
      // Sample rate ratio (demod page 1, 0x9f): high 16 bits of xtal * 2^22 / rate.
      if ((setup.index & 0xff) === 0x11 && setup.value === ((0x9f << 8) | 0x20)) {
        const hi = (data[0] << 8) | data[1];
        if (hi) rate = 28.8e6 * 4194304 / (hi * 65536);
      }
      return { status: 'ok', bytesWritten: data.length };
    },
    async transferIn(ep, len) {
      // Paced at the sample rate like the real device.
      await new Promise((r) => setTimeout(r, len / 2 / rate * 1000));
      const u8 = new Uint8Array(len), w = 2 * Math.PI * 100e3 / rate;
      for (let i = 0; i < len; i += 2) {
        phase += w;
        u8[i] = 127.5 + 30 * Math.cos(phase) + (Math.random() - 0.5) * 6;
        u8[i + 1] = 127.5 + 30 * Math.sin(phase) + (Math.random() - 0.5) * 6;
      }
      phase %= 2 * Math.PI;
      return ok(u8);
    },
  };
  const usb = new EventTarget();
  usb.getDevices = async () => [dev];
  usb.requestDevice = async () => dev;
  Object.defineProperty(navigator, 'usb', { value: usb, configurable: true });
})();
