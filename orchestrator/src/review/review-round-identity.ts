// concern: review-round-identity
/** Owns how a review round is identified and ordered on a branch. */

import type { Database } from 'bun:sqlite'
import { attributedTaskKey } from '../epic/epic.ts'
import { reviewRunEvidenceSql } from './review-evidence-sql.ts'

export type ReviewRoundIdentityInput = {
  launch_key: string | null
  branch: string | null
  patch_id: string | null
  path_set: string | null
}

const normalized = (value: string | null | undefined) => value?.trim().toLowerCase() ?? null

/**
 * A round is one canonical patch for one attributed task. Classification runs
 * before view filters, so every grouping and filtered view shares its ordinal.
 */
export function reviewRoundIdentity(row: ReviewRoundIdentityInput): {
  task: string | null
  identity: string | null
} {
  const task = attributedTaskKey(row.launch_key, row.branch)
  return {
    task,
    identity:
      task && row.patch_id ? `${normalized(task)}\0${row.patch_id}\0${row.path_set ?? ''}` : null,
  }
}

/** Assign first-seen ordinals to classifiable identities; unclassifiable stay null. */
export function reviewRoundOrdinals(identities: readonly (string | null)[]): (number | null)[] {
  const seen = new Map<string, number>()
  return identities.map((identity) => {
    if (!identity) return null
    const existing = seen.get(identity)
    if (existing !== undefined) return existing
    const round = seen.size + 1
    seen.set(identity, round)
    return round
  })
}

type PriorRoundRow = {
  review_record_id: string
  recorded_at: string
  number: number
  launch_key: string | null
  branch: string | null
  patch_id: string | null
  path_set: string | null
}

/** Eligible prior identities on one branch, in the budget's recorded order. */
function priorRoundIdentities(
  database: Database,
  projectRecordId: string | null,
  branch: string | null,
): (string | null)[] {
  if (!projectRecordId || !branch) return []
  const rows = database
    .query<PriorRoundRow, [string, string]>(
      `SELECT r.record_id AS review_record_id, r.recorded_at, r.number, r.patch_id, r.path_set,
              run.launch_key, run.branch
         FROM review r
         JOIN review_lens rl ON rl.review_record_id=r.record_id
         JOIN run ON run.record_id=rl.run_record_id
        WHERE run.project_record_id=?
          AND run.branch=?
          AND ${reviewRunEvidenceSql('run', 'rl')}
        ORDER BY r.recorded_at,r.number,rl.record_id`,
    )
    .all(projectRecordId, branch)
  const identities: (string | null)[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.review_record_id)) continue
    seen.add(row.review_record_id)
    identities.push(reviewRoundIdentity(row).identity)
  }
  return identities
}

/** Ordinal of a review being recorded, using the same rule as the round budget. */
export function reviewRoundForRecording(
  database: Database,
  input: ReviewRoundIdentityInput & { project_record_id: string | null },
): number | null {
  const prior = priorRoundIdentities(database, input.project_record_id, input.branch)
  return reviewRoundOrdinals([...prior, reviewRoundIdentity(input).identity]).at(-1) ?? null
}
