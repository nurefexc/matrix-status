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
import Soup from 'gi://Soup';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

const VISIT_COUNTS_KEY = 'visit-counts';

// ---------------------------------------------------------------------------
// MatrixIndicator
// ---------------------------------------------------------------------------

const MatrixIndicator = GObject.registerClass(
    class MatrixIndicator extends PanelMenu.Button {
        _init(settings, extensionPath) {
            super._init(0.5, 'Matrix Status');

            this._settings = settings;
            this._path = extensionPath;
            this._httpSession = new Soup.Session();
            this._cancellable = new Gio.Cancellable();

            const iconPath = GLib.build_filenamev([this._path, 'icons', 'matrix.svg']);
            this.icon = new St.Icon({
                gicon: Gio.Icon.new_for_string(iconPath),
                style_class: 'system-status-icon',
                icon_size: 16,
            });
            this.add_child(this.icon);

            this._lastRooms = [];
            this._nextBatch = null;
            this._avatarCache = new Map();
            this._rooms = new Map();
            this._isInitialSync = true;
            this._openQrRoomId = null;
            this._menuBuildSourceId = null;

            // Profile info
            this._userId = null;
            this._displayName = null;
            this._profileAvatarUrl = null;

            // Notification deduplication – roomId → last notified event_id
            this._notifiedEvents = new Map();
            this._notifSource = null;

            this._visitCounts = this._loadVisitCounts();

            this._cachePath = GLib.build_filenamev([
                GLib.get_user_cache_dir(), 'matrix-status-extension',
            ]);
            GLib.mkdir_with_parents(this._cachePath, 0o755);

            this._buildMenu([]);
        }

        destroy() {
            if (this._menuBuildSourceId) {
                GLib.source_remove(this._menuBuildSourceId);
                this._menuBuildSourceId = null;
            }
            this._notifSource?.destroy();
            this._notifSource = null;
            this._cancellable.cancel();
            this._httpSession.abort();
            this._avatarCache.clear();
            this._rooms.clear();
            super.destroy();
        }

        // -----------------------------------------------------------------------
        // Visit count persistence
        // -----------------------------------------------------------------------

        _loadVisitCounts() {
            try {
                const raw = this._settings.get_string(VISIT_COUNTS_KEY).trim();
                if (!raw) return new Map();
                return new Map(Object.entries(JSON.parse(raw)));
            } catch (e) {
                console.warn(`[Matrix-Status] Failed to load visit counts: ${e.message}`);
                return new Map();
            }
        }

        _saveVisitCounts() {
            try {
                this._settings.set_string(VISIT_COUNTS_KEY,
                    JSON.stringify(Object.fromEntries(this._visitCounts)));
            } catch (e) {
                console.warn(`[Matrix-Status] Failed to save visit counts: ${e.message}`);
            }
        }

        _incrementVisitCount(roomId) {
            this._visitCounts.set(roomId, Number(this._visitCounts.get(roomId) || 0) + 1);
            this._saveVisitCounts();
        }

        // -----------------------------------------------------------------------
        // Desktop notifications
        // -----------------------------------------------------------------------

        _ensureNotifSource() {
            if (this._notifSource && !this._notifSource.isDestroyed()) return;
            this._notifSource = new MessageTray.Source({
                title: 'Matrix',
                icon_name: 'user-available-symbolic',
            });
            this._notifSource.connect('destroy', () => {
                this._notifSource = null;
            });
            Main.messageTray.add(this._notifSource);
        }

        _showNotification(room, senderName, body, eventId) {
            if (!this._settings.get_boolean('notifications-enable')) return;
            if (!eventId) return;
            if (this._notifiedEvents.get(room.id) === eventId) return;
            this._notifiedEvents.set(room.id, eventId);

            this._ensureNotifSource();

            const notif = new MessageTray.Notification({
                source: this._notifSource,
                title: room.name,
                body: `${senderName}: ${body}`,
                isTransient: true,
                urgency: room.highlightCount > 0
                    ? MessageTray.Urgency.HIGH
                    : MessageTray.Urgency.NORMAL,
            });
            notif.connect('activated', () => {
                this._incrementVisitCount(room.id);
                this._openMatrixClient(room.id);
            });
            this._notifSource.addNotification(notif);
        }

        // -----------------------------------------------------------------------
        // URL / client helpers
        // -----------------------------------------------------------------------

        _getWebUrl(roomId = null) {
            return roomId ? `https://matrix.to/#/${roomId}` : 'https://matrix.to';
        }

        _getElementUrl(roomId = null) {
            return roomId ? `element://vector/webapp/#/room/${roomId}` : 'element://';
        }

        _getSchildiChatUrl(roomId = null) {
            return roomId ? `schildichat://vector/webapp/#/room/${roomId}` : 'schildichat://';
        }

        /**
         * Build a Fractal-compatible matrix: URI for a given room.
         * Format: matrix:roomid/<encoded-id>?action=join&via=<domain>
         */
        _getFractalUrl(roomId = null) {
            if (!roomId) return 'matrix:';
            const cleanId = roomId.startsWith('!') ? roomId.slice(1) : roomId;
            const encodedId = cleanId.replace(/:/g, '%3A');
            const via = cleanId.includes(':') ? `&via=${cleanId.split(':')[1]}` : '';
            return `matrix:roomid/${encodedId}?action=join${via}`;
        }

        _openMatrixClient(roomId = null) {
            const t = this._settings.get_enum('client-type');
            const uri = t === 3 ? this._getSchildiChatUrl(roomId)
                : t === 2 ? this._getFractalUrl(roomId)
                    : t === 1 ? this._getElementUrl(roomId)
                        : this._getWebUrl(roomId);
            Gio.AppInfo.launch_default_for_uri(uri, null);
        }

        _copyToClipboard(text) {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        }

        /**
         * Convert an mxc:// URL into an authenticated thumbnail URL.
         * Uses the modern /client/v1/media/ path; fallbacks are handled in _loadAvatar.
         */
        _getMxcThumbnailUrl(mxcUrl) {
            if (!mxcUrl?.startsWith('mxc://')) return null;
            let base = this._settings.get_string('homeserver-url').trim();
            if (!base) return null;
            if (!base.startsWith('http')) base = `https://${base}`;
            base = base.replace(/\/$/, '');
            const parts = mxcUrl.replace('mxc://', '').split('/');
            if (parts.length < 2) return null;
            return `${base}/_matrix/client/v1/media/thumbnail/${parts[0]}/${parts.slice(1).join('/')}?width=96&height=96&method=crop`;
        }

        _getPrettyId(room) {
            return room.dmPartnerId || room.canonicalAlias || room.id;
        }

        // -----------------------------------------------------------------------
        // Network – identity and profile
        // -----------------------------------------------------------------------

        async _fetchWhoAmI(homeserver, token) {
            try {
                const msg = Soup.Message.new('GET',
                    `${homeserver}/_matrix/client/v3/account/whoami`);
                msg.request_headers.append('Authorization', `Bearer ${token}`);
                const bytes = await this._httpSession.send_and_read_async(
                    msg, GLib.PRIORITY_DEFAULT, this._cancellable);
                if (msg.status_code === 200) {
                    const r = JSON.parse(new TextDecoder().decode(bytes.toArray()));
                    this._userId = r.user_id;
                }
            } catch (_e) { /* non-critical */
            }
        }

        /**
         * Fetch the full profile in a single request:
         * displayname + avatar_url (mxc://) → converted to thumbnail URL.
         */
        async _fetchProfile(homeserver, token) {
            if (!this._userId) return;
            try {
                const url = `${homeserver}/_matrix/client/v3/profile/${encodeURIComponent(this._userId)}`;
                const msg = Soup.Message.new('GET', url);
                msg.request_headers.append('Authorization', `Bearer ${token}`);
                const bytes = await this._httpSession.send_and_read_async(
                    msg, GLib.PRIORITY_DEFAULT, this._cancellable);
                if (msg.status_code === 200) {
                    const r = JSON.parse(new TextDecoder().decode(bytes.toArray()));
                    this._displayName = r.displayname || null;
                    this._profileAvatarUrl = r.avatar_url
                        ? this._getMxcThumbnailUrl(r.avatar_url)
                        : null;
                }
            } catch (_e) { /* non-critical */
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

                const token = this._settings.get_string('access-token').trim();
                const tryFetch = async fetchUrl => {
                    const m = Soup.Message.new('GET', fetchUrl);
                    if (token) m.request_headers.append('Authorization', `Bearer ${token}`);
                    const b = await this._httpSession.send_and_read_async(
                        m, GLib.PRIORITY_DEFAULT, this._cancellable);
                    return {status: m.status_code, bytes: b};
                };

                let res = await tryFetch(url);
                if (res.status !== 200 && url.includes('/client/v1/media/'))
                    res = await tryFetch(url.replace('/client/v1/media/', '/media/v3/'));
                if (res.status !== 200)
                    res = await tryFetch(
                        url.replace('/client/v1/media/', '/media/r0/')
                            .replace('/v3/', '/r0/'));

                if (res.status === 200) {
                    cacheFile.replace_contents_async(
                        res.bytes.toArray(), null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, null,
                        (f, r) => {
                            try {
                                f.replace_contents_finish(r);
                            } catch (_e) {
                            }
                        });
                    const gicon = Gio.BytesIcon.new(res.bytes);
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

                throw new Error(`HTTP ${res.status}`);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    if (bin && !bin.is_finalized)
                        bin.set_child(new St.Icon({
                            icon_name: fallbackIconName,
                            icon_size: iconSize,
                            style_class: 'matrix-room-avatar-default',
                        }));
                }
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
            return `https://matrix.to/#/${this._getPrettyId(room)}`;
        }

        async _fillQrContainerForUrl(container, dataUrl, labelText) {
            container.get_children().forEach(c => c.destroy());

            const spinner = new Animation.Spinner(16);
            spinner.x_align = Clutter.ActorAlign.CENTER;
            container.add_child(spinner);
            spinner.play();

            try {
                const url = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(dataUrl)}`;
                const msg = Soup.Message.new('GET', url);
                const bytes = await this._httpSession.send_and_read_async(
                    msg, GLib.PRIORITY_DEFAULT, this._cancellable);
                spinner.destroy();

                if (msg.status_code !== 200) {
                    container.add_child(new St.Label({
                        text: 'Error generating QR code',
                        x_align: Clutter.ActorAlign.CENTER,
                    }));
                    return;
                }

                container.add_child(new St.Icon({
                    gicon: Gio.BytesIcon.new(bytes),
                    icon_size: 160,
                    x_align: Clutter.ActorAlign.CENTER,
                    style_class: 'matrix-qr-image',
                }));

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
                } catch (_) {
                }

                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(`[Matrix-Status] QR generation error: ${e.message}`);
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
                    for (const item of this.menu.getMenuItems()) {
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
                console.error(`[Matrix-Status] Action box error: ${e.message}`);
            }
        }

        _createActionBox(room, roomItem) {
            const actionItem = new PopupMenu.PopupBaseMenuItem({reactive: true, can_focus: false});
            actionItem.style_class = 'matrix-action-box-item';

            const qrContainer = new St.BoxLayout({vertical: true, x_expand: true});
            actionItem.add_child(qrContainer);

            const items = this.menu.getMenuItems();
            this.menu.addMenuItem(actionItem, items.indexOf(roomItem) + 1);
            roomItem._actionItem = actionItem;

            this._fillQrContainerForUrl(
                qrContainer,
                this._getMatrixToUrlFor(room),
                this._getPrettyId(room)
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
                if (!this._cancellable.is_cancelled())
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
                const item = new PopupMenu.PopupMenuItem(
                    this._isInitialSync ? 'Synchronizing...' : 'No Active Messages');
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
                            this._copyToClipboard(this._getPrettyId(room));
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

            const clientType = this._settings.get_enum('client-type');
            if (clientType >= 1 && clientType <= 3) {
                const cfg = {
                    1: {name: 'Element', icon: 'element.svg'},
                    2: {name: 'Fractal', icon: 'fractal.svg'},
                    3: {name: 'SchildiChat', icon: 'schildichat.svg'},
                }[clientType];

                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                const launchItem = new PopupMenu.PopupMenuItem(`Open ${cfg.name}`);
                const gfile = Gio.File.new_for_path(
                    GLib.build_filenamev([this._path, 'icons', cfg.icon]));
                const clientIcon = new St.Icon({gicon: Gio.FileIcon.new(gfile), icon_size: 16});
                launchItem.remove_child(launchItem.label);
                launchItem.insert_child_at_index(clientIcon, 0);
                launchItem.add_child(launchItem.label);
                launchItem.connect('activate', () => this._openMatrixClient());
                this.menu.addMenuItem(launchItem);
            }
        }

        async refresh() {
            let homeserver = this._settings.get_string('homeserver-url').trim();
            const token = this._settings.get_string('access-token').trim();
            if (!token || !homeserver) return;
            if (!homeserver.startsWith('http')) homeserver = `https://${homeserver}`;
            homeserver = homeserver.replace(/\/$/, '');

            const filter = JSON.stringify({
                room: {
                    state: {
                        types: [
                            'm.room.name', 'm.room.member', 'm.room.canonical_alias',
                            'm.room.encryption', 'm.room.avatar',
                        ],
                        lazy_load_members: true,
                    },
                    timeline: {limit: 1},
                    account_data: {types: ['m.tag']},
                },
            });

            try {
                let url = `${homeserver}/_matrix/client/v3/sync?timeout=30000&filter=${encodeURIComponent(filter)}`;
                if (this._nextBatch) url += `&since=${this._nextBatch}`;

                const msg = Soup.Message.new('GET', url);
                msg.request_headers.append('Authorization', `Bearer ${token}`);
                const bytes = await this._httpSession.send_and_read_async(
                    msg, GLib.PRIORITY_DEFAULT, this._cancellable);

                if (msg.status_code === 200) {
                    const response = JSON.parse(new TextDecoder().decode(bytes.toArray()));
                    if (response.next_batch) this._nextBatch = response.next_batch;

                    if (!this._userId) {
                        await this._fetchWhoAmI(homeserver, token);
                        await this._fetchProfile(homeserver, token);
                    }

                    this._processSync(response);
                    this._isInitialSync = false;
                } else if (msg.status_code === 401 || msg.status_code === 403) {
                    console.warn(`[Matrix-Status] Auth failed (${msg.status_code}). Resetting sync token.`);
                    this._nextBatch = null;
                } else {
                    console.warn(`[Matrix-Status] Sync failed with status: ${msg.status_code}`);
                }
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(`[Matrix-Status] Sync error: ${e.message}`);
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
                        avatarUrl = this._getMxcThumbnailUrl(avatarEv.content.url);

                    if (!avatarUrl && isDirect) {
                        const partnerHero = roomData.summary?.['m.heroes']?.find(
                            h => this._userId && h !== this._userId);
                        if (partnerHero) {
                            const memberEv = roomData.state?.events?.find(
                                e => e.type === 'm.room.member' && e.state_key === partnerHero);
                            if (memberEv?.content?.avatar_url)
                                avatarUrl = this._getMxcThumbnailUrl(memberEv.content.avatar_url);
                        }
                    }
                    if (!avatarUrl && this._userId) {
                        const anyMember = roomData.state?.events?.find(
                            e => e.type === 'm.room.member' &&
                                e.content?.avatar_url &&
                                e.state_key !== this._userId);
                        if (anyMember?.content?.avatar_url)
                            avatarUrl = this._getMxcThumbnailUrl(anyMember.content.avatar_url);
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
                        if (eventId && eventId !== this._notifiedEvents.get(roomId)) {
                            const senderId = lastEvent.sender || '';
                            const senderName = senderId.split(':')[0].replace('@', '') || senderId;
                            const body = lastEvent.content?.body ||
                                lastEvent.content?.msgtype || '…';
                            this._showNotification(updatedRoom, senderName, body, eventId);
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

// ---------------------------------------------------------------------------
// MatrixSearchProvider
// ---------------------------------------------------------------------------

const MatrixSearchProvider = GObject.registerClass(
    class MatrixSearchProvider extends GObject.Object {
        _init(indicator) {
            super._init();
            this._indicator = indicator;
            this.id = 'matrix-status-search-provider';

            const iconPath = GLib.build_filenamev([this._indicator._path, 'icons', 'matrix.svg']);
            this.appInfo = {
                get_name: () => 'Matrix Rooms',
                get_icon: () => Gio.Icon.new_for_string(iconPath),
                get_id: () => this.id,
                should_show: () => true,
            };
        }

        getInitialResultSet(terms) {
            return this._filterRooms(terms);
        }

        getSubsearchResultSet(_previousResults, terms) {
            return this._filterRooms(terms);
        }

        filterResults(results, maxResults) {
            return results.slice(0, maxResults);
        }

        _filterRooms(terms) {
            if (!this._indicator._rooms) return [];
            const query = terms.join(' ').toLowerCase();
            return Array.from(this._indicator._rooms.values())
                .filter(r =>
                    r.name?.toLowerCase().includes(query) ||
                    r.canonicalAlias?.toLowerCase().includes(query))
                .map(r => r.id);
        }

        getResultMetas(roomIds) {
            return roomIds.map(id => {
                const room = this._indicator._rooms.get(id);
                const fallback = room?.isDirect
                    ? 'avatar-default-symbolic'
                    : 'system-users-symbolic';
                return {
                    id,
                    name: room?.name ?? 'Unknown Room',
                    description: room?.canonicalAlias ?? 'Matrix Room',
                    createIcon: size => {
                        let gicon = null;
                        if (room?.avatarUrl) {
                            const hash = GLib.compute_checksum_for_string(
                                GLib.ChecksumType.MD5, room.avatarUrl, -1);
                            const cacheFile = Gio.File.new_for_path(
                                GLib.build_filenamev([this._indicator._cachePath, hash]));
                            if (cacheFile.query_exists(null))
                                gicon = Gio.FileIcon.new(cacheFile);
                            else
                                this._indicator._loadAvatar(room.avatarUrl, null, fallback);
                        }
                        if (!gicon) gicon = Gio.Icon.new_for_string(fallback);
                        return new St.Icon({
                            gicon,
                            icon_size: size > 0 ? size : 64,
                            style_class: 'search-result-icon',
                        });
                    },
                };
            });
        }

        activateResult(roomId) {
            this._indicator._incrementVisitCount(roomId);
            this._indicator._openMatrixClient(roomId);
        }

        launchSearch(_terms) {
            this._indicator._openMatrixClient();
        }
    });

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

export default class MatrixExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new MatrixIndicator(this._settings, this.path);
        Main.panel.addToStatusArea('matrix-status', this._indicator);

        this._searchProvider = new MatrixSearchProvider(this._indicator);
        if (Main.overview.searchController)
            Main.overview.searchController.addProvider(this._searchProvider);

        this._indicator.refresh();

        this._settings.connect('changed::sync-interval', () => this._restartTimer());

        const rebuildMenu = () => {
            this._indicator?._scheduleMenuBuild(this._indicator?._lastRooms ?? []);
        };
        this._settings.connect('changed::client-type', rebuildMenu);
        this._settings.connect('changed::generate-qr-code-enable', rebuildMenu);
        this._settings.connect('changed::notifications-enable', rebuildMenu);

        this._restartTimer();
    }

    _restartTimer() {
        if (this._timeout) {
            clearInterval(this._timeout);
            this._timeout = null;
        }
        const interval = this._settings.get_int('sync-interval') * 1000;
        this._timeout = setInterval(
            () => this._indicator.refresh(), Math.max(interval, 5000));
    }

    disable() {
        if (Main.overview.searchController)
            Main.overview.searchController.removeProvider(this._searchProvider);
        if (this._timeout) {
            clearInterval(this._timeout);
            this._timeout = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}