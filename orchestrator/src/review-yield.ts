import type { Database } from 'bun:sqlite'
import { db } from './db.ts'
import {
  REVIEW_OVERLAP,
  REVIEW_SEVERITY,
  type ReviewOverlap,
  type ReviewSeverity,
} from './review-vocabulary.ts'
import { attributedTaskKey } from './epic.ts'
import { median } from './statistics.ts'
import { reviewRunEvidenceSql } from './review-evidence-sql.ts'
import { reviewTriageBag } from './review-triage.ts'

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
  unrecorded: number
  invalid: number
}

export type ReviewYieldRow = {
  key: string
  runs: number
  reviews: { recorded: number; completed: number }
  recordedFindings: number
  findings: number
  triaged: number
  untriaged: number
  hits: number
  accepted: number
  rejected: number
  modified: number
  skipped: number
  findingsPerRun: number | null
  highOrCriticalPerRun: number | null
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
  notRecorded: { metric: string; needed: string; count?: number }[]
}

type LensRow = {
  lens_id: number
  review_id: number
  recorded_at: string
  completed_at: string | null
  patch_id: string | null
  path_set: string | null
  project: string | null
  run_repo: string | null
  launch_key: string | null
  branch: string | null
  lens: string
  agent: string
  model: string | null
  latency_ms: number | null
  input_tree: string | null
  head_commit: string | null
  overlap: string | null
}

type FindingRow = {
  review_id: number
  review_lens_id: number
  severity: string
  triaged_severity: string | null
  disposition: string | null
}

type ComputedLens = LensRow & {
  task: string | null
  round: number | null
  findings: FindingRow[]
  reviewComplete: boolean
}

const normalized = (value: string | null | undefined) => value?.trim().toLowerCase() ?? null

/**
 * A round is one canonical patch for one attributed task. Classification runs
 * before view filters, so every grouping and filtered view shares its ordinal.
 */
function classifyRounds(
  rows: LensRow[],
): Map<number, { task: string | null; round: number | null }> {
  const result = new Map<number, { task: string | null; round: number | null }>()
  const ordinal = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const row of rows) {
    const task = attributedTaskKey(row.launch_key, row.branch)
    if (!task || !row.patch_id) {
      result.set(row.lens_id, { task, round: null })
      continue
    }
    const identity = `${normalized(task)}\0${row.patch_id}\0${row.path_set ?? ''}`
    let round = ordinal.get(identity)
    if (round === undefined) {
      round = (seen.get(normalized(task)!) ?? 0) + 1
      seen.set(normalized(task)!, round)
      ordinal.set(identity, round)
    }
    result.set(row.lens_id, { task, round })
  }
  return result
}

export function reviewYield(
  filters: ReviewYieldFilters = {},
  database: Database = db(),
): ReviewYieldReport {
  const lensRows = database
    .query(
      `SELECT rl.id AS lens_id, r.id AS review_id, r.recorded_at, r.completed_at, r.patch_id, r.path_set, p.name AS project,
            run.repo AS run_repo, run.launch_key, run.branch, rl.lens, rl.agent,
            rl.model, run.latency_ms, run.input_tree, run.head_commit, rl.overlap
       FROM review_lens rl
       JOIN review r ON r.id=rl.review_id
       JOIN run ON run.id=rl.run_id
       LEFT JOIN project p ON p.id=r.project_id
      WHERE ${reviewRunEvidenceSql('run', 'rl')}
      ORDER BY r.recorded_at,r.id,rl.id`,
    )
    .all() as LensRow[]
  const findingRows = database
    .query(
      `SELECT review_id,review_lens_id,severity,triaged_severity,disposition
       FROM review_finding ORDER BY review_lens_id,ordinal`,
    )
    .all() as FindingRow[]
  const findings = new Map<number, FindingRow[]>()
  for (const row of findingRows)
    findings.set(row.review_lens_id, [...(findings.get(row.review_lens_id) ?? []), row])

  const rounds = classifyRounds(lensRows)
  const reviewFindings = new Map<number, FindingRow[]>()
  for (const row of findingRows)
    reviewFindings.set(row.review_id, [...(reviewFindings.get(row.review_id) ?? []), row])

  const wanted = {
    project: normalized(filters.project),
    task: normalized(filters.task),
    lens: normalized(filters.lens),
    agent: normalized(filters.agent),
  }
  const rows: ComputedLens[] = lensRows
    .filter((row) => {
      if (wanted.project && normalized(row.project ?? row.run_repo) !== wanted.project) return false
      if (filters.since && Date.parse(row.recorded_at) < Date.parse(filters.since)) return false
      if (wanted.task && normalized(rounds.get(row.lens_id)?.task) !== wanted.task) return false
      if (wanted.lens && normalized(row.lens) !== wanted.lens) return false
      if (wanted.agent && normalized(row.agent) !== wanted.agent) return false
      return true
    })
    .map((row) => ({
      ...row,
      ...rounds.get(row.lens_id)!,
      findings: findings.get(row.lens_id) ?? [],
      reviewComplete:
        row.completed_at !== null &&
        (reviewFindings.get(row.review_id) ?? []).every((finding) => finding.disposition !== null),
    }))

  const missingPatch = rows.filter((row) => row.patch_id === null).length

  return {
    filters: {
      project: filters.project ?? null,
      since: filters.since ?? null,
      task: filters.task ?? null,
      lens: filters.lens ?? null,
      agent: filters.agent ?? null,
    },
    lenses: grouped(rows, (row) => row.lens),
    rounds: grouped(
      rows.filter((row) => row.round !== null),
      (row) => `round ${row.round}`,
      (_a, _b, aRows, bRows) => aRows[0]!.round! - bRows[0]!.round!,
    ),
    agents: grouped(rows, (row) => row.agent),
    models: grouped(rows, (row) => row.model ?? '(not recorded)'),
    notRecorded: [
      {
        metric: 'finding-level overlap between duplicate lenses',
        needed:
          "store an equivalence link between findings from lenses with the same id on one review; the store records only each lens's aggregate overlap judgment",
      },
      ...(missingPatch
        ? [
            {
              metric: 'round change identity',
              needed: 'record review.patch_id; rounds are not keyed on input_tree or head_commit',
              count: missingPatch,
            },
          ]
        : []),
    ],
  }
}

