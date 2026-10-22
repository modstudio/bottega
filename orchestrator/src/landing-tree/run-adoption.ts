// concern: landing-tree run adoption
/** Transfers coordinator-run judgment to the architect who opens its landing tree. */

import type { Database } from 'bun:sqlite'
import { sessionId, writeTransaction } from '../database/db.ts'
import { filedIssueLoopRun } from '../issue/issue-queue.ts'
import { machineId } from '../record/machine-identity.ts'
import { transferRunMutationOwnership } from '../run/run-authority.ts'
import { joinMutationReason } from '../run/run-mutation-owner.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { agentExecutionStatsSql } from '../run/synthetic-lifecycle-job.ts'
import { type LandingTreeRunRow, landingTreeRunAdoptionDecision } from './landing-tree.ts'

type CoordinatorRoot = Pick<
  LandingTreeRunRow,
  'record_id' | 'session_id' | 'launch_key' | 'job' | 'label'
>

function issueKey(row: CoordinatorRoot): string | null {
  return filedIssueLoopRun({ id: row.record_id, job: row.job, label: row.label })?.issueKey ?? null
}

/** Atomically adopt every root and turn selected by the shipping-time ruling. */
export function adoptCoordinatorRunsForLanding(
  opened: CoordinatorRoot,
  database: Database,
): number {
  const actor = sessionId(database)
  if (!actor || actor === opened.session_id) return 0
  const openedIssueKey = issueKey(opened)
  const candidates = database
    .query<CoordinatorRoot, [string | null]>(
      `SELECT record_id,session_id,launch_key,job,label FROM run
       WHERE parent_run_record_id IS NULL AND session_id IS ?
         AND ${agentExecutionStatsSql('run')}
       ORDER BY number`,
    )
    .all(opened.session_id)
    .filter((candidate) =>
      landingTreeRunAdoptionDecision({
        openedOwner: opened.session_id,
        openedLaunchKey: opened.launch_key,
        openedIssueKey,
        candidateOwner: candidate.session_id,
        candidateLaunchKey: candidate.launch_key,
        candidateIssueKey: issueKey(candidate),
      }),
    )
  if (!candidates.length) return 0
  return writeTransaction(() => {
    let adopted = 0
    for (const candidate of candidates) {
      const reason = joinMutationReason(
        `shipping run ${opened.record_id}`,
        `adopted from operator owner ${opened.session_id} by ${actor}`,
      )
      if (
        !transferRunMutationOwnership(
          candidate.record_id,
          opened.session_id,
          actor,
          reason ?? `shipping run ${opened.record_id}`,
          database,
        )
      )
        continue
      const members = database
        .query<{ record_id: string; finished_at: string }, [string, string]>(
          `SELECT record_id,COALESCE(last_event_at,started_at) finished_at FROM run
           WHERE (record_id=? OR parent_run_record_id=?)
             AND status IN ('ok','failed','stale','stopped','asking')
           ORDER BY turn,number`,
        )
        .all(candidate.record_id, candidate.record_id)
      for (const member of members)
        enqueueRunRecord(database, member.record_id, machineId(), member.finished_at)
      adopted++
    }
    return adopted
  }, database)
}
