// CW decoder display, as cw_decoder4's web page (web/app.js: drawFFT / drawScope / drawStatus / renderText, GPL —
// see src/cwdec/README.md): status row, decoded text with the newest character highlighted, FFT spectrum and
// oscilloscope with the same controls (click the FFT to pick the tone, double-click / click the scope for full width,
// zoom, KEY / ENV / RAW). Taken from the FTX-1 Controller (js/cwview.js); drawn while visible() is true.

const PlutoCwView = (function () {
  'use strict';
  const { ST, codepointOf } = PlutoDecoders;

  const HZ_PER_BIN = 8000 / 256;
  // the device's palette (display.cpp lgfx::color565 values)
  const C = {
    panelBg: '#020810', frame: '#283c55', label: '#647d9b',
    eqFill: '#08412f', eqLine: '#3ce6a0', eqPeak: '#d2d7e1',
    marker: '#324b82', band: '#0a182a', toneBand: '#463410',
    raw: '#0082af', env: '#fac775', gate: '#5adc78',
    lvlLo: '#2dc878', lvlMid: '#e6b43c', lvlHi: '#eb463c',
  };
  const EQ_BIN_START = 10, EQ_BAR_COUNT = 29; // bin 10 (312.5 Hz) .. bin 38 (1187.5 Hz)
  const EQ_F_MIN = EQ_BIN_START * HZ_PER_BIN;
  const EQ_F_MAX = (EQ_BIN_START + EQ_BAR_COUNT - 1) * HZ_PER_BIN;
  const hzToX = (hz, x0, plotW) => x0 + ((hz - EQ_F_MIN) / (EQ_F_MAX - EQ_F_MIN)) * plotW;
  const xToHz = (x, x0, plotW) => EQ_F_MIN + ((x - x0) / plotW) * (EQ_F_MAX - EQ_F_MIN);

  // monotone cubic (Fritsch-Carlson) between the 29 FFT points: smooth, with no peaks or dips that are not in the data
  function smoothCurve(ys, outN) {
    const n = ys.length;
    if (n < 3) return Float64Array.from(ys);
    const d = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) d[i] = ys[i + 1] - ys[i];
    const m = new Float64Array(n);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], ss = a * a + b * b;
      if (ss > 9) { const t = 3 / Math.sqrt(ss); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    const out = new Float64Array(outN);
    for (let k = 0; k < outN; k++) {
      const u = (k / (outN - 1)) * (n - 1), i = Math.min(n - 2, Math.floor(u));
      const t = u - i, t2 = t * t, t3 = t2 * t;
      out[k] = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * m[i + 1];
    }
    return out;
  }

  function fitCanvas(cv) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(160, Math.round(cv.clientWidth)), h = Math.round(cv.clientHeight || 130);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  class CwView {
    // el: { text, fft, scope, fftCard, scopeCard, fftCap, scopeCap, scopeSpan, zoom, zoomV, bKey, bEnv, bRaw,
    //       mode, tone, wpm, toneHz, peakHz, lvlBar, lvlTx, clip, inRate, copy, clear }
    constructor(dec, el, visible) {
      this.dec = dec; this.el = el;
      this.dispMax = 8000; this.bar = new Float32Array(EQ_BAR_COUNT);
      this.peakPx = new Float32Array(EQ_BAR_COUNT); this.peakTtl = new Uint8Array(EQ_BAR_COUNT);
      this.showKey = true; this.showEnv = true; this.showRaw = true;
      this.rawMax = 100; this.envMax = 500; this.zoom = 2;
      this.peakHold = 0; this.peakMs = 0;
      this.expanded = null; // null | 'fft' | 'scope'
      this.tHead = document.createElement('span');
      this.tNew = document.createElement('span'); this.tNew.className = 'new';
      el.text.append(this.tHead, this.tNew);
      dec.addEventListener('text', () => this.renderText());
      this._wire();
      const loop = () => { if (visible()) this.draw(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }

    renderText() {
      const t = this.el.text, chars = this.dec.chars;
      const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
      this.tHead.textContent = chars.length ? String.fromCodePoint(...chars.slice(0, -1)) : '';
      this.tNew.textContent = chars.length ? String.fromCodePoint(chars[chars.length - 1]) : '';
      if (atBottom) t.scrollTop = t.scrollHeight;
    }

    draw() {
      this.drawStatus();
      if (this.expanded !== 'scope') this.drawFFT();
      if (this.expanded !== 'fft') this.drawScope();
    }

    drawFFT() {
      const { g, w, h } = fitCanvas(this.el.fft);
      const st = this.dec.status || [], spec = this.dec.spec;
      const x0 = 10, plotW = w - 20, top = 12, baseY = h - 26, plotH = baseY - top;
      g.fillStyle = C.panelBg; g.fillRect(0, 0, w, h);
      g.strokeStyle = C.frame; g.lineWidth = 1; g.strokeRect(0.5, 0.5, w - 1, h - 1);
      // TONE selection range (600-1000 Hz)
      const xLo = hzToX(600, x0, plotW), xHi = hzToX(1000, x0, plotW);
      g.fillStyle = C.band; g.fillRect(xLo, top - 4, xHi - xLo, plotH + 8);
      g.strokeStyle = C.marker;
      g.beginPath(); g.moveTo(xLo, top - 4); g.lineTo(xLo, baseY + 4); g.moveTo(xHi, top - 4); g.lineTo(xHi, baseY + 4); g.stroke();
      // detection band of the selected tone (one Goertzel bin, follows WPM)
      const toneHz = st[ST.toneHz] || 600, halfBw = (st[ST.gateBw] || 67) / 2;
      const xc = hzToX(toneHz, x0, plotW), xbl = hzToX(toneHz - halfBw, x0, plotW), xbr = hzToX(toneHz + halfBw, x0, plotW);
      g.fillStyle = C.toneBand; g.fillRect(xbl, top - 4, xbr - xbl, plotH + 8);
      g.strokeStyle = C.env;
      g.beginPath(); g.moveTo(xbl, top - 4); g.lineTo(xbl, baseY + 4); g.moveTo(xbr, top - 4); g.lineTo(xbr, baseY + 4); g.stroke();
      // AGC: follows the frame maximum slowly
      let fmax = 0;
      for (let b = 0; b < EQ_BAR_COUNT; b++) fmax = Math.max(fmax, spec[EQ_BIN_START + b] || 0);
      this.dispMax += (fmax * 1.15 - this.dispMax) * 0.05;
      if (this.dispMax < 8000) this.dispMax = 8000;
      const { bar, peakPx, peakTtl } = this, yPt = new Float32Array(EQ_BAR_COUNT);
      for (let b = 0; b < EQ_BAR_COUNT; b++) {
        let t = ((spec[EQ_BIN_START + b] || 0) / this.dispMax) * plotH;
        if (t > plotH) t = plotH;
        bar[b] += (t - bar[b]) * (t >= bar[b] ? 0.7 : 0.35);
        yPt[b] = baseY - bar[b];
        if (bar[b] >= peakPx[b]) { peakPx[b] = bar[b]; peakTtl[b] = 25; } else if (peakTtl[b] > 0) peakTtl[b]--; else if (peakPx[b] > 0) peakPx[b] -= plotH / 42;
      }
      const bx = (b) => x0 + (b / (EQ_BAR_COUNT - 1)) * plotW;
      const curve = smoothCurve(yPt, Math.max(EQ_BAR_COUNT, Math.round(plotW / 2) + 1));
      const cx = (i) => x0 + (i / (curve.length - 1)) * plotW;
      g.fillStyle = C.eqFill;
      g.beginPath(); g.moveTo(cx(0), baseY);
      for (let i = 0; i < curve.length; i++) g.lineTo(cx(i), curve[i]);
      g.lineTo(cx(curve.length - 1), baseY); g.closePath(); g.fill();
      g.strokeStyle = C.eqLine; g.lineWidth = 1.5;
      g.beginPath();
      for (let i = 0; i < curve.length; i++) (i ? g.lineTo : g.moveTo).call(g, cx(i), curve[i]);
      g.stroke();
      g.strokeStyle = C.eqPeak; g.lineWidth = 1;
      g.beginPath();
      for (let b = 0; b < EQ_BAR_COUNT; b++) {
        if (peakPx[b] <= 1) continue;
        const y = Math.round(baseY - peakPx[b]) + 0.5;
        g.moveTo(bx(b) - 3, y); g.lineTo(bx(b) + 3, y);
      }
      g.stroke();
      // centre marker of the selected tone
      g.fillStyle = C.env;
      g.beginPath(); g.moveTo(xc, baseY + 3); g.lineTo(xc - 4, baseY + 10); g.lineTo(xc + 4, baseY + 10); g.closePath(); g.fill();
      g.fillStyle = C.label; g.font = '10px ui-monospace, monospace'; g.textAlign = 'center';
      for (const f of [400, 600, 800, 1000, 1200]) {
        if (f < EQ_F_MIN || f > EQ_F_MAX) continue;
        g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), hzToX(f, x0, plotW), h - 8);
      }
      g.textAlign = 'left';
    }

    drawScope() {
      const { g, w, h } = fitCanvas(this.el.scope);
      const d = this.dec, st = d.status || [], SRN = d.sMn.length, sTotal = d.sTotal;
      g.fillStyle = C.panelBg; g.fillRect(0, 0, w, h);
      g.strokeStyle = C.frame; g.lineWidth = 1; g.strokeRect(0.5, 0.5, w - 1, h - 1);
      // zoom 1 = one column per pixel (as the device); wider columns show short elements better
      const x0 = 4, zoom = this.zoom;
      const cols = Math.max(16, Math.floor((w - 8) / zoom)), start = Math.max(0, sTotal - cols);
      const colL = (i) => Math.round(x0 + (i - start) * zoom);
      const colW = (i) => Math.max(1, colL(i + 1) - colL(i));
      const colC = (i) => colL(i) + colW(i) / 2;
      const textH = 22, keyY = textH + 4, waveTop = keyY + 10, waveBot = h - 8;
      const midY = (waveTop + waveBot) / 2, halfH = (waveBot - waveTop) / 2;
      let rmax = 0, emax = 0;
      for (let i = start; i < sTotal; i++) { const k = i % SRN; rmax = Math.max(rmax, Math.abs(d.sMx[k]), Math.abs(d.sMn[k])); emax = Math.max(emax, d.sMag[k]); }
      this.rawMax += (rmax * 1.1 - this.rawMax) * 0.1; if (this.rawMax < 60) this.rawMax = 60;
      this.envMax += (emax * 1.1 - this.envMax) * 0.1; if (this.envMax < 400) this.envMax = 400;
      if (this.showRaw) {
        g.strokeStyle = '#142837';
        g.beginPath(); g.moveTo(x0, midY + 0.5); g.lineTo(x0 + cols * zoom, midY + 0.5); g.stroke();
        g.fillStyle = C.raw;
        for (let i = start; i < sTotal; i++) {
          const k = i % SRN;
          let y1 = midY - (d.sMx[k] / this.rawMax) * halfH, y2 = midY - (d.sMn[k] / this.rawMax) * halfH;
          y1 = Math.max(waveTop, y1); y2 = Math.min(waveBot, y2);
          if (y2 < y1) [y1, y2] = [y2, y1];
          g.fillRect(colL(i), y1, colW(i), y2 - y1 + 1);
        }
      }
      if (this.showEnv) {
        g.strokeStyle = C.env; g.lineWidth = 1.2;
        g.beginPath();
        let started = false;
        for (let i = start; i < sTotal; i++) {
          const k = i % SRN, x = colC(i);
          const y = waveBot - Math.min(waveBot - waveTop, (d.sMag[k] / this.envMax) * (waveBot - waveTop));
          if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
        }
        g.stroke();
      }
      if (this.showKey) {
        g.fillStyle = C.gate;
        for (let i = start; i < sTotal; i++) if (d.sGate[i % SRN]) g.fillRect(colL(i), keyY, colW(i), 4);
        // decoded characters at the middle of their elements, sweeping left with the trace
        g.fillStyle = '#adff2f';
        g.font = '15px "Hiragino Sans", "Noto Sans JP", sans-serif';
        g.textAlign = 'center';
        for (const t of d.ticker) {
          if (t.col < start || t.col >= sTotal) continue;
          g.fillText(String.fromCodePoint(codepointOf(t.ch)), colC(t.col), textH - 4);
        }
        g.textAlign = 'left';
      }
      const ms = (st[ST.colMsX10] || 0) / 10;
      this.el.scopeSpan.textContent = ms > 0 ? `${((cols * ms) / 1000).toFixed(1)}s / ${ms.toFixed(1)}ms/col` : '';
    }

    drawStatus() {
      const st = this.dec.status, el = this.el;
      if (!st) return;
      el.wpm.textContent = st[ST.wpm] || '--';
      el.toneHz.textContent = st[ST.toneHz] || '---';
      // Peak drops to 0 between elements: hold the last value for a second, as the device does
      const now = performance.now();
      if (st[ST.peakHz]) { this.peakHold = st[ST.peakHz]; this.peakMs = now; }
      el.peakHz.textContent = this.peakHold && now - this.peakMs < 1000 ? `${this.peakHold}Hz` : '----';
      el.mode.textContent = st[ST.mode] ? 'JP' : 'US';
      el.mode.classList.toggle('jp', !!st[ST.mode]);
      el.tone.textContent = st[ST.toneAuto] ? 'AUTO' : `${st[ST.toneHz]}Hz`;
      el.tone.style.color = st[ST.toneAuto] ? C.gate : '';
      // input level, dBFS (0 dBFS = full scale)
      const pk = st[ST.inputPeak], db = pk > 0 ? 20 * Math.log10(pk / 2048) : -60, shown = Math.max(-50, Math.min(0, db));
      el.lvlBar.style.width = `${((shown + 50) / 50) * 100}%`;
      el.lvlBar.style.background = db >= -2.5 ? C.lvlHi : db >= -5.2 ? C.lvlMid : C.lvlLo;
      el.lvlTx.textContent = pk > 0 ? `${db.toFixed(1)} dBFS` : '-inf dBFS';
      el.clip.style.visibility = this.dec.clipMs && now - this.dec.clipMs < 500 ? 'visible' : 'hidden';
      // input rate; red when input is being dropped (WPM and element lengths would be off)
      if (now - this.dec.inRateMs > 1500) el.inRate.textContent = '';
      else if (this.dec.inRate > 0) {
        const off = (this.dec.inRate / 8000 - 1) * 100;
        el.inRate.textContent = `${this.dec.inRate.toFixed(0)} sps`;
        el.inRate.style.color = Math.abs(off) > 0.5 ? '#ff9a8f' : '';
        el.inRate.title = `実効入力レート (正常 8000 sps、ずれ ${off.toFixed(2)}%)`;
      }
    }

    setExpanded(which) {
      this.expanded = this.expanded === which ? null : which;
      const { fftCard, scopeCard } = this.el;
      fftCard.classList.toggle('wide', this.expanded === 'fft');
      fftCard.classList.toggle('hidden', this.expanded === 'scope');
      scopeCard.classList.toggle('wide', this.expanded === 'scope');
      scopeCard.classList.toggle('hidden', this.expanded === 'fft');
    }

    _wire() {
      const { el, dec } = this;
      el.mode.addEventListener('click', () => dec.toggleMode());
      el.tone.addEventListener('click', () => dec.cycleTone());
      for (const [cap, which] of [[el.fftCap, 'fft'], [el.scopeCap, 'scope']]) {
        cap.addEventListener('click', (e) => { if (!e.target.closest('button, input, select, label')) this.setExpanded(which); });
      }
      el.scope.addEventListener('click', () => this.setExpanded('scope'));
      // FFT click picks the tone (as a tap on the device's FFT panel); full width is the double-click, so the pick
      // waits 250 ms and is cancelled by one
      let timer = null;
      el.fft.addEventListener('click', (e) => {
        if (timer) return;
        const r = el.fft.getBoundingClientRect(), x = e.clientX - r.left, w = r.width;
        timer = setTimeout(() => { timer = null; dec.setToneHz(xToHz(x, 10, w - 20)); }, 250);
      });
      el.fft.addEventListener('dblclick', () => { clearTimeout(timer); timer = null; this.setExpanded('fft'); });
      el.zoom.value = this.zoom;
      el.zoom.addEventListener('input', () => { this.zoom = +el.zoom.value; el.zoomV.textContent = this.zoom.toFixed(1); });
      const trace = (btn, key) => btn.addEventListener('click', () => { this[key] = !this[key]; btn.classList.toggle('on', this[key]); });
      trace(el.bKey, 'showKey'); trace(el.bEnv, 'showEnv'); trace(el.bRaw, 'showRaw');
      el.copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(dec.text);
        el.copy.textContent = 'コピーしました';
        setTimeout(() => { el.copy.textContent = 'コピー'; }, 1200);
      });
      el.clear.addEventListener('click', () => dec.clear());
    }
  }

  return CwView;
})();
