export const runStopBoundarySpecs = [
  {
    name: 'run-stop-boundary',
    file: 'orchestrator/src/run/run-stop.ts',
    allowed: [
      '../cleanup/cleanup.ts',
      '../database/db.ts',
      '../record/machine-identity.ts',
      '../resources/resource-ownership.ts',
      './run-authority.ts',
      './run-liveness.ts',
      './run-outbox.ts',
      './question-vocabulary.ts',
      './question-outbox.ts',
      './question-close.ts',
      './question-open.ts',
      '../worktree/worktree-remove.ts',
      '../worktree/worktree-types.ts',
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep run-stop independent of transports, routing, reviews, contracts, the CLI, and durable execution.',
  },
] as const
