#!/usr/bin/env bash
#
# Build a Bun-compiled CLI binary for use as a Tauri sidecar.
#
# Tauri's external-bin convention is "<base-name>-<rust-target-triple>[.exe]".
# In CI we know the triple via $TAURI_TARGET (set by the workflow). Locally,
# without an argument, we detect the host triple.
#
#   scripts/build-tauri-sidecar.sh                       # auto-detect host
#   scripts/build-tauri-sidecar.sh aarch64-apple-darwin  # explicit
#
# The output lands at src-tauri/binaries/ocpp-cp-sim-<triple>[.exe], which is
# what tauri.conf.json's `bundle.externalBin` expects.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Resolve target triple (CLI arg → $TAURI_TARGET → host auto-detect).
TARGET="${1:-${TAURI_TARGET:-}}"
if [ -z "$TARGET" ]; then
  case "$(uname -sm)" in
    "Darwin arm64")  TARGET="aarch64-apple-darwin" ;;
    "Darwin x86_64") TARGET="x86_64-apple-darwin" ;;
    "Linux aarch64") TARGET="aarch64-unknown-linux-gnu" ;;
    "Linux x86_64")  TARGET="x86_64-unknown-linux-gnu" ;;
    # Git Bash / MSYS2 / Cygwin report e.g. "MINGW64_NT-10.0-26100 x86_64".
    MINGW*" x86_64" | MSYS*" x86_64" | CYGWIN*" x86_64") TARGET="x86_64-pc-windows-msvc" ;;
    MINGW*" arm64" | MSYS*" arm64" | CYGWIN*" arm64")    TARGET="aarch64-pc-windows-msvc" ;;
    *) echo "Unable to auto-detect rust target triple from $(uname -sm); pass it as an arg." >&2; exit 1 ;;
  esac
fi

EXT=""
case "$TARGET" in
  aarch64-apple-darwin)        BUN_TARGET="bun-darwin-arm64" ;;
  x86_64-apple-darwin)         BUN_TARGET="bun-darwin-x64" ;;
  aarch64-unknown-linux-gnu)   BUN_TARGET="bun-linux-arm64" ;;
  x86_64-unknown-linux-gnu)    BUN_TARGET="bun-linux-x64" ;;
  x86_64-pc-windows-msvc)      BUN_TARGET="bun-windows-x64"; EXT=".exe" ;;
  aarch64-pc-windows-msvc)     BUN_TARGET="bun-windows-x64"; EXT=".exe" ;;
  *) echo "Unsupported target triple: $TARGET" >&2; exit 1 ;;
esac

OUT_DIR="src-tauri/binaries"
OUT="$OUT_DIR/ocpp-cp-sim-${TARGET}${EXT}"
mkdir -p "$OUT_DIR"

echo "Building Bun sidecar for $TARGET ($BUN_TARGET) → $OUT"
bun build --compile --target="$BUN_TARGET" --outfile="$OUT" src/cli/main.ts

# Ensure the bin is executable on macOS/Linux. Bun does this for us in
# practice, but be explicit so a fresh CI checkout never trips on a
# permissions edge case.
if [ "$EXT" = "" ]; then
  chmod +x "$OUT"
fi

echo "Done: $(ls -lh "$OUT" | awk '{print $5, $9}')"
