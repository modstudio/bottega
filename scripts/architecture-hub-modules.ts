export const hubModuleSpecs = [
  {
    file: 'hub/src/board-contract.ts',
    allowed: ['zod', '../../shared/record-id.ts'],
  },
  {
    file: 'hub/src/evidence-api.ts',
    allowed: [
      '../../shared/record-space-membership.ts',
      '../../shared/record-space-request.ts',
      './hosted-evidence.ts',
    ],
  },
  { file: 'hub/deploy/site/src/decision.ts', allowed: [] },
  {
    file: 'hub/deploy/site/src/worker.ts',
    allowed: ['./decision.ts', 'shared/brand.ts'],
  },
  {
    file: 'hub/src/fixture-question-reclaim.ts',
    allowed: ['./db.ts', './orch.ts', './reconcile.ts'],
  },
  {
    file: 'hub/src/task-identity.ts',
    allowed: ['bun:sqlite', './db.ts', './task-adoption.ts'],
  },
  {
    file: 'hub/src/task-api.ts',
    allowed: [
      '../../shared/record-space-membership.ts',
      '../../shared/record-space-request.ts',
      './hosted-task-prune.ts',
      './hosted-tasks.ts',
    ],
  },
  {
    file: 'hub/src/service-revision.ts',
    allowed: ['../../shared/install-root.ts', '../../shared/process-identity.ts', './db.ts'],
  },
  {
    file: 'hub/src/serve-lifecycle.ts',
    allowed: ['../../shared/process-identity.ts', '../../shared/state-directory.ts'],
  },
] as const
