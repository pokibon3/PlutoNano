// Pluto SDR Nano — UI, stream control, rendering and wideband scan.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MIN_F = 70e6, MAX_F = 6e9;
  const SCAN_FS = 20e6, SCAN_BLOCK = 16384, SCAN_FFT = 1024, SCAN_USE = 0.8;

  // filters: FIL1..FIL3 bandwidths; fil selects one and bandwidth follows it.
  const MODE_DEFAULTS = {
    WFM: { filters: [200e3, 150e3, 100e3], fil: 0, snap: 100000, deemph: 50 },
    NFM: { filters: [15e3, 10e3, 7e3], fil: 0, snap: 12500, deemph: 0 },
    AM: { filters: [9e3, 6e3, 3e3], fil: 1, snap: 1000, deemph: 0 },
    USB: { filters: [3e3, 2.4e3, 1.8e3], fil: 1, snap: 100, deemph: 0 },
    LSB: { filters: [3e3, 2.4e3, 1.8e3], fil: 1, snap: 100, deemph: 0 },
    CW: { filters: [1.2e3, 500, 250], fil: 1, snap: 100, deemph: 0 },
  };
  // Must match dsp.js: SSB passband low cut and the CW tone.
  const SSB_LOWCUT = 100, CW_PITCH = 700;
  const BW_LIMITS = { WFM: [50e3, 250e3], NFM: [3e3, 50e3], AM: [1e3, 30e3], USB: [500, 6e3], LSB: [500, 6e3], CW: [100, 3e3] };
  // Below ~2.083 MSPS the AD9361 needs a FIR filter loaded; without one the
  // driver rejects the rate and the next rate change hangs the device.
  const SAMPLE_RATES = [2.4e6, 3.072e6, 4e6, 5e6, 6e6, 7.68e6];
  const MIN_RATE = 2.4e6;
  const RF_BWS = [0, 0.2e6, 0.5e6, 1e6, 2e6, 4e6, 6e6, 10e6, 20e6, 56e6];

  // Band buttons: default frequency, mode and the range used for the
  // wideband scan and for remembering the last frequency in the band.
  const BANDS = [
    { name: 'FM', f: 80.0e6, mode: 'WFM', lo: 76e6, hi: 95e6, title: 'FM 放送 76–95 MHz' },
    { name: 'AIR', f: 118.1e6, mode: 'AM', lo: 118e6, hi: 137e6, title: 'エアバンド 118–137 MHz' },
    // Below the 70 MHz tuning limit: a placeholder key, disabled.
    { name: '50', lo: 50e6, hi: 54e6, dummy: true, title: '50 MHz アマチュアバンド 50–54 MHz（70 MHz 未満は受信不可）' },
    // Japanese amateur bands: NFM, 20 kHz channel step.
    { name: '144', f: 145.0e6, mode: 'NFM', snap: 20e3, lo: 144e6, hi: 146e6, title: '144 MHz アマチュアバンド 144–146 MHz' },
    { name: '430', f: 433.0e6, mode: 'NFM', snap: 20e3, lo: 430e6, hi: 440e6, title: '430 MHz アマチュアバンド 430–440 MHz' },
    { name: '1200', f: 1295.0e6, mode: 'NFM', snap: 20e3, lo: 1260e6, hi: 1300e6, title: '1200 MHz アマチュアバンド 1260–1300 MHz' },
    { name: '2400', f: 2427.0e6, mode: 'NFM', snap: 20e3, lo: 2400e6, hi: 2450e6, title: '2400 MHz アマチュアバンド 2400–2450 MHz' },
    { name: '5600', f: 5760.0e6, mode: 'NFM', snap: 20e3, lo: 5650e6, hi: 5850e6, title: '5600 MHz アマチュアバンド 5650–5850 MHz' },
  ];

  const DEFAULTS = {
    lo: 80e6, vfo: 80e6, sampleRate: 2.4e6, rfBw: 0, gainMode: 'slow_attack', gain: 50,
    mode: 'WFM', perMode: JSON.parse(JSON.stringify(MODE_DEFAULTS)),
    ppm: 0, squelchOn: false, squelch: -60, volume: 0.6, stereo: true,
    fftSize: 8192, fps: 30, window: 'bh', smoothing: 0.8, colormap: 'classic',
    dbMin: -120, dbMax: -30, zoom: 0, specFrac: 0.32,
    scanStart: 76, scanStop: 95, scanGain: 50, menu: true, introSeen: false,
    band: null, bandMem: {},
    meterStyle: 'needle', panelTheme: 'cyan', meterCal: -10, autoTs: true, txEnabled: false, txAtten: -30, micGain: 20,
    audioOut: '', audioIn: '',
  };

  // ---------------- settings ----------------
  const S = (() => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('plutonano.settings') || '{}'); } catch (e) { /* ignore */ }
    const s = Object.assign({}, DEFAULTS, saved);
    s.perMode = {};
    for (const [k, d] of Object.entries(JSON.parse(JSON.stringify(MODE_DEFAULTS)))) {
      const m = s.perMode[k] = Object.assign(d, (saved.perMode || {})[k]);
      m.bandwidth = m.filters[m.fil];
    }
    if (!MODE_DEFAULTS[s.mode]) s.mode = 'WFM';
    if (!(s.sampleRate >= MIN_RATE)) s.sampleRate = MIN_RATE;
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
    if (S.audioOut) applySink(ctx);
    const gain = ctx.createGain();
    gain.gain.value = S.volume ** 2;
    gain.connect(ctx.destination);
    // Audio scope taps the demodulated audio ahead of the volume control.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.6;
    analyser.connect(gain);
    const ch = new MessageChannel();
    let node = null;
    // file:// pages cannot load worklets from blob: URLs, but data: URLs work.
    const code = $('worklet-src').textContent;
    for (const url of ['data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(code))), blobUrl('worklet-src')]) {
      try { await ctx.audioWorklet.addModule(url); node = new AudioWorkletNode(ctx, 'pluto-player', { numberOfInputs: 0, outputChannelCount: [2] }); break; } catch (e) { /* try next */ }
    }
    ctx.hasWorklet = !!node;
    if (node) {
      node.port.postMessage({ port: ch.port1 }, [ch.port1]);
    } else {
      node = scriptProcessorPlayer(ctx, ch.port1);
    }
    node.connect(analyser);
    worker.postMessage({ type: 'audioPort', port: ch.port2 }, [ch.port2]);
    audio = { ctx, node, gain, analyser };
    // Drop what piled up while suspended so playback starts without lag.
    ctx.addEventListener('statechange', () => { if (ctx.state === 'running') node.port.postMessage({ reset: true }); });
    resumeAudio();
  }

  // ---------------- audio devices ----------------
  const canSink = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  const hasDevices = !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices);

  async function applySink(ctx) {
    try {
      await ctx.setSinkId(S.audioOut);
    } catch (e) {
      toast('出力デバイスを使えません。既定の出力に戻します: ' + e.message);
      S.audioOut = ''; save(); refreshAudioDevices();
      try { await ctx.setSinkId(''); } catch (e2) { /* ignore */ }
    }
  }

  // Without mic permission the labels are empty and the ids are not
  // stable, so the names button asks once.
  async function refreshAudioDevices() {
    if (!hasDevices) return;
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) { /* ignore */ }
    let unnamed = false;
    const fill = (sel, kind, cur) => {
      const devs = list.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
      sel.innerHTML = '';
      const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
      add('', '既定（システム設定）');
      devs.forEach((d, i) => { if (!d.label) unnamed = true; add(d.deviceId, d.label || `${kind === 'audioinput' ? '入力' : '出力'} ${i + 1}`); });
      if (cur && !devs.some((d) => d.deviceId === cur)) add(cur, '保存済みのデバイス（未接続）');
      sel.value = cur;
    };
    fill($('audioIn'), 'audioinput', S.audioIn);
    if (canSink) fill($('audioOut'), 'audiooutput', S.audioOut);
    $('audioNamesRow').hidden = !unnamed;
  }

  function releaseMic() {
    if (tx.mic) {
      tx.mic.src.disconnect();
      tx.mic.node.disconnect();
      tx.mic.node.port.postMessage({ stop: true });
      tx.mic = null;
    }
    if (tx.stream) { tx.stream.getTracks().forEach((t) => t.stop()); tx.stream = null; }
  }

  async function setAudioIn(id) {
    S.audioIn = id; save();
    const live = !!tx.mic;
    releaseMic();
    if (live) {
      try { await ensureMic(); } catch (e) { toast('マイクを開けません: ' + e.message); }
    }
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
      // Same latency bound as the worklet.
      if (fill > target * 3) { r = (r + fill - target) % cap; fill = target; }
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
    $('btnConnect').textContent = pluto ? 'Disconnect' : 'Connect';
    $('btnConnect').classList.toggle('primary', !pluto);
    $('btnPlay').disabled = !pluto;
    $('btnPlay').classList.toggle('on', state === 'live');
    $('btnPlay').innerHTML = state === 'live' ? '<span class="ic">&#9632;</span> Stop' : '<span class="ic">&#9654;</span> Start';
    $('btnScan').disabled = !pluto;
    $('btnScan').textContent = state === 'sweep' ? 'Stop scan' : 'Start scan';
    $('btnScan').classList.toggle('active', state === 'sweep');
    updateMeter();
    $('loVal').textContent = pluto ? fmtHz(curLo, 6) : '—';
    updateTx();
    txRetune();
  }

  async function connect(interactive) {
    if (!navigator.usb) {
      toast('このブラウザは WebUSB に対応していません。Chrome または Edge で開いてください。');
      return;
    }
    try {
      // The Connect button always shows the device chooser; only the
      // automatic connect at startup reuses an already permitted device.
      let p;
      if (interactive) p = await window.Pluto.request();
      else if (!(p = await window.Pluto.getPaired())) return;
      await p.open();
      pluto = p;
      const serial = p.usb.serialNumber ? ' (' + p.usb.serialNumber.slice(-8) + ')' : '';
      $('devName').textContent = (p.usb.productName || 'PlutoSDR') + serial;
      const lo = await p.getRange(window.Pluto.RX_LO, 'frequency_available').catch(() => null);
      if (lo && lo.min > 300e6) {
        toast(`周波数範囲が ${fmtHz(lo.min, 0)}〜${fmtHz(lo.max, 1)} に制限されています（AD9363 モード）。`, 'info');
      }
      await applySource();
      // Keep the transmitter quiet until PTT (the DDS tone is on at boot).
      await p.txIdle().catch(() => {});
      setStatus();
      toast('Pluto SDR Nano に接続しました', 'info');
      await startLive();
    } catch (e) {
      pluto = null;
      setStatus();
      if (e && e.name === 'NotFoundError') return; // chooser cancelled
      let msg = 'Pluto SDR Nano に接続できません: ' + (e && e.message ? e.message : e);
      if (e && e.name === 'SecurityError') msg += '（このページの読み込み方法では WebUSB が使えません）';
      if (/claim|busy|Unable/i.test(msg)) msg += ' — 他のアプリ（iio_info など）が Pluto SDR Nano を使っていないか確認してください。';
      toast(msg);
    }
  }

  async function disconnect() {
    const p = pluto;
    if (!p) return;
    if (tx.on || tx.want) { tx.keyDown = false; sidetone(false); tx.want = false; await txStopNow(); }
    await stopStream();
    pluto = null;
    clearInterval(rssiTimer);
    await p.close();
    $('devName').textContent = '—';
    $('rssiVal').textContent = '—';
    setStatus();
  }

  let lostReason = '';
  function onDeviceLost(msg) {
    lostReason = msg || '';
    streamToken++;
    tx.want = tx.keyDown = false;
    if (tx.on) { tx.on = false; tx.token++; clearTimeout(tx.tot); sidetone(false); }
    state = 'idle';
    pluto = null;
    clearInterval(rssiTimer);
    $('devName').textContent = '—';
    setStatus();
    workerConfig();
    toast(msg || 'Pluto SDR Nano との接続が切れました');
  }

  if (navigator.usb) {
    navigator.usb.addEventListener('disconnect', (e) => {
      if (pluto && e.device === pluto.usb) onDeviceLost();
    });
  }

  function rfBandwidth() { return S.rfBw || clamp(Math.round(S.sampleRate), 200e3, 56e6); }

  // Writing the sample rate, RF bandwidth or crystal correction makes the
  // AD9361 recalibrate, which briefly drives the transmitter at the TX LO.
  // Only write what actually changes.
  async function applySource() {
    if (!pluto) return;
    await applyPpm();
    const near = (a, b) => Math.abs(a - b) <= 2;
    if (!near(await pluto.getSampleRate().catch(() => 0), S.sampleRate)) await pluto.setSampleRate(S.sampleRate);
    // The driver rounds the RF bandwidth, so compare loosely.
    const bw = rfBandwidth();
    if (Math.abs(await pluto.getBandwidth().catch(() => 0) - bw) > bw * 0.01) await pluto.setBandwidth(bw);
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
      const xo = Math.round(XO_NOMINAL * (1 + S.ppm * 1e-6));
      if (Math.abs(await pluto.getXoCorrection().catch(() => 0) - xo) <= 1) return;
      await pluto.setXoCorrection(xo);
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
        curGain = g;
        updatePanel();
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
    if (S.mode === 'USB') return [f + SSB_LOWCUT, f + SSB_LOWCUT + bw];
    if (S.mode === 'LSB') return [f - SSB_LOWCUT - bw, f - SSB_LOWCUT];
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
      btn.className = 'key';
      btn.disabled = !!b.dummy;
      btn.addEventListener('click', () => selectBand(b));
      el.appendChild(btn);
    }
  }

  // The band containing the VFO (none while scanning), preferring the one
  // last selected.
  function activeBand() {
    const sweeping = state === 'sweep' && !!sweep;
    const ok = (b) => b && !sweeping && S.vfo >= b.lo && S.vfo <= b.hi;
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
    const mem = S.bandMem[b.name] || { f: b.f, mode: b.mode };
    S.mode = mem.mode;
    if (b.snap) mode().snap = b.snap;
    syncControls();
    if (state === 'sweep') {
      // Leaving a wideband scan: go back to live reception in the new band.
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
    txRetune();
    dirty = true;
    save();
  }

  function snap(f) {
    const s = mode().snap || 1;
    return Math.round(f / s) * s;
  }

  // ---------------- frequency display ----------------
  const DIGITS = 10;
  // Seven-segment digits drawn as SVG: segments a..g in a SEG_W x SEG_H box.
  const SEG_W = 56, SEG_H = 80, SEG_T = 9, SEG_G = 1.2;
  const SEGS = (() => {
    const t = SEG_T, h = t / 2, g = SEG_G, pts = (a) => a.map((v) => v.toFixed(1)).join(' ');
    const hz = (y) => pts([h + g, y, t + g, y - h, SEG_W - t - g, y - h, SEG_W - h - g, y,
      SEG_W - t - g, y + h, t + g, y + h]);
    const vt = (x, y0, y1) => pts([x, y0 + g, x + h, y0 + h + g, x + h, y1 - h - g, x, y1 - g,
      x - h, y1 - h - g, x - h, y0 + h + g]);
    const mid = SEG_H / 2, L = h, R = SEG_W - h;
    return [hz(h), vt(R, h, mid), vt(R, mid, SEG_H - h), hz(SEG_H - h), vt(L, mid, SEG_H - h), vt(L, h, mid), hz(mid)];
  })();
  const SEG_ON = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
  const SEG_SVG = `<svg viewBox="0 0 ${SEG_W} ${SEG_H}">` +
    SEGS.map((p) => `<polygon points="${p}"/>`).join('') + '</svg>';
  function buildFreq() {
    const el = $('freq');
    el.innerHTML = '';
    for (let i = DIGITS - 1; i >= 0; i--) {
      const d = document.createElement('span');
      d.className = 'd' + (i < 3 ? ' small' : '');
      d.dataset.k = i;
      d.innerHTML = SEG_SVG;
      el.appendChild(d);
      if (i % 3 === 0 && i > 0) {
        const s = document.createElement('span');
        s.className = 'sep';
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
    let lead = true, i = 0;
    for (const el of $('freq').children) {
      if (el.classList.contains('sep')) { el.classList.toggle('off', lead); continue; }
      const ch = s[i++];
      // Leading zeros stay dark, but always show at least 1 MHz digit.
      if (ch !== '0' || i > DIGITS - 7) lead = false;
      const on = lead ? '' : SEG_ON[+ch];
      el.querySelectorAll('polygon').forEach((p, j) => p.classList.toggle('on', on.includes('abcdefg'[j])));
    }
  }

  // ---------------- S-meter ----------------
  // Channel power in dBm ~ dBFS - RX gain + calibration. S9 = -93 dBm
  // (VHF/UHF convention), 6 dB per S unit; above S9 the scale is in dB.
  const S9_DBM = -93;
  let curGain = S.gain;
  const toDbm = (dbfs) => dbfs - curGain + S.meterCal;
  // Scale position 0..1: S0..S9 fill the left 60 %, S9..+60 dB the rest.
  function meterPos(dbm) {
    if (dbm <= S9_DBM) return clamp((dbm - (S9_DBM - 54)) / 54, 0, 1) * 0.6;
    return 0.6 + clamp((dbm - S9_DBM) / 60, 0, 1) * 0.4;
  }
  function sText(dbm) {
    if (dbm <= S9_DBM) return 'S' + clamp(Math.floor((dbm - S9_DBM + 54) / 6), 0, 9);
    return 'S9+' + Math.round(dbm - S9_DBM);
  }
  const meter = { target: 0, x: 0, v: 0, peak: 0, peakAt: 0, sq: null, key: '', colors: null };

  // While transmitting the meter is a PO (output power) meter, 0..TX_PO_MAX
  // mW, from the I/Q power sent and the TX attenuation. 0 dB with a
  // full-scale DAC is taken as TX_PO_MAX.
  const TX_PO_MAX = 5;
  const poPos = (mw) => clamp(mw / TX_PO_MAX, 0, 1);
  function updateMeter() {
    if (tx.on) {
      const mw = tx.powMw || 0, dbm = 10 * Math.log10(Math.max(mw, 1e-9));
      meter.target = poPos(mw);
      $('meterS').textContent = 'PO';
      $('meterText').textContent = (mw >= 0.1 ? mw.toFixed(2) + ' mW' : (mw * 1000).toFixed(1) + ' µW');
      $('meterText').title = mw > 0 ? dbm.toFixed(1) + ' dBm' : '';
      meter.sq = null;
      return;
    }
    const live = state === 'live' && levelDb > -199;
    const dbm = toDbm(levelDb);
    meter.target = live ? meterPos(dbm) : 0;
    $('meterText').textContent = live ? dbm.toFixed(1) + ' dBm' : '--- dBm';
    $('meterText').title = live ? `${levelDb.toFixed(1)} dBFS · gain ${Math.round(curGain)} dB` : '';
    $('meterS').textContent = live ? sText(dbm) : 'S-';
    $('stereoInd').classList.toggle('on', state === 'live' && S.mode === 'WFM' && stereoLocked);
    meter.sq = S.squelchOn ? meterPos(toDbm(S.squelch)) : null;
  }

  // Needle: slightly under-damped spring; bar: fast attack, slow release
  // with a peak hold.
  function meterTick(dt, now) {
    const p = meter.target;
    if (S.meterStyle === 'needle') {
      meter.v += (160 * (p - meter.x) - 16 * meter.v) * dt;
      meter.x = clamp(meter.x + meter.v * dt, -0.02, 1.03);
    } else {
      meter.x += (p - meter.x) * (1 - Math.exp(-dt / (p > meter.x ? 0.03 : 0.3)));
      meter.v = 0;
    }
    if (meter.x >= meter.peak) { meter.peak = meter.x; meter.peakAt = now; }
    else if (now - meter.peakAt > 1500) meter.peak = Math.max(meter.x, meter.peak - dt * 0.6);
    const key = [S.meterStyle, S.panelTheme, meter.x.toFixed(4), meter.peak.toFixed(3), meter.sq, curGain, S.meterCal, tx.on,
      smeterCanvas.clientWidth, smeterCanvas.clientHeight, dpr].join();
    if (key !== meter.key) { meter.key = key; drawMeter(); }
  }

  const smeterCanvas = $('smeter');
  function fitCanvas(c) {
    const w = c.clientWidth, h = c.clientHeight;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return [ctx, w, h];
  }
  function panelColors() {
    const cs = getComputedStyle($('panel'));
    const g = (n) => cs.getPropertyValue(n).trim();
    return { lcd: g('--lcd'), dim: g('--lcd-dim'), ghost: g('--lcd-ghost'), over: g('--over'), needle: g('--needle') };
  }

  const S_MARKS = [[1, '1'], [3, '3'], [5, '5'], [7, '7'], [9, '9']].map(([n, t]) => [n / 9 * 0.6, t])
    .concat([[20, '+20'], [40, '+40'], [60, '+60']].map(([d, t]) => [0.6 + d / 60 * 0.4, t]));
  const DBM_MARKS = [-140, -120, -100, -80, -60, -40];

  function drawMeter() {
    const [ctx, w, h] = fitCanvas(smeterCanvas);
    if (!w || !h) return;
    const c = meter.colors || (meter.colors = panelColors());
    const font = (px, wgt = 600) => `${wgt} ${px}px "Helvetica Neue", Arial, sans-serif`;
    const tick = (x0, y0, x1, y1) => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (S.meterStyle === 'needle') {
      // IC-7300 style analog meter on the LCD: one needle over stacked
      // scales (S units, dBm, and dBFS at the current gain).
      const ink = '#eef0f4', blue = '#7f86ff', needleCol = '#f05a28';
      const ital = (px, wgt = 600) => `italic ${wgt} ${px}px "Helvetica Neue", Arial, sans-serif`;
      const cx = w / 2, cy = h * 2.3, R1 = cy - 30, A = Math.asin((w * 0.39) / R1);
      const ang = (p) => -Math.PI / 2 - A + p * 2 * A;
      const pt = (p, r) => [cx + Math.cos(ang(p)) * r, cy + Math.sin(ang(p)) * r];
      // Title plate.
      const tw = 62;
      const tg = ctx.createLinearGradient(0, 0, 0, 11);
      tg.addColorStop(0, '#4b55d8'); tg.addColorStop(1, '#2a2f8a');
      ctx.fillStyle = tg;
      ctx.fillRect(cx - tw / 2, 0, tw, 11);
      ctx.font = `700 8px "Helvetica Neue", Arial, sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.letterSpacing = '1px';
      ctx.fillText(tx.on ? 'PO METER' : 'S METER', cx, 6);
      ctx.letterSpacing = '0px';
      // Draws one arc with ticks; marks = [[pos, label, major, colour]].
      const scale = (R, marks, split) => {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = ink;
        ctx.beginPath(); ctx.arc(cx, cy, R, ang(0), ang(split ?? 1)); ctx.stroke();
        if (split != null) {
          ctx.strokeStyle = blue;
          ctx.lineWidth = 2.4;
          ctx.beginPath(); ctx.arc(cx, cy, R + 0.6, ang(split), ang(1)); ctx.stroke();
        }
        for (const [p, t, major, col] of marks) {
          if (p < -0.001 || p > 1.001) continue;
          ctx.strokeStyle = ctx.fillStyle = col || ink;
          ctx.lineWidth = major ? 1.3 : 0.9;
          tick(...pt(p, R), ...pt(p, R + (major ? 5 : 3)));
          if (t) ctx.fillText(t, ...pt(p, R + 11));
        }
      };
      if (tx.on) {
        // PO: mW (linear) over dBm.
        ctx.font = ital(10.5, 700);
        const pMarks = [];
        for (let i = 0; i <= 10; i++) pMarks.push([i / 10, i % 2 ? '' : String(i / 2), i % 2 === 0]);
        scale(R1, pMarks);
        ctx.font = ital(12, 800);
        ctx.fillStyle = ink;
        ctx.fillText('PO', ...pt(-0.08, R1 + 6));
        ctx.font = ital(8, 700);
        ctx.fillText('mW', ...pt(1.0, R1 + 21));
        const R2 = R1 - 25;
        ctx.font = ital(8.5, 600);
        // -10 / -5 dBm crowd the left end: ticks only.
        const dMarks = [-10, -5, 0, 3, 5, 7].map((d) => [poPos(10 ** (d / 10)), d < 0 ? '' : (d > 0 ? '+' : '') + d, d >= 0]);
        scale(R2, dMarks);
        ctx.font = ital(8, 800);
        ctx.textAlign = 'right';
        ctx.fillText('dBm', ...pt(-0.01, R2 + 1).map((v, i) => v - (i ? 0 : 3)));
        ctx.textAlign = 'center';
      } else {
      // S scale.
      ctx.font = ital(10.5, 700);
      const sMarks = [];
      for (let n = 0; n <= 9; n++) sMarks.push([n / 9 * 0.6, n % 2 ? String(n) : '', n % 2 === 1]);
      for (let d = 10; d <= 60; d += 10) sMarks.push([0.6 + d / 150, d % 20 ? '' : '+' + d, d % 20 === 0, blue]);
      scale(R1, sMarks, 0.6);
      ctx.font = ital(15, 800);
      ctx.fillStyle = ink;
      ctx.fillText('S', ...pt(-0.07, R1 + 6));
      ctx.font = ital(8, 700);
      ctx.fillStyle = blue;
      ctx.fillText('dB', ...pt(1.0, R1 + 21));
      // dBm scale.
      const R2 = R1 - 25;
      ctx.font = ital(8.5, 600);
      const mMarks = [];
      for (let d = -140; d <= -30; d += 10) mMarks.push([meterPos(d), d % 20 ? '' : String(d), d % 20 === 0]);
      scale(R2, mMarks);
      ctx.font = ital(8, 800);
      ctx.fillStyle = ink;
      ctx.textAlign = 'right';
      ctx.fillText('dBm', ...pt(-0.01, R2 + 1).map((v, i) => v - (i ? 0 : 3)));
      // dBFS scale, which moves with the RX gain.
      const R3 = R2 - 25;
      ctx.textAlign = 'center';
      ctx.font = ital(8.5, 600);
      const fMarks = [];
      for (let d = -160; d <= 0; d += 10) {
        // Only where the dBFS value lies on the S scale's range.
        const m = toDbm(d);
        if (m >= S9_DBM - 54 && m <= S9_DBM + 60) fMarks.push([meterPos(m), d % 20 ? '' : String(d), d % 20 === 0]);
      }
      scale(R3, fMarks);
      ctx.font = ital(8, 800);
      ctx.fillStyle = ink;
      ctx.textAlign = 'right';
      ctx.fillText('FS', ...pt(-0.01, R3 + 1).map((v, i) => v - (i ? 0 : 3)));
      ctx.textAlign = 'center';
      if (meter.sq !== null) {
        ctx.fillStyle = blue;
        ctx.beginPath(); ctx.arc(...pt(meter.sq, R1 - 4), 2, 0, 2 * Math.PI); ctx.fill();
      }
      }
      // Needle from below the window, with a faint glow.
      const t = ang(meter.x), ux = Math.cos(t), uy = Math.sin(t);
      const r0 = cy - h - 2, r1 = R1 + 7;
      ctx.strokeStyle = ctx.shadowColor = needleCol;
      ctx.shadowBlur = 3;
      ctx.lineWidth = 2;
      tick(cx + ux * r0, cy + uy * r0, cx + ux * r1, cy + uy * r1);
      ctx.shadowBlur = 0;
      return;
    }
    // LCD bar meter: scale with tick rail above a fine segmented bar.
    const mono = (px, wgt = 600) => `${wgt} ${px}px ui-monospace, Menlo, monospace`;
    const x0 = 16, bw = w - 34, rail = h * 0.42, by = rail + 7, bh = Math.round(h * 0.26), N = 48;
    const sw = bw / N;
    if (tx.on) {
      ctx.font = mono(9, 700);
      ctx.fillStyle = c.over;
      ctx.fillText('PO', 8, rail - 12);
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.lcd;
      tick(x0, rail, x0 + bw, rail);
      for (let i = 0; i <= 10; i++) {
        const x = x0 + i / 10 * bw;
        tick(x, rail, x, rail - (i % 2 ? 3 : 5));
        if (i % 2 === 0) { ctx.font = mono(10, 700); ctx.fillStyle = c.lcd; ctx.fillText(String(i / 2), x, rail - 13); }
      }
      const lit = meter.x * N, pk = Math.min(N - 1, Math.floor(meter.peak * N));
      for (let i = 0; i < N; i++) {
        const on = i + 0.5 <= lit || (i === pk && meter.peak > 0.01);
        ctx.fillStyle = on ? c.over : c.ghost;
        ctx.fillRect(x0 + i * sw + 0.75, by, sw - 1.5, bh);
      }
      return;
    }
    ctx.font = mono(11, 700);
    ctx.fillStyle = c.lcd;
    ctx.fillText('S', 7, rail - 12);
    ctx.lineWidth = 1;
    ctx.strokeStyle = c.lcd;
    tick(x0, rail, x0 + bw * 0.6, rail);
    ctx.strokeStyle = c.over;
    tick(x0 + bw * 0.6, rail, x0 + bw, rail);
    for (let n = 1; n <= 9; n++) {
      const x = x0 + n / 9 * 0.6 * bw;
      ctx.strokeStyle = c.lcd;
      tick(x, rail, x, rail - (n % 2 ? 5 : 3));
    }
    for (let d = 10; d <= 60; d += 10) {
      const x = x0 + (0.6 + d / 150) * bw;
      ctx.strokeStyle = c.over;
      tick(x, rail, x, rail - (d % 20 ? 3 : 5));
    }
    for (const [p, t] of S_MARKS) {
      ctx.font = p > 0.6 ? mono(9.5, 600) : mono(11, 700);
      ctx.fillStyle = p > 0.6 ? c.over : c.lcd;
      ctx.fillText(t, x0 + p * bw, rail - 13);
    }
    const lit = meter.x * N, pk = Math.min(N - 1, Math.floor(meter.peak * N));
    for (let i = 0; i < N; i++) {
      const over = (i + 0.5) / N > 0.6;
      const on = i + 0.5 <= lit || (i === pk && meter.peak > 0.01);
      ctx.fillStyle = on ? (over ? c.over : c.lcd) : c.ghost;
      ctx.fillRect(x0 + i * sw + 0.75, by, sw - 1.5, bh);
    }
    if (meter.sq !== null) {
      const x = x0 + meter.sq * bw;
      ctx.fillStyle = c.dim;
      ctx.beginPath(); ctx.moveTo(x, by + bh + 2); ctx.lineTo(x - 4, by + bh + 8); ctx.lineTo(x + 4, by + bh + 8); ctx.fill();
    }
  }

  // ---------------- main dial ----------------
  // 50 detents per turn; clockwise tunes up. A fast flick keeps spinning
  // with friction, and AUTO multiplies the step by 10 when turned fast.
  const DETENTS = 50, DETENT = 2 * Math.PI / DETENTS;
  const dialCanvas = $('dial');
  const dial = { angle: -Math.PI / 2, acc: 0, v: 0, fly: false, grab: null, total: 0, samples: [], key: '' };

  function tuneBy(n, speed) {
    if (state === 'sweep' || !n) return;
    const step = mode().snap || 1000;
    setVfo(snap(S.vfo) + n * step * (S.autoTs && speed > 40 ? 10 : 1));
  }
  function dialRotate(d, speed) {
    dial.angle = (dial.angle + d) % (2 * Math.PI);
    dial.acc += d / DETENT;
    const n = Math.trunc(dial.acc);
    dial.acc -= n;
    tuneBy(n, speed);
  }
  function dialTick(dt) {
    if (dial.fly) {
      dialRotate(dial.v * dt, Math.abs(dial.v) / DETENT);
      dial.v *= Math.exp(-dt * 1.6);
      if (Math.abs(dial.v) < 0.5) dial.fly = false;
    }
    const key = [dial.angle.toFixed(4), dialCanvas.clientWidth, dpr].join();
    if (key !== dial.key) { dial.key = key; drawDial(); }
    for (const k of knobs) {
      const kk = [k.get().toFixed(4), S.panelTheme, k.canvas.clientWidth, dpr].join();
      if (kk !== k.key) { k.key = kk; drawKnob(k); }
    }
  }

  // ---------------- audio scope ----------------
  // Spectrum of the demodulated audio in the frequency LCD, with the
  // filter passband shaded.
  const scopeCanvas = $('afScope');
  const scope = { last: 0, key: '', buf: null };

  // Audio passband [lo, hi] in Hz and the span shown for the current mode.
  function audioPassband() {
    const bw = mode().bandwidth;
    switch (S.mode) {
      case 'USB': case 'LSB': return { lo: SSB_LOWCUT, hi: SSB_LOWCUT + bw, span: Math.max(4000, SSB_LOWCUT + bw + 500) };
      case 'CW': return { lo: Math.max(0, CW_PITCH - bw / 2), hi: CW_PITCH + bw / 2, span: Math.max(2000, CW_PITCH + bw / 2 + 300) };
      case 'WFM': return { lo: 0, hi: 15e3, span: 16e3 };
      case 'NFM': return { lo: 0, hi: Math.min(bw / 2, 8e3), span: Math.min(bw / 2, 8e3) * 1.25 };
      default: return { lo: 0, hi: bw / 2, span: bw / 2 * 1.25 };
    }
  }

  function scopeTick(now) {
    const micOn = tx.on && !!tx.mic && S.mode !== 'CW';
    const live = !!audio && (state === 'live' || micOn);
    const pb = audioPassband();
    const key = [S.mode, mode().bandwidth, S.panelTheme, scopeCanvas.clientWidth, scopeCanvas.clientHeight, dpr, live, micOn].join();
    if (live ? now - scope.last < 33 : key === scope.key) return;
    scope.last = now;
    scope.key = key;
    const [ctx, w, h] = fitCanvas(scopeCanvas);
    if (!w || !h) return;
    const c = meter.colors || (meter.colors = panelColors());
    const axisH = 11, ph = h - axisH;
    const xOf = (f) => (f / pb.span) * w;
    // Passband.
    const xa = xOf(pb.lo), xb = Math.min(w, xOf(pb.hi));
    ctx.fillStyle = c.ghost;
    ctx.fillRect(xa, 0, xb - xa, ph);
    ctx.strokeStyle = c.dim;
    ctx.lineWidth = 1;
    for (const x of [xa, xb]) {
      if (x <= 0.5 || x >= w - 0.5) continue;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, ph); ctx.stroke();
    }
    // Frequency ticks.
    const step = niceStep(pb.span, 4);
    ctx.font = '600 9px ui-monospace, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = c.dim;
    ctx.strokeStyle = c.ghost;
    for (let f = 0; f <= pb.span; f += step) {
      const x = Math.round(xOf(f)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, ph); ctx.lineTo(x, ph + 3); ctx.stroke();
      ctx.textAlign = f === 0 ? 'left' : 'center';
      if (x < w - 10) ctx.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), f === 0 ? 0 : x, ph + 2);
    }
    ctx.strokeStyle = c.dim;
    ctx.beginPath(); ctx.moveTo(0, ph + 0.5); ctx.lineTo(w, ph + 0.5); ctx.stroke();
    if (!live) return;
    // Spectrum, -100..-20 dBFS.
    const an = micOn ? tx.mic.analyser : audio.analyser;
    if (!scope.buf || scope.buf.length !== an.frequencyBinCount) scope.buf = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(scope.buf);
    const binHz = audio.ctx.sampleRate / an.fftSize;
    ctx.beginPath();
    ctx.moveTo(0, ph);
    for (let x = 0; x <= w; x++) {
      // Peak of the bins under this pixel.
      const b0 = Math.floor(x / w * pb.span / binHz), b1 = Math.max(b0 + 1, Math.floor((x + 1) / w * pb.span / binHz));
      let db = -200;
      for (let b = b0; b < b1 && b < scope.buf.length; b++) db = Math.max(db, scope.buf[b]);
      ctx.lineTo(x, ph * (1 - clamp((db + 100) / 80, 0, 1)));
    }
    ctx.lineTo(w, ph);
    ctx.closePath();
    ctx.fillStyle = c.dim;
    ctx.fill();
  }

  // ---------------- transmit ----------------
  // Japanese amateur bands within the Pluto SDR Nano's range. TX is allowed only when
  // the whole emission (txEdges) lies inside one of them.
  const TX_BANDS = [[144e6, 146e6], [430e6, 440e6], [1260e6, 1300e6], [2400e6, 2450e6], [5650e6, 5850e6]];
  const TX_MODES = ['NFM', 'AM', 'USB', 'LSB', 'CW'];
  const TX_TOT = 180e3;      // time-out timer
  const CW_HANG = 800;       // semi break-in: stay on the air this long after the key opens
  const TX_KERNEL_BUFFERS = 4;
  // The receiver removes DC, so with its LO on the VFO our own carrier
  // vanishes from the display. While transmitting keep the LO this far away.
  const TX_MON_OFFSET = 200e3;
  const txWorker = new Worker(blobUrl('txworker-src'));
  const tx = {
    on: false, want: false, busy: false, token: 0, loop: null, tot: 0, hang: 0,
    mic: null, stream: null, side: null, keyDown: false, reqId: 0, pending: new Map(),
  };
  txWorker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'block') { const r = tx.pending.get(m.id); tx.pending.delete(m.id); if (r) r(m.iq); }
  };

  function txEdges(f = S.vfo) {
    const bw = mode().bandwidth;
    switch (S.mode) {
      case 'NFM': return [f - 8e3, f + 8e3];
      case 'AM': return [f - 3e3, f + 3e3];
      case 'USB': return [f, f + SSB_LOWCUT + bw];
      case 'LSB': return [f - SSB_LOWCUT - bw, f];
      case 'CW': return [f - 250, f + 250];
      default: return null;
    }
  }

  // Why TX is not possible right now, or '' when it is.
  function txBlocked() {
    if (!pluto) return 'Pluto SDR Nano が接続されていません';
    if (!pluto.canTx) return 'この Pluto SDR Nano では送信できません';
    if (!S.txEnabled) return '送信が無効です（サイドバーの Transmit で有効にしてください）';
    if (!TX_MODES.includes(S.mode)) return `${S.mode} では送信できません`;
    if (state === 'sweep') return 'スキャン中は送信できません';
    const [a, b] = txEdges();
    if (!TX_BANDS.some(([lo, hi]) => a >= lo && b <= hi)) return 'アマチュアバンド外のため送信できません';
    return '';
  }

  // Modulator rate: fs / L close to the 48 kHz audio rate.
  function txRates() {
    const fs = S.sampleRate, L = Math.max(1, Math.round(fs / 48000));
    return { fs, L, r: fs / L, m: Math.round(fs / L * 0.01) };
  }

  async function ensureMic() {
    if (!tx.stream) {
      const audioOpts = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
      if (S.audioIn) {
        try {
          tx.stream = await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: S.audioIn } }, audioOpts) });
        } catch (e) {
          if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
          toast('選択した入力デバイスが見つかりません。既定の入力を使います', 'info');
        }
      }
      if (!tx.stream) tx.stream = await navigator.mediaDevices.getUserMedia({ audio: audioOpts });
      refreshAudioDevices();
    }
    if (tx.mic) return;
    if (!audio.ctx.hasWorklet) throw new Error('AudioWorklet が使えません');
    const ctx = audio.ctx;
    const src = ctx.createMediaStreamSource(tx.stream);
    const node = new AudioWorkletNode(ctx, 'pluto-mic', { numberOfInputs: 1, numberOfOutputs: 1 });
    // A silent path to the output keeps the node processing.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink).connect(ctx.destination);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.6;
    src.connect(node);
    src.connect(analyser);
    const ch = new MessageChannel();
    node.port.postMessage({ port: ch.port1 }, [ch.port1]);
    txWorker.postMessage({ type: 'micPort', port: ch.port2 }, [ch.port2]);
    tx.mic = { node, analyser, src };
  }

  // CW sidetone at the receive pitch, gated with a short ramp.
  function sidetone(on) {
    if (!audio) return;
    const ctx = audio.ctx;
    if (!tx.side) {
      const osc = ctx.createOscillator();
      osc.frequency.value = CW_PITCH;
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g).connect(ctx.destination);
      osc.start();
      tx.side = g;
    }
    tx.side.gain.setTargetAtTime(on ? 0.15 * S.volume : 0, ctx.currentTime, 0.003);
  }

  function txBlock() {
    return new Promise((resolve) => {
      const id = ++tx.reqId;
      tx.pending.set(id, resolve);
      txWorker.postMessage({ type: 'block', id, m: txRates().m });
    });
  }

  async function txStartNow() {
    const why = txBlocked();
    if (why) { toast(why); return false; }
    await ensureAudio();
    if (S.mode !== 'CW') await ensureMic();
    const { fs, L, m } = txRates();
    txWorker.postMessage({
      type: 'config',
      cfg: { fs, L, mode: S.mode, bandwidth: mode().bandwidth, micGain: 10 ** (S.micGain / 20), inRate: audio.ctx.sampleRate },
    });
    // Report a device lost mid-way instead of failing on a null device.
    const p = pluto;
    const step = async (name, fn) => {
      try { await fn(); } catch (e) { throw new Error(`${name}: ${e.message}`); }
      if (pluto !== p) throw new Error(`送信開始中に Pluto SDR Nano が切断されました（${name}${lostReason ? ' / ' + lostReason : ''}）`);
    };
    await step('TX LO', () => p.setTxFrequency(S.vfo));
    await step('TX level', () => p.setTxAttenuation(S.txAtten));
    await step('buffers', () => p.setKernelBuffers(TX_KERNEL_BUFFERS, p.txDev));
    await step('open TX', () => p.startTx(m * L));
    const token = ++tx.token;
    tx.on = true;
    tx.mode = S.mode; tx.bw = mode().bandwidth;
    keepTxVisible();
    audio.gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.01);
    tx.tot = setTimeout(() => { toast('タイムアウト（3 分）で送信を止めました', 'info'); txKey(false, true); }, TX_TOT);
    updateTx();
    tx.stats = { blocks: 0, peak: 0, t0: performance.now() };
    $('txStat').textContent = '開始…';
    tx.loop = (async () => {
      let next = txBlock();
      while (token === tx.token) {
        const iq = await next;
        if (token !== tx.token || !iq) break;
        next = txBlock();
        try {
          await pluto.writeTx(iq);
          // Status: blocks written, peak level, effective rate.
          const st = tx.stats;
          let pk = 0, pw = 0;
          for (let i = 0; i + 1 < iq.length; i += 14) {
            const a = Math.abs(iq[i]); if (a > pk) pk = a;
            pw += iq[i] * iq[i] + iq[i + 1] * iq[i + 1];
          }
          st.peak = Math.max(st.peak * 0.9, pk);
          // Mean power of this block relative to a full-scale carrier.
          const rel = pw / Math.ceil(iq.length / 14) / (32752 * 32752);
          const mw = TX_PO_MAX * 10 ** (S.txAtten / 10) * rel;
          tx.powMw = mw > (tx.powMw || 0) ? mw : tx.powMw * 0.85 + mw * 0.15;
          if (st.blocks % 3 === 0) updateMeter();
          if (++st.blocks % 10 === 0) {
            const sec = (performance.now() - st.t0) / 1000;
            const rate = st.blocks * iq.length / 2 / sec / 1e6;
            $('txStat').textContent = `${st.blocks} blk · peak ${(st.peak / 327.67).toFixed(0)}% · ${rate.toFixed(2)} MSPS`;
          }
        } catch (e) {
          if (token === tx.token) { toast('送信エラー: ' + e.message); tx.want = false; txKick(); }
          break;
        }
      }
    })();
    return true;
  }

  async function txStopNow() {
    tx.on = false;
    tx.powMw = 0;
    tx.token++;
    clearTimeout(tx.tot);
    txWorker.postMessage({ type: 'stop' });
    if (audio) audio.gain.gain.setTargetAtTime(S.volume ** 2, audio.ctx.currentTime, 0.02);
    updateTx();
    await tx.loop;
    if (pluto) {
      try { await pluto.stopTx(); } catch (e) { /* ignore */ }
      try { await pluto.txIdle(); } catch (e) { /* ignore */ }
    }
  }

  // Brings the transmitter in line with tx.want, one transition at a time.
  async function txKick() {
    if (tx.busy) return;
    tx.busy = true;
    try {
      while (tx.want !== tx.on) {
        if (tx.want) {
          let ok = false;
          try { ok = await txStartNow(); } catch (e) { toast(/切断/.test(e.message) ? e.message : '送信できません: ' + e.message); }
          if (!ok) { tx.want = false; if (pluto && pluto.tx) await txStopNow(); }
        } else {
          await txStopNow();
        }
      }
    } finally {
      tx.busy = false;
      updateTx();
    }
  }

  // PTT / CW key. In CW the key is passed to the modulator with its timing
  // and the transmitter drops out CW_HANG ms after the last key-up.
  function txKey(down, force) {
    if (down) {
      const why = txBlocked();
      if (why) { toast(why); return; }
    }
    if (tx.keyDown === down && !force) return;
    tx.keyDown = down;
    if (S.mode === 'CW' && !force) {
      clearTimeout(tx.hang);
      if (down && !tx.on && !tx.want) txWorker.postMessage({ type: 'stop' }); // fresh key timeline
      txWorker.postMessage({ type: 'key', down, t: performance.now() });
      sidetone(down);
      if (down) { tx.want = true; txKick(); }
      else tx.hang = setTimeout(() => { if (!tx.keyDown) { tx.want = false; txKick(); } }, CW_HANG);
    } else {
      sidetone(false);
      clearTimeout(tx.hang);
      tx.want = down;
      txKick();
    }
    updateTx();
  }

  // Called after anything that changes frequency, mode or filter.
  function txRetune() {
    if (!tx.on && !tx.want) return;
    const why = txBlocked();
    if (why || (tx.on && (S.mode !== tx.mode || mode().bandwidth !== tx.bw))) {
      if (why) toast(why);
      tx.keyDown = false;
      sidetone(false);
      tx.want = false;
      txKick();
    } else if (tx.on && pluto) {
      pluto.setTxFrequency(S.vfo).catch(() => {});
      keepTxVisible();
    }
  }

  function keepTxVisible() {
    if (!tx.on || state !== 'live') return;
    if (Math.abs(S.vfo - S.lo) < TX_MON_OFFSET / 2) setLo(S.vfo + TX_MON_OFFSET);
  }

  function updateTx() {
    if (tx.meterOn !== tx.on) { tx.meterOn = tx.on; meter.peak = 0; updateMeter(); }
    $('txInd').classList.toggle('on', tx.on);
    $('btnPtt').classList.toggle('on', tx.on || tx.keyDown);
    $('btnPtt').disabled = !pluto || !S.txEnabled;
    $('btnPtt').textContent = S.mode === 'CW' ? 'KEY' : 'PTT';
    dial.key = '';
  }

  function setTxEnabled(on) {
    if (on && !S.txLicenseOk) {
      on = confirm('送信機能を有効にします。\n\n' +
        '・アマチュア無線局の免許を受け、この Pluto SDR Nano を無線設備として登録した局だけが送信できます。\n' +
        '・スプリアス対策のフィルタ（LPF / BPF）を必ず入れてください。\n' +
        '・アプリの制限（アマチュアバンド内のみ）は誤送信を防ぐ補助で、法令への適合を保証するものではありません。\n\n' +
        '上記を理解し、法令を守って運用しますか？');
      if (on) S.txLicenseOk = true;
    }
    S.txEnabled = on;
    $('txEnabled').checked = on;
    if (!on) { tx.keyDown = false; sidetone(false); tx.want = false; txKick(); }
    updateTx();
    save();
  }

  function bindTx() {
    $('txEnabled').addEventListener('change', (e) => setTxEnabled(e.target.checked));
    $('txAtten').addEventListener('input', (e) => {
      S.txAtten = +e.target.value;
      $('txAttenVal').textContent = S.txAtten.toFixed(2).replace(/\.?0+$/, '') + ' dB';
      if (tx.on && pluto) pluto.setTxAttenuation(S.txAtten).catch(() => {});
      save();
    });
    $('micGain').addEventListener('input', (e) => {
      S.micGain = +e.target.value;
      $('micGainVal').textContent = S.micGain + ' dB';
      txWorker.postMessage({ type: 'gain', gain: 10 ** (S.micGain / 20) });
      save();
    });
    const ptt = $('btnPtt');
    ptt.addEventListener('pointerdown', (e) => { e.preventDefault(); ptt.setPointerCapture(e.pointerId); txKey(true); });
    const up = () => { if (tx.keyDown) txKey(false); };
    ptt.addEventListener('pointerup', up);
    ptt.addEventListener('pointercancel', up);
    // Never keep transmitting when the window loses focus.
    window.addEventListener('blur', () => { if (tx.keyDown || tx.want) txKey(false, true); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && (tx.keyDown || tx.want)) txKey(false, true); });
    $('txEnabled').checked = S.txEnabled;
    $('txAtten').value = S.txAtten;
    $('txAttenVal').textContent = S.txAtten + ' dB';
    $('micGain').value = S.micGain;
    $('micGainVal').textContent = S.micGain + ' dB';
    updateTx();
  }

  // ---------------- AF / SQL knobs ----------------
  // Value 0..1 over a 270 degree sweep; drag up/down or use the wheel.
  const knobs = [];
  const knobAngle = (v) => 0.75 * Math.PI + v * 1.5 * Math.PI;
  function makeKnob(canvas, label, name, get, set, fmt) {
    const k = { canvas, get, key: '' };
    let y0 = null, v0 = 0;
    const show = (on) => { $(label).textContent = on ? fmt() : name; };
    const apply = (v) => { set(clamp(v, 0, 1)); show(true); };
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      y0 = e.clientY; v0 = get();
      show(true);
    });
    canvas.addEventListener('pointermove', (e) => { if (y0 !== null) apply(v0 + (y0 - e.clientY) / 150); });
    const up = () => { y0 = null; show(false); };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    let wheelTimer = 0;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      apply(get() - e.deltaY * (e.deltaMode === 1 ? 33 : 1) * 0.0004);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => show(false), 800);
    }, { passive: false });
    knobs.push(k);
  }

  function drawKnob(k) {
    const [ctx, w, h] = fitCanvas(k.canvas);
    if (!w || !h) return;
    const c = meter.colors || (meter.colors = panelColors());
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 7, v = k.get(), a = knobAngle(v);
    // Value arc around the knob.
    ctx.lineWidth = 3;
    ctx.strokeStyle = c.ghost;
    ctx.beginPath(); ctx.arc(cx, cy, R + 4.5, knobAngle(0), knobAngle(1)); ctx.stroke();
    if (v > 0.001) {
      ctx.strokeStyle = c.lcd;
      ctx.shadowColor = c.lcd; ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.arc(cx, cy, R + 4.5, knobAngle(0), a); ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.arc(cx + 0.5, cy + 1.5, R, 0, 2 * Math.PI); ctx.fill();
    const g = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
    g.addColorStop(0, '#55555d'); g.addColorStop(1, '#141417');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill();
    ctx.lineWidth = 1;
    for (let i = 0; i < 28; i++) {
      const t = a + i * 2 * Math.PI / 28, co = Math.cos(t), si = Math.sin(t);
      ctx.strokeStyle = `rgba(255,255,255,${(0.06 + 0.12 * Math.max(0, -(co + si) / Math.SQRT2)).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(cx + co * R * 0.8, cy + si * R * 0.8); ctx.lineTo(cx + co * R * 0.98, cy + si * R * 0.98); ctx.stroke();
    }
    ctx.strokeStyle = '#f0f0f4';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * R * 0.2, cy + Math.sin(a) * R * 0.2); ctx.lineTo(cx + Math.cos(a) * R * 0.72, cy + Math.sin(a) * R * 0.72); ctx.stroke();
    ctx.lineCap = 'butt';
  }

  function setVolume(v) {
    S.volume = v;
    if (audio && !tx.on) audio.gain.gain.setTargetAtTime(S.volume ** 2, audio.ctx.currentTime, 0.02);
    save();
  }

  // SQL knob: the bottom 3 % is OFF, the rest maps to -120..0 dBFS.
  const SQL_OFF = 0.03;
  function setSquelchKnob(v) {
    S.squelchOn = v >= SQL_OFF;
    if (S.squelchOn) S.squelch = Math.round(-120 + (v - SQL_OFF) / (1 - SQL_OFF) * 120);
    $('squelchOn').checked = S.squelchOn;
    $('squelch').value = S.squelch;
    $('squelchVal').textContent = S.squelch;
    workerConfig(); updateMeter(); updatePanel(); save();
  }

  function bindKnobs() {
    makeKnob($('afKnob'), 'afLbl', 'AF', () => S.volume, setVolume, () => Math.round(S.volume * 100) + '%');
    makeKnob($('sqlKnob'), 'sqlLbl', 'SQL',
      () => (S.squelchOn ? SQL_OFF + (S.squelch + 120) / 120 * (1 - SQL_OFF) : 0),
      setSquelchKnob, () => (S.squelchOn ? S.squelch + 'dB' : 'OFF'));
  }

  function drawDial() {
    const [ctx, w, h] = fitCanvas(dialCanvas);
    if (!w || !h) return;
    const cx = w / 2, cy = h / 2, Rb = Math.min(w, h) / 2 - 1, R = Rb - 9, a = dial.angle;
    // Recessed bezel around the knob.
    let g = ctx.createRadialGradient(cx, cy, R, cx, cy, Rb);
    g.addColorStop(0, '#040405'); g.addColorStop(0.7, '#141417'); g.addColorStop(1, '#2a2a30');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, Rb, 0, 2 * Math.PI); ctx.fill();
    // LED arcs on the left and right: blue, red while transmitting.
    ctx.lineCap = 'round';
    for (const side of [0, Math.PI]) {
      const led = tx.on ? '#ff3b30' : '#2f7dff';
      ctx.strokeStyle = led;
      ctx.shadowColor = led; ctx.shadowBlur = 9;
      ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(cx, cy, R + 4.5, side - 0.7, side + 0.7); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = tx.on ? 'rgba(255,215,205,0.85)' : 'rgba(200,225,255,0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(cx, cy, R + 4.5, side - 0.62, side + 0.62); ctx.stroke();
    }
    ctx.lineCap = 'butt';
    // Drop shadow and rubber skirt.
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath(); ctx.arc(cx + 1, cy + 2, R, 0, 2 * Math.PI); ctx.fill();
    g = ctx.createRadialGradient(cx, cy, R * 0.7, cx, cy, R);
    g.addColorStop(0, '#26262b'); g.addColorStop(1, '#0b0b0d');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill();
    // Fine knurling turns with the knob; ridges facing the top-left light are brighter.
    ctx.lineWidth = 1;
    for (let i = 0; i < 120; i++) {
      const t = a + i * 2 * Math.PI / 120, c = Math.cos(t), s = Math.sin(t);
      const lit = 0.05 + 0.14 * Math.max(0, -(c + s) / Math.SQRT2);
      ctx.strokeStyle = `rgba(255,255,255,${lit.toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(cx + c * R * 0.82, cy + s * R * 0.82); ctx.lineTo(cx + c * R * 0.98, cy + s * R * 0.98); ctx.stroke();
    }
    // Polished chamfer between skirt and face.
    const Rf = R * 0.76;
    g = ctx.createLinearGradient(cx - Rf, cy - Rf, cx + Rf, cy + Rf);
    g.addColorStop(0, '#8a8a94'); g.addColorStop(0.5, '#1a1a1e'); g.addColorStop(1, '#5a5a62');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.8, 0, 2 * Math.PI); ctx.fill();
    // Spun-metal face: conic sheen fixed to the light, fine concentric grooves.
    g = ctx.createConicGradient(-Math.PI / 4, cx, cy);
    const metal = ['#9a9aa4', '#26262b', '#6e6e78', '#1c1c20', '#9a9aa4', '#26262b', '#6e6e78', '#1c1c20', '#9a9aa4'];
    metal.forEach((col, i) => g.addColorStop(i / (metal.length - 1), col));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, Rf, 0, 2 * Math.PI); ctx.fill();
    ctx.lineWidth = 0.6;
    for (let r = 2, i = 0; r < Rf; r += 1.6, i++) {
      ctx.strokeStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.12)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
    }
    // Glossy black finger dimple: concave, so its lower-right wall catches the light.
    const dr = R * 0.2, dx = cx + Math.cos(a) * R * 0.48, dy = cy + Math.sin(a) * R * 0.48;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.arc(dx, dy, dr + 1.5, 0, 2 * Math.PI); ctx.fill();
    g = ctx.createRadialGradient(dx - dr * 0.3, dy - dr * 0.3, dr * 0.1, dx, dy, dr);
    g.addColorStop(0, '#050506'); g.addColorStop(0.75, '#1c1c21'); g.addColorStop(1, '#5c5c66');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(dx, dy, dr, 0, 2 * Math.PI); ctx.fill();
    g = ctx.createRadialGradient(dx + dr * 0.25, dy + dr * 0.3, 0, dx + dr * 0.25, dy + dr * 0.3, dr * 0.45);
    g.addColorStop(0, 'rgba(255,255,255,0.28)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(dx, dy, dr, 0, 2 * Math.PI); ctx.fill();
  }

  function bindDial() {
    const angleOf = (e) => {
      const r = dialCanvas.getBoundingClientRect();
      const x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
      return { a: Math.atan2(y, x), dist: Math.hypot(x, y) };
    };
    dialCanvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dialCanvas.setPointerCapture(e.pointerId);
      dial.fly = false;
      dial.grab = angleOf(e).a;
      dial.total = 0;
      dial.samples = [{ t: performance.now(), a: 0 }];
    });
    dialCanvas.addEventListener('pointermove', (e) => {
      if (dial.grab === null) return;
      const { a, dist } = angleOf(e);
      let d = a - dial.grab;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      dial.grab = a;
      if (dist < 8) return; // the angle is unstable near the centre
      const now = performance.now();
      dial.total += d;
      dial.samples.push({ t: now, a: dial.total });
      while (dial.samples.length > 2 && now - dial.samples[0].t > 100) dial.samples.shift();
      const s0 = dial.samples[0], dt = (now - s0.t) / 1000;
      dialRotate(d, dt > 0 ? Math.abs(dial.total - s0.a) / dt / DETENT : 0);
    });
    const release = () => {
      if (dial.grab === null) return;
      dial.grab = null;
      const now = performance.now();
      const s = dial.samples.filter((x) => now - x.t < 120);
      if (s.length < 2) return;
      const dt = (s[s.length - 1].t - s[0].t) / 1000;
      const v = dt > 0.01 ? (s[s.length - 1].a - s[0].a) / dt : 0;
      if (Math.abs(v) > 6) { dial.v = clamp(v, -60, 60); dial.fly = true; }
    };
    dialCanvas.addEventListener('pointerup', release);
    dialCanvas.addEventListener('pointercancel', release);
    dialCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      dial.fly = false;
      dialRotate(-e.deltaY * (e.deltaMode === 1 ? 33 : 1) / 100 * DETENT, 0);
    }, { passive: false });
  }

  // ---------------- front panel ----------------
  const STEPS = [10, 100, 1e3, 10e3, 12.5e3, 20e3, 25e3, 100e3];
  const fmtStep = (v) => (v >= 1e6 ? +(v / 1e6).toFixed(3) + 'M' : v >= 1e3 ? +(v / 1e3).toFixed(2) + 'k' : String(v));
  const GAIN_MODES = { manual: 'MGC', slow_attack: 'AGC-S', fast_attack: 'AGC-F', hybrid: 'AGC-H' };

  function setStep(v) {
    mode().snap = v;
    $('snap').value = v;
    updatePanel();
    save();
  }

  function buildPanel() {
    // FINE / FAST walk down / up the STEPS list.
    const stepBy = (dir) => {
      const cur = mode().snap;
      const v = dir > 0 ? STEPS.find((x) => x > cur) : STEPS.findLast((x) => x < cur);
      if (v) setStep(v);
    };
    $('fineBtn').addEventListener('click', () => stepBy(-1));
    $('fastBtn').addEventListener('click', () => stepBy(1));
    $('autoBtn').addEventListener('click', () => { S.autoTs = !S.autoTs; updatePanel(); save(); });
    $('filBtn').addEventListener('click', () => {
      const m = mode();
      m.fil = (m.fil + 1) % m.filters.length;
      setBandwidth(m.filters[m.fil]);
    });

    $('modeBadge').addEventListener('click', () => {
      const order = Object.keys(MODE_DEFAULTS);
      const next = order[(order.indexOf(S.mode) + 1) % order.length];
      document.querySelector(`#modes button[data-mode="${next}"]`).click();
    });
    $('themeBtn').addEventListener('click', () => {
      S.panelTheme = S.panelTheme === 'amber' ? 'cyan' : 'amber';
      updatePanel();
      save();
    });
    smeterCanvas.addEventListener('click', () => {
      S.meterStyle = S.meterStyle === 'bar' ? 'needle' : 'bar';
      meter.v = 0;
      save();
    });
    const clock = () => {
      const d = new Date();
      $('clock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };
    clock();
    setInterval(clock, 5000);
    bindDial();
    bindKnobs();
  }

  function updatePanel() {
    const m = mode();
    if ($('panel').dataset.theme !== S.panelTheme) {
      $('panel').dataset.theme = S.panelTheme;
      meter.colors = null;
      meter.key = dial.key = '';
    }
    $('modeBadge').textContent = S.mode;
    $('bwBadge').textContent = `FIL${m.fil + 1} ${fmtStep(m.bandwidth)}`;
    $('tsBadge').textContent = 'TS ' + fmtStep(m.snap);
    $('agcBadge').textContent = GAIN_MODES[S.gainMode] || S.gainMode;
    $('gainBadge').textContent = 'G ' + Math.round(curGain);
    $('srBadge').textContent = +(S.sampleRate / 1e6).toFixed(3) + 'M';
    $('sqlBadge').classList.toggle('on', S.squelchOn);
    $('fineBtn').disabled = !STEPS.some((x) => x < m.snap);
    $('fastBtn').disabled = !STEPS.some((x) => x > m.snap);
    $('autoBtn').classList.toggle('active', S.autoTs);
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
    ctx.strokeStyle = '#3a3a42';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#7d7d86';
    ctx.textBaseline = 'middle';
    // Lines every 10 dB, labels every 20 dB.
    for (let d = Math.ceil(dbMin / 10) * 10; d <= dbMax; d += 10) {
      const y = Math.round(yOf(d)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      if (d % 20 === 0) ctx.fillText(String(d), 4 * dpr, y - 7 * dpr);
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
    // Without animation frames (hidden window) nothing drains the queue;
    // past WF_ROWS a full redraw from wfRows is needed anyway.
    if (wfPending.length >= WF_ROWS) { wfPending = []; wfView = null; }
    else wfPending.push(row);
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

  let lastFrame = 0;
  function frame(now) {
    const dt = clamp((now - lastFrame) / 1000 || 0, 0, 0.05);
    lastFrame = now;
    meterTick(dt, now);
    dialTick(dt);
    scopeTick(now);
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
        if (S.mode === 'USB') bw = f - S.vfo - SSB_LOWCUT;
        else if (S.mode === 'LSB') bw = S.vfo - f - SSB_LOWCUT;
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

  // Also stores the width in the selected FIL preset.
  function setBandwidth(bw) {
    const m = mode();
    m.bandwidth = m.filters[m.fil] = bw;
    txRetune();
    $('bandwidth').value = +(bw / 1e3).toFixed(2);
    updatePanel();
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
    $('meterCal').value = S.meterCal;
    if (S.gainMode === 'manual') curGain = S.gain;
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
    $('zoom').value = S.zoom;
    $('app').classList.toggle('nomenu', !S.menu);
    updateMeter();
    updatePanel();
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

    on('sampleRate', 'change', async (e) => {
      S.sampleRate = +e.target.value;
      updatePanel();
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
    on('meterCal', 'change', (e) => {
      S.meterCal = clamp(Math.round((+e.target.value || 0) * 2) / 2, -60, 60);
      e.target.value = S.meterCal;
      updateMeter();
      save();
    });
    on('gain', 'input', (e) => {
      S.gain = +e.target.value;
      curGain = S.gain;
      updatePanel();
      $('gainVal').textContent = S.gain + ' dB';
      save();
      if (pluto && state !== 'sweep' && S.gainMode === 'manual') pluto.setGain(S.gain).catch(() => {});
    });

    document.querySelectorAll('#modes button').forEach((b) => b.addEventListener('click', () => {
      S.mode = b.dataset.mode;
      syncControls();
      updateTx();
      workerConfig();
      setVfo(S.vfo);
      save();
    }));
    on('bandwidth', 'change', (e) => {
      const [mn, mx] = BW_LIMITS[S.mode];
      setBandwidth(clamp((+e.target.value || 0) * 1e3, mn, mx));
    });
    on('snap', 'change', (e) => setStep(+e.target.value));
    on('deemph', 'change', (e) => { mode().deemph = +e.target.value; workerConfig(); save(); });
    on('stereo', 'change', (e) => { S.stereo = e.target.checked; workerConfig(); save(); });
    $('audioOutRow').hidden = !canSink;
    if (!hasDevices) $('audioIn').disabled = true;
    on('audioOut', 'change', (e) => { S.audioOut = e.target.value; save(); if (audio) applySink(audio.ctx); });
    on('audioIn', 'change', (e) => setAudioIn(e.target.value));
    on('btnAudioNames', 'click', async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      } catch (e) { toast('マイクの使用が許可されませんでした'); }
      refreshAudioDevices();
    });
    if (hasDevices) navigator.mediaDevices.addEventListener('devicechange', refreshAudioDevices);
    refreshAudioDevices();
    on('squelchOn', 'change', (e) => { S.squelchOn = e.target.checked; workerConfig(); updateMeter(); updatePanel(); save(); });
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

    // Space is PTT everywhere except in text fields.
    const typing = (t) => !!t.matches && t.matches('input[type=text], input[type=number], select, textarea');
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' || typing(e.target)) return;
      e.preventDefault();
      txKey(false);
    });
    window.addEventListener('keydown', (e) => {
      if (typing(e.target)) return;
      if (e.code !== 'Space' && e.target.matches && e.target.matches('input')) return;
      const step = mode().snap || 1000;
      if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) txKey(true); }
      else if (e.key === 'Enter') { e.preventDefault(); if (pluto) $('btnPlay').click(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setVfo(snap(S.vfo) + step * (e.shiftKey ? 10 : 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); setVfo(snap(S.vfo) - step * (e.shiftKey ? 10 : 1)); }
    });

    $('introClose').addEventListener('click', () => { $('intro').hidden = true; S.introSeen = true; save(); });
  }

  // ---------------- installable app ----------------
  // Only the GitHub Pages build links a manifest; file:// pages skip this.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && document.querySelector('link[rel=manifest]')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // A new build took over: reload into it right away. The device is
    // released first so the reloaded page can reconnect to it.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      toast('新しいバージョンに更新します', 'info');
      Promise.race([disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
        .then(() => location.reload());
    });
    let installEvt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvt = e;
      $('btnInstall').hidden = false;
    });
    $('btnInstall').addEventListener('click', async () => {
      if (!installEvt) return;
      installEvt.prompt();
      await installEvt.userChoice.catch(() => {});
      installEvt = null;
      $('btnInstall').hidden = true;
    });
    window.addEventListener('appinstalled', () => { $('btnInstall').hidden = true; });
  }

  // Read-only hook for tools/browser-check.mjs.
  window.__plutoNano = { S, get sweep() { return sweep; }, wfRows, get state() { return state; } };

  // ---------------- init ----------------
  buildFreq();
  buildBands();
  buildPanel();
  updateBands();
  bindControls();
  bindTx();
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
