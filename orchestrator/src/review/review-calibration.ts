// concern: review-calibration
import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { median } from '../state/statistics.ts'
import { completedReviewEvidenceSql, REVIEW_WINDOW } from './review-evidence-sql.ts'
import { MIN_REVIEW_TRIAGED } from './review-triage.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
  REVIEW_SEVERITY,
  type ReviewCoverage,
  type ReviewLimits,
  type ReviewOverlap,
  type ReviewReproduced,
  type ReviewSeverity,
} from './review-vocabulary.ts'

export type ReviewCalibration = {
  lens: string
  agent: string
  model: string | null
  precision: number | null
  hits: number
  triaged: number
  rejection_categories: { category: string; count: number }[]
  /** Completed lens runs that explicitly degraded from requested MCP to the mirror. */
  mirror_lenses: number
  basis: 'model' | 'agent' | null
  reproduced: GradeDistribution<ReviewReproduced>
  coverage: GradeDistribution<ReviewCoverage>
  limits: GradeDistribution<ReviewLimits>
  overlap: GradeDistribution<ReviewOverlap>
  severity: SeverityAgreement
  tiers: Record<'0' | '1' | '2' | '3' | 'unclassified', TierCalibration>
}

type TierCalibration = {
  reviews: number
  lenses: number
  findings_accepted: number
  findings_rejected: number
  rounds: { min: number | null; median: number | null; max: number | null }
}

type GradeDistribution<T extends string> = {
  counts: Record<T, number>
  shares: Record<T, number | null>
  ungraded: number
}

type SeverityAgreement = {
  counts: { agreed: number; changed: number; not_comparable: number; not_assessed: number }
  shares: {
    agreed: number | null
    changed: number | null
    not_comparable: number | null
    not_assessed: number | null
  }
}

function gradeDistribution<T extends string>(
  rows: Record<string, unknown>[],
  column: string,
  values: readonly T[],
): GradeDistribution<T> {
  const counts = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>
  let ungraded = 0
  for (const row of rows) {
    const value = row[column]
    if (typeof value === 'string' && values.includes(value as T)) counts[value as T]++
    else ungraded++
  }
  const graded = rows.length - ungraded
  const shares = Object.fromEntries(
    values.map((value) => [value, graded > 0 ? counts[value] / graded : null]),
  ) as Record<T, number | null>
  return { counts, shares, ungraded }
}

function severityAgreement(
  rows: { severity: string; triaged_severity: string | null }[],
): SeverityAgreement {
  const counts = { agreed: 0, changed: 0, not_comparable: 0, not_assessed: 0 }
  for (const row of rows) {
    if (row.triaged_severity === null) counts.not_assessed++
    else if (!REVIEW_SEVERITY.includes(row.severity as ReviewSeverity)) counts.not_comparable++
    else if (row.triaged_severity === row.severity) counts.agreed++
    else counts.changed++
  }
  const total = rows.length
  return {
    counts,
    shares: {
      agreed: total ? counts.agreed / total : null,
      changed: total ? counts.changed / total : null,
      not_comparable: total ? counts.not_comparable / total : null,
      not_assessed: total ? counts.not_assessed / total : null,
    },
  }
}

function calibrationCell(
  lens: string,
  agent: string,
  model: string | null | undefined,
  database: Database,
): Omit<ReviewCalibration, 'basis'> {
  const modelClause = model === undefined ? '' : 'AND rl.model IS ?'
  const reviews = database
    .query(
      `SELECT DISTINCT r.id FROM review r JOIN review_lens rl ON rl.review_id=r.id
      JOIN run ON run.id=rl.run_id
      WHERE rl.lens=? AND rl.agent=? AND ${completedReviewEvidenceSql('r', 'run', 'rl')} ${modelClause}
      ORDER BY r.completed_at DESC, r.id DESC LIMIT ?`,
    )
    .all(
      ...(model === undefined ? [lens, agent, REVIEW_WINDOW] : [lens, agent, model, REVIEW_WINDOW]),
    ) as { id: number }[]
  const emptyTiers = () =>
    Object.fromEntries(
      ['0', '1', '2', '3', 'unclassified'].map((key) => [
        key,
        {
          reviews: 0,
          lenses: 0,
          findings_accepted: 0,
          findings_rejected: 0,
          rounds: { min: null, median: null, max: null },
        },
      ]),
    ) as ReviewCalibration['tiers']
  const emptyGrades = () => ({
    reproduced: gradeDistribution([], 'reproduced', REVIEW_REPRODUCED),
    coverage: gradeDistribution([], 'coverage', REVIEW_COVERAGE),
    limits: gradeDistribution([], 'limits', REVIEW_LIMITS),
    overlap: gradeDistribution([], 'overlap', REVIEW_OVERLAP),
    severity: severityAgreement([]),
    tiers: emptyTiers(),
  })
  if (!reviews.length)
    return {
      lens,
      agent,
      model: model ?? null,
      precision: null,
      hits: 0,
      triaged: 0,
      rejection_categories: [],
      mirror_lenses: 0,
      ...emptyGrades(),
    }
  const ids = reviews.map((r) => r.id)
  const marks = ids.map(() => '?').join(',')
  const counts = database
    .query(
      `SELECT
       SUM(CASE WHEN disposition IN ('accepted','modified') THEN 1 ELSE 0 END) AS hits,
       SUM(CASE WHEN disposition IN ('accepted','modified','rejected') THEN 1 ELSE 0 END) AS triaged
     FROM review_finding rf JOIN review_lens rl ON rl.id=rf.review_lens_id
     WHERE rf.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}`,
    )
    .get(...ids, lens, agent, ...(model === undefined ? [] : [model])) as {
    hits: number | null
    triaged: number | null
  }
  const categories = database
    .query(
      `SELECT rejection_category AS category, COUNT(*) AS count
       FROM review_finding rf JOIN review_lens rl ON rl.id=rf.review_lens_id
      WHERE rf.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}
        AND disposition='rejected' AND rejection_category IS NOT NULL
      GROUP BY rejection_category ORDER BY count DESC, category LIMIT 3`,
    )
    .all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as {
    category: string
    count: number
  }[]
  const triaged = counts.triaged ?? 0
  const hits = counts.hits ?? 0
  const mirrorLenses = database
    .query(
      `SELECT COUNT(*) AS count FROM review_lens rl JOIN run ON run.id=rl.run_id
      WHERE rl.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}
        AND run.mcp_connected=0 AND run.mcp_error LIKE 'mirror:%'`,
    )
    .get(...ids, lens, agent, ...(model === undefined ? [] : [model])) as { count: number }
  const gradeRows = database
    .query(
      `SELECT reproduced, coverage, limits, overlap FROM review_lens rl
      WHERE rl.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}`,
    )
    .all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as Record<string, unknown>[]
  const severityRows = database
    .query(
      `SELECT rf.severity, rf.triaged_severity FROM review_finding rf
      JOIN review_lens rl ON rl.id=rf.review_lens_id
      WHERE rf.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}
        AND rf.disposition IS NOT NULL`,
    )
    .all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as {
    severity: string
    triaged_severity: string | null
  }[]
  const tierRows = database
    .query(
      `SELECT r.id AS review_id, r.tier, rl.id AS lens_id, rf.disposition
       FROM review r JOIN review_lens rl ON rl.review_id=r.id
       LEFT JOIN review_finding rf ON rf.review_lens_id=rl.id
      WHERE r.id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}`,
    )
    .all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as {
    review_id: number
    tier: number | null
    lens_id: number
    disposition: string | null
  }[]
  const tiers = emptyTiers()
  const tierReviews = new Map<string, Set<number>>()
  const tierLenses = new Map<string, Set<number>>()
  for (const row of tierRows) {
    const key = row.tier === null ? 'unclassified' : String(row.tier)
    const cell = tiers[key as keyof typeof tiers]
    if (!cell) continue
    const reviews = tierReviews.get(key) ?? new Set<number>()
    const lenses = tierLenses.get(key) ?? new Set<number>()
    reviews.add(row.review_id)
    lenses.add(row.lens_id)
    tierReviews.set(key, reviews)
    tierLenses.set(key, lenses)
    if (row.disposition === 'accepted') cell.findings_accepted++
    if (row.disposition === 'rejected') cell.findings_rejected++
  }
  for (const [key, cell] of Object.entries(tiers)) {
    cell.reviews = tierReviews.get(key)?.size ?? 0
    cell.lenses = tierLenses.get(key)?.size ?? 0
  }
  const identityRows = database
    .query(
      `SELECT r.id AS review_id, r.tier, rl.id AS lens_id, run.branch, run.launch_key
       FROM review r JOIN review_lens rl ON rl.review_id=r.id
       JOIN run ON run.id=rl.run_id
      WHERE r.id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}
      ORDER BY r.id, rl.id`,
    )
    .all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as {
    review_id: number
    tier: number | null
    lens_id: number
    branch: string | null
    launch_key: string | null
  }[]
  const firstIdentity = new Map<number, (typeof identityRows)[number]>()
  for (const row of identityRows)
    if (!firstIdentity.has(row.review_id)) firstIdentity.set(row.review_id, row)
  const roundCounts = new Map<string, Map<string, number>>()
  for (const row of firstIdentity.values()) {
    const tier = row.tier === null ? 'unclassified' : String(row.tier)
    const identities = roundCounts.get(tier) ?? new Map<string, number>()
    const identity = row.launch_key ?? row.branch ?? `review:${row.review_id}`
    identities.set(identity, (identities.get(identity) ?? 0) + 1)
    roundCounts.set(tier, identities)
  }
  for (const [key, cell] of Object.entries(tiers)) {
    const values = [...(roundCounts.get(key)?.values() ?? [])]
    if (values.length)
      cell.rounds = {
        min: Math.min(...values),
        median: median(values),
        max: Math.max(...values),
      }
  }
  return {
    lens,
    agent,
    model: model ?? null,
    precision: triaged >= MIN_REVIEW_TRIAGED ? hits / triaged : null,
    hits,
    triaged,
    rejection_categories: categories,
    mirror_lenses: mirrorLenses.count,
    reproduced: gradeDistribution(gradeRows, 'reproduced', REVIEW_REPRODUCED),
    coverage: gradeDistribution(gradeRows, 'coverage', REVIEW_COVERAGE),
    limits: gradeDistribution(gradeRows, 'limits', REVIEW_LIMITS),
    overlap: gradeDistribution(gradeRows, 'overlap', REVIEW_OVERLAP),
    severity: severityAgreement(severityRows),
    tiers,
  }
}

