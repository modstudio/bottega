// concern: workflow step actions
/** Authorizes dispatch and landing against the current step of one workflow cursor. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { type Job, job } from '../jobs/jobs.ts'
import {
  cliWorkflowCursorContext,
  selectWorkflowCursorByHandle,
} from './workflow-cursor-selection.ts'
import { cursorComposition } from './workflow-cursor-serve.ts'

export type StepActionTarget = {
  cursor: number
  cursorRecordId: string
  workflowSlug: string
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
    workflowSlug: row.workflow_slug,
    stepSlug: step.slug,
    taskKey: row.workflow_key,
    jobs: step.jobs,
    actions: step.actions,
  }
}

export type StepActionRead = (cursor: number) => Promise<StepActionTarget>

export type StepDispatchDecision =
  | { action: 'dispatch-with-key'; key: string }
  | { action: 'dispatch-without-key' }
  | { action: 'refuse'; reason: string }

/** Decide whether the current step and cursor may dispatch this declared job. */
export function decideStepDispatch(input: {
  cursor: number
  taskKey: string
  workflowSlug: string
  stepSlug: string
  stepJobs: string[]
  job: Pick<Job, 'name' | 'needs'>
}): StepDispatchDecision {
  if (!input.taskKey && input.job.needs.writesRepo === true)
    return {
      action: 'refuse',
      reason:
        `workflow ${input.workflowSlug} cursor ${input.cursor} has no task key, and ${input.job.name} writes the repository; ` +
        'compose plan-task (or take up a task), then dispatch from that keyed cursor',
    }
  if (!input.stepJobs.includes(input.job.name)) {
    const declared = input.stepJobs.length ? input.stepJobs.join(', ') : 'none'
    return {
      action: 'refuse',
      reason: `step ${input.stepSlug} of cursor ${input.cursor} declares jobs: ${declared}; ${input.job.name} is not one of them`,
    }
  }
  if (input.taskKey) return { action: 'dispatch-with-key', key: input.taskKey }
  return { action: 'dispatch-without-key' }
}

export async function dispatchForStep(
  input: { cursor: number; job: string; argv: string[] },
  ports: {
    read?: StepActionRead
    dispatch(argv: string[], binding: { cursorRecordId: string; stepSlug: string }): Promise<void>
  },
): Promise<void> {
  const target = await (ports.read ?? stepActionTarget)(input.cursor)
  const decision = decideStepDispatch({
    cursor: input.cursor,
    taskKey: target.taskKey,
    workflowSlug: target.workflowSlug,
    stepSlug: target.stepSlug,
    stepJobs: target.jobs,
    job: job(input.job),
  })
  if (decision.action === 'refuse') throw new Error(decision.reason)
  const argv =
    decision.action === 'dispatch-with-key' ? [...input.argv, '--key', decision.key] : input.argv
  await ports.dispatch(argv, {
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

async function authorizeLandAction(
  cursor: number,
  required: 'pr-create' | 'pr-merge',
  read: StepActionRead = stepActionTarget,
): Promise<void> {
  const target = await read(cursor)
  if (!target.actions.includes(required)) {
    const declared = target.actions.length ? target.actions.join(', ') : 'none'
    throw new Error(
      `step ${target.stepSlug} of cursor ${cursor} declares actions: ${declared}; ${required} is not one of them`,
    )
  }
}

export async function createForStep(
  input: {
    cursor: number
    args: [githubArgs: string[], options: StepLandCreateOptions]
  },
  ports: {
    read?: StepActionRead
    create(githubArgs: string[], options: StepLandCreateOptions): Promise<void>
  },
): Promise<void> {
  await authorizeLandAction(input.cursor, 'pr-create', ports.read)
  await ports.create(...input.args)
}

export async function mergeForStep(
  input: {
    cursor: number
    args: [target: string, options: StepLandMergeOptions]
  },
  ports: {
    read?: StepActionRead
    merge(target: string, options: StepLandMergeOptions): Promise<void>
  },
): Promise<void> {
  await authorizeLandAction(input.cursor, 'pr-merge', ports.read)
  await ports.merge(...input.args)
}
