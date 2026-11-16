export const questionPortPublicModules = [
  'orchestrator/src/question-store/question-store-mutation.ts',
  'orchestrator/src/question-store/question-store-read.ts',
]

export const questionCallerModules = [
  {
    file: 'orchestrator/src/workflow/task-flow-store-sqlite-questions.ts',
    allowed: [
      'bun:sqlite',
      'orchestrator/src/question-store/question-store-sqlite-reads.ts',
      'orchestrator/src/workflow/task-flow-store-types.ts',
    ],
  },
  {
    file: 'orchestrator/src/run/question-close.ts',
    allowed: [
      'shared/brand.ts',
      'orchestrator/src/database/db.ts',
      'orchestrator/src/run/question-delivery-pending.ts',
      'orchestrator/src/workflow/task-flow-store-types.ts',
      'orchestrator/src/workflow/task-flow-store.ts',
      'orchestrator/src/run/question-delivery.ts',
      'orchestrator/src/run/question-mutation.ts',
      'orchestrator/src/run/question-open.ts',
      'orchestrator/src/run/question-outbox.ts',
    ],
  },
]
