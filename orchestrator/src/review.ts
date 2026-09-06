import type { Database } from 'bun:sqlite'
import {
  db, nowIso, REVIEW_REPRODUCED, REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP,
  REVIEW_SEVERITY,
  type ReviewReproduced, type ReviewCoverage, type ReviewLimits, type ReviewOverlap,
  type ReviewSeverity,
} from './db.ts'
import { CANON_SOURCE_SCHEMA, REVIEW_SCHEMA, type CanonSource, type ReviewReply } from './contract.ts'
import { job } from './jobs.ts'
import { classifyReviewTier, diffNumstat, type ReviewTier } from './review-tier.ts'

export const REVIEW_WINDOW = 50
/**
 * Initial safety floor. Re-set this from the observed triage distribution once
 * this repository has enough review data; until then the conservative value
 * prevents a handful of findings from changing reviewer behaviour.
 */
export const MIN_REVIEW_TRIAGED = 10

export const DISPOSITIONS = ['accepted', 'modified', 'rejected', 'skipped'] as const
export type Disposition = typeof DISPOSITIONS[number]

export type ReviewGrades = {
  reproduced: ReviewReproduced
  coverage: ReviewCoverage
  limits: ReviewLimits
  overlap: ReviewOverlap
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')
const isCanonSource = (v: unknown): v is CanonSource =>
  typeof v === 'string' && (CANON_SOURCE_SCHEMA.enum as readonly string[]).includes(v)
const exactKeys = (value: object, expected: string[]) => {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, i) => key === [...expected].sort()[i])
}

export function parseReviewReply(value: unknown): ReviewReply | null {
  const v = value as Partial<ReviewReply> | null
  if (!v || typeof v !== 'object' || Array.isArray(v) || !exactKeys(v, ['findings', 'provenance']) ||
      !Array.isArray(v.findings)) return null
  const p = v.provenance
  const provenanceKeys = [
    'standards_read', 'model_used', 'files_covered', 'commands_run',
    'could_not_verify', 'canon_source',
  ]
  if (!p || typeof p !== 'object' || Array.isArray(p) ||
      !(exactKeys(p, provenanceKeys) || exactKeys(p, ['tree_inspected', ...provenanceKeys])) ||
      (p.tree_inspected !== undefined && p.tree_inspected !== null &&
        typeof p.tree_inspected !== 'string') ||
      typeof p.model_used !== 'string' ||
      !isStrings(p.standards_read) || !isStrings(p.files_covered) ||
      !isStrings(p.commands_run) || !isStrings(p.could_not_verify) ||
      !isCanonSource(p.canon_source)) return null
  if (!v.findings.every((f) => f && typeof f === 'object' && !Array.isArray(f) &&
      exactKeys(f, ['severity', 'location', 'evidence', 'proposed_correction']) &&
      typeof f.severity === 'string' && typeof f.location === 'string' &&
      typeof f.evidence === 'string' && typeof f.proposed_correction === 'string')) return null
  if (p.tree_inspected === null) delete (p as Record<string, unknown>).tree_inspected
  return v as ReviewReply
}

export function parseReviewOutput(text: string): ReviewReply | null {
  const candidates = [text.trim(), ...(text.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? [])
    .map((x) => x.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim())]
  for (const candidate of candidates) {
    try {
      const parsed = parseReviewReply(JSON.parse(candidate))
      if (parsed) return parsed
    } catch { /* try an embedded object */ }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return parseReviewReply(JSON.parse(text.slice(start, end + 1))) } catch { /* invalid */ }
  }
  return null
}

type RunRow = {
  id: number; agent: string; model: string | null; lens: string | null
  job: string; status: string; output_path: string | null; input_tree: string | null
  head_commit: string | null; repo: string | null
  base_commit: string | null
}

