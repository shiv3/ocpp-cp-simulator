---
title: Desktop app (Tauri)
type: entity
summary: Tauri desktop bundle that boots the simulator daemon as a sidecar on an ephemeral loopback port and opens the full web console in Remote mode; macOS / Windows / Linux installers on the Releases page.
sources:
  - src-tauri/
  - scripts/build-tauri-sidecar.sh
  - .github/workflows/release.yml
related:
  - web-console.md
  - daemon.md
  - ../concepts/local-vs-remote-mode.md
updated: 2026-09-03
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
