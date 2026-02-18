# Browser UI

React + TypeScript web application with Flowbite/Tailwind UI. Also available as a Tauri desktop application.

## Web Version

https://shiv3.github.io/ocpp-cp-simulator/

## Desktop Application

### Download

Download the latest desktop version from the [Releases](https://github.com/shiv3/ocpp-cp-simulator/releases) page.

Available for:

- **macOS**:
  - Apple Silicon: `OCPP.CP.Simulator_*_aarch64.dmg`
  - Intel: `OCPP.CP.Simulator_*_x64.dmg`
- **Windows**: `OCPP.CP.Simulator_*_x64-setup.exe` or `.msi`
- **Linux**:
  - AppImage: `ocpp-cp-simulator_*_amd64.AppImage` (recommended)
  - Debian/Ubuntu: `ocpp-cp-simulator_*_amd64.deb`

### Installation

#### macOS

1. Download the appropriate `.dmg` file for your processor
2. Open the downloaded file
3. Drag the OCPP CP Simulator app to your Applications folder
4. First time opening: Right-click and select "Open" to bypass Gatekeeper
   - Alternatively: `xattr -c "/Applications/OCPP CP Simulator.app"`

#### Windows

1. Download the `.exe` or `.msi` installer
2. Run the installer
3. Follow the installation wizard
4. The app will be available in your Start Menu

#### Linux

**AppImage (Recommended)**

1. Download the `.AppImage` file
2. Make it executable: `chmod +x ocpp-cp-simulator_*.AppImage`
3. Run: `./ocpp-cp-simulator_*.AppImage`

**Debian/Ubuntu**

1. Download the `.deb` file
2. Install: `sudo dpkg -i ocpp-cp-simulator_*.deb`

## Development

```bash
npm install

# Web dev server
npm run dev

# Desktop dev mode (requires Rust)
npm run tauri:dev

# Production build
npm run tauri:build
```

### Prerequisites

- Node.js (v18 or later)
- Rust (latest stable, desktop only)
- Platform-specific dependencies:
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Microsoft Visual Studio C++ Build Tools
