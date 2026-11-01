import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { machineId } from '../../../shared/machine-config.ts'
import { applyMigrations } from '../database/migrations.ts'
import { enqueuePullRequestCi } from '../record/landing-outbox.ts'
import attemptFixture from './fixtures/github-workflow-attempt.json'
import jobsFixture from './fixtures/github-workflow-jobs.json'
import runsFixture from './fixtures/github-workflow-runs.json'
import {
  derivePullRequestCiCounts,
  fetchPullRequestCiAttempts,
  type PullRequestCiFetchAdapter,
  parsePullRequestCiAttempt,
  recordPullRequestCi,
} from './pr-ci-record.ts'

const configRoot = mkdtempSync(join(tmpdir(), 'pr-ci-record-'))
const priorConfigRoot = process.env[CONFIG_HOME_ENV]

beforeAll(() => {
  process.env[CONFIG_HOME_ENV] = configRoot
  machineId('01990000-0000-7000-8000-000000000099')
})

afterAll(() => {
  if (priorConfigRoot === undefined) delete process.env[CONFIG_HOME_ENV]
  else process.env[CONFIG_HOME_ENV] = priorConfigRoot
  rmSync(configRoot, { recursive: true, force: true })
})

const attempt = (run: number, number: number, conclusion: string, headCommit = 'head') => ({
  workflowRunId: run,
  runAttempt: number,
  workflowName: 'CI',
  event: 'pull_request',
  headCommit,
  conclusion,
  failedJobs: conclusion === 'failure' ? ['test'] : [],
  createdAt: '2026-10-20T00:00:00Z',
  completedAt: '2026-10-20T00:01:00Z',
})

test('recording the same run attempts updates their rows and outbox payloads', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database.query("INSERT INTO schema_meta (key,value) VALUES ('machine_id','machine-record')").run()
  database
    .query(`INSERT INTO project (record_id,name,path,stack,settings)
    VALUES ('01990000-0000-7000-8000-000000000099','fixture','/fixture','bun','{}')`)
    .run()
  let finalConclusion = 'success'
  const adapter: PullRequestCiFetchAdapter = {
    pullRequest: () => ({
      number: 17,
      createdAt: '2026-10-19T00:00:00Z',
      mergedAt: '2026-10-20T00:02:00Z',
      state: 'closed',
      baseBranch: 'main',
      headBranch: 'feature',
    }),
    workflowRuns: (_cwd, _repository, query) =>
      query.branch ? [{ id: 42, run_attempt: 2, created_at: '2026-10-20T00:00:00Z' }] : [],
    attempt: (_cwd, _repository, runId, runAttempt) => ({
      ...attemptFixture,
      id: runId,
      run_attempt: runAttempt,
      conclusion: runAttempt === 2 ? finalConclusion : 'failure',
    }),
    jobs: () => jobsFixture.jobs,
  }
  const project = {
    recordId: '01990000-0000-7000-8000-000000000099',
    name: 'fixture',
    path: '/fixture',
    stack: 'bun',
    canon: false,
    retiredAt: null,
    settings: {},
  }
  const first = recordPullRequestCi({
    project,
    target: '17',
    cwd: '/fixture',
    database,
    adapter,
    repository: 'owner/repository',
  })
  expect(first.complete, first.error).toBe(true)
  finalConclusion = 'cancelled'
  expect(
    recordPullRequestCi({
      project,
      target: '17',
      cwd: '/fixture',
      database,
      adapter,
      repository: 'owner/repository',
    }).complete,
  ).toBe(true)
  expect(
    database.query<{ count: number }, []>('SELECT count(*) AS count FROM pull_request_ci').get()!
      .count,
  ).toBe(3)
  expect(
    database
      .query<{ conclusion: string }, []>(
        'SELECT conclusion FROM pull_request_ci WHERE run_attempt=2',
      )
      .get()!.conclusion,
  ).toBe('cancelled')
  expect(
    database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM outbox WHERE kind='pull_request_ci'",
      )
      .get()!.count,
  ).toBe(3)
  database.close()
})

