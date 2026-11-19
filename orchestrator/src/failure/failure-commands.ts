// concern: failure-commands
/** Knows failure evidence reclassification and its audit. Must not know runs, routing, transports, the CLI, or worktrees. */
import { db, writableDb, writeTransaction } from '../database/db.ts'
import { auditRunMutation, runMutationActor } from '../run/run-authority.ts'
import { classify, type FailureKind, gooseVendorFailureKind } from './failure.ts'

type FailureFlags = { has(name: string): boolean }
type FailurePresentation = { log(...values: unknown[]): void }
type FailureRow = {
  record_id: string
  agent: string
  job: string
  status: string
  failure_kind: string | null
  error: string
  harness: string | null
  output_path: string | null
  executor: string
  parent_run_record_id: string | null
  has_turns: number
  failed_turn_numbers: string | null
}
type PersistedOutputReader = (
  row: Pick<FailureRow, 'record_id' | 'output_path' | 'executor'>,
) => string | null
type ChangedTurnRootsRollup = (rootIds: readonly string[], changedAt: string) => void

/** Select the narrowly audited replacement for one stored failure kind and error. */
export function reclassifiedFailureKind(
  failureKind: string | null,
  storedError: string,
  harness: string | null = null,
  output: string | null = null,
): FailureKind | null {
  const kind = classify(storedError)
  if (
    (failureKind === 'other' || failureKind === null) &&
    (kind === 'quota' || kind === 'billing' || kind === 'auth')
  )
    return kind
  if (failureKind === 'contract' && harness === 'goose')
    return gooseVendorFailureKind(output ?? storedError)
  return null
}

function matchedFailures(all: FailureRow[], readOutput: PersistedOutputReader) {
  return all.flatMap((row) => {
    const output = readOutput(row)
    const kind = reclassifiedFailureKind(row.failure_kind, row.error, row.harness, output)
    const source =
      row.failure_kind === 'contract' && output !== null ? 'output' : 'stored error only'
    return kind ? [{ row, kind, source }] : []
  })
}

function failureRows(): FailureRow[] {
  return db()
    .query(
      `SELECT r.record_id, r.agent, r.job, r.status, r.failure_kind, r.error,
              r.output_path, r.executor, r.parent_run_record_id, a.harness,
              EXISTS(SELECT 1 FROM run child WHERE child.parent_run_record_id=r.record_id) AS has_turns,
              (SELECT group_concat(child.number, ', ')
                 FROM run child
                WHERE child.parent_run_record_id=r.record_id
                  AND child.status IN ('failed', 'stale')) AS failed_turn_numbers
       FROM run r LEFT JOIN agent a ON a.name = r.agent
      WHERE status IN ('failed', 'stale')
      ORDER BY r.number`,
    )
    .all() as FailureRow[]
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
  readOutput: PersistedOutputReader,
  rollUpChangedTurnRoots: ChangedTurnRootsRollup,
): void {
  const { has } = flags
  const { log } = presentation
  type CountRow = { agent: string; failure_kind: string | null; count: number }

  const all = failureRows()
  const matched = matchedFailures(all, readOutput)
  const applicable = matched.filter(
    ({ row }) => row.parent_run_record_id !== null || !row.has_turns,
  )

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
  const replacement = new Map(applicable.map(({ row, kind }) => [row.record_id, kind]))
  const projected = counts(
    all.map((row) => ({
      agent: row.agent,
      failure_kind: replacement.get(row.record_id) ?? row.failure_kind,
    })),
  )

  printCounts('BEFORE', before)
  const outputMatches = matched.filter(({ source }) => source === 'output').length
  const errorMatches = matched.length - outputMatches
  log(
    `\nSOURCES  rows decided from output: ${outputMatches}; rows decided from stored error only: ${errorMatches}`,
  )
  log(`\nPLAN (${matched.length} matched row${matched.length === 1 ? '' : 's'})`)
  for (const { row, kind } of matched) {
    if (row.parent_run_record_id === null && row.has_turns) {
      log(
        `run ${row.record_id}  ${row.agent}/${row.job}  [${row.status}]  skipped: kind is rolled up from its turns; its own failure cannot be reclassified because its error column holds the last turn's error; reclassify turn ${row.failed_turn_numbers ?? '(none)'} instead`,
      )
      continue
    }
    log(
      `run ${row.record_id}  ${row.agent}/${row.job}  [${row.status}]  ${row.failure_kind ?? 'null'} -> ${kind}`,
    )
    log(row.error)
  }
  log('')
  printCounts('AFTER', projected)

  if (has('dry-run')) {
    log(
      `\n${applicable.length} row${applicable.length === 1 ? '' : 's'} would be reclassified — dry run, no writes.`,
    )
    return
  }

  writableDb()

  const update = db().query(
    `UPDATE run SET failure_kind = ?,
                    own_failure_kind = ?
      WHERE record_id = ? AND status IN ('failed', 'stale')
        AND failure_kind IS ? AND error = ?`,
  )
  const apply = writeTransaction(() => {
    let changed = 0
    const changedRoots = new Set<string>()
    for (const { row, kind } of applicable) {
      const result = update.run(kind, kind, row.record_id, row.failure_kind, row.error)
      changed += result.changes
      if (result.changes) {
        if (row.parent_run_record_id) changedRoots.add(row.parent_run_record_id)
        auditRunMutation(
          runMutationActor(row.record_id),
          'reclassify',
          `${row.failure_kind ?? 'null'} -> ${kind}`,
        )
      }
    }
    rollUpChangedTurnRoots([...changedRoots], new Date().toISOString())
    return changed
  })
  const changed = apply
  log(`\n${changed} row${changed === 1 ? '' : 's'} reclassified.`)
}
