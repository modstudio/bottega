import type { ImportBoundary } from './architecture-boundaries.ts'

const source = 'orchestrator/src/database/'

export const databaseBoundarySpecs: ImportBoundary[] = [
  {
    name: 'database-boundary',
    file: `${source}db.ts`,
    allowed: [
      'bun:sqlite',
      'node:crypto',
      'node:fs',
      'node:path',
      'node:url',
      'shared/brand.ts',
      'shared/embedded-assets.ts',
      `${source}contention.ts`,
      `${source}database-location.ts`,
      `${source}migrations.ts`,
    ],
    typeOnlyAllowed: [],
    reason: 'Enforce the database concern boundary.',
  },
]
