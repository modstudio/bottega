import { workflowFloorBoundarySpecs } from './architecture-workflow-floor-modules.ts'

const projectTaskListSurfaces = {
  board: [
    'orchestrator/src/issue/issue-dispatch.ts',
    'orchestrator/src/session/session-epic-work.ts',
    'orchestrator/src/workflow/workflow-child-service.ts',
  ],
  reports: [
    'orchestrator/src/branch/task-status-observation.ts',
    'orchestrator/src/doc/context-brief.ts',
    'orchestrator/src/run/run-task-linking.ts',
    'orchestrator/src/session/context-review.ts',
    'orchestrator/src/session/session-close-out-obligation-adapter.ts',
    'orchestrator/src/workflow/workflow-cursor-report.ts',
  ],
  contextHealth: ['orchestrator/src/context-health/context-health-adapter.ts'],
  hostedMirrorOrSync: [
    'orchestrator/src/commands/cleanup.ts',
    'orchestrator/src/cleanup/cleanup-sweep.ts',
    'orchestrator/src/cleanup/cleanup-sweep-hub-tasks.ts',
  ],
  projectLifecycle: ['orchestrator/src/project/default-local-project-retirement.ts'],
} as const

const exactPath = (path: string) => `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`

export const projectTaskListImportRule = {
  name: 'project-task-list-has-declared-surface-importers',
  severity: 'error' as const,
  comment:
    'Project-wide task lists belong only to task-list, board, report, context-health, hosted mirror or sync, and project-lifecycle surfaces. Project lifecycle is administrative and may need a zero-task answer that no narrower query provides.',
  from: {
    path: '^orchestrator/src/',
    pathNot: Object.values(projectTaskListSurfaces).flat().map(exactPath),
  },
  to: { path: exactPath('orchestrator/src/workflow/project-task-list.ts') },
}

export const workflowBoundarySpecs = [
  ...workflowFloorBoundarySpecs,
  {
    name: 'project-task-list-boundary',
    file: 'orchestrator/src/workflow/project-task-list.ts',
    allowed: ['./task-read-port.ts', './workflow-task-reference.ts'],
    reason:
      'Keep the expensive project-wide read in the one module whose importers are manifest-gated.',
  },
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
