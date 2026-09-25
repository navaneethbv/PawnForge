import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['engine/Stockfish/**', 'macos/.build/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['server.js', 'chess-analysis.js', 'engine-worker.js', '*.config.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/**/*.js', 'overlay.js', 'background.js', 'tests/browser/**/*.js'],
    languageOptions: { globals: { ...globals.browser, chrome: 'readonly' } },
  },
];