export function reviewCalibration(
  lens: string,
  agent: string,
  model: string,
  database: Database = db(),
): ReviewCalibration {
  const specific = calibrationCell(lens, agent, model, database)
  if (specific.triaged >= MIN_REVIEW_TRIAGED) return { ...specific, basis: 'model' }
  const aggregate = calibrationCell(lens, agent, undefined, database)
  if (aggregate.triaged >= MIN_REVIEW_TRIAGED) return { ...aggregate, model: null, basis: 'agent' }
  return { ...aggregate, precision: null, model: null, basis: null }
}

export type ReviewCalibrationFleetCell = {
  lens: string
  agent: string
  model: string | null
  n: number
  precision: number | null
  basis: 'model' | 'aggregate' | null
  last_graded_at: string | null
}

export function reviewCalibrationFleet(database: Database = db()): ReviewCalibrationFleetCell[] {
  const identities = database
    .query(`SELECT DISTINCT lens, agent FROM review_lens ORDER BY lens, agent`)
    .all() as { lens: string; agent: string }[]
  const lenses = [...new Set(identities.map((row) => row.lens))]
  const agents = [...new Set(identities.map((row) => row.agent))]
  const graded = database
    .query(
      `SELECT rl.lens, rl.agent, rl.model, MAX(s.scored_at) AS last_graded_at
       FROM review_lens rl JOIN review r ON r.id=rl.review_id
       LEFT JOIN score s ON s.run_id=rl.run_id
      WHERE r.completed_at IS NOT NULL
        AND (rl.reproduced IS NOT NULL OR rl.coverage IS NOT NULL OR rl.limits IS NOT NULL OR rl.overlap IS NOT NULL)
      GROUP BY rl.lens, rl.agent, rl.model ORDER BY rl.lens, rl.agent, rl.model`,
    )
    .all() as { lens: string; agent: string; model: string | null; last_graded_at: string | null }[]
  const pairHasGrade = new Set(graded.map((row) => `${row.lens}\0${row.agent}`))
  const pairLastGraded = new Map<string, string | null>()
  for (const row of graded) {
    const key = `${row.lens}\0${row.agent}`
    const prior = pairLastGraded.get(key)
    if (row.last_graded_at && (!prior || row.last_graded_at > prior))
      pairLastGraded.set(key, row.last_graded_at)
  }
  const cells = new Map<string, ReviewCalibrationFleetCell>()
  for (const row of graded) {
    if (row.model === null) {
      const aggregate = calibrationCell(row.lens, row.agent, undefined, database)
      cells.set(`${row.lens}\0${row.agent}\0`, {
        lens: row.lens,
        agent: row.agent,
        model: null,
        n: aggregate.triaged,
        precision: aggregate.precision,
        basis: 'aggregate',
        last_graded_at: pairLastGraded.get(`${row.lens}\0${row.agent}`) ?? null,
      })
      continue
    }
    const specific = calibrationCell(row.lens, row.agent, row.model, database)
    cells.set(`${row.lens}\0${row.agent}\0${row.model}`, {
      lens: row.lens,
      agent: row.agent,
      model: row.model,
      n: specific.triaged,
      precision: specific.precision,
      basis: 'model',
      last_graded_at: row.last_graded_at,
    })
    if (specific.triaged < MIN_REVIEW_TRIAGED) {
      const aggregate = calibrationCell(row.lens, row.agent, undefined, database)
      if (aggregate.triaged >= MIN_REVIEW_TRIAGED) {
        cells.set(`${row.lens}\0${row.agent}\0`, {
          lens: row.lens,
          agent: row.agent,
          model: null,
          n: aggregate.triaged,
          precision: aggregate.precision,
          basis: 'aggregate',
          last_graded_at: pairLastGraded.get(`${row.lens}\0${row.agent}`) ?? null,
        })
      }
    }
  }
  for (const lens of lenses)
    for (const agent of agents) {
      if (!pairHasGrade.has(`${lens}\0${agent}`)) {
        cells.set(`${lens}\0${agent}\0`, {
          lens,
          agent,
          model: null,
          n: 0,
          precision: null,
          basis: null,
          last_graded_at: null,
        })
      }
    }
  return [...cells.values()].sort(
    (a, b) =>
      a.lens.localeCompare(b.lens) ||
      a.agent.localeCompare(b.agent) ||
      String(a.model).localeCompare(String(b.model)),
  )
}

