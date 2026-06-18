# Matrix Status Monitor

[![GNOME Extensions](https://img.shields.io/badge/GNOME%20Extensions-Install-4A86CF?logo=gnome&logoColor=white)](https://extensions.gnome.org/extension/9328/matrix-status-monitor/)
[![Lint](https://github.com/nurefexc/matrix-status/actions/workflows/linter.yml/badge.svg)](https://github.com/nurefexc/matrix-status/actions/workflows/linter.yml)
[![Release](https://github.com/nurefexc/matrix-status/actions/workflows/release.yml/badge.svg)](https://github.com/nurefexc/matrix-status/actions/workflows/release.yml)
[![Version](https://img.shields.io/github/v/release/nurefexc/matrix-status?label=version)](https://github.com/nurefexc/matrix-status/releases)
[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-45%E2%80%9350-4A86CF)](#version)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

High-performance Matrix notification monitor for GNOME Shell.

## Version

This extension supports GNOME Shell `45` → `50`.

| Branch | Compatible GNOME version |
|--------|--------------------------|
| master | GNOME 45 → 50            |

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

3. Restart GNOME Shell (X11: `Alt+F2` then `r`, Wayland: logout and log back in) and enable the extension via the Extensions app.

## Features

- **Real-time Monitoring**: Uses optimized Matrix Incremental Sync (long polling) for instant updates with minimal network traffic.
- **Intelligent Room Sorting**: Weight-based multi-criteria priority system — mentions and DMs always surface first, idle rooms stay at the bottom with a visual separator.
- **Desktop Notifications**: Native GNOME Shell message tray notifications for new messages, with deduplication and high urgency for direct mentions.
- **Profile Header**: Displays your avatar, display name, and Matrix user ID at the top of the panel menu, with a one-click copy button.
- **QR Code Sharing**: Generate and display QR codes for any room or your own user ID directly from the menu.
- **Persistent Avatar Cache**: Room and user avatars are cached locally (3-hour TTL) for fast loading and reduced data usage.
- **Unread Indicators**: Displays unread message counts per room; bold text for direct mentions and highlights.
- **Security Indicator**: Lock icon for rooms with end-to-end encryption (E2EE) enabled.
- **Direct Client Integration**: Open rooms directly in Element, SchildiChat, Fractal, NeoChat or via matrix.to.
- **GNOME Overview Search**: Access rooms from the system search (Super key) using an async-backed cache.
- **Incremental Sync**: Optimized network usage with `since` token support.

## Sorting Priority

Rooms are ranked by a weight-based system. The higher the weight, the closer to the top.

| Condition | Weight bonus |
|---|---|
| DM with highlight/mention | +1600 |
| DM with unread | +1200 |
| Highlight/mention count | +1000–1300 |
| Unread count | +500–750 |
| Marked as favourite | +180 |
| Frequently visited | +up to 240 |
| Recent activity | +up to 120 |
| Muted / low-priority | −2000 (always bottom) |

Active and idle rooms are separated by a visual divider in the menu.

## Configuration

Open the extension settings to configure:

- **Homeserver URL**: Your Matrix homeserver (e.g., `https://matrix.org`).
- **Access Token**: Your Matrix account's access token.
- **Sync Interval**: How often to poll for updates (minimum 5 seconds).
- **Preferred Client**: Choose between Web (matrix.to), Element, Fractal, SchildiChat, or NeoChat.
- **QR Code Generation**: Enable or disable QR code buttons for rooms and your profile.
- **Desktop Notifications**: Enable or disable GNOME Shell message tray notifications.

### 🔑 How to get your Access Token

You will need a Matrix access token to use this extension. You can obtain it in two ways:

#### Method 1: Element Desktop (Simple)

1. Open **All Settings**, then click on **Help & about** at the bottom of the left panel.
2. Scroll down to the **Advanced** section and click the arrow next to **Access Token**.
3. Copy the token to your clipboard.

#### Method 2: Command Line (curl)

If you don't use Element or find it faster, run the following command in your terminal (replace with your own credentials):

```bash
curl -XPOST -d '{"type":"m.login.password", "user":"USERNAME", "password":"PASSWORD"}' \
"https://matrix.org/_matrix/client/v3/login"
```

*Note: If you use your own homeserver, replace `https://matrix.org` with your server's URL.*

Look for the `"access_token"` field in the response.

> [!WARNING]
> **Your token is sensitive data – treat it like your password!** Clear it from your clipboard and command line history after use.

### ⚙️ Entering Settings

1. Open the extension settings.
2. In the **Homeserver URL** field, enter your server's address (e.g., `https://matrix.org`).
3. In the **Access Token** field, paste the token obtained above.

## 🚀 Roadmap

The goal of this project is to provide an ultra-lightweight navigation layer for the Matrix network, prioritising productivity and quick access over message display.

### 🔍 Phase 1: "Search & Access" Turbo (In Progress)
- **SOCKS5 Proxy Support**: Secure network access for digital nomads and corporate environments.

### ⚖️ Phase 2: Scalability and Stability
- **Multi-Account Support**: Monitor multiple Matrix accounts and homeservers simultaneously.
- **Offline Cache**: Room list available and searchable without a network connection.
- **DND Integration**: Synchronise with GNOME's "Do Not Disturb" mode to suppress notifications automatically.
- **Native Dark Mode Support**: Fully compatible with GNOME 45+ appearance settings.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.