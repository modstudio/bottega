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
    '../doc/context-cursor-warning-decision.ts',
    '../doc/doc-context-write.ts',
    '../session/context-review-decision.ts',
  ]),
  module('orchestrator/src/context-health/context-health-adapter.ts', [
    'bun:sqlite',
    '../../../shared/board-duration.ts',
    '../../../shared/brand.ts',
    '../../../shared/context-item-vocabulary.ts',
    '../database/db.ts',
    '../doc/context-service.ts',
    '../doc/doc-lint.ts',
    '../doc/doc-lint-adapter.ts',
    '../project/projects.ts',
    '../run/run-status.ts',
    '../workflow/task-flow-store.ts',
    '../workflow/workflow-task-reference.ts',
    './context-health.ts',
  ]),
  module('orchestrator/src/context-health/context-health-render.ts', ['./context-health.ts']),
]
