export const workflowBoundarySpecs = [
  {
    name: 'workflow-read-space-boundary',
    file: 'orchestrator/src/workflow/workflow-read-space.ts',
    allowed: [
      'bun:sqlite',
      '../../../shared/brand.ts',
      '../project-space.ts',
      '../project/projects.ts',
      '../record/install-binding.ts',
      '../record/record-project-destination.ts',
    ],
    reason:
      'Keep cross-owner workflow read routing in one adapter while the cache and routing decision remain pure.',
  },
] as const
