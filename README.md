# Matrix Status Monitor

High-performance Matrix notification monitor for GNOME Shell.

## Features

- **Real-time Monitoring**: Uses Matrix Sync API for instant message notifications.
- **Unread Indicators**: Displays unread message counts for rooms in the GNOME panel.
- **Quick Access**: Direct access to your Matrix rooms from the top panel.
- **Modern UI**: Built with native GNOME Shell components (St, Adwaita) for a seamless experience.
- **Matrix.to Integration**: One-click room opening using universal Matrix links.

## Installation

### Dependencies
- GNOME Shell (45-49)
- `libadwaita`
- `glib2-devel` (for compiling schemas)

### Building & Installing

1. Clone the repository:
   ```bash
   git clone https://github.com/nurefexc/matrix-status.git
   cd matrix-status
   ```

2. Compile GSettings schemas:
   ```bash
   make compile
   ```

3. Move the extension to your local directory:
   ```bash
   mkdir -p ~/.local/share/gnome-shell/extensions/matrix-status@nurefexc.com
   cp -r * ~/.local/share/gnome-shell/extensions/matrix-status@nurefexc.com
   ```

4. Restart GNOME Shell (X11: `Alt+F2` then `r`, Wayland: Logout/Login) and enable via Extensions app.

## Configuration

Open the extension settings to configure:
- **Homeserver URL**: Your Matrix homeserver (e.g., `https://matrix.org`).
- **Access Token**: Your Matrix account's access token.
- **Sync Interval**: Frequency of updates (default 10s).

## Future Plans

- **Interactive Notifications**: Desktop notifications for new messages with "Mark as Read" or "Reply" actions.
- **Multiple Account Support**: Ability to monitor multiple homeservers/accounts simultaneously.
- **Improved Filtering**: Option to hide specific rooms or only show mentions (highlights).
- **Custom Icons**: Support for per-room avatars in the dropdown menu.
- **Theming Options**: Choice of panel icon styles (monochrome/colored) and "Do Not Disturb" mode integration.
- **Message Preview**: Hovering over the room name shows the last message snippet.
- **GNOME Search Provider**: Search through your Matrix rooms directly from the GNOME Overview.
- **Modern UI Components**: Full utilization of newest Libadwaita features as they become available.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
