// concern: workflow handoff CLI adapter

import { resolve } from 'node:path'
import { flagValue, flagValues } from '../cli/args.ts'
import { db } from '../database/db.ts'
import { resolveGateIdentifier } from '../gate/gate-identifier.ts'
import { projectAt } from '../project/projects.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { workflowArgs } from './workflow-command-arguments.ts'
import type { CommitCountPort } from './workflow-compose-branch.ts'
import { resolveWorkflowLiveAutonomy } from './workflow-cursor-live-autonomy.ts'
import {
  cliWorkflowCursorContext,
  resolveWorkflowCursorContext,
  selectWorkflowCursorByHandle,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { handoffTargetArguments, handoffWorkflow } from './workflow-handoff.ts'
import { resolveOfferedArtifacts } from './workflow-offered-artifacts.ts'
import { productionWorkflowFloorPorts } from './workflow-production-floor-ports.ts'
import type { HubTaskReader } from './workflow-task-reference.ts'

export async function handoffCommand(
  argv: string[],
  print: (value: unknown, line?: string) => void,
  options: {
    cwd?: string
    hubTaskReader?: HubTaskReader
    commitCount?: CommitCountPort
    database?: ReturnType<typeof db>
    context?: WorkflowCursorContext
  } = {},
): Promise<void> {
  const database = options.database ?? db()
  const cursor = Number(flagValue(argv, 'cursor'))
  if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error('--cursor is required')
  const project =
    flagValue(argv, 'project') ?? projectAt(resolve(options.cwd ?? process.cwd()))?.name
  if (!project) throw new Error('--project is required')
  const row = await selectWorkflowCursorByHandle({ project }, cursor, undefined, database)
  const args = workflowArgs(argv)
  const context = await resolveWorkflowCursorContext(
    project,
    handoffTargetArguments(row, args),
    options.context ?? cliWorkflowCursorContext(),
    options.hubTaskReader,
    row,
  )
  const live = await resolveWorkflowLiveAutonomy(
    {
      slug: argv[2]!,
      project,
      mode: flagValue(argv, 'mode'),
      args,
      context,
    },
    database,
  )
  const result = await handoffWorkflow({
    row,
    workflow: argv[2]!,
    mode: flagValue(argv, 'mode'),
    args,
    reason: flagValue(argv, 'reason') ?? '',
    context,
    live,
    commitCount: options.commitCount,
    evidence: {
      gate:
        flagValue(argv, 'gate') === undefined
          ? undefined
          : resolveGateIdentifier(database, flagValue(argv, 'gate')!),
      run:
        flagValue(argv, 'run') === undefined
          ? undefined
          : resolveRunIdentifier(database, flagValue(argv, 'run')!),
      artifacts: resolveOfferedArtifacts(database, flagValues(argv, 'artifact')),
      task: flagValue(argv, 'task'),
    },
    floorPorts: productionWorkflowFloorPorts(),
    database,
  })
  print(
    result,
    [`handed off to ${result.workflow} cursor ${result.cursor}`, result.claimWarning]
      .filter(Boolean)
      .join('\n'),
  )
}
