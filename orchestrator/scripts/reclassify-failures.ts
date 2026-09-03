/**
 * Reclassify stored failures under the rule that now exists.
 *
 * Not a hand-edit of two rows: the same classify() every new run goes through
 * is re-run over the errors already on disk, so what changes is decided by the
 * rule rather than by whoever noticed. Prints every change for review.
 */
import { db } from '../src/db.ts'
import { classify } from '../src/failure.ts'

const rows = db().query(
  `SELECT id, agent, job, status, failure_kind, error FROM run
    WHERE status IN ('failed', 'stale') AND error IS NOT NULL ORDER BY id`,
).all() as { id: number; agent: string; job: string; status: string
             failure_kind: string | null; error: string }[]

/**
 * A stale row has no error the classifier can read - the reaper wrote its
 * message, not the agent - so its kind comes from what being reaped MEANS.
 *
 * It can only be an external kill: every agent's timeout is below
 * STALE_AFTER_MS, so a genuine hang is stopped by its own timer and recorded as
 * `timeout`, and run()'s try/finally writes a terminal row on any normal exit
 * and on SIGTERM. These predate the reaper stamping the kind itself.
 */
const kindOf = (r: { status: string; error: string }) =>
  r.status === 'stale' ? 'interrupted' : classify(r.error)

const apply = process.argv.includes('--apply')
let changed = 0
for (const r of rows) {
  const now = kindOf(r)
  if (now === r.failure_kind) continue
  changed++
  console.log(`run ${r.id}  ${r.agent}/${r.job}  [${r.status}]  ${r.failure_kind ?? 'null'} -> ${now}`)
  console.log(`    ${r.error.replace(/\s+/g, ' ').slice(0, 110)}`)
  if (apply) db().query('UPDATE run SET failure_kind = ? WHERE id = ?').run(now, r.id)
}
console.log(`\n${changed} of ${rows.length} failed or stale runs reclassify` +
            (apply ? ' — applied.' : ' — dry run, pass --apply to write.'))
