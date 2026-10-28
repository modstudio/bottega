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
      'shared/machine-config.ts',
      'shared/process-identity.ts',
      'shared/record-id.ts',
      'shared/read-only-database-access.ts',
      'shared/store-access.ts',
      'orchestrator/src/caller-classification.ts',
      `${source}contention.ts`,
      `${source}database-file-family.ts`,
      `${source}database-location.ts`,
      `${source}machine-identity-store.ts`,
      `${source}migration-compatibility.ts`,
      `${source}migration-drain-state.ts`,
      `${source}migration-window-decision.ts`,
      `${source}migrations.ts`,
      `${source}project-register-store.ts`,
      `${source}store-actor.ts`,
      `${source}wal-persistence.ts`,
      `${source}write-probe.ts`,
    ],
    typeOnlyAllowed: [],
    reason: 'Enforce the database concern boundary.',
  },
  {
    name: 'write-probe-policy-boundary',
    file: `${source}write-probe.ts`,
    allowed: [],
    typeOnlyAllowed: [],
    reason: 'Keep write-probe naming and stale classification pure over observed facts.',
  },
  {
    name: 'machine-identity-store-boundary',
    file: `${source}machine-identity-store.ts`,
    allowed: ['shared/machine-config.ts'],
    typeOnlyAllowed: ['bun:sqlite', 'shared/config-directory.ts'],
    reason: 'Enforce the machine identity store concern boundary.',
  },
]
