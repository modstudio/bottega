// concern: workflow step actions
/** Authorizes dispatch and landing against the current step of one workflow cursor. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { cursorComposition } from './workflow-cursor-serve.ts'
import {
  cliWorkflowCursorContext,
  selectWorkflowCursorByHandle,
} from './workflow-cursor-selection.ts'

export type StepActionTarget = {
  cursor: number
  cursorRecordId: string
  stepSlug: string
  taskKey: string
  jobs: string[]
  actions: string[]
}

export async function stepActionTarget(
  cursor: number,
  database: Database = db(),
): Promise<StepActionTarget> {
  const row = await selectWorkflowCursorByHandle(
    {},
    cursor,
    cliWorkflowCursorContext().session,
    database,
  )
  const step = cursorComposition(row, database).steps[row.ordinal]
  if (!step) {
    throw new Error(`cursor ${cursor} composition has no step at ordinal ${row.ordinal}`)
  }
  return {
    cursor: row.id,
    cursorRecordId: row.record_id,
    stepSlug: step.slug,
    taskKey: row.workflow_key,
    jobs: step.jobs,
    actions: step.actions,
  }
}

type StepActionRead = (cursor: number) => Promise<StepActionTarget>

export async function dispatchForStep(
  input: { cursor: number; job: string; argv: string[] },
  ports: {
    read?: StepActionRead
    dispatch(argv: string[], binding: { cursorRecordId: string; stepSlug: string }): Promise<void>
  },
): Promise<void> {
  const target = await (ports.read ?? stepActionTarget)(input.cursor)
  if (!target.taskKey) {
    throw new Error(`cursor ${input.cursor} has no task key; workflow dispatch needs a keyed cursor`)
  }
  if (!target.jobs.includes(input.job)) {
    const declared = target.jobs.length ? target.jobs.join(', ') : 'none'
    throw new Error(
      `step ${target.stepSlug} of cursor ${input.cursor} declares jobs: ${declared}; ${input.job} is not one of them`,
    )
  }
  await ports.dispatch([...input.argv, '--key', target.taskKey], {
    cursorRecordId: target.cursorRecordId,
    stepSlug: target.stepSlug,
  })
}

export type StepLandCreateOptions = {
  cwd?: string
  overrideTriage?: string
  ceilingRuling?: string
  fromOperator?: boolean
}

export type StepLandMergeOptions = {
  cwd?: string
  releaseRequired?: boolean
  depth?: string
}

export type StepLandInput =
  | {
      action: 'create'
      cursor: number
      args: [githubArgs: string[], options: StepLandCreateOptions]
    }
  | {
      action: 'merge'
      cursor: number
      args: [target: string, options: StepLandMergeOptions]
    }

export async function landForStep(
  input: StepLandInput,
  ports: {
    read?: StepActionRead
    create(githubArgs: string[], options: StepLandCreateOptions): Promise<void>
    merge(target: string, options: StepLandMergeOptions): Promise<void>
  },
): Promise<void> {
  const target = await (ports.read ?? stepActionTarget)(input.cursor)
  const required = input.action === 'create' ? 'pr-create' : 'pr-merge'
  if (!target.actions.includes(required)) {
    const declared = target.actions.length ? target.actions.join(', ') : 'none'
    throw new Error(
      `step ${target.stepSlug} of cursor ${input.cursor} declares actions: ${declared}; ${required} is not one of them`,
    )
  }
  if (input.action === 'create') await ports.create(...input.args)
  else await ports.merge(...input.args)
}
