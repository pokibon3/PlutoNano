// Pluto Nano SDR — UI, stream control, rendering and wideband scan.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MIN_F = 70e6, MAX_F = 6e9;
  const SCAN_FS = 20e6, SCAN_BLOCK = 16384, SCAN_FFT = 1024, SCAN_USE = 0.8;

  const MODE_DEFAULTS = {
    WFM: { bandwidth: 200e3, snap: 100000, deemph: 50 },
    NFM: { bandwidth: 12.5e3, snap: 12500, deemph: 0 },
    AM: { bandwidth: 10e3, snap: 1000, deemph: 0 },
    USB: { bandwidth: 2.8e3, snap: 100, deemph: 0 },
    LSB: { bandwidth: 2.8e3, snap: 100, deemph: 0 },
  };
  const BW_LIMITS = { WFM: [50e3, 250e3], NFM: [3e3, 50e3], AM: [1e3, 30e3], USB: [500, 6e3], LSB: [500, 6e3] };
  const SAMPLE_RATES = [1.024e6, 1.536e6, 2.048e6, 2.4e6, 3.072e6, 4e6, 5e6, 6e6, 7.68e6];
  const RF_BWS = [0, 0.2e6, 0.5e6, 1e6, 2e6, 4e6, 6e6, 10e6, 20e6, 56e6];

  // Band buttons: default frequency, mode and the range used for the
  // wideband scan and for remembering the last frequency in the band.
  const BANDS = [
    { name: 'FM', f: 80.0e6, mode: 'WFM', lo: 76e6, hi: 95e6, title: 'FM 放送 76–95 MHz' },
    { name: 'AIR', f: 118.1e6, mode: 'AM', lo: 118e6, hi: 137e6, title: 'エアバンド 118–137 MHz' },
    // Japanese amateur bands: NFM, 20 kHz channel step.
    { name: '144', f: 145.0e6, mode: 'NFM', snap: 20e3, lo: 144e6, hi: 146e6, title: '144 MHz アマチュアバンド 144–146 MHz' },
    { name: '430', f: 433.0e6, mode: 'NFM', snap: 20e3, lo: 430e6, hi: 440e6, title: '430 MHz アマチュアバンド 430–440 MHz' },
    { name: '1200', f: 1295.0e6, mode: 'NFM', snap: 20e3, lo: 1260e6, hi: 1300e6, title: '1200 MHz アマチュアバンド 1260–1300 MHz' },
    { name: '2400', f: 2427.0e6, mode: 'NFM', snap: 20e3, lo: 2400e6, hi: 2450e6, title: '2400 MHz アマチュアバンド 2400–2450 MHz' },
    { name: '5600', f: 5760.0e6, mode: 'NFM', snap: 20e3, lo: 5650e6, hi: 5850e6, title: '5600 MHz アマチュアバンド 5650–5850 MHz' },
    // Wi-Fi bands: there is nothing to listen to, so these start a
    // wideband scan of the band and label the channels (Japan).
    { name: '2.4G', f: 2437e6, mode: 'NFM', lo: 2400e6, hi: 2500e6, wifi: true, title: '2.4 GHz Wi-Fi（ch1–14）をスキャン' },
    { name: '5G', f: 5500e6, mode: 'NFM', lo: 5150e6, hi: 5730e6, wifi: true, title: '5 GHz Wi-Fi（W52 / W53 / W56）をスキャン' },
  ];

  // Japanese Wi-Fi channels: [number, centre Hz, width Hz].
  const WIFI_CHANNELS = [
    ...Array.from({ length: 13 }, (_, i) => [i + 1, (2412 + 5 * i) * 1e6, 20e6]),
    [14, 2484e6, 22e6],
    ...[36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144]
      .map((n) => [n, (5000 + 5 * n) * 1e6, 20e6]),
  ];

  const DEFAULTS = {
    lo: 80e6, vfo: 80e6, sampleRate: 2.4e6, rfBw: 0, gainMode: 'slow_attack', gain: 50,
    mode: 'WFM', perMode: JSON.parse(JSON.stringify(MODE_DEFAULTS)),
    ppm: 0, squelchOn: false, squelch: -60, volume: 0.6, stereo: true,
    fftSize: 8192, fps: 30, window: 'bh', smoothing: 0.8, colormap: 'classic',
    dbMin: -120, dbMax: -30, zoom: 0, specFrac: 0.32,
    scanStart: 76, scanStop: 95, scanGain: 50, menu: true, introSeen: false,
    band: null, bandMem: {},
  };

  // ---------------- settings ----------------
  const S = (() => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('plutonano.settings') || '{}'); } catch (e) { /* ignore */ }
    const s = Object.assign({}, DEFAULTS, saved);
    s.perMode = Object.assign({}, JSON.parse(JSON.stringify(MODE_DEFAULTS)), saved.perMode || {});
    if (!MODE_DEFAULTS[s.mode]) s.mode = 'WFM';
    return s;
  })();
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem('plutonano.settings', JSON.stringify(S)); } catch (e) { /* ignore */ }
    }, 300);
  }
  const mode = () => S.perMode[S.mode];

  // ---------------- helpers ----------------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function fmtHz(f, digits) {
    const a = Math.abs(f);
    if (a >= 1e9) return (f / 1e9).toFixed(digits ?? 6) + ' GHz';
    if (a >= 1e6) return (f / 1e6).toFixed(digits ?? 4) + ' MHz';
    if (a >= 1e3) return (f / 1e3).toFixed(digits ?? 2) + ' kHz';
    return f.toFixed(0) + ' Hz';
  }
  function fmtRate(r) { return (r / 1e6).toFixed(r % 1e5 ? 3 : 1).replace(/\.?0+$/, '') + ' MSPS'; }
  let toastTimer = 0;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = kind || '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'info' ? 3000 : 7000);
  }
  function blobUrl(id) {
    return URL.createObjectURL(new Blob([$(id).textContent], { type: 'text/javascript' }));
  }

  // ---------------- worker ----------------
  const worker = new Worker(blobUrl('worker-src'));
  let lastFFT = null;
  let levelDb = -200;
  let stereoLocked = false;
  const sweepWaiters = new Map();
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'fft') {
      if (state !== 'live') return;
      lastFFT = m;
      wfPush(m.db, m.f0, m.binHz);
      dirty = true;
    } else if (m.type === 'level') {
      levelDb = m.db;
      stereoLocked = !!m.stereo;
      updateMeter();
    } else if (m.type === 'sweep') {
      const w = sweepWaiters.get(m.id);
      if (w) { sweepWaiters.delete(m.id); w(m.db); }
    }
  };
  function workerConfig() {
    worker.postMessage({
      type: 'config',
      cfg: {
        fs: S.sampleRate, lo: S.lo, vfo: S.vfo, mode: S.mode, bandwidth: mode().bandwidth,
        deemph: mode().deemph * 1e-6, stereo: S.stereo, squelch: S.squelchOn ? S.squelch : null,
        fftSize: S.fftSize, fps: S.fps, window: S.window, smoothing: S.smoothing,
        audioRate: audio ? audio.ctx.sampleRate : 48000, audio: !!audio && state === 'live',
      },
    });
  }

  // ---------------- audio ----------------
  let audio = null;
  // Before the first user gesture Chrome keeps the context suspended and
  // resume() never settles, so it is not awaited; audio starts on the
  // first click or key press.
  function resumeAudio() {
    if (!audio || audio.ctx.state === 'running') return;
    audio.ctx.resume().catch(() => {});
    if (!navigator.userActivation || !navigator.userActivation.hasBeenActive) {
      toast('クリックまたはキー操作で音声を開始します', 'info');
    }
  }
  for (const ev of ['pointerdown', 'keydown']) {
    window.addEventListener(ev, () => { if (audio && audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {}); }, true);
  }

  async function ensureAudio() {
    if (audio) { resumeAudio(); return; }
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    const gain = ctx.createGain();
    gain.gain.value = S.volume ** 2;
    gain.connect(ctx.destination);
    const ch = new MessageChannel();
    let node = null;
    // file:// pages cannot load worklets from blob: URLs, but data: URLs work.
    const code = $('worklet-src').textContent;
    for (const url of ['data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(code))), blobUrl('worklet-src')]) {
      try { await ctx.audioWorklet.addModule(url); node = new AudioWorkletNode(ctx, 'pluto-player', { numberOfInputs: 0, outputChannelCount: [2] }); break; } catch (e) { /* try next */ }
    }
    if (node) {
      node.port.postMessage({ port: ch.port1 }, [ch.port1]);
    } else {
      node = scriptProcessorPlayer(ctx, ch.port1);
    }
    node.connect(gain);
    worker.postMessage({ type: 'audioPort', port: ch.port2 }, [ch.port2]);
    audio = { ctx, node, gain };
    // Drop what piled up while suspended so playback starts without lag.
    ctx.addEventListener('statechange', () => { if (ctx.state === 'running') node.port.postMessage({ reset: true }); });
    resumeAudio();
  }

  // Fallback player on the main thread for browsers without usable worklets.
  function scriptProcessorPlayer(ctx, port) {
    const cap = ctx.sampleRate * 2, buf = new Float32Array(cap * 2), target = Math.round(ctx.sampleRate * 0.2);
    let r = 0, w = 0, fill = 0, primed = false, tick = 0;
    port.onmessage = (e) => {
      const a = e.data, n = a.length >> 1;
      for (let i = 0; i < n; i++) {
        if (fill >= cap) { r = (r + 1) % cap; fill--; }
        buf[2 * w] = a[2 * i]; buf[2 * w + 1] = a[2 * i + 1]; w = (w + 1) % cap; fill++;
      }
    };
    const node = ctx.createScriptProcessor(4096, 0, 2);
    node.onaudioprocess = (e) => {
      const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1), n = L.length;
      if (!primed && fill >= target) primed = true;
      if (primed && fill >= n) {
        for (let i = 0; i < n; i++) { L[i] = buf[2 * r]; R[i] = buf[2 * r + 1]; r = (r + 1) % cap; }
        fill -= n;
      } else { primed = false; L.fill(0); R.fill(0); }
      if (++tick % 4 === 0) port.postMessage({ fill, target });
    };
    node.port = { postMessage(m) { if (m && m.reset) { r = w = fill = 0; primed = false; } } };
    return node;
  }

  // ---------------- device ----------------
  let pluto = null;
  let state = 'idle'; // idle | live | sweep
  let curLo = S.lo;
  // After a retune the kernel still holds buffers captured at the old LO,
  // so each block is tagged with the LO that was in effect when it was read.
  const LIVE_KERNEL_BUFFERS = 4;
  const STALE_READS = LIVE_KERNEL_BUFFERS - 1;
  let rxReads = 0;
  let loTags = [];
  function loForRead(n) {
    while (loTags.length > 1 && loTags[1].at <= n) loTags.shift();
    return loTags.length ? loTags[0].lo : curLo;
  }
  let streamToken = 0;
  let rssiTimer = 0;

  function setStatus() {
    updateBands();
    const parts = [];
    if (!pluto) parts.push('Not connected');
    else {
      parts.push('PlutoSDR');
      if (state === 'live') parts.push(fmtRate(S.sampleRate), 'LO ' + fmtHz(curLo, 3));
      else if (state === 'sweep') parts.push('Scanning');
      else parts.push('Stopped');
    }
    $('statusText').textContent = parts.join(' · ');
    $('btnConnect').textContent = pluto ? 'Disconnect' : 'Connect';
    $('btnConnect').classList.toggle('primary', !pluto);
    $('btnPlay').disabled = !pluto;
    $('btnPlay').classList.toggle('on', state === 'live');
    $('btnPlay').innerHTML = state === 'live' ? '&#9632;' : '&#9654;';
    $('btnScan').disabled = !pluto;
    $('btnScan').textContent = state === 'sweep' ? 'Stop scan' : 'Start scan';
    $('btnScan').classList.toggle('active', state === 'sweep');
    $('loVal').textContent = pluto ? fmtHz(curLo, 6) : '—';
  }

  async function connect(interactive) {
    if (!navigator.usb) {
      toast('このブラウザは WebUSB に対応していません。Chrome または Edge で開いてください。');
      return;
    }
    try {
      let p = await window.Pluto.getPaired();
      if (!p) {
        if (!interactive) return;
        p = await window.Pluto.request();
      }
      await p.open();
      pluto = p;
      const serial = p.usb.serialNumber ? ' (' + p.usb.serialNumber.slice(-8) + ')' : '';
      $('devName').textContent = (p.usb.productName || 'PlutoSDR') + serial;
      const lo = await p.getRange(window.Pluto.RX_LO, 'frequency_available').catch(() => null);
      if (lo && lo.min > 300e6) {
        toast(`周波数範囲が ${fmtHz(lo.min, 0)}〜${fmtHz(lo.max, 1)} に制限されています（AD9363 モード）。`, 'info');
      }
      await applySource();
      setStatus();
      toast('Pluto に接続しました', 'info');
      await startLive();
    } catch (e) {
      pluto = null;
      setStatus();
      if (e && e.name === 'NotFoundError') return; // chooser cancelled
      let msg = 'Pluto に接続できません: ' + (e && e.message ? e.message : e);
      if (e && e.name === 'SecurityError') msg += '（このページの読み込み方法では WebUSB が使えません）';
      if (/claim|busy|Unable/i.test(msg)) msg += ' — 他のアプリ（iio_info など）が Pluto を使っていないか確認してください。';
      toast(msg);
    }
  }

  async function disconnect() {
    const p = pluto;
    if (!p) return;
    await stopStream();
    pluto = null;
    clearInterval(rssiTimer);
    await p.close();
    $('devName').textContent = '—';
    $('rssiVal').textContent = '—';
    setStatus();
  }

  function onDeviceLost(msg) {
    streamToken++;
    state = 'idle';
    pluto = null;
    clearInterval(rssiTimer);
    $('devName').textContent = '—';
    setStatus();
    workerConfig();
    toast(msg || 'Pluto との接続が切れました');
  }

  if (navigator.usb) {
    navigator.usb.addEventListener('disconnect', (e) => {
      if (pluto && e.device === pluto.usb) onDeviceLost();
    });
  }

  function rfBandwidth() { return S.rfBw || clamp(Math.round(S.sampleRate), 200e3, 56e6); }

  async function applySource() {
    if (!pluto) return;
    await applyPpm();
    await pluto.setSampleRate(S.sampleRate);
    await pluto.setBandwidth(rfBandwidth());
    await pluto.setGainMode(S.gainMode);
    if (S.gainMode === 'manual') await pluto.setGain(S.gain);
    await pluto.setFrequency(S.lo);
    curLo = S.lo;
  }

  // Crystal correction: +ppm means the reference runs fast, so signals
  // appear lower than their true frequency.
  const XO_NOMINAL = 40e6;
  async function applyPpm() {
    if (!pluto) return;
    try {
      await pluto.setXoCorrection(XO_NOMINAL * (1 + S.ppm * 1e-6));
    } catch (e) {
      toast('周波数補正を設定できません: ' + e.message);
    }
  }

  function blockSize(fs) {
    return clamp(2 ** Math.floor(Math.log2(fs / 25)), 16384, 262144);
  }

  async function startLive() {
    if (!pluto || state === 'live') return;
    await ensureAudio();
    audio.node.port.postMessage({ reset: true });
    const token = ++streamToken;
    state = 'live';
    lastFFT = null;
    try {
      await pluto.setKernelBuffers(LIVE_KERNEL_BUFFERS);
      await applySource();
      await pluto.startRx(blockSize(S.sampleRate));
      rxReads = 0;
      loTags = [{ lo: curLo, at: 0 }];
    } catch (e) {
      state = 'idle';
      setStatus();
      toast('受信を開始できません: ' + e.message);
      return;
    }
    workerConfig();
    setStatus();
    startRssi();
    (async () => {
      while (token === streamToken) {
        try {
          const iq = await pluto.readRx();
          if (token !== streamToken) break;
          const lo = loForRead(rxReads++);
          worker.postMessage({ type: 'iq', data: iq, lo }, [iq.buffer]);
        } catch (e) {
          if (token === streamToken) onDeviceLost('受信エラー: ' + e.message);
          break;
        }
      }
    })();
  }

  async function stopStream() {
    if (state === 'idle') return;
    streamToken++;
    sweep = null;
    state = 'idle';
    clearInterval(rssiTimer);
    workerConfig();
    setStatus();
    if (pluto) {
      try { await pluto.stopRx(); } catch (e) { /* ignore */ }
    }
    dirty = true;
  }

  async function restartIfLive() {
    if (state !== 'live') { if (pluto && state === 'idle') applySource().catch(() => {}); return; }
    await stopStream();
    await startLive();
  }

  function startRssi() {
    clearInterval(rssiTimer);
    rssiTimer = setInterval(async () => {
      if (!pluto || state !== 'live') return;
      try {
        const r = await pluto.getRssi();
        const g = await pluto.getGain();
        $('rssiVal').textContent = `${r.toFixed(1)} dB · gain ${g.toFixed(0)} dB`;
        if (S.gainMode !== 'manual') $('gainVal').textContent = g.toFixed(0) + ' dB';
      } catch (e) { /* transient */ }
    }, 1000);
  }

  // Coalesces LO writes so dragging never queues a backlog.
  let loWanted = null, loBusy = false;
  async function setLo(f) {
    S.lo = clamp(Math.round(f), MIN_F, MAX_F);
    if (!pluto || state === 'sweep') { curLo = S.lo; workerConfig(); setStatus(); return; }
    loWanted = S.lo;
    if (loBusy) return;
    loBusy = true;
    while (loWanted !== null) {
      const t = loWanted;
      loWanted = null;
      try {
        await pluto.setFrequency(t);
        curLo = t;
        loTags.push({ lo: t, at: rxReads + STALE_READS });
      } catch (e) { toast('周波数を設定できません: ' + e.message); }
    }
    loBusy = false;
    workerConfig();
    setStatus();
  }

  // ---------------- tuning ----------------
  function vfoEdges(f = S.vfo) {
    const bw = mode().bandwidth;
    if (S.mode === 'USB') return [f, f + bw];
    if (S.mode === 'LSB') return [f - bw, f];
    return [f - bw / 2, f + bw / 2];
  }

  // ---------------- bands ----------------
  function buildBands() {
    const el = $('bands');
    for (const b of BANDS) {
      const btn = document.createElement('button');
      btn.textContent = b.name;
      btn.title = b.title;
      btn.dataset.band = b.name;
      btn.addEventListener('click', () => selectBand(b));
      el.appendChild(btn);
    }
  }

  // The band containing the VFO (or the scan range while scanning),
  // preferring the one last selected.
  function activeBand() {
    const sweeping = state === 'sweep' && !!sweep;
    const f = sweeping ? (sweep.start + sweep.stop) / 2 : S.vfo;
    const ok = (b) => b && f >= b.lo && f <= b.hi && !!b.wifi === sweeping;
    const cur = BANDS.find((b) => b.name === S.band);
    return ok(cur) ? cur : BANDS.find(ok) || null;
  }

  function updateBands() {
    const active = activeBand()?.name;
    for (const btn of $('bands').children) btn.classList.toggle('active', btn.dataset.band === active);
  }

  function selectBand(b) {
    // Remember where we were in the band we are leaving.
    const cur = BANDS.find((x) => x.name === S.band);
    if (cur && S.vfo >= cur.lo && S.vfo <= cur.hi) S.bandMem[cur.name] = { f: S.vfo, mode: S.mode };
    S.band = b.name;
    S.scanStart = b.lo / 1e6;
    S.scanStop = b.hi / 1e6;
    if (b.wifi) {
      $('scanPreset').value = '';
      syncControls();
      save();
      if (pluto) (state === 'sweep' ? stopSweep() : Promise.resolve()).then(startSweep);
      return;
    }
    const mem = S.bandMem[b.name] || { f: b.f, mode: b.mode };
    S.mode = mem.mode;
    if (b.snap) mode().snap = b.snap;
    syncControls();
    if (state === 'sweep') {
      // Leaving a Wi-Fi scan: go back to live reception in the new band.
      tuneFromScan(mem.f);
      return;
    }
    workerConfig();
    setVfo(mem.f, { center: true });
  }

  function setVfo(f, opts = {}) {
    f = clamp(Math.round(f), MIN_F, MAX_F);
    if (viewCenter !== null) {
      const [va, vb] = viewRange();
      if (opts.center || f < va || f > vb) viewCenter = null;
    }
    S.vfo = f;
    const half = S.sampleRate / 2 * 0.95;
    const [a, b] = vfoEdges(f);
    if (opts.center || a < S.lo - half || b > S.lo + half) setLo(f);
    else workerConfig();
    renderFreq();
    updateBands();
    dirty = true;
    save();
  }

  function snap(f) {
    const s = mode().snap || 1;
    return Math.round(f / s) * s;
  }

  // ---------------- frequency display ----------------
  const DIGITS = 10;
  function buildFreq() {
    const el = $('freq');
    el.innerHTML = '';
    for (let i = DIGITS - 1; i >= 0; i--) {
      const d = document.createElement('span');
      d.className = 'd';
      d.dataset.k = i;
      el.appendChild(d);
      if (i % 3 === 0 && i > 0) {
        const s = document.createElement('span');
        s.className = 'sep';
        s.textContent = '.';
        el.appendChild(s);
      }
    }
    el.addEventListener('wheel', (e) => {
      const d = e.target.closest('.d');
      if (!d) return;
      e.preventDefault();
      const step = 10 ** +d.dataset.k;
      setVfo(S.vfo + (e.deltaY < 0 ? step : -step));
    }, { passive: false });
    el.addEventListener('click', (e) => {
      const d = e.target.closest('.d');
      if (!d) return;
      const r = d.getBoundingClientRect();
      const step = 10 ** +d.dataset.k;
      setVfo(S.vfo + (e.clientY < r.top + r.height / 2 ? step : -step));
    });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const inp = $('freqInput');
      inp.value = (S.vfo / 1e6).toFixed(6).replace(/\.?0+$/, '');
      el.hidden = true;
      inp.hidden = false;
      inp.focus();
      inp.select();
    });
    const inp = $('freqInput');
    const done = (apply) => {
      if (apply) {
        const v = parseFreqInput(inp.value);
        if (v) setVfo(v, { center: true });
        else toast('周波数の形式が正しくありません（例: 82.5, 433.92M, 1.2G）');
      }
      inp.hidden = true;
      el.hidden = false;
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      else if (e.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', () => { if (!inp.hidden) done(false); });
  }

  function parseFreqInput(s) {
    const m = /^\s*([\d.]+)\s*([kKmMgG]?)(?:hz|Hz|HZ)?\s*$/.exec(s);
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (!isFinite(v)) return null;
    const mul = { k: 1e3, m: 1e6, g: 1e9, '': 1e6 }[m[2].toLowerCase()];
    return v * mul;
  }

  function renderFreq() {
    const s = String(Math.round(S.vfo)).padStart(DIGITS, '0');
    const digits = $('freq').querySelectorAll('.d');
    let lead = true;
    digits.forEach((d, i) => {
      const ch = s[i];
      if (ch !== '0') lead = false;
      d.textContent = ch;
      d.classList.toggle('dim', lead);
    });
  }

  function updateMeter() {
    const db = state === 'live' ? levelDb : -200;
    const pct = clamp((db + 100) / 100, 0, 1) * 100;
    $('meterFill').style.width = pct + '%';
    $('meterText').textContent = db > -199 ? db.toFixed(1) + ' dB' : '-- dB';
    $('stereoInd').classList.toggle('on', state === 'live' && S.mode === 'WFM' && stereoLocked);
    const sq = $('meterSq');
    sq.style.display = S.squelchOn ? 'block' : 'none';
    sq.style.left = clamp((S.squelch + 100) / 100, 0, 1) * 100 + '%';
  }

  // ---------------- colormaps ----------------
  function buildLut(name) {
    const lut = new Uint32Array(256);
    const stops = {
      classic: ['#000020', '#000030', '#000050', '#000091', '#1e90ff', '#ffffff', '#ffff00', '#fe6d16', '#ff0000', '#c60000', '#9f0000', '#750000', '#4a0000'],
      gray: ['#000000', '#ffffff'],
    }[name];
    for (let i = 0; i < 256; i++) {
      let r, g, b;
      const t = i / 255;
      if (name === 'turbo') {
        r = 34.61 + t * (1172.33 - t * (10793.56 - t * (33300.12 - t * (38394.49 - t * 14825.05))));
        g = 23.31 + t * (557.33 + t * (1225.33 - t * (3574.96 - t * (1073.77 + t * 707.56))));
        b = 27.2 + t * (3211.1 - t * (15327.97 - t * (27814 - t * (22569.18 - t * 6838.66))));
      } else {
        const pos = t * (stops.length - 1);
        const i0 = Math.min(Math.floor(pos), stops.length - 2), f = pos - i0;
        const c0 = parseInt(stops[i0].slice(1), 16), c1 = parseInt(stops[i0 + 1].slice(1), 16);
        r = ((c0 >> 16) & 255) * (1 - f) + ((c1 >> 16) & 255) * f;
        g = ((c0 >> 8) & 255) * (1 - f) + ((c1 >> 8) & 255) * f;
        b = (c0 & 255) * (1 - f) + (c1 & 255) * f;
      }
      lut[i] = (255 << 24) | (clamp(b | 0, 0, 255) << 16) | (clamp(g | 0, 0, 255) << 8) | clamp(r | 0, 0, 255);
    }
    return lut;
  }
  let lut = buildLut(S.colormap);

  // ---------------- view ----------------
  const specCanvas = $('spec'), wfCanvas = $('wf'), ovCanvas = $('wfOverlay');
  const specCtx = specCanvas.getContext('2d');
  const wfCtx = wfCanvas.getContext('2d', { willReadFrequently: false });
  const ovCtx = ovCanvas.getContext('2d');
  let dpr = window.devicePixelRatio || 1;
  let dirty = true;
  let hoverX = null;

  // Visible span: zoom slider 0..1 maps logarithmically from full band to ~1/2000.
  // Centre of the displayed range while live; null follows the VFO.
  let viewCenter = null;

  function viewRange() {
    if (state === 'sweep' && sweep) {
      const full = sweep.stop - sweep.start;
      const span = full / (1 + 199 * S.zoom ** 2);
      const c = clamp(sweep.viewCenter ?? (sweep.start + full / 2), sweep.start + span / 2, sweep.stop - span / 2);
      return [c - span / 2, c + span / 2];
    }
    const fs = S.sampleRate;
    const span = Math.max(fs / Math.pow(2000, S.zoom), 2000);
    // While panning, follow the LO being tuned rather than the last frame.
    const lo = state === 'live' && lastFFT && !(drag && drag.kind === 'pan') ? lastFFT.f0 + fs / 2 : S.lo;
    const c = clamp(viewCenter ?? S.vfo, lo - fs / 2 + span / 2, lo + fs / 2 - span / 2);
    return [c - span / 2, c + span / 2];
  }

  function xToFreq(x, w) {
    const [a, b] = viewRange();
    return a + (x / w) * (b - a);
  }
  function freqToX(f, w) {
    const [a, b] = viewRange();
    return ((f - a) / (b - a)) * w;
  }

  // Per-pixel max (or interpolation when zoomed past bin resolution).
  function lineFor(db, f0, binHz, va, vb, W, out) {
    const n = db.length;
    const px = (vb - va) / W;
    for (let x = 0; x < W; x++) {
      const fa = va + x * px, fb = fa + px;
      const ia = (fa - f0) / binHz, ib = (fb - f0) / binHz;
      if (ib < 0 || ia >= n) { out[x] = NaN; continue; }
      if (ib - ia < 1) {
        const p = clamp((ia + ib) / 2 - 0.5, 0, n - 1);
        const i = Math.floor(p), f = p - i;
        out[x] = i + 1 < n ? db[i] * (1 - f) + db[i + 1] * f : db[i];
      } else {
        let m = -Infinity;
        const s = Math.max(0, Math.floor(ia)), e = Math.min(n, Math.ceil(ib));
        for (let i = s; i < e; i++) if (db[i] > m) m = db[i];
        out[x] = m;
      }
    }
    return out;
  }

  function niceStep(span, target) {
    const raw = span / target;
    const p = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }

  function fmtTick(f, step) {
    if (step >= 1e6) return (f / 1e6).toFixed(Math.max(0, -Math.floor(Math.log10(step / 1e6)))) + 'M';
    if (step >= 1e3) return (f / 1e6).toFixed(Math.max(3, 6 - Math.floor(Math.log10(step)))).replace(/\.?0+$/, '') + 'M';
    return (f / 1e6).toFixed(6) + 'M';
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    for (const c of [specCanvas, wfCanvas, ovCanvas]) {
      const w = Math.max(1, Math.round(c.clientWidth * dpr));
      const h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    wfFullRender();
    dirty = true;
  }

  const AXIS_H = 22;
  let lineBuf = new Float32Array(0);

  function drawSpectrum() {
    const W = specCanvas.width, H = specCanvas.height;
    const ctx = specCtx;
    const axisH = AXIS_H * dpr;
    const plotH = H - axisH;
    ctx.fillStyle = '#0b0b0d';
    ctx.fillRect(0, 0, W, H);

    const [va, vb] = viewRange();
    const dbMin = S.dbMin, dbMax = Math.max(S.dbMax, S.dbMin + 5);
    const yOf = (db) => (1 - (db - dbMin) / (dbMax - dbMin)) * plotH;

    // Grid.
    ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`;
    ctx.strokeStyle = '#26262b';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#7d7d86';
    ctx.textBaseline = 'middle';
    const dbStep = niceStep(dbMax - dbMin, plotH / (40 * dpr));
    for (let d = Math.ceil(dbMin / dbStep) * dbStep; d <= dbMax; d += dbStep) {
      const y = Math.round(yOf(d)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillText(String(Math.round(d)), 4 * dpr, y - 7 * dpr);
    }
    const fStep = niceStep(vb - va, W / (110 * dpr));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let f = Math.ceil(va / fStep) * fStep; f <= vb; f += fStep) {
      const x = Math.round(((f - va) / (vb - va)) * W) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
      ctx.fillText(fmtTick(f, fStep), x, plotH + 5 * dpr);
    }
    ctx.textAlign = 'left';
    ctx.strokeStyle = '#3a3a40';
    ctx.beginPath(); ctx.moveTo(0, plotH + 0.5); ctx.lineTo(W, plotH + 0.5); ctx.stroke();

    // Trace.
    let src = null;
    if (state === 'sweep' && sweep) src = { db: sweep.db, f0: sweep.start, binHz: sweep.binHz };
    else if (lastFFT) src = lastFFT;
    if (src) {
      if (lineBuf.length !== W) lineBuf = new Float32Array(W);
      lineFor(src.db, src.f0, src.binHz, va, vb, W, lineBuf);
      const grad = ctx.createLinearGradient(0, 0, 0, plotH);
      grad.addColorStop(0, 'rgba(66,150,250,0.45)');
      grad.addColorStop(1, 'rgba(66,150,250,0.04)');
      ctx.beginPath();
      let started = false, lastX = 0;
      for (let x = 0; x < W; x++) {
        const v = lineBuf[x];
        if (Number.isNaN(v)) continue;
        const y = clamp(yOf(v), 0, plotH);
        if (!started) { ctx.moveTo(x, plotH); ctx.lineTo(x, y); started = true; } else ctx.lineTo(x, y);
        lastX = x;
      }
      if (started) {
        ctx.lineTo(lastX, plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.beginPath();
        started = false;
        for (let x = 0; x < W; x++) {
          const v = lineBuf[x];
          if (Number.isNaN(v)) { started = false; continue; }
          const y = clamp(yOf(v), 0, plotH);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#9cc8ff';
        ctx.lineWidth = Math.max(1, dpr * 0.75);
        ctx.stroke();
      }
    }

    drawWifiChannels(ctx, W, plotH, va, vb);

    // VFO.
    if (state !== 'sweep') drawVfo(ctx, W, plotH, true);
    if (state === 'sweep' && sweep) drawSweepCursor(ctx, W, plotH);

    // Hover readout.
    if (hoverX !== null) {
      const x = hoverX * dpr;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, plotH); ctx.stroke();
      const f = xToFreq(x, W);
      let txt = fmtHz(f, 4);
      if (src && lineBuf.length === W && !Number.isNaN(lineBuf[Math.round(clamp(x, 0, W - 1))])) {
        txt += '  ' + lineBuf[Math.round(clamp(x, 0, W - 1))].toFixed(1) + ' dB';
      }
      ctx.font = `${12 * dpr}px ui-monospace, Menlo, monospace`;
      const tw = ctx.measureText(txt).width + 10 * dpr;
      const tx = clamp(x + 8 * dpr, 0, W - tw);
      ctx.fillStyle = 'rgba(20,20,24,0.85)';
      ctx.fillRect(tx, 6 * dpr, tw, 18 * dpr);
      ctx.fillStyle = '#e4e4e7';
      ctx.textBaseline = 'middle';
      ctx.fillText(txt, tx + 5 * dpr, 15 * dpr);
    }
  }

  // Wi-Fi channel numbers along the top while a Wi-Fi band is shown.
  function drawWifiChannels(ctx, W, H, va, vb) {
    const band = activeBand();
    if (!band || !band.wifi) return;
    const chans = WIFI_CHANNELS.filter(([, f, w]) => f + w / 2 > va && f - w / 2 < vb);
    if (!chans.length) return;
    const px = (f) => ((f - va) / (vb - va)) * W;
    ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // Skip labels that would overlap (2.4 GHz channels are 5 MHz apart).
    const minGap = ctx.measureText('ch144').width + 6 * dpr;
    let lastX = -Infinity, row = 0;
    for (const [n, f, w] of chans) {
      const x = px(f), xa = px(f - w / 2), xb = px(f + w / 2);
      const y = 4 * dpr + (row % 2) * 4 * dpr;
      row++;
      ctx.strokeStyle = 'rgba(245,217,10,0.35)';
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath(); ctx.moveTo(xa + 1, y); ctx.lineTo(xb - 1, y); ctx.stroke();
      ctx.setLineDash([3 * dpr, 4 * dpr]);
      ctx.strokeStyle = 'rgba(245,217,10,0.18)';
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y); ctx.lineTo(Math.round(x) + 0.5, H); ctx.stroke();
      ctx.setLineDash([]);
      if (x - lastX >= minGap) {
        ctx.fillStyle = 'rgba(245,217,10,0.85)';
        ctx.fillText('ch' + n, x, 12 * dpr);
        lastX = x;
      }
    }
    ctx.textAlign = 'left';
  }

  function drawVfo(ctx, W, H, label) {
    const [a, b] = vfoEdges();
    const xa = freqToX(a, W), xb = freqToX(b, W), xc = freqToX(S.vfo, W);
    ctx.fillStyle = 'rgba(66,150,250,0.20)';
    ctx.fillRect(xa, 0, Math.max(1, xb - xa), H);
    ctx.strokeStyle = 'rgba(66,150,250,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(xa) + 0.5, 0); ctx.lineTo(Math.round(xa) + 0.5, H);
    ctx.moveTo(Math.round(xb) + 0.5, 0); ctx.lineTo(Math.round(xb) + 0.5, H);
    ctx.stroke();
    ctx.strokeStyle = '#ff4d4d';
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath(); ctx.moveTo(Math.round(xc) + 0.5, 0); ctx.lineTo(Math.round(xc) + 0.5, H); ctx.stroke();
    if (label) {
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(66,150,250,0.95)';
      const t = S.mode;
      const tw = ctx.measureText(t).width;
      ctx.fillText(t, clamp(xc - tw / 2, 0, W - tw), H - 10 * dpr);
    }
  }

  function drawSweepCursor(ctx, W, H) {
    if (sweep.curLo == null) return;
    const x = freqToX(sweep.curLo, W);
    ctx.strokeStyle = 'rgba(255,200,0,0.6)';
    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke();
  }

  function drawOverlay() {
    const W = ovCanvas.width, H = ovCanvas.height;
    ovCtx.clearRect(0, 0, W, H);
    if (state !== 'sweep') {
      ovCtx.save();
      ovCtx.globalAlpha = 0.6;
      drawVfo(ovCtx, W, H, false);
      ovCtx.restore();
    }
    if (hoverX !== null) {
      ovCtx.strokeStyle = 'rgba(255,255,255,0.25)';
      ovCtx.beginPath(); ovCtx.moveTo(hoverX * dpr + 0.5, 0); ovCtx.lineTo(hoverX * dpr + 0.5, H); ovCtx.stroke();
    }
  }

  // ---------------- waterfall ----------------
  const WF_ROWS = 1200;
  const wfRows = [];
  let wfView = null;
  let wfPending = [];

  function quantize(db) {
    const q = new Uint8Array(db.length);
    for (let i = 0; i < db.length; i++) q[i] = clamp(Math.round((db[i] + 170) * 1.5), 0, 255);
    return q;
  }

  function wfPush(db, f0, binHz) {
    const row = { q: quantize(db), f0, binHz };
    wfRows.unshift(row);
    if (wfRows.length > WF_ROWS) wfRows.length = WF_ROWS;
    wfPending.push(row);
  }

  let rowLine = new Float32Array(0), rowQ = new Float32Array(0);
  function paintRow(row, img, y, W, va, vb) {
    if (rowLine.length !== W) rowLine = new Float32Array(W);
    if (rowQ.length !== row.q.length) rowQ = new Float32Array(row.q.length);
    for (let i = 0; i < row.q.length; i++) rowQ[i] = row.q[i] / 1.5 - 170;
    lineFor(rowQ, row.f0, row.binHz, va, vb, W, rowLine);
    const lo = S.dbMin, k = 255 / Math.max(S.dbMax - S.dbMin, 1);
    const base = y * W;
    for (let x = 0; x < W; x++) {
      const v = rowLine[x];
      img[base + x] = Number.isNaN(v) ? 0xff0a0a0a : lut[clamp(((v - lo) * k) | 0, 0, 255)];
    }
  }

  function wfFullRender() {
    const W = wfCanvas.width, H = wfCanvas.height;
    if (!W || !H) return;
    const [va, vb] = viewRange();
    const img = wfCtx.createImageData(W, H);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xff0a0a0a);
    const n = Math.min(H, wfRows.length);
    for (let y = 0; y < n; y++) paintRow(wfRows[y], px, y, W, va, vb);
    wfCtx.putImageData(img, 0, 0);
    wfView = { va, vb, W, H, min: S.dbMin, max: S.dbMax, lut };
    wfPending = [];
  }

  function wfUpdate() {
    const W = wfCanvas.width, H = wfCanvas.height;
    const [va, vb] = viewRange();
    if (!wfView || wfView.va !== va || wfView.vb !== vb || wfView.W !== W || wfView.H !== H ||
        wfView.min !== S.dbMin || wfView.max !== S.dbMax || wfView.lut !== lut) {
      wfFullRender();
      return;
    }
    const n = wfPending.length;
    if (!n) return;
    if (n >= H) { wfFullRender(); return; }
    wfCtx.drawImage(wfCanvas, 0, 0, W, H - n, 0, n, W, H - n);
    const img = wfCtx.createImageData(W, n);
    const px = new Uint32Array(img.data.buffer);
    // Newest row goes on top.
    for (let i = 0; i < n; i++) paintRow(wfPending[n - 1 - i], px, i, W, va, vb);
    wfCtx.putImageData(img, 0, 0);
    wfPending = [];
  }

  function frame() {
    if (dirty) {
      dirty = false;
      drawSpectrum();
      wfUpdate();
      drawOverlay();
    }
    requestAnimationFrame(frame);
  }

  // ---------------- pointer interaction ----------------
  let drag = null;

  function hitEdge(x, W) {
    if (state === 'sweep') return null;
    const [a, b] = vfoEdges();
    const xa = freqToX(a, W) / dpr, xb = freqToX(b, W) / dpr;
    if (Math.abs(x - xa) < 5) return S.mode === 'USB' ? null : 'left';
    if (Math.abs(x - xb) < 5) return S.mode === 'LSB' ? null : 'right';
    return null;
  }

  function attachPointer(el) {
    el.addEventListener('pointerdown', (e) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const W = el.width;
      const f = xToFreq(x * dpr, W);
      el.setPointerCapture(e.pointerId);
      const [va, vb] = viewRange();
      // Spectrum: dragging the background scrolls the frequency; a click
      // without movement tunes there (decided on pointerup).
      const pan = { kind: 'pan', el, x0: x, f, hzPerPx: (vb - va) / el.clientWidth, moved: false };
      if (state === 'sweep') {
        drag = Object.assign(pan, { center0: (va + vb) / 2 });
        return;
      }
      const edge = el === specCanvas ? hitEdge(x, W) : null;
      if (edge) { drag = { kind: 'edge', edge, el }; return; }
      // Spectrum: always scroll (the VFO only moves on a plain click).
      if (el === specCanvas) { drag = Object.assign(pan, { center0: (va + vb) / 2, span: vb - va }); return; }
      const [a, b] = vfoEdges();
      if (f >= a && f <= b) drag = { kind: 'vfo', el, off: S.vfo - f };
      else { drag = { kind: 'vfo', el, off: 0 }; setVfo(snap(f)); }
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      hoverX = x;
      dirty = true;
      const W = el.width;
      if (!drag) {
        el.style.cursor = el === specCanvas && hitEdge(x, W) ? 'ew-resize' : 'crosshair';
        return;
      }
      if (drag.kind === 'pan') {
        const dx = x - drag.x0;
        if (!drag.moved && Math.abs(dx) < 4) return;
        drag.moved = true;
        el.style.cursor = 'grabbing';
        const df = -dx * drag.hzPerPx;
        if (state === 'sweep') {
          if (sweep && drag.center0 != null) { sweep.viewCenter = drag.center0 + df; dirty = true; }
          return;
        }
        // Scroll the displayed range. The VFO keeps its frequency; the LO
        // follows when the view leaves the captured band.
        const fs = S.sampleRate, span = drag.span;
        const c = clamp(drag.center0 + df, MIN_F + span / 2, MAX_F - span / 2);
        let lo = S.lo;
        if (c - span / 2 < lo - fs / 2) lo = c - span / 2 + fs / 2;
        if (c + span / 2 > lo + fs / 2) lo = c + span / 2 - fs / 2;
        viewCenter = c;
        if (Math.round(lo) !== S.lo) {
          // Keep the VFO inside the band; it is pushed along at the edge.
          const half = fs / 2 * 0.95;
          const v = clamp(S.vfo, lo - half, lo + half);
          if (v !== S.vfo) { S.vfo = snap(v); renderFreq(); updateBands(); }
          setLo(lo);
          save();
        }
        dirty = true;
        return;
      }
      const f = xToFreq(x * dpr, W);
      if (drag.kind === 'vfo') {
        const nf = snap(f + drag.off);
        if (nf !== S.vfo) {
          // Stay inside the current band while dragging.
          const half = S.sampleRate / 2;
          setVfo(clamp(nf, S.lo - half, S.lo + half));
        }
      } else if (drag.kind === 'edge') {
        let bw;
        if (S.mode === 'USB') bw = f - S.vfo;
        else if (S.mode === 'LSB') bw = S.vfo - f;
        else bw = 2 * Math.abs(f - S.vfo);
        const [mn, mx] = BW_LIMITS[S.mode];
        setBandwidth(clamp(Math.round(bw / 100) * 100, mn, mx));
      }
    });
    el.addEventListener('pointerup', () => {
      const d = drag;
      drag = null;
      el.style.cursor = 'crosshair';
      if (!d || d.kind !== 'pan' || d.moved) return;
      if (state === 'sweep') tuneFromScan(d.f);
      else setVfo(snap(d.f));
    });
    el.addEventListener('pointercancel', () => { drag = null; });
    el.addEventListener('pointerleave', () => { hoverX = null; dirty = true; });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const z = clamp(S.zoom - e.deltaY * 0.0015, 0, 1);
        if (state === 'sweep' && sweep) {
          const r = el.getBoundingClientRect();
          sweep.viewCenter = xToFreq((e.clientX - r.left) * dpr, el.width);
        }
        S.zoom = z;
        $('zoom').value = z;
        dirty = true;
        save();
        return;
      }
      if (state === 'sweep') return;
      const step = mode().snap || 1000;
      setVfo(snap(S.vfo) + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 10 : 1));
    }, { passive: false });
  }

  function setBandwidth(bw) {
    mode().bandwidth = bw;
    $('bandwidth').value = +(bw / 1e3).toFixed(2);
    workerConfig();
    dirty = true;
    save();
  }

  // ---------------- wideband scan ----------------
  let sweep = null;
  let sweepId = 0;

  function sweepFFT(iq, lo) {
    return new Promise((resolve) => {
      const id = ++sweepId;
      sweepWaiters.set(id, resolve);
      worker.postMessage({ type: 'sweep', data: iq, lo, id }, [iq.buffer]);
    });
  }

  async function startSweep() {
    if (!pluto) return;
    let a = clamp(+S.scanStart * 1e6, MIN_F, MAX_F), b = clamp(+S.scanStop * 1e6, MIN_F, MAX_F);
    if (!(b > a)) { toast('Stop は Start より大きくしてください'); return; }
    await stopStream();
    const token = ++streamToken;
    const binHz = SCAN_FS / SCAN_FFT;
    const nb = Math.ceil((b - a) / binHz) + 1;
    sweep = { start: a, stop: b, binHz, db: new Float32Array(nb).fill(-160), curLo: null, viewCenter: null, passes: 0 };
    state = 'sweep';
    S.zoom = 0; $('zoom').value = 0;
    wfRows.length = 0;
    setStatus();
    dirty = true;
    try {
      await pluto.setSampleRate(SCAN_FS);
      await pluto.setBandwidth(18e6);
      await pluto.setGainMode('manual');
      await pluto.setGain(S.scanGain);
      await pluto.setKernelBuffers(2);
      await pluto.startRx(SCAN_BLOCK);
    } catch (e) {
      toast('スキャンを開始できません: ' + e.message);
      await stopStream();
      return;
    }
    const use = SCAN_FS * SCAN_USE;
    const half = SCAN_FFT / 2, keep = Math.ceil(SCAN_FFT * SCAN_USE / 2) + 2; // slight overlap: no gaps between steps
    try {
      while (token === streamToken) {
        const t0 = performance.now();
        for (let c = a + use / 2; c - use / 2 < b && token === streamToken; c += use) {
          const lo = clamp(Math.round(c), MIN_F, MAX_F);
          await pluto.setFrequency(lo);
          await pluto.readRx();
          await pluto.readRx();
          const iq = await pluto.readRx();
          const db = await sweepFFT(iq, lo);
          if (token !== streamToken) break;
          // DC spike: patch the centre bins from their neighbours.
          const dcFix = (db[half - 3] + db[half + 3]) / 2;
          for (let i = half - 2; i <= half + 2; i++) db[i] = dcFix;
          for (let i = half - keep; i <= half + keep; i++) {
            const f = lo + (i - half) * binHz;
            const j = Math.round((f - a) / binHz);
            if (j >= 0 && j < nb) sweep.db[j] = db[i];
          }
          sweep.curLo = lo;
          dirty = true;
        }
        if (token !== streamToken) break;
        sweep.passes++;
        wfPush(sweep.db, a, binHz);
        dirty = true;
        const dt = (performance.now() - t0) / 1000;
        $('scanInfo').textContent = `Pass ${sweep.passes} · ${dt.toFixed(2)} s/sweep · ${(binHz / 1e3).toFixed(1)} kHz/bin`;
      }
    } catch (e) {
      if (token === streamToken) onDeviceLost('スキャン中のエラー: ' + e.message);
    }
  }

  async function stopSweep() {
    if (state !== 'sweep') return;
    await stopStream();
    wfRows.length = 0;
    if (pluto) {
      try {
        await pluto.setKernelBuffers(LIVE_KERNEL_BUFFERS);
        await applySource();
      } catch (e) { /* reported on next start */ }
    }
    setStatus();
    dirty = true;
  }

  async function tuneFromScan(f) {
    f = snap(clamp(f, MIN_F, MAX_F));
    await stopSweep();
    viewCenter = null;
    S.vfo = f;
    S.lo = f;
    curLo = f;
    renderFreq();
    updateBands();
    save();
    await startLive();
  }

  // ---------------- controls ----------------
  function fillSelect(sel, values, fmt) {
    sel.innerHTML = '';
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = fmt(v);
      sel.appendChild(o);
    }
  }

  function syncControls() {
    $('sampleRate').value = S.sampleRate;
    $('rfBw').value = S.rfBw;
    $('gainMode').value = S.gainMode;
    $('gain').value = S.gain;
    $('ppm').value = S.ppm;
    $('gain').disabled = S.gainMode !== 'manual';
    $('gainVal').textContent = S.gain + ' dB';
    document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
    $('bandwidth').value = +(mode().bandwidth / 1e3).toFixed(2);
    $('snap').value = mode().snap;
    $('deemph').value = mode().deemph;
    $('deemph').disabled = !(S.mode === 'WFM' || S.mode === 'NFM');
    $('stereo').checked = S.stereo;
    $('stereo').disabled = S.mode !== 'WFM';
    $('squelchOn').checked = S.squelchOn;
    $('squelch').value = S.squelch;
    $('squelchVal').textContent = S.squelch;
    $('fftSize').value = S.fftSize;
    $('fps').value = S.fps; $('fpsVal').textContent = S.fps;
    $('window').value = S.window;
    $('smoothing').value = S.smoothing; $('smoothingVal').textContent = S.smoothing.toFixed(2);
    $('colormap').value = S.colormap;
    $('dbMax').value = S.dbMax; $('dbMaxVal').textContent = S.dbMax;
    $('dbMin').value = S.dbMin; $('dbMinVal').textContent = S.dbMin;
    $('scanStart').value = S.scanStart;
    $('scanStop').value = S.scanStop;
    $('scanGain').value = S.scanGain; $('scanGainVal').textContent = S.scanGain + ' dB';
    $('volume').value = S.volume;
    $('zoom').value = S.zoom;
    $('app').classList.toggle('nomenu', !S.menu);
    updateMeter();
  }

  function bindControls() {
    fillSelect($('sampleRate'), SAMPLE_RATES, (v) => fmtRate(v) + (v > 6e6 ? ' (USB limit)' : ''));
    fillSelect($('rfBw'), RF_BWS, (v) => (v ? fmtHz(v, 1) : 'Auto'));

    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

    on('btnConnect', 'click', () => (pluto ? disconnect() : connect(true)));
    on('btnPlay', 'click', () => (state === 'live' ? stopStream() : state === 'sweep' ? stopSweep().then(startLive) : startLive()));
    on('btnMenu', 'click', () => {
      if (window.matchMedia('(max-width: 760px)').matches) $('app').classList.toggle('menu-open');
      else { S.menu = !S.menu; $('app').classList.toggle('nomenu', !S.menu); save(); }
      setTimeout(resize, 0);
    });
    on('volume', 'input', (e) => {
      S.volume = +e.target.value;
      if (audio) audio.gain.gain.setTargetAtTime(S.volume ** 2, audio.ctx.currentTime, 0.02);
      save();
    });

    on('sampleRate', 'change', async (e) => {
      S.sampleRate = +e.target.value;
      save();
      wfRows.length = 0;
      workerConfig();
      await restartIfLive();
      setVfo(S.vfo);
      setStatus();
    });
    on('rfBw', 'change', async (e) => {
      S.rfBw = +e.target.value;
      save();
      if (pluto && state === 'live') pluto.setBandwidth(rfBandwidth()).catch((err) => toast(err.message));
    });
    on('gainMode', 'change', async (e) => {
      S.gainMode = e.target.value;
      syncControls();
      save();
      if (pluto && state !== 'sweep') {
        try {
          await pluto.setGainMode(S.gainMode);
          if (S.gainMode === 'manual') await pluto.setGain(S.gain);
        } catch (err) { toast(err.message); }
      }
    });
    on('ppm', 'change', async (e) => {
      S.ppm = clamp(Math.round((+e.target.value || 0) * 10) / 10, -100, 100);
      e.target.value = S.ppm;
      save();
      if (!pluto) return;
      await applyPpm();
      // The driver recomputes dividers from the new reference on the next write.
      if (state !== 'sweep') {
        await pluto.setSampleRate(S.sampleRate).catch(() => {});
        await pluto.setFrequency(curLo).catch(() => {});
      }
    });
    on('gain', 'input', (e) => {
      S.gain = +e.target.value;
      $('gainVal').textContent = S.gain + ' dB';
      save();
      if (pluto && state !== 'sweep' && S.gainMode === 'manual') pluto.setGain(S.gain).catch(() => {});
    });

    document.querySelectorAll('#modes button').forEach((b) => b.addEventListener('click', () => {
      S.mode = b.dataset.mode;
      syncControls();
      workerConfig();
      setVfo(S.vfo);
      save();
    }));
    on('bandwidth', 'change', (e) => {
      const [mn, mx] = BW_LIMITS[S.mode];
      setBandwidth(clamp((+e.target.value || 0) * 1e3, mn, mx));
    });
    on('snap', 'change', (e) => { mode().snap = +e.target.value; save(); });
    on('deemph', 'change', (e) => { mode().deemph = +e.target.value; workerConfig(); save(); });
    on('stereo', 'change', (e) => { S.stereo = e.target.checked; workerConfig(); save(); });
    on('squelchOn', 'change', (e) => { S.squelchOn = e.target.checked; workerConfig(); updateMeter(); save(); });
    on('squelch', 'input', (e) => {
      S.squelch = +e.target.value;
      $('squelchVal').textContent = S.squelch;
      workerConfig(); updateMeter(); save();
    });

    on('fftSize', 'change', (e) => { S.fftSize = +e.target.value; wfRows.length = 0; workerConfig(); save(); });
    on('fps', 'input', (e) => { S.fps = +e.target.value; $('fpsVal').textContent = S.fps; workerConfig(); save(); });
    on('window', 'change', (e) => { S.window = e.target.value; workerConfig(); save(); });
    on('smoothing', 'input', (e) => {
      S.smoothing = +e.target.value;
      $('smoothingVal').textContent = S.smoothing.toFixed(2);
      workerConfig(); save();
    });
    on('colormap', 'change', (e) => { S.colormap = e.target.value; lut = buildLut(S.colormap); dirty = true; save(); });
    on('dbMax', 'input', (e) => {
      S.dbMax = Math.max(+e.target.value, S.dbMin + 5);
      $('dbMaxVal').textContent = S.dbMax;
      dirty = true; save();
    });
    on('dbMin', 'input', (e) => {
      S.dbMin = Math.min(+e.target.value, S.dbMax - 5);
      $('dbMinVal').textContent = S.dbMin;
      dirty = true; save();
    });
    on('zoom', 'input', (e) => { S.zoom = +e.target.value; dirty = true; save(); });

    on('scanPreset', 'change', (e) => {
      if (!e.target.value) return;
      const [a, b] = e.target.value.split(',').map(Number);
      S.scanStart = a; S.scanStop = b;
      syncControls(); save();
    });
    on('scanStart', 'change', (e) => { S.scanStart = +e.target.value; $('scanPreset').value = ''; save(); });
    on('scanStop', 'change', (e) => { S.scanStop = +e.target.value; $('scanPreset').value = ''; save(); });
    on('scanGain', 'input', (e) => {
      S.scanGain = +e.target.value;
      $('scanGainVal').textContent = S.scanGain + ' dB';
      save();
      if (pluto && state === 'sweep') pluto.setGain(S.scanGain).catch(() => {});
    });
    on('btnScan', 'click', () => (state === 'sweep' ? stopSweep() : startSweep()));

    // Spectrum / waterfall splitter.
    const split = $('splitter');
    split.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      split.setPointerCapture(e.pointerId);
      split.classList.add('drag');
      const plots = $('plots').getBoundingClientRect();
      const grab = e.clientY - (plots.top + S.specFrac * plots.height);
      const move = (ev) => {
        S.specFrac = clamp((ev.clientY - grab - plots.top) / plots.height, 0.1, 0.9);
        specCanvas.style.height = S.specFrac * 100 + '%';
        resize();
      };
      const up = () => {
        split.classList.remove('drag');
        split.removeEventListener('pointermove', move);
        split.removeEventListener('pointerup', up);
        split.removeEventListener('pointercancel', up);
        save();
      };
      split.addEventListener('pointermove', move);
      split.addEventListener('pointerup', up);
      split.addEventListener('pointercancel', up);
    });
    // Double-click restores the default split.
    split.addEventListener('dblclick', () => {
      S.specFrac = DEFAULTS.specFrac;
      specCanvas.style.height = S.specFrac * 100 + '%';
      resize();
      save();
    });

    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      const step = mode().snap || 1000;
      if (e.code === 'Space') { e.preventDefault(); if (pluto) $('btnPlay').click(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setVfo(snap(S.vfo) + step * (e.shiftKey ? 10 : 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setVfo(snap(S.vfo) - step * (e.shiftKey ? 10 : 1)); }
    });

    $('introClose').addEventListener('click', () => { $('intro').hidden = true; S.introSeen = true; save(); });
  }

  // Read-only hook for tools/browser-check.mjs.
  window.__plutoNano = { S, get sweep() { return sweep; }, wfRows, get state() { return state; } };

  // ---------------- init ----------------
  buildFreq();
  buildBands();
  updateBands();
  bindControls();
  syncControls();
  renderFreq();
  setStatus();
  specCanvas.style.height = S.specFrac * 100 + '%';
  attachPointer(specCanvas);
  attachPointer(ovCanvas);
  new ResizeObserver(resize).observe($('plots'));
  resize();
  workerConfig();
  requestAnimationFrame(frame);
  if (!S.introSeen) $('intro').hidden = false;
  if (!navigator.usb) {
    toast('このブラウザは WebUSB に対応していません。Chrome または Edge で開いてください。');
  } else {
    connect(false);
  }
})();
