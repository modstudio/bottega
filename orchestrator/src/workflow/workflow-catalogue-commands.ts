// concern: workflows
/** Knows workflow catalogue command semantics. Must not know CLI grammar or transports. */
import { resolve } from 'node:path'
import { flagValue } from '../cli/args.ts'
import { projectAt } from '../project/projects.ts'
import { forkStepCatalogue } from './step-catalogue.ts'
import type { WorkflowCommandOptions, WorkflowPrint } from './workflow-commands.ts'

const positive = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer`)
  return n
}

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
