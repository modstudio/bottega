import type { ArchitectureModule } from './architecture.ts'

export const recordOutboxModules: ArchitectureModule[] = [
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
