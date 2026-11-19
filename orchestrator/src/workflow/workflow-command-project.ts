// concern: workflow command project resolution
/** Resolves workflow-command checkouts to their registered project and verb-specific remedy. */

import { resolve } from 'node:path'
import { gitToplevel } from '../../../shared/git.ts'
import { recordApiConfigured } from '../../../shared/record-api-url.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { type Project, projectAt } from '../project/projects.ts'

export type WorkflowProjectCommand = 'hydrate' | 'import' | 'promote' | 'promote-tree'

function workflowProjectRemedy(command: WorkflowProjectCommand): string {
  return command === 'promote'
    ? "run from a registered project's checkout"
    : "pass --cwd naming a registered project's checkout or worktree"
}

export function workflowProjectRefusal(input: {
  command: WorkflowProjectCommand
  root: string
  project: string | null
  recordConfigured: boolean
}): string | null {
  if (input.project || !input.recordConfigured) return null
  return renderRefusal(
    refusal(
      `refusing workflow ${input.command} in ${input.root}: no registered project owns this directory`,
      { kind: 'edit', text: workflowProjectRemedy(input.command) },
    ),
  )
}

export function workflowCommandProject(
  command: WorkflowProjectCommand,
  options: { cwd?: string },
): { root: string; project: Project | null } {
  const resolved = resolve(options.cwd ?? process.cwd())
  const root = gitToplevel(resolved)
  if (!root) {
    throw new Error(
      renderRefusal(
        refusal(`refusing workflow ${command} in ${resolved}: not a git repository`, {
          kind: 'edit',
          text: workflowProjectRemedy(command),
        }),
      ),
    )
  }
  const project = projectAt(root)
  const projectRefusal = workflowProjectRefusal({
    command,
    root,
    project: project?.name ?? null,
    recordConfigured: recordApiConfigured(),
  })
  if (projectRefusal) throw new Error(projectRefusal)
  return { root, project }
}