export function calibrationLine(calibration: ReviewCalibration): string {
  const gradeSummary = (
    name: keyof Pick<ReviewCalibration, 'reproduced' | 'coverage' | 'limits' | 'overlap'>,
  ) => {
    const distribution = calibration[name]
    const counts = Object.entries(distribution.counts)
      .map(([value, count]) => `${value} ${count}`)
      .join(', ')
    return `${name}: ${counts}; ungraded ${distribution.ungraded}`
  }
  const severity = ` Severity agreement: agreed ${calibration.severity.counts.agreed}, changed ${calibration.severity.counts.changed}, not-comparable ${calibration.severity.counts.not_comparable}, not-assessed ${calibration.severity.counts.not_assessed}.`
  const mirror = ` MIRROR lenses: ${calibration.mirror_lenses}.`
  const grades = `${mirror} Review grades: ${gradeSummary('reproduced')}; ${gradeSummary('coverage')}; ${gradeSummary('limits')}; ${gradeSummary('overlap')}.${severity}`
  if (calibration.precision === null) {
    return `Reviewer calibration: no reliable precision yet for lens ${calibration.lens} on agent ${calibration.agent}.${grades}`
  }
  const rejected = calibration.rejection_categories.length
    ? ` Frequent rejection categories: ${calibration.rejection_categories.map((x) => `${x.category} (${x.count})`).join(', ')}.`
    : ''
  const scope = calibration.basis === 'model' ? `model ${calibration.model}` : 'all models'
  return `Reviewer calibration: lens ${calibration.lens} on agent ${calibration.agent} (${scope}) has precision ${calibration.precision.toFixed(2)} over ${calibration.triaged} triaged findings.${rejected}${grades}`
}

/** Reserved during routing so argv eligibility remains true after calibration is appended. */
export const CALIBRATION_SUFFIX_RESERVE_BYTES = 1024
