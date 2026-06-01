/**
 * BaseClient is the base class for all Matrix client integrations.
 */
export class BaseClient {
    constructor(id, name, icon) {
        this.id = id;
        this.name = name;
        this.icon = icon;
    }

    /**
     * Returns the URI to open the client, optionally for a specific room.
     * @param {string|null} roomId
     * @returns {string}
     */
    getUrl(roomId = null) {
        throw new Error('getUrl() must be implemented by subclasses');
    }
}
