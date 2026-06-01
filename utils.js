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
