#!/bin/sh
# FT8 decoder core: ft8_lib (vendored, MIT) + api.c, freestanding wasm32 build (clang + wasm-ld, no Emscripten).
#   brew install lld   (first time only)      sh wasm/ft8/build.sh   ->  src/ft8/ft8core.wasm
set -eu
cd "$(dirname "$0")"
OUT=../../src/ft8/ft8core.wasm
TMP=${TMPDIR:-/tmp}/ft8-wasm.$$; mkdir -p "$TMP"; trap 'rm -rf "$TMP"' EXIT
WASM_LD=$(command -v wasm-ld || echo /opt/homebrew/opt/lld/bin/wasm-ld)
CFLAGS="--target=wasm32 -O2 -flto -nostdlibinc -ffreestanding -fno-builtin -fvisibility=hidden -Wall -Wno-unused-function -Ishim -Ift8_lib"
OBJS=""
for f in ft8_lib/ft8/decode.c ft8_lib/ft8/encode.c ft8_lib/ft8/ldpc.c ft8_lib/ft8/crc.c ft8_lib/ft8/constants.c ft8_lib/ft8/message.c ft8_lib/ft8/text.c \
         ft8_lib/common/monitor.c ft8_lib/fft/kiss_fft.c ft8_lib/fft/kiss_fftr.c api.c support.c; do
  o="$TMP/$(basename "$f").o"; clang $CFLAGS -c "$f" -o "$o"; OBJS="$OBJS $o"
done
EX=""; for e in ft8_init ft8_block_ptr ft8_block_size ft8_process ft8_blocks ft8_reset ft8_results_ptr ft8_result_size ft8_decode ft8_nsym ft8_tx_text_ptr ft8_tx_tones_ptr ft8_tx_encode; do EX="$EX --export=$e"; done
mkdir -p "$(dirname "$OUT")"
"$WASM_LD" --no-entry --lto-O2 -z stack-size=1048576 --initial-memory=16777216 $EX $OBJS -o "$OUT"
chmod 644 "$OUT"
echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
