// DSP building blocks: FFT, windows, FIR design, decimators, resampler and
// demodulators. Plain Float32Array code so it runs in a worker or in Node.

(function (root) {
  'use strict';

  const TAU = 2 * Math.PI;

  class FFT {
    constructor(n) {
      this.n = n;
      this.cos = new Float32Array(n / 2);
      this.sin = new Float32Array(n / 2);
      for (let k = 0; k < n / 2; k++) {
        this.cos[k] = Math.cos(TAU * k / n);
        this.sin[k] = Math.sin(TAU * k / n);
      }
      this.rev = new Uint32Array(n);
      const bits = Math.log2(n);
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        this.rev[i] = r;
      }
    }

    // In-place forward transform.
    transform(re, im) {
      const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half, c = cs[k], s = sn[k];
            const tr = re[l] * c + im[l] * s;
            const ti = im[l] * c - re[l] * s;
            re[l] = re[j] - tr; im[l] = im[j] - ti;
            re[j] += tr; im[j] += ti;
          }
        }
      }
    }
  }

  function makeWindow(type, n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = TAU * i / (n - 1);
      if (type === 'hann') w[i] = 0.5 - 0.5 * Math.cos(x);
      else if (type === 'rect') w[i] = 1;
      else w[i] = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
    }
    return w;
  }

  // Windowed-sinc lowpass. cutoff is in Hz at rate fs. Odd length, unity DC gain.
  function lowpass(fs, cutoff, transition, window = 'blackman') {
    const k = window === 'blackman' ? 5.5 : 3.3;
    let n = Math.ceil(k * fs / transition) | 1;
    n = Math.max(15, Math.min(n, 4095)) | 1;
    const fc = cutoff / fs, m = (n - 1) / 2;
    const h = new Float32Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const t = i - m;
      const sinc = t === 0 ? 2 * fc : Math.sin(TAU * fc * t) / (Math.PI * t);
      const x = TAU * i / (n - 1);
      const w = window === 'blackman'
        ? 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x)
        : 0.54 - 0.46 * Math.cos(x);
      h[i] = sinc * w;
      sum += h[i];
    }
    for (let i = 0; i < n; i++) h[i] /= sum;
    return h;
  }

  // Complex FIR filter that only computes every D-th output.
  class CDecim {
    constructor(taps, D) {
      this.h = taps; this.D = D; this.L = taps.length;
      this.hr = new Float32Array(this.L - 1);
      this.hi = new Float32Array(this.L - 1);
      this.br = new Float32Array(0); this.bi = new Float32Array(0);
      this.pos = 0;
    }

    process(re, im, n, outRe, outIm) {
      const L = this.L, D = this.D, h = this.h, tot = L - 1 + n;
      if (this.br.length < tot) { this.br = new Float32Array(tot); this.bi = new Float32Array(tot); }
      const br = this.br, bi = this.bi;
      br.set(this.hr); bi.set(this.hi);
      br.set(re.subarray(0, n), L - 1); bi.set(im.subarray(0, n), L - 1);
      let k = 0, p = this.pos;
      for (; p + L <= tot; p += D) {
        let sr = 0, si = 0;
        for (let j = 0; j < L; j++) { const c = h[j]; sr += c * br[p + j]; si += c * bi[p + j]; }
        outRe[k] = sr; outIm[k++] = si;
      }
      this.pos = p - n;
      this.hr.set(br.subarray(n, tot)); this.hi.set(bi.subarray(n, tot));
      return k;
    }
  }

  class RDecim {
    constructor(taps, D) {
      this.h = taps; this.D = D; this.L = taps.length;
      this.hist = new Float32Array(this.L - 1);
      this.buf = new Float32Array(0);
      this.pos = 0;
    }

    process(x, n, out) {
      const L = this.L, D = this.D, h = this.h, tot = L - 1 + n;
      if (this.buf.length < tot) this.buf = new Float32Array(tot);
      const b = this.buf;
      b.set(this.hist); b.set(x.subarray(0, n), L - 1);
      let k = 0, p = this.pos;
      for (; p + L <= tot; p += D) {
        let s = 0;
        for (let j = 0; j < L; j++) s += h[j] * b[p + j];
        out[k++] = s;
      }
      this.pos = p - n;
      this.hist.set(b.subarray(n, tot));
      return k;
    }
  }

  // Catmull-Rom fractional resampler; ratio = input rate / output rate.
  class Resampler {
    constructor(ratio) {
      this.ratio = ratio;
      this.hist = new Float32Array(3);
      this.buf = new Float32Array(0);
      this.t = 1;
    }

    process(x, n, out) {
      const len = n + 3;
      if (this.buf.length < len) this.buf = new Float32Array(len);
      const c = this.buf;
      c.set(this.hist); c.set(x.subarray(0, n), 3);
      let k = 0, t = this.t;
      const r = this.ratio;
      while (t < len - 2) {
        const i = t | 0, f = t - i;
        const y0 = c[i - 1], y1 = c[i], y2 = c[i + 1], y3 = c[i + 2];
        const a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
        const b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
        const d = 0.5 * (y2 - y0);
        out[k++] = ((a * f + b) * f + d) * f + y1;
        t += r;
      }
      this.t = t - n;
      this.hist.set(c.subarray(n, n + 3));
      return k;
    }
  }

  // Numerically controlled oscillator mixing by exp(-j*2*pi*f/fs*n).
  class Mixer {
    constructor() { this.pr = 1; this.pi = 0; this.setFreq(0, 1); }
    setFreq(f, fs) {
      const w = -TAU * f / fs;
      this.cr = Math.cos(w); this.ci = Math.sin(w);
    }
    process(re, im, n, outRe, outIm) {
      let pr = this.pr, pi = this.pi;
      const cr = this.cr, ci = this.ci;
      for (let i = 0; i < n; i++) {
        const xr = re[i], xi = im[i];
        outRe[i] = xr * pr - xi * pi;
        outIm[i] = xr * pi + xi * pr;
        const t = pr * cr - pi * ci;
        pi = pr * ci + pi * cr;
        pr = t;
      }
      const g = 1 / Math.hypot(pr, pi);
      this.pr = pr * g; this.pi = pi * g;
    }
  }

  // Peak-tracking AGC for AM/SSB audio.
  class AGC {
    constructor(rate) {
      this.env = 1e-4;
      this.decay = Math.exp(-1 / (rate * 0.5));
      this.attack = 1 - Math.exp(-1 / (rate * 0.002));
    }
    process(x, n) {
      let env = this.env;
      const decay = this.decay, attack = this.attack;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(x[i]);
        env = a > env ? env + attack * (a - env) : env * decay;
        if (env < 1e-5) env = 1e-5;
        x[i] = x[i] * (0.25 / env);
      }
      this.env = env;
    }
  }

  // FM stereo pilot PLL. Tracks the 19 kHz pilot in the MPX signal and
  // reports whether a pilot is present.
  class PilotPLL {
    constructor(rate) {
      this.w0 = TAU * 19000 / rate;
      this.wMax = TAU * 50 / rate;
      const wn = TAU * 20, zeta = 0.707, kd = 0.5;
      this.kp = 2 * zeta * wn / (kd * rate);
      this.ki = wn * wn / (kd * rate * rate);
      this.lp = 1 - Math.exp(-1 / (rate * 0.05));
      this.theta = 0; this.dw = 0; this.i = 0; this.q = 0;
      this.locked = false;
    }
  }

  // Complete receive chain: IQ at fs -> interleaved stereo audio at audioRate.
  // mode: WFM | NFM | AM | USB | LSB | CW
  // CW: the carrier at the VFO is heard as a CW_PITCH tone.
  const CW_PITCH = 700;
  class Receiver {
    constructor(opts) {
      this.audioRate = opts.audioRate || 48000;
      this.mixer = new Mixer();
      this.configure(opts);
    }

    configure(o) {
      Object.assign(this, {
        fs: o.fs ?? this.fs,
        offset: o.offset ?? this.offset ?? 0,
        mode: o.mode ?? this.mode ?? 'WFM',
        bandwidth: o.bandwidth ?? this.bandwidth ?? 200e3,
        deemph: o.deemph ?? this.deemph ?? 50e-6,
        squelch: o.squelch ?? this.squelch ?? null,
        stereo: o.stereo ?? this.stereo ?? true,
      });
      const fs = this.fs, bw = this.bandwidth, mode = this.mode;
      const ssb = mode === 'USB' || mode === 'LSB', cw = mode === 'CW';

      // WFM keeps the whole MPX baseband (stereo subcarrier up to 53 kHz).
      // CW uses a low IF so its narrow filter stays short.
      const ifTarget = Math.min(fs, cw ? 12e3 : Math.max(1.25 * bw, mode === 'WFM' ? 150e3 : 50e3));
      const D1 = Math.max(1, Math.floor(fs / (4 * ifTarget)));
      const fs1 = fs / D1;
      const D2 = Math.max(1, Math.floor(fs1 / ifTarget));
      this.ifRate = fs1 / D2;

      // Stage 1 only has to keep aliases out of the final channel.
      this.stage1 = D1 > 1
        ? new CDecim(lowpass(fs, ifTarget / 2, Math.max(fs1 - ifTarget, ifTarget * 0.5), 'blackman'), D1)
        : null;
      const half = bw / 2;
      this.stage2 = new CDecim(lowpass(fs1, half, cw ? Math.max(bw * 0.3, 100) : Math.max(half * 0.2, 500), 'hamming'), D2);

      // SSB: centre the sideband before filtering, shift back after.
      this.ssbShift = mode === 'USB' ? bw / 2 : mode === 'LSB' ? -bw / 2 : 0;
      this.mixer.setFreq(this.offset + this.ssbShift, fs);
      this.bfo = new Mixer();
      this.bfo.setFreq(cw ? -CW_PITCH : -this.ssbShift, this.ifRate);

      const audioCut = Math.min(
        mode === 'WFM' ? 15e3 : mode === 'NFM' ? Math.min(bw / 2, 8e3) : ssb ? bw : cw ? CW_PITCH + bw / 2 + 300 : bw / 2,
        this.audioRate * 0.45);
      const Da = Math.max(1, Math.floor(this.ifRate / this.audioRate));
      // WFM: the filter must also reject the 19 kHz pilot.
      const audioTaps = lowpass(this.ifRate, audioCut, mode === 'WFM' ? 3000 : Math.max(audioCut * 0.25, 500), 'hamming');
      this.audioDecim = new RDecim(audioTaps, Da);
      this.diffDecim = new RDecim(audioTaps, Da);
      this.aRate = this.ifRate / Da;
      this.baseRatio = this.aRate / this.audioRate;
      this.resampler = new Resampler(this.baseRatio);
      this.resamplerR = new Resampler(this.baseRatio);
      this.pll = mode === 'WFM' ? new PilotPLL(this.ifRate) : null;
      this.blend = 0;

      this.fmGain = this.ifRate / (TAU * (mode === 'WFM' ? 75e3 : Math.max(bw / 2 - 1500, 2500)));
      // De-emphasis runs after decimation, separately on L and R.
      this.deAlpha = this.deemph > 0 && (mode === 'WFM' || mode === 'NFM')
        ? 1 - Math.exp(-1 / (this.aRate * this.deemph)) : 0;
      this.deL = this.deL || 0; this.deR = this.deR || 0;
      this.dcAlpha = 1 - Math.exp(-TAU * 30 / this.ifRate);
      this.dcState = 0;
      this.prevR = this.prevR || 0; this.prevI = this.prevI || 0;
      this.agc = new AGC(this.aRate);
      this.levelDb = -200;
    }

    setOffset(offset) {
      this.offset = offset;
      this.mixer.setFreq(offset + this.ssbShift, this.fs);
    }

    setRateCorrection(c) { this.resampler.ratio = this.resamplerR.ratio = this.baseRatio * (1 + c); }

    get stereoLocked() { return !!(this.pll && this.pll.locked && this.stereo); }

    ensure(n) {
      if (!this.wr || this.wr.length < n) {
        this.wr = new Float32Array(n); this.wi = new Float32Array(n);
        this.xr = new Float32Array(n); this.xi = new Float32Array(n);
        this.demod = new Float32Array(n); this.diff = new Float32Array(n);
        this.aud = new Float32Array(n); this.audR = new Float32Array(n);
        this.outL = new Float32Array(n * 2 + 1024); this.outR = new Float32Array(n * 2 + 1024);
      }
    }

    // iq: Float32 re/im arrays of length n. Returns Float32Array of audio.
    process(re, im, n) {
      this.ensure(n);
      this.mixer.process(re, im, n, this.wr, this.wi);
      let m = n, sr = this.wr, si = this.wi;
      if (this.stage1) { m = this.stage1.process(sr, si, m, this.xr, this.xi); sr = this.xr; si = this.xi; }
      const cr = this.wr, ci = this.wi; // reuse as stage-2 output
      m = this.stage2.process(sr, si, m, cr, ci);

      let pwr = 0;
      for (let i = 0; i < m; i++) pwr += cr[i] * cr[i] + ci[i] * ci[i];
      this.levelDb = 10 * Math.log10(pwr / Math.max(m, 1) + 1e-20);

      const d = this.demod, mode = this.mode;
      if (mode === 'WFM' || mode === 'NFM') {
        let pr = this.prevR, pi = this.prevI;
        const g = this.fmGain;
        for (let i = 0; i < m; i++) {
          const r = cr[i], q = ci[i];
          d[i] = Math.atan2(q * pr - r * pi, r * pr + q * pi) * g;
          pr = r; pi = q;
        }
        this.prevR = pr; this.prevI = pi;
        if (this.pll) this.pilot(d, m);
      } else if (mode === 'AM') {
        let dc = this.dcState;
        const a = this.dcAlpha;
        for (let i = 0; i < m; i++) {
          const e = Math.sqrt(cr[i] * cr[i] + ci[i] * ci[i]);
          dc += a * (e - dc);
          d[i] = e - dc;
        }
        this.dcState = dc;
      } else {
        this.bfo.process(cr, ci, m, this.xr, this.xi);
        for (let i = 0; i < m; i++) d[i] = this.xr[i];
      }

      const L = this.aud, R = this.audR;
      let k = this.audioDecim.process(d, m, L);
      if (this.pll) {
        // L = (L+R) + (L-R), R = (L+R) - (L-R); fade between mono and stereo.
        this.diffDecim.process(this.diff, m, R);
        const target = this.stereoLocked ? 1 : 0;
        let g = this.blend;
        const step = 1 / (this.aRate * 0.2);
        for (let i = 0; i < k; i++) {
          g += g < target ? Math.min(step, target - g) : -Math.min(step, g - target);
          const sum = L[i], dif = R[i] * g;
          L[i] = sum + dif; R[i] = sum - dif;
        }
        this.blend = g;
      } else {
        if (mode !== 'NFM' && mode !== 'WFM') this.agc.process(L, k);
        R.set(L.subarray(0, k));
      }
      if (this.deAlpha) {
        const a = this.deAlpha;
        let sl = this.deL, sr = this.deR;
        for (let i = 0; i < k; i++) { sl += a * (L[i] - sl); L[i] = sl; sr += a * (R[i] - sr); R[i] = sr; }
        this.deL = sl; this.deR = sr;
      }
      const nl = this.resampler.process(L, k, this.outL);
      const nr = this.resamplerR.process(R, k, this.outR);
      const nf = Math.min(nl, nr);
      const out = new Float32Array(nf * 2);
      if (!(this.squelch !== null && this.levelDb < this.squelch)) {
        const ol = this.outL, or = this.outR;
        for (let i = 0; i < nf; i++) { out[2 * i] = ol[i]; out[2 * i + 1] = or[i]; }
      }
      return out;
    }

    // Runs the pilot PLL over the MPX signal and fills this.diff with the
    // L-R channel demodulated by the regenerated 38 kHz subcarrier.
    pilot(d, m) {
      const p = this.pll, diff = this.diff;
      let th = p.theta, dw = p.dw, pi = p.i, pq = p.q;
      const w0 = p.w0, kp = p.kp, ki = p.ki, lp = p.lp, wMax = p.wMax;
      for (let i = 0; i < m; i++) {
        const x = d[i], c = Math.cos(th), s = Math.sin(th);
        // Locked: cos(th) follows the pilot sin(wt), so the subcarrier
        // sin(2wt) = -sin(2*th).
        diff[i] = -4 * x * s * c;
        pi += lp * (2 * x * c - pi);
        pq += lp * (-2 * x * s - pq);
        const amp = Math.max(Math.hypot(pi, pq), 0.005);
        const e = -x * s / amp;
        dw += ki * e;
        if (dw > wMax) dw = wMax; else if (dw < -wMax) dw = -wMax;
        th += w0 + dw + kp * e;
        if (th > TAU) th -= TAU;
      }
      p.theta = th; p.dw = dw; p.i = pi; p.q = pq;
      // Pilot is nominally 10% of full deviation; require it in phase.
      p.locked = p.locked ? pi > 0.025 && pi > 2 * Math.abs(pq) : pi > 0.04 && pi > 4 * Math.abs(pq);
    }
  }

  // Averaged power spectrum in dBFS, FFT-shifted (DC in the middle).
  class Spectrum {
    constructor(n, window) {
      this.n = n;
      this.fft = new FFT(n);
      this.win = makeWindow(window, n);
      let s = 0;
      for (let i = 0; i < n; i++) s += this.win[i];
      this.norm = 1 / (s * s);
      this.re = new Float32Array(n); this.im = new Float32Array(n);
      this.acc = new Float32Array(n);
      this.frames = 0;
    }

    // Adds one frame from interleaved Int16 IQ starting at sample index start.
    addFrame(iq, start) {
      const n = this.n, w = this.win, re = this.re, im = this.im;
      for (let i = 0, j = start * 2; i < n; i++, j += 2) {
        re[i] = iq[j] * w[i] / 2048;
        im[i] = iq[j + 1] * w[i] / 2048;
      }
      this.fft.transform(re, im);
      const acc = this.acc;
      for (let i = 0; i < n; i++) acc[i] += re[i] * re[i] + im[i] * im[i];
      this.frames++;
    }

    take() {
      const n = this.n, h = n >> 1, out = new Float32Array(n);
      const g = this.norm / Math.max(this.frames, 1);
      for (let i = 0; i < n; i++) {
        out[(i + h) % n] = 10 * Math.log10(this.acc[i] * g + 1e-20);
      }
      this.acc.fill(0);
      this.frames = 0;
      return out;
    }
  }

  const api = { FFT, makeWindow, lowpass, CDecim, RDecim, Resampler, Mixer, AGC, Receiver, Spectrum };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DSP = api;
})(typeof self !== 'undefined' ? self : globalThis);
