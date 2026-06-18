import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Utils from './utils.js';

import { SETTINGS_KEYS } from './constants.js';

const DEFAULT_MAX_NOTIFICATIONS_PER_ROOM = 8;
const DEFAULT_ICON_NAME = 'chat-message-new-symbolic';

const MatrixNotificationPolicy = GObject.registerClass(
    class MatrixNotificationPolicy extends MessageTray.NotificationPolicy {
        _init(settings) {
            super._init();
            this._settings = settings;
        }

        get enable() {
            return this._getBool(SETTINGS_KEYS.NOTIFICATIONS_ENABLE, true);
        }

        get enableSound() {
            return this._getBool('notifications-sound', false);
        }

        get showBanners() {
            return this._getBool('notifications-show-banners', true);
        }

        get forceExpanded() {
            return this._getBool('notifications-force-expanded', false);
        }

        get showInLockScreen() {
            return this._getBool('notifications-lock-screen', true);
        }

        get detailsInLockScreen() {
            return this._getBool('notifications-lock-screen-details', false);
        }

        store() {
        }

        _getBool(key, fallback = false) {
            try {
                if (this._settings && typeof this._settings.get_boolean === 'function')
                    return this._settings.get_boolean(key);
            } catch (e) {
                Utils.warn(`Failed to get boolean setting ${key}: ${e.message}`);
            }
            return fallback;
        }
    });

export class NotificationManager {
    constructor(settings, matrixClient, cachePath) {
        this._settings = settings;
        this._matrixClient = matrixClient;
        this._cachePath = cachePath;

        this._sources = new Map();
        this._policies = new Map();
        this._roomNotifications = new Map();
        this._roomOrder = new Map();
        this._roomMeta = new Map();
        this._avatarCache = new Map();
        this._signalIds = new Map();
    }

    destroy() {
        for (const roomMap of this._roomNotifications.values()) {
            for (const notification of roomMap.values()) {
                this._safeDestroyNotification(
                    notification,
                    MessageTray.NotificationDestroyedReason.SOURCE_CLOSED
                );
            }
        }

        for (const [roomId, source] of this._sources.entries()) {
            this._disconnectTrackedSignals(roomId);
            this._safeDestroySource(source);
        }

        this._sources.clear();
        this._policies.clear();
        this._roomNotifications.clear();
        this._roomOrder.clear();
        this._roomMeta.clear();
        this._avatarCache.clear();
        this._signalIds.clear();
    }

    async showNotification(message) {
        try {
            if (!this._shouldNotify(message))
                return false;

            const room = message.room;
            const roomId = room.id;
            const eventId = message.eventId;

            this._rememberRoomMeta(room);

            let roomMap = this._roomNotifications.get(roomId);
            if (!roomMap) {
                roomMap = new Map();
                this._roomNotifications.set(roomId, roomMap);
            }

            let roomOrder = this._roomOrder.get(roomId);
            if (!roomOrder) {
                roomOrder = [];
                this._roomOrder.set(roomId, roomOrder);
            }

            if (roomMap.has(eventId))
                return false;

            const source = await this._ensureSource(room);
            const notification = await this._createNotification(source, message);

            roomMap.set(eventId, notification);
            roomOrder.push(eventId);

            source.addNotification(notification);

            this._trimRoomNotifications(roomId);
            this._refreshSourceTitle(roomId);

            return true;
        } catch (e) {
            Utils.warn(`[Matrix-Status] Failed to show notification: ${e.message}`);
            return false;
        }
    }

    redactEvent(roomId, redactedEventId) {
        return this.retractNotification(roomId, redactedEventId);
    }

    retractNotification(roomId, eventId, reason = MessageTray.NotificationDestroyedReason.REPLACED) {
        const roomMap = this._roomNotifications.get(roomId);
        if (!roomMap)
            return false;

        const notification = roomMap.get(eventId);
        if (!notification)
            return false;

        this._safeDestroyNotification(notification, reason);
        return true;
    }

