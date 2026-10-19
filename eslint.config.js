// Lint configuration (development only): `npm ci && npm run lint`.
import js from '@eslint/js';
import globals from 'globals';

// What gjs and GNOME Shell define globally for an ES module.
const gjs = {
    ...globals.es2024,
    global: 'readonly',
    console: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    imports: 'readonly',
    ARGV: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
};

export default [
    { ignores: ['node_modules/'] },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: gjs },
        rules: {
            // A leading underscore marks a deliberately unused binding. A
            // caught error may go unused when the handler is the fallback;
            // an empty catch block is still an error (no-empty).
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            'eqeqeq': ['error', 'smart'],
            'no-var': 'error',
            'prefer-const': ['error', { destructuring: 'all' }],
            'no-shadow': 'error',
        },
    },
    {
        // Node scripts: the config itself and the source checks.
        files: ['eslint.config.js', 'tests/**/*.mjs'],
        languageOptions: { globals: globals.node },
    },
];
