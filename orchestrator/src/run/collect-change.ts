// concern: collect-change
/** Reads and validates the monotonic source cursor used by external collectors. */

import type { OrchChangeCursorEnvelope } from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'

export function collectChangeCursor(): number {
  return (
    db().query<{ value: number }, []>('SELECT value FROM collect_change_counter').get()?.value ?? 0
  )
}

export function applyChangedAfterFilter(
  after: number | null,
  where: string[],
  args: Array<string | number>,
): number | null {
  if (after === null) return null
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
  const envelope: OrchChangeCursorEnvelope = {
    schema_version: 2,
    kind: 'cursor',
    data: { cursor: snapshot },
  }
  log(JSON.stringify(envelope))
}