    retractAllForRoom(roomId) {
        const roomMap = this._roomNotifications.get(roomId);
        if (roomMap) {
            for (const notification of roomMap.values())
                this._safeDestroyNotification(notification, MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        }

        this._roomNotifications.delete(roomId);
        this._roomOrder.delete(roomId);

        const source = this._sources.get(roomId);
        if (source) {
            this._disconnectTrackedSignals(roomId);
            this._sources.delete(roomId);
            this._policies.delete(roomId);
            this._roomMeta.delete(roomId);
            this._safeDestroySource(source);
        }
    }

    replaceNotification(oldRoomId, oldEventId, newMessage) {
        this.retractNotification(
            oldRoomId,
            oldEventId,
            MessageTray.NotificationDestroyedReason.REPLACED
        );
        return this.showNotification(newMessage);
    }

    hasNotification(roomId, eventId) {
        return this._roomNotifications.get(roomId)?.has(eventId) ?? false;
    }

    getRoomNotificationCount(roomId) {
        return this._roomNotifications.get(roomId)?.size ?? 0;
    }

    getSource(roomId) {
        return this._sources.get(roomId) ?? null;
    }

    async _ensureSource(room) {
        const roomId = room.id;
        let source = this._sources.get(roomId);
        if (source)
            return source;

        let policy = this._policies.get(roomId);
        if (!policy) {
            policy = new MatrixNotificationPolicy(this._settings);
            this._policies.set(roomId, policy);
        }

        source = new MessageTray.Source({
            title: room.name || 'Matrix',
            iconName: DEFAULT_ICON_NAME,
            policy,
        });

        this._sources.set(roomId, source);

        this._trackSignal(roomId, source, 'destroy', () => {
            this._sources.delete(roomId);
            this._policies.delete(roomId);
            this._roomNotifications.delete(roomId);
            this._roomOrder.delete(roomId);
            this._roomMeta.delete(roomId);
            this._disconnectTrackedSignals(roomId);
        });

        this._trackSignal(roomId, source, 'notification-added', () => {
            this._refreshSourceTitle(roomId);
        });

        this._trackSignal(roomId, source, 'notification-removed', () => {
            this._refreshSourceTitle(roomId);
            this._cleanupEmptyRoom(roomId);
        });

        Main.messageTray.add(source);

        if (room.avatarUrl) {
            const icon = await this._loadAvatarIcon(room.avatarUrl);
            if (icon)
                source.gicon = icon;
        }

        this._refreshSourceTitle(roomId);
        return source;
    }

    async _createNotification(source, message) {
        const title = this._buildNotificationTitle(message);
        const body = this._buildNotificationBody(message);
        const urgency = message.urgency ?? this._getUrgency(message);

        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            useBodyMarkup: true,
            isTransient: this._isTransient(message),
            resident: !this._isTransient(message),
            urgency,
        });

        if (message.room?.avatarUrl) {
            const icon = await this._loadAvatarIcon(message.room.avatarUrl);
            if (icon)
                notification.gicon = icon;
        }

        notification.acknowledged = false;

        this._bindNotificationSignals(notification, message);
        this._addNotificationActions(notification, message);

