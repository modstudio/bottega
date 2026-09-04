import type { Database } from 'bun:sqlite'
import { db, nowIso } from './db.ts'
import { CANON_SOURCE_SCHEMA, REVIEW_SCHEMA, type CanonSource, type ReviewReply } from './contract.ts'
import { job } from './jobs.ts'

export const REVIEW_WINDOW = 50
/**
 * Initial safety floor. Re-set this from the observed triage distribution once
 * this repository has enough review data; until then the conservative value
 * prevents a handful of findings from changing reviewer behaviour.
 */
export const MIN_REVIEW_TRIAGED = 10

export const DISPOSITIONS = ['accepted', 'modified', 'rejected', 'skipped'] as const
export type Disposition = typeof DISPOSITIONS[number]

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
  if (!p || typeof p !== 'object' || Array.isArray(p) || !exactKeys(p, [
    'tree_inspected', 'standards_read', 'model_used', 'files_covered', 'commands_run',
    'could_not_verify', 'canon_source',
  ]) ||
      typeof p.tree_inspected !== 'string' || typeof p.model_used !== 'string' ||
      !isStrings(p.standards_read) || !isStrings(p.files_covered) ||
      !isStrings(p.commands_run) || !isStrings(p.could_not_verify) ||
      !isCanonSource(p.canon_source)) return null
  if (!v.findings.every((f) => f && typeof f === 'object' && !Array.isArray(f) &&
      exactKeys(f, ['severity', 'location', 'evidence', 'proposed_correction']) &&
      typeof f.severity === 'string' && typeof f.location === 'string' &&
      typeof f.evidence === 'string' && typeof f.proposed_correction === 'string')) return null
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
  job: string; status: string; output_path: string | null
}

export function recordReviews(
  entries: { runId: number; output: ReviewReply }[], database: Database = db(),
): number {
  if (!entries.length) throw new Error('a review requires at least one lens run')
  const runs = entries.map(({ runId }) => {
    const run = database.query(
      'SELECT id, agent, model, lens, job, status, output_path FROM run WHERE id=?',
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
  const transaction = database.transaction(() => {
    const review = database.query('INSERT INTO review (recorded_at) VALUES (?) RETURNING id')
      .get(nowIso()) as { id: number }
    const insertLens = database.query(
      `INSERT INTO review_lens
         (review_id, run_id, lens, agent, model, tree_inspected, standards_read,
          files_covered, commands_run, could_not_verify)
       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
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
        output.provenance.tree_inspected, JSON.stringify(output.provenance.standards_read),
        JSON.stringify(output.provenance.files_covered), JSON.stringify(output.provenance.commands_run),
        JSON.stringify(output.provenance.could_not_verify)) as { id: number }
      output.findings.forEach((finding) => insert.run(
        review.id, lens.id, ++ordinal, finding.severity, finding.location, finding.evidence,
        finding.proposed_correction,
      ))
    })
    return review.id
  })
  return transaction()
}

export function recordReview(runId: number, output: ReviewReply, database: Database = db()): number {
  return recordReviews([{ runId, output }], database)
}

export function triageFinding(
  reviewId: number, ordinal: number, disposition: Disposition,
  rejectionCategory?: string, database: Database = db(),
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
  const result = database.query(
    `UPDATE review_finding SET disposition=?, rejection_category=?, triaged_at=?
       WHERE review_id=? AND ordinal=?`,
  ).run(disposition, disposition === 'rejected' ? rejectionCategory!.trim() : null,
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
  if (!reviews.length) return { lens, agent, model: model ?? null, precision: null, hits: 0, triaged: 0, rejection_categories: [] }
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
  return { lens, agent, model: model ?? null,
    precision: triaged >= MIN_REVIEW_TRIAGED ? hits / triaged : null,
    hits, triaged, rejection_categories: categories }
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
  if (calibration.precision === null) {
    return `Reviewer calibration: no reliable precision yet for lens ${calibration.lens} on agent ${calibration.agent}.`
  }
  const rejected = calibration.rejection_categories.length
    ? ` Frequent rejection categories: ${calibration.rejection_categories.map((x) => `${x.category} (${x.count})`).join(', ')}.`
    : ''
  const scope = calibration.basis === 'model' ? `model ${calibration.model}` : 'all models'
  return `Reviewer calibration: lens ${calibration.lens} on agent ${calibration.agent} (${scope}) has precision ${calibration.precision.toFixed(2)} over ${calibration.triaged} triaged findings.${rejected}`
}

/** Reserved during routing so argv eligibility remains true after calibration is appended. */
export const CALIBRATION_SUFFIX_RESERVE_BYTES = 1024

export { REVIEW_SCHEMA }
