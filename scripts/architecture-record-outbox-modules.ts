import type { ArchitectureModule } from './architecture.ts'

export const recordOutboxModules: ArchitectureModule[] = [
  {
    file: 'orchestrator/src/record/outbox-secret-audit.ts',
    allowed: [
      'bun:sqlite',
      'shared/brand.ts',
      'orchestrator/src/record/outbox-prune-payload.ts',
      'orchestrator/src/record/outbox-sanitize.ts',
    ],
  },
  {
    file: 'orchestrator/src/record/hosted-secret-audit.ts',
    allowed: [
      'bun',
      'shared/record/schema-board.ts',
      'shared/record/schema-context-items.ts',
      'shared/record/schema-docs.ts',
      'shared/record/schema-hub.ts',
      'shared/record/schema-question.ts',
      'shared/record/schema-task-flow.ts',
      'shared/record/schema-workflow-catalogue.ts',
      'shared/record/tenant.ts',
      'shared/hosted-secret-mask.ts',
      'shared/secret-shaped.ts',
    ],
  },
  {
    file: 'orchestrator/src/record/outbox-enqueue.ts',
    allowed: [
      'node:fs',
      'node:path',
      'bun:sqlite',
      'shared/state-directory.ts',
      'orchestrator/src/database/session-identity.ts',
      'orchestrator/src/database/write-commit-effects.ts',
      'orchestrator/src/record/outbox-sanitize.ts',
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
      'orchestrator/src/record/outbox-read.ts',
    ],
  },
  {
    file: 'orchestrator/src/record/outbox-score-supersession.ts',
    allowed: [
      'bun:sqlite',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/record/outbox-quarantine.ts',
      'orchestrator/src/record/outbox-read.ts',
    ],
  },
  {
    file: 'orchestrator/src/record/outbox-read.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/record/outbox-held.ts',
    allowed: [
      'bun:sqlite',
      'orchestrator/src/record/outbox-held-contract.ts',
      'orchestrator/src/record/outbox-read.ts',
    ],
  },
  {
    file: 'orchestrator/src/record/outbox-dependency.ts',
    allowed: [
      'bun:sqlite',
      'orchestrator/src/run/run-status.ts',
      'orchestrator/src/record/outbox-prune-payload.ts',
      'orchestrator/src/record/outbox-read.ts',
      'orchestrator/src/record/record-evidence-references.ts',
      'orchestrator/src/record/record-sync-types.ts',
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