        return notification;
    }

    _bindNotificationSignals(notification, message) {
        const roomId = message.room.id;
        const eventId = message.eventId;

        notification.connect('activated', () => {
            notification.acknowledged = true;

            if (typeof message.onOpen === 'function')
                message.onOpen(roomId, eventId);
            else if (typeof this.onNotificationActivated === 'function')
                this.onNotificationActivated(roomId, eventId);
        });

        notification.connect('destroy', () => {
            this._forgetNotification(roomId, eventId);
            this._refreshSourceTitle(roomId);
            this._cleanupEmptyRoom(roomId);
        });
    }

    _addNotificationActions(notification, message) {
        notification.addAction('Open', () => {
            if (typeof message.onOpen === 'function')
                message.onOpen(message.room.id, message.eventId);
            else if (typeof this.onNotificationActivated === 'function')
                this.onNotificationActivated(message.room.id, message.eventId);
        });

        if (message.canReply && typeof message.onReply === 'function') {
            notification.addAction('Reply', () => {
                message.onReply(message.room.id, message.eventId, message.threadId ?? null);
            });
        }

        if (message.canMarkRead && typeof message.onMarkRead === 'function') {
            notification.addAction('Mark as Read', () => {
                message.onMarkRead(message.room.id, message.eventId);
            });
        }
    }

    _trimRoomNotifications(roomId) {
        const roomMap = this._roomNotifications.get(roomId);
        const roomOrder = this._roomOrder.get(roomId);
        const max = this._getInt('notifications-max-per-room', DEFAULT_MAX_NOTIFICATIONS_PER_ROOM);

        if (!roomMap || !roomOrder)
            return;

        while (roomOrder.length > max) {
            const oldestEventId = roomOrder.shift();
            const notification = roomMap.get(oldestEventId);
            if (!notification)
                continue;

            this._safeDestroyNotification(
                notification,
                MessageTray.NotificationDestroyedReason.EXPIRED
            );
        }
    }

    _cleanupEmptyRoom(roomId) {
        const roomMap = this._roomNotifications.get(roomId);
        if (roomMap && roomMap.size > 0)
            return;

        this._roomNotifications.delete(roomId);
        this._roomOrder.delete(roomId);

        const source = this._sources.get(roomId);
        if (!source)
            return;

        this._sources.delete(roomId);
        this._policies.delete(roomId);

        this._disconnectTrackedSignals(roomId);
        this._safeDestroySource(source);
    }

    _forgetNotification(roomId, eventId) {
        const roomMap = this._roomNotifications.get(roomId);
        if (roomMap)
            roomMap.delete(eventId);

        const roomOrder = this._roomOrder.get(roomId);
        if (roomOrder) {
            const idx = roomOrder.indexOf(eventId);
            if (idx >= 0)
                roomOrder.splice(idx, 1);
        }
    }

    _refreshSourceTitle(roomId) {
        const source = this._sources.get(roomId);
        const meta = this._roomMeta.get(roomId);
        if (!source || !meta)
            return;

        const count = this.getRoomNotificationCount(roomId);
        const base = meta.name || meta.canonicalAlias || 'Matrix';

        try {
            source.title = count > 0 ? `${base} (${count})` : base;
        } catch (e) {
            Utils.warn(`[Matrix-Status] Failed to update source title: ${e.message}`);
        }
    }

    _rememberRoomMeta(room) {
        this._roomMeta.set(room.id, {
            name: room.name || 'Matrix',
            avatarUrl: room.avatarUrl || null,
            canonicalAlias: room.canonicalAlias || null,
        });
    }

    _buildNotificationTitle(message) {
        const roomName = message.room?.name || 'Matrix';

        if (message.isMention)
            return `${roomName} — Mention`;

        if (message.isReply)
            return `${roomName} — Reply`;

        if (message.type === 'm.room.member')
            return `${roomName} — Membership`;

        return roomName;
    }

    _buildNotificationBody(message) {
        const sender = this._escapeText(message.senderName || 'Someone');

        let body = message.formattedBody
            ? this._sanitizeMarkup(message.formattedBody)
            : this._formatBody(this._humanizeBody(message));

        if (!body)
            body = 'New message';

        if (message.isReply)
            return `${sender} replied: ${body}`;

        return `${sender}: ${body}`;
    }

    _humanizeBody(message) {
        const type = message.type || 'm.room.message';
        const raw = message.body || '';

        if (type === 'm.sticker')
            return 'sent a sticker';

        if (type === 'm.room.member')
            return raw || 'membership event';

        if (!raw && message.msgtype === 'm.image')
            return 'sent an image';

        if (!raw && message.msgtype === 'm.video')
            return 'sent a video';

        if (!raw && message.msgtype === 'm.audio')
            return 'sent an audio message';

        if (!raw && message.msgtype === 'm.file')
            return 'sent a file';

        return raw;
    }

    _getUrgency(message) {
        if (message.urgency !== undefined && message.urgency !== null)
            return message.urgency;

        if (message.isMention)
            return MessageTray.Urgency.HIGH;

        return MessageTray.Urgency.NORMAL;
    }

    _isTransient(message) {
        if (message.silent)
            return true;

        return this._getBool('notifications-transient', false);
    }

    _shouldNotify(message) {
        if (!this._getBool(SETTINGS_KEYS.NOTIFICATIONS_ENABLE, true))
            return false;

        if (!message?.room?.id || !message?.eventId)
            return false;

        if (message.isOwn)
            return false;

        if (message.isRedacted || message.redacted)
            return false;

        if (message.isMuted && !message.isMention)
            return false;

        if (message.onlyShowOnMention)
            return !!message.isMention;

        if (this._getBool('notifications-mentions-only', false) && !message.isMention)
            return false;

        return true;
    }

    async _loadAvatarIcon(url) {
        if (!url)
            return null;

        if (this._avatarCache.has(url))
            return this._avatarCache.get(url);

        try {
            const urlHash = GLib.compute_checksum_for_string(
                GLib.ChecksumType.MD5,
                url,
                -1
            );

            const cacheFile = Gio.File.new_for_path(
                GLib.build_filenamev([this._cachePath, urlHash])
            );

            if (!cacheFile.query_exists(null)) {
                const res = await this._matrixClient.fetchBytes(url);
                if (res?.status === 200 && res.bytes) {
                    const contents = res.bytes.toArray();
                    cacheFile.replace_contents(
                        contents,
                        null,
                        false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION,
                        null
                    );
                }
            }

            if (cacheFile.query_exists(null)) {
                const icon = Gio.Icon.new_for_string(cacheFile.get_path());
                this._avatarCache.set(url, icon);
                return icon;
            }
        } catch (e) {
            Utils.warn(`[Matrix-Status] Failed to load notification avatar: ${e.message}`);
        }

        return null;
    }

    _formatBody(body) {
        if (!body)
            return '';

        let formatted = this._escapeText(body);

        formatted = formatted.replace(/(\*\*|__)(.*?)\1/g, '<b>$2</b>');
        formatted = formatted.replace(/(^|[^\*])\*(?!\*)([^*]+)\*(?!\*)/g, '$1<i>$2</i>');
        formatted = formatted.replace(/(^|[^_])_(?!_)([^_]+)_(?!_)/g, '$1<i>$2</i>');
        formatted = formatted.replace(
            /\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g,
            '<a href="$2">$1</a>'
        );

        return formatted;
    }

    _sanitizeMarkup(markup) {
        if (!markup)
            return '';

        let text = `${markup}`;

        text = text.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, '&amp;');
        text = text.replace(/<(?!\/?(b|i|u|a)(\s+href="https?:\/\/[^"]*")?\s*\/?>)/g, '&lt;');
        text = text.replace(/(?<!\/?(b|i|u|a)(\s+href="https?:\/\/[^"]*")?\s*)>/g, '&gt;');

        return text;
    }

    _escapeText(text) {
        return `${text ?? ''}`
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _safeDestroyNotification(notification, reason) {
        if (!notification)
            return;

        try {
            notification.destroy(reason);
        } catch (e) {
            Utils.warn(`[Matrix-Status] Failed to destroy notification: ${e.message}`);
        }
    }

    _safeDestroySource(source) {
        if (!source)
            return;

        try {
            source.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        } catch (e) {
            Utils.warn(`[Matrix-Status] Failed to destroy source: ${e.message}`);
        }
    }

    _trackSignal(roomId, obj, signal, callback) {
        try {
            const id = obj.connect(signal, callback);
            if (!this._signalIds.has(roomId))
                this._signalIds.set(roomId, []);
            this._signalIds.get(roomId).push({obj, id});
        } catch (e) {
            Utils.warn(`[Matrix-Status] Failed to connect signal ${signal}: ${e.message}`);
        }
    }

    _disconnectTrackedSignals(roomId) {
        const tracked = this._signalIds.get(roomId);
        if (!tracked)
            return;

        for (const item of tracked) {
            try {
                item.obj.disconnect(item.id);
            } catch (e) {
                Utils.warn(`Failed to disconnect signal: ${e.message}`);
            }
        }

        this._signalIds.delete(roomId);
    }

    _getBool(key, fallback = false) {
        try {
            if (this._settings && typeof this._settings.get_boolean === 'function')
                return this._settings.get_boolean(key);
        } catch (e) {
            Utils.warn(`Failed to get boolean setting ${key}: ${e.message}`);
        }
        return fallback;
    }

    _getInt(key, fallback = 0) {
        try {
            if (this._settings && typeof this._settings.get_int === 'function')
                return this._settings.get_int(key);
        } catch (e) {
            Utils.warn(`Failed to get int setting ${key}: ${e.message}`);
        }
        return fallback;
    }
}