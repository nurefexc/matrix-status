import { BaseClient } from './base.js';

export class NeoChatClient extends BaseClient {
    constructor() {
        super(4, 'NeoChat', 'neochat.svg');
    }

    getUrl(roomId = null) {
        if (!roomId) return 'matrix:';
        const encodedId = roomId.replace(/:/g, '%3A').replace(/^!/, '');
        const prefix = roomId.startsWith('@') ? 'u' : 'roomid';
        return `matrix:${prefix}/${encodedId}?action=chat`;
    }
}
