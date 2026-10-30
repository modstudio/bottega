#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  statuses: readonly CommitStatus[]
}): RecordRehearsalDecision {
  if (!input.migrationChanged)
    return { pass: true, message: 'record rehearsal: no migration change' }
  const status = input.statuses.find(
    (candidate) => candidate.context === RECORD_REHEARSAL_STATUS_CONTEXT,
  )
  if (!status) return { pass: false, message: `record rehearsal status is missing; ${remedy}` }
  if (status.state !== 'success') {
    return {
      pass: false,
      message: `record rehearsal status is ${status.state}, not success; ${remedy}`,
    }
  }
  const description = recordRehearsalDescription.parse(status.description ?? '')
  if (description?.hash !== input.migrationSetHash) {
    return {
      pass: false,
      message: `record rehearsal migration-set hash differs from the checked-out tree; a migration may have landed on trunk, so ${remedy} again`,
    }
  }
  if (description.pending < 1) {
    return {
      pass: false,
      message: `record rehearsal applied no pending migration; ${remedy}`,
    }
  }
  return { pass: true, message: `record rehearsal: migration-set ${input.migrationSetHash} passed` }
}

type GitHubEvent = {
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

function headSha(event: GitHubEvent, repository: string): string {
  if (event.pull_request?.head?.sha) return event.pull_request.head.sha
  const headRef = event.merge_group?.head_ref
  const pullRequest = headRef ? mergeGroupPullRequest(headRef) : null
  if (!pullRequest)
    throw new Error(`merge group head_ref does not name a pull request: ${headRef ?? '<missing>'}`)
  return command(['gh', 'api', `repos/${repository}/pulls/${pullRequest}`, '--jq', '.head.sha'])
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
    const changed = command(['git', 'diff', '--name-only', `${baseSha}...HEAD`])
      .split('\n')
      .some((path) => path.startsWith('shared/record/migrations/'))
    let statuses: CommitStatus[] = []
    if (changed) {
      statuses = JSON.parse(
        command([
          'gh',
          'api',
          `repos/${repository}/commits/${headSha(event, repository)}/statuses`,
        ]),
      ) as CommitStatus[]
    }
    const root = fileURLToPath(new URL('..', import.meta.url))
    const decision = decideRecordRehearsal({
      migrationChanged: changed,
      migrationSetHash: recordMigrationSetHashFrom(join(root, 'shared', 'record', 'migrations')),
      statuses,
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
