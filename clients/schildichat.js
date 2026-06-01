import { BaseClient } from './base.js';

export class SchildiChatClient extends BaseClient {
    constructor() {
        super(3, 'SchildiChat', 'schildichat.svg');
    }

    getUrl(roomId = null) {
        return roomId ? `schildichat://vector/webapp/#/room/${roomId}` : 'schildichat://';
    }
}
