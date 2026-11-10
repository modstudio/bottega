// concern: workflows
/** Knows workflow catalogue command semantics. Must not know CLI grammar or transports. */
import { resolve } from 'node:path'
import { flagValue } from '../cli/args.ts'
import { projectAt } from '../project/projects.ts'
import { forkStepCatalogue } from './step-catalogue.ts'
import { positive } from './workflow-command-arguments.ts'
import type { WorkflowCommandOptions, WorkflowPrint } from './workflow-commands.ts'

export async function forkCatalogueCommand(
  argv: string[],
  print: WorkflowPrint,
  options: WorkflowCommandOptions = {},
): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const project = projectAt(cwd)?.name ?? null
  if (!project)
    throw new Error(
      `cannot fork the workflow step catalogue: no registered project contains ${cwd}\n` +
        "cleared by: run from a registered project's worktree, or pass --cwd for one",
    )
  print(
    await forkStepCatalogue(
      positive(flagValue(argv, 'from'), '--from'),
      flagValue(argv, 'reason'),
      project,
      flagValue(argv, 'author'),
    ),
  )
}
