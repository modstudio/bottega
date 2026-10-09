// concern: architecture-manifest
/** Test-substance module allowlists shared by the gate and orchestrator. */

export const testSubstanceModules = [
  {
    file: 'shared/test-substance/test-substance.ts',
    allowed: ['../ratchet.ts', './test-substance-eslint.ts', './test-substance-php.ts'],
  },
  {
    file: 'shared/test-substance/test-substance-php.ts',
    allowed: ['./test-substance.ts'],
  },
  {
    file: 'shared/test-substance/test-substance-eslint.ts',
    allowed: [
      '@typescript-eslint/parser',
      '@vitest/eslint-plugin',
      'eslint',
      'eslint-plugin-jest',
      'eslint-plugin-sonarjs',
      'typescript',
      'node:path',
      './expect-without-matcher.ts',
      './no-assertion.ts',
      './relative-module.ts',
      './self-comparison.ts',
      './test-substance.ts',
      './vitest-async-assertion.ts',
    ],
  },
  { file: 'shared/test-substance/expect-without-matcher.ts', allowed: ['eslint'] },
  {
    file: 'shared/test-substance/no-assertion.ts',
    allowed: ['node:path', 'eslint', 'typescript', './relative-module.ts'],
  },
  {
    file: 'shared/test-substance/relative-module.ts',
    allowed: ['node:fs', 'node:path', 'typescript'],
  },
  {
    file: 'shared/test-substance/no-assertion.test.ts',
    allowed: ['bun:test', 'node:path', './test-substance-eslint.ts'],
  },
  { file: 'shared/test-substance/vitest-async-assertion.ts', allowed: ['eslint'] },
  { file: 'shared/test-substance/self-comparison.ts', allowed: ['eslint'] },
  {
    file: 'orchestrator/src/test-substance-commands.ts',
    allowed: [
      'node:fs',
      'node:path',
      '../../shared/test-substance/test-substance.ts',
      './test-substance-project-policy.ts',
    ],
  },
  {
    file: 'orchestrator/src/test-substance-project-policy.ts',
    allowed: [
      'bun:sqlite',
      '../../shared/test-substance/test-substance.ts',
      './database/db.ts',
      './project/project-settings.ts',
      './project/projects.ts',
    ],
  },
  {
    file: 'orchestrator/src/commands/test-substance.ts',
    allowed: ['commander', '../test-substance-commands.ts', './support.ts'],
  },
] as const
