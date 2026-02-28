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
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

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

            const iconPath = GLib.build_filenamev([this._path, 'icons', 'matrix.svg']);
            const gicon = Gio.Icon.new_for_string(iconPath);

            this.icon = new St.Icon({
                gicon: gicon,
                style_class: 'system-status-icon',
                icon_size: 16,
            });

            this.add_child(this.icon);
            this._lastRooms = [];
            this._nextBatch = null; // Token for incremental sync
            this._avatarCache = new Map(); // Cache for room/user avatars
            this._rooms = new Map(); // Full room cache for incremental sync
            this._isInitialSync = true;
            this._cachePath = GLib.build_filenamev([GLib.get_user_cache_dir(), 'matrix-status-extension']);
            GLib.mkdir_with_parents(this._cachePath, 0o755);
            this._openQrRoomId = null;
            this._userId = null;
            this._buildMenu([]);
        }

        destroy() {
            this._cancellable.cancel();
            this._httpSession.abort();
            this._avatarCache.clear();
            this._rooms.clear();
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

        _copyToClipboard(text) {
            const clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        }

        _getMxcThumbnailUrl(mxcUrl) {
            if (!mxcUrl || !mxcUrl.startsWith('mxc://'))
                return null;

            let homeserverBase = this._settings.get_string('homeserver-url').trim();
            if (!homeserverBase)
                return null;

            if (!homeserverBase.startsWith('http'))
                homeserverBase = `https://${homeserverBase}`;
            homeserverBase = homeserverBase.replace(/\/$/, '');

            const mxcParts = mxcUrl.replace('mxc://', '').split('/');
            if (mxcParts.length < 2)
                return null;

            const serverName = mxcParts[0];
            const mediaId = mxcParts.slice(1).join('/');

            // Use the modern authenticated media API path introduced in Matrix v1.11.
            // Fallback logic for older servers will be handled in _loadAvatar.
            return `${homeserverBase}/_matrix/client/v1/media/thumbnail/${serverName}/${mediaId}?width=64&height=64&method=crop`;
        }

        _getPrettyId(room) {
            return room.dmPartnerId || room.canonicalAlias || room.id;
        }

        async _fetchWhoAmI(homeserver, token) {
            try {
                const url = `${homeserver}/_matrix/client/v3/account/whoami`;
                const message = Soup.Message.new('GET', url);
                message.request_headers.append('Authorization', `Bearer ${token}`);

                const bytes = await this._httpSession.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    this._cancellable,
                );

                if (message.status_code === 200) {
                    const response = JSON.parse(new TextDecoder().decode(bytes.toArray()));
                    this._userId = response.user_id;
                }
            } catch (e) {
                // Ignore whoami errors, we'll just have less precise DM avatar filtering
            }
        }

        async _loadAvatar(url, bin, fallbackIconName) {
            try {
                // Generate a unique filename for the URL in cache
                // Using a simple hash of the URL
                const urlHash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
                const cacheFile = Gio.File.new_for_path(GLib.build_filenamev([this._cachePath, urlHash]));
                const cacheExists = cacheFile.query_exists(null);

                // 1. Check memory cache first (most frequent)
                if (this._avatarCache.has(url)) {
                    const gicon = this._avatarCache.get(url);
                    const cachedIcon = new St.Icon({
                        gicon: gicon,
                        icon_size: 24,
                        style_class: 'matrix-room-avatar',
                    });
                    bin.set_child(cachedIcon);
                    
                    // If cached in memory, still check if it's too old on disk (background update)
                    // but we'll return now to keep UI snappy.
                }

                // 2. Check disk cache if not in memory or for age check
                let useDiskCache = false;
                if (cacheExists) {
                    const info = cacheFile.query_info('standard::*,time::*', Gio.FileQueryInfoFlags.NONE, null);
                    const mtime = info.get_attribute_uint64('time::modified');
                    const now = Math.floor(Date.now() / 1000);
                    const threeHours = 3 * 60 * 60;

                    if (now - mtime < threeHours) {
                        useDiskCache = true;
                    }
                }

                if (useDiskCache && !this._avatarCache.has(url)) {
                    const gicon = Gio.FileIcon.new(cacheFile);
                    this._avatarCache.set(url, gicon);
                    const avatarIcon = new St.Icon({
                        gicon: gicon,
                        icon_size: 24,
                        style_class: 'matrix-room-avatar',
                    });
                    bin.set_child(avatarIcon);
                    return;
                }

                const token = this._settings.get_string('access-token').trim();
                const tryFetch = async (fetchUrl) => {
                    const message = Soup.Message.new('GET', fetchUrl);
                    if (token) {
                        message.request_headers.append('Authorization', `Bearer ${token}`);
                    }
                    const bytes = await this._httpSession.send_and_read_async(
                        message,
                        GLib.PRIORITY_DEFAULT,
                        this._cancellable
                    );
                    return { status: message.status_code, bytes };
                };

                // 3. Network fetch (if no cache or expired)
                let res = await tryFetch(url);

                // Fallback to /media/v3 if modern path fails
                if (res.status !== 200 && url.includes('/client/v1/media/')) {
                    const v3Url = url.replace('/client/v1/media/', '/media/v3/');
                    res = await tryFetch(v3Url);
                }

                // Fallback to /media/r0 if v3 fails
                if (res.status !== 200 && (url.includes('/v3/') || url.includes('/v3/'))) {
                    const r0Url = url.replace('/client/v1/media/', '/media/r0/').replace('/v3/', '/r0/');
                    res = await tryFetch(r0Url);
                }

                if (res.status === 200) {
                    // Save to disk cache
                    cacheFile.replace_contents_async(
                        res.bytes.toArray(),
                        null,
                        false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION,
                        null,
                        (file, result) => {
                            try {
                                file.replace_contents_finish(result);
                            } catch (e) {
                                // Silent fail on cache write
                            }
                        }
                    );

                    const gicon = Gio.BytesIcon.new(res.bytes);
                    this._avatarCache.set(url, gicon);

                    const avatarIcon = new St.Icon({
                        gicon: gicon,
                        icon_size: 24,
                        style_class: 'matrix-room-avatar',
                    });
                    bin.set_child(avatarIcon);
                    return;
                }

                // If fetch failed but we have OLD disk cache, use it as last resort
                if (cacheExists && !this._avatarCache.has(url)) {
                    const gicon = Gio.FileIcon.new(cacheFile);
                    const avatarIcon = new St.Icon({
                        gicon: gicon,
                        icon_size: 24,
                        style_class: 'matrix-room-avatar',
                    });
                    bin.set_child(avatarIcon);
                    return;
                }

                throw new Error(`Status ${res.status}`);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    console.error(`[Matrix-Status] Avatar load error for ${url}: ${e.message}`);
                    const fallback = new St.Icon({
                        icon_name: fallbackIconName,
                        icon_size: 24,
                        style_class: 'matrix-room-avatar-default',
                    });
                    bin.set_child(fallback);
                }
            }
        }

        _getMatrixToUrlFor(room) {
            const target = this._getPrettyId(room);
            return `https://matrix.to/#/${target}`;
        }

        async _toggleActionBox(room, roomItem) {
            try {
                // If this room's action box is already shown, close it
                if (this._openQrRoomId === room.id) {
                    if (roomItem._actionItem) {
                        roomItem._actionItem.destroy();
                        roomItem._actionItem = null;
                    }
                    this._openQrRoomId = null;
                    return;
                }

                // Close any other open action box first
                if (this._openQrRoomId) {
                    const items = this.menu._getMenuItems();
                    for (const item of items) {
                        if (item._actionItem) {
                            item._actionItem.destroy();
                            item._actionItem = null;
                        
                            // Reset icon of the previous button (set to QR icon as it's now closed)
                            const btn = item.get_children().find(c => c instanceof St.Button && c.has_style_class_name('matrix-action-button'));
                            if (btn && btn.child instanceof St.Icon) {
                                btn.child.icon_name = 'qr-code-symbolic';
                            }
                        }
                    }
                }

                this._openQrRoomId = room.id;
                this._createActionBox(room, roomItem);
            }
            catch (e) {
                console.error(`[Matrix-Status] Action box error: ${e.message}`);
            }
        }

        _createActionBox(room, roomItem, showQrImmediately = false) {
            const actionItem = new PopupMenu.PopupBaseMenuItem({ reactive: true, can_focus: false });
            actionItem.style_class = 'matrix-action-box-item';
            
            const mainBox = new St.BoxLayout({ vertical: true, x_expand: true });
            
            const qrContainer = new St.BoxLayout({ vertical: true, x_expand: true });
            mainBox.add_child(qrContainer);

            actionItem.add_child(mainBox);

            // Find position to insert (right after the room item)
            const items = this.menu._getMenuItems();
            const index = items.indexOf(roomItem);
            this.menu.addMenuItem(actionItem, index + 1);
            
            roomItem._actionItem = actionItem;

            this._fillQrContainer(room, qrContainer);
        }

        async _fillQrContainer(room, container) {
            try {
                // Clear container first
                container.get_children().forEach(c => c.destroy());
                
                const spinner = new Animation.Spinner(16);
                spinner.x_align = Clutter.ActorAlign.CENTER;
                container.add_child(spinner);
                spinner.play();
                container.visible = true;

                const dataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(this._getMatrixToUrlFor(room))}`;
                const message = Soup.Message.new('GET', dataUrl);
                const bytes = await this._httpSession.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    this._cancellable,
                );
                
                spinner.destroy();

                if (message.status_code !== 200) {
                    container.add_child(new St.Label({ text: 'Error generating QR', x_align: Clutter.ActorAlign.CENTER }));
                    return;
                }

                // QR Image
                const icon = new St.Icon({
                    gicon: Gio.BytesIcon.new(bytes),
                    icon_size: 160,
                    x_align: Clutter.ActorAlign.CENTER,
                    style_class: 'matrix-qr-image',
                });
                container.add_child(icon);

                // ID row: label and copy button
                const idRow = new St.BoxLayout({ 
                    x_expand: true, 
                    x_align: Clutter.ActorAlign.CENTER,
                    style_class: 'matrix-qr-id-row' 
                });

                const idLabel = new St.Label({
                    text: this._getPrettyId(room),
                    style_class: 'matrix-qr-id-label',
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const copyBtn = new St.Button({
                    child: new St.Icon({
                        icon_name: 'edit-copy-symbolic',
                        icon_size: 14,
                    }),
                    style_class: 'button matrix-qr-copy-button',
                    can_focus: true,
                });

                copyBtn.connect('clicked', () => {
                    this._copyToClipboard(this._getPrettyId(room));
                    this.menu.close();
                });

                idRow.add_child(idLabel);
                idRow.add_child(copyBtn);
                container.add_child(idRow);
            }
            catch (e) {
                console.error(`[Matrix-Status] QR generation error: ${e.message}`);
            }
        }

        _buildMenu(rooms = []) {
            this.menu.removeAll();
            if (rooms.length === 0) {
                const message = this._isInitialSync ? 'Synchronizing...' : 'No Active Messages';
                const item = new PopupMenu.PopupMenuItem(message);
                item.sensitive = false;
                this.menu.addMenuItem(item);
            }
            else {
                rooms.sort((a, b) => b.timestamp - a.timestamp);

                rooms.forEach((room) => {
                    const item = new PopupMenu.PopupMenuItem('', { activate: true });

                    // Icon Container (Avatar + Lock)
                    const iconContainer = new St.BoxLayout({
                        style_class: 'matrix-icon-container',
                        y_align: Clutter.ActorAlign.CENTER,
                    });

                    // Room Avatar
                    const avatarBin = new St.Bin({
                        style_class: 'matrix-room-avatar-container',
                        child: null,
                    });
                    
                    const fallbackIconName = room.isDirect ? 'avatar-default-symbolic' : 'system-users-symbolic';

                    if (room.avatarUrl) {
                        const spinner = new Animation.Spinner(24);
                        spinner.add_style_class_name('matrix-avatar-spinner');
                        avatarBin.set_child(spinner);
                        spinner.play();
                        
                        this._loadAvatar(room.avatarUrl, avatarBin, fallbackIconName);
                    } else {
                        const defaultAvatar = new St.Icon({
                            icon_name: fallbackIconName,
                            icon_size: 24,
                            style_class: 'matrix-room-avatar-default',
                        });
                        avatarBin.set_child(defaultAvatar);
                    }
                    iconContainer.add_child(avatarBin);

                    // Lock Icon (Encryption)
                    const lockIcon = new St.Icon({
                        icon_name: 'changes-prevent-symbolic',
                        style_class: 'matrix-lock-icon',
                        icon_size: 14,
                        opacity: room.encrypted ? 255 : 0, // Keep space even if not encrypted
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    iconContainer.add_child(lockIcon);

                    item.insert_child_at_index(iconContainer, 0);

                    const labelText = room.unread > 0 ? `<b>(${room.unread}) ${room.name}</b>` : room.name;
                    item.label.get_clutter_text().set_markup(labelText);
                    item.label.x_expand = true;

                    // Action button
                    const isQrEnabled = this._settings.get_boolean('generate-qr-code-enable');
                    const initialIconName = isQrEnabled 
                        ? (this._openQrRoomId === room.id ? 'view-conceal-symbolic' : 'qr-code-symbolic')
                        : 'edit-copy-symbolic';

                    const actionButton = new St.Button({
                        child: new St.Icon({
                            icon_name: initialIconName,
                            icon_size: 14,
                        }),
                        style_class: 'button matrix-action-button',
                        can_focus: true,
                        y_align: Clutter.ActorAlign.CENTER,
                    });

                    actionButton.connect('clicked', () => {
                        if (isQrEnabled) {
                            this._toggleActionBox(room, item);
                            const newIconName = this._openQrRoomId === room.id ? 'view-conceal-symbolic' : 'qr-code-symbolic';
                            actionButton.child.icon_name = newIconName;
                        } else {
                            this._copyToClipboard(this._getPrettyId(room));
                            this.menu.close();
                        }
                        return Clutter.EVENT_STOP;
                    });

                    item.add_child(actionButton);

                    item.connect('activate', () => {
                        this._openMatrixClient(room.id);
                    });
                    this.menu.addMenuItem(item);

                    // Restore action box if it was open for this room
                    if (isQrEnabled && this._openQrRoomId === room.id) {
                        this._createActionBox(room, item, true);
                    }
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
                    state: { types: ['m.room.name', 'm.room.member', 'm.room.canonical_alias', 'm.room.encryption', 'm.room.avatar'], lazy_load_members: true },
                    timeline: { limit: 1 },
                    account_data: { types: ['m.tag'] },
                },
            });

            try {
                let url = `${homeserver}/_matrix/client/v3/sync?timeout=30000&filter=${encodeURIComponent(filter)}`;
                if (this._nextBatch) {
                    url += `&since=${this._nextBatch}`;
                }

                const message = Soup.Message.new('GET', url);
                message.request_headers.append('Authorization', `Bearer ${token}`);

                const bytes = await this._httpSession.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    this._cancellable,
                );

                if (message.status_code === 200) {
                    const response = JSON.parse(new TextDecoder().decode(bytes.toArray()));
                    
                    // Update the sync token for the next request
                    if (response.next_batch) {
                        this._nextBatch = response.next_batch;
                    }

                    // Fetch own user ID if we don't have it yet (needed for better DM avatar matching)
                    if (!this._userId) {
                        await this._fetchWhoAmI(homeserver, token);
                    }

                    this._processSync(response);
                    this._isInitialSync = false;
                }
                else if (message.status_code === 401 || message.status_code === 403) {
                    console.warn(`[Matrix-Status] Auth failed (Status: ${message.status_code}). Resetting sync token.`);
                    this._nextBatch = null;
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
        _isSameRoomList(newList) {
            if (this._lastRooms.length !== newList.length)
                return false;
            
            for (let i = 0; i < newList.length; i++) {
                const a = this._lastRooms[i];
                const b = newList[i];
                if (a.id !== b.id || a.unread !== b.unread || a.name !== b.name || a.encrypted !== b.encrypted || a.avatarUrl !== b.avatarUrl)
                    return false;
            }
            return true;
        }

        _processSync(data) {
            if (!this._rooms)
                this._rooms = new Map();

            // Update rooms from the sync data
            if (data.rooms?.join) {
                for (const [roomId, roomData] of Object.entries(data.rooms.join)) {
                    const unreadNotifications = roomData.unread_notifications?.notification_count || 0;
                    const highlightCount = roomData.unread_notifications?.highlight_count || 0;
                    const unread = unreadNotifications + highlightCount;

                    const hasFavTag = roomData.account_data?.events?.some(e => e.type === 'm.tag' && e.content?.tags?.['m.favourite']);

                    // Find if room already exists in our map
                    let existingRoom = this._rooms.get(roomId);

                    // If it's a new room with unread/fav, or an update to an existing room
                    if (unread > 0 || hasFavTag || existingRoom) {
                        let name = existingRoom?.name || null;
                        let dmPartnerId = existingRoom?.dmPartnerId || null;
                        let canonicalAlias = existingRoom?.canonicalAlias || null;
                        let isEncrypted = existingRoom?.encrypted || false;
                        let isDirect = existingRoom?.isDirect || false;
                        let avatarUrl = existingRoom?.avatarUrl || null;
                        let timestamp = existingRoom?.timestamp || 0;
                        let isFavorite = hasFavTag || existingRoom?.isFavorite || false;

                        // Update metadata if present in this sync
                        const nameEv = roomData.state?.events?.find(e => e.type === 'm.room.name');
                        if (nameEv?.content?.name)
                            name = nameEv.content.name;

                        const aliasEv = roomData.state?.events?.find(e => e.type === 'm.room.canonical_alias');
                        if (aliasEv?.content?.alias)
                            canonicalAlias = aliasEv.content.alias;

                        if (roomData.state?.events?.some(e => e.type === 'm.room.encryption'))
                            isEncrypted = true;

                        if (roomData.is_direct !== undefined)
                            isDirect = roomData.is_direct;

                        if (roomData.summary?.['m.heroes']?.length > 0) {
                            const heroes = roomData.summary['m.heroes'];
                            if (!name && heroes.length === 1) {
                                dmPartnerId = heroes[0];
                                isDirect = true;
                            }

                            if (!name) {
                                const heroNames = heroes.map((h) => {
                                    const m = roomData.state?.events?.find(e => e.type === 'm.room.member' && e.state_key === h);
                                    return m?.content?.displayname || h.split(':')[0].replace('@', '');
                                });
                                name = heroNames.join(', ');
                            }
                        }

                        const lastEvent = roomData.timeline?.events?.[roomData.timeline.events.length - 1];
                        if (lastEvent?.origin_server_ts)
                            timestamp = lastEvent.origin_server_ts;

                        const avatarEv = roomData.state?.events?.find(e => e.type === 'm.room.avatar');
                        if (avatarEv?.content?.url) {
                            avatarUrl = this._getMxcThumbnailUrl(avatarEv.content.url);
                        }

                        // DM Avatar logic
                        if (!avatarUrl && isDirect) {
                            // Try heroes
                            if (roomData.summary?.['m.heroes']?.length > 0) {
                                // Filter out self from heroes to avoid using own avatar in DM
                                const partnerHero = roomData.summary['m.heroes'].find(h => this._userId && h !== this._userId);
                                if (partnerHero) {
                                    const memberEv = roomData.state?.events?.find(e => 
                                        e.type === 'm.room.member' && e.state_key === partnerHero
                                    );
                                    if (memberEv?.content?.avatar_url) {
                                        avatarUrl = this._getMxcThumbnailUrl(memberEv.content.avatar_url);
                                    }
                                }
                            }
                            
                            // Try any member besides self
                            if (!avatarUrl && this._userId) {
                                const anyMemberWithAvatar = roomData.state?.events?.find(e => 
                                    e.type === 'm.room.member' && 
                                    e.content?.avatar_url && 
                                    e.state_key !== this._userId
                                );
                                if (anyMemberWithAvatar?.content?.avatar_url) {
                                    avatarUrl = this._getMxcThumbnailUrl(anyMemberWithAvatar.content.avatar_url);
                                }
                            }
                        }

                        const updatedRoom = {
                            name: name || 'Unnamed Room',
                            id: roomId,
                            dmPartnerId,
                            canonicalAlias,
                            unread,
                            timestamp,
                            encrypted: isEncrypted,
                            isDirect,
                            avatarUrl,
                            isFavorite,
                        };

                        this._rooms.set(roomId, updatedRoom);
                    }
                }
            }

            // Convert map to list and filter
            let roomList = Array.from(this._rooms.values())
                .filter(r => r.unread > 0 || r.isFavorite || r.id === this._openQrRoomId);

            // Re-calculate total unread from the current list
            const totalUnread = roomList.reduce((acc, r) => acc + r.unread, 0);

            if (totalUnread > 0) {
                this.add_style_class_name('matrix-pill-active');
            }
            else {
                this.remove_style_class_name('matrix-pill-active');
            }

            // Only rebuild menu if data changed; avoid unnecessary rebuilds to prevent flicker
            if (!this._isSameRoomList(roomList)) {
                this._lastRooms = roomList;
                this._buildMenu(roomList);
            }
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
        this._settings.connect('changed::generate-qr-code-enable', () => {
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