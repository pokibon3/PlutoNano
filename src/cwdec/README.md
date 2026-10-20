# CW decoder core

`cw-worklet.js` and `cwcore.wasm` are copied unchanged from
[pokibon3/cw_decoder4](https://github.com/pokibon3/cw_decoder4) `web/` (commit `958cf33`).
They run the same DSP / decoder as the ESP32 CW Decoder firmware.

The decoder is partly based on the Arduino CW Decoder by Hjalmar Skovholm Hansen OZ1JHM
and is distributed under the GPL. The corresponding source (`src/dsp.cpp`, `src/decoder.cpp`,
`src/decode.cpp`, `lib/float_fft`, `web/wasm/`) and the build script (`web/build.sh`) are in
that repository.

To update: rebuild there with `sh web/build.sh`, then copy both files here.
