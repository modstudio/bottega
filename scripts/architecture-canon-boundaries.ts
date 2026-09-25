import type { ImportBoundary } from './architecture-boundaries.ts'
import { canonLoadBoundarySpecs } from './architecture-canon-load-boundaries.ts'

const source = 'orchestrator/src/canon/'

const canonCommandBoundarySpecs: ImportBoundary[] = [
  {
    name: 'canon-commands-boundary',
    file: `${source}canon-commands.ts`,
    allowed: [
      'node:fs',
      'node:path',
      'zod',
      `${source}canon.ts`,
      `${source}canon-files.ts`,
      `${source}canon-hydrate.ts`,
      `${source}canon-lint.ts`,
      `${source}canon-write-gate.ts`,
      `${source}canon-load-files.ts`,
      `${source}canon-load.ts`,
      `${source}user-canon-commands.ts`,
      'orchestrator/src/agent/worker-launch-env.ts',
      'orchestrator/src/doc/docs.ts',
      `${source}evals.ts`,
      'orchestrator/src/project/projects.ts',
      'shared/ratchet.ts',
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep canon command adapters independent of runs, routing, transports, the CLI, and worktrees.',
  },
]

const userCanonBoundarySpecs: ImportBoundary[] = [
  {
    name: 'user-canon-import-boundary',
    file: 'orchestrator/src/doc/user-canon-import.ts',
    allowed: [
      'orchestrator/src/database/db.ts',
      'orchestrator/src/record/record-api-client.ts',
      'orchestrator/src/doc/doc-read-store.ts',
      'orchestrator/src/doc/doc-revision-store.ts',
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep user canon batch mirroring independent of commands, filesystems, and unrelated stores.',
  },
  {
    name: 'user-canon-commands-boundary',
    file: `${source}user-canon-commands.ts`,
    allowed: [
      'shared/ratchet.ts',
      'orchestrator/src/doc/docs.ts',
      'orchestrator/src/doc/doc-write-allowed.ts',
      'orchestrator/src/doc/user-canon-import.ts',
      'orchestrator/src/project/projects.ts',
      `${source}canon-lint.ts`,
      `${source}canon-write-gate.ts`,
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

export const canonBoundarySpecs = [
  ...canonCommandBoundarySpecs,
  ...userCanonBoundarySpecs,
  ...canonLoadBoundarySpecs,
]