test('CI counts do not attribute a rerun as a flake without a head commit', () => {
  expect(
    derivePullRequestCiCounts([
      { workflowRunId: 42, runAttempt: 1, headCommit: null, conclusion: 'failure' },
      { workflowRunId: 42, runAttempt: 2, headCommit: null, conclusion: 'success' },
    ]),
  ).toEqual({ ciRuns: 1, reruns: 1, flakeAttributedReruns: 0 })
})

test('derives runs, reruns, and same-run same-head flakes', () => {
  expect(
    derivePullRequestCiCounts([
      attempt(1, 1, 'failure'),
      attempt(1, 2, 'success'),
      attempt(2, 1, 'failure', 'old'),
      attempt(2, 2, 'success', 'new'),
      attempt(3, 1, 'success'),
    ]),
  ).toEqual({ ciRuns: 3, reruns: 2, flakeAttributedReruns: 1 })
})

test('parses the recorded GitHub API attempt and failed-job shapes', () => {
  expect(parsePullRequestCiAttempt(attemptFixture, jobsFixture.jobs)).toEqual({
    workflowRunId: 42,
    runAttempt: 2,
    workflowName: 'CI',
    event: 'merge_group',
    headCommit: 'abc',
    conclusion: 'success',
    failedJobs: ['integration'],
    createdAt: '2026-10-20T00:00:00Z',
    completedAt: '2026-10-20T00:01:00Z',
  })
})

test('an in-progress workflow attempt has no completion time', () => {
  expect(
    parsePullRequestCiAttempt({ ...attemptFixture, conclusion: null }, jobsFixture.jobs)
      .completedAt,
  ).toBeNull()
})

test('fetches force-pushed PR heads and every matching merge-queue branch in the PR window', () => {
  const queries: Array<{ branch?: string; event?: string; created: string }> = []
  const adapter: PullRequestCiFetchAdapter = {
    pullRequest: () => ({
      number: 1249,
      createdAt: '2026-10-22T12:00:00Z',
      mergedAt: '2026-10-23T04:00:00Z',
      state: 'closed',
      baseBranch: 'main',
      headBranch: 'DEV-1600-orch-01a166ae',
    }),
    workflowRuns: (_cwd, _repository, query) => {
      queries.push(query)
      return runsFixture.workflow_runs.filter((run) =>
        query.branch ? run.head_branch === query.branch : run.event === query.event,
      )
    },
    attempt: (_cwd, _repository, runId, runAttempt) => ({
      ...attemptFixture,
      id: runId,
      run_attempt: runAttempt,
      head_sha: runsFixture.workflow_runs.find((run) => run.id === runId)?.head_sha,
      conclusion: runId === 39882868998 || runId === 39883730485 ? 'success' : 'failure',
    }),
    jobs: () => jobsFixture.jobs,
  }
  const result = fetchPullRequestCiAttempts({
    cwd: '/fixture',
    repository: 'owner/repository',
    target: '1249',
    adapter,
  })
  expect(queries).toEqual([
    { branch: 'DEV-1600-orch-01a166ae', created: '>=2026-10-22T12:00:00Z' },
    { event: 'merge_group', created: '>=2026-10-22T12:00:00Z' },
  ])
  expect(result.attempts.map((value) => [value.workflowRunId, value.runAttempt])).toEqual([
    [39878290377, 1],
    [39878964524, 1],
    [39878964524, 2],
    [39882868998, 1],
    [39883730485, 1],
  ])
  expect(derivePullRequestCiCounts(result.attempts)).toEqual({
    ciRuns: 4,
    reruns: 1,
    flakeAttributedReruns: 0,
  })
})

test('refuses an unmerged pull request without writing CI evidence', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(`INSERT INTO project (record_id,name,path,stack,settings)
    VALUES ('01990000-0000-7000-8000-000000000099','fixture','/fixture','bun','{}')`)
    .run()
  const project = {
    recordId: '01990000-0000-7000-8000-000000000099',
    name: 'fixture',
    path: '/fixture',
    stack: 'bun',
    canon: false,
    retiredAt: null,
    settings: {},
  }
  const adapter: PullRequestCiFetchAdapter = {
    pullRequest: () => ({
      number: 17,
      createdAt: '2026-10-19T00:00:00Z',
      mergedAt: null,
      state: 'open',
      baseBranch: 'main',
      headBranch: 'feature',
    }),
    workflowRuns: () => [],
    attempt: () => ({}),
    jobs: () => [],
  }

  expect(() =>
    recordPullRequestCi({
      project,
      target: '17',
      cwd: '/fixture',
      database,
      adapter,
      repository: 'owner/repository',
    }),
  ).toThrow('pull request #17 is open and unmerged; pr ci-record records merged pull requests only')
  expect(database.query('SELECT record_id FROM pull_request_ci').all()).toEqual([])
  database.close()
})

