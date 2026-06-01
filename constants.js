/**
 * Client configurations
 */
export const CLIENT_CONFIGS = {
    0: { name: 'Web (matrix.to)', icon: 'matrix.svg' },
    1: { name: 'Element', icon: 'element.svg' },
    2: { name: 'Fractal', icon: 'fractal.svg' },
    3: { name: 'SchildiChat', icon: 'schildichat.svg' },
    4: { name: 'NeoChat', icon: 'neochat.svg' },
};

/**
 * GSettings keys
 */
export const SETTINGS_KEYS = {
    HOMESERVER_URL: 'homeserver-url',
    ACCESS_TOKEN: 'access-token',
    SYNC_INTERVAL: 'sync-interval',
    CLIENT_TYPE: 'client-type',
    NOTIFICATIONS_ENABLE: 'notifications-enable',
    GENERATE_QR_ENABLE: 'generate-qr-code-enable',
    VISIT_COUNTS: 'visit-counts',
};

/**
 * Sync filter
 */
export const SYNC_FILTER = {
    room: {
        state: {
            types: [
                'm.room.name', 'm.room.member', 'm.room.canonical_alias',
                'm.room.encryption', 'm.room.avatar',
            ],
            lazy_load_members: true,
        },
        timeline: { limit: 1 },
        account_data: { types: ['m.tag'] },
    },
};