function grouped(
  rows: ComputedLens[],
  keyOf: (row: ComputedLens) => string,
  sort: (a: string, b: string, aRows: ComputedLens[], bRows: ComputedLens[]) => number = (a, b) =>
    a.localeCompare(b),
): ReviewYieldRow[] {
  const groups = new Map<string, ComputedLens[]>()
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row])
  return [...groups.entries()]
    .sort(([a, aRows], [b, bRows]) => sort(a, b, aRows, bRows))
    .map(([key, members]) => aggregate(key, members))
}

function aggregate(key: string, rows: ComputedLens[]): ReviewYieldRow {
  const allFindings = rows.flatMap((row) => row.findings)
  const recordedTriage = reviewTriageBag(allFindings)
  const evidenceRows = rows.filter((row) => row.reviewComplete)
  const evidenceFindings = evidenceRows.flatMap((row) => row.findings)
  const triage = reviewTriageBag(evidenceFindings)
  const highSeverities = REVIEW_SEVERITY.slice(0, 2)
  const high = evidenceFindings.filter((finding) =>
    highSeverities.includes(finding.triaged_severity as ReviewSeverity),
  ).length
  const latencies = rows
    .flatMap((row) => (row.latency_ms === null ? [] : [Math.max(0, row.latency_ms)]))
    .sort((a, b) => a - b)
  const medianMs = median(latencies)
  const overlapCounts = Object.fromEntries(
    REVIEW_OVERLAP.map((value) => [value, rows.filter((row) => row.overlap === value).length]),
  ) as Record<ReviewOverlap, number>
  return {
    key,
    runs: rows.length,
    reviews: {
      recorded: new Set(rows.map((row) => row.review_id)).size,
      completed: new Set(evidenceRows.map((row) => row.review_id)).size,
    },
    recordedFindings: allFindings.length,
    findings: evidenceFindings.length,
    triaged: triage.triaged,
    untriaged: recordedTriage.untriaged,
    hits: triage.hits,
    accepted: triage.accepted,
    rejected: triage.rejected,
    modified: triage.modified,
    skipped: triage.skipped,
    findingsPerRun: evidenceRows.length ? evidenceFindings.length / evidenceRows.length : null,
    highOrCriticalPerRun: evidenceRows.length ? high / evidenceRows.length : null,
    medianLensMinutes: medianMs === null ? null : medianMs / 60_000,
    overlap: {
      ...overlapCounts,
      unrecorded: rows.filter((row) => row.overlap === null).length,
      invalid: rows.filter(
        (row) => row.overlap !== null && !REVIEW_OVERLAP.includes(row.overlap as ReviewOverlap),
      ).length,
    },
  }
}

const number = (value: number | null) => (value === null ? '—' : value.toFixed(2))

export function renderReviewYieldHuman(report: ReviewYieldReport): string {
  const lines: string[] = []
  const section = (title: string, rows: ReviewYieldRow[]) => {
    lines.push(title)
    lines.push(
      'KEY'.padEnd(22) +
        'RUNS REV C REC FIND TRI UNTR ACCEPT REJECT MODIFY SKIP  F/R H+C/R MED MIN  UNIQUE SHARED',
    )
    if (!rows.length) lines.push('(none)')
    for (const row of rows)
      lines.push(
        row.key.slice(0, 21).padEnd(22) +
          String(row.runs).padStart(4) +
          String(row.reviews.recorded).padStart(4) +
          String(row.reviews.completed).padStart(2) +
          String(row.recordedFindings).padStart(4) +
          String(row.findings).padStart(5) +
          String(row.triaged).padStart(4) +
          String(row.untriaged).padStart(5) +
          String(row.accepted).padStart(8) +
          String(row.rejected).padStart(7) +
          String(row.modified).padStart(7) +
          String(row.skipped).padStart(5) +
          number(row.findingsPerRun).padStart(5) +
          number(row.highOrCriticalPerRun).padStart(6) +
          (row.medianLensMinutes === null ? '—' : number(row.medianLensMinutes)).padStart(8) +
          String(row.overlap.unique).padStart(8) +
          String(row.overlap.shared).padStart(7),
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
  for (const missing of report.notRecorded)
    lines.push(
      `  ${missing.metric}${missing.count === undefined ? '' : ` (${missing.count})`}: ${missing.needed}`,
    )
  return lines.join('\n')
}
