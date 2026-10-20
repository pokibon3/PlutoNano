// TX worker: microphone audio (or CW key events, or FT8 / FT4 audio) in, I/Q blocks out.
// Loaded from a Blob together with dsp.js, so DSP is a global here.

'use strict';

let tx = null;
let micPort = null;
let resampler = null, rsBuf = new Float32Array(0);
// Microphone FIFO at the modulator rate; playback starts once it holds
// FIFO_TARGET seconds so the 256-sample chunks never run it dry.
const FIFO_TARGET = 0.06;
let fifo = new Float32Array(1 << 16), fr = 0, fill = 0, primed = false;
// CW: key events in performance.now() ms, mapped to modulator samples with
// a fixed lead so they land ahead of what is already queued in the device.
const KEY_LEAD = 0.08;
let keyT0 = null, keyS0 = 0, pendingKeys = [];
// Data (FT8 / FT4): one generated waveform at the modulator rate, played from
// the next block on; silence before and after it.
let wave = null, wavePos = 0;

function push(x, n) {
  const cap = fifo.length;
  for (let i = 0; i < n; i++) {
    if (fill === cap) { fr = (fr + 1) % cap; fill--; }
    fifo[(fr + fill) % cap] = x[i];
    fill++;
  }
}

function onMic(chunk) {
  if (!tx || tx.mode === 'CW' || tx.data) return;
  if (!resampler) { push(chunk, chunk.length); return; }
  const need = Math.ceil(chunk.length / resampler.ratio) + 4;
  if (rsBuf.length < need) rsBuf = new Float32Array(need);
  push(rsBuf, resampler.process(chunk, chunk.length, rsBuf));
}

function takeAudio(m) {
  const out = new Float32Array(m);
  if (tx.data) {
    if (wave) { const n = Math.min(m, wave.length - wavePos); if (n > 0) out.set(wave.subarray(wavePos, wavePos + n)); wavePos += m; }
    return out;
  }
  const target = Math.round(tx.micRate * FIFO_TARGET);
  if (!primed && fill >= target) primed = true;
  if (!primed) return out;
  if (fill > target * 3) { fr = (fr + fill - target) % fifo.length; fill = target; }
  const n = Math.min(m, fill), cap = fifo.length;
  for (let i = 0; i < n; i++) out[i] = fifo[(fr + i) % cap];
  fr = (fr + n) % cap;
  fill -= n;
  if (n < m) primed = false; // underrun: refill before continuing
  return out;
}

function schedule(ev) {
  if (keyT0 === null) { keyT0 = ev.t; keyS0 = tx.pos + Math.round(KEY_LEAD * tx.micRate); }
  const s = keyS0 + Math.round((ev.t - keyT0) * tx.micRate / 1000);
  tx.keyAt(ev.down, Math.max(s, tx.pos));
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'config': {
      const c = m.cfg;
      tx = new DSP.Transmitter(c);
      resampler = Math.abs(c.inRate - tx.micRate) > 0.5 ? new DSP.Resampler(c.inRate / tx.micRate) : null;
      fill = fr = 0; primed = false;
      wave = null;
      keyT0 = null;
      for (const ev of pendingKeys) schedule(ev);
      pendingKeys = [];
      break;
    }
    case 'gain':
      if (tx) tx.micGain = m.gain;
      break;
    case 'wave':
      wave = m.s; wavePos = 0;
      break;
    case 'key':
      if (tx) schedule(m); else pendingKeys.push(m);
      break;
    case 'stop':
      tx = null;
      pendingKeys = [];
      break;
    case 'micPort':
      micPort = m.port;
      micPort.onmessage = (ev) => onMic(ev.data);
      break;
    case 'block': {
      if (!tx) { postMessage({ type: 'block', id: m.id, iq: null }); break; }
      const iq = tx.process(tx.mode === 'CW' ? null : takeAudio(m.m), m.m);
      postMessage({ type: 'block', id: m.id, iq }, [iq.buffer]);
      break;
    }
  }
};
