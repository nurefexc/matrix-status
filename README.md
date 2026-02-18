# Matrix Status Monitor

[<img src="https://raw.githubusercontent.com/eonpatapon/gnome-shell-extension-caffeine/master/resources/get_it_on_gnome_extensions.png" height="100" align="right">](https://extensions.gnome.org/extension/9328/matrix-status-monitor/)

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

- **Real-time Monitoring**: Uses Matrix Sync API for instant message notifications.
- **Unread Indicators**: Displays unread message counts for rooms in the GNOME panel.
- **Quick Access**: Direct access to your Matrix rooms from the top panel.
- **Modern UI**: Built with native GNOME Shell components (St, Adwaita) for a seamless experience.
- **Matrix.to Integration**: One-click room opening using universal Matrix links.
- **Security Indicator**: Visual feedback (lock icon) for rooms with end-to-end encryption (E2EE) enabled.
- **Direct Client Integration**: Open rooms directly in Element or Fractal.
- **Intelligent Filtering**: Automatically displays only relevant rooms, prioritizing unread messages and favorites.

## Configuration

Open the extension settings to configure:
- **Homeserver URL**: Your Matrix homeserver (e.g., `https://matrix.org`).
- **Access Token**: Your Matrix account's access token.
- **Sync Interval**: Frequency of updates (default 10s).

## 🚀 Roadmap

The goal of this project is to provide an ultra-lightweight navigation layer for the Matrix network, prioritizing productivity and quick access over message display.

#### Next up
- Quick Identification (Avatars): Implement and cache room/user avatars in the dropdown for faster visual recognition.

### 🛠️ Phase 1: Navigation Fundamentals (V1.1 – Completed)
- **Direct Client Integration**: Future support for additional clients like FluffyChat.
- **Intelligent Filtering**: Optimization and advanced rule sets.

### 🔍 Phase 2: "Search & Access" Turbo
- **GNOME Overview Integration**: Access rooms directly from the system's central search (Super key) using an asynchronous cache.
- **Quick Identification (Avatars)**: Caching room-specific icons in the dropdown menu for faster visual recognition.
- **SOCKS5 Proxy Support**: Secure network access support for digital nomads and corporate users.

### ⚖️ Phase 3: Scalability and Stability
- **Multi-Account Support**: Monitor multiple Matrix accounts and homeservers simultaneously in a single interface.
- **Offline Cache**: Room list availability and searchability even without a network connection.
- **DND Integration**: Synchronization with GNOME's "Do Not Disturb" mode.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
