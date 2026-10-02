import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      'react-hooks/purity': 'off',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    // Backend. The deliberate split in this repo is ESM TypeScript on the
    // frontend and CommonJS .cjs on the server (package.json is
    // "type": "module"), so these need their own block: node globals and
    // sourceType commonjs rather than the TS parser.
    //
    // This was the gap that let server.cjs ship an alert-state key that never
    // matched a real key, and a purge window hardcoded straight into SQL.
    files: ['**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      // Server handlers routinely take (req, res, next) and ignore the tail;
      // an underscore prefix is how they say so.
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Node tooling scripts. These are .js but ESM, since package.json sets
    // "type": "module" - the mock device and this config file itself.
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
])