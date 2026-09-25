export const branchModuleSpecs = [
  { file: 'orchestrator/src/branch/branch-landing-record.ts', allowed: ['./branch-state.ts'] },
  { file: 'orchestrator/src/branch/branch-state.ts', allowed: ['./merged-pull-request.ts'] },
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
