/*
 * Matrix Status Monitor – GNOME Shell extension
 *
 * Goal: Lightweight navigation and notification layer for Matrix in the GNOME panel.
 * Style: Readability, maintainability, minimal dependencies.
 *
 * Note to contributors:
 * - Keep network calls (Soup.Session) and UI building (PopupMenu)
 *   clearly separated.
 * - All user settings are in GSettings (schemas/...).
 * - Targeted shell versions: GNOME 45–49.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Indicator displayed on the panel and dropdown menu handling.
 * - Icon: matrix-symbolic
 * - Menu: Room list + Client launcher (Element/Fractal)
 */
const MatrixIndicator = GObject.registerClass(
    class MatrixIndicator extends PanelMenu.Button {
        _init(settings, extensionPath) {
            super._init(0.5, 'Matrix Status');
            this._settings = settings;
            this._path = extensionPath;
            this._httpSession = new Soup.Session();
            this._cancellable = new Gio.Cancellable();

            const iconPath = GLib.build_filenamev([this._path, 'icons', 'matrix-symbolic.svg']);
            const gicon = Gio.FileIcon.new(Gio.File.new_for_path(iconPath));

            this.icon = new St.Icon({
                gicon: gicon,
                style_class: 'system-status-icon',
                icon_size: 16,
            });

            this.add_child(this.icon);
            this._lastRooms = [];
            this._buildMenu([]);
        }

        destroy() {
            this._cancellable.cancel();
            this._httpSession.abort();
            super.destroy();
        }

        _getWebUrl(roomId = null) {
            return roomId ? `https://matrix.to/#/${roomId}` : 'https://matrix.to';
        }

        _getElementUrl(roomId = null) {
            return roomId ? `element://vector/webapp/#/room/${roomId}` : 'element://';
        }

        /**
         * Generate Fractal URI for a given room.
         * Example: matrix:roomid/<encoded_room_id>?action=join&via=<domain>
         * - Remove '!' prefix from the start of roomId
         * - ':' → '%3A' encoding
         * - 'via' parameter for the room domain (better discoverability on the network)
         */
        _getFractalUrl(roomId = null) {
            if (!roomId) {
                return 'matrix:';
            }

            // Format: matrix:roomid/ddFcOBvOPLPIhKDvmy%3Anurefexc.com?action=join&via=nurefexc.com
            // Remove '!' from start of roomId if present
            const cleanId = roomId.startsWith('!') ? roomId.slice(1) : roomId;
            const encodedId = cleanId.replace(/:/g, '%3A');

            // Extract domain for 'via' parameter
            let via = '';
            if (cleanId.includes(':')) {
                via = `&via=${cleanId.split(':')[1]}`;
            }

            return `matrix:roomid/${encodedId}?action=join${via}`;
        }

        _openMatrixClient(roomId = null) {
            const clientType = this._settings.get_enum('client-type');
            let uri;

            if (clientType === 2) {
                uri = this._getFractalUrl(roomId);
            }
            else if (clientType === 1) {
                uri = this._getElementUrl(roomId);
            }
            else {
                uri = this._getWebUrl(roomId);
            }

            Gio.AppInfo.launch_default_for_uri(uri, null);
        }

        _buildMenu(rooms = []) {
            this.menu.removeAll();
            if (rooms.length === 0) {
                const item = new PopupMenu.PopupMenuItem('No Active Messages');
                item.sensitive = false;
                this.menu.addMenuItem(item);
            }
            else {
                rooms.sort((a, b) => b.timestamp - a.timestamp);

                rooms.forEach((room) => {
                    const item = new PopupMenu.PopupMenuItem('', { activate: true });

                    if (room.encrypted) {
                        const lockIcon = new St.Icon({
                            icon_name: 'changes-prevent-symbolic',
                            style_class: 'popup-menu-icon',
                            icon_size: 14,
                            x_align: Clutter.ActorAlign.CENTER,
                            y_align: Clutter.ActorAlign.CENTER,
                        });
                        item.insert_child_at_index(lockIcon, 0);
                    }

                    let labelText = room.unread > 0 ? `<b>(${room.unread}) ${room.name}</b>` : room.name;
                    item.label.get_clutter_text().set_markup(labelText);

                    item.connect('activate', () => {
                        this._openMatrixClient(room.id);
                    });
                    this.menu.addMenuItem(item);
                });
            }

            const clientType = this._settings.get_enum('client-type');
            if (clientType === 1 || clientType === 2) {
                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                const clientName = clientType === 1 ? 'Element' : 'Fractal';
                const iconName = clientType === 1 ? 'element.svg' : 'fractal.svg';

                const launchItem = new PopupMenu.PopupMenuItem(`Open ${clientName}`);

                const iconPath = GLib.build_filenamev([this._path, 'icons', iconName]);
                const gfile = Gio.File.new_for_path(iconPath);
                const gicon = Gio.FileIcon.new(gfile);
                const icon = new St.Icon({
                    gicon: gicon,
                    icon_size: 16,
                });
                launchItem.add_child(icon);
                launchItem.remove_child(icon);
                launchItem.insert_child_at_index(icon, 0);

                launchItem.connect('activate', () => this._openMatrixClient());
                this.menu.addMenuItem(launchItem);
            }
        }

        /**
         * Synchronization with Matrix Client API (/_matrix/client/v3/sync).
         * - Minimal filter: room name, tags, encryption flag
         * - Goal: Fast, lightweight list building (not message display)
         */
        async refresh() {
            let homeserver = this._settings.get_string('homeserver-url').trim();
            const token = this._settings.get_string('access-token').trim();
            if (!token || !homeserver)
                return;
            if (!homeserver.startsWith('http'))
                homeserver = `https://${homeserver}`;
            homeserver = homeserver.replace(/\/$/, '');

            const filter = JSON.stringify({
                room: {
                    state: { types: ['m.room.name', 'm.room.member', 'm.room.canonical_alias', 'm.room.encryption'], lazy_load_members: true },
                    timeline: { limit: 1 },
                    account_data: { types: ['m.tag'] },
                },
            });

            try {
                const url = `${homeserver}/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(filter)}`;
                const message = Soup.Message.new('GET', url);
                message.request_headers.append('Authorization', `Bearer ${token}`);

                const bytes = await this._httpSession.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    this._cancellable,
                );

                if (message.status_code === 200) {
                    const response = JSON.parse(new TextDecoder().decode(bytes.toArray()));
                    this._processSync(response);
                }
                else {
                    console.warn(`[Matrix-Status] Sync failed with status: ${message.status_code}`);
                }
            }
            catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    console.error(`[Matrix-Status] Sync error: ${e.message}`);
                }
            }
        }

        /**
         * Process sync response and update menu/data state.
         * - Intelligent filtering: only unread or favorite rooms
         * - Sorting: based on last event timestamp (desc)
         */
        _processSync(data) {
            let roomList = [];
            let totalUnread = 0;

            if (data.rooms?.join) {
                for (const [roomId, roomData] of Object.entries(data.rooms.join)) {
                    const unreadNotifications = roomData.unread_notifications?.notification_count || 0;
                    const highlightCount = roomData.unread_notifications?.highlight_count || 0;
                    const unread = unreadNotifications + highlightCount;

                    if (unread > 0)
                        totalUnread += unread;

                    const hasFavTag = roomData.account_data?.events?.some(e => e.type === 'm.tag' && e.content?.tags?.['m.favourite']);

                    // Show room if it has unread messages OR it's a favorite
                    if (unread > 0 || hasFavTag) {
                        let name = null;
                        const nameEv = roomData.state?.events?.find(e => e.type === 'm.room.name');
                        if (nameEv?.content?.name)
                            name = nameEv.content.name;

                        if (!name && roomData.summary?.['m.heroes']?.length > 0) {
                            const heroes = roomData.summary['m.heroes'];
                            const heroNames = heroes.map(h => {
                                const m = roomData.state?.events?.find(e => e.type === 'm.room.member' && e.state_key === h);
                                return m?.content?.displayname || h.split(':')[0].replace('@', '');
                            });
                            name = heroNames.join(', ');
                        }

                        // Get timestamp from the last event for sorting
                        const lastEvent = roomData.timeline?.events?.[roomData.timeline.events.length - 1];
                        const timestamp = lastEvent?.origin_server_ts || 0;

                        const isEncrypted = roomData.state?.events?.some(e => e.type === 'm.room.encryption');

                        roomList.push({
                            name: name || 'Unnamed Room',
                            id: roomId,
                            unread,
                            timestamp,
                            encrypted: isEncrypted,
                        });
                    }
                }
            }

            if (totalUnread > 0) {
                this.add_style_class_name('matrix-pill-active');
            }
            else {
                this.remove_style_class_name('matrix-pill-active');
            }

            this._lastRooms = roomList;
            this._buildMenu(roomList);
        }
    });

/**
 * Main extension lifecycle management (enable/disable).
 * - Settings initialization
 * - Indicator creation and registration in the panel
 * - Timer (sync) management
 */
export default class MatrixExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new MatrixIndicator(this._settings, this.path);
        Main.panel.addToStatusArea('matrix-status', this._indicator);
        this._indicator.refresh();

        this._settings.connect('changed::sync-interval', () => this._restartTimer());
        this._settings.connect('changed::client-type', () => {
            // Rebuild menu immediately to reflect client change (e.g., show/hide Open Element)
            this._indicator?._buildMenu(this._indicator?._lastRooms ?? []);
        });
        this._restartTimer();
    }

    _restartTimer() {
        if (this._timeout) {
            clearInterval(this._timeout);
            this._timeout = null;
        }
        const interval = this._settings.get_int('sync-interval') * 1000;
        this._timeout = setInterval(() => this._indicator.refresh(), Math.max(interval, 5000));
    }

    disable() {
        if (this._timeout) {
            clearInterval(this._timeout);
            this._timeout = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}