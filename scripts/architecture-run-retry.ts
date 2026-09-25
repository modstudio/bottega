export const runRetryBoundarySpecs = [
  {
    name: 'run-retry-boundary',
    file: 'orchestrator/src/run/run-retry.ts',
    allowed: ['../../../shared/process-identity.ts'],
    reason:
      'Keep retry path and prompt decisions independent of stores, Git, projects, worktrees, routing, and transports.',
  },
  {
    name: 'run-retry-workspace-boundary',
    file: 'orchestrator/src/run/run-retry-workspace.ts',
    allowed: [
      'node:fs',
      '../database/db.ts',
      '../git/git-environment.ts',
      '../project/projects.ts',
      '../worktree/worktree-types.ts',
      './branch-owner-guard.ts',
      './checkpoint.ts',
      './resume-tree.ts',
      './run-retry.ts',
    ],
    reason:
      'Keep writing-retry workspace resolution independent of contracts, transports, routing, reviews, and the CLI.',
  },
] as const
