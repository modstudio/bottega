import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { failureReason, outcomeOf } from './outcome.ts'

export const COLLECTION_COMMANDS = new Set(['result', 'wait'])

function dur(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const t = ms / 1000
  if (t < 60) return `${t.toFixed(1)}s`
  const m = Math.floor(t / 60)
  if (m < 60) return `${m}m ${String(Math.round(t % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function scoreHint(id: number, jobName: string, parent: number | null, writesRepo: (job: string) => boolean): string {
  const target = parent ?? id
  const writes = writesRepo(jobName)
  return `orch score ${target} <none|partial|full> [wrong|mixed|right]`
    + (writes ? ' [drifted|partial|faithful]' : '')
    + ' --note "..."'
    + (parent ? `   # the whole conversation, not turn ${id}` : '')
}

function evidenceNote(row: { evidence_excluded: string | null }): string {
  return row.evidence_excluded
    ? `\n  not routing evidence: ${row.evidence_excluded}`
    : ''
}

export function collectResult(
  database: Database, argv: string[], writesRepo: (job: string) => boolean = () => false,
): void {
  const id = Number(argv[1])
  if (!id) throw new Error('orch result <run-id>')
  const row = database.query(
    `SELECT id, agent, job, status, latency_ms, vendor_tokens, output_path, error,
            failure_kind, exit_code, parent_run_id, evidence_excluded, base_commit
       FROM run WHERE id = ?`,
  ).get(id) as {
    id: number; agent: string; job: string; status: string; latency_ms: number | null
    vendor_tokens: number | null; output_path: string | null; error: string | null
    failure_kind: string | null; exit_code: number | null; parent_run_id: number | null
    evidence_excluded: string | null; base_commit: string | null
  } | null
  if (!row) throw new Error(`no run ${id}`)

  const outcome = outcomeOf(row)
  const baseNote = row.base_commit ? `\n  base:      ${row.base_commit}` : ''
  if (!outcome.terminal) {
    console.error(`run ${id} (${row.agent}/${row.job}) is still running`)
    process.exit(2)
  }
  if (row.output_path && existsSync(row.output_path)) {
    console.log(readFileSync(row.output_path, 'utf8'))
  }
  if (row.status === 'asking') {
    const rootId = row.parent_run_id ?? row.id
    const open = database.query(
      `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
        WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
    ).get(rootId, rootId) as { n: number }
    const running = database.query(
      `SELECT id FROM run
        WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
        ORDER BY turn DESC LIMIT 1`,
    ).get(rootId, rootId) as { id: number } | null
    console.error(
      (open.n
        ? `\n— run ${id} asking — waiting on a ruling: orch answer ${rootId} ...`
        : running
          ? `\n— run ${id} asking — resumed as run ${running.id}, which is still running`
          : `\n— run ${id} asking — recoverable: orch continue ${rootId}`) +
      baseNote + evidenceNote(row),
    )
    return
  }
  if (!outcome.ok) {
    console.error(`\n— run ${id} ${row.status}: ${failureReason(row)}` + baseNote + evidenceNote(row))
    process.exit(1)
  }
  if (!argv.includes('--quiet')) {
    console.error(
      `\n— run ${row.id} · ${row.agent} · ${dur(row.latency_ms)}` +
        (row.vendor_tokens ? ` · ${row.vendor_tokens.toLocaleString()} vendor tokens` : '') +
        `\n  score it:  ${scoreHint(row.id, row.job, row.parent_run_id, writesRepo)}` +
        baseNote + evidenceNote(row),
    )
  }
}

const VALUE_FLAGS = new Set(['--timeout'])

export async function collectWait(
  database: Database, argv: string[], beforePoll: () => void = () => {},
): Promise<void> {
  const rest = argv.slice(1)
  const ids = rest
    .filter((x, i) => /^\d+$/.test(x) && !VALUE_FLAGS.has(rest[i - 1] ?? ''))
    .map(Number)
  if (!ids.length) throw new Error('orch wait <run-id>...')
  const timeoutAt = argv.indexOf('--timeout')
  const timeoutMs = Number(timeoutAt >= 0 ? argv[timeoutAt + 1] : 1800) * 1000
  const deadline = Date.now() + timeoutMs
  const q = database.query(
    `SELECT id, status, error, failure_kind, exit_code
       FROM run WHERE id IN (${ids.map(() => '?').join(',')})`,
  )
  for (;;) {
    beforePoll()
    const rows = q.all(...ids) as {
      id: number; status: string; error: string | null
      failure_kind: string | null; exit_code: number | null
    }[]
    const outcomes = rows.map((row) => ({ row, outcome: outcomeOf(row) }))
    const running = outcomes.filter(({ outcome }) => !outcome.terminal)
    if (!running.length) {
      for (const { row, outcome } of outcomes) {
        console.log(`${row.id}\t${outcome.line}`)
        if (!outcome.ok) console.log(`  ${failureReason(row)}`)
      }
      if (outcomes.some(({ outcome }) => !outcome.ok)) process.exit(1)
      return
    }
    if (Date.now() >= deadline) {
      console.error(`still running after ${Math.round(timeoutMs / 1000)}s: ` +
        running.map(({ row }) => row.id).join(', '))
      process.exit(2)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

export async function collect(database: Database, argv: string[], beforePoll?: () => void): Promise<void> {
  if (argv[0] === 'result') collectResult(database, argv)
  else if (argv[0] === 'wait') await collectWait(database, argv, beforePoll)
  else throw new Error(`not a collection command: ${argv[0] ?? ''}`)
}
