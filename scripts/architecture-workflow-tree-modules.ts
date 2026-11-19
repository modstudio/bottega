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
  module('orchestrator/src/workflow/workflow-command-project.ts', [
    'node:path',
    '../../../shared/git.ts',
    '../../../shared/record-api-url.ts',
    '../../../shared/refusal.ts',
    '../project/projects.ts',
  ]),
  module('orchestrator/src/workflow/workflow-import-branch.ts', [
    '../../../shared/brand.ts',
    '../../../shared/project-trunk.ts',
    '../project/projects.ts',
    '../review/review-target.ts',
    '../worktree/worktree-caller.ts',
  ]),
  module('orchestrator/src/workflow/workflow-import-output.ts', ['./workflow-tree-store.ts']),
  module('orchestrator/src/workflow/workflow-promotion-admission.ts', []),
  module('orchestrator/src/workflow/workflow-promotion-command.ts', [
    '../../../shared/bounded-process.ts',
    '../cli/args.ts',
    '../git/git-environment.ts',
    '../project/projects.ts',
    './workflow-promotion-admission.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree.ts', [
    'node:util',
    './step-catalogue.ts',
    './workflow-step-sequences.ts',
    './workflows.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree-commands.ts', [
    '../../../shared/brand.ts',
    '../../../shared/git.ts',
    '../../../shared/refusal.ts',
    '../cli/args.ts',
    '../database/db.ts',
    '../git/git-environment.ts',
    './workflow-command-project.ts',
    './workflow-import-branch.ts',
    './workflow-import-output.ts',
    './workflow-promotion-command.ts',
    './workflow-read-space.ts',
    './workflow-tree.ts',
    './workflow-tree-files.ts',
    './workflow-tree-hydration.ts',
    './workflow-tree-store.ts',
    './workflow-tree-sync-command.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree-sync-command.ts', []),
  module('orchestrator/src/workflow/workflow-tree-files.ts', [
    'node:fs',
    'node:path',
    './workflow-tree.ts',
  ]),
  module('orchestrator/src/workflow/workflow-tree-hydration.ts', [
    '../../../shared/brand.ts',
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
    '../database/db.ts',
    '../record/record-write-authority.ts',
    './step-catalogue.ts',
    './workflow-read-space.ts',
    './workflow-step-sequences.ts',
    './workflow-tree.ts',
    './workflow-tree-hydration.ts',
    './workflow-tree-promotion.ts',
    './workflows.ts',
  ]),
]
