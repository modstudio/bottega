// concern: review-record-command
/** Resolves finished review facts, writes their interchange file, and invokes a project's recorder. */
import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
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
} from './review-group.ts'
import { type ReviewRecordRow, reviewRecordFindings } from './review-record-findings.ts'
import { writeReviewRecordFindings } from './review-record-findings-file.ts'

type ReviewRecordProject = Pick<Project, 'name' | 'settings'>

type ResolvedReviewRecord = {
  complete: boolean
  tier: 0 | 1 | 2 | 3
  rows: ReviewRecordRow[]
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

/** Selects only review rows for the branch's current measured change. */
export function readProjectReview(
  database: Database,
  group: ChangeGroup,
): { complete: boolean; rows: ReviewRecordRow[] } {
  const selectedReviews = reviewsForTriage(database, group).reviews
  const selectedIds = new Set(selectedReviews.map(({ reviewId }) => reviewId))
  const rows = database
    .query<
      {
        review: number
        finding: number | null
        lens: string
        run: number
        disposition: ReviewRecordRow['disposition']
        category: string | null
        severity: string | null
        location: string | null
      },
      [string, string]
    >(
      `SELECT r.id AS review,rf.id AS finding,rl.lens,rl.run_id AS run,rf.disposition,
              rf.rejection_category AS category,
              rf.triaged_severity AS severity,rf.location
         FROM review_lens rl JOIN run ON run.id=rl.run_id
         JOIN review r ON r.id=rl.review_id
         LEFT JOIN review_finding rf ON rf.review_lens_id=rl.id
        WHERE run.repo=? AND run.branch=?
        ORDER BY rl.id,rf.id`,
    )
    .all(group.project, group.branch)
    .filter(({ review }) => selectedIds.has(review))
  return {
    complete: selectedReviews.every(reviewRoundTriageComplete),
    rows: rows.map(({ review: _review, finding: _finding, ...row }) => row),
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
  }
}

function defaultOperations(database: Database = db()): ReviewRecordCommandOperations {
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
    `orch review project-record ${branch} --cwd ${cwd} --reason "<one line>"`
  )
}

export function recordProjectReviewCommand(
  branch: string,
  cwd: string | undefined,
  reason: string | undefined,
  presentation: Presentation,
  operations: ReviewRecordCommandOperations = defaultOperations(),
): void {
  if (!cwd)
    throw new Error('orch review project-record <branch> --cwd <tree> --reason "<one line>"')
  if (!reason?.trim() || /[\r\n]/.test(reason)) {
    throw new Error('--reason must be one non-empty line')
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
  if (!review.complete) {
    throw new Error(
      `review triage for ${branch} is incomplete; finish every lens and finding with orch judge`,
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
