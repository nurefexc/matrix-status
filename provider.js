import Gio from 'gi://Gio'
import GLib from 'gi://GLib';

export default class MatrixSearchProvider {
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

    async getInitialResultSet(terms) {
        return this._filterRooms(terms);
    }

    async getSubsearchResultSet(_previousResults, terms) {
        return this._filterRooms(terms);
    }

    filterResults(results, maxResults) {
        return results.slice(0, maxResults);
    }

    _filterRooms(terms) {
        if (!this._indicator._rooms)
            return [];
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
            const fallback = room?.isDirect ? 'avatar-default-symbolic' : 'system-users-symbolic';
            return {
                id,
                name: room?.name ?? 'Unknown Room',
                description: room?.canonicalAlias ?? 'Matrix Room',
                createIcon: size => {
                    let gicon = null;
                    if (room?.avatarUrl) {
                        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, room.avatarUrl, -1);
                        const cacheFile = Gio.File.new_for_path(
                            GLib.build_filenamev([this._indicator._cachePath, hash])
                        );
                        if (cacheFile.query_exists(null))
                            gicon = Gio.FileIcon.new(cacheFile);
                        else
                            this._indicator._loadAvatar(room.avatarUrl, null, fallback);
                    }
                    if (!gicon)
                        gicon = Gio.Icon.new_for_string(fallback);
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
};