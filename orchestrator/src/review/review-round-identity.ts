// concern: review-round-identity
/** Owns how a review round is identified and ordered for an attributed task. */

import type { Database } from 'bun:sqlite'
import { attributedTaskKey } from '../epic/epic.ts'
import { reviewRunEvidenceSql } from './review-evidence-sql.ts'
import { reviewLineage } from './review-lineage-store.ts'
import type { ReviewRole } from './review-role.ts'

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
      task && row.patch_id?.trim()
        ? `${normalized(task)}\0${row.patch_id}\0${row.path_set ?? ''}`
        : null,
  }
}

/** Assign first-seen ordinals per task; unclassifiable rows stay null. */
export function reviewRoundOrdinals(
  rows: readonly { task: string | null; identity: string | null }[],
): (number | null)[] {
  const ordinals = new Map<string, number>()
  const counts = new Map<string, number>()
  return rows.map(({ task, identity }) => {
    const normalizedTask = normalized(task)
    if (!normalizedTask || !identity) return null
    const existing = ordinals.get(identity)
    if (existing !== undefined) return existing
    const round = (counts.get(normalizedTask) ?? 0) + 1
    counts.set(normalizedTask, round)
    ordinals.set(identity, round)
    return round
  })
}

/** Assign the ordinal from the same eligible lineage and role evidence used by the round budget. */
export function reviewRoundForRecording(
  database: Database,
  input: ReviewRoundIdentityInput & { project: string | null; role: ReviewRole },
): number | null {
  if (input.role !== 'round' || !input.project || !input.branch) return null
  const current = reviewRoundIdentity(input)
  if (!current.identity) return null
  const lineage = reviewLineage(database, input.project, input.branch)
  const rows = database
    .query<ReviewRoundIdentityInput & { review_record_id: string }, [string, ...string[]]>(
      `SELECT r.record_id AS review_record_id,r.patch_id,r.path_set,run.launch_key,run.branch
         FROM review r
         JOIN review_lens rl ON rl.review_record_id=r.record_id
         JOIN run ON run.record_id=rl.run_record_id
        WHERE run.project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND run.branch IN (${lineage.map(() => '?').join(',')})
          AND r.role='round'
          AND ${reviewRunEvidenceSql('run', 'rl')}
        ORDER BY r.recorded_at,r.number,run.number`,
    )
    .all(input.project, ...lineage)
  const seen = new Set<string>()
  const prior: ReturnType<typeof reviewRoundIdentity>[] = []
  for (const row of rows) {
    if (seen.has(row.review_record_id)) continue
    seen.add(row.review_record_id)
    prior.push(reviewRoundIdentity(row))
  }
  return reviewRoundOrdinals([...prior, current]).at(-1) ?? null
}
