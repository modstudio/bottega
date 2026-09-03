/**
 * One-shot DEV-137 cutover for child turns left `asking` after they completed.
 *
 * Dry-run by default. This script is intentionally not a permanent CLI verb:
 * the write path now resolves these rows as their successors are created, and
 * a standing bulk rewrite would be a hazard to genuinely waiting turns. Remove
 * this file after its reviewed output has been applied to the live database.
 */
import { Database } from 'bun:sqlite'
import { DB_PATH } from '../src/db.ts'

const apply = process.argv.includes('--apply')
const database = apply
  ? new Database(DB_PATH, { readwrite: true, create: false })
  : new Database(DB_PATH, { readonly: true })
database.exec('PRAGMA busy_timeout = 15000')

type AskingRow = { id: number; root: number; status: string }
const rows = database.query(
  `SELECT prior.id, prior.parent_run_id AS root, prior.status
     FROM run prior
    WHERE prior.parent_run_id IS NOT NULL
      AND prior.status='asking'
      AND EXISTS (
        SELECT 1 FROM question q
         WHERE q.run_id=prior.id AND q.answered_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM question q
         WHERE q.run_id=prior.id AND q.answered_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM run later
         WHERE later.parent_run_id=prior.parent_run_id AND later.turn>prior.turn
      )
    ORDER BY prior.id`,
).all() as AskingRow[]

const update = database.query(
  `UPDATE run AS prior SET status='ok'
    WHERE prior.id=? AND prior.parent_run_id=? AND prior.status='asking'
      AND EXISTS (
        SELECT 1 FROM question q
         WHERE q.run_id=prior.id AND q.answered_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM question q
         WHERE q.run_id=prior.id AND q.answered_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM run later
         WHERE later.parent_run_id=prior.parent_run_id AND later.turn>prior.turn
      )`,
)

let changed = 0
for (const row of rows) {
  const reason = 'later turn exists on same root and this turn\'s question is answered'
  console.log(
    `run ${row.id}  root ${row.root}  status=${row.status}  ` +
    `reason="${reason}"  -> ok`,
  )
  if (apply) changed += update.run(row.id, row.root).changes
}

console.log(
  `\n${apply ? changed : rows.length} child row${rows.length === 1 ? '' : 's'} ` +
  (apply ? 'resolved — applied.' : 'would be resolved — dry run, pass --apply to write.'),
)
database.close()
