import { workflowFloorBoundarySpecs } from './architecture-workflow-floor-modules.ts'

export const workflowBoundarySpecs = [
  ...workflowFloorBoundarySpecs,
  {
    name: 'workflow-task-claim-boundary',
    file: 'orchestrator/src/workflow/workflow-task-claim.ts',
    allowed: [
      '../board/board-claim-policy.ts',
      '../board/board-operations.ts',
      'bun:sqlite',
      '../database/db.ts',
      '../project/projects.ts',
      '../run/run-task-claim-renewal.ts',
    ],
    reason:
      'Keep the cursor-to-claim decision pure and route its local or hosted write through the board service.',
  },
  {
    name: 'workflow-read-space-boundary',
    file: 'orchestrator/src/workflow/workflow-read-space.ts',
    allowed: [
      'bun:sqlite',
      '../../../shared/brand.ts',
      '../../../shared/record-remedies.ts',
      '../project-space-cache.ts',
      '../project-space.ts',
      '../project/declared-record-space.ts',
      '../project/projects.ts',
      '../record/install-binding.ts',
    ],
    reason:
      'Keep cross-owner workflow read routing in one adapter while the cache and routing decision remain pure.',
  },
] as const
