// concern: architecture-manifest
/** Test-substance module allowlists shared by the gate and orchestrator. */

export const testSubstanceModules = [
  {
    file: 'shared/test-substance/test-substance.ts',
    allowed: ['../ratchet.ts', './test-substance-eslint.ts'],
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
      './expect-without-matcher.ts',
      './no-assertion.ts',
      './self-comparison.ts',
      './test-substance.ts',
    ],
  },
  { file: 'shared/test-substance/expect-without-matcher.ts', allowed: ['eslint'] },
  { file: 'shared/test-substance/no-assertion.ts', allowed: ['eslint'] },
  { file: 'shared/test-substance/self-comparison.ts', allowed: ['eslint'] },
  {
    file: 'orchestrator/src/test-substance/test-substance-commands.ts',
    allowed: ['node:fs', 'node:path', '../../../shared/test-substance/test-substance.ts'],
  },
  {
    file: 'orchestrator/src/commands/test-substance.ts',
    allowed: ['commander', '../test-substance/test-substance-commands.ts', './support.ts'],
  },
] as const