function tierForRuns(runs: RunRow[], database: Database): ReviewTier | null {
  const bases = new Map(runs.map((run) => [run.id, run.base_commit]))
  const trees = new Map(runs.map((run) => [run.id, run.input_tree]))
  const distinctBases = new Set(bases.values())
  const distinctTrees = new Set(trees.values())
  const differ = (values: Map<number, string | null>) => [...values].map(([id, value]) =>
    `run ${id}=${value ?? 'NULL'}`).join(', ')
  if (distinctBases.size !== 1 || distinctTrees.size !== 1) {
    console.error(`warning: review tier not recorded: lens runs differ (${differ(bases)}; ${differ(trees)})`)
    return null
  }
  try {
    for (const run of runs) {
      if (!run.base_commit || !run.input_tree || !run.head_commit || !run.repo) {
        throw new Error(`run ${run.id} lacks base_commit, input_tree, head_commit, or repo`)
      }
      const repo = projectPath(database, run.repo)
      if (!repo) throw new Error(`run ${run.id} project ${run.repo} is not registered`)
      const base = git(repo, ['cat-file', '-e', `${run.base_commit}^{commit}`])
      if (!base.ok) throw new Error(`run ${run.id} base ${run.base_commit} cannot be resolved`)
      const actualTree = git(repo, ['rev-parse', `${run.head_commit}^{tree}`])
      if (!actualTree.ok || actualTree.out !== run.input_tree) {
        throw new Error(`run ${run.id} reviewed tree ${run.input_tree} cannot be resolved from ${run.head_commit}`)
      }
    }
    const run = runs[0]!
    const repo = projectPath(database, run.repo!)
    return classifyReviewTier({ files: diffNumstat(repo!, run.base_commit!, run.head_commit!) })
  } catch (cause) {
    console.error(`warning: review tier not recorded: ${String((cause as Error)?.message ?? cause)}`)
    return null
  }
}

const pinRef = (runId: number) => `refs/orch/reviewed/${runId}`

function git(repo: string, args: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(['git', ...args], {
    cwd: repo, env: process.env, stdout: 'pipe', stderr: 'pipe',
  })
  return {
    ok: p.exitCode === 0,
    out: p.stdout.toString().trim(),
    err: p.stderr.toString().trim() || `exit ${p.exitCode}`,
  }
}

function projectPath(database: Database, name: string): string | null {
  return (database.query('SELECT path FROM project WHERE name=?').get(name) as
    { path: string } | null)?.path ?? null
}

function pinReviewedCommits(runs: RunRow[], database: Database): void {
  for (const run of runs) {
    if (!run.head_commit) continue
    const warn = (why: string) => {
      console.error(
        `warning: review run ${run.id} recorded but ${pinRef(run.id)} was not created: ` +
        why,
      )
    }
    try {
      const repo = run.repo ? projectPath(database, run.repo) : null
      if (!repo) {
        warn(`project ${run.repo ?? '(none)'} is not registered`)
        continue
      }
      if (!git(repo, ['cat-file', '-e', `${run.head_commit}^{commit}`]).ok) {
        warn(`commit ${run.head_commit} is missing from ${repo}`)
        continue
      }
      const updated = git(repo, ['update-ref', pinRef(run.id), run.head_commit])
      if (!updated.ok) warn(`git update-ref failed: ${updated.err}`)
    } catch (cause) {
      warn(String((cause as Error)?.message ?? cause))
    }
  }
}

