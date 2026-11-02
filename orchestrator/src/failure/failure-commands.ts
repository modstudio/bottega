// concern: failure-commands
/** Knows failure evidence reclassification and its audit. Must not know runs, routing, transports, the CLI, or worktrees. */
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { auditRunMutation, runMutationActor } from '../run/run-authority.ts'
import { classify, type FailureKind, isGooseProviderErrorNonAnswer } from './failure.ts'

type FailureFlags = { has(name: string): boolean }
type FailurePresentation = { log(...values: unknown[]): void }

/** Select the narrowly audited replacement for one stored failure kind and error. */
export function reclassifiedFailureKind(
  failureKind: string | null,
  error: string,
): FailureKind | null {
  if (!error) return null
  const kind = classify(error)
  if (
    (failureKind === 'other' || failureKind === null) &&
    (kind === 'quota' || kind === 'billing' || kind === 'auth')
  )
    return kind
  if (
    failureKind === 'contract' &&
    isGooseProviderErrorNonAnswer(error) &&
    kind === 'provider_error'
  )
    return kind
  return null
}

/**
 * Re-run quota/billing/auth signatures over old, unclassified failures, and
 * reclassify contract failures whose own Goose final message reports an
 * upstream provider error. This is deliberately not a general
 * reclassification: a stored failure is evidence, and changing its meaning on
 * anything less than that row's own vendor error would rewrite the agent's
 * record.
 */
export function reclassifyFailuresCommand(
  flags: FailureFlags,
  presentation: FailurePresentation,
): void {
  const { has } = flags
  const { log } = presentation
  type FailureRow = {
    record_id: string
    agent: string
    job: string
    status: string
    failure_kind: string | null
    error: string
  }
  type CountRow = { agent: string; failure_kind: string | null; count: number }

  const all = db()
    .query(
      `SELECT record_id, agent, job, status, failure_kind, error
       FROM run
      WHERE status IN ('failed', 'stale')
      ORDER BY number`,
    )
    .all() as FailureRow[]
  const matched = all.flatMap((row) => {
    const kind = reclassifiedFailureKind(row.failure_kind, row.error)
    return kind ? [{ row, kind }] : []
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
  const replacement = new Map(matched.map(({ row, kind }) => [row.record_id, kind]))
  const projected = counts(
    all.map((row) => ({
      agent: row.agent,
      failure_kind: replacement.get(row.record_id) ?? row.failure_kind,
    })),
  )

  printCounts('BEFORE', before)
  log(`\nPLAN (${matched.length} matched row${matched.length === 1 ? '' : 's'})`)
  for (const { row, kind } of matched) {
    log(
      `run ${row.record_id}  ${row.agent}/${row.job}  [${row.status}]  ${row.failure_kind ?? 'null'} -> ${kind}`,
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
      WHERE record_id = ? AND status IN ('failed', 'stale')
        AND failure_kind IS ? AND error = ?`,
  )
  const apply = writeTransaction(() => {
    let changed = 0
    for (const { row, kind } of matched) {
      const result = update.run(kind, row.record_id, row.failure_kind, row.error)
      changed += result.changes
      if (result.changes) {
        auditRunMutation(
          runMutationActor(row.record_id),
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
