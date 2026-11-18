// concern: workflow handoff CLI adapter

import { resolve } from 'node:path'
import { flagValue } from '../cli/args.ts'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { workflowArgs } from './workflow-command-arguments.ts'
import type { CommitCountPort } from './workflow-compose-branch.ts'
import { resolveWorkflowLiveAutonomy } from './workflow-cursor-live-autonomy.ts'
import {
  cliWorkflowCursorContext,
  resolveWorkflowCursorContext,
  selectWorkflowCursorByHandle,
} from './workflow-cursor-selection.ts'
import { handoffWorkflow } from './workflow-handoff.ts'
import type { HubTaskReader } from './workflow-task-reference.ts'

export async function handoffCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
  options: { cwd?: string; hubTaskReader?: HubTaskReader; commitCount?: CommitCountPort } = {},
): Promise<void> {
  const cursor = Number(flagValue(argv, 'cursor'))
  if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error('--cursor is required')
  const project =
    flagValue(argv, 'project') ?? projectAt(resolve(options.cwd ?? process.cwd()))?.name
  if (!project) throw new Error('--project is required')
  const row = await selectWorkflowCursorByHandle({ project }, cursor, undefined, db())
  const args = workflowArgs(argv)
  const context = await resolveWorkflowCursorContext(
    project,
    { ...args, key: row.workflow_key },
    cliWorkflowCursorContext(),
    options.hubTaskReader,
    row,
  )
  const live = await resolveWorkflowLiveAutonomy({
    slug: argv[2]!,
    project,
    mode: flagValue(argv, 'mode'),
    args,
    context,
  })
  const result = await handoffWorkflow({
    row,
    workflow: argv[2]!,
    mode: flagValue(argv, 'mode'),
    args,
    reason: flagValue(argv, 'reason') ?? '',
    context,
    live,
    commitCount: options.commitCount,
  })
  print(
    result,
    [`handed off to ${result.workflow} cursor ${result.cursor}`, result.claimWarning]
      .filter(Boolean)
      .join('\n'),
  )
}