export function recordReviews(
  entries: { runId: number; output: ReviewReply }[], database: Database = db(),
): number {
  if (!entries.length) throw new Error('a review requires at least one lens run')
  const runs = entries.map(({ runId }) => {
    const run = database.query(
      `SELECT id, agent, model, lens, job, status, output_path, input_tree, head_commit, repo, base_commit
         FROM run WHERE id=?`,
    ).get(runId) as RunRow | null
    if (!run) throw new Error(`no run ${runId}`)
    if (!job(run.job).findings) throw new Error(`run ${runId} job ${run.job} does not produce review findings`)
    if (!run.lens) throw new Error(`run ${runId} has no lens identity`)
    if (!run.model) throw new Error(`run ${runId} has no effective model recorded`)
    if (run.status !== 'ok') throw new Error(`run ${runId} is ${run.status}, not a completed review run`)
    const existing = database.query('SELECT review_id FROM review_lens WHERE run_id=?').get(runId) as
      { review_id: number } | null
    if (existing) throw new Error(`run ${runId} is already recorded in review ${existing.review_id}`)
    return run
  })
  const measuredTrees = runs.filter((run) => run.input_tree !== null)
  const distinctTrees = new Set(measuredTrees.map((run) => run.input_tree))
  if (distinctTrees.size > 1) {
    throw new Error(
      `review lens runs measured different trees:\n${runs.map((run) =>
        `run ${run.id}: ${run.input_tree ?? 'NULL'}`).join('\n')}`,
    )
  }
  const transaction = database.transaction(() => {
    const tier = tierForRuns(runs, database)
    const review = database.query(
      `INSERT INTO review (recorded_at, tier, tier_risk, tier_size, tier_reasons)
       VALUES (?,?,?,?,?) RETURNING id`,
    ).get(nowIso(), tier?.tier ?? null, tier?.risk ?? null, tier?.size ?? null,
      tier ? JSON.stringify(tier.reasons) : null) as { id: number }
    const insertLens = database.query(
      `INSERT INTO review_lens
         (review_id, run_id, lens, agent, model, tree_inspected, reviewed_tree, standards_read,
          files_covered, commands_run, could_not_verify)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    )
    const insert = database.query(
      `INSERT INTO review_finding
         (review_id, review_lens_id, ordinal, severity, location, evidence, proposed_correction)
       VALUES (?,?,?,?,?,?,?)`,
    )
    let ordinal = 0
    entries.forEach(({ output }, index) => {
      const run = runs[index]!
      const lens = insertLens.get(review.id, run.id, run.lens, run.agent, run.model,
        output.provenance.tree_inspected ?? null, run.input_tree,
        JSON.stringify(output.provenance.standards_read),
        JSON.stringify(output.provenance.files_covered), JSON.stringify(output.provenance.commands_run),
        JSON.stringify(output.provenance.could_not_verify)) as { id: number }
      output.findings.forEach((finding) => insert.run(
        review.id, lens.id, ++ordinal, finding.severity, finding.location, finding.evidence,
        finding.proposed_correction,
      ))
    })
    return review.id
  })
  const reviewId = transaction()
  pinReviewedCommits(runs, database)
  return reviewId
}

export type ReviewPin = {
  project: string
  runId: number
  reviewId: number
  commit: string
  completed: boolean
  superseded: boolean
  landed: boolean
  deleted: boolean
}

/** Inspect keepalive refs; pruning is an explicit act and never part of cleanup. */
export function reviewPins(prune = false, database: Database = db()): ReviewPin[] {
  const registered = new Map((database.query(
    'SELECT name, path, settings FROM project',
  ).all() as { name: string; path: string; settings: string }[]).map((project) => {
    let settings: Record<string, unknown> = {}
    try { settings = JSON.parse(project.settings) } catch { /* unreadable settings have no trunk */ }
    return [project.name, { path: project.path, settings }] as const
  }))
  const rows = database.query(
    `SELECT run.repo, run.branch, run.id AS run_id, rl.review_id, r.completed_at
       FROM review_lens rl
       JOIN review r ON r.id=rl.review_id
       JOIN run ON run.id=rl.run_id
      WHERE run.head_commit IS NOT NULL
      ORDER BY run.repo, run.id`,
  ).all() as {
    repo: string | null; branch: string | null; run_id: number
    review_id: number; completed_at: string | null
  }[]
  const pins: ReviewPin[] = []
  for (const row of rows) {
    if (!row.repo) continue
    const project = registered.get(row.repo)
    if (!project) continue
    const ref = git(project.path, ['rev-parse', '--verify', pinRef(row.run_id)])
    if (!ref.ok) continue
    const superseded = Boolean(database.query(
      `SELECT 1
         FROM review_lens newer_lens
         JOIN review newer ON newer.id=newer_lens.review_id
         JOIN run newer_run ON newer_run.id=newer_lens.run_id
        WHERE newer.id>? AND newer_run.repo=? AND newer_run.branch IS ?
        LIMIT 1`,
    ).get(row.review_id, row.repo, row.branch))
    const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
    const landed = Boolean(row.branch && trunk &&
      git(project.path, ['show-ref', '--verify', '--quiet', `refs/heads/${row.branch}`]).ok &&
      git(project.path, [
        'merge-base', '--is-ancestor', `refs/heads/${row.branch}`, `refs/heads/${trunk}`,
      ]).ok)
    let deleted = false
    if (prune && row.completed_at !== null && landed) {
      const removal = git(project.path, ['update-ref', '-d', pinRef(row.run_id)])
      if (!removal.ok) throw new Error(`git update-ref -d ${pinRef(row.run_id)} failed: ${removal.err}`)
      deleted = true
    }
    pins.push({
      project: row.repo, runId: row.run_id, reviewId: row.review_id, commit: ref.out,
      completed: row.completed_at !== null, superseded, landed, deleted,
    })
  }
  return pins
}

export function recordReview(runId: number, output: ReviewReply, database: Database = db()): number {
  return recordReviews([{ runId, output }], database)
}

export function gradeReviewLens(
  runId: number, output: ReviewReply | null, grades: ReviewGrades, database: Database = db(),
): number {
  let row = database.query('SELECT id, review_id FROM review_lens WHERE run_id=?').get(runId) as
    { id: number; review_id: number } | null
  if (!row) {
    if (!output) throw new Error(`run ${runId} has no review output to record`)
    // The scoring path records through recordReview so it shares the same
    // best-effort commit pinning as `orch review record`.
    const reviewId = recordReview(runId, output, database)
    row = database.query('SELECT id, review_id FROM review_lens WHERE run_id=?').get(runId) as
      { id: number; review_id: number }
    if (row.review_id !== reviewId) throw new Error(`run ${runId} review capture did not persist`)
  }
  database.query(
    `UPDATE review_lens SET reproduced=?, coverage=?, limits=?, overlap=? WHERE id=?`,
  ).run(grades.reproduced, grades.coverage, grades.limits, grades.overlap, row.id)
  return row.review_id
}

export function triageFinding(
  reviewId: number, ordinal: number, disposition: Disposition,
  rejectionCategory?: string, triagedSeverity?: string, database: Database = db(),
): void {
  if (!DISPOSITIONS.includes(disposition)) throw new Error(`invalid disposition: ${disposition}`)
  if (disposition === 'rejected' && !rejectionCategory?.trim()) {
    throw new Error('a rejected finding requires --category')
  }
  if (rejectionCategory && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(rejectionCategory)) {
    throw new Error('rejection category must be a lowercase stable id of at most 64 characters')
  }
  const review = database.query('SELECT completed_at FROM review WHERE id=?').get(reviewId) as
    { completed_at: string | null } | null
  if (!review) throw new Error(`no review ${reviewId}`)
  if (review.completed_at) throw new Error(`review ${reviewId} is already complete`)
  const finding = database.query(
    'SELECT severity FROM review_finding WHERE review_id=? AND ordinal=?',
  ).get(reviewId, ordinal) as { severity: string } | null
  if (!finding) throw new Error(`review ${reviewId} has no finding ${ordinal}`)
  const severity = triagedSeverity?.trim()
  if (severity && !REVIEW_SEVERITY.includes(severity as ReviewSeverity)) {
    throw new Error(`severity must be: ${REVIEW_SEVERITY.join(' | ')}`)
  }
  const result = database.query(
    `UPDATE review_finding SET disposition=?, rejection_category=?, triaged_severity=?, triaged_at=?
       WHERE review_id=? AND ordinal=?`,
  ).run(disposition, disposition === 'rejected' ? rejectionCategory!.trim() : null,
    severity ?? null,
    nowIso(), reviewId, ordinal)
  if (result.changes !== 1) throw new Error(`review ${reviewId} has no finding ${ordinal}`)
}

export function completeReview(reviewId: number, database: Database = db()): void {
  const row = database.query(
    `SELECT COUNT(*) AS findings,
            SUM(CASE WHEN disposition IS NULL THEN 1 ELSE 0 END) AS untriaged
       FROM review_finding WHERE review_id=?`,
  ).get(reviewId) as { findings: number; untriaged: number | null }
  const review = database.query('SELECT id FROM review WHERE id=?').get(reviewId)
  if (!review) throw new Error(`no review ${reviewId}`)
  if ((row.untriaged ?? 0) > 0) throw new Error(`review ${reviewId} still has ${row.untriaged} untriaged findings`)
  database.query('UPDATE review SET completed_at=? WHERE id=?').run(nowIso(), reviewId)
}

export type ReviewCalibration = {
  lens: string; agent: string; model: string | null; precision: number | null
  hits: number; triaged: number; rejection_categories: { category: string; count: number }[]
  basis: 'model' | 'agent' | null
  reproduced: GradeDistribution<ReviewReproduced>
  coverage: GradeDistribution<ReviewCoverage>
  limits: GradeDistribution<ReviewLimits>
  overlap: GradeDistribution<ReviewOverlap>
  severity: SeverityAgreement
  tiers: Record<'0' | '1' | '2' | '3' | 'unclassified', TierCalibration>
}

export type TierCalibration = {
  reviews: number; lenses: number; findings_accepted: number; findings_rejected: number
}

export type GradeDistribution<T extends string> = {
  counts: Record<T, number>
  shares: Record<T, number | null>
  ungraded: number
}

export type SeverityAgreement = {
  counts: { agreed: number; changed: number; not_comparable: number; not_assessed: number }
  shares: { agreed: number | null; changed: number | null; not_comparable: number | null; not_assessed: number | null }
}

function gradeDistribution<T extends string>(
  rows: Record<string, unknown>[], column: string, values: readonly T[],
): GradeDistribution<T> {
  const counts = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>
  let ungraded = 0
  for (const row of rows) {
    const value = row[column]
    if (typeof value === 'string' && values.includes(value as T)) counts[value as T]++
    else ungraded++
  }
  const graded = rows.length - ungraded
  const shares = Object.fromEntries(values.map((value) => [
    value, graded > 0 ? counts[value] / graded : null,
  ])) as Record<T, number | null>
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
  lens: string, agent: string, model: string | null | undefined, database: Database,
): Omit<ReviewCalibration, 'basis'> {
  const modelClause = model === undefined ? '' : 'AND rl.model IS ?'
  const reviews = database.query(
    `SELECT DISTINCT r.id FROM review r JOIN review_lens rl ON rl.review_id=r.id
      WHERE rl.lens=? AND rl.agent=? AND r.completed_at IS NOT NULL ${modelClause}
      ORDER BY r.completed_at DESC, r.id DESC LIMIT ?`,
  ).all(...(model === undefined ? [lens, agent, REVIEW_WINDOW] : [lens, agent, model, REVIEW_WINDOW])) as { id: number }[]
  const emptyTiers = () => Object.fromEntries(['0', '1', '2', '3', 'unclassified'].map((key) =>
    [key, { reviews: 0, lenses: 0, findings_accepted: 0, findings_rejected: 0 }])) as ReviewCalibration['tiers']
  const emptyGrades = () => ({
    reproduced: gradeDistribution([], 'reproduced', REVIEW_REPRODUCED),
    coverage: gradeDistribution([], 'coverage', REVIEW_COVERAGE),
    limits: gradeDistribution([], 'limits', REVIEW_LIMITS),
    overlap: gradeDistribution([], 'overlap', REVIEW_OVERLAP),
    severity: severityAgreement([]),
    tiers: emptyTiers(),
  })
  if (!reviews.length) return { lens, agent, model: model ?? null, precision: null, hits: 0, triaged: 0, rejection_categories: [], ...emptyGrades() }
  const ids = reviews.map((r) => r.id)
  const marks = ids.map(() => '?').join(',')
  const counts = database.query(
    `SELECT
       SUM(CASE WHEN disposition IN ('accepted','modified') THEN 1 ELSE 0 END) AS hits,
       SUM(CASE WHEN disposition IN ('accepted','modified','rejected') THEN 1 ELSE 0 END) AS triaged
     FROM review_finding rf JOIN review_lens rl ON rl.id=rf.review_lens_id
     WHERE rf.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}`,
  ).get(...ids, lens, agent, ...(model === undefined ? [] : [model])) as { hits: number | null; triaged: number | null }
  const categories = database.query(
    `SELECT rejection_category AS category, COUNT(*) AS count
       FROM review_finding rf JOIN review_lens rl ON rl.id=rf.review_lens_id
      WHERE rf.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}
        AND disposition='rejected' AND rejection_category IS NOT NULL
      GROUP BY rejection_category ORDER BY count DESC, category LIMIT 3`,
  ).all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as { category: string; count: number }[]
  const triaged = counts.triaged ?? 0
  const hits = counts.hits ?? 0
  const gradeRows = database.query(
    `SELECT reproduced, coverage, limits, overlap FROM review_lens rl
      WHERE rl.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}`,
  ).all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as Record<string, unknown>[]
  const severityRows = database.query(
    `SELECT rf.severity, rf.triaged_severity FROM review_finding rf
      JOIN review_lens rl ON rl.id=rf.review_lens_id
      WHERE rf.review_id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}
        AND rf.disposition IS NOT NULL`,
  ).all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as
    { severity: string; triaged_severity: string | null }[]
  const tierRows = database.query(
    `SELECT r.id AS review_id, r.tier, rl.id AS lens_id, rf.disposition
       FROM review r JOIN review_lens rl ON rl.review_id=r.id
       LEFT JOIN review_finding rf ON rf.review_lens_id=rl.id
      WHERE r.id IN (${marks}) AND rl.lens=? AND rl.agent=? ${modelClause}`,
  ).all(...ids, lens, agent, ...(model === undefined ? [] : [model])) as
    { review_id: number; tier: number | null; lens_id: number; disposition: string | null }[]
  const tiers = emptyTiers()
  const tierReviews = new Map<string, Set<number>>()
  const tierLenses = new Map<string, Set<number>>()
  for (const row of tierRows) {
    const key = row.tier === null ? 'unclassified' : String(row.tier)
    const cell = tiers[key as keyof typeof tiers]
    if (!cell) continue
    const reviews = tierReviews.get(key) ?? new Set<number>()
    const lenses = tierLenses.get(key) ?? new Set<number>()
    reviews.add(row.review_id); lenses.add(row.lens_id)
    tierReviews.set(key, reviews); tierLenses.set(key, lenses)
    if (row.disposition === 'accepted') cell.findings_accepted++
    if (row.disposition === 'rejected') cell.findings_rejected++
  }
  for (const [key, cell] of Object.entries(tiers)) {
    cell.reviews = tierReviews.get(key)?.size ?? 0
    cell.lenses = tierLenses.get(key)?.size ?? 0
  }
  return { lens, agent, model: model ?? null,
    precision: triaged >= MIN_REVIEW_TRIAGED ? hits / triaged : null,
    hits, triaged, rejection_categories: categories,
    reproduced: gradeDistribution(gradeRows, 'reproduced', REVIEW_REPRODUCED),
    coverage: gradeDistribution(gradeRows, 'coverage', REVIEW_COVERAGE),
    limits: gradeDistribution(gradeRows, 'limits', REVIEW_LIMITS),
    overlap: gradeDistribution(gradeRows, 'overlap', REVIEW_OVERLAP),
    severity: severityAgreement(severityRows),
    tiers,
  }
}

export function reviewCalibration(
  lens: string, agent: string, model: string, database: Database = db(),
): ReviewCalibration {
  const specific = calibrationCell(lens, agent, model, database)
  if (specific.triaged >= MIN_REVIEW_TRIAGED) return { ...specific, basis: 'model' }
  const aggregate = calibrationCell(lens, agent, undefined, database)
  if (aggregate.triaged >= MIN_REVIEW_TRIAGED) return { ...aggregate, model: null, basis: 'agent' }
  return { ...aggregate, precision: null, model: null, basis: null }
}

export function calibrationLine(calibration: ReviewCalibration): string {
  const gradeSummary = (name: keyof Pick<ReviewCalibration, 'reproduced' | 'coverage' | 'limits' | 'overlap'>) => {
    const distribution = calibration[name]
    const counts = Object.entries(distribution.counts).map(([value, count]) => `${value} ${count}`).join(', ')
    return `${name}: ${counts}; ungraded ${distribution.ungraded}`
  }
  const severity = ` Severity agreement: agreed ${calibration.severity.counts.agreed}, changed ${calibration.severity.counts.changed}, not-comparable ${calibration.severity.counts.not_comparable}, not-assessed ${calibration.severity.counts.not_assessed}.`
  const grades = ` Review grades: ${gradeSummary('reproduced')}; ${gradeSummary('coverage')}; ${gradeSummary('limits')}; ${gradeSummary('overlap')}.${severity}`
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

export { REVIEW_SCHEMA }
