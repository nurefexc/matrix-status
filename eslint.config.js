import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        plugins: {
            '@stylistic': stylistic,
        },
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.es2021,
                // GNOME Shell and GObject specific globals
                imports: 'readonly',
                Intl: 'readonly',
                TextDecoder: 'readonly',
                console: 'readonly',
                print: 'readonly',
                log: 'readonly',
                logError: 'readonly',
            },
        },
        rules: {
            ...stylistic.configs['recommended-flat'].rules,
            '@stylistic/indent': ['error', 4],
            '@stylistic/semi': ['error', 'always'],
            '@stylistic/quotes': ['error', 'single'],
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-console': 'off',
        },
    },
    {
        ignores: [
            'node_modules/',
            '*.zip',
            'schemas/gschemas.compiled',
        ],
    },
];
