// concern: landing-tree run adoption
/** Transfers coordinator-run judgment to the architect who opens its landing tree. */

import type { Database } from 'bun:sqlite'
import { db, sessionId, writeTransaction } from '../database/db.ts'
import { filedIssueLoopRun } from '../issue/issue-queue.ts'
import { machineId } from '../record/machine-identity.ts'
import { auditRunMutation, type RootAuthority } from '../run/run-authority.ts'
import { joinMutationReason } from '../run/run-mutation-owner.ts'
import { enqueueRunRecord } from '../run/run-outbox.ts'
import { landingTreeRunAdoptionDecision } from './landing-tree.ts'

type CoordinatorRoot = {
  record_id: string
  session_id: string | null
  launch_key: string | null
  job: string
  label: string | null
}

function issueKey(row: CoordinatorRoot): string | null {
  return filedIssueLoopRun({ id: row.record_id, job: row.job, label: row.label })?.issueKey ?? null
}

function adoptionAuthority(root: CoordinatorRoot, actor: string): RootAuthority {
  return {
    runId: root.record_id,
    rootId: root.record_id,
    owner: actor,
    actor,
    ownerLastSeenAt: null,
    chainLastActivityAt: 0,
    now: Date.now(),
    windowMs: 0,
  }
}

/** Atomically adopt every root and turn selected by the shipping-time ruling. */
export function adoptCoordinatorRunsForLanding(
  opened: CoordinatorRoot,
  database: Database = db(),
): number {
  const actor = sessionId(database)
  if (!actor || actor === opened.session_id) return 0
  const openedIssueKey = issueKey(opened)
  const candidates = database
    .query<CoordinatorRoot, [string | null]>(
      `SELECT record_id,session_id,launch_key,job,label FROM run
       WHERE parent_run_record_id IS NULL AND session_id IS ? ORDER BY number`,
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
      const claimed = database
        .query('UPDATE run SET session_id=? WHERE record_id=? AND session_id IS ?')
        .run(actor, candidate.record_id, opened.session_id)
      if (claimed.changes !== 1) continue
      database
        .query('UPDATE run SET session_id=? WHERE parent_run_record_id=?')
        .run(actor, candidate.record_id)
      const reason = joinMutationReason(
        `shipping run ${opened.record_id}`,
        `adopted from operator owner ${opened.session_id} by ${actor}`,
      )
      auditRunMutation(adoptionAuthority(candidate, actor), 'adopt', reason, database)
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
