#!/usr/bin/env bash
# Idempotent setup for the dev spike-test runner on a fresh Debian 12 VM.
#
#   bash scripts/loadtest-dev/setup-vm.sh
#
# What it does (every step is skipped when already done):
#   1. apt: unzip curl git ca-certificates procps (sudo when not root)
#   2. bun (official installer, into ~/.bun) unless `bun` is on PATH
#   3. raises the open-files limit (/etc/security/limits.d + sysctl), so new
#      login shells get `ulimit -n 65536`; run.ts also raises it for itself
#   4. `bun install` WITHOUT the two @open-ocpp-trace/* packages (they live on
#      GitHub Packages, which needs a token even for a public package), then
#      puts the public open-ocpp-trace/sdk sources (tag 0.1.0) into
#      node_modules by hand. package.json and bun.lock are restored
#      byte-for-byte afterwards: nothing in git changes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

log() { printf '[setup] %s\n' "$*"; }

# --- 1. packages -------------------------------------------------------------
need=()
for bin in unzip curl git ps; do
  command -v "$bin" >/dev/null 2>&1 || need+=("$bin")
done
if [ "${#need[@]}" -gt 0 ]; then
  log "installing apt packages (missing: ${need[*]})"
  $SUDO apt-get update -qq
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip curl git ca-certificates procps
else
  log "apt packages present"
fi

# --- 2. bun ------------------------------------------------------------------
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  log "installing bun"
  curl -fsSL https://bun.sh/install | bash
fi
log "bun $(bun --version)"

# --- 3. open-files limit ------------------------------------------------------
LIMITS=/etc/security/limits.d/90-ocpp-loadtest.conf
if [ ! -f "$LIMITS" ]; then
  log "raising nofile limit to 65536 ($LIMITS)"
  printf '* soft nofile 65536\n* hard nofile 65536\nroot soft nofile 65536\nroot hard nofile 65536\n' |
    $SUDO tee "$LIMITS" >/dev/null || log "WARN: could not write $LIMITS"
fi
# Ephemeral ports / file handles for ~4,000 outbound sockets plus restarts.
$SUDO sysctl -q -w fs.file-max=1048576 net.ipv4.ip_local_port_range="10240 65000" >/dev/null 2>&1 ||
  log "WARN: sysctl not applied (fine inside a container)"
ulimit -n 65536 2>/dev/null || ulimit -n "$(ulimit -Hn)" 2>/dev/null || true
log "ulimit -n in this shell: $(ulimit -n)  (log out and in for the limits.d value; run.ts raises it itself)"

# --- 4. dependencies ------------------------------------------------------------
TRACE_DIR="node_modules/@open-ocpp-trace"
if [ -f node_modules/socket.io-client/package.json ] && [ -f "$TRACE_DIR/core/src/index.ts" ] &&
  [ -f "$TRACE_DIR/jsonl/src/index.ts" ] && [ "${FORCE_INSTALL:-0}" != "1" ]; then
  log "node_modules already set up (FORCE_INSTALL=1 to redo)"
else
  BACKUP="$(mktemp -d)"
  cp package.json bun.lock "$BACKUP/"
  restore() { cp "$BACKUP/package.json" "$BACKUP/bun.lock" "$REPO_ROOT/"; rm -rf "$BACKUP"; }
  trap restore EXIT
  log "bun install without @open-ocpp-trace/* (package.json / bun.lock restored afterwards)"
  bun -e '
    const p = JSON.parse(await Bun.file("package.json").text());
    for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(p[k] ?? {})) if (name.startsWith("@open-ocpp-trace/")) delete p[k][name];
    }
    await Bun.write("package.json", JSON.stringify(p, null, 2) + "\n");
  '
  # The scope registry in bunfig.toml is never contacted once nothing names it.
  bun install --ignore-scripts
  restore
  trap - EXIT

  SDK_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/open-ocpp-trace-sdk-0.1.0"
  SDK_TAG="refs/tags/@open-ocpp-trace/core@0.1.0" # core@0.1.0 and jsonl@0.1.0 tag the same commit
  if [ ! -f "$SDK_CACHE/typescript/packages/core/src/index.ts" ]; then
    log "fetching open-ocpp-trace/sdk $SDK_TAG"
    rm -rf "$SDK_CACHE"
    git init -q "$SDK_CACHE"
    git -C "$SDK_CACHE" fetch -q --depth 1 https://github.com/open-ocpp-trace/sdk.git "$SDK_TAG"
    git -C "$SDK_CACHE" checkout -q FETCH_HEAD
  fi
  for pkg in core jsonl; do
    rm -rf "$TRACE_DIR/$pkg"
    mkdir -p "$TRACE_DIR/$pkg"
    cp -R "$SDK_CACHE/typescript/packages/$pkg/src" "$TRACE_DIR/$pkg/src"
    cp "$SDK_CACHE/typescript/LICENSE" "$TRACE_DIR/$pkg/" 2>/dev/null || cp "$SDK_CACHE/LICENSE" "$TRACE_DIR/$pkg/"
    # The published package ships dist/; the tag has sources only, so point
    # every export at the .ts sources (bun runs TypeScript directly).
    bun -e '
      const [dir, src] = process.argv.slice(1);
      const p = JSON.parse(await Bun.file(src).text());
      const fix = (e) => typeof e === "object" && e && e["@open-ocpp-trace/source"]
        ? { types: e["@open-ocpp-trace/source"], default: e["@open-ocpp-trace/source"] } : e;
      for (const k of Object.keys(p.exports)) p.exports[k] = fix(p.exports[k]);
      if (p.dependencies) for (const d of Object.keys(p.dependencies)) p.dependencies[d] = p.version;
      delete p.devDependencies;
      await Bun.write(dir + "/package.json", JSON.stringify(p, null, 2) + "\n");
    ' "$TRACE_DIR/$pkg" "$SDK_CACHE/typescript/packages/$pkg/package.json"
  done
  log "placed @open-ocpp-trace/core and /jsonl 0.1.0 sources in $TRACE_DIR"
fi

# --- 5. smoke check ------------------------------------------------------------------
bun -e 'const { SCHEMA_VERSION } = await import("@open-ocpp-trace/core"); await import("@open-ocpp-trace/jsonl"); await import("socket.io-client"); console.log("[setup] trace sdk schema", SCHEMA_VERSION, "+ socket.io-client OK")'
if ! git diff --quiet -- package.json bun.lock; then
  log "WARN: package.json / bun.lock differ from git"
fi
bun apps/cli/src/main.ts --help >/dev/null 2>&1 && log "simulator CLI starts" ||
  log "WARN: 'bun apps/cli/src/main.ts --help' failed"
log "done. Next: see scripts/loadtest-dev/README.md"
