# OCPP Simulator

OCPP charger simulator written in React that works as a standalone web app or desktop application.

## Web Version

https://shiv3.github.io/ocpp-cp-simulator/v1#config=%7B"wsURL"%3A"wss%3A%2F%2Flocalhost%3A8080%2F"%2C"connectorNumber"%3A2%2C"ChargePointID"%3A"test-cp"%2C"tagID"%3A"test-tag"%2C"ocppVersion"%3A"OCPP-1.6J"%2C"Experimental"%3Anull%7D

### Legacy Version (v1)

The legacy version is available at `/v1` path:

https://shiv3.github.io/ocpp-cp-simulator/v1

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
   - Alternatively, you can bypass the security warning by running: `xattr -c "/Applications/OCPP CP Simulator.app"`

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
3. Or double-click to install with Software Center

### Development

To run the desktop app in development mode:

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri:dev

# Build for production
npm run tauri:build
```

#### Prerequisites for Development

- Node.js (v18 or later)
- Rust (latest stable)
- Platform-specific dependencies:
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Microsoft Visual Studio C++ Build Tools

<img width="1532" alt="image" src="https://github.com/user-attachments/assets/480f6e76-a426-4f0c-b133-a62a03f0847e">

## Doc

https://deepwiki.com/shiv3/ocpp-cp-simulator

## Contributing

Review `AGENTS.md` for repository guidelines covering project layout, required commands, and pull request expectations.

### Experimental feature (v1)

experimental feature support e.g. simultaneous use of multiple chargers

[like this](https://shiv3.github.io/ocpp-cp-simulator/v1#config=%7B"wsURL"%3A"wss%3A%2F%2Flocalhost%3A8080%2F"%2C"connectorNumber"%3A2%2C"ChargePointID"%3A"test-cp"%2C"tagID"%3A"test-tag"%2C"ocppVersion"%3A"OCPP-1.6J"%2C"Experimental"%3A%7B"ChargePointIDs"%3A%5B%7B"ChargePointID"%3A"test-cp"%2C"ConnectorNumber"%3A2%7D%2C%7B"ChargePointID"%3A"test-cp2"%2C"ConnectorNumber"%3A2%7D%2C%7B"ChargePointID"%3A"test-cp3"%2C"ConnectorNumber"%3A2%7D%2C%7B"ChargePointID"%3A"test-cp4"%2C"ConnectorNumber"%3A2%7D%2C%7B"ChargePointID"%3A"test-cp5"%2C"ConnectorNumber"%3A1%7D%2C%7B"ChargePointID"%3A"test-cp6"%2C"ConnectorNumber"%3A1%7D%2C%7B"ChargePointID"%3A"test-cp7"%2C"ConnectorNumber"%3A7%7D%5D%7D%7D)

<img width="1534" alt="image" src="https://github.com/user-attachments/assets/5904d690-0178-4ddc-be90-fe580259d998">
