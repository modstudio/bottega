import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { median } from '../state/statistics.ts'
import { applicableReview } from './review-applicability.ts'
import { reviewRoundIdentity } from './review-round-identity.ts'
import {
  parseStoredReviewPathSet,
  parseStoredReviewSettings,
  reviewRunEvidenceSql,
} from './review-evidence-sql.ts'
import { reviewLensGraded } from './review-group.ts'
import { identifySecondOpinionRun } from './review-second-opinion.ts'
import { reviewTriageBag } from './review-triage.ts'
import {
  REVIEW_OVERLAP,
  REVIEW_SEVERITY,
  type ReviewOverlap,
  type ReviewSeverity,
} from './review-vocabulary.ts'
import {
  mediumPlusAcceptedCount,
  mediumPlusAcceptedYield,
  UNRECORDED_SLICE,
  yieldAreaKey,
  yieldPathAreas,
  yieldRiskKey,
  yieldSizeKey,
} from './review-yield-slice.ts'

export type ReviewYieldFilters = {
  project?: string
  since?: string
  task?: string
  lens?: string
  agent?: string
}

type ReviewYieldOverlap = {
  unique: number
  shared: number
  none: number
  alone: number
  unrecorded: number
  invalid: number
}

type ReviewYieldRow = {
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
  linkedFindings: number
  mediumPlusAccepted: number
  mediumPlusAcceptedYield: number | null
  overlap: ReviewYieldOverlap
}

type ReviewYieldLensPair = {
  lenses: [string, string]
  linkedFindings: number
  findings: [number, number]
  shares: [number | null, number | null]
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
  bySize: ReviewYieldRow[]
  byRisk: ReviewYieldRow[]
  byArea: ReviewYieldRow[]
  lensPairs: ReviewYieldLensPair[]
  rounds: ReviewYieldRow[]
  lensRounds: ReviewYieldRow[]
  selectionReasons: ReviewYieldRow[]
  agents: ReviewYieldRow[]
  models: ReviewYieldRow[]
  notRecorded: { metric: string; needed: string; count?: number }[]
}

export type ReviewRoundEvidenceRow = {
  lens_id: string
  run_id: string
  review_record_id: string
  recorded_at: string
  completed_at: string | null
  tier: 0 | 1 | 2 | 3 | null
  tier_risk: number | null
  tier_size: number | null
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
  reproduced: string | null
  coverage: string | null
  limits: string | null
  project_settings: string | null
  stored_round: number | null
  selection_reason: string | null
}

type FindingRow = {
  record_id: string
  review_record_id: string
  review_lens_record_id: string
  severity: string
  triaged_severity: string | null
  disposition: string | null
  duplicate_of_finding_record_id: string | null
}

type ComputedLens = ReviewRoundEvidenceRow & {
  task: string | null
  round: number | null
  findings: FindingRow[]
  reviewComplete: boolean
  secondOpinion: boolean
}

const normalized = (value: string | null | undefined) => value?.trim().toLowerCase() ?? null

function classifyTasks(
  rows: ReviewRoundEvidenceRow[],
): Map<string, { task: string | null; round: number | null }> {
  const result = new Map<string, { task: string | null; round: number | null }>()
  for (const row of rows) {
    result.set(row.lens_id, {
      task: reviewRoundIdentity(row).task,
      round: row.stored_round,
    })
  }
  return result
}

const reviewFindingRows = (database: Database): FindingRow[] =>
  database
    .query(
      `SELECT record_id,review_record_id,review_lens_record_id,severity,triaged_severity,disposition,
              duplicate_of_finding_record_id
       FROM review_finding ORDER BY review_lens_record_id,ordinal`,
    )
    .all() as FindingRow[]

