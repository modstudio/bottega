/**
 * One-shot DEV-146 cutover for a root left `asking` after its chain ended.
 *
 * Dry-run by default. This script is intentionally not a permanent CLI verb:
 * the write path now inherits the last turn's terminal status onto the root,
 * and a standing bulk rewrite would be a hazard to genuinely waiting turns.
 * Remove this file after its reviewed output has been applied to the live
 * database.
 *
 * Opens the database read-only unless `--apply`. Refuses to report success
 * against a missing or empty file: DB_PATH is relative to the checkout, so a
 * worktree with no orch.db used to create an empty one on import and print
 * "0 rows" as though that were a finding.
 */
import { existsSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { DB_PATH, resolveRootFromLastTurn } from '../src/db.ts'

const apply = process.argv.includes('--apply')

if (!existsSync(DB_PATH)) {
  throw new Error(
    `no database at ${DB_PATH}; refusing to report an empty result as a finding`,
  )
}

const database = apply
  ? new Database(DB_PATH, { readwrite: true, create: false })
  : new Database(DB_PATH, { readonly: true, create: false })
database.exec('PRAGMA busy_timeout = 15000')

const n = (database.query('SELECT COUNT(*) n FROM run').get() as { n: number }).n
if (n === 0) {
  database.close()
  throw new Error(
    `database at ${DB_PATH} has no runs; this is not the live orchestrator database`,
  )
}

type Stranded = {
  id: number; agent: string; job: string; status: string
  last_id: number; last_turn: number; last_status: string
}
const rows = database.query(
  `SELECT root.id, root.agent, root.job, root.status,
          last.id AS last_id, last.turn AS last_turn, last.status AS last_status
     FROM run root
     JOIN run last ON last.id = (
       SELECT id FROM run
        WHERE (id = root.id OR parent_run_id = root.id)
        ORDER BY turn DESC, id DESC LIMIT 1
     )
    WHERE root.parent_run_id IS NULL
      AND root.status = 'asking'
      AND last.status IN ('ok', 'failed', 'stale')
      AND NOT EXISTS (
        SELECT 1 FROM question q JOIN run owner ON owner.id = q.run_id
         WHERE (owner.id = root.id OR owner.parent_run_id = root.id)
           AND q.answered_at IS NULL
      )
    ORDER BY root.id`,
).all() as Stranded[]

let changed = 0
for (const row of rows) {
  console.log(
    `run ${row.id}  ${row.agent}/${row.job}  status=${row.status}  ` +
    `last turn ${row.last_id} (turn ${row.last_turn}) is ${row.last_status}  ` +
    `-> ${row.last_status}`,
  )
  if (apply) changed += resolveRootFromLastTurn(database, row.id)
}

console.log(
  `\n${apply ? changed : rows.length} root${rows.length === 1 ? '' : 's'} ` +
  (apply ? 'resolved — applied.' : 'would be resolved — dry run, pass --apply to write.'),
)
database.close()
