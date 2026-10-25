// concern: architecture-manifest
/** Workflow autonomy module allowlists, kept outside the root manifest to preserve its file ceiling. */
import { dirname, normalize } from 'node:path'

type WorkflowAutonomyModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): WorkflowAutonomyModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const workflowAutonomyModules: WorkflowAutonomyModule[] = [
  module('orchestrator/src/workflow/workflow-render.ts', [
    '../../../shared/brand.ts',
    './autonomy.ts',
    './workflow-cursor-format.ts',
    './workflow-floor.ts',
    './workflows.ts',
  ]),
  module('orchestrator/src/workflow/autonomy.ts', [
    '../../../shared/autonomy.ts',
    '../../../shared/ship-to.ts',
  ]),
  module('orchestrator/src/workflow/autonomy-scopes.ts', [
    '../../../shared/brand.ts',
    'bun:sqlite',
    '../../../shared/config-client.ts',
    '../../../shared/config-directory.ts',
    '../../../shared/machine-config.ts',
    '../database/db.ts',
    '../project/projects.ts',
    './autonomy.ts',
    './session-context-cache.ts',
    './step-catalogue.ts',
    './workflow-cursor-autonomy.ts',
  ]),
]
