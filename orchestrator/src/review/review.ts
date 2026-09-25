// concern: review
import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { ReviewReply } from '../contract/contract.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { enqueueReview } from './review-outbox.ts'

export { parseReviewOutput, parseReviewReply } from '../contract/contract.ts'

import { job } from '../jobs/jobs.ts'
import { currentCoverage, projectRecord } from './review-coverage.ts'
import { filesCoveredIntersectChanged } from './review-coverage-match.ts'
import { measureReviewChange, serializePathSet } from './review-group.ts'
import {
  git,
  measureChangeIdentity,
  pinRef,
  pinReviewedCommits,
  projectPath,
  reviewChangeRange,
  storedChangePathSet,
} from './review-pins.ts'
import type { ReviewListFilter, ReviewListRow, ReviewReadLens, RunRow } from './review-types.ts'

export const UNEVIDENCED_REVIEW_ERROR =
  'clean review with no evidence: files_covered and commands_run are empty'

export type CleanReviewEvidence =
  | { failure: string; note: null; kind: 'unevidenced' | 'harness' }
  | { failure: null; note: string | null }

export function normalizeCoveredPath(path: string): string {
  const repositoryPath = path
    .trim()
    .replace(/\s+(?:\u2014|-)\s+.+$/, '')
    .trimEnd()
    .replace(/:\d+(?:-\d+)?$/, '')
  return repositoryPath.trim().replace(/^\.\//, '')
}

/** Classify the evidence on a findings:[] reply against the recorded change path set. */
export function cleanReviewEvidence(
  runId: number,
  output: ReviewReply,
  database: Database = db(),
): CleanReviewEvidence {
  const provenance = output.provenance
  provenance.files_covered = provenance.files_covered.map(normalizeCoveredPath)
  if (output.findings.length) return { failure: null, note: null }
  if (!provenance.files_covered.length && !provenance.commands_run.length) {
    return { failure: UNEVIDENCED_REVIEW_ERROR, note: null, kind: 'unevidenced' }
  }
  const unavailable = (why: string): CleanReviewEvidence => ({
    failure: `clean review changed-path coverage not checked: ${why}`,
    note: null,
    kind: 'harness',
  })
  let changed: string[]
  try {
    const stored = storedChangePathSet(runId, database)
    if (stored) changed = stored
    else {
      const run = database
        .query(
          'SELECT repo, base_commit, input_tree, head_commit, review_ref, changed_paths FROM run WHERE id=?',
        )
        .get(runId) as
        | (Pick<
            RunRow,
            'base_commit' | 'input_tree' | 'head_commit' | 'review_ref' | 'changed_paths'
          > & { repo: string | null })
        | null
      const range = run ? reviewChangeRange(run) : null
      if (!run?.repo || !range) {
        return unavailable('run lacks repo, base_commit, or input_tree')
      }
      if (range.paths !== null) {
        changed = range.paths
      } else {
        const repo = projectPath(database, run.repo)
        if (!repo) return unavailable(`project ${run.repo} is not registered`)
        const identity = measureChangeIdentity(repo, range.from, range.to)
        if (!identity) return unavailable('git diff --name-only failed')
        changed = identity.paths
      }
    }
  } catch (cause) {
    return unavailable(String((cause as Error)?.message ?? cause))
  }
  if (!changed.length) return unavailable('changed-path set is empty')
  const intersects = filesCoveredIntersectChanged(changed, provenance.files_covered)
  if (!intersects) {
    return {
      failure: 'clean review with no evidence: files_covered intersects none of the changed paths',
      note: null,
      kind: 'unevidenced',
    }
  }
  return { failure: null, note: null }
}

function reviewReadLenses(reviewId: number, database: Database): ReviewReadLens[] {
  return (
    database
      .query(
        `SELECT rl.id, rl.lens, rl.run_id, rl.agent, rl.model, rl.tree_inspected, rl.reviewed_tree,
            rl.reproduced, rl.coverage, rl.limits, rl.overlap,
            run.input_tree, run.branch, run.base_commit, run.launch_cwd, run.head_commit
       FROM review_lens rl JOIN run ON run.id=rl.run_id
      WHERE rl.review_id=? ORDER BY rl.id`,
      )
      .all(reviewId) as {
      id: number
      lens: string
      run_id: number
      agent: string
      model: string | null
      tree_inspected: string | null
      reviewed_tree: string | null
      input_tree: string | null
      branch: string | null
      base_commit: string | null
      launch_cwd: string | null
      head_commit: string | null
      reproduced: ReviewReadLens['reproduced']
      coverage: ReviewReadLens['coverageGrade']
      limits: ReviewReadLens['limits']
      overlap: ReviewReadLens['overlap']
    }[]
  ).map((row) => ({
    id: row.id,
    lens: row.lens,
    runId: row.run_id,
    agent: row.agent,
    model: row.model,
    treeInspected: row.tree_inspected,
    tree: row.reviewed_tree,
    inputTree: row.input_tree,
    branch: row.branch,
    baseCommit: row.base_commit,
    launchCwd: row.launch_cwd,
    headCommit: row.head_commit,
    reviewRef: pinRef(row.run_id),
    reproduced: row.reproduced,
    coverageGrade: row.coverage,
    limits: row.limits,
    overlap: row.overlap,
  }))
}

export function listReviews(
  filter: ReviewListFilter = {},
  database: Database = db(),
): ReviewListRow[] {
  const where: string[] = []
  const params: SQLQueryBindings[] = []
  if (filter.state === 'open')
    where.push(
      '(r.completed_at IS NULL OR EXISTS (SELECT 1 FROM review_finding open_f WHERE open_f.review_id=r.id AND open_f.disposition IS NULL))',
    )
  if (filter.state === 'complete') where.push('r.completed_at IS NOT NULL')
  if (filter.project) {
    where.push(
      'EXISTS (SELECT 1 FROM review_lens project_l JOIN run project_run ON project_run.id=project_l.run_id WHERE project_l.review_id=r.id AND project_run.repo=?)',
    )
    params.push(filter.project)
  }
  if (filter.since) {
    where.push('r.recorded_at>=?')
    params.push(filter.since)
  }
  const rows = database
    .query(
      `SELECT r.id, r.recorded_at, r.completed_at, r.tier, r.tier_risk, r.tier_size,
            COUNT(DISTINCT rl.id) AS lens_count,
            COUNT(DISTINCT rf.id) AS findings_total,
            COUNT(DISTINCT CASE WHEN rf.disposition IS NOT NULL THEN rf.id END) AS findings_triaged,
            COUNT(DISTINCT CASE WHEN rf.disposition='accepted' THEN rf.id END) AS findings_accepted,
            COUNT(DISTINCT CASE WHEN rf.disposition='modified' THEN rf.id END) AS findings_modified,
            COUNT(DISTINCT CASE WHEN rf.disposition='rejected' THEN rf.id END) AS findings_rejected,
            COUNT(DISTINCT CASE WHEN rf.disposition='skipped' THEN rf.id END) AS findings_skipped,
            run.repo AS project, r.patch_id, r.path_set, r.commit_message, r.outdated_reason
       FROM review r JOIN review_lens rl ON rl.review_id=r.id JOIN run ON run.id=rl.run_id
       LEFT JOIN review_finding rf ON rf.review_id=r.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY r.id
      ORDER BY CASE WHEN r.completed_at IS NULL OR EXISTS (SELECT 1 FROM review_finding order_f WHERE order_f.review_id=r.id AND order_f.disposition IS NULL) THEN 0 ELSE 1 END,
               r.recorded_at DESC, r.id DESC`,
    )
    .all(...params) as {
    id: number
    recorded_at: string
    completed_at: string | null
    tier: number | null
    tier_risk: number | null
    tier_size: number | null
    lens_count: number
    findings_total: number
    findings_triaged: number
    findings_accepted: number
    findings_modified: number
    findings_rejected: number
    findings_skipped: number
    project: string | null
    patch_id: string | null
    path_set: string | null
    commit_message: string | null
    outdated_reason: string | null
  }[]
  return rows.map((row) => {
    const lenses = reviewReadLenses(row.id, database)
    return {
      id: row.id,
      recorded_at: row.recorded_at,
      completed_at: row.completed_at,
      project: row.project,
      branches: [...new Set(lenses.map((lens) => lens.branch).filter(Boolean))] as string[],
      tier: row.tier,
      risk: row.tier_risk,
      size: row.tier_size,
      lens_count: row.lens_count,
      findings: {
        total: row.findings_total,
        triaged: row.findings_triaged,
        accepted: row.findings_accepted,
        modified: row.findings_modified,
        rejected: row.findings_rejected,
        skipped: row.findings_skipped,
      },
      coverage: currentCoverage(
        {
          id: row.id,
          lenses,
          patchId: row.patch_id,
          pathSet: row.path_set,
          commitMessage: row.commit_message,
          outdatedReason: row.outdated_reason,
        },
        row.project,
        database,
      ),
    }
  })
}

export function getReview(reviewId: number, database: Database = db()) {
  const review = database
    .query(
      `SELECT id, recorded_at, completed_at, tier, tier_risk, tier_size, tier_reasons, tier_reason,
            patch_id, path_set, commit_message, outdated_at, outdated_reason FROM review WHERE id=?`,
    )
    .get(reviewId) as {
    id: number
    recorded_at: string
    completed_at: string | null
    tier: number | null
    tier_risk: number | null
    tier_size: number | null
    tier_reasons: string | null
    tier_reason: string | null
    patch_id: string | null
    path_set: string | null
    commit_message: string | null
    outdated_at: string | null
    outdated_reason: string | null
  } | null
  if (!review) throw new Error(`no review ${reviewId}`)
  const lenses = reviewReadLenses(reviewId, database)
  const projects = [
    ...new Set(
      (
        database
          .query(
            `SELECT run.repo FROM review_lens rl JOIN run ON run.id=rl.run_id WHERE rl.review_id=? AND run.repo IS NOT NULL`,
          )
          .all(reviewId) as { repo: string }[]
      ).map((row) => row.repo),
    ),
  ]
  const amendments = database
    .query(
      `SELECT finding_ordinal, at, actor_session,
              old_disposition, new_disposition,
              old_rejection_category, new_rejection_category,
              old_triaged_severity, new_triaged_severity, reason
         FROM review_finding_amendment
        WHERE review_id=?
        ORDER BY at, rowid`,
    )
    .all(reviewId) as {
    finding_ordinal: number
    at: string
    actor_session: string | null
    old_disposition: string | null
    new_disposition: string
    old_rejection_category: string | null
    new_rejection_category: string | null
    old_triaged_severity: string | null
    new_triaged_severity: string | null
    reason: string
  }[]
  return {
    id: review.id,
    recorded_at: review.recorded_at,
    completed_at: review.completed_at,
    tier: review.tier,
    risk: review.tier_risk,
    size: review.tier_size,
    tier_reasons: review.tier_reasons ? JSON.parse(review.tier_reasons) : null,
    tier_reason: review.tier_reason,
    projects,
    change_identity: {
      patch_id: review.patch_id,
      path_set: review.path_set ? JSON.parse(review.path_set) : null,
    },
    outdated_at: review.outdated_at,
    outdated_reason: review.outdated_reason,
    current_class:
      projects.length === 1
        ? currentCoverage(
            {
              id: reviewId,
              lenses,
              patchId: review.patch_id,
              pathSet: review.path_set,
              commitMessage: review.commit_message,
              outdatedReason: review.outdated_reason,
            },
            projects[0]!,
            database,
          )
        : null,
    lenses: lenses.map((lens) => {
      const project = projects.length === 1 ? projectRecord(database, projects[0]!) : null
      const pin = project
        ? git(project.path, ['rev-parse', '--verify', lens.reviewRef], true)
        : { ok: false, out: '' }
      return {
        run_id: lens.runId,
        lens: lens.lens,
        agent: lens.agent,
        model: lens.model,
        reviewed_tree: lens.tree,
        head_commit: lens.headCommit,
        review_ref: lens.reviewRef,
        grading: {
          reproduced: lens.reproduced,
          coverage: lens.coverageGrade,
          limits: lens.limits,
          overlap: lens.overlap,
        },
        pin: { resolves: pin.ok, commit: pin.ok ? pin.out : null },
      }
    }),
    findings: (
      database
        .query(
          `SELECT ordinal, severity, location, disposition, rejection_category, evidence, proposed_correction
           FROM review_finding WHERE review_id=? ORDER BY ordinal`,
        )
        .all(reviewId) as {
        ordinal: number
        severity: string
        location: string
        disposition: string | null
        rejection_category: string | null
        evidence: string
        proposed_correction: string
      }[]
    ).map((finding) => ({
      ...finding,
      amendments: amendments
        .filter((amendment) => amendment.finding_ordinal === finding.ordinal)
        .map(({ finding_ordinal: _findingOrdinal, ...amendment }) => amendment),
    })),
  }
}

export function recordReviews(
  entries: { runId: number; output: ReviewReply }[],
  database: Database = writableDb(),
): number {
  if (!entries.length) throw new Error('a review requires at least one lens run')
  const runs = entries.map(({ runId }) => {
    const run = database
      .query(
        `SELECT id, agent, model, lens, job, status, output_path, input_tree, head_commit, repo, project_id,
              base_commit, review_ref, changed_paths, branch
         FROM run WHERE id=?`,
      )
      .get(runId) as RunRow | null
    if (!run) throw new Error(`no run ${runId}`)
    if (!job(run.job).findings)
      throw new Error(`run ${runId} job ${run.job} does not produce review findings`)
    if (!run.lens) throw new Error(`run ${runId} has no lens identity`)
    if (!run.model) throw new Error(`run ${runId} has no effective model recorded`)
    if (run.status !== 'ok')
      throw new Error(`run ${runId} is ${run.status}, not a completed review run`)
    const existing = database
      .query('SELECT review_id FROM review_lens WHERE run_id=?')
      .get(runId) as { review_id: number } | null
    if (existing)
      throw new Error(`run ${runId} is already recorded in review ${existing.review_id}`)
    return run
  })
  const projects = [...new Set(runs.map((run) => run.repo))]
  if (projects.length > 1) {
    throw new Error(
      `review lens runs belong to different projects: ${projects.map((project) => project ?? '(none)').join(', ')}`,
    )
  }
  const measuredTrees = runs.filter((run) => run.input_tree !== null)
  const distinctTrees = new Set(measuredTrees.map((run) => run.input_tree))
  if (distinctTrees.size > 1) {
    throw new Error(
      `review lens runs measured different trees:\n${runs
        .map((run) => `run ${run.id}: ${run.input_tree ?? 'NULL'}`)
        .join('\n')}`,
    )
  }
  const measured = (() => {
    const run = runs[0]!
    if (!run.repo || !run.head_commit) return null
    const repo = projectPath(database, run.repo)
    if (!repo) return null
    const project = database
      .query<{ name: string; settings: string }, [string]>(
        'SELECT name,settings FROM project WHERE name=?',
      )
      .get(run.repo)
    if (!project) return null
    return measureReviewChange(
      repo,
      { name: project.name, settings: JSON.parse(project.settings) },
      run.head_commit,
    )
  })()
  const reviewId = writeTransaction(() => {
    const tier = measured?.tier ?? null
    const review = database
      .query(
        `INSERT INTO review (record_id, recorded_at, tier, tier_risk, tier_size, tier_reasons, tier_reason, project_id,
                           patch_id, path_set, commit_message)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .get(
        newRecordId(),
        nowIso(),
        tier?.tier ?? null,
        tier?.risk ?? null,
        tier?.size ?? null,
        tier ? JSON.stringify(tier.reasons) : null,
        tier?.reasons[tier.risk >= tier.size ? 0 : 1] ?? null,
        runs.every((run) => run.project_id === runs[0]!.project_id) ? runs[0]!.project_id : null,
        measured?.patchId ?? null,
        measured ? serializePathSet(measured.pathSet) : null,
        measured?.message ?? null,
      ) as { id: number }
    const insertLens = database.query(
      `INSERT INTO review_lens
         (record_id, review_id, run_id, lens, agent, model, tree_inspected, reviewed_tree, standards_read,
          files_covered, commands_run, could_not_verify, mcp_tools, docs_read, substitutes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    )
    const insert = database.query(
      `INSERT INTO review_finding
         (record_id, review_id, review_lens_id, ordinal, severity, location, evidence, proposed_correction)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    let ordinal = 0
    entries.forEach(({ output }, index) => {
      const run = runs[index]!
      output.provenance.files_covered = output.provenance.files_covered.map(normalizeCoveredPath)
      const lens = insertLens.get(
        newRecordId(),
        review.id,
        run.id,
        run.lens,
        run.agent,
        run.model,
        output.provenance.tree_inspected ?? null,
        run.input_tree,
        JSON.stringify(output.provenance.standards_read),
        JSON.stringify(output.provenance.files_covered),
        JSON.stringify(output.provenance.commands_run),
        JSON.stringify(output.provenance.could_not_verify),
        JSON.stringify(output.provenance.mcp_tools),
        JSON.stringify(output.provenance.docs_read),
        JSON.stringify(output.provenance.substitutes),
      ) as { id: number }
      output.findings.forEach((finding) => {
        insert.run(
          newRecordId(),
          review.id,
          lens.id,
          ++ordinal,
          finding.severity,
          finding.location,
          finding.evidence,
          finding.proposed_correction,
        )
      })
    })
    enqueueReview(database, review.id)
    return review.id
  }, database)
  pinReviewedCommits(runs, database)
  return reviewId
}
