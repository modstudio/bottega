import type { ImportBoundary } from './architecture-boundaries.ts'

const source = 'orchestrator/src/canon/'

export const userCanonBoundarySpecs: ImportBoundary[] = [
  {
    name: 'user-canon-commands-boundary',
    file: `${source}user-canon-commands.ts`,
    allowed: [
      'shared/ratchet.ts',
      'orchestrator/src/doc/docs.ts',
      `${source}canon-lint.ts`,
      `${source}user-canon-home.ts`,
      `${source}user-canon-home-files.ts`,
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep user canon commands independent of runs, routing, transports, the CLI, and worktrees.',
  },
  {
    name: 'user-canon-home-boundary',
    file: `${source}user-canon-home.ts`,
    allowed: ['node:path', 'shared/brand.ts'],
    typeOnlyAllowed: [],
    reason:
      'Keep user canon home mapping and hydration decisions pure and independent of filesystems, stores, commands, and processes.',
  },
  {
    name: 'user-canon-home-files-boundary',
    file: `${source}user-canon-home-files.ts`,
    allowed: ['node:fs', 'node:path', `${source}user-canon-home.ts`],
    typeOnlyAllowed: [],
    reason:
      'Keep user canon home file access independent of stores, commands, runs, routing, and transports.',
  },
]
