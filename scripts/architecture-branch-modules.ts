export const branchModuleSpecs = [
  {
    file: 'orchestrator/src/branch/create-time-settlement.ts',
    allowed: [
      '../database/db.ts',
      '../git/git-environment.ts',
      '../resources/resource-claims.ts',
      '../worktree/worktree-types.ts',
    ],
  },
  { file: 'orchestrator/src/branch/branch-landing-record.ts', allowed: ['./branch-state.ts'] },
  {
    file: 'orchestrator/src/branch/branch-landing-match.ts',
    allowed: ['./branch-landing-record.ts'],
  },
  {
    file: 'orchestrator/src/branch/branch-landing-service.ts',
    allowed: [
      '../database/db.ts',
      '../git/git-environment.ts',
      '../project/projects.ts',
      '../pull-request/pr-admission.ts',
      './branch-landing-record.ts',
    ],
  },
  {
    file: 'orchestrator/src/branch/task-key-pull-request.ts',
    allowed: ['bun:sqlite', '../database/db.ts'],
  },
  { file: 'orchestrator/src/branch/branch-state.ts', allowed: ['./merged-pull-request.ts'] },
  {
    file: 'orchestrator/src/branch/offline-branch-landing.ts',
    allowed: [
      'bun:sqlite',
      '../database/db.ts',
      '../git/git-environment.ts',
      '../project/projects.ts',
      './branch-state.ts',
      './task-branch.ts',
    ],
  },
  {
    file: 'orchestrator/src/branch/task-branch-reuse.ts',
    allowed: ['../git/git-environment.ts', './task-branch.ts'],
  },
  {
    file: 'orchestrator/src/branch/merged-pull-request.ts',
    allowed: ['../git/git-environment.ts', '../project/projects.ts'],
  },
  {
    file: 'orchestrator/src/branch/other-branch-state.ts',
    allowed: ['./branch-state.ts', './merged-pull-request.ts'],
  },
] as const
