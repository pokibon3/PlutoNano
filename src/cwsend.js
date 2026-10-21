// CW transmit from text, taken from the FTX-1 Controller (js/cwsend.js): the elements are timed here at the key speed
// and handed to a key, key(down, t) with t in performance.now() ms (here: the CW modulator's key events, which keep
// that timing). Characters go out one at a time, so everything after the character on air stays editable. In the
// editor, sent text is locked and coloured (sent / on air) by a backdrop behind the transparent textarea; when the
// transmission ends (or is stopped) its line moves to the log above.

const PlutoCwSender = (function () {
  'use strict';

  const MORSE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
    M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
    Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...',
    8: '---..', 9: '----.', '/': '-..-.', '?': '..--..', '.': '.-.-.-', ',': '--..--', '=': '-...-', '+': '.-.-.',
    '-': '-....-', '@': '.--.-.', '(': '-.--.', ')': '-.--.-', "'": '.----.', '"': '.-..-.', '!': '-.-.--', ':': '---...',
    '&': '.-...',
  };
  // Wabun (Japanese) codes, as cw_decoder4's decoder table (src/decode.cpp jp_code) plus ヰ / ヱ
  const KANA = {
    ア: '--.--', イ: '.-', ウ: '..-', エ: '-.---', オ: '.-...', カ: '.-..', キ: '-.-..', ク: '...-', ケ: '-.--', コ: '----',
    サ: '-.-.-', シ: '--.-.', ス: '---.-', セ: '.---.', ソ: '---.', タ: '-.', チ: '..-.', ツ: '.--.', テ: '.-.--', ト: '..-..',
    ナ: '.-.', ニ: '-.-.', ヌ: '....', ネ: '--.-', ノ: '..--', ハ: '-...', ヒ: '--..-', フ: '--..', ヘ: '.', ホ: '-..',
    マ: '-..-', ミ: '..-.-', ム: '-', メ: '-...-', モ: '-..-.', ヤ: '.--', ユ: '-..--', ヨ: '--', ラ: '...', リ: '--.',
    ル: '-.--.', レ: '---', ロ: '.-.-', ワ: '-.-', ヰ: '.-..-', ヱ: '.--..', ヲ: '.---', ン: '.-.-.',
    '゛': '..', '゜': '..--.', 'ー': '.--.-', '、': '.-.-.-', '」': '.-.-..',
  };
  const SMALL = { ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ッ: 'ツ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ヮ: 'ワ', ヵ: 'カ', ヶ: 'ケ' };

  // switching between Latin (欧文) and Wabun (和文): ホレ before the first kana, ラタ before the first Latin letter after it
  const HORE = '-..---', RATA = '...-.';

  // what one typed character is sent as: full-width letters / digits become half-width (NFKC), hiragana and half-width
  // kana become katakana, small kana full size, and a voiced kana its base kana + ゛ / ゜ (ガ -> カ ゛).
  // Returns { codes, chars (the character each code stands for), kind: 'jp' (kana) | 'us' (Latin letter) | null (digits,
  // signs: both) }, or null when it cannot be sent.
  function codesOf(ch) {
    let c = ch.normalize('NFKC').toUpperCase();
    c = [...c].map((x) => (x >= 'ぁ' && x <= 'ゖ' ? String.fromCharCode(x.charCodeAt(0) + 0x60) : x)).join('');
    const codes = [], chars = [];
    let kind = null;
    for (let x of c.normalize('NFD')) {
      x = x === '\u3099' ? '゛' : x === '\u309A' ? '゜' : SMALL[x] || x;
      const code = MORSE[x] || KANA[x];
      if (!code) return null;
      if (KANA[x] && !MORSE[x]) kind = 'jp'; else if (/[A-Z]/.test(x)) kind = 'us';
      codes.push(code); chars.push(x);
    }
    return codes.length ? { codes, chars, kind } : null;
  }

  const WORD_GAP = 7;      // units between words (3 between characters)
  const IDLE_MS = 2000;    // the transmission ends after this long with nothing more typed
  const MAX_LINES = 200;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // wait until performance.now() reaches t: a timer for most of it, then a short spin for the last few ms
  // (timers alone are late by several ms, which shows at CW speeds)
  async function until(t) {
    const d = t - performance.now();
    if (d > 4) await sleep(d - 3);
    while (performance.now() < t) { /* spin */ }
  }

  class CwSender extends EventTarget {
    // el: { editor (textarea), back (its coloured backdrop), log (div, finished transmissions) }
    // keyer(): the key as (down, t) => {}, or null when keying is not possible; wpm(): the key speed
    constructor(el, keyer, wpm) {
      super();
      this.el = el; this.keyer = keyer; this.wpm = wpm;
      this.setKey = null;     // the key line of the transmission in progress
      this.active = false;
      this.lastKey = 0;
      this.pos = 0;           // editor text before this has been taken for sending (locked)
      this.sentEnd = 0;       // ... and before this has been keyed
      this.cur = null;        // { start } of the character on air
      this.aborted = 0;       // end of the character that STOP cut off
      this.mode = 'us';       // Latin or Wabun on the air now (kept between transmissions)
      this.out = [];          // what went out, for the log: { text, space (word gap before), pro, el (its span in the log) }
      this.line = null;       // the log line of the transmission in progress
      const ed = el.editor;
      // the locked part cannot be changed: edits starting in it are refused and the caret goes after it
      ed.addEventListener('beforeinput', (e) => {
        const backAtEdge = /^delete.*Backward$/.test(e.inputType) && this.pos && ed.selectionStart === this.pos && ed.selectionEnd === this.pos;
        if (ed.selectionStart < this.pos || backAtEdge) {
          e.preventDefault();
          ed.setSelectionRange(ed.value.length, ed.value.length);
        }
      });
      this.locked = '';
      this.good = '';         // the editor text after the last accepted change
      ed.addEventListener('input', () => {
        // (IME input cannot be refused beforehand: undo a change that reached into the locked part)
        if (this.pos && !ed.value.startsWith(this.locked)) ed.value = this.good;
        this.lastKey = Date.now();
        this._paint();
      });
      ed.addEventListener('scroll', () => { el.back.scrollTop = ed.scrollTop; });
      this._paint();
    }

    // start sending; false when keying is not possible
    start() {
      if (this.active) return true;
      this.setKey = this.keyer();
      if (!this.setKey) return false;
      this.active = true;
      this.dispatchEvent(new Event('state'));
      this._run();
      return true;
    }

    stop() {
      if (!this.active) return;
      this.active = false;
      try { this.setKey?.(false, performance.now()); } catch (e) { /* ignore */ }
      if (this.cur) this.aborted = this.cur.start + 1; // the character on air did not go out complete
      this.dispatchEvent(new Event('state'));
    }

    async _run() {
      const key = this.setKey;
      let tEnd = 0; // end of the previous character's last element
      try {
        while (this.active) {
          const c = this._takeChar();
          if (!c) {
            // nothing more: wait for typing, end after IDLE_MS without it
            if (Date.now() - this.lastKey >= IDLE_MS) break;
            await sleep(20);
            continue;
          }
          if (!c.codes) continue; // cannot be sent: ignored (not in the log either)
          const unit = 1200 / (this.wpm() || 20), gap = (c.space ? WORD_GAP : 3) * unit;
          // 3 units between characters, 7 after a space; never in the past (waiting for typing)
          let t = Math.max(tEnd ? tEnd + gap : 0, performance.now() + 5);
          let codes = c.codes, pro = false;
          const out = [{ text: c.chars.join(''), space: c.space, cls: 'cw-pend' }];
          // changing between Latin and Wabun: ホレ / ラタ first, as a word of its own (or a character, inside a word)
          if (c.kind && c.kind !== this.mode) {
            pro = true;
            codes = [c.kind === 'jp' ? HORE : RATA, ...codes];
            out.unshift({ text: c.kind === 'jp' ? 'ホレ' : 'ラタ', space: c.space, cls: 'cw-pend', pro: true });
            this.mode = c.kind;
          }
          out.forEach((o) => this._logAdd(o));
          // (a voiced kana is two codes: its base kana and ゛ / ゜, 3 units apart)
          for (let j = 0; j < codes.length && this.active; j++) {
            const code = codes[j];
            if (j) t += j === 1 && pro ? gap : 3 * unit;
            for (let k = 0; k < code.length && this.active; k++) {
              if (k) t += unit;
              await until(t);
              if (!this.active) break;
              await key(true, t);
              t += (code[k] === '.' ? 1 : 3) * unit;
              await until(t);
              await key(false, t);
            }
          }
          tEnd = t;
          if (this.active) { out.forEach((o) => this._logSet(o, 'cw-sent')); this.sentEnd = this.pos; this.cur = null; this._paint(); }
        }
      } catch (e) {
        this.active = false;
        this.dispatchEvent(new CustomEvent('error', { detail: e }));
      }
      try { await key(false, performance.now()); } catch (e) { /* ignore */ }
      this._finish();
    }

    // next character after the locked part; whitespace before it means a word gap
    _takeChar() {
      const v = this.el.editor.value, m = /^(\s*)(\S)/.exec(v.slice(this.pos));
      if (!m) return null;
      const start = this.pos + m[1].length, codes = codesOf(m[2]);
      this.pos = start + 1;
      this.locked = v.slice(0, this.pos);
      this.cur = codes ? { start } : null;
      if (!codes) this.sentEnd = this.pos;
      this._paint();
      return { codes: codes?.codes, chars: codes?.chars, kind: codes?.kind, space: m[1].length > 0 };
    }

    // the transmission is over: its line goes to the log, what was not sent stays in the editor
    _finish() {
      const ed = this.el.editor, v = ed.value;
      if (this.pos) {
        for (const o of this.out) if (o.cls === 'cw-pend') this._logSet(o, 'cw-abort'); // STOP cut it off
        ed.value = v.slice(Math.max(this.pos, this.aborted)).replace(/^\s+/, '');
      }
      this.out = [];
      this.line = null;
      this.pos = this.sentEnd = this.aborted = 0;
      this.locked = '';
      this.cur = null;
      this.setKey = null;
      this.active = false;
      this.dispatchEvent(new Event('state'));
      this._paint();
    }

    // the log, as it goes out: one line per transmission, characters as sent (half-width, katakana, カ゛ for ガ),
    // ホレ / ラタ where inserted; characters that cannot be sent are not there
    _logAdd(o) {
      const log = this.el.log;
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
      if (!this.line) {
        this.line = document.createElement('div');
        this.line.className = 'cw-line';
        const t = document.createElement('span');
        t.className = 'cw-time';
        t.textContent = `${new Date().toISOString().slice(11, 19)} `;
        this.line.append(t);
        log.append(this.line);
        while (log.childElementCount > MAX_LINES) log.firstElementChild.remove();
      }
      const prev = this.out[this.out.length - 1];
      o.el = document.createElement('span');
      o.el.textContent = `${prev && (o.space || o.pro || prev.pro) ? ' ' : ''}${o.text}`;
      this.out.push(o);
      this._logSet(o, 'cw-pend');
      this.line.append(o.el);
      if (atBottom) log.scrollTop = log.scrollHeight;
    }
    _logSet(o, cls) {
      o.cls = cls;
      o.el.className = o.pro && cls === 'cw-sent' ? 'cw-pro' : cls;
    }

    // backdrop: sent | on air | editable (the textarea's own text is transparent)
    _paint() {
      const v = this.el.editor.value, back = this.el.back;
      this.good = v;
      const parts = [[0, this.sentEnd, 'cw-sent'], [this.sentEnd, this.pos, 'cw-pend'], [this.pos, v.length, 'cw-edit']];
      back.replaceChildren(...parts.map(([a, b, cls]) => { const x = document.createElement('span'); x.className = cls; x.textContent = v.slice(a, b); return x; }),
        '\n'); // (a trailing line break so the backdrop scrolls as far as the textarea)
      back.scrollTop = this.el.editor.scrollTop;
    }
  }

  return CwSender;
})();
