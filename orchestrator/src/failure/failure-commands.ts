// concern: failure-commands
/** Knows failure evidence reclassification and its audit. Must not know runs, routing, transports, the CLI, or worktrees. */
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { auditRunMutation, runMutationActor } from '../run/run-authority.ts'
import { classify } from './failure.ts'

type FailureFlags = { has(name: string): boolean }
type FailurePresentation = { log(...values: unknown[]): void }

/**
 * Re-run only the quota/auth signatures over old, unclassified
 * failures. This is deliberately not a general reclassification: a stored
 * failure is evidence, and changing its meaning on anything less than that
 * row's own vendor error would rewrite the agent's record.
 */
export function reclassifyFailuresCommand(
  flags: FailureFlags,
  presentation: FailurePresentation,
): void {
  const { has } = flags
  const { log } = presentation
  type FailureRow = {
    id: number
    agent: string
    job: string
    status: string
    failure_kind: string | null
    error: string
  }
  type CountRow = { agent: string; failure_kind: string | null; count: number }

  const all = db()
    .query(
      `SELECT id, agent, job, status, failure_kind, error
       FROM run
      WHERE status IN ('failed', 'stale')
      ORDER BY id`,
    )
    .all() as FailureRow[]
  const matched = all.flatMap((row) => {
    if ((row.failure_kind !== 'other' && row.failure_kind !== null) || !row.error) return []
    const kind = classify(row.error)
    return kind === 'quota' || kind === 'auth' ? [{ row, kind }] : []
  })

  const counts = (rows: { agent: string; failure_kind: string | null }[]): CountRow[] => {
    const grouped = new Map<string, CountRow>()
    for (const row of rows) {
      const key = JSON.stringify([row.agent, row.failure_kind])
      const existing = grouped.get(key)
      if (existing) existing.count++
      else grouped.set(key, { agent: row.agent, failure_kind: row.failure_kind, count: 1 })
    }
    return [...grouped.values()].sort(
      (a, b) =>
        a.agent.localeCompare(b.agent) ||
        (a.failure_kind ?? '').localeCompare(b.failure_kind ?? ''),
    )
  }
  const printCounts = (label: string, rows: CountRow[]) => {
    log(`${label} (all failed/stale rows)`)
    if (!rows.length) log('  (none)')
    for (const row of rows) {
      log(`  ${row.agent}  ${row.failure_kind ?? 'null'}  ${row.count}`)
    }
  }

  const before = counts(all)
  const replacement = new Map(matched.map(({ row, kind }) => [row.id, kind]))
  const projected = counts(
    all.map((row) => ({
      agent: row.agent,
      failure_kind: replacement.get(row.id) ?? row.failure_kind,
    })),
  )

  printCounts('BEFORE', before)
  log(`\nPLAN (${matched.length} matched row${matched.length === 1 ? '' : 's'})`)
  for (const { row, kind } of matched) {
    log(
      `run ${row.id}  ${row.agent}/${row.job}  [${row.status}]  ${row.failure_kind ?? 'null'} -> ${kind}`,
    )
    log(row.error)
  }
  log('')
  printCounts('AFTER', projected)

  if (has('dry-run')) {
    log(
      `\n${matched.length} row${matched.length === 1 ? '' : 's'} would be reclassified — dry run, no writes.`,
    )
    return
  }

  writableDb()

  const update = db().query(
    `UPDATE run SET failure_kind = ?
      WHERE id = ? AND status IN ('failed', 'stale')
        AND (failure_kind = 'other' OR failure_kind IS NULL) AND error = ?`,
  )
  const apply = writeTransaction(() => {
    let changed = 0
    for (const { row, kind } of matched) {
      const result = update.run(kind, row.id, row.error)
      changed += result.changes
      if (result.changes) {
        auditRunMutation(
          runMutationActor(row.id),
          'reclassify',
          `${row.failure_kind ?? 'null'} -> ${kind}`,
        )
      }
    }
    return changed
  })
  const changed = apply
  log(`\n${changed} row${changed === 1 ? '' : 's'} reclassified.`)
}
