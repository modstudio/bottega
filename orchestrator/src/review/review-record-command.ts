// concern: review-record-command
/** Resolves finished review facts, writes their interchange file, and invokes a project's recorder. */
import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { resolveStatePaths } from '../../../shared/state-directory.ts'
import { db } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { type Project, projectAt } from '../project/projects.ts'
import { reviewRecordArgv } from '../project/review-record-template.ts'
import {
  type ChangeGroup,
  measureChangeGroup,
  reviewRoundTriageComplete,
  reviewsForTriage,
  reviewTaskKeyForBranch,
} from './review-group.ts'
import { reviewLineage } from './review-lineage-store.ts'
import { type ReviewRecordRow, reviewRecordFindings } from './review-record-findings.ts'
import { writeReviewRecordFindings } from './review-record-findings-file.ts'

type ReviewRecordProject = Pick<Project, 'name' | 'settings'>

type ResolvedReviewRecord = {
  complete: boolean
  tier: 0 | 1 | 2 | 3
  rows: ReviewRecordRow[]
  refusal?: string | null
}

type ReviewRecordCommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

type ReviewRecordCommandOperations = {
  project(cwd: string): ReviewRecordProject | null
  review(project: ReviewRecordProject, cwd: string, branch: string): ResolvedReviewRecord
  findingsPath(project: string, branch: string): string
  write(path: string, findings: ReturnType<typeof reviewRecordFindings>): void
  run(argv: string[], cwd: string): ReviewRecordCommandResult
}

const PROJECT_REVIEW_RECORD_USAGE = `${PLATFORM_SLUG} review project-record <branch> --cwd <tree> --reason "<one line>"`

export function projectReviewRecordInputRefusal(condition: string): string {
  return `${condition}\ncleared by: ${PROJECT_REVIEW_RECORD_USAGE}`
}

/** Refuse an empty lineage when completed same-task rounds prove review evidence exists elsewhere. */
export function emptyProjectReviewRefusal(input: {
  selectedReviewCount: number
  taskKey: string | null
  lineage: readonly string[]
  completedReviewBranches: readonly string[]
}): string | null {
  if (input.selectedReviewCount || !input.taskKey || !input.completedReviewBranches.length) {
    return null
  }
  return (
    `review lineage [${input.lineage.join(', ')}] selected no review rounds for task ` +
    `${input.taskKey}, but completed task rounds exist on branches ` +
    `[${input.completedReviewBranches.join(', ')}]; cleared by: make the reviewed branch inherit ` +
    'one of those branches through a same-task --base, or run and complete its review'
  )
}

type Presentation = { log(...values: unknown[]): void }

