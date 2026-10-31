// concern: architecture-manifest
/** Workflow tree module allowlists, kept outside the root manifest to preserve its file ceiling. */
import { dirname, normalize } from 'node:path'

type WorkflowTreeModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): WorkflowTreeModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const workflowTreeModules: WorkflowTreeModule[] = [
  module('orchestrator/src/workflow/workflow-import-output.ts', ['./workflow-tree-store.ts']),
  module('orchestrator/src/workflow/workflow-tree.ts', [
    './step-catalogue.ts',
    './workflow-step-sequences.ts',
    './workflows.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree-files.ts', [
    'node:fs',
    'node:path',
    './workflow-tree.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree-promotion.ts', [
    'node:util',
    './step-catalogue.ts',
    './workflow-tree.ts',
    './workflows.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree-store.ts', [
    '../../../shared/brand.ts',
    'bun:sqlite',
    'node:util',
    '../database/db.ts',
    '../record/record-write-authority.ts',
    './step-catalogue.ts',
    './workflow-read-space.ts',
    './workflow-step-sequences.ts',
    './workflow-tree.ts',
    './workflow-tree-promotion.ts',
    './workflows.ts',
  ]),
]
