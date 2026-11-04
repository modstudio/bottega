// concern: collect-change
/** Reads and validates the monotonic source cursor used by external collectors. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'

export function collectChangeCursor(): number {
  return (
    db().query<{ value: number }, []>('SELECT value FROM collect_change_counter').get()?.value ?? 0
  )
}

export function changedAfter(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('--changed-after must be a non-negative integer')
  return parsed
}

export function applyChangedAfterFilter(
  value: string | undefined,
  since: string | undefined,
  hasRequestedRuns: boolean,
  where: string[],
  args: Array<string | number>,
): number | null {
  const after = changedAfter(value)
  if (after === null) return null
  if (since) throw new Error('--since and --changed-after cannot be combined')
  if (hasRequestedRuns)
    throw new Error(`${PLATFORM_SLUG} run list --id and --changed-after cannot be combined`)
  const snapshot = collectChangeCursor()
  where.push(`(
    EXISTS (
      SELECT 1 FROM run changed_run
       WHERE (changed_run.record_id=r.record_id OR changed_run.parent_run_record_id=r.record_id)
         AND changed_run.change_seq>? AND changed_run.change_seq<=?
    ) OR EXISTS (
      SELECT 1 FROM question changed_question
      JOIN run changed_owner ON changed_owner.record_id=changed_question.run_record_id
      WHERE (changed_owner.record_id=r.record_id OR changed_owner.parent_run_record_id=r.record_id)
        AND changed_question.change_seq>? AND changed_question.change_seq<=?
    )
  )`)
  args.push(after, snapshot, after, snapshot)
  return snapshot
}

export function publishChangeCursor(snapshot: number | null, log: (line: string) => void): void {
  if (snapshot === null) return
  log(JSON.stringify({ schema_version: 2, kind: 'cursor', data: { cursor: snapshot } }))
}
