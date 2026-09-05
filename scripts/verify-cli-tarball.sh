#!/usr/bin/env bash
#
# Install the packed CLI tarball into a throwaway global prefix and BOOT it.
#
# Why this exists (#320): the release workflow used to verify the tarball by
# `tar -tf | grep`-ing for a handful of filenames. Every one of those greps
# passed while the published package could not start at all, because
# `package.json#files` omitted `src/data`, `src/ocpp`, `src/trace` and
# `vendor/` — paths nothing grepped for. A check that asserts named files are
# present cannot catch a path nobody thought to name; a check that runs the
# installed package catches this and every future instance.
#
# Usage:
#   scripts/verify-cli-tarball.sh [--expect-dist] [path/to/ocpp-cp-simulator-<version>.tgz]
#
# With no tarball argument it packs one itself (`npm pack --ignore-scripts`, so
# the `prepack` vite build is skipped and whatever `dist/` is on disk — possibly
# none — is used as-is). `dist/` is only needed by `--web-console`, so CI can
# call this without paying for a UI build.
#
# --expect-dist makes the bundled web console mandatory instead of
# best-effort: the release workflow builds `dist/` before packing, so a
# tarball without one there means `files` dropped "dist" and the release
# artifact would ship without its whole reason to exist.
#
# Exits non-zero on the first failing stage, with the captured log.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ocpp-cli-verify.XXXXXX")"
DAEMON_PID=""

cleanup() {
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

fail() {
  echo "::error::CLI tarball verification failed: $1"
  shift
  for log in "$@"; do
    [ -f "$log" ] || continue
    echo "----- $log -----"
    cat "$log"
  done
  exit 1
}

EXPECT_DIST=0
TARBALL=""
for arg in "$@"; do
  case "$arg" in
    --expect-dist) EXPECT_DIST=1 ;;
    *) TARBALL="$arg" ;;
  esac
done

if [ -z "$TARBALL" ]; then
  echo "==> packing (npm pack --ignore-scripts)"
  # Capture stdout only: npm prints the tarball name there. --ignore-scripts
  # keeps `prepack`'s vite log out of that capture. --pack-destination keeps
  # the 2 MB artifact out of the working tree.
  ( cd "$REPO_ROOT" && npm pack --silent --ignore-scripts --pack-destination "$SCRATCH" ) \
    > "$SCRATCH/pack.out" 2> "$SCRATCH/pack.err"
  [ $? -eq 0 ] || fail "npm pack" "$SCRATCH/pack.err"
  TARBALL="$SCRATCH/$(basename "$(tail -n 1 "$SCRATCH/pack.out")")"
fi
[ -f "$TARBALL" ] || fail "tarball not found: $TARBALL"
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
echo "==> tarball: $TARBALL ($(wc -c < "$TARBALL") bytes)"

# ---------------------------------------------------------------------------
# Install into a sandboxed global prefix. BUN_INSTALL relocates bun's whole
# global tree (bin/ + install/global/node_modules), so this never touches the
# developer's or the runner's real global installs.
# ---------------------------------------------------------------------------
export BUN_INSTALL="$SCRATCH/bun-global"
mkdir -p "$BUN_INSTALL"
echo "==> bun install -g $TARBALL"
bun install -g --backend=copyfile "$TARBALL" > "$SCRATCH/install.log" 2>&1
[ $? -eq 0 ] || fail "bun install -g" "$SCRATCH/install.log"

BIN="$BUN_INSTALL/bin/ocpp-cp-sim"
[ -x "$BIN" ] || fail "installed bin missing or not executable: $BIN" "$SCRATCH/install.log"
PKG_DIR="$BUN_INSTALL/install/global/node_modules/ocpp-cp-simulator"
[ -d "$PKG_DIR" ] || fail "installed package dir missing: $PKG_DIR" "$SCRATCH/install.log"

# ---------------------------------------------------------------------------
# Stage A — the binary starts at all. This is what caught #320: main.ts's
# static import of ../data/... is resolved before any argument is parsed, so a
# missing top-level source directory kills even `--help`.
# (There is no --version flag; --help is the cheapest full-boot smoke.)
# ---------------------------------------------------------------------------
echo "==> [A] ocpp-cp-sim --help"
"$BIN" --help > "$SCRATCH/help.log" 2>&1
[ $? -eq 0 ] || fail "'ocpp-cp-sim --help' exited non-zero" "$SCRATCH/help.log"
grep -q "Usage: ocpp-cp-sim" "$SCRATCH/help.log" || fail "--help printed no usage banner" "$SCRATCH/help.log"

