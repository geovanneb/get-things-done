// ESLint flat config for the CLI, server, UI and scripts.
// Rules that flag a lot of existing code are warnings for now, so the lint step can
// block on real errors from day one. Tighten them in small follow-up PRs.
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = tseslint.config(
  {
    ignores: ['**/node_modules/', '**/dist/', 'desktop/release/', 'desktop/stage/', 'templates/', 'executive-workspace/', 'coverage/'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  // CLI, server and the Node scripts.
  {
    files: ['src/**/*.ts', 'server/**/*.ts', 'desktop/**/*.ts', 'desktop/**/*.mjs', 'scripts/**/*.mjs', 'bin/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['bin/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // React dashboard.
  {
    files: ['ui/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['ui/vite.config.ts'],
    languageOptions: { globals: globals.node },
  },

  // Formatting belongs to Prettier: turn off every rule that would fight it.
  prettier,
);
