import { BaseClient } from './base.js';

export class WebClient extends BaseClient {
    constructor() {
        super(0, 'Web (matrix.to)', 'matrix.svg');
    }

    getUrl(roomId = null) {
        return roomId ? `https://matrix.to/#/${roomId}` : 'https://matrix.to';
    }
}
