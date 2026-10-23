// concern: pull-request CI evidence
/** Fetches, records, and derives the GitHub Actions evidence attached to one pull request. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { writeTransaction } from '../database/db.ts'
import { currentProjectRepository, type Project } from '../project/projects.ts'
import { enqueuePullRequestCi } from '../record/landing-outbox.ts'

export type PullRequestCiAttempt = {
  workflowRunId: number
  runAttempt: number
  workflowName: string
  event: string
  headCommit: string
  conclusion: string | null
  failedJobs: string[]
  createdAt: string
  completedAt: string | null
}

export type PullRequestCiCounts = {
  ciRuns: number
  reruns: number
  flakeAttributedReruns: number
}

export function derivePullRequestCiCounts(
  attempts: readonly PullRequestCiAttempt[],
): PullRequestCiCounts {
  const runs = new Map<number, PullRequestCiAttempt[]>()
  for (const attempt of attempts) {
    const values = runs.get(attempt.workflowRunId) ?? []
    values.push(attempt)
    runs.set(attempt.workflowRunId, values)
  }
  let reruns = 0
  let flakeAttributedReruns = 0
  for (const values of runs.values()) {
    const ordered = [...values].sort((left, right) => left.runAttempt - right.runAttempt)
    reruns += ordered.filter((attempt) => attempt.runAttempt > 1).length
    flakeAttributedReruns += ordered.filter(
      (attempt, index) =>
        attempt.conclusion === 'failure' &&
        ordered
          .slice(index + 1)
          .some(
            (later) => later.headCommit === attempt.headCommit && later.conclusion === 'success',
          ),
    ).length
  }
  return { ciRuns: runs.size, reruns, flakeAttributedReruns }
}

const CI_MERGE_MARGIN_MS = 60 * 60 * 1_000

type PullRequestFacts = {
  number: number
  createdAt: string
  mergedAt: string | null
  state: string
  baseBranch: string
  headBranch: string
}
export type PullRequestCiFetchAdapter = {
  pullRequest(cwd: string, repository: string, target: string): PullRequestFacts
  workflowRuns(
    cwd: string,
    repository: string,
    query: { branch?: string; event?: string; created: string },
  ): unknown[]
  attempt(cwd: string, repository: string, runId: number, attempt: number): unknown
  jobs(cwd: string, repository: string, runId: number, attempt: number): unknown[]
}

type ProcessResult = { exitCode: number; stdout: string; stderr: string }
function run(cwd: string, argv: string[]): ProcessResult {
  const result = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  }
}

function api(cwd: string, path: string, fields: readonly string[] = []): unknown {
  const result = run(cwd, [
    'gh',
    'api',
    '--method',
    'GET',
    path,
    ...fields.flatMap((field) => ['-f', field]),
  ])
  if (result.exitCode !== 0) {
    throw new Error(`gh api ${path} failed: ${result.stderr || `exit ${result.exitCode}`}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (cause) {
    throw new Error(
      `gh api ${path} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

function array(value: unknown, field?: string): unknown[] {
  const selected =
    field && value && typeof value === 'object' ? (value as Record<string, unknown>)[field] : value
  if (!Array.isArray(selected))
    throw new Error(`GitHub API returned an unexpected ${field ?? 'array'} shape`)
  return selected
}

const cliPullRequestCiFetchAdapter: PullRequestCiFetchAdapter = {
  pullRequest(cwd, repository, target) {
    const value = api(cwd, `repos/${repository}/pulls/${encodeURIComponent(target)}`) as Record<
      string,
      unknown
    >
    const head = value.head as Record<string, unknown> | undefined
    const base = value.base as Record<string, unknown> | undefined
    if (
      !Number.isSafeInteger(value.number) ||
      typeof value.created_at !== 'string' ||
      (value.merged_at !== null && typeof value.merged_at !== 'string') ||
      typeof value.state !== 'string' ||
      typeof head?.ref !== 'string' ||
      typeof base?.ref !== 'string'
    ) {
      throw new Error('GitHub pull request response has an unexpected shape')
    }
    return {
      number: Number(value.number),
      createdAt: value.created_at,
      mergedAt: value.merged_at as string | null,
      state: value.state,
      headBranch: head.ref,
      baseBranch: base.ref,
    }
  },
  workflowRuns(cwd, repository, query) {
    const values: unknown[] = []
    for (let page = 1; ; page += 1) {
      const fields = ['per_page=100', `page=${page}`]
      if (query.branch) fields.push(`branch=${query.branch}`)
      if (query.event) fields.push(`event=${query.event}`)
      fields.push(`created=${query.created}`)
      const batch = array(api(cwd, `repos/${repository}/actions/runs`, fields), 'workflow_runs')
      values.push(...batch)
      if (batch.length < 100) break
    }
    return values
  },
  attempt(cwd, repository, runId, attempt) {
    return api(cwd, `repos/${repository}/actions/runs/${runId}/attempts/${attempt}`)
  },
  jobs(cwd, repository, runId, attempt) {
    const values: unknown[] = []
    for (let page = 1; ; page += 1) {
      const batch = array(
        api(cwd, `repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs`, [
          'per_page=100',
          `page=${page}`,
        ]),
        'jobs',
      )
      values.push(...batch)
      if (batch.length < 100) break
    }
    return values
  },
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`GitHub ${label} is not an integer`)
  return Number(value)
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`GitHub ${label} is not a string`)
  return value
}
function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label)
}

export function parsePullRequestCiAttempt(
  value: unknown,
  jobs: readonly unknown[],
): PullRequestCiAttempt {
  if (!value || typeof value !== 'object')
    throw new Error('GitHub workflow attempt is not an object')
  const row = value as Record<string, unknown>
  const failedJobs = jobs.flatMap((job) => {
    if (!job || typeof job !== 'object') throw new Error('GitHub workflow job is not an object')
    const candidate = job as Record<string, unknown>
    if (
      typeof candidate.name !== 'string' ||
      (candidate.conclusion !== null && typeof candidate.conclusion !== 'string')
    )
      throw new Error('GitHub workflow job has an unexpected shape')
    return candidate.conclusion === 'failure' ? [candidate.name] : []
  })
  return {
    workflowRunId: integer(row.id, 'workflow run id'),
    runAttempt: integer(row.run_attempt, 'workflow run attempt'),
    workflowName: text(row.name, 'workflow name'),
    event: text(row.event, 'workflow event'),
    headCommit: text(row.head_sha, 'workflow head commit'),
    conclusion: nullableText(row.conclusion, 'workflow conclusion'),
    failedJobs,
    createdAt: text(row.created_at, 'workflow creation time'),
    completedAt: nullableText(row.updated_at, 'workflow completion time'),
  }
}

export function fetchPullRequestCiAttempts(input: {
  cwd: string
  repository: string
  target: string
  adapter?: PullRequestCiFetchAdapter
}): { pullRequest: PullRequestFacts; attempts: PullRequestCiAttempt[] } {
  const adapter = input.adapter ?? cliPullRequestCiFetchAdapter
  const pullRequest = adapter.pullRequest(input.cwd, input.repository, input.target)
  if (pullRequest.mergedAt === null) {
    throw new PullRequestCiUnmergedError(
      `pull request #${pullRequest.number} is ${pullRequest.state} and unmerged; pr ci-record records merged pull requests only`,
    )
  }
  const created = `>=${pullRequest.createdAt}`
  const queuePrefix = `gh-readonly-queue/${pullRequest.baseBranch}/pr-${pullRequest.number}-`
  const earliest = Date.parse(pullRequest.createdAt)
  const latest = Date.parse(pullRequest.mergedAt) + CI_MERGE_MARGIN_MS
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) {
    throw new Error('GitHub pull request timestamps have an unexpected shape')
  }
  const inWindow = (raw: unknown): raw is Record<string, unknown> => {
    if (!raw || typeof raw !== 'object') throw new Error('GitHub workflow run is not an object')
    const at = Date.parse(
      text((raw as Record<string, unknown>).created_at, 'workflow creation time'),
    )
    if (!Number.isFinite(at)) throw new Error('GitHub workflow creation time is invalid')
    return at >= earliest && at <= latest
  }
  const pullRequestRuns = adapter
    .workflowRuns(input.cwd, input.repository, { branch: pullRequest.headBranch, created })
    .filter(inWindow)
  const queueRuns = adapter
    .workflowRuns(input.cwd, input.repository, { event: 'merge_group', created })
    .filter(inWindow)
    .filter((raw) => text(raw.head_branch, 'workflow head branch').startsWith(queuePrefix))
  const runs = [...pullRequestRuns, ...queueRuns]
  const attempts: PullRequestCiAttempt[] = []
  const seen = new Set<number>()
  for (const raw of runs) {
    const row = raw
    const runId = integer(row.id, 'workflow run id')
    if (seen.has(runId)) continue
    seen.add(runId)
    const attemptCount = integer(row.run_attempt, 'workflow run attempt')
    for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      const detail = adapter.attempt(input.cwd, input.repository, runId, attempt)
      attempts.push(
        parsePullRequestCiAttempt(
          detail,
          adapter.jobs(input.cwd, input.repository, runId, attempt),
        ),
      )
    }
  }
  return { pullRequest, attempts }
}

class PullRequestCiUnmergedError extends Error {}

export function pullRequestCiRetryCommand(prNumber: number, projectName: string): string {
  return `${PLATFORM_SLUG} pr ci-record ${prNumber} --project ${projectName}`
}

export function pullRequestCiIncompleteMessage(
  prNumber: number,
  detail: string,
  retryCommand: string,
): string {
  return `CI recording incomplete for PR #${prNumber}: ${detail}; retry: ${retryCommand}`
}

function collectionRecord(
  database: Database,
  project: Project,
  prNumber: number,
  complete: boolean,
  error: string | null,
  at: string,
): string {
  const recordId =
    database
      .query<{ record_id: string }, [string, number]>(
        "SELECT record_id FROM pull_request_ci WHERE project_record_id=? AND pr_number=? AND record_kind='collection'",
      )
      .get(project.recordId, prNumber)?.record_id ?? newRecordId()
  database
    .query(`INSERT INTO pull_request_ci
    (record_id,project,project_record_id,pr_number,record_kind,complete,error,recorded_at)
    VALUES (?,?,?,?, 'collection',?,?,?)
    ON CONFLICT(project_record_id,pr_number) WHERE record_kind='collection' DO UPDATE SET
      complete=excluded.complete,error=excluded.error,recorded_at=excluded.recorded_at`)
    .run(recordId, project.name, project.recordId, prNumber, complete ? 1 : 0, error, at)
  return recordId
}

export function recordPullRequestCi(input: {
  project: Project
  target: string
  cwd: string
  database: Database
  adapter?: PullRequestCiFetchAdapter
  repository?: string
}): { prNumber: number; complete: boolean; counts: PullRequestCiCounts; error?: string } {
  const repository = input.repository ?? currentProjectRepository(input.project)
  if (!repository)
    throw new Error(`project ${input.project.name} has no GitHub repository identity`)
  let prNumber = Number(input.target)
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`pull request must be a positive integer, received ${input.target}`)
  }
  try {
    const fetched = fetchPullRequestCiAttempts({
      cwd: input.cwd,
      repository,
      target: input.target,
      adapter: input.adapter,
    })
    prNumber = fetched.pullRequest.number
    const at = new Date().toISOString()
    writeTransaction(() => {
      for (const attempt of fetched.attempts) {
        const existingId = input.database
          .query<{ record_id: string }, [string, number, number, number]>(
            `SELECT record_id FROM pull_request_ci WHERE project_record_id=? AND pr_number=?
           AND record_kind='attempt' AND workflow_run_id=? AND run_attempt=?`,
          )
          .get(
            input.project.recordId,
            prNumber,
            attempt.workflowRunId,
            attempt.runAttempt,
          )?.record_id
        const recordId = existingId ?? newRecordId()
        input.database
          .query(`INSERT INTO pull_request_ci
          (record_id,project,project_record_id,pr_number,record_kind,workflow_run_id,run_attempt,
           workflow_name,event,head_commit,conclusion,failed_jobs,workflow_created_at,workflow_completed_at,recorded_at)
          VALUES (?,?,?,?, 'attempt',?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(project_record_id,pr_number,record_kind,workflow_run_id,run_attempt) DO UPDATE SET
            workflow_name=excluded.workflow_name,event=excluded.event,head_commit=excluded.head_commit,
            conclusion=excluded.conclusion,failed_jobs=excluded.failed_jobs,workflow_created_at=excluded.workflow_created_at,
            workflow_completed_at=excluded.workflow_completed_at,recorded_at=excluded.recorded_at`)
          .run(
            recordId,
            input.project.name,
            input.project.recordId,
            prNumber,
            attempt.workflowRunId,
            attempt.runAttempt,
            attempt.workflowName,
            attempt.event,
            attempt.headCommit,
            attempt.conclusion,
            JSON.stringify(attempt.failedJobs),
            attempt.createdAt,
            attempt.completedAt,
            at,
          )
        enqueuePullRequestCi(input.database, recordId, at)
      }
      enqueuePullRequestCi(
        input.database,
        collectionRecord(input.database, input.project, prNumber, true, null, at),
        at,
      )
    }, input.database)
    return { prNumber, complete: true, counts: derivePullRequestCiCounts(fetched.attempts) }
  } catch (cause) {
    if (cause instanceof PullRequestCiUnmergedError) throw cause
    const error = cause instanceof Error ? cause.message : String(cause)
    const incomplete = pullRequestCiIncompleteMessage(
      prNumber,
      error,
      pullRequestCiRetryCommand(prNumber, input.project.name),
    )
    if (Number.isSafeInteger(prNumber) && prNumber > 0) {
      const at = new Date().toISOString()
      writeTransaction(() => {
        const id = collectionRecord(input.database, input.project, prNumber, false, incomplete, at)
        enqueuePullRequestCi(input.database, id, at)
      }, input.database)
    }
    return {
      prNumber,
      complete: false,
      counts: { ciRuns: 0, reruns: 0, flakeAttributedReruns: 0 },
      error: incomplete,
    }
  }
}
