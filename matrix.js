import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

/**
 * MatrixClient handles all communication with the Matrix homeserver.
 */
export class MatrixClient {
    constructor(settings) {
        this._settings = settings;
        this._httpSession = new Soup.Session();
        this._cancellable = new Gio.Cancellable();
    }

    get cancellable() {
        return this._cancellable;
    }

    destroy() {
        this._cancellable.cancel();
        this._httpSession.abort();
    }

    get _token() {
        return this._settings.get_string('access-token').trim();
    }

    get _homeserver() {
        let url = this._settings.get_string('homeserver-url').trim();
        if (!url) return null;
        if (!url.startsWith('http')) url = `https://${url}`;
        return url.replace(/\/$/, '');
    }

    /**
     * Helper for GET requests
     */
    async _get(url, priority = GLib.PRIORITY_DEFAULT, useAuth = true) {
        const msg = Soup.Message.new('GET', url);
        if (useAuth) {
            const token = this._token;
            if (token)
                msg.request_headers.append('Authorization', `Bearer ${token}`);
        }

        const bytes = await this._httpSession.send_and_read_async(
            msg, priority, this._cancellable);

        return {
            status: msg.status_code,
            data: bytes ? new TextDecoder().decode(bytes.toArray()) : null,
            bytes,
        };
    }

    async whoami() {
        const homeserver = this._homeserver;
        if (!homeserver) return null;
        try {
            const res = await this._get(`${homeserver}/_matrix/client/v3/account/whoami`);
            if (res.status === 200)
                return JSON.parse(res.data);
        } catch (e) {
            console.error(`[Matrix-Client] whoami error: ${e.message}`);
        }
        return null;
    }

    async getProfile(userId) {
        const homeserver = this._homeserver;
        if (!homeserver || !userId) return null;
        try {
            const res = await this._get(`${homeserver}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`);
            if (res.status === 200)
                return JSON.parse(res.data);
        } catch (e) {
            console.error(`[Matrix-Client] getProfile error: ${e.message}`);
        }
        return null;
    }

    async sync(since = null, filter = null) {
        const homeserver = this._homeserver;
        const token = this._token;
        if (!homeserver || !token) return null;

        let url = `${homeserver}/_matrix/client/v3/sync?timeout=30000`;
        if (filter) url += `&filter=${encodeURIComponent(JSON.stringify(filter))}`;
        if (since) url += `&since=${since}`;

        try {
            const res = await this._get(url);
            if (res.status === 200)
                return JSON.parse(res.data);
            else if (res.status === 401 || res.status === 403)
                throw new Error('AUTH_ERROR');
            else
                throw new Error(`SYNC_ERROR_${res.status}`);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        }
        return null;
    }

    getMxcThumbnailUrl(mxcUrl, width = 96, height = 96, method = 'crop') {
        const homeserver = this._homeserver;
        if (!homeserver || !mxcUrl || !mxcUrl.startsWith('mxc://')) return null;

        const parts = mxcUrl.replace('mxc://', '').split('/');
        if (parts.length < 2) return null;

        return `${homeserver}/_matrix/client/v1/media/thumbnail/${parts[0]}/${parts.slice(1).join('/')}?width=${width}&height=${height}&method=${method}`;
    }

    async fetchBytes(url, useAuth = true) {
        try {
            const res = await this._get(url, GLib.PRIORITY_DEFAULT, useAuth);
            return {
                status: res.status,
                bytes: res.bytes,
            };
        } catch (e) {
            // ignore
        }
        return null;
    }
}
