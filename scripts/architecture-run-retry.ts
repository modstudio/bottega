export const runRetryModuleSpecs = [
  {
    name: 'run-retry-boundary',
    file: 'orchestrator/src/run/run-retry.ts',
    allowed: [],
    typeOnlyAllowed: [],
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
      './continuation-tree-service.ts',
      './resume-tree.ts',
      './run-retry.ts',
      './run-alive.ts',
      './run-control.ts',
      './run-lease.ts',
    ],
    typeOnlyAllowed: ['./run-resume-options.ts'],
    reason:
      'Keep retry workspace resolution independent of contracts, transports, routing, reviews, and the CLI.',
  },
] as const
