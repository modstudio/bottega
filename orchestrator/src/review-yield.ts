import type { Database } from 'bun:sqlite'
import { db } from './db.ts'

export type ReviewYieldFilters = {
  project?: string
  since?: string
  task?: string
  lens?: string
  agent?: string
}

export type ReviewYieldOverlap = {
  unique: number
  shared: number
  none: number
  alone: number
  notRecorded: number
}

export type ReviewYieldRow = {
  key: string
  runs: number
  findings: number
  accepted: number
  rejected: number
  modified: number
  skipped: number
  findingsPerRun: number
  highOrCriticalPerRun: number
  medianLensMinutes: number | null
  overlap: ReviewYieldOverlap
}

export type ReviewYieldReport = {
  filters: {
    project: string | null
    since: string | null
    task: string | null
    lens: string | null
    agent: string | null
  }
  lenses: ReviewYieldRow[]
  rounds: ReviewYieldRow[]
  agents: ReviewYieldRow[]
  models: ReviewYieldRow[]
  notRecorded: { metric: string; needed: string }[]
}

type LensRow = {
  lens_id: number
  review_id: number
  recorded_at: string
  project: string | null
  run_repo: string | null
  launch_key: string | null
  branch: string | null
  lens: string
  agent: string
  model: string | null
  latency_ms: number | null
  overlap: string | null
}

type FindingRow = {
  review_lens_id: number
  severity: string
  triaged_severity: string | null
  disposition: string | null
}

type ComputedLens = LensRow & { round: number; findings: FindingRow[] }

const normalized = (value: string | null | undefined) => value?.trim().toLowerCase() ?? null

/**
 * A round is one review for one task, ordered by the review record. It is
 * computed before lens and agent filters so a filtered view keeps the ordinal
 * of the round that actually happened.
 */
export function reviewYield(
  filters: ReviewYieldFilters = {}, database: Database = db(),
): ReviewYieldReport {
  const lensRows = database.query(
    `SELECT rl.id AS lens_id, r.id AS review_id, r.recorded_at, p.name AS project,
            run.repo AS run_repo, run.launch_key, run.branch, rl.lens, rl.agent,
            rl.model, run.latency_ms, rl.overlap
       FROM review_lens rl
       JOIN review r ON r.id=rl.review_id
       JOIN run ON run.id=rl.run_id
       LEFT JOIN project p ON p.id=r.project_id
      ORDER BY r.recorded_at,r.id,rl.id`,
  ).all() as LensRow[]
  const findingRows = database.query(
    `SELECT review_lens_id,severity,triaged_severity,disposition
       FROM review_finding ORDER BY review_lens_id,ordinal`,
  ).all() as FindingRow[]
  const findings = new Map<number, FindingRow[]>()
  for (const row of findingRows) findings.set(row.review_lens_id, [...(findings.get(row.review_lens_id) ?? []), row])

  const reviewIdentity = new Map<number, string>()
  for (const row of lensRows) {
    if (!reviewIdentity.has(row.review_id)) {
      reviewIdentity.set(row.review_id,
        normalized(row.launch_key) ?? normalized(row.branch) ?? `review:${row.review_id}`)
    }
  }
  const ordinal = new Map<number, number>()
  const seen = new Map<string, number>()
  for (const row of lensRows) {
    if (ordinal.has(row.review_id)) continue
    const identity = reviewIdentity.get(row.review_id)!
    const next = (seen.get(identity) ?? 0) + 1
    seen.set(identity, next)
    ordinal.set(row.review_id, next)
  }

  const wanted = {
    project: normalized(filters.project), task: normalized(filters.task),
    lens: normalized(filters.lens), agent: normalized(filters.agent),
  }
  const rows: ComputedLens[] = lensRows.filter((row) => {
    if (wanted.project && normalized(row.project ?? row.run_repo) !== wanted.project) return false
    if (filters.since && Date.parse(row.recorded_at) < Date.parse(filters.since)) return false
    if (wanted.task && normalized(row.launch_key) !== wanted.task) return false
    if (wanted.lens && normalized(row.lens) !== wanted.lens) return false
    if (wanted.agent && normalized(row.agent) !== wanted.agent) return false
    return true
  }).map((row) => ({ ...row, round: ordinal.get(row.review_id)!, findings: findings.get(row.lens_id) ?? [] }))

  return {
    filters: {
      project: filters.project ?? null, since: filters.since ?? null, task: filters.task ?? null,
      lens: filters.lens ?? null, agent: filters.agent ?? null,
    },
    lenses: grouped(rows, (row) => row.lens),
    rounds: grouped(rows, (row) => `round ${row.round}`, (a, b) => Number(a.slice(6)) - Number(b.slice(6))),
    agents: grouped(rows, (row) => row.agent),
    models: grouped(rows, (row) => row.model ?? '(not recorded)'),
    notRecorded: [{
      metric: 'finding-level overlap between duplicate lenses',
      needed: 'store an equivalence link between findings from lenses with the same id on one review; the store records only each lens\'s aggregate overlap judgment',
    }],
  }
}

