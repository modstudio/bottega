import type { ArchitectureModule } from './architecture.ts'

export const recordOutboxModules: ArchitectureModule[] = [
  {
    file: 'orchestrator/src/record/outbox-prune-query.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/record/outbox-prune.ts',
    allowed: [
      'bun:sqlite',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/record/outbox-prune-query.ts',
    ],
  },
]
