import type { ArchitectureModule } from './architecture.ts'

export const recordOutboxModules: ArchitectureModule[] = [
  {
    file: 'orchestrator/src/record/outbox-enqueue.ts',
    allowed: [
      'node:fs',
      'node:path',
      'bun:sqlite',
      'shared/state-directory.ts',
      'orchestrator/src/database/write-commit-effects.ts',
    ],
  },
  {
    file: 'orchestrator/src/record/outbox-quarantine.ts',
    allowed: [
      'bun:sqlite',
      'shared/brand.ts',
      'shared/record-id.ts',
      'shared/state-directory.ts',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/database/write-commit-effects.ts',
      'orchestrator/src/record/outbox-enqueue.ts',
      'orchestrator/src/record/outbox-held-contract.ts',
    ],
  },
  {
    file: 'orchestrator/src/record/outbox-prune-payload.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/record/outbox-prune-query.ts',
    allowed: ['orchestrator/src/record/outbox-prune-payload.ts'],
  },
  {
    file: 'orchestrator/src/record/outbox-prune.ts',
    allowed: [
      'bun:sqlite',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/record/outbox-prune-query.ts',
      'orchestrator/src/record/outbox-prune-payload.ts',
    ],
  },
]
