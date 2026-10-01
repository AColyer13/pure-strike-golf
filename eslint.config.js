import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['vendor/**', 'legacy/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser } },
  },
  { files: ['sw.js'], languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } } },
  {
    files: ['tests/**/*.mjs', 'tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': ['warn', { destructuring: 'all' }],
      eqeqeq: ['error', 'smart'],
    },
  },
];
