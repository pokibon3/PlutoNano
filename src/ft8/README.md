# FT8 / FT4 core (decoder + message encoder)

Taken from the FTX-1 Controller (`js/ft8/`, `wasm/ft8/`, commit `dbbb22a`). `ft8-worklet.js` and `ft8core.wasm` are
unchanged; `ft8-worker.js` receives the core as bytes in a message instead of fetching it.

`ft8core.wasm` is built from [ft8_lib](https://github.com/kgoba/ft8_lib) (MIT, Kārlis Goba), vendored in
`wasm/ft8/ft8_lib/` (see its `VERSION`; one small patch exposes candidate LLRs), plus `wasm/ft8/api.c` /
`support.c`. Rebuild with `sh wasm/ft8/build.sh`.

On top of ft8_lib, `api.c` adds what WSJT-X does and ft8_lib does not:
fine time/frequency synchronisation of each candidate on a 200 Hz baseband (FFT downsampling), demodulation there,
OSD (ordered-statistics) decoding when belief propagation fails, and three passes with subtraction of decoded
signals. On ft8_lib's 27 test recordings this decodes 93 % of WSJT-X's messages (ft8_lib alone: 74 %), plus 20
plausible messages WSJT-X's reference run did not report.

`ft8_tx_encode` packs a message text into the tones (used by the FTX-1 Controller for transmitting; this app only
receives).

FT4 (`ft8_init(1)`) runs the same fine sync / OSD / subtraction with FT4's parameters (105 symbols of 48 ms,
4 tones, BT 1, 4 x 4 sync, 500 Hz baseband), plus WSJT-X's multi-symbol bit metrics (complex tone amplitudes of 1, 2
and 4 symbols added coherently). ft8_lib's candidate search is patched to reach FT4 start times up to 1.92 s.
On synthetic slots (no real FT4 recordings were available) the 50 % decode point moves from about -14 dB (ft8_lib)
to about -16.3 dB, and with 18 overlapping signals per slot from 52 % to 69 % decoded, with no false decodes on noise.
