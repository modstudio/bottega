// concern: review
import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { ReviewReply } from '../contract/contract.ts'
import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { nextReviewNumber } from './review-number.ts'
import { enqueueReview } from './review-outbox.ts'

export { parseReviewOutput, parseReviewReply } from '../contract/contract.ts'

import { job } from '../jobs/jobs.ts'
import { currentCoverage, projectRecord, reviewBranchNames } from './review-coverage.ts'
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
import { type ReviewRole, reviewRoleForBatch } from './review-role.ts'
import type {
  CoverageGitResult,
  ReviewListFilter,
  ReviewListRow,
  ReviewReadLens,
  RunRow,
} from './review-types.ts'

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

/** Classify whether a review reply has evidence, including changed-path coverage for clean replies. */
export function cleanReviewEvidence(
  runId: string,
  output: ReviewReply,
  database: Database = db(),
): CleanReviewEvidence {
  const provenance = output.provenance
  provenance.files_covered = provenance.files_covered.map(normalizeCoveredPath)
  if (!provenance.files_covered.length && !provenance.commands_run.length) {
    return { failure: UNEVIDENCED_REVIEW_ERROR, note: null, kind: 'unevidenced' }
  }
  if (output.findings.length) return { failure: null, note: null }
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
          'SELECT repo, base_commit, input_tree, head_commit, review_ref, changed_paths FROM run WHERE record_id=?',
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

type ReviewReadLensRow = {
  record_id: string
  review_record_id: string
  lens: string
  run_record_id: string
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
}

const reviewReadLens = (row: ReviewReadLensRow): ReviewReadLens => ({
  recordId: row.record_id,
  lens: row.lens,
  runId: row.run_record_id,
  agent: row.agent,
  model: row.model,
  treeInspected: row.tree_inspected,
  tree: row.reviewed_tree,
  inputTree: row.input_tree,
  branch: row.branch,
  baseCommit: row.base_commit,
  launchCwd: row.launch_cwd,
  headCommit: row.head_commit,
  reviewRef: pinRef(row.run_record_id),
  reproduced: row.reproduced,
  coverageGrade: row.coverage,
  limits: row.limits,
  overlap: row.overlap,
})

function reviewReadLenses(reviewRecordId: string, database: Database): ReviewReadLens[] {
  return database
    .query(
      `SELECT rl.record_id, rl.review_record_id, rl.lens, rl.run_record_id, rl.agent, rl.model, rl.tree_inspected, rl.reviewed_tree,
            rl.reproduced, rl.coverage, rl.limits, rl.overlap,
            run.input_tree, run.branch, run.base_commit, run.launch_cwd, run.head_commit
       FROM review_lens rl JOIN run ON run.record_id=rl.run_record_id
      WHERE rl.review_record_id=? ORDER BY run.started_at,rl.record_id`,
    )
    .all(reviewRecordId)
    .map((row) => reviewReadLens(row as ReviewReadLensRow))
}

function reviewReadLensesByReview(
  reviewRecordIds: ReadonlySet<string>,
  database: Database,
): Map<string, ReviewReadLens[]> {
  const result = new Map<string, ReviewReadLens[]>()
  if (!reviewRecordIds.size) return result
  const rows = database
    .query(
      `SELECT rl.record_id, rl.review_record_id, rl.lens, rl.run_record_id, rl.agent, rl.model, rl.tree_inspected, rl.reviewed_tree,
              rl.reproduced, rl.coverage, rl.limits, rl.overlap,
              run.input_tree, run.branch, run.base_commit, run.launch_cwd, run.head_commit
         FROM review_lens rl JOIN run ON run.record_id=rl.run_record_id
        ORDER BY run.started_at,rl.record_id`,
    )
    .all() as ReviewReadLensRow[]
  for (const row of rows) {
    if (!reviewRecordIds.has(row.review_record_id)) continue
    const lenses = result.get(row.review_record_id) ?? []
    lenses.push(reviewReadLens(row))
    result.set(row.review_record_id, lenses)
  }
  return result
}

type ReviewListQueryRow = {
  record_id: string
  number: number
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
}

function listReviewCoverage(
  row: ReviewListQueryRow,
  lenses: ReviewReadLens[],
  database: Database,
  branchesByProject: Map<string, Set<string> | null>,
  commandsByProject: Map<string, Map<string, CoverageGitResult>>,
  coverageByEvidence: Map<string, ReviewListRow['coverage']>,
): ReviewListRow['coverage'] {
  const key = JSON.stringify({
    project: row.project,
    lenses: lenses.map((lens) => ({
      tree: lens.tree,
      inputTree: lens.inputTree,
      branch: lens.branch,
      baseCommit: lens.baseCommit,
      headCommit: lens.headCommit,
    })),
    patchId: row.patch_id,
    pathSet: row.path_set,
    commitMessage: row.commit_message,
    outdatedReason: row.outdated_reason,
  })
  const cached = coverageByEvidence.get(key)
  if (cached !== undefined) return cached
  let commandCache = row.project ? commandsByProject.get(row.project) : undefined
  if (row.project && !commandCache) {
    commandCache = new Map()
    commandsByProject.set(row.project, commandCache)
  }
  const coverage = currentCoverage(
    {
      recordId: row.record_id,
      lenses,
      patchId: row.patch_id,
      pathSet: row.path_set,
      commitMessage: row.commit_message,
      outdatedReason: row.outdated_reason,
    },
    row.project,
    database,
    row.project ? (branchesByProject.get(row.project) ?? undefined) : undefined,
    commandCache,
  )
  coverageByEvidence.set(key, coverage)
  return coverage
}

export function listReviews(
  filter: ReviewListFilter = {},
  database: Database = db(),
): ReviewListRow[] {
  const where: string[] = []
  const params: SQLQueryBindings[] = []
  if (filter.state === 'open')
    where.push(
      '(r.completed_at IS NULL OR EXISTS (SELECT 1 FROM review_finding open_f WHERE open_f.review_record_id=r.record_id AND open_f.disposition IS NULL))',
    )
  if (filter.state === 'complete') where.push('r.completed_at IS NOT NULL')
  if (filter.project) {
    where.push(
      'EXISTS (SELECT 1 FROM review_lens project_l JOIN run project_run ON project_run.record_id=project_l.run_record_id WHERE project_l.review_record_id=r.record_id AND project_run.project_record_id=(SELECT record_id FROM project WHERE name=?))',
    )
    params.push(filter.project)
  }
  if (filter.since) {
    where.push('r.recorded_at>=?')
    params.push(filter.since)
  }
  const rows = database
    .query(
      `SELECT r.record_id, r.number, r.recorded_at, r.completed_at, r.tier, r.tier_risk, r.tier_size,
            COUNT(DISTINCT rl.record_id) AS lens_count,
            COUNT(DISTINCT rf.record_id) AS findings_total,
            COUNT(DISTINCT CASE WHEN rf.disposition IS NOT NULL THEN rf.record_id END) AS findings_triaged,
            COUNT(DISTINCT CASE WHEN rf.disposition='accepted' THEN rf.record_id END) AS findings_accepted,
            COUNT(DISTINCT CASE WHEN rf.disposition='modified' THEN rf.record_id END) AS findings_modified,
            COUNT(DISTINCT CASE WHEN rf.disposition='rejected' THEN rf.record_id END) AS findings_rejected,
            COUNT(DISTINCT CASE WHEN rf.disposition='skipped' THEN rf.record_id END) AS findings_skipped,
            run.repo AS project, r.patch_id, r.path_set, r.commit_message, r.outdated_reason
       FROM review r JOIN review_lens rl ON rl.review_record_id=r.record_id JOIN run ON run.record_id=rl.run_record_id
       LEFT JOIN review_finding rf ON rf.review_record_id=r.record_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY r.record_id
      ORDER BY CASE WHEN r.completed_at IS NULL OR EXISTS (SELECT 1 FROM review_finding order_f WHERE order_f.review_record_id=r.record_id AND order_f.disposition IS NULL) THEN 0 ELSE 1 END,
               r.recorded_at DESC, r.number DESC`,
    )
    .all(...params) as ReviewListQueryRow[]
  const branchesByProject = new Map(
    [
      ...new Set(rows.map((row) => row.project).filter((name): name is string => Boolean(name))),
    ].map((project) => [project, reviewBranchNames(project, database)] as const),
  )
  const coverageCommandsByProject = new Map<string, Map<string, CoverageGitResult>>()
  const coverageByEvidence = new Map<string, ReviewListRow['coverage']>()
  const lensesByReview = reviewReadLensesByReview(
    new Set(rows.map((row) => row.record_id)),
    database,
  )
  return rows.map((row) => {
    const lenses = lensesByReview.get(row.record_id) ?? []
    const coverage = listReviewCoverage(
      row,
      lenses,
      database,
      branchesByProject,
      coverageCommandsByProject,
      coverageByEvidence,
    )
    return {
      record_id: row.record_id,
      number: row.number,
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
      coverage,
    }
  })
}

function reviewProjects(reviewRecordId: string, database: Database): string[] {
  return [
    ...new Set(
      (
        database
          .query(
            `SELECT run.repo FROM review_lens rl JOIN run ON run.record_id=rl.run_record_id WHERE rl.review_record_id=? AND run.repo IS NOT NULL`,
          )
          .all(reviewRecordId) as { repo: string }[]
      ).map((row) => row.repo),
    ),
  ]
}

export function getReview(reviewRecordId: string, database: Database = db()) {
  const review = database
    .query(
      `SELECT record_id, number, recorded_at, completed_at, tier, tier_risk, tier_size, tier_reasons, tier_reason,
            patch_id, path_set, commit_message, outdated_at, outdated_reason FROM review WHERE record_id=?`,
    )
    .get(reviewRecordId) as {
    record_id: string
    number: number
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
  if (!review) throw new Error(`no review ${reviewRecordId}`)
  const lenses = reviewReadLenses(reviewRecordId, database)
  const projects = reviewProjects(reviewRecordId, database)
  const amendments = database
    .query(
      `SELECT amendment.review_finding_record_id, amendment.at, amendment.actor_session,
              old_disposition, new_disposition,
              old_rejection_category, new_rejection_category,
              old_triaged_severity, new_triaged_severity, reason
         FROM review_finding_amendment amendment
         JOIN review_finding finding ON finding.record_id=amendment.review_finding_record_id
        WHERE finding.review_record_id=?
        ORDER BY amendment.at, amendment.record_id`,
    )
    .all(reviewRecordId) as {
    review_finding_record_id: string
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
    record_id: review.record_id,
    number: review.number,
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
              recordId: reviewRecordId,
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
        run_record_id: lens.runId,
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
          `SELECT record_id, ordinal, severity, location, disposition, rejection_category, evidence, proposed_correction
           FROM review_finding WHERE review_record_id=? ORDER BY ordinal`,
        )
        .all(reviewRecordId) as {
        record_id: string
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
        .filter((amendment) => amendment.review_finding_record_id === finding.record_id)
        .map(({ review_finding_record_id: _findingRecordId, ...amendment }) => amendment),
    })),
  }
}

