import parser from '@typescript-eslint/parser'
import sonarjs from 'eslint-plugin-sonarjs'

export default [
  {
    ignores: ['hub/web/src/routeTree.gen.ts', '**/migrations/meta/**'],
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
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[property.name='pathname'][object.type='NewExpression'][object.callee.name='URL'][object.arguments.1.type='MemberExpression'][object.arguments.1.object.type='MetaProperty'][object.arguments.1.object.meta.name='import'][object.arguments.1.object.property.name='meta'][object.arguments.1.property.name='url']",
          message: 'Use fileURLToPath(new URL(..., import.meta.url)) for filesystem paths.',
        },
      ],
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },
]
