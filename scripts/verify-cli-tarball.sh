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
#   scripts/verify-cli-tarball.sh [--expect-dist] [--runtime node|bun] [path/to/ocpp-cp-simulator-<version>.tgz]
#
# --runtime node  (#916) proves the package runs WITHOUT Bun: PATH is cut down
#                 to node's directory plus /usr/bin:/bin, the script fails if
#                 `bun` is still found, the tarball is installed with npm only
#                 and every stage runs the bin through its `node` shebang.
#                 Needs a tarball argument (building the bundle needs Bun).
# --runtime bun   runs the installed bundle with `bun --bun`, ignoring the
#                 shebang, so the same package is exercised on Bun.
# (no flag)       the original mix: bun and npm installs, bin run by shebang.
#
# With no tarball argument it builds the CLI bundle (`bun run build:cli`, the
# `bin` the tarball ships) and packs one itself (`npm pack --ignore-scripts`,
# so the `prepack` vite build is skipped and whatever `dist/` is on disk —
# possibly none — is used as-is). `dist/` is only needed by `--web-console`,
# so CI can call this without paying for a UI build.
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
RUNTIME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --expect-dist) EXPECT_DIST=1 ;;
    --runtime) shift; RUNTIME="${1:-}" ;;
    *) TARBALL="$1" ;;
  esac
  shift
done
case "$RUNTIME" in
  ""|node|bun) ;;
  *) echo "::error::--runtime takes node or bun, not '$RUNTIME'"; exit 2 ;;
esac
# RUN is the command prefix every stage runs the installed bin with (`env`:
# the bin runs through its shebang).
RUN=(env)
if [ "$RUNTIME" = node ]; then
  [ -n "$TARBALL" ] || { echo "::error::--runtime node needs a tarball argument (building the bundle needs Bun)"; exit 2; }
  NODE_BIN="$(command -v node)" || { echo "::error::node not found"; exit 2; }
  export PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin"
  if command -v bun > /dev/null 2>&1; then
    echo "::error::--runtime node: bun is still on PATH ($(command -v bun)); the point is to run without it"
    exit 2
  fi
  echo "==> runtime: node $(node -v), no bun on PATH"
elif [ "$RUNTIME" = bun ]; then
  RUN=(bun --bun)
  echo "==> runtime: bun $(bun -v) (bun --bun, shebang ignored)"
fi

if [ -z "$TARBALL" ]; then
  echo "==> building the CLI bundle (bun run build:cli)"
  ( cd "$REPO_ROOT" && bun run build:cli ) > "$SCRATCH/build-cli.log" 2>&1
  [ $? -eq 0 ] || fail "bun run build:cli" "$SCRATCH/build-cli.log"
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
# Stage P — the repository is a Bun workspace (#578) and the root package.json
# carries a "workspaces" field, but the package it publishes is the CLI bundle
# alone. The tarball must therefore hold no workspace member (packages/,
# apps/) and its manifest must not depend on one: a `workspace:*` range, or a
# file that only exists in the repository, would install nowhere else. The
# `workspaces` field itself is harmless to both installers; stages A (bun) and
# A2 (npm) below install the manifest as packed and run it.
# ---------------------------------------------------------------------------
echo "==> [P] packed manifest and file list"
if tar -tzf "$TARBALL" | grep -E '^package/(packages|apps)/' > "$SCRATCH/members.log"; then
  fail "the tarball ships workspace members (packages/ or apps/)" "$SCRATCH/members.log"
fi
tar -xzOf "$TARBALL" package/package.json > "$SCRATCH/packed-package.json" \
  || fail "the tarball has no package/package.json"
if grep -n 'workspace:' "$SCRATCH/packed-package.json" > "$SCRATCH/workspace-refs.log"; then
  fail "the packed package.json uses a workspace: dependency; it could not install outside the repository" "$SCRATCH/workspace-refs.log"
fi

# ---------------------------------------------------------------------------
# Install into a sandboxed global prefix. BUN_INSTALL relocates bun's whole
# global tree (bin/ + install/global/node_modules), so this never touches the
# developer's or the runner's real global installs.
# ---------------------------------------------------------------------------
if [ "$RUNTIME" = node ]; then
  # No Bun: install with npm, which is how most users get the package.
  NPM_PREFIX="$SCRATCH/npm-global"
  mkdir -p "$NPM_PREFIX"
  echo "==> npm install -g $TARBALL"
  npm install -g --prefix "$NPM_PREFIX" --no-audit --no-fund "$TARBALL" > "$SCRATCH/install.log" 2>&1
  [ $? -eq 0 ] || fail "npm install -g" "$SCRATCH/install.log"
  BIN="$NPM_PREFIX/bin/ocpp-cp-sim"
  PKG_DIR="$NPM_PREFIX/lib/node_modules/ocpp-cp-simulator"
