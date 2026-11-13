#!/bin/sh
#
# Builds the SuperDB query engine for SuperLens as WebAssembly from a
# checkout of the super repo (default: ../super) and copies Go's
# wasm_exec.js next to it.
#
#   SUPER_REPO   path to the super repo (default: ../super)
#   OUT          output directory (default: dist)
#
# wasm/main.go is compiled from inside the super repo so it builds against
# that checkout and its go.mod, with no separate Go module to keep in sync.

set -eu
cd "$(dirname "$0")/.."
LENS=$(pwd)
SUPER_REPO=${SUPER_REPO:-../super}
OUT=${OUT:-dist}

if [ ! -f "$SUPER_REPO/go.mod" ]; then
  echo "build-wasm: no super repo at $SUPER_REPO (set SUPER_REPO)" >&2
  exit 1
fi
SUPER_REPO=$(cd "$SUPER_REPO" && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

VERSION=$(git -C "$SUPER_REPO" describe --tags --always --dirty 2>/dev/null || echo unknown)
echo "building $OUT/super.wasm from $SUPER_REPO ($VERSION)"
(
  cd "$SUPER_REPO"
  GOOS=js GOARCH=wasm go build -trimpath \
    -ldflags "-s -w -X main.version=$VERSION" \
    -o "$OUT/super.wasm" "$LENS/wasm/main.go"
)

GOROOT=$(go env GOROOT)
for f in "$GOROOT/lib/wasm/wasm_exec.js" "$GOROOT/misc/wasm/wasm_exec.js"; do
  if [ -f "$f" ]; then
    cp "$f" "$OUT/wasm_exec.js"
    break
  fi
done
if [ ! -f "$OUT/wasm_exec.js" ]; then
  echo "build-wasm: can't find wasm_exec.js under $GOROOT" >&2
  exit 1
fi
ls -l "$OUT/super.wasm" | awk '{printf "super.wasm: %.1f MB\n", $5 / 1048576}'