test('records an explicit incomplete collection with the error and retry remedy after fetch failure', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(`INSERT INTO project (record_id,name,path,stack,settings)
    VALUES ('01990000-0000-7000-8000-000000000099','fixture','/fixture','bun','{}')`)
    .run()
  const project = {
    recordId: '01990000-0000-7000-8000-000000000099',
    name: 'fixture',
    path: '/fixture',
    stack: 'bun',
    canon: false,
    retiredAt: null,
    settings: {},
  }
  const adapter: PullRequestCiFetchAdapter = {
    pullRequest: () => ({
      number: 17,
      createdAt: '2026-10-19T00:00:00Z',
      mergedAt: '2026-10-20T00:02:00Z',
      state: 'closed',
      baseBranch: 'main',
      headBranch: 'feature',
    }),
    workflowRuns: () => {
      throw new Error('workflow runs unavailable')
    },
    attempt: () => ({}),
    jobs: () => [],
  }

  const result = recordPullRequestCi({
    project,
    target: '17',
    cwd: '/fixture',
    database,
    adapter,
    repository: 'owner/repository',
  })
  const rows = database
    .query<{ record_kind: string; complete: number; error: string }, []>(
      'SELECT record_kind,complete,error FROM pull_request_ci',
    )
    .all()
  expect(result).toMatchObject({ prNumber: 17, complete: false, error: rows[0]?.error })
  expect(rows).toEqual([
    {
      record_kind: 'collection',
      complete: 0,
      error: `CI recording incomplete for PR #17: workflow runs unavailable; retry: ${PLATFORM_SLUG} pr ci-record 17 --project fixture`,
    },
  ])
  database.close()
})

test('CI outbox refresh sanitizes errors and does not reuse quarantined or retired rows', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database.query("INSERT INTO schema_meta (key,value) VALUES ('machine_id','machine-record')").run()
  database
    .query(`INSERT INTO project (record_id,name,path,stack,settings)
    VALUES ('01990000-0000-7000-8000-000000000099','fixture','/fixture','bun','{}')`)
    .run()
  database
    .query(`INSERT INTO pull_request_ci
      (record_id,project,project_record_id,pr_number,record_kind,complete,error,recorded_at)
      VALUES ('01990000-0000-7000-8000-000000000017','fixture',
      '01990000-0000-7000-8000-000000000099',17,'collection',0,'safe','2026-10-20T00:00:00Z')`)
    .run()
  const recordId = '01990000-0000-7000-8000-000000000017'
  enqueuePullRequestCi(database, recordId)
  const secret = 'ghp_123456789012345678901234567890123456'
  database.query('UPDATE pull_request_ci SET error=? WHERE record_id=?').run(secret, recordId)
  enqueuePullRequestCi(database, recordId)
  const refreshed = database.query<{ payload: string }, []>('SELECT payload FROM outbox').get()!
  expect(refreshed.payload).not.toContain(secret)
  expect(JSON.parse(refreshed.payload)).toMatchObject({
    error: '[withheld: provider-prefix]',
    withheldFields: ['error'],
  })

  database.query("UPDATE outbox SET quarantined_at='2026-10-20T01:00:00Z'").run()
  enqueuePullRequestCi(database, recordId)
  database
    .query("UPDATE outbox SET retired_at='2026-10-20T02:00:00Z' WHERE quarantined_at IS NULL")
    .run()
  enqueuePullRequestCi(database, recordId)
  expect(
    database.query<{ count: number }, []>('SELECT count(*) AS count FROM outbox').get()!.count,
  ).toBe(3)
  database.close()
})
