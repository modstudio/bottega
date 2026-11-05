// concern: architecture-manifest
/** Storage lifecycle module allowlists, split from the record manifest to preserve its ceiling. */

export const storageRecordModules = [
  {
    file: 'orchestrator/src/record/record-storage.ts',
    allowed: ['shared/storage-lifecycle.ts', 'orchestrator/src/record/record-pool.ts'],
  },
  {
    file: 'orchestrator/src/record/record-api-storage.ts',
    allowed: ['hono', 'shared/storage-lifecycle.ts', 'orchestrator/src/record/record-auth.ts'],
  },
]
