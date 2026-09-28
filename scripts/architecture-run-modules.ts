export const runModuleBoundarySpecs = [
  {
    name: 'run-coordinator-log-boundary',
    file: 'orchestrator/src/run/run-coordinator-log.ts',
    allowed: ['node:fs', 'node:path', '../../../shared/secret-shaped.ts', './run-artifacts.ts'],
    typeOnlyAllowed: [],
    reason: 'Keep coordinator diagnostics independent of run lifecycle policy and database state.',
  },
  {
    name: 'run-diff-boundary',
    file: 'orchestrator/src/run/run-diff.ts',
    allowed: [
      'node:fs',
      '../database/db.ts',
      '../git/git-environment.ts',
      '../project/projects.ts',
    ],
    typeOnlyAllowed: [],
    reason:
      'Keep run diff independent of run control, transports, routing, the CLI, and worktrees by value.',
  },
] as const
