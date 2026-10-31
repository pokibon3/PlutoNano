// DSP worker: turns raw IQ blocks into spectrum frames and audio.
// Loaded from a Blob together with dsp.js, so DSP is a global here.

'use strict';

const cfg = {
  fs: 2.4e6, lo: 100e6, vfo: 100e6, mode: 'WFM', bandwidth: 200e3, deemph: 50e-6,
  squelch: null, stereo: true, fftSize: 8192, fps: 30, window: 'bh', smoothing: 0.8,
  audioRate: 48000, audio: false,
};

let rx = null;
let spec = null;
let smooth = null;
let audioPort = null;
let re = new Float32Array(0), im = new Float32Array(0);
let total = 0, nextEmit = 0, phase = 0;
let levelAt = 0;
let sweepSpec = null;

function rebuildReceiver() {
  rx = new DSP.Receiver({
    fs: cfg.fs, offset: cfg.vfo - cfg.lo, mode: cfg.mode, bandwidth: cfg.bandwidth,
    deemph: cfg.deemph, squelch: cfg.squelch, stereo: cfg.stereo, audioRate: cfg.audioRate,
  });
}

function rebuildSpectrum() {
  spec = new DSP.Spectrum(cfg.fftSize, cfg.window);
  smooth = null;
  phase = 0;
}

function configure(c) {
  const prev = Object.assign({}, cfg);
  Object.assign(cfg, c);
  const changed = (...keys) => keys.some((k) => k in c && c[k] !== prev[k]);
  if (!rx || changed('fs', 'mode', 'bandwidth', 'deemph', 'audioRate')) rebuildReceiver();
  else if (changed('vfo', 'lo')) rx.setOffset(cfg.vfo - cfg.lo);
  if (rx && 'squelch' in c) rx.squelch = cfg.squelch;
  if (rx && 'stereo' in c) rx.stereo = cfg.stereo;
  if (!spec || changed('fftSize', 'window')) rebuildSpectrum();
  if (changed('fs', 'fps')) { nextEmit = total; }
}

function emitSpectrum(lo) {
  const db = spec.take();
  const a = Math.min(Math.max(cfg.smoothing, 0), 0.98);
  if (smooth && smooth.length === db.length && smooth.lo === lo && a > 0) {
    for (let i = 0; i < db.length; i++) smooth[i] = smooth[i] * a + db[i] * (1 - a);
  } else {
    smooth = Float32Array.from(db);
    smooth.lo = lo;
  }
  const out = Float32Array.from(smooth);
  postMessage({ type: 'fft', db: out, f0: lo - cfg.fs / 2, binHz: cfg.fs / cfg.fftSize }, [out.buffer]);
}

// RX gain of the current block when the device tags it (RTL-SDR), so the
// S-meter follows gain steps of its AGC exactly.
let blockGain;

function handleIQ(iq, lo) {
  const n = iq.length >> 1;
  if (!n) return;

  // Spectrum: a few frames per output, spread over the block.
  const N = spec.n;
  const emitEvery = cfg.fs / cfg.fps;
  const interval = Math.max(N, Math.floor(emitEvery / 4));
  let p = phase;
  for (; p + N <= n; p += interval) {
    spec.addFrame(iq, p);
    if (total + p + N >= nextEmit) {
      emitSpectrum(lo);
      nextEmit += emitEvery;
      if (nextEmit < total + p) nextEmit = total + p + emitEvery;
    }
  }
  phase = Math.max(0, p - n);
  total += n;

  // Audio.
  if (cfg.audio && audioPort) {
    if (rx.offset !== cfg.vfo - lo) rx.setOffset(cfg.vfo - lo);
    if (re.length < n) { re = new Float32Array(n); im = new Float32Array(n); }
    for (let i = 0, j = 0; i < n; i++, j += 2) {
      re[i] = iq[j] / 2048;
      im[i] = iq[j + 1] / 2048;
    }
    const audio = rx.process(re, im, n);
    audioPort.postMessage(audio, [audio.buffer]);
  }

  if (total - levelAt >= cfg.fs / 15) {
    levelAt = total;
    postMessage({ type: 'level', db: rx.levelDb, gain: blockGain, stereo: rx.stereoLocked });
  }
}

function handleSweep(iq, lo, id) {
  const N = 1024;
  if (!sweepSpec) sweepSpec = new DSP.Spectrum(N, 'bh');
  const frames = Math.floor((iq.length >> 1) / N);
  for (let f = 0; f < frames; f++) sweepSpec.addFrame(iq, f * N);
  const db = sweepSpec.take();
  postMessage({ type: 'sweep', db, lo, id }, [db.buffer]);
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'config':
      configure(m.cfg);
      break;
    case 'audioPort':
      audioPort = m.port;
      audioPort.onmessage = (ev) => {
        const { fill, target } = ev.data;
        if (!rx || !target) return;
        const err = (fill - target) / target;
        rx.setRateCorrection(Math.max(-0.005, Math.min(0.005, err * 0.002)));
      };
      break;
    case 'iq':
      blockGain = m.gain;
      handleIQ(m.data, m.lo);
      break;
    case 'sweep':
      handleSweep(m.data, m.lo, m.id);
      break;
  }
};

configure({});
