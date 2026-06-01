import { BaseClient } from './base.js';

export class ElementClient extends BaseClient {
    constructor() {
        super(1, 'Element', 'element.svg');
    }

    getUrl(roomId = null) {
        return roomId ? `element://vector/webapp/#/room/${roomId}` : 'element://';
    }
}
