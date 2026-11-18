// concern: architecture-manifest
/** Context health module allowlists kept outside the root manifest's file ceiling. */
import { dirname, normalize } from 'node:path'

type ContextHealthModule = { file: string; allowed: string[] }
const module = (file: string, allowed: string[]): ContextHealthModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const contextHealthModules: ContextHealthModule[] = [
  module('orchestrator/src/context-health/context-health.ts', [
    '../../../shared/brand.ts',
    '../../../shared/context-item-vocabulary.ts',
    '../board/board-store.ts',
    '../doc/context-cursor-warning-decision.ts',
    '../doc/doc-context-write.ts',
    '../doc/doc-lint.ts',
    '../record/record-task-flow-contract.ts',
    '../session/context-review-decision.ts',
    '../state/statistics.ts',
  ]),
  module('orchestrator/src/context-health/context-health-adapter.ts', [
    '../../../shared/board-duration.ts',
    '../../../shared/brand.ts',
    '../../../shared/context-item-vocabulary.ts',
    '../database/db.ts',
    '../doc/context-service.ts',
    '../doc/doc-lint.ts',
    '../doc/doc-lint-adapter.ts',
    '../project/projects.ts',
    '../record/record-task-flow-contract.ts',
    '../session/brief-injection.ts',
    '../session/context-review-store.ts',
    '../workflow/task-flow-store.ts',
    '../workflow/workflow-cursor-list.ts',
    '../workflow/workflow-task-reference.ts',
    './context-health.ts',
  ]),
  module('orchestrator/src/context-health/context-health-render.ts', ['./context-health.ts']),
]
