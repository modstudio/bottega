export const runRetryBoundarySpecs = [
  {
    name: 'run-retry-boundary',
    file: 'orchestrator/src/run/run-retry.ts',
    allowed: [],
    reason:
      'Keep retry path and prompt decisions independent of stores, Git, projects, worktrees, routing, and transports.',
  },
  {
    name: 'run-retry-workspace-boundary',
    file: 'orchestrator/src/run/run-retry-workspace.ts',
    allowed: [
      'node:fs',
      '../../../shared/process-identity.ts',
      '../database/db.ts',
      '../git/git-environment.ts',
      '../project/projects.ts',
      '../worktree/worktree-types.ts',
      './branch-owner-guard.ts',
      './checkpoint.ts',
      './resume-tree.ts',
      './run-retry.ts',
      './run-alive.ts',
      './run-control.ts',
      './run-lease.ts',
    ],
    reason:
      'Keep writing-retry workspace resolution independent of contracts, transports, routing, reviews, and the CLI.',
  },
] as const
