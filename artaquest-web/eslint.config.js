import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `src/generated` is emitted by the Arta pipeline in ArtaQuest/artalife and re-synced by
  // tools/arta-sync.mjs. Linting it means either editing a file that the next sync overwrites, or
  // a gate that goes red on a commit nobody here authored. Fix generated code in its generator.
  globalIgnores(['dist', 'src/generated']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // eslint-plugin-react-hooks v6's recommended config turns on the EXPERIMENTAL React Compiler
      // lint rules by default. On this pre-existing codebase they flag many valid, working patterns
      // (mount-time setState, intentional `window.location` assignment, refs read in callbacks, inline
      // render helpers) — none of which are bugs, and we have not adopted the React Compiler. Rather
      // than mass-rewrite dozens of working components (risking regressions), we disable just these
      // experimental rules and keep the rest of the ruleset strict. Revisit if/when we enable the
      // React Compiler, at which point these become meaningful and can be fixed deliberately.
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
    },
  },
])