else
  export BUN_INSTALL="$SCRATCH/bun-global"
  mkdir -p "$BUN_INSTALL"
  echo "==> bun install -g $TARBALL"
  bun install -g --backend=copyfile "$TARBALL" > "$SCRATCH/install.log" 2>&1
  [ $? -eq 0 ] || fail "bun install -g" "$SCRATCH/install.log"

  BIN="$BUN_INSTALL/bin/ocpp-cp-sim"
  PKG_DIR="$BUN_INSTALL/install/global/node_modules/ocpp-cp-simulator"
fi
[ -x "$BIN" ] || fail "installed bin missing or not executable: $BIN" "$SCRATCH/install.log"
[ -d "$PKG_DIR" ] || fail "installed package dir missing: $PKG_DIR" "$SCRATCH/install.log"
# The package is the bundle plus dist/; no source tree (#578). A src/ in the
# tarball means `files` regressed to shipping sources, and anything that only
# works because of it would hide behind this script's own checks.
[ -f "$PKG_DIR/dist-cli/main.js" ] || fail "installed package has no dist-cli/main.js (is \"dist-cli\" in package.json#files, and was build:cli run?)" "$SCRATCH/install.log"
[ ! -e "$PKG_DIR/src" ] || fail "installed package ships src/ — the tarball must carry only the bundle and dist/" "$SCRATCH/install.log"
if [ "$RUNTIME" != bun ]; then
  head -n 1 "$PKG_DIR/dist-cli/main.js" | grep -q '^#!/usr/bin/env node$' \
    || fail "dist-cli/main.js does not start with the node shebang (#916)"
fi

# ---------------------------------------------------------------------------
# Stage A — the binary starts at all. This is what caught #320, when the
# tarball shipped sources and main.ts's static import of ../data/... was
# resolved before any argument was parsed; with the bundle it is the check
# that `bin` points at a file the tarball has and that bun runs it.
# (There is no --version flag; --help is the cheapest full-boot smoke.)
# ---------------------------------------------------------------------------
echo "==> [A] ocpp-cp-sim --help"
"${RUN[@]}" "$BIN" --help > "$SCRATCH/help.log" 2>&1
[ $? -eq 0 ] || fail "'ocpp-cp-sim --help' exited non-zero" "$SCRATCH/help.log"
grep -q "Usage: ocpp-cp-sim" "$SCRATCH/help.log" || fail "--help printed no usage banner" "$SCRATCH/help.log"

# ---------------------------------------------------------------------------
# Stage A2 — the same tarball through npm, which is how most users install it
# (`npm install -g`). npm reads the "workspaces" field of a package it installs
# too, so this is the check that it neither errors nor skips the bin. Skipped
# where npm is not installed.
# ---------------------------------------------------------------------------
if [ "$RUNTIME" = node ]; then
  echo "==> [A2] skipped: the install above was npm already"
elif command -v npm > /dev/null 2>&1; then
  echo "==> [A2] npm install -g $TARBALL"
  NPM_PREFIX="$SCRATCH/npm-global"
  mkdir -p "$NPM_PREFIX"
  npm install -g --prefix "$NPM_PREFIX" --no-audit --no-fund "$TARBALL" > "$SCRATCH/npm-install.log" 2>&1
  [ $? -eq 0 ] || fail "npm install -g" "$SCRATCH/npm-install.log"
  "$NPM_PREFIX/bin/ocpp-cp-sim" --help > "$SCRATCH/npm-help.log" 2>&1
  [ $? -eq 0 ] || fail "the npm-installed 'ocpp-cp-sim --help' exited non-zero" "$SCRATCH/npm-help.log"
  grep -q "Usage: ocpp-cp-sim" "$SCRATCH/npm-help.log" || fail "the npm-installed --help printed no usage banner" "$SCRATCH/npm-help.log"
else
  echo "==> [A2] skipped: npm is not installed"
fi

# ---------------------------------------------------------------------------
# Stage B — the installed bundle is self-contained: `bun build --compile`
# over it resolves every import it still makes. The bundle inlines the
# repository's modules, so what is left are external packages; a bare
# specifier the bundle kept (an `--external`, or a dependency `bun build`
# could not inline) must resolve from the installed package's own
# node_modules, or the published CLI fails on that import.
# ---------------------------------------------------------------------------
if [ "$RUNTIME" = node ]; then
  echo "==> [B] skipped: needs bun"
else
  echo "==> [B] bun build --compile (from the installed tree)"
  bun build --compile "$PKG_DIR/dist-cli/main.js" --outfile "$SCRATCH/compiled" > "$SCRATCH/compile.log" 2>&1
  [ $? -eq 0 ] || fail "the installed bundle's import graph does not resolve" "$SCRATCH/compile.log"
fi

