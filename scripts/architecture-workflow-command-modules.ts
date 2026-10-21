// concern: architecture-manifest
/** Workflow command module allowlists, kept outside the root manifest to preserve its file ceiling. */
import { dirname, normalize } from 'node:path'

type WorkflowCommandModule = { file: string; allowed: string[] }

const module = (file: string, allowed: string[]): WorkflowCommandModule => ({
  file,
  allowed: allowed.map((target) =>
    target.startsWith('.') ? normalize(`${dirname(file)}/${target}`) : target,
  ),
})

export const workflowCommandModules: WorkflowCommandModule[] = [
  module('orchestrator/src/workflow/workflow-catalogue-commands.ts', [
    'node:path',
    '../cli/args.ts',
    '../project/projects.ts',
    './step-catalogue.ts',
    './workflow-commands.ts',
  ]),
]
