import { BaseClient } from './base.js';

export class FractalClient extends BaseClient {
    constructor() {
        super(2, 'Fractal', 'fractal.svg');
    }

    getUrl(roomId = null) {
        if (!roomId) return 'matrix:';
        const cleanId = roomId.startsWith('!') ? roomId.slice(1) : roomId;
        const encodedId = cleanId.replace(/:/g, '%3A');
        const via = cleanId.includes(':') ? `&via=${cleanId.split(':')[1]}` : '';
        return `matrix:roomid/${encodedId}?action=join${via}`;
    }
}
