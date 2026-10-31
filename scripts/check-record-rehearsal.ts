#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nulPathListArgs, splitNulPaths } from '../shared/git-path-list.ts'
import { recordMigrationSetHashFrom } from './record-migration-set.ts'
import {
  RECORD_REHEARSAL_STATUS_CONTEXT,
  recordRehearsalDescription,
} from './record-rehearsal-status.ts'

export type CommitStatus = { context: string; state: string; description: string | null }

export type RecordRehearsalDecision =
  | { pass: true; message: string }
  | { pass: false; message: string }

const remedy = 'run bun scripts/record-rehearse.ts'

export function mergeGroupPullRequest(headRef: string): number | null {
  const match = /^(?:refs\/heads\/)?gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]+$/.exec(headRef)
  return match?.[1] ? Number(match[1]) : null
}

export function decideRecordRehearsal(input: {
  migrationChanged: boolean
  migrationSetHash: string
  currentHeadStatuses: readonly CommitStatus[]
  earlierHeadStatuses: readonly CommitStatus[]
}): RecordRehearsalDecision {
  if (!input.migrationChanged)
    return { pass: true, message: 'record rehearsal: no migration change' }
  const statuses = [...input.currentHeadStatuses, ...input.earlierHeadStatuses].filter(
    (status) => status.context === RECORD_REHEARSAL_STATUS_CONTEXT,
  )
  if (!statuses.length)
    return { pass: false, message: `record rehearsal status is missing; ${remedy}` }
  const successfulDescriptions = statuses
    .filter((status) => status.state === 'success')
    .map((status) => recordRehearsalDescription.parse(status.description ?? ''))
  const matching = successfulDescriptions.find(
    (description) => description?.hash === input.migrationSetHash && description.pending >= 1,
  )
  if (matching)
    return {
      pass: true,
      message: `record rehearsal: migration-set ${input.migrationSetHash} passed`,
    }
  const sameHash = successfulDescriptions.find(
    (description) => description?.hash === input.migrationSetHash,
  )
  if (sameHash?.pending === 0) {
    return {
      pass: false,
      message: `record rehearsal applied no pending migration; ${remedy}`,
    }
  }
  if (successfulDescriptions.length) {
    return {
      pass: false,
      message: `record rehearsal migration-set hash differs from the checked-out tree; a migration may have landed on trunk, so ${remedy} again`,
    }
  }
  const status = statuses[0]!
  return {
    pass: false,
    message: `record rehearsal status is ${status.state}, not success; ${remedy}`,
  }
}

type GitHubEvent = {
  number?: number
  pull_request?: { base?: { sha?: string }; head?: { sha?: string } }
  merge_group?: { base_sha?: string; head_ref?: string }
}

function command(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString().trim()
}

function eventPullRequest(
  event: GitHubEvent,
  repository: string,
): { number: number; headSha: string } {
  if (event.pull_request?.head?.sha && event.number)
    return { number: event.number, headSha: event.pull_request.head.sha }
  const headRef = event.merge_group?.head_ref
  const number = headRef ? mergeGroupPullRequest(headRef) : null
  if (!number)
    throw new Error(`merge group head_ref does not name a pull request: ${headRef ?? '<missing>'}`)
  const headSha = command(['gh', 'api', `repos/${repository}/pulls/${number}`, '--jq', '.head.sha'])
  return { number, headSha }
}

function earlierHeadStatuses(
  pullRequest: { number: number; headSha: string },
  repository: string,
): CommitStatus[] {
  const commits = command([
    'gh',
    'api',
    '--paginate',
    `repos/${repository}/pulls/${pullRequest.number}/commits`,
    '--jq',
    '.[].sha',
  ])
    .split('\n')
    .filter((sha) => sha && sha !== pullRequest.headSha)
  return commits.flatMap(
    (sha) =>
      JSON.parse(
        command(['gh', 'api', `repos/${repository}/commits/${sha}/statuses`]),
      ) as CommitStatus[],
  )
}

if (import.meta.main) {
  try {
    const eventPath = process.env.GITHUB_EVENT_PATH
    const repository = process.env.GITHUB_REPOSITORY
    if (!eventPath || !repository)
      throw new Error('GITHUB_EVENT_PATH and GITHUB_REPOSITORY are required')
    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as GitHubEvent
    const baseSha = event.pull_request?.base?.sha ?? event.merge_group?.base_sha
    if (!baseSha)
      throw new Error('GitHub event does not carry a pull request or merge-group base sha')
    const changed = splitNulPaths(
      command(nulPathListArgs(['git', 'diff', '--name-only', `${baseSha}...HEAD`])),
    ).some((path) => path.startsWith('shared/record/migrations/'))
    let currentHeadStatuses: CommitStatus[] = []
    let priorStatuses: CommitStatus[] = []
    if (changed) {
      const pullRequest = eventPullRequest(event, repository)
      currentHeadStatuses = JSON.parse(
        command(['gh', 'api', `repos/${repository}/commits/${pullRequest.headSha}/statuses`]),
      ) as CommitStatus[]
      priorStatuses = earlierHeadStatuses(pullRequest, repository)
    }
    const root = fileURLToPath(new URL('..', import.meta.url))
    const decision = decideRecordRehearsal({
      migrationChanged: changed,
      migrationSetHash: recordMigrationSetHashFrom(join(root, 'shared', 'record', 'migrations')),
      currentHeadStatuses,
      earlierHeadStatuses: priorStatuses,
    })
    console[decision.pass ? 'log' : 'error'](decision.message)
    if (!decision.pass) process.exitCode = 1
  } catch (error) {
    console.error(
      `record rehearsal check failed: ${error instanceof Error ? error.message : String(error)}; ${remedy}`,
    )
    process.exitCode = 1
  }
}
