import parser from '@typescript-eslint/parser'
import sonarjs from 'eslint-plugin-sonarjs'

export default [
  {
    ignores: [
      'hub/web/src/routeTree.gen.ts',
      '**/migrations/meta/**',
    ],
  },
  {
    files: [
      'orchestrator/src/**/*.{ts,tsx}',
      'orchestrator/test/**/*.{ts,tsx}',
      'hub/src/**/*.{ts,tsx}',
      'hub/web/src/**/*.{ts,tsx}',
      'shared/**/*.{ts,tsx}',
      'scripts/**/*.{ts,tsx}',
    ],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { sonarjs },
    rules: {
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
]