export function reviewYield(
  filters: ReviewYieldFilters = {},
  database: Database = db(),
): ReviewYieldReport {
  const lensRows = database
    .query(
      `SELECT rl.record_id AS lens_id, run.record_id AS run_id, r.record_id AS review_record_id, r.recorded_at, r.completed_at, r.tier, r.tier_risk, r.tier_size, r.patch_id, r.path_set, p.name AS project,
            run.repo AS run_repo, run.launch_key, run.branch, rl.lens, rl.agent,
            rl.model, run.latency_ms, run.input_tree, run.head_commit, rl.overlap,rl.reproduced,
            rl.coverage,rl.limits,p.settings AS project_settings, r.round AS stored_round,
            rl.selection_reason
       FROM review_lens rl
       JOIN review r ON r.record_id=rl.review_record_id
       JOIN run ON run.record_id=rl.run_record_id
       LEFT JOIN project p ON p.record_id=r.project_record_id
      WHERE ${reviewRunEvidenceSql('run', 'rl')}
      ORDER BY r.recorded_at,r.record_id,rl.record_id`,
    )
    .all() as ReviewRoundEvidenceRow[]
  const findingRows = reviewFindingRows(database)
  const findings = new Map<string, FindingRow[]>()
  for (const row of findingRows)
    findings.set(row.review_lens_record_id, [
      ...(findings.get(row.review_lens_record_id) ?? []),
      row,
    ])

  const rounds = classifyTasks(lensRows)
  const secondOpinionRuns = classifySecondOpinions(lensRows)
  const reviewFindings = new Map<string, FindingRow[]>()
  for (const row of findingRows)
    reviewFindings.set(row.review_record_id, [
      ...(reviewFindings.get(row.review_record_id) ?? []),
      row,
    ])

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
        (reviewFindings.get(row.review_record_id) ?? []).every(
          (finding) => finding.disposition !== null,
        ),
      secondOpinion: secondOpinionRuns.has(row.run_id),
    }))

  const missingPatch = rows.filter((row) => row.patch_id === null).length
  const pairs = lensPairs(rows)

  return {
    filters: {
      project: filters.project ?? null,
      since: filters.since ?? null,
      task: filters.task ?? null,
      lens: filters.lens ?? null,
      agent: filters.agent ?? null,
    },
    lenses: grouped(rows, displayLens),
    ...changeSlices(rows),
    lensPairs: pairs,
    rounds: grouped(
      rows.filter((row) => row.round !== null),
      (row) => `round ${row.round}`,
      (_a, _b, aRows, bRows) => aRows[0]!.round! - bRows[0]!.round!,
    ),
    lensRounds: grouped(
      rows.filter((row) => row.round !== null),
      (row) => `${displayLens(row)} round ${row.round}`,
      (a, b) => a.localeCompare(b, undefined, { numeric: true }),
    ),
    selectionReasons: grouped(
      rows.filter((row) => row.selection_reason !== null),
      (row) => row.selection_reason!,
    ),
    agents: grouped(rows, (row) => row.agent),
    models: grouped(rows, (row) => row.model ?? '(not recorded)'),
    notRecorded: [
      pairs.length
        ? {
            metric: 'finding-level overlap between duplicate lenses',
            needed: 'only reviews with explicit --duplicate links are measured in finding overlap',
          }
        : {
            metric: 'finding-level overlap between duplicate lenses',
            needed: 'record matching findings while scoring with --duplicate N=<run>#<M>',
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

const displayLens = (row: ComputedLens): string =>
  `${row.lens}${row.secondOpinion ? ' (second opinion)' : ''}`

function classifySecondOpinions(rows: ReviewRoundEvidenceRow[]): Set<string> {
  const groups = new Map<string, ReviewRoundEvidenceRow[]>()
  for (const row of rows) {
    if (!row.project || !row.branch || !row.patch_id || !row.path_set || row.tier === null) continue
    const key = JSON.stringify([row.project, row.branch, row.patch_id, row.path_set])
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const result = new Set<string>()
  for (const members of groups.values()) {
    const first = members[0]!
    const paths = parseStoredReviewPathSet(first.path_set)
    if (!paths) continue
    const lens = applicableReview(
      first.tier!,
      paths,
      parseStoredReviewSettings(first.project_settings),
    ).secondOpinion
    if (!lens) continue
    const creditedRuns = identifySecondOpinionRun(
      members.map((row) => ({
        recordId: row.lens_id,
        runId: row.run_id,
        lens: row.lens,
        model: row.model,
        graded: reviewLensGraded(row),
        completed: row.completed_at !== null,
      })),
      lens,
    )
    if (creditedRuns) result.add(creditedRuns.secondRunId)
  }
  return result
}

function linkedFindingIds(rows: ComputedLens[], allRows: ComputedLens[]): Set<string> {
  const selected = new Set(
    allRows.flatMap((row) =>
      row.reviewComplete ? row.findings.map((finding) => finding.record_id) : [],
    ),
  )
  const members = new Set(
    rows.flatMap((row) =>
      row.reviewComplete ? row.findings.map((finding) => finding.record_id) : [],
    ),
  )
  const linked = new Set<string>()
  for (const finding of allRows.flatMap((row) => (row.reviewComplete ? row.findings : []))) {
    const peer = finding.duplicate_of_finding_record_id
    if (!peer || !selected.has(peer)) continue
    if (members.has(finding.record_id)) linked.add(finding.record_id)
    if (members.has(peer)) linked.add(peer)
  }
  return linked
}

function lensPairs(rows: ComputedLens[]): ReviewYieldLensPair[] {
  const findingRows = new Map(
    rows.flatMap((row) =>
      row.reviewComplete
        ? row.findings.map(
            (finding) => [finding.record_id, { finding, lens: displayLens(row) }] as const,
          )
        : [],
    ),
  )
  const counts = new Map<string, { lenses: [string, string]; count: number }>()
  for (const { finding, lens } of findingRows.values()) {
    const peer = finding.duplicate_of_finding_record_id
      ? findingRows.get(finding.duplicate_of_finding_record_id)
      : undefined
    if (!peer) continue
    const lenses = [lens, peer.lens].sort() as [string, string]
    const key = JSON.stringify(lenses)
    const current = counts.get(key)
    counts.set(key, { lenses, count: (current?.count ?? 0) + 1 })
  }
  const totals = new Map<string, number>()
  for (const row of rows) {
    if (row.reviewComplete)
      totals.set(displayLens(row), (totals.get(displayLens(row)) ?? 0) + row.findings.length)
  }
  return [...counts.values()]
    .sort((a, b) => JSON.stringify(a.lenses).localeCompare(JSON.stringify(b.lenses)))
    .map(({ lenses, count }) => {
      const findings: [number, number] = [totals.get(lenses[0]) ?? 0, totals.get(lenses[1]) ?? 0]
      return {
        lenses,
        linkedFindings: count,
        findings,
        shares: findings.map((total) => (total ? count / total : null)) as [
          number | null,
          number | null,
        ],
      }
    })
}

function yieldRowAreas(row: ComputedLens): string[] {
  const paths = parseStoredReviewPathSet(row.path_set)
  if (paths === null) return [UNRECORDED_SLICE]
  return yieldPathAreas(paths, parseStoredReviewSettings(row.project_settings)?.lenses ?? [])
}

function changeSlices(
  rows: ComputedLens[],
): Pick<ReviewYieldReport, 'bySize' | 'byRisk' | 'byArea'> {
  const sliceSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
  return {
    bySize: grouped(rows, (row) => yieldSizeKey(displayLens(row), row.tier_size), sliceSort),
    byRisk: grouped(rows, (row) => yieldRiskKey(displayLens(row), row.tier_risk), sliceSort),
    byArea: grouped(
      rows.flatMap((row) => yieldRowAreas(row).map((area) => ({ ...row, area }))),
      (row) => yieldAreaKey(displayLens(row), row.area),
      sliceSort,
    ),
  }
}

function grouped<T extends ComputedLens>(
  rows: T[],
  keyOf: (row: T) => string,
  sort: (a: string, b: string, aRows: T[], bRows: T[]) => number = (a, b) => a.localeCompare(b),
): ReviewYieldRow[] {
  const groups = new Map<string, T[]>()
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row])
  return [...groups.entries()]
    .sort(([a, aRows], [b, bRows]) => sort(a, b, aRows, bRows))
    .map(([key, members]) => aggregate(key, members, rows))
}

function aggregate(key: string, rows: ComputedLens[], allRows: ComputedLens[]): ReviewYieldRow {
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
      recorded: new Set(rows.map((row) => row.review_record_id)).size,
      completed: new Set(evidenceRows.map((row) => row.review_record_id)).size,
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
    linkedFindings: linkedFindingIds(rows, allRows).size,
    mediumPlusAccepted: mediumPlusAcceptedCount(evidenceFindings),
    mediumPlusAcceptedYield: mediumPlusAcceptedYield(evidenceRows),
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

type YieldColumn = { header: string; align: 'left' | 'right' }

/** Size each column to the widest of its header and values, with a space between columns. */
export function renderYieldTable(
  columns: readonly YieldColumn[],
  rows: readonly (readonly string[])[],
): string[] {
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  )
  const format = (cells: readonly string[]) =>
    cells
      .map((cell, index) =>
        columns[index]!.align === 'left'
          ? cell.padEnd(widths[index]!)
          : cell.padStart(widths[index]!),
      )
      .join(' ')
  return [format(columns.map((column) => column.header)), ...rows.map(format)]
}

const YIELD_ROW_COLUMNS: YieldColumn[] = [
  { header: 'KEY', align: 'left' },
  { header: 'RUNS', align: 'right' },
  { header: 'REV', align: 'right' },
  { header: 'C', align: 'right' },
  { header: 'REC', align: 'right' },
  { header: 'FIND', align: 'right' },
  { header: 'LINK', align: 'right' },
  { header: 'TRI', align: 'right' },
  { header: 'UNTR', align: 'right' },
  { header: 'ACCEPT', align: 'right' },
  { header: 'REJECT', align: 'right' },
  { header: 'MODIFY', align: 'right' },
  { header: 'SKIP', align: 'right' },
  { header: 'F/R', align: 'right' },
  { header: 'H+C/R', align: 'right' },
  { header: 'MED MIN', align: 'right' },
  { header: 'MED+', align: 'right' },
  { header: 'UNIQUE', align: 'right' },
  { header: 'SHARED', align: 'right' },
  { header: 'NONE', align: 'right' },
  { header: 'ALONE', align: 'right' },
]

const YIELD_PAIR_COLUMNS: YieldColumn[] = [
  { header: 'LENSES', align: 'left' },
  { header: 'LINKED', align: 'right' },
  { header: 'SHARE LEFT', align: 'right' },
  { header: 'SHARE RIGHT', align: 'right' },
]

function yieldRowCells(row: ReviewYieldRow): string[] {
  return [
    row.key,
    String(row.runs),
    String(row.reviews.recorded),
    String(row.reviews.completed),
    String(row.recordedFindings),
    String(row.findings),
    String(row.linkedFindings),
    String(row.triaged),
    String(row.untriaged),
    String(row.accepted),
    String(row.rejected),
    String(row.modified),
    String(row.skipped),
    number(row.findingsPerRun),
    number(row.highOrCriticalPerRun),
    row.medianLensMinutes === null ? '—' : number(row.medianLensMinutes),
    number(row.mediumPlusAcceptedYield),
    String(row.overlap.unique),
    String(row.overlap.shared),
    String(row.overlap.none),
    String(row.overlap.alone),
  ]
}

export function renderReviewYieldHuman(report: ReviewYieldReport): string {
  const lines: string[] = []
  const section = (title: string, rows: ReviewYieldRow[]) => {
    lines.push(title)
    const table = renderYieldTable(YIELD_ROW_COLUMNS, rows.map(yieldRowCells))
    lines.push(table[0]!)
    if (!rows.length) lines.push('(none)')
    else lines.push(...table.slice(1))
  }
  section('BY LENS', report.lenses)
  lines.push('')
  section('BY SIZE', report.bySize)
  lines.push('')
  section('BY RISK', report.byRisk)
  lines.push('')
  section('BY AREA', report.byArea)
  lines.push('')
  lines.push('BY LENS PAIR')
  const pairs = renderYieldTable(
    YIELD_PAIR_COLUMNS,
    report.lensPairs.map((pair) => [
      pair.lenses.join(' / '),
      String(pair.linkedFindings),
      number(pair.shares[0]),
      number(pair.shares[1]),
    ]),
  )
  lines.push(pairs[0]!)
  if (!report.lensPairs.length) lines.push('(none)')
  else lines.push(...pairs.slice(1))
  lines.push('')
  section('BY ROUND ORDINAL', report.rounds)
  lines.push('')
  section('BY LENS ROUND', report.lensRounds)
  lines.push('')
  section('BY SELECTION REASON', report.selectionReasons)
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
