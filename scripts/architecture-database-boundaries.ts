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
      'orchestrator/src/caller-classification.ts',
      `${source}contention.ts`,
      `${source}database-location.ts`,
      `${source}machine-identity-store.ts`,
      `${source}migrations.ts`,
      `${source}project-register-store.ts`,
    ],
    typeOnlyAllowed: [],
    reason: 'Enforce the database concern boundary.',
  },
  {
    name: 'machine-identity-store-boundary',
    file: `${source}machine-identity-store.ts`,
    allowed: ['shared/record/schema.ts'],
    typeOnlyAllowed: ['bun:sqlite'],
    reason: 'Enforce the machine identity store concern boundary.',
  },
]
