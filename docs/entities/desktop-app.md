---
title: Desktop app (Tauri)
type: entity
summary: Tauri desktop bundle that boots the simulator daemon as a sidecar on an ephemeral loopback port and opens the full web console in Remote mode; macOS / Windows / Linux installers on the Releases page.
sources:
  - src-tauri/
  - scripts/build-tauri-sidecar.sh
  - .github/workflows/release.yml
  - public/splash.html
related:
  - web-console.md
  - daemon.md
  - cli.md
  - ../concepts/local-vs-remote-mode.md
  - ../analyses/testing-strategy.md
updated: 2026-09-05
---

# Desktop app (Tauri)

The desktop app is **not** a wrapper around the static Local-mode build. On
launch it spins up the bundled simulator [daemon](daemon.md) as a sidecar, waits
for `/v1/healthz`, then opens the full [web console](web-console.md) served by
that daemon — so you get the same Remote-mode UX as `ocpp-cp-sim --web-console`,
without having to install anything else.

- State (`state.db`) is written to the OS-standard app data dir:
  - macOS: `~/Library/Application Support/com.ocpp.cp-simulator/state.db`
  - Linux: `~/.local/share/com.ocpp.cp-simulator/state.db`
  - Windows: `%APPDATA%\com.ocpp.cp-simulator\state.db`
- The daemon binds an ephemeral port on `127.0.0.1` — no firewall prompt.
- The daemon exposes health, static web-console assets, and Socket.IO on that
  loopback port. REST control endpoints and the Unix-domain socket are not used.
- Closing the window terminates the daemon (SIGTERM) so the next launch starts from a clean process.
- Multiple-launch is squashed by `tauri-plugin-single-instance`: the second invocation focuses the existing window instead of starting a second daemon.

## How the sidecar finds the web console

The sidecar is a `bun build --compile` binary, and `dist/` is **not** inside
it. `tauri.conf.json`'s `frontendDist` (`../dist`) is embedded in the _Rust_
binary — the Tauri config schema says a relative `frontendDist` "is read
recursively and all files are embedded in the application binary" — and that
copy serves only `splash.html` over `tauri://`. The daemon serves the console
over HTTP from a real directory on disk, so the bundle ships `dist/` a second
time as a resource:

| Piece                                   | Value                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `bundle.resources` in `tauri.conf.json` | `{"../dist/": "web-console/"}` — lands at `<resource-dir>/web-console` |
| Resource dir, macOS                     | `OCPP CP Simulator.app/Contents/Resources`                             |
| Resource dir, Windows                   | the install directory, beside the `.exe`                               |
| Resource dir, Linux (deb / rpm)         | `/usr/lib/<product>`                                                   |
| Flag passed to the sidecar              | `--web-console-dist <resource-dir>/web-console` (see [CLI](cli.md))    |

`src-tauri/src/lib.rs` resolves that path with Tauri's `resource_dir()` and
appends it to `DAEMON_ARGS`. It is the only platform-independent answer, so
the desktop app never relies on the CLI's own search. When the directory has
no `index.html` — a `tauri dev` build before `npm run build` — the flag is
dropped and the daemon falls back to its search, which is correct for the
debug path (`bun src/cli/main.ts`, where `dist/` is just `<repo>/dist`).

### Why it was broken from v0.3.2 to v0.7.8 (#319)

`lib.rs` has spawned the sidecar with `--web-console` since v0.3.2, and the
CLI used to look for `dist/` relative to `import.meta.dir`. Inside a
`bun build --compile` binary that is the in-binary virtual filesystem root
(`/$bunfs/root`), so the lookup resolved to `/dist`, found nothing, and the
daemon **exited 1 before binding a port**. `splash.html` then polled
`/v1/healthz` for its full `POLL_TIMEOUT_MS` (30 s) and rendered "Daemon
failed to start". About 30 desktop releases shipped that way, because CI
built the sidecar but never ran it.

Three things changed:

1. The CLI anchors its search on `process.execPath` (the compiled binary's
   real path) as well as `import.meta.dir`, and accepts `--web-console-dist`.
2. `tauri.conf.json` ships `dist/` as the `web-console` resource and `lib.rs`
   passes its path.
3. `src/build/__tests__/tauriSidecarWebConsole.bun.test.ts` compiles the
   sidecar and **launches** it, with the arguments parsed out of `lib.rs`'s
   `DAEMON_ARGS` and the readiness budget read from `splash.html`, so the
   test cannot drift away from either. It runs on every pull request under
   `bun run test:bun` — see [Testing strategy](../analyses/testing-strategy.md#does-anything-actually-launch-the-desktop-daemon).

## Download

Download the latest desktop version from the [Releases](https://github.com/shiv3/ocpp-cp-simulator/releases) page.
Desktop releases are cut from `vX.Y.Z` git tags (the same tag that publishes
semver [Docker image](docker-image.md#image-tags) tags).

Available for:

- **macOS**:
  - Apple Silicon: `OCPP.CP.Simulator_*_aarch64.dmg`
  - Intel: `OCPP.CP.Simulator_*_x64.dmg`
- **Windows**: `OCPP.CP.Simulator_*_x64-setup.exe` or `.msi`
- **Linux**:
  - Debian/Ubuntu: `OCPP.CP.Simulator_*_amd64.deb`
  - Fedora/RHEL: `OCPP.CP.Simulator-*.x86_64.rpm`

## Installation

### macOS

1. Download the appropriate `.dmg` file for your processor
2. Open the downloaded file
3. Drag the OCPP CP Simulator app to your Applications folder
4. First time opening: Right-click and select "Open" to bypass Gatekeeper
   - Alternatively: `xattr -c "/Applications/OCPP CP Simulator.app"`

### Windows

1. Download the `.exe` or `.msi` installer
2. Run the installer
3. Follow the installation wizard
4. The app will be available in your Start Menu

### Linux

**Debian/Ubuntu**

1. Download the `.deb` file
2. Install: `sudo dpkg -i OCPP.CP.Simulator_*.deb`

**Fedora/RHEL**

1. Download the `.rpm` file
2. Install: `sudo rpm -i OCPP.CP.Simulator-*.rpm`

## Development

```bash
npm install

# Desktop dev mode (requires Rust + Bun)
#   In debug builds the desktop shell spawns `bun src/cli/main.ts ...`
#   directly, so iteration on the daemon stays fast — no need to
#   re-compile the sidecar between edits.
npm run tauri:dev

# Production build
#   The beforeBuildCommand chains `npm run build` and
#   `scripts/build-tauri-sidecar.sh`, so `dist/` + the Bun-compiled
#   sidecar both land in `src-tauri/` before tauri bundles the app.
npm run tauri:build
```

### Prerequisites

- Node.js (v18 or later)
- Bun (used to compile the CLI sidecar for `tauri:build`; needed for `tauri:dev` too since the desktop shell spawns `bun src/cli/main.ts`)
- Rust (latest stable, desktop only)
- Platform-specific dependencies:
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Microsoft Visual Studio C++ Build Tools