function grouped(
  rows: ComputedLens[], keyOf: (row: ComputedLens) => string,
  sort: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): ReviewYieldRow[] {
  const groups = new Map<string, ComputedLens[]>()
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row])
  return [...groups.entries()].sort(([a], [b]) => sort(a, b)).map(([key, members]) => aggregate(key, members))
}

function aggregate(key: string, rows: ComputedLens[]): ReviewYieldRow {
  const allFindings = rows.flatMap((row) => row.findings)
  const count = (disposition: string) => allFindings.filter((finding) => finding.disposition === disposition).length
  const high = allFindings.filter((finding) => ['high', 'critical'].includes(finding.triaged_severity ?? finding.severity)).length
  const latencies = rows.flatMap((row) => row.latency_ms === null ? [] : [Math.max(0, row.latency_ms)]).sort((a, b) => a - b)
  const middle = Math.floor(latencies.length / 2)
  const medianMs = !latencies.length ? null : latencies.length % 2
    ? latencies[middle]!
    : (latencies[middle - 1]! + latencies[middle]!) / 2
  const overlap = (value: string) => rows.filter((row) => row.overlap === value).length
  return {
    key, runs: rows.length, findings: allFindings.length,
    accepted: count('accepted'), rejected: count('rejected'), modified: count('modified'), skipped: count('skipped'),
    findingsPerRun: rows.length ? allFindings.length / rows.length : 0,
    highOrCriticalPerRun: rows.length ? high / rows.length : 0,
    medianLensMinutes: medianMs === null ? null : medianMs / 60_000,
    overlap: {
      unique: overlap('unique'), shared: overlap('shared'), none: overlap('none'), alone: overlap('alone'),
      notRecorded: rows.filter((row) => row.overlap === null).length,
    },
  }
}

const number = (value: number) => value.toFixed(2)

export function renderReviewYieldHuman(report: ReviewYieldReport): string {
  const lines: string[] = []
  const section = (title: string, rows: ReviewYieldRow[]) => {
    lines.push(title)
    lines.push('KEY'.padEnd(22) + 'RUNS FIND  ACCEPT REJECT MODIFY SKIP  F/R H+C/R MED MIN  UNIQUE SHARED')
    if (!rows.length) lines.push('(none)')
    for (const row of rows) lines.push(
      row.key.slice(0, 21).padEnd(22) +
      String(row.runs).padStart(4) + String(row.findings).padStart(5) +
      String(row.accepted).padStart(8) + String(row.rejected).padStart(7) +
      String(row.modified).padStart(7) + String(row.skipped).padStart(5) +
      number(row.findingsPerRun).padStart(5) + number(row.highOrCriticalPerRun).padStart(6) +
      (row.medianLensMinutes === null ? '—' : number(row.medianLensMinutes)).padStart(8) +
      String(row.overlap.unique).padStart(8) + String(row.overlap.shared).padStart(7),
    )
  }
  section('BY LENS', report.lenses)
  lines.push('')
  section('BY ROUND ORDINAL', report.rounds)
  lines.push('')
  section('BY AGENT', report.agents)
  lines.push('')
  section('BY MODEL', report.models)
  lines.push('', 'NOT RECORDED')
  for (const missing of report.notRecorded) lines.push(`  ${missing.metric}: ${missing.needed}`)
  return lines.join('\n')
}