# ---------------------------------------------------------------------------
# Stage C — it serves. Boots the daemon WITH a charge point, because creating
# a CP is what pulls in packages/ocpp/src's validators (ChargePoint -> profiles ->
# OCPPMessageHandlerV201 -> ocpp/validation/v201) — the Dockerfile carries the
# same warning. The CSMS URL points at a closed port on purpose: the CP fails
# to connect, which is fine, /v1/healthz must still answer 200.
# ---------------------------------------------------------------------------
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')"
[ -n "$PORT" ] || fail "could not pick a free port"
echo "==> [C] daemon on 127.0.0.1:$PORT with a bootstrapped CP"
"${RUN[@]}" "$BIN" --http-port "$PORT" --state-db :memory: \
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
# Stage C1 — JSON Lines mode (#916): a command on stdin gets its answer on
# stdout. The CSMS URL is a closed port again; `status` does not need a link.
# ---------------------------------------------------------------------------
echo "==> [C1] --json status over stdin"
( echo '{"id":"smoke","command":"status"}'; sleep 3 ) \
  | "${RUN[@]}" "$BIN" --cp-id verify-json --ws-url ws://127.0.0.1:9/ocpp/ --json > "$SCRATCH/json.log" 2>&1
grep -q '"id":"smoke","ok":true' "$SCRATCH/json.log" \
  || fail "--json did not answer the status command" "$SCRATCH/json.log"

# ---------------------------------------------------------------------------
# Stage C2 — export-k6 writes its runtime. The runtime used to be copied from
# src/cli/exportK6/runtime/ beside the running module, which a bundle does not
# have; it is embedded now (runtimeSources.ts). Run from the installed tree,
# this is the check that the embedded copy reaches the export.
# ---------------------------------------------------------------------------
echo "==> [C2] export-k6 from the installed tree"
"${RUN[@]}" "$BIN" export-k6 --scenario "$REPO_ROOT/docs/examples/scenarios/demo-charging.json" \
  --out "$SCRATCH/k6-export" > "$SCRATCH/export-k6.log" 2>&1
[ $? -eq 0 ] || fail "'ocpp-cp-sim export-k6' exited non-zero" "$SCRATCH/export-k6.log"
for f in scenario.k6.ts ocpp-runtime/index.ts ocpp-runtime/wire/v16.ts; do
  [ -f "$SCRATCH/k6-export/$f" ] || fail "export-k6 wrote no $f" "$SCRATCH/export-k6.log"
done

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
  "${RUN[@]}" "$BIN" --http-port "$PORT" --web-console --state-db :memory: > "$SCRATCH/console.log" 2>&1 &
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
  # The CLI bundle inlines socket.io, ws, ...: their notices travel with it (#870).
  [ -s "$PKG_DIR/dist-cli/THIRD-PARTY-LICENSES.txt" ] \
    || fail "the tarball ships dist-cli/main.js without dist-cli/THIRD-PARTY-LICENSES.txt (scripts/generate-cli-notices.ts)"
  grep -qi "socket.io" "$PKG_DIR/dist-cli/THIRD-PARTY-LICENSES.txt" \
    || fail "dist-cli/THIRD-PARTY-LICENSES.txt does not list socket.io, which the bundle inlines"
  # MIT / ISC need the notices to travel with the bundled code (#857).
  [ -s "$PKG_DIR/dist/THIRD-PARTY-LICENSES.txt" ] \
    || fail "the tarball ships dist/ without THIRD-PARTY-LICENSES.txt (vite.config.ts license plugin)"
  # The fonts are copied, not imported: OFL-1.1 needs their notice too (#857).
  grep -qi "ibm-plex" "$PKG_DIR/dist/THIRD-PARTY-LICENSES.txt" \
    || fail "THIRD-PARTY-LICENSES.txt does not mention the bundled ibm-plex fonts (scripts/licenseNotices.ts)"
  [ "$SERVED" = 1 ] || fail "--web-console never served GET /" "$SCRATCH/console.log"
  grep -qi "<div id=\"root\"" "$SCRATCH/index.html" \
    || fail "--web-console served something that is not the UI shell" "$SCRATCH/index.html" "$SCRATCH/console.log"
  kill "$DAEMON_PID" 2>/dev/null
  wait "$DAEMON_PID" 2>/dev/null
  DAEMON_PID=""
  echo "==> CLI tarball verification passed (help + import graph + daemon healthz + export-k6 + web console)"
elif [ "$EXPECT_DIST" = 1 ]; then
  fail "--expect-dist was requested but the tarball ships no dist/index.html (is \"dist\" still in package.json#files?)" "$SCRATCH/install.log"
else
  echo "==> [D] skipped: tarball ships no dist/ (packed without the prepack vite build)"
  echo "==> CLI tarball verification passed (help + import graph + daemon healthz + export-k6)"
fi
