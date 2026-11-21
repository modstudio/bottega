// concern: run-claim-inheritance
/** Reads the root facts a retained turn inherits while it is claimed. */

import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { job } from '../jobs/jobs.ts'
import { supersededTurnQuestionState } from '../route/failover.ts'
import { closeRunChainQuestions, QUESTION_CLOSE_ATTEMPT_FAILED_OVER } from './question-close.ts'

export type RunWorkflowBinding = { cursorRecordId: string; stepSlug: string }

export function inheritedRunBinding(
  parent: string | undefined,
  binding: RunWorkflowBinding | undefined,
): { cursorRecordId: string | null; stepSlug: string | null } | null {
  if (!parent || binding) return binding ?? null
  const facts = inheritedRunFacts(parent)
  return { cursorRecordId: facts.cursor_record_id, stepSlug: facts.step_slug }
}

export const bindingValues = (
  binding: { cursorRecordId: string | null; stepSlug: string | null } | null,
) => [binding?.cursorRecordId ?? null, binding?.stepSlug ?? null] as const

export function recordCarriedRulings(runId: string, questionIds: readonly string[]): void {
  const insert = db().query(
    'INSERT INTO run_carried_ruling (record_id,run_record_id,question_record_id) VALUES (?,?,?)',
  )
  for (const id of questionIds) insert.run(newRecordId(), runId, id)
}

export function claimRecordId(reserveId: string | undefined): string {
  if (!reserveId) return newRecordId()
  const reservation = db()
    .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
    .get(reserveId)
  if (!reservation) throw new Error(`reserved run ${reserveId} does not exist`)
  return reserveId
}

export async function prepareClaimQuestionState(input: {
  resolveSuperseded: boolean
  parent: string
  turn: number
  automaticFailover: boolean
  retryOf?: string
}) {
  const state = input.resolveSuperseded
    ? await supersededTurnQuestionState(db(), input.parent, input.turn - 1)
    : null
  if (input.automaticFailover && input.retryOf !== undefined)
    await closeRunChainQuestions(db(), input.retryOf, QUESTION_CLOSE_ATTEMPT_FAILED_OVER)
  return state
}

export function inheritedRunFacts(parent: string): {
  launch_cwd: string | null
  launch_seed: string | null
  launch_key: string | null
  launch_base: string | null
  job: string
  no_failover: number
  task_record_id: string | null
  project_record_id: string | null
  branch: string | null
  cursor_record_id: string | null
  step_slug: string | null
} {
  return db()
    .query(
      `SELECT launch_cwd, launch_seed, launch_key, launch_base, job, no_failover,
              task_record_id, project_record_id, branch, cursor_record_id, step_slug
         FROM run WHERE record_id=?`,
    )
    .get(parent) as ReturnType<typeof inheritedRunFacts>
}

export function inheritedRunWritesRepo(jobName: string): boolean {
  return Boolean(job(jobName).needs.writesRepo)
}

export function inheritedRunLinks(parent: string): {
  taskRecordId: string | null
  projectRecordId: string | null
  projectName: string | null
} {
  const facts = inheritedRunFacts(parent)
  const project = facts.project_record_id
    ? (db()
        .query<{ name: string }, [string]>('SELECT name FROM project WHERE record_id=?')
        .get(facts.project_record_id) ?? null)
    : null
  return {
    taskRecordId: facts.task_record_id,
    projectRecordId: facts.project_record_id,
    projectName: project?.name ?? null,
  }
}
