// FT8 / FT4 decoder worker: owns the WebAssembly core (ft8_lib) so a decode never stalls the UI.
// The core arrives as bytes in the first message ({ type: 'wasm', bytes }): the single-file build has nothing to fetch.
let e = null, bs = 0, pending = new Float32Array(0), loaded;
const ready = new Promise((r) => { loaded = r; });
onmessage = async ({ data: m }) => {
  if (m.type === 'wasm') {
    const { instance } = await WebAssembly.instantiate(m.bytes, {});
    e = instance.exports; e.ft8_init(0); bs = e.ft8_block_size();
    loaded();
    return;
  }
  await ready;
  if (m.type === 'samples') {
    const all = new Float32Array(pending.length + m.s.length); all.set(pending); all.set(m.s, pending.length);
    let p = 0;
    for (; p + bs <= all.length; p += bs) { new Float32Array(e.memory.buffer, e.ft8_block_ptr(), bs).set(all.subarray(p, p + bs)); e.ft8_process(); }
    pending = all.slice(p);
  } else if (m.type === 'init') {
    e.ft8_init(m.ft4 ? 1 : 0); bs = e.ft8_block_size(); pending = new Float32Array(0);
  } else if (m.type === 'reset') {
    e.ft8_reset(); pending = new Float32Array(0);
  } else if (m.type === 'decode') {
    const blocks = e.ft8_blocks();
    const n = blocks > 40 ? e.ft8_decode() : 0;
    const rs = e.ft8_result_size(), rp = e.ft8_results_ptr(), out = [];
    for (let i = 0; i < n; i++) {
      const dv = new DataView(e.memory.buffer, rp + i * rs, rs);
      const tb = new Uint8Array(e.memory.buffer, rp + i * rs + 16, 40);
      out.push({ snr: dv.getFloat32(0, true), dt: dv.getFloat32(4, true), freq: dv.getFloat32(8, true), text: new TextDecoder().decode(tb.subarray(0, tb.indexOf(0))) });
    }
    postMessage({ type: 'decoded', slot: m.slot, mode: m.mode, blocks, list: out });
  } else if (m.type === 'encode') {
    // message text -> 79 tones; text comes back as the receiver will see it (or rc != 0 when it cannot be packed)
    const tb = new Uint8Array(e.memory.buffer, e.ft8_tx_text_ptr(), 40);
    tb.fill(0); tb.set(new TextEncoder().encode(m.text.toUpperCase().trim().replace(/\s+/g, ' ')).subarray(0, 39));
    const rc = e.ft8_tx_encode();
    postMessage({ type: 'encoded', id: m.id, rc, text: new TextDecoder().decode(tb.subarray(0, tb.indexOf(0))), tones: rc ? null : new Uint8Array(e.memory.buffer, e.ft8_tx_tones_ptr(), e.ft8_nsym()).slice() });
  }
};