function sharedProjectRecordId(runs: readonly RunRow[]): string | null {
  return runs.every((run) => run.project_record_id === runs[0]!.project_record_id)
    ? runs[0]!.project_record_id
    : null
}

function reviewProjectAndRole(runs: readonly RunRow[]): [string | null, ReviewRole] {
  const role = reviewRoleForBatch(runs.map((run) => run.review_role))
  if (!role) {
    throw new Error(
      `review lens runs have different round roles; record the round and supplementary runs separately with one ${PLATFORM_SLUG} review record command each`,
    )
  }
  return [sharedProjectRecordId(runs), role]
}

function recordedReviewNumber(database: Database, runRecordId: string): number | null {
  const row = database
    .query(
      `SELECT review.number FROM review_lens JOIN review ON review.record_id=review_lens.review_record_id WHERE review_lens.run_record_id=?`,
    )
    .get(runRecordId) as { number: number } | null
  return row?.number ?? null
}

export function recordReviews(
  entries: { runId: string; output: ReviewReply }[],
  database: Database = writableDb(),
): string {
  if (!entries.length) throw new Error('a review requires at least one lens run')
  const runs = entries.map(({ runId }) => {
    const run = database
      .query(
        `SELECT record_id, agent, model, lens, review_role, job, status, output_path, input_tree, head_commit, repo, project_record_id,
              base_commit, review_ref, changed_paths, branch
         FROM run WHERE record_id=?`,
      )
      .get(runId) as RunRow | null
    if (!run) throw new Error(`no run ${runId}`)
    if (!job(run.job).findings)
      throw new Error(`run ${runId} job ${run.job} does not produce review findings`)
    if (!run.lens) throw new Error(`run ${runId} has no lens identity`)
    if (!run.model) throw new Error(`run ${runId} has no effective model recorded`)
    if (run.status !== 'ok')
      throw new Error(`run ${runId} is ${run.status}, not a completed review run`)
    const existing = recordedReviewNumber(database, runId)
    if (existing) throw new Error(`run ${runId} is already recorded in review ${existing}`)
    return run
  })
  const projects = [...new Set(runs.map((run) => run.project_record_id))]
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
        .map((run) => `run ${run.record_id}: ${run.input_tree ?? 'NULL'}`)
        .join('\n')}`,
    )
  }
  const measured = (() => {
    const run = runs[0]!
    if (!run.project_record_id || !run.head_commit) return null
    const project = database
      .query<{ name: string; path: string; settings: string }, [string]>(
        'SELECT name,path,settings FROM project WHERE record_id=?',
      )
      .get(run.project_record_id)
    if (!project) return null
    return measureReviewChange(
      project.path,
      { name: project.name, settings: JSON.parse(project.settings) },
      run.head_commit,
    )
  })()
  const reviewRecordId = writeTransaction(() => {
    const tier = measured?.tier ?? null
    const review = database
      .query(
        `INSERT INTO review (record_id, number, recorded_at, tier, tier_risk, tier_size, tier_reasons, tier_reason, project_record_id, role,
                           patch_id, path_set, commit_message)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING record_id`,
      )
      .get(
        newRecordId(),
        nextReviewNumber(database),
        nowIso(),
        tier?.tier ?? null,
        tier?.risk ?? null,
        tier?.size ?? null,
        tier ? JSON.stringify(tier.reasons) : null,
        tier?.reasons[tier.risk >= tier.size ? 0 : 1] ?? null,
        ...reviewProjectAndRole(runs),
        measured?.patchId ?? null,
        measured ? serializePathSet(measured.pathSet) : null,
        measured?.message ?? null,
      ) as { record_id: string }
    const insertLens = database.query(
      `INSERT INTO review_lens
         (record_id, review_record_id, run_record_id, lens, agent, model, tree_inspected, reviewed_tree, standards_read,
          files_covered, commands_run, could_not_verify, mcp_tools, docs_read, substitutes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING record_id`,
    )
    const insert = database.query(
      `INSERT INTO review_finding
         (record_id, review_record_id, review_lens_record_id, ordinal, severity, location, evidence, proposed_correction)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    let ordinal = 0
    entries.forEach(({ output }, index) => {
      const run = runs[index]!
      output.provenance.files_covered = output.provenance.files_covered.map(normalizeCoveredPath)
      const lens = insertLens.get(
        newRecordId(),
        review.record_id,
        run.record_id,
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
      ) as { record_id: string }
      output.findings.forEach((finding) => {
        insert.run(
          newRecordId(),
          review.record_id,
          lens.record_id,
          ++ordinal,
          finding.severity,
          finding.location,
          finding.evidence,
          finding.proposed_correction,
        )
      })
    })
    enqueueReview(database, review.record_id)
    return review.record_id
  }, database)
  pinReviewedCommits(runs, database)
  return reviewRecordId
}
