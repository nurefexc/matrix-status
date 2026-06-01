import { WebClient } from './web.js';
import { ElementClient } from './element.js';
import { FractalClient } from './fractal.js';
import { SchildiChatClient } from './schildichat.js';
import { NeoChatClient } from './neochat.js';

export const ALL_CLIENTS = [
    new WebClient(),
    new ElementClient(),
    new FractalClient(),
    new SchildiChatClient(),
    new NeoChatClient(),
];

/**
 * Gets a client by its ID.
 * @param {number} id
 * @returns {import('./base.js').BaseClient}
 */
export function getClientById(id) {
    return ALL_CLIENTS.find(c => c.id === id) || ALL_CLIENTS[0];
}
