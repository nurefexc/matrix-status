# Matrix Status Monitor

[![GNOME Extensions](https://img.shields.io/badge/GNOME%20Extensions-Install-4A86CF?logo=gnome&logoColor=white)](https://extensions.gnome.org/extension/9328/matrix-status-monitor/)
[![Lint](https://github.com/nurefexc/matrix-status/actions/workflows/linter.yml/badge.svg)](https://github.com/nurefexc/matrix-status/actions/workflows/linter.yml)
[![Release](https://github.com/nurefexc/matrix-status/actions/workflows/release.yml/badge.svg)](https://github.com/nurefexc/matrix-status/actions/workflows/release.yml)
[![Version](https://img.shields.io/github/v/release/nurefexc/matrix-status?label=version)](https://github.com/nurefexc/matrix-status/releases)
[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-45%E2%80%9349-4A86CF)](#version)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

High-performance Matrix notification monitor for GNOME Shell.

## Version

This extension supports GNOME Shell `45` -> `49`.

| Branch | Compatible GNOME version |
|--------|--------------------------|
| master | GNOME 45 -> 49           |

## Installation from source

1. Clone the repository:
   ```bash
   git clone https://github.com/nurefexc/matrix-status.git
   cd matrix-status
   ```

2. Build and install:
   ```bash
   make compile
   mkdir -p ~/.local/share/gnome-shell/extensions/matrix-status@nurefexc.com
   cp -r * ~/.local/share/gnome-shell/extensions/matrix-status@nurefexc.com
   ```

3. Restart GNOME Shell (X11: `Alt+F2` then `r`, Wayland: Logout/Login) and enable via Extensions app.

## Features

- **Real-time Monitoring**: Uses optimized Matrix Incremental Sync (Long Polling) for instant notifications with minimal network traffic.
- **Persistent Avatar Cache**: Room and user avatars are cached locally for fast loading and reduced data usage.
- **Unread Indicators**: Displays unread message counts for rooms in the GNOME panel.
- **Quick Access**: Direct access to your Matrix rooms from the top panel.
- **QR Code Generation**: Easily share room/user links via generated QR codes directly from the menu.
- **Modern UI**: Built with native GNOME Shell components (St, Adwaita) and circular avatars for a seamless, modern experience.
- **Matrix.to Integration**: One-click room opening using universal Matrix links.
- **Security Indicator**: Visual feedback (lock icon) for rooms with end-to-end encryption (E2EE) enabled.
- **Direct Client Integration**: Open rooms directly in Element, Fractal or SchildiChat.
- **Intelligent Filtering**: Automatically displays only relevant rooms, prioritizing unread messages and favorites.
- **Incremental Sync**: Optimized network usage with `since` token support.
- **Avatar Support**: Circular avatars with persistent local caching.
- **QR Code Sharing**: Integrated QR generator for room IDs.

### Configuration

Open the extension settings to configure:
- **Homeserver URL**: Your Matrix homeserver (e.g., `https://matrix.org`).
- **Access Token**: Your Matrix account's access token.
- **Sync Interval**: Frequency of updates (optimized for long polling).
- **Client Type**: Choose between Web, Element, or Fractal.
- **QR Code**: Enable or disable QR code sharing.

#### 🔑 How to get your Access Token (Element Desktop)

1. Open **All Settings** and go to **Help and about** at the bottom of the left panel.
2. Scroll all the way down to **Advanced** and click the arrow in **Access Token** to expand it.
3. Click the copy button to copy it to the clipboard.

> [!WARNING]
> **Be careful with your access token. It's sensitive!** Erase from your clipboard and clipboard history after use.

## 🚀 Roadmap

The goal of this project is to provide an ultra-lightweight navigation layer for the Matrix network, prioritizing productivity and quick access over message display.

### 🔍 Phase 1: "Search & Access" Turbo
- **GNOME Overview Integration**: Access rooms directly from the system's central search (Super key) using an asynchronous cache.
- **SOCKS5 Proxy Support**: Secure network access support for digital nomads and corporate users.

### ⚖️ Phase 2: Scalability and Stability
- **Multi-Account Support**: Monitor multiple Matrix accounts and homeservers simultaneously in a single interface.
- **Offline Cache**: Room list availability and searchability even without a network connection.
- **DND Integration**: Synchronization with GNOME's "Do Not Disturb" mode.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