function git(cwd: string, argv: string[]): string {
  const result = Bun.spawnSync(['git', ...argv], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${argv.join(' ')} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`,
    )
  }
  return result.stdout.toString().trim()
}

/** Selects every review round recorded by runs on the branch. */
export function readProjectReview(
  database: Database,
  group: ChangeGroup,
): { complete: boolean; rows: ReviewRecordRow[]; refusal: string | null } {
  const selectedReviews = reviewsForTriage(database, group).branchReviews
  const selectedIds = new Set(selectedReviews.map(({ reviewRecordId }) => reviewRecordId))
  const lineage = reviewLineage(database, group.project, group.branch)
  const taskKey = reviewTaskKeyForBranch(database, group.project, group.branch)
  const completedReviewBranches = taskKey
    ? database
        .query<{ branch: string }, [string, string, ...string[]]>(
          `SELECT DISTINCT run.branch FROM review r INDEXED BY review_project_id
             JOIN review_lens rl ON rl.review_record_id=r.record_id
             JOIN run ON run.record_id=rl.run_record_id
            WHERE r.project_record_id=(SELECT record_id FROM project WHERE name=?)
              AND r.completed_at IS NOT NULL AND r.role='round'
              AND upper(trim(run.launch_key))=? AND run.branch IS NOT NULL
              AND run.branch NOT IN (${lineage.map(() => '?').join(',')})
            ORDER BY run.branch`,
        )
        .all(group.project, taskKey.toUpperCase(), ...lineage)
        .map(({ branch }) => branch)
    : []
  const rows = database
    .query<
      {
        review: string
        finding: string | null
        lens: string
        run: string
        disposition: ReviewRecordRow['disposition']
        category: string | null
        severity: string | null
        location: string | null
      },
      [string, ...string[]]
    >(
      `SELECT r.record_id AS review,rf.record_id AS finding,rl.lens,rl.run_record_id AS run,rf.disposition,
              rf.rejection_category AS category,
              rf.triaged_severity AS severity,rf.location
         FROM review_lens rl JOIN run ON run.record_id=rl.run_record_id
         JOIN review r ON r.record_id=rl.review_record_id
         LEFT JOIN review_finding rf ON rf.review_lens_record_id=rl.record_id
        WHERE run.project_record_id=(SELECT record_id FROM project WHERE name=?)
          AND run.branch IN (${lineage.map(() => '?').join(',')})
        ORDER BY run.started_at,rl.record_id,rf.ordinal`,
    )
    .all(group.project, ...lineage)
    .filter(({ review }) => selectedIds.has(review))
  return {
    complete: selectedReviews.every(reviewRoundTriageComplete),
    rows: rows.map(({ review: _review, finding: _finding, ...row }) => row),
    refusal: emptyProjectReviewRefusal({
      selectedReviewCount: selectedReviews.length,
      taskKey,
      lineage,
      completedReviewBranches,
    }),
  }
}

function resolveReview(
  project: ReviewRecordProject,
  cwd: string,
  branch: string,
  database: Database,
): ResolvedReviewRecord {
  const tip = git(cwd, ['rev-parse', '--verify', `${branch}^{commit}`])
  const measured = measureChangeGroup(cwd, project, branch, tip)
  if (!measured) throw new Error(`could not measure the change group for ${branch} at ${tip}`)
  const branchReview = readProjectReview(database, measured.group)
  return {
    complete: branchReview.complete,
    tier: measured.tier.tier,
    rows: branchReview.rows,
    refusal: branchReview.refusal,
  }
}

export function reviewRecordCommandOperations(
  database: Database = db(),
): ReviewRecordCommandOperations {
  return {
    project: (cwd) => projectAt(cwd, database),
    review: (project, cwd, branch) => resolveReview(project, cwd, branch, database),
    findingsPath: (project, branch) =>
      join(
        resolveStatePaths(process.env).orchestratorDirectory,
        'review-records',
        project,
        `${encodeURIComponent(branch)}.json`,
      ),
    write: writeReviewRecordFindings,
    run: (argv, cwd) => {
      const result = Bun.spawnSync(argv, {
        cwd,
        env: targetGitEnvironment(cwd),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      }
    },
  }
}

function displayCommand(argv: readonly string[]): string {
  return argv.map((argument) => JSON.stringify(argument)).join(' ')
}

function recordCommandRemedy(branch: string, cwd: string): string {
  return (
    `cleared by: fix the project's review record command or its inputs, then rerun ` +
    `${PLATFORM_SLUG} review project-record ${branch} --cwd ${cwd} --reason "<one line>"`
  )
}

export function recordProjectReviewCommand(
  branch: string,
  cwd: string | undefined,
  reason: string | undefined,
  presentation: Presentation,
  operations: ReviewRecordCommandOperations = reviewRecordCommandOperations(),
): void {
  if (!cwd)
    throw new Error(
      projectReviewRecordInputRefusal(
        "--cwd <tree> is required to name the reviewed branch's worktree",
      ),
    )
  if (!reason?.trim() || /[\r\n]/.test(reason)) {
    throw new Error(projectReviewRecordInputRefusal('--reason must be one non-empty line'))
  }
  const project = operations.project(cwd)
  if (!project) {
    throw new Error(`cannot resolve a project for ${cwd}; pass a registered project worktree`)
  }
  const template = project.settings.review?.record
  if (!template) {
    presentation.log(`project ${project.name} declares no review record`)
    return
  }
  const review = operations.review(project, cwd, branch)
  if (review.refusal) throw new Error(review.refusal)
  if (!review.complete) {
    throw new Error(
      `review triage for ${branch} is incomplete; finish every lens and finding with ${PLATFORM_SLUG} score`,
    )
  }
  const findings = reviewRecordFindings(review.rows)
  const findingsPath = operations.findingsPath(project.name, branch)
  operations.write(findingsPath, findings)
  const agents = new Set(review.rows.map((row) => row.run)).size
  const argv = reviewRecordArgv(template, {
    tier: String(review.tier),
    reason,
    agents: String(agents),
    findings: findingsPath,
    branch,
  })
  const rendered = displayCommand(argv)
  let result: ReviewRecordCommandResult
  try {
    result = operations.run(argv, cwd)
  } catch (error) {
    throw new Error(
      `review record command could not start: ${rendered}\n${error instanceof Error ? error.message : String(error)}\n${recordCommandRemedy(branch, cwd)}`,
    )
  }
  if (result.exitCode !== 0) {
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
    throw new Error(
      `review record command failed (${result.exitCode}): ${rendered}\n${output || '(no output)'}\n` +
        recordCommandRemedy(branch, cwd),
    )
  }
  presentation.log(`ran review record command: ${rendered}`)
  presentation.log(`findings file: ${findingsPath}`)
}
