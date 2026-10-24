export const runResumeModuleSpecs = [
  {
    file: 'orchestrator/src/run/run-base-resolution.ts',
    allowed: ['bun:sqlite', '../database/db.ts', '../git/git-environment.ts'],
  },
  {
    file: 'orchestrator/src/run/resume-tree.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/run-resume-kind.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/continuation-message.ts',
    allowed: ['node:crypto'],
  },
  {
    file: 'orchestrator/src/run/checkpoint-resume-context.ts',
    allowed: ['../../../shared/git.ts'],
  },
  {
    file: 'orchestrator/src/run/continuation-checkpoint-context.ts',
    allowed: ['bun:sqlite', './checkpoint.ts', './resume-tree.ts', './run-resume-kind.ts'],
  },
  {
    file: 'orchestrator/src/run/continuation-checkout.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/continuation-checkout-service.ts',
    allowed: ['../project/projects.ts', './continuation-checkout.ts'],
  },
  {
    file: 'orchestrator/src/run/continuation-provision-decision.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/continuation-provision-service.ts',
    allowed: [
      '../../../shared/brand.ts',
      '../project/projects.ts',
      '../worktree/worktree-seed.ts',
      './continuation-provision-decision.ts',
      './continuation-tree-decision.ts',
      './continuation-tree-service.ts',
    ],
  },
  {
    file: 'orchestrator/src/run/continuation-tree-decision.ts',
    allowed: [],
  },
  {
    file: 'orchestrator/src/run/continuation-tree-service.ts',
    allowed: ['node:fs', '../git/git-environment.ts', './continuation-tree-decision.ts'],
  },
] as const
