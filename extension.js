/*
 * Matrix Status Monitor – GNOME Shell extension
 *
 * Goal: Lightweight navigation and notification layer for Matrix in the GNOME panel.
 * Style: Readability, maintainability, minimal dependencies.
 *
 * Note to contributors:
 * - Keep network calls (Soup.Session) and UI building (PopupMenu) clearly separated.
 * - All user settings are in GSettings (schemas/...).
 * - Targeted shell versions: GNOME 45–50.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { overview, messageTray, panel } from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

import MatrixSearchProvider from './provider.js'
import { MatrixClient } from './matrix.js';
import { NotificationManager } from './notification.js';
import * as Utils from './utils.js';
import { SETTINGS_KEYS, SYNC_FILTER } from './constants.js';
import { getClientById } from './clients/index.js';
import QRCode from './vendor/qrcode.js';

// ---------------------------------------------------------------------------
// MatrixIndicator
// ---------------------------------------------------------------------------

const MatrixIndicator = GObject.registerClass(
    class MatrixIndicator extends PanelMenu.Button {
        constructor(settings, extensionPath) {
            super(0.5, 'Matrix Status');

            this._settings = settings;
            this._path = extensionPath;
            this._matrixClient = new MatrixClient(settings);

            const iconPath = GLib.build_filenamev([this._path, 'icons', 'matrix.svg']);
            this._icon = Utils.createIcon(Gio.Icon.new_for_string(iconPath));
            this.add_child(this._icon);

            this._lastRooms = [];
            this._nextBatch = null;
            this._avatarCache = new Map();
            this._rooms = new Map();
            this._isInitialSync = true;
            this._isCacheLoaded = false;
            this._openQrRoomId = null;
            this._menuBuildSourceId = null;

            this._userId = null;
            this._displayName = null;
            this._profileAvatarUrl = null;

            this._notifiedEvents = new Map();
            this._visitCounts = this._loadVisitCounts();

            this._cachePath = GLib.build_filenamev([
                GLib.get_user_cache_dir(), 'matrix-status-extension',
            ]);
            GLib.mkdir_with_parents(this._cachePath, 0o755);

            this._loadCache();

            this._notifManager = new NotificationManager(settings, this._matrixClient, this._cachePath);
            this._notifManager.onNotificationActivated = (roomId) => {
                this._incrementVisitCount(roomId);
                this._openMatrixClient(roomId);
            };

            this._buildMenu([]);
        }

        destroy() {
            if (this._menuBuildSourceId) {
                GLib.source_remove(this._menuBuildSourceId);
                this._menuBuildSourceId = null;
            }
            this._notifManager?.destroy();
            this._notifManager = null;
            this._matrixClient.destroy();
            this._avatarCache.clear();
            this._rooms.clear();
            super.destroy();
        }

        // -----------------------------------------------------------------------
        // Visit count persistence
        // -----------------------------------------------------------------------

        _loadVisitCounts() {
            try {
                const raw = this._settings.get_string(SETTINGS_KEYS.VISIT_COUNTS).trim();
                if (!raw) return new Map();
                return new Map(Object.entries(JSON.parse(raw)));
            } catch (e) {
                Utils.warn(`Failed to load visit counts: ${e.message}`);
                return new Map();
            }
        }

        _saveVisitCounts() {
            try {
                this._settings.set_string(SETTINGS_KEYS.VISIT_COUNTS,
                    JSON.stringify(Object.fromEntries(this._visitCounts)));
            } catch (e) {
                Utils.warn(`Failed to save visit counts: ${e.message}`);
            }
        }

        // -----------------------------------------------------------------------
        // Cache persistence
        // -----------------------------------------------------------------------

        _getCacheFile() {
            return Gio.File.new_for_path(GLib.build_filenamev([this._cachePath, 'rooms.json']));
        }

        _loadCache() {
            try {
                const file = this._getCacheFile();
                if (!file.query_exists(null)) return;

                const [success, contents] = file.load_contents(null);
                if (!success) return;

                const cache = JSON.parse(new TextDecoder().decode(contents));
                if (cache.rooms) {
                    this._rooms = new Map(Object.entries(cache.rooms));
                    this._isCacheLoaded = true;
                    // Convert back to Array for _isSameRoomList and _scheduleMenuBuild
                    const roomList = Array.from(this._rooms.values());
                    this._lastRooms = roomList;
                    this._scheduleMenuBuild(roomList);
                }
                if (cache.nextBatch)
                    this._nextBatch = cache.nextBatch;
                if (cache.userId) this._userId = cache.userId;
                if (cache.displayName) this._displayName = cache.displayName;
                if (cache.profileAvatarUrl) this._profileAvatarUrl = cache.profileAvatarUrl;

            } catch (e) {
                Utils.warn(`Failed to load cache: ${e.message}`);
            }
        }

        _saveCache() {
            try {
                const file = this._getCacheFile();
                const cache = {
                    rooms: Object.fromEntries(this._rooms),
                    nextBatch: this._nextBatch,
                    userId: this._userId,
                    displayName: this._displayName,
                    profileAvatarUrl: this._profileAvatarUrl,
                };
                const contents = JSON.stringify(cache);
                file.replace_contents_async(
                    contents,
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null,
                    (f, res) => {
                        try {
                            f.replace_contents_finish(res);
                        } catch (e) {
                            Utils.warn(`Failed to save cache finish: ${e.message}`);
                        }
                    }
                );
            } catch (e) {
                Utils.warn(`Failed to save cache: ${e.message}`);
            }
        }

        _incrementVisitCount(roomId) {
            this._visitCounts.set(roomId, Number(this._visitCounts.get(roomId) || 0) + 1);
            this._saveVisitCounts();
        }

        // -----------------------------------------------------------------------
        // Network – identity and profile
        // -----------------------------------------------------------------------

        _openMatrixClient(roomId = null) {
            const t = this._settings.get_enum(SETTINGS_KEYS.CLIENT_TYPE);
            const client = getClientById(t);
            const uri = client.getUrl(roomId);

            try {
                Gio.AppInfo.launch_default_for_uri(uri, null);
            } catch (e) {
                Utils.error(`Failed to launch client: ${e.message}`);
            }
        }

        _copyToClipboard(text) {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        }


        // -----------------------------------------------------------------------
        // Network – identity and profile
        // -----------------------------------------------------------------------

        async _fetchIdentity() {
            try {
                const whoami = await this._matrixClient.whoami();
                if (whoami) {
                    this._userId = whoami.user_id;
                    const profile = await this._matrixClient.getProfile(this._userId);
                    if (profile) {
                        this._displayName = profile.displayname || null;
                        this._profileAvatarUrl = profile.avatar_url
                            ? this._matrixClient.getMxcThumbnailUrl(profile.avatar_url)
                            : null;
                    }
                    this._saveCache();
                }
            } catch (e) {
                Utils.error(`Identity fetch failed: ${e.message}`);
            }
        }

        // -----------------------------------------------------------------------
        // Avatar loader (rooms + profile share this)
        // -----------------------------------------------------------------------

        /**
         * Load an avatar from memory cache → disk cache → network.
         * Falls back to a symbolic icon on any failure.
         * iconSize defaults to 24 for rooms, pass 32 for the profile header.
         */
        async _loadAvatar(url, bin, fallbackIconName, iconSize = 24) {
            try {
                const urlHash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
                const cacheFile = Gio.File.new_for_path(
                    GLib.build_filenamev([this._cachePath, urlHash]));
                const cacheExists = cacheFile.query_exists(null);

                if (this._avatarCache.has(url)) {
                    if (bin && !bin.is_finalized)
                        bin.set_child(new St.Icon({
                            gicon: this._avatarCache.get(url),
                            icon_size: iconSize,
                            width: iconSize,
                            height: iconSize,
                            style_class: 'matrix-room-avatar',
                            x_align: Clutter.ActorAlign.CENTER,
                            y_align: Clutter.ActorAlign.CENTER,
                        }));
                    return;
                }

                if (cacheExists) {
                    const info = cacheFile.query_info('time::modified',
                        Gio.FileQueryInfoFlags.NONE, null);
                    const age = Math.floor(Date.now() / 1000) -
                        info.get_attribute_uint64('time::modified');
                    if (age < 3 * 3600) {
                        const gicon = Gio.FileIcon.new(cacheFile);
                        this._avatarCache.set(url, gicon);
                        if (bin && !bin.is_finalized)
                            bin.set_child(new St.Icon({
                                gicon,
                                icon_size: iconSize,
                                style_class: 'matrix-room-avatar',
                            }));
                        return;
                    }
                }

                const res = await this._matrixClient.fetchBytes(url);

                if (res && res.status === 200) {
                    const bytes = res.bytes;
                    cacheFile.replace_contents_async(
                        bytes.toArray(), null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, null,
                        (f, r) => {
                            try {
                                f.replace_contents_finish(r);
                            } catch (_e) {
                            }
                        });
                    const gicon = Gio.BytesIcon.new(bytes);
                    this._avatarCache.set(url, gicon);
                    if (bin && !bin.is_finalized)
                        bin.set_child(new St.Icon({
                            gicon,
                            icon_size: iconSize,
                            style_class: 'matrix-room-avatar',
                        }));
                    return;
                }

                if (cacheExists) {
                    const gicon = Gio.FileIcon.new(cacheFile);
                    if (bin && !bin.is_finalized)
                        bin.set_child(new St.Icon({
                            gicon,
                            icon_size: iconSize,
                            style_class: 'matrix-room-avatar',
                        }));
                    return;
                }

                throw new Error('Fetch failed');
            } catch (e) {
                Utils.warn(`Failed to load avatar: ${e.message}`);
                if (bin && !bin.is_finalized)
                    bin.set_child(new St.Icon({
                        icon_name: fallbackIconName,
                        icon_size: iconSize,
                        style_class: 'matrix-room-avatar-default',
                    }));
            }
        }

        // -----------------------------------------------------------------------
        // Profile header
        // -----------------------------------------------------------------------

        _buildProfileHeader() {
            if (!this._userId) return null;

            const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            headerItem.style_class = 'matrix-profile-header';

            const box = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'matrix-profile-box',
            });

            const avatarBin = new St.Bin({
                style_class: 'matrix-room-avatar-container matrix-profile-avatar',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                width: 38,
                height: 38,
                child: new St.Icon({
                    icon_name: 'avatar-default-symbolic',
                    icon_size: 32,
                    width: 38,
                    height: 38,
                    style_class: 'matrix-room-avatar-default',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
            box.add_child(avatarBin);

            if (this._profileAvatarUrl) {
                const spinner = new Animation.Spinner(24);
                spinner.x_align = Clutter.ActorAlign.CENTER;
                avatarBin.set_child(spinner);
                spinner.play();
                this._loadAvatar(this._profileAvatarUrl, avatarBin, 'avatar-default-symbolic', 32);
            }

            const textCol = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (this._displayName) {
                textCol.add_child(new St.Label({
                    text: this._displayName,
                    style_class: 'matrix-profile-displayname',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            textCol.add_child(new St.Label({
                text: this._userId,
                style_class: 'matrix-profile-userid',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            box.add_child(textCol);

            box.add_child(this._makeIconButton(
                'edit-copy-symbolic',
                'matrix-profile-action-btn',
                () => {
                    this._copyToClipboard(this._userId);
                    this.menu.close();
                }
            ));

            const isQrEnabled = this._settings.get_boolean('generate-qr-code-enable');

            const qrContainer = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'matrix-profile-qr-container',
            });
            const qrItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            qrItem.style_class = 'matrix-action-box-item matrix-profile-qr-item';
            qrItem.add_child(qrContainer);
            qrItem.visible = false;

            if (isQrEnabled) {
                box.add_child(this._makeIconButton(
                    'qr-code-symbolic',
                    'matrix-profile-action-btn',
                    () => {
                        const opening = !qrItem.visible;
                        qrItem.visible = opening;
                        if (!opening) {
                            qrContainer.get_children().forEach(c => c.destroy());
                        } else {
                            this._fillQrContainerForUrl(
                                qrContainer,
                                `https://matrix.to/#/${this._userId}`,
                                this._userId
                            );
                        }
                    }
                ));
            }

            headerItem.add_child(box);
            return {headerItem, qrItem};
        }

        _makeIconButton(iconName, styleClass, callback) {
            const btn = new St.Button({
                child: new St.Icon({icon_name: iconName, icon_size: 14}),
                style_class: `button ${styleClass}`,
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            btn.connect('clicked', callback);
            return btn;
        }

        _getMatrixToUrlFor(room) {
            return `https://matrix.to/#/${Utils.getPrettyId(room)}`;
        }

        async _fillQrContainerForUrl(container, dataUrl, labelText) {
            container.get_children().forEach(c => c.destroy());

            const spinner = new Animation.Spinner(16);
            spinner.x_align = Clutter.ActorAlign.CENTER;
            container.add_child(spinner);
            spinner.play();

            try {
                const qrCode = new QRCode({
                    content: dataUrl,
                    padding: 1,
                    width: 256,
                    height: 256,
                    color: '#000000',
                    background: '#ffffff',
                    ecl: 'M',
                });

                const [file, stream] = Gio.File.new_tmp('matrix-qr-XXXXXX.svg');
                const svgData = qrCode.svg();
                await new Promise((resolve, reject) => {
                    file.replace_contents_async(
                        new TextEncoder().encode(svgData),
                        null,
                        false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION,
                        null,
                        (f, r) => {
                            try {
                                f.replace_contents_finish(r);
                                resolve();
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });

                spinner.destroy();

                const qrWidget = new St.Widget({
                    style_class: 'matrix-qr-image',
                    style: `
                        background-image: url("${file.get_uri()}");
                        background-size: contain;
                        width: 180px;
                        height: 180px;
                    `,
                    x_align: Clutter.ActorAlign.CENTER,
                });
                container.add_child(qrWidget);

                // We keep a reference to delete the file when the widget is destroyed
                qrWidget.connect('destroy', () => {
                    try {
                        file.delete_async(GLib.PRIORITY_LOW, null, null);
                    } catch (e) {
                        Utils.warn(`Failed to delete temp QR file: ${e.message}`);
                    }
                });

                const idRow = new St.BoxLayout({
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                    style_class: 'matrix-qr-id-row',
                });
                idRow.add_child(new St.Label({
                    text: labelText,
                    style_class: 'matrix-qr-id-label',
                    y_align: Clutter.ActorAlign.CENTER,
                }));

                const copyBtn = new St.Button({
                    child: new St.Icon({icon_name: 'edit-copy-symbolic', icon_size: 14}),
                    style_class: 'button matrix-qr-copy-button',
                    can_focus: true,
                });
                copyBtn.connect('clicked', () => {
                    this._copyToClipboard(labelText);
                    this.menu.close();
                });
                idRow.add_child(copyBtn);
                container.add_child(idRow);
            } catch (e) {
                try {
                    spinner.destroy();
                } catch (err) {
                    Utils.warn(`Failed to destroy spinner: ${err.message}`);
                }

                Utils.error(`QR generation error: ${e.message}`);
                container.add_child(new St.Label({
                    text: 'Error generating QR code',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            }
        }

        async _toggleActionBox(room, roomItem) {
            try {
                if (this._openQrRoomId === room.id) {
                    roomItem._actionItem?.destroy();
                    roomItem._actionItem = null;
                    this._openQrRoomId = null;
                    return;
                }

                if (this._openQrRoomId) {
                    for (const item of this.menu._getMenuItems()) {
                        if (item._actionItem) {
                            item._actionItem.destroy();
                            item._actionItem = null;
                        }

                        const btn = item.get_children?.()?.find(
                            c => c instanceof St.Button &&
                                c.has_style_class_name('matrix-action-button'));
                        if (btn?.child instanceof St.Icon)
                            btn.child.icon_name = 'qr-code-symbolic';
                    }
                }

                this._openQrRoomId = room.id;
                this._createActionBox(room, roomItem);
            } catch (e) {
                Utils.error(`Action box error: ${e.message}`);
            }
        }

        _createActionBox(room, roomItem) {
            const actionItem = new PopupMenu.PopupBaseMenuItem({reactive: true, can_focus: false});
            actionItem.style_class = 'matrix-action-box-item';

            const qrContainer = new St.BoxLayout({vertical: true, x_expand: true});
            actionItem.add_child(qrContainer);

            const items = this.menu._getMenuItems();
            this.menu.addMenuItem(actionItem, items.indexOf(roomItem) + 1);
            roomItem._actionItem = actionItem;

            this._fillQrContainerForUrl(
                qrContainer,
                this._getMatrixToUrlFor(room),
                Utils.getPrettyId(room)
            );
        }

        _computeRoomWeight(room) {
            if (room.isMuted) return -2000;
            let w = 0;
            if (room.isDirect && room.highlightCount > 0) w += 1600;
            else if (room.isDirect && room.unread > 0) w += 1200;
            if (room.highlightCount > 0) w += 1000 + Math.min(room.highlightCount * 50, 300);
            if (room.unread > 0) w += 500 + Math.min(room.unread * 15, 250);
            if (room.isFavorite) w += 180;
            w += Math.min(Number(this._visitCounts.get(room.id) || 0) * 12, 240);
            if (room.timestamp > 0) {
                const hoursSince = (Date.now() - room.timestamp) / 3_600_000;
                w += Math.max(0, 120 - Math.min(hoursSince, 120));
            }
            if (room.id === this._openQrRoomId) w += 400;
            return w;
        }

        _sortRooms(rooms) {
            return [...rooms].sort((a, b) => {
                const d = this._computeRoomWeight(b) - this._computeRoomWeight(a);
                if (d !== 0) return d;
                const t = (b.timestamp || 0) - (a.timestamp || 0);
                if (t !== 0) return t;
                return a.name.localeCompare(b.name);
            });
        }

        _isIdleRoom(room) {
            return room.isMuted || this._computeRoomWeight(room) <= 0;
        }

        _scheduleMenuBuild(roomList) {
            if (this._menuBuildSourceId) {
                GLib.source_remove(this._menuBuildSourceId);
                this._menuBuildSourceId = null;
            }

            this._menuBuildSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._menuBuildSourceId = null;
                if (!this._matrixClient || !this._matrixClient.cancellable || this._matrixClient.cancellable.is_cancelled())
                    return GLib.SOURCE_REMOVE;
                
                this._buildMenu(roomList);
                return GLib.SOURCE_REMOVE;
            });
        }

        _buildMenu(rooms = []) {
            this.menu.removeAll();

            if (this._userId) {
                const result = this._buildProfileHeader();
                if (result) {
                    this.menu.addMenuItem(result.headerItem);
                    this.menu.addMenuItem(result.qrItem);
                    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                }
            }

            if (rooms.length === 0) {
                const label = (this._isInitialSync && !this._isCacheLoaded)
                    ? 'Connecting to Matrix...'
                    : 'No Active Messages';
                const item = new PopupMenu.PopupMenuItem(label);
                item.sensitive = false;
                this.menu.addMenuItem(item);
            } else {
                const sorted = this._sortRooms(rooms);
                const firstIdleIdx = sorted.findIndex(r => this._isIdleRoom(r));
                let separatorInserted = false;
                const isQrEnabled = this._settings.get_boolean('generate-qr-code-enable');

                sorted.forEach((room, index) => {
                    if (!separatorInserted && firstIdleIdx !== -1 && index === firstIdleIdx) {
                        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Idle'));
                        separatorInserted = true;
                    }

                    const item = new PopupMenu.PopupMenuItem('', {activate: true});

                    const iconContainer = new St.BoxLayout({
                        style_class: 'matrix-icon-container',
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    const avatarBin = new St.Bin({
                        style_class: 'matrix-room-avatar-container',
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                        width: 28,
                        height: 28,
                    });
                    const fallback = room.isDirect
                        ? 'avatar-default-symbolic'
                        : 'system-users-symbolic';

                    if (room.avatarUrl) {
                        const sp = new Animation.Spinner(24);
                        sp.add_style_class_name('matrix-avatar-spinner');
                        avatarBin.set_child(sp);
                        sp.play();
                        this._loadAvatar(room.avatarUrl, avatarBin, fallback, 24);
                    } else {
                        avatarBin.set_child(new St.Icon({
                            icon_name: fallback,
                            icon_size: 24,
                            style_class: 'matrix-room-avatar-default',
                        }));
                    }

                    iconContainer.add_child(avatarBin);
                    iconContainer.add_child(new St.Icon({
                        icon_name: 'changes-prevent-symbolic',
                        style_class: 'matrix-lock-icon',
                        icon_size: 14,
                        opacity: room.encrypted ? 255 : 0,
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                    }));
                    item.insert_child_at_index(iconContainer, 0);

                    const escaped = GLib.markup_escape_text(room.name, -1);
                    let labelText;
                    if (room.highlightCount > 0)
                        labelText = `<b>(${room.unread}) ${escaped}</b>`;
                    else if (room.unread > 0)
                        labelText = `(${room.unread}) ${escaped}`;
                    else
                        labelText = escaped;

                    item.label.get_clutter_text().set_markup(labelText);
                    item.label.x_expand = true;

                    const actionButton = new St.Button({
                        child: new St.Icon({
                            icon_name: isQrEnabled
                                ? (this._openQrRoomId === room.id
                                    ? 'view-conceal-symbolic'
                                    : 'qr-code-symbolic')
                                : 'edit-copy-symbolic',
                            icon_size: 14,
                        }),
                        style_class: 'button matrix-action-button',
                        can_focus: true,
                        y_align: Clutter.ActorAlign.CENTER,
                    });

                    actionButton.connect('clicked', () => {
                        if (isQrEnabled) {
                            this._toggleActionBox(room, item);
                            actionButton.child.icon_name = this._openQrRoomId === room.id
                                ? 'view-conceal-symbolic' : 'qr-code-symbolic';
                        } else {
                            this._copyToClipboard(Utils.getPrettyId(room));
                            this.menu.close();
                        }
                        return Clutter.EVENT_STOP;
                    });

                    item.add_child(actionButton);
                    item.connect('activate', () => {
                        this._incrementVisitCount(room.id);
                        this._openMatrixClient(room.id);
                    });

                    this.menu.addMenuItem(item);

                    if (isQrEnabled && this._openQrRoomId === room.id)
                        this._createActionBox(room, item);
                });
            }

            const clientType = this._settings.get_enum(SETTINGS_KEYS.CLIENT_TYPE);
            if (clientType >= 0 && clientType <= 4) {
                const client = getClientById(clientType);

                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                const launchItem = new PopupMenu.PopupMenuItem(`Open ${client.name}`);
                const gfile = Gio.File.new_for_path(
                    GLib.build_filenamev([this._path, 'icons', client.icon]));
                const clientIcon = Utils.createIcon(Gio.FileIcon.new(gfile));
                launchItem.remove_child(launchItem.label);
                launchItem.insert_child_at_index(clientIcon, 0);
                launchItem.add_child(launchItem.label);
                launchItem.connect('activate', () => this._openMatrixClient());
                this.menu.addMenuItem(launchItem);
            }
        }

        async refresh() {
            try {
                const response = await this._matrixClient.sync(this._nextBatch, SYNC_FILTER);
                this._isInitialSync = false;
                if (response) {
                    if (response.next_batch)
                        this._nextBatch = response.next_batch;

                    if (!this._userId)
                        await this._fetchIdentity();

                    this._processSync(response);
                    this._saveCache();
                }
            } catch (e) {
                this._isInitialSync = false;
                if (e.message === 'AUTH_ERROR') {
                    Utils.warn('Auth failed. Resetting sync token.');
                    this._nextBatch = null;
                } else {
                    Utils.error(`Sync error: ${e.message}`);
                }
            }
        }

        _isSameRoomList(newList) {
            if (this._lastRooms.length !== newList.length) return false;
            for (let i = 0; i < newList.length; i++) {
                const a = this._lastRooms[i], b = newList[i];
                if (a.id !== b.id || a.unread !== b.unread || a.highlightCount !== b.highlightCount ||
                    a.name !== b.name || a.encrypted !== b.encrypted || a.avatarUrl !== b.avatarUrl ||
                    a.isMuted !== b.isMuted || a.isFavorite !== b.isFavorite)
                    return false;
            }
            return true;
        }

        _processSync(data) {
            if (!this._rooms) this._rooms = new Map();

            if (data.rooms?.join) {
                for (const [roomId, roomData] of Object.entries(data.rooms.join)) {
                    const highlightCount = roomData.unread_notifications?.highlight_count || 0;
                    const unreadNotifications = roomData.unread_notifications?.notification_count || 0;
                    const unread = unreadNotifications + highlightCount;

                    const hasFavTag = roomData.account_data?.events?.some(
                        e => e.type === 'm.tag' && e.content?.tags?.['m.favourite']);
                    const hasLowPriority = roomData.account_data?.events?.some(
                        e => e.type === 'm.tag' && e.content?.tags?.['m.lowpriority']);

                    const existing = this._rooms.get(roomId);

                    let name = existing?.name || null;
                    let dmPartnerId = existing?.dmPartnerId || null;
                    let canonicalAlias = existing?.canonicalAlias || null;
                    let isEncrypted = existing?.encrypted || false;
                    let isDirect = existing?.isDirect || false;
                    let avatarUrl = existing?.avatarUrl || null;
                    let timestamp = existing?.timestamp || 0;
                    let isFavorite = hasFavTag || existing?.isFavorite || false;
                    let isMuted = hasLowPriority || existing?.isMuted || false;

                    const nameEv = roomData.state?.events?.find(e => e.type === 'm.room.name');
                    if (nameEv?.content?.name) name = nameEv.content.name;

                    const aliasEv = roomData.state?.events?.find(
                        e => e.type === 'm.room.canonical_alias');
                    if (aliasEv?.content?.alias) canonicalAlias = aliasEv.content.alias;

                    if (roomData.state?.events?.some(e => e.type === 'm.room.encryption'))
                        isEncrypted = true;
                    if (roomData.is_direct !== undefined) isDirect = roomData.is_direct;

                    if (roomData.summary?.['m.heroes']?.length > 0) {
                        const heroes = roomData.summary['m.heroes'];
                        if (!name && heroes.length === 1) {
                            dmPartnerId = heroes[0];
                            isDirect = true;
                        }
                        if (!name) {
                            name = heroes.map(h => {
                                const m = roomData.state?.events?.find(
                                    e => e.type === 'm.room.member' && e.state_key === h);
                                return m?.content?.displayname || h.split(':')[0].replace('@', '');
                            }).join(', ');
                        }
                    }

                    const lastEvent = roomData.timeline?.events?.[roomData.timeline.events.length - 1];
                    if (lastEvent?.origin_server_ts) timestamp = lastEvent.origin_server_ts;

                    const avatarEv = roomData.state?.events?.find(e => e.type === 'm.room.avatar');
                    if (avatarEv?.content?.url)
                        avatarUrl = this._matrixClient.getMxcThumbnailUrl(avatarEv.content.url);

                    if (!avatarUrl && isDirect) {
                        const partnerHero = roomData.summary?.['m.heroes']?.find(
                            h => this._userId && h !== this._userId);
                        if (partnerHero) {
                            const memberEv = roomData.state?.events?.find(
                                e => e.type === 'm.room.member' && e.state_key === partnerHero);
                            if (memberEv?.content?.avatar_url)
                                avatarUrl = this._matrixClient.getMxcThumbnailUrl(memberEv.content.avatar_url);
                        }
                    }
                    if (!avatarUrl && this._userId) {
                        const anyMember = roomData.state?.events?.find(
                            e => e.type === 'm.room.member' &&
                                e.content?.avatar_url &&
                                e.state_key !== this._userId);
                        if (anyMember?.content?.avatar_url)
                            avatarUrl = this._matrixClient.getMxcThumbnailUrl(anyMember.content.avatar_url);
                    }

                    const updatedRoom = {
                        name: name || 'Unnamed Room',
                        id: roomId, dmPartnerId, canonicalAlias,
                        unread, highlightCount, timestamp,
                        encrypted: isEncrypted, isDirect, avatarUrl,
                        isFavorite, isMuted,
                    };

                    this._rooms.set(roomId, updatedRoom);

                    if (!this._isInitialSync && unread > 0 && lastEvent) {
                        const eventId = lastEvent.event_id;
                        if (eventId) {
                            const senderId = lastEvent.sender || '';
                            const senderName = senderId.split(':')[0].replace('@', '') || senderId;
                            
                            // Check for redaction
                            const isRedacted = roomData.timeline?.events?.some(e => 
                                e.type === 'm.room.redaction' && e.redacts === eventId);
                            
                            if (!isRedacted) {
                                const body = lastEvent.content?.body ||
                                    lastEvent.content?.msgtype || '…';
                                const urgency = updatedRoom.highlightCount > 0
                                    ? MessageTray.Urgency.HIGH
                                    : MessageTray.Urgency.NORMAL;
                                
                                this._notifManager.showNotification({
                                    room: updatedRoom,
                                    senderName: senderName,
                                    body: body,
                                    eventId: eventId,
                                    urgency: urgency,
                                    type: lastEvent.type,
                                    msgtype: lastEvent.content?.msgtype,
                                })
                                    .catch(e => Utils.warn(`[Matrix-Status] Failed to show notification: ${e.message}`));
                            }
                        }
                    }
                }
            }

            const roomList = this._sortRooms(
                Array.from(this._rooms.values()).filter(
                    r => r.unread > 0 || r.isFavorite || r.isMuted || r.id === this._openQrRoomId)
            );

            const totalUnread = roomList.reduce((acc, r) => acc + r.unread, 0);
            if (totalUnread > 0) this.add_style_class_name('matrix-pill-active');
            else this.remove_style_class_name('matrix-pill-active');

            if (!this._isSameRoomList(roomList)) {
                this._lastRooms = roomList;
                this._scheduleMenuBuild(roomList);
            }
        }
    });

export default class MatrixExtension extends Extension {
    #provider = null
    enable() {
        this._settings = this.getSettings();
        this._indicator = new MatrixIndicator(this._settings, this.path);
        panel.addToStatusArea('matrix-status', this._indicator);

        this.#provider = new MatrixSearchProvider(this._indicator);
        if (overview.searchController)
            overview.searchController.addProvider(this.#provider);
        this._indicator.refresh();

        this._settings.connect(`changed::${SETTINGS_KEYS.SYNC_INTERVAL}`, () => this._restartTimer());

        const rebuildMenu = () => {
            this._indicator?._scheduleMenuBuild(this._indicator?._lastRooms ?? []);
        };
        this._settings.connect(`changed::${SETTINGS_KEYS.CLIENT_TYPE}`, rebuildMenu);
        this._settings.connect(`changed::${SETTINGS_KEYS.GENERATE_QR_ENABLE}`, rebuildMenu);
        this._settings.connect(`changed::${SETTINGS_KEYS.NOTIFICATIONS_ENABLE}`, rebuildMenu);

        this._restartTimer();
    }

    _restartTimer() {
        if (this._timeout) {
            clearInterval(this._timeout);
            this._timeout = null;
        }
        const interval = this._settings.get_int(SETTINGS_KEYS.SYNC_INTERVAL) * 1000;
        this._timeout = setInterval(
            () => this._indicator.refresh(), Math.max(interval, 5000));
    }

    disable() {
        if (overview.searchController)
            overview.searchController.removeProvider(this.#provider);
        if (this._timeout) {
            clearInterval(this._timeout);
            this._timeout = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this.#provider = null
        this._settings = null;
    }
}