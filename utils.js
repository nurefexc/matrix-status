import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

/**
 * Gets a human-readable ID for a room.
 */
export function getPrettyId(room) {
    return room.dmPartnerId || room.canonicalAlias || room.id;
}

/**
 * Common logging helper.
 */
export function log(message) {
    console.log(`[Matrix-Status] ${message}`);
}

export function warn(message) {
    console.warn(`[Matrix-Status] ${message}`);
}

export function error(message) {
    console.error(`[Matrix-Status] ${message}`);
}

/**
 * Load an icon.
 */
export function createIcon(gicon, size = 16, styleClass = 'system-status-icon') {
    return new St.Icon({
        gicon,
        icon_size: size,
        style_class: styleClass,
    });
}

export function getWebUrl(roomId = null) {
    return roomId ? `https://matrix.to/#/${roomId}` : 'https://matrix.to';
}

export function getElementUrl(roomId = null) {
    return roomId ? `element://vector/webapp/#/room/${roomId}` : 'element://';
}

export function getSchildiChatUrl(roomId = null) {
    return roomId ? `schildichat://vector/webapp/#/room/${roomId}` : 'schildichat://';
}

export function getNeoChatUrl(roomId = null) {
    if (!roomId) return 'matrix:';
    const encodedId = roomId.replace(/:/g, '%3A').replace(/^!/, '');
    const prefix = roomId.startsWith('@') ? 'u' : 'roomid';
    return `matrix:${prefix}/${encodedId}?action=chat`;
}

export function getFractalUrl(roomId = null) {
    if (!roomId) return 'matrix:';
    const cleanId = roomId.startsWith('!') ? roomId.slice(1) : roomId;
    const encodedId = cleanId.replace(/:/g, '%3A');
    const via = cleanId.includes(':') ? `&via=${cleanId.split(':')[1]}` : '';
    return `matrix:roomid/${encodedId}?action=join${via}`;
}
