// concern: architecture-manifest
/** Workflow floor-evidence module allowlists, kept outside the root manifest to preserve its file ceiling. */
import { dirname, normalize } from 'node:path'

type WorkflowFloorModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): WorkflowFloorModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const workflowFloorModules: WorkflowFloorModule[] = [
  module('orchestrator/src/workflow/workflow-cursor-transition.ts', []),
  module('orchestrator/src/workflow/workflow-cursor-trail.ts', []),
  module('orchestrator/src/workflow/workflow-cursor-format.ts', []),
  module('orchestrator/src/workflow/workflow-cursor-arguments.ts', [
    'bun:sqlite',
    '../database/db.ts',
    './workflow-cursor-format.ts',
    './workflow-cursor-trail.ts',
    './workflows.ts',
  ]),
  module('orchestrator/src/workflow/workflow-cursor-adoption.ts', [
    'bun:sqlite',
    '../database/db.ts',
    '../run/question-outbox.ts',
  ]),
  module('orchestrator/src/workflow/workflow-cursor-selection.ts', [
    'bun:sqlite',
    '../database/db.ts',
    './workflow-cursor-arguments.ts',
    './workflow-cursor-trail.ts',
    './workflow-cursor-transition.ts',
    './workflows.ts',
  ]),
  module('orchestrator/src/workflow/workflow-floor.ts', []),
  module('orchestrator/src/workflow/workflow-floor-evidence.ts', [
    'bun:sqlite',
    'node:child_process',
    'node:fs',
    'node:path',
    '../../../shared/self-spawn.ts',
    '../artifact-paths.ts',
    '../branch/merged-pull-request.ts',
    '../branch/task-key-pull-request.ts',
    '../database/database-location.ts',
    '../database/db.ts',
    '../project/projects.ts',
    './workflow-floor.ts',
  ]),
  module('orchestrator/src/workflow/workflow-probe.ts', [
    'bun:sqlite',
    'node:child_process',
    'node:fs',
    'node:os',
    'node:path',
    '../../../shared/secret-shaped.ts',
    '../database/db.ts',
    '../gate/gate-decision.ts',
    '../sandbox/sandbox.ts',
    '../sandbox/sandbox-runtime.ts',
  ]),
  module('orchestrator/src/workflow/workflow-cursor.ts', [
    'bun:sqlite',
    'node:crypto',
    '../database/db.ts',
    '../project/projects.ts',
    '../operator/operator-waiting.ts',
    './autonomy.ts',
    '../run/question-vocabulary.ts',
    '../run/question-mutation.ts',
    '../run/question-close.ts',
    '../run/question-open.ts',
    '../run/question-outbox.ts',
    './workflow-floor.ts',
    './workflow-floor-evidence.ts',
    './workflow-render.ts',
    './workflows.ts',
    './workflow-cursor-transition.ts',
    './workflow-cursor-trail.ts',
    './workflow-cursor-arguments.ts',
    './workflow-cursor-adoption.ts',
    './workflow-cursor-format.ts',
    './workflow-cursor-selection.ts',
    './workflow-step-reference.ts',
  ]),
]