# ---------------------------------------------------------------------------
# Stage B — the WHOLE import graph of the installed tree resolves. Same
# argument ci.yml already makes for the sidecar smoke: `bun build --compile`
# is the only thing that resolves every import, including type-only ones the
# runtime elides and modules no single run reaches. Pointing it at the
# installed copy rather than the checkout is what makes it a packaging check:
# it fails if `files` omits any directory anything imports, whether or not a
# smoke-test code path happens to touch it.
# ---------------------------------------------------------------------------
echo "==> [B] bun build --compile (from the installed tree)"
bun build --compile "$PKG_DIR/src/cli/main.ts" --outfile "$SCRATCH/compiled" > "$SCRATCH/compile.log" 2>&1
[ $? -eq 0 ] || fail "the installed package's import graph does not resolve" "$SCRATCH/compile.log"

# ---------------------------------------------------------------------------
# Stage C — it serves. Boots the daemon WITH a charge point, because creating
# a CP is what pulls in src/ocpp's validators (ChargePoint -> profiles ->
# OCPPMessageHandlerV201 -> ocpp/validation/v201) — the Dockerfile carries the
# same warning. The CSMS URL points at a closed port on purpose: the CP fails
# to connect, which is fine, /v1/healthz must still answer 200.
# ---------------------------------------------------------------------------
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')"
[ -n "$PORT" ] || fail "could not pick a free port"
echo "==> [C] daemon on 127.0.0.1:$PORT with a bootstrapped CP"
"$BIN" --http-port "$PORT" --state-db :memory: \
  --cp-id verify-smoke --connectors 2 \
  --ws-url ws://127.0.0.1:9/ocpp/ > "$SCRATCH/daemon.log" 2>&1 &
DAEMON_PID=$!

HEALTHY=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/v1/healthz" -o "$SCRATCH/healthz.json" 2>/dev/null; then
    HEALTHY=1
    break
  fi
  kill -0 "$DAEMON_PID" 2>/dev/null || break
  sleep 0.5
done
[ "$HEALTHY" = 1 ] || fail "daemon never served GET /v1/healthz" "$SCRATCH/daemon.log"
kill -0 "$DAEMON_PID" 2>/dev/null || fail "daemon exited after answering healthz" "$SCRATCH/daemon.log"
echo "    healthz: $(cat "$SCRATCH/healthz.json")"
grep -q 'Bootstrapped CP "verify-smoke"' "$SCRATCH/daemon.log" \
  || fail "daemon never bootstrapped the charge point" "$SCRATCH/daemon.log"

kill "$DAEMON_PID" 2>/dev/null
wait "$DAEMON_PID" 2>/dev/null
DAEMON_PID=""

# ---------------------------------------------------------------------------
# Stage D — the bundled web console, but ONLY when the tarball actually ships
# one. `dist/` is built by the `prepack` vite build, which the release workflow
# runs and which CI (calling this after a plain `npm pack --ignore-scripts`)
# does not. Skipping rather than failing keeps this script usable in both
# places while still covering the release artifact's whole reason to exist:
# `files` dropping "dist" is invisible to stages A-C.
# ---------------------------------------------------------------------------
if [ -f "$PKG_DIR/dist/index.html" ]; then
  PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')"
  [ -n "$PORT" ] || fail "could not pick a free port"
  echo "==> [D] daemon with --web-console on 127.0.0.1:$PORT"
  "$BIN" --http-port "$PORT" --web-console --state-db :memory: > "$SCRATCH/console.log" 2>&1 &
  DAEMON_PID=$!
  SERVED=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/" -o "$SCRATCH/index.html" 2>/dev/null; then
      SERVED=1
      break
    fi
    kill -0 "$DAEMON_PID" 2>/dev/null || break
    sleep 0.5
  done
  [ "$SERVED" = 1 ] || fail "--web-console never served GET /" "$SCRATCH/console.log"
  grep -qi "<div id=\"root\"" "$SCRATCH/index.html" \
    || fail "--web-console served something that is not the UI shell" "$SCRATCH/index.html" "$SCRATCH/console.log"
  kill "$DAEMON_PID" 2>/dev/null
  wait "$DAEMON_PID" 2>/dev/null
  DAEMON_PID=""
  echo "==> CLI tarball verification passed (help + import graph + daemon healthz + web console)"
elif [ "$EXPECT_DIST" = 1 ]; then
  fail "--expect-dist was requested but the tarball ships no dist/index.html (is \"dist\" still in package.json#files?)" "$SCRATCH/install.log"
else
  echo "==> [D] skipped: tarball ships no dist/ (packed without the prepack vite build)"
  echo "==> CLI tarball verification passed (help + import graph + daemon healthz)"
fi
