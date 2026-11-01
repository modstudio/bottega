#!/usr/bin/env bun
import { PLATFORM_SLUG } from '../shared/brand.ts'
import {
  RECORD_REHEARSAL_STATUS_CONTEXT,
  recordRehearsalDescription,
} from './record-rehearsal-status.ts'

const REHEARSAL_APP = `${PLATFORM_SLUG}-record-backup`
const REHEARSAL_VM_SIZE = 'shared-cpu-1x'
const REHEARSAL_VM_MEMORY_MB = '1024'
const REHEARSAL_WAIT_TIMEOUT_MS = 20 * 60 * 1000
const FLY_WAIT_TIMEOUT_SECONDS = 60
const GITHUB_STATUS_DESCRIPTION_LIMIT = 140
export const REHEARSAL_NOTICE_LIMIT = 20

const tokenName = `${PLATFORM_SLUG.toUpperCase()}_RECORD_REHEARSAL_FLY_TOKEN`
const sealingCommand = `${PLATFORM_SLUG} machine config secret run --name ${tokenName} -- bun scripts/record-rehearse.ts`

type CommandResult = { exitCode: number; stdout: string; stderr: string }
export type RehearsalCommandRunner = (
  argv: readonly string[],
  options?: { env?: Record<string, string>; timeoutMs?: number },
) => Promise<CommandResult>

export type RehearsalLines = {
  dump: string
  pending: number
  restoreMs: number
  migrateMs: number
  notices: string[]
  noticesTruncated: number
  hash?: string
  failure?: string
}

export function parseRehearsalLines(output: string): RehearsalLines {
  const outputLines = output.split('\n')
  const value = (prefix: string) => {
    for (const line of outputLines) {
      const start = line.indexOf(prefix)
      if (start >= 0) return line.slice(start + prefix.length).trim()
    }
    return undefined
  }
  const number = (prefix: string) => Number(value(prefix))
  const notices = outputLines.flatMap((line) => {
    const start = line.indexOf('REHEARSAL NOTICE ')
    return start >= 0 ? [line.slice(start + 'REHEARSAL NOTICE '.length).trim()] : []
  })
  const lines: RehearsalLines = {
    dump: value('REHEARSAL DUMP ') ?? '',
    pending: number('REHEARSAL PENDING '),
    restoreMs: number('REHEARSAL RESTORE '),
    migrateMs: number('REHEARSAL MIGRATE '),
    notices: notices.slice(0, REHEARSAL_NOTICE_LIMIT),
    noticesTruncated:
      (number('REHEARSAL NOTICE-TRUNCATED ') || 0) +
      Math.max(0, notices.length - REHEARSAL_NOTICE_LIMIT),
  }
  const hash = value('REHEARSAL PASS ')
  const failure = value('REHEARSAL FAIL ')
  if (hash) lines.hash = hash
  if (failure) lines.failure = failure
  return lines
}

export function machineExitCode(machine: unknown): number | null {
  if (!machine || typeof machine !== 'object' || !('events' in machine)) return null
  const events = (machine as { events?: unknown }).events
  if (!Array.isArray(events)) return null
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const exitCode = (event as { request?: { exit_event?: { exit_code?: unknown } } }).request
      ?.exit_event?.exit_code
    if (typeof exitCode === 'number') return exitCode
  }
  return null
}

export function launchedMachineId(output: string): string | null {
  return /\bMachine ID:\s*([0-9a-f]{14,})\b/i.exec(output)?.[1] ?? null
}

export function rehearsalStatus(
  lines: RehearsalLines,
  exitCode: number | null,
):
  | { state: 'success'; description: string; notices: string[]; noticesTruncated: number }
  | {
      state: 'failure'
      description: string
      failure: string
      notices: string[]
      noticesTruncated: number
    } {
  const passed =
    exitCode === 0 &&
    Boolean(lines.hash?.match(/^[0-9a-f]{64}$/)) &&
    Number.isInteger(lines.pending) &&
    lines.pending > 0 &&
    lines.dump.length > 0 &&
    Number.isFinite(lines.restoreMs) &&
    Number.isFinite(lines.migrateMs)
  const description = passed
    ? recordRehearsalDescription.format({
        hash: lines.hash!,
        pending: lines.pending,
        restoreMs: lines.restoreMs,
        migrateMs: lines.migrateMs,
        dump: lines.dump,
      })
    : `REHEARSAL FAIL ${lines.failure ?? `machine exit ${exitCode ?? 'unknown'} without a valid PASS`}`
  if (passed) {
    return {
      state: 'success',
      description: description.slice(0, GITHUB_STATUS_DESCRIPTION_LIMIT),
      notices: lines.notices,
      noticesTruncated: lines.noticesTruncated,
    }
  }
  return {
    state: 'failure',
    description: description.slice(0, GITHUB_STATUS_DESCRIPTION_LIMIT),
    failure: description,
    notices: lines.notices,
    noticesTruncated: lines.noticesTruncated,
  }
}

export function renderRehearsalNotices(lines: RehearsalLines): string[] {
  if (lines.notices.length === 0 && lines.noticesTruncated === 0) return ['notices: none']
  const rendered = ['notices:', ...lines.notices]
  if (lines.noticesTruncated > 0) {
    rendered.push(`NOTICE-TRUNCATED ${lines.noticesTruncated}`)
  }
  return rendered
}

function checked(result: CommandResult, argv: readonly string[]): string {
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  return result.stdout.trim()
}

async function realCommandRunner(
  argv: readonly string[],
  options: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env },
  })
  let timedOut = false
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        child.kill()
      }, options.timeoutMs)
    : undefined
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (timer) clearTimeout(timer)
  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout,
    stderr: timedOut ? `timed out after ${options.timeoutMs}ms\n${stderr}` : stderr,
  }
}

async function realMachineDetails(machineId: string, token: string): Promise<unknown> {
  const response = await fetch(
    `https://api.machines.dev/v1/apps/${REHEARSAL_APP}/machines/${machineId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  )
  if (!response.ok)
    throw new Error(`Machines API returned ${response.status} ${response.statusText}`)
  return response.json()
}

async function postStatus(
  runner: RehearsalCommandRunner,
  sha: string,
  status: { state: 'success' | 'failure'; description: string },
): Promise<void> {
  const argv = [
    'gh',
    'api',
    `repos/{owner}/{repo}/statuses/${sha}`,
    '--method',
    'POST',
    '--raw-field',
    `context=${RECORD_REHEARSAL_STATUS_CONTEXT}`,
    '--raw-field',
    `state=${status.state}`,
    '--raw-field',
    `description=${status.description}`,
  ]
  checked(await runner(argv), argv)
}

export async function rerunFailedRecordRehearsal(
  runner: RehearsalCommandRunner,
  sha: string,
): Promise<void> {
  const pullArgv = [
    'gh',
    'api',
    '--paginate',
    'repos/{owner}/{repo}/pulls?state=open&per_page=100',
    '--jq',
    `.[] | select(.head.sha == "${sha}") | .number`,
  ]
  const pullRequest = checked(await runner(pullArgv), pullArgv)
    .split('\n')
    .find(Boolean)
  if (!pullRequest) return
  const checksArgv = [
    'gh',
    'api',
    '--paginate',
    `repos/{owner}/{repo}/commits/${sha}/check-runs`,
    '--jq',
    `.check_runs[] | select(.name == "${RECORD_REHEARSAL_STATUS_CONTEXT}") | [.id, .conclusion, .details_url] | @tsv`,
  ]
  const latest = checked(await runner(checksArgv), checksArgv)
    .split('\n')
    .find(Boolean)
  if (!latest) return
  const [jobId, conclusion, detailsUrl] = latest.split('\t')
  const runId = /\/actions\/runs\/(\d+)\/job\//.exec(detailsUrl ?? '')?.[1]
  if (!conclusion || !['failure', 'cancelled', 'timed_out'].includes(conclusion)) return
  if (!jobId || !runId) return
  const rerunArgv = ['gh', 'run', 'rerun', runId, '--job', jobId]
  const outcome = checked(await runner(rerunArgv), rerunArgv)
  console.log(
    `record rehearsal rerun requested after ${conclusion} for pull request ${pullRequest}, run ${runId}, job ${jobId}${outcome ? `: ${outcome}` : ''}`,
  )
}

function runMachineArgv(machineName: string): string[] {
  return [
    'flyctl',
    'machine',
    'run',
    '.',
    '--dockerfile',
    'orchestrator/deploy/backup/rehearse.Dockerfile',
    '--app',
    REHEARSAL_APP,
    '--restart',
    'no',
    '--name',
    machineName,
    '--vm-size',
    REHEARSAL_VM_SIZE,
    '--vm-memory',
    REHEARSAL_VM_MEMORY_MB,
  ]
}

async function cleanupMachine(
  runner: RehearsalCommandRunner,
  machineName: string,
  knownMachineId: string | null,
  flyEnv: Record<string, string>,
): Promise<Error | undefined> {
  let machineId = knownMachineId
  if (!machineId) {
    const listArgv = ['flyctl', 'machine', 'list', '--app', REHEARSAL_APP, '--json']
    const listed = await runner(listArgv, { env: flyEnv })
    if (listed.exitCode !== 0) {
      return new Error(
        `record rehearsal cleanup could not find ${machineName}: ${listed.stderr.trim() || listed.stdout.trim()}`,
      )
    }
    try {
      const machines = JSON.parse(listed.stdout) as Array<{ id?: unknown; name?: unknown }>
      const machine = machines.find((candidate) => candidate.name === machineName)
      if (typeof machine?.id === 'string') machineId = machine.id
    } catch {
      return new Error(`record rehearsal cleanup could not parse machine list for ${machineName}`)
    }
  }
  if (!machineId) return undefined
  const destroyArgv = ['flyctl', 'machine', 'destroy', machineId, '--app', REHEARSAL_APP, '--force']
  const destroyed = await runner(destroyArgv, { env: flyEnv })
  if (destroyed.exitCode === 0) return undefined
  return new Error(
    `record rehearsal cleanup failed for ${machineName} (${machineId}): ${destroyed.stderr.trim() || destroyed.stdout.trim()}`,
  )
}

async function waitForMachineToStop(
  runner: RehearsalCommandRunner,
  machineId: string,
  flyEnv: Record<string, string>,
): Promise<void> {
  const startedAt = Date.now()
  while (true) {
    const argv = [
      'flyctl',
      'machine',
      'wait',
      machineId,
      '--app',
      REHEARSAL_APP,
      '--state',
      'stopped',
      '--wait-timeout',
      `${FLY_WAIT_TIMEOUT_SECONDS}s`,
    ]
    const result = await runner(argv, {
      env: flyEnv,
      timeoutMs: (FLY_WAIT_TIMEOUT_SECONDS + 30) * 1000,
    })
    if (result.exitCode === 0) return
    const output = `${result.stdout}\n${result.stderr}`
    if (
      !output.includes('deadline_exceeded') ||
      Date.now() - startedAt >= REHEARSAL_WAIT_TIMEOUT_MS
    ) {
      checked(result, argv)
    }
  }
}

async function remoteHead(runner: RehearsalCommandRunner): Promise<string> {
  const headArgv = ['git', 'rev-parse', 'HEAD']
  const sha = checked(await runner(headArgv), headArgv)
  const branchArgv = ['git', 'branch', '--show-current']
  const branch = checked(await runner(branchArgv), branchArgv)
  const remoteContainsArgv = ['git', 'branch', '--remotes', '--contains', sha]
  const remoteContains = checked(await runner(remoteContainsArgv), remoteContainsArgv)
  if (!remoteContains.split('\n').some((line) => line.trim().startsWith('origin/'))) {
    throw new Error(
      `record rehearsal refuses HEAD because it is not on origin; run: git push -u origin ${branch}`,
    )
  }
  return sha
}

async function rehearsalFailure(
  runner: RehearsalCommandRunner,
  sha: string,
  machineName: string,
  error: unknown,
  statusPosted: boolean,
): Promise<Error> {
  const originalMessage = `machine ${machineName}: ${error instanceof Error ? error.message : String(error)}`
  if (statusPosted) return new Error(originalMessage)
  try {
    await postStatus(runner, sha, {
      state: 'failure',
      description: `REHEARSAL FAIL ${originalMessage}`.slice(0, GITHUB_STATUS_DESCRIPTION_LIMIT),
    })
    return new Error(originalMessage)
  } catch (postError) {
    const postMessage = postError instanceof Error ? postError.message : String(postError)
    return new Error(`${originalMessage}; status post failed: ${postMessage}`)
  }
}

export async function runRecordRehearsal(input: {
  token: string
  runner: RehearsalCommandRunner
  machineDetails: (machineId: string, token: string) => Promise<unknown>
}): Promise<RehearsalLines> {
  const gitStatusArgv = ['git', 'status', '--porcelain']
  if (checked(await input.runner(gitStatusArgv), gitStatusArgv)) {
    throw new Error('record rehearsal refuses a dirty working tree; commit the tree and rerun it')
  }
  const sha = await remoteHead(input.runner)
  const machineName = `record-rehearsal-${sha.slice(0, 8)}-${Date.now()}`
  const flyEnv = { FLY_API_TOKEN: input.token }
  let statusPosted = false
  let machineId: string | null = null
  let result: RehearsalLines | undefined
  let failure: unknown
  try {
    const runArgv = runMachineArgv(machineName)
    const runResult = await input.runner(runArgv, {
      env: flyEnv,
      timeoutMs: REHEARSAL_WAIT_TIMEOUT_MS,
    })
    machineId = launchedMachineId(`${runResult.stdout}\n${runResult.stderr}`)
    checked(runResult, runArgv)
    if (!machineId)
      throw new Error(
        `flyctl machine run did not report the launched Machine ID for ${machineName}`,
      )
    await waitForMachineToStop(input.runner, machineId, flyEnv)
    const details = await input.machineDetails(machineId, input.token)
    const logsArgv = ['flyctl', 'logs', '--app', REHEARSAL_APP, '--no-tail', '--machine', machineId]
    const logs = checked(await input.runner(logsArgv, { env: flyEnv }), logsArgv)
    const lines = parseRehearsalLines(logs)
    const status = rehearsalStatus(lines, machineExitCode(details))
    await postStatus(input.runner, sha, status)
    statusPosted = true
    if (status.state === 'failure') throw new Error(status.failure)
    try {
      await rerunFailedRecordRehearsal(input.runner, sha)
    } catch (rerunError) {
      const detail = rerunError instanceof Error ? rerunError.message : String(rerunError)
      const retryCommand = /gh run rerun \d+ --job \d+/.exec(detail)?.[0]
      console.error(
        `record rehearsal passed; rerun request failed: ${detail}${retryCommand ? `; rerun it with ${retryCommand}` : ''}`,
      )
    }
    result = lines
  } catch (error) {
    failure = await rehearsalFailure(input.runner, sha, machineName, error, statusPosted)
  } finally {
    failure = (await cleanupMachine(input.runner, machineName, machineId, flyEnv)) ?? failure
  }
  if (failure) throw failure
  if (!result) throw new Error('record rehearsal finished without a result')
  return result
}

if (import.meta.main) {
  const token = process.env[tokenName]
  if (!token) {
    console.error(
      `${tokenName} is required. Ask the operator to seal the app-scoped token, then run: ${sealingCommand}`,
    )
    process.exit(1)
  }
  try {
    const lines = await runRecordRehearsal({
      token,
      runner: realCommandRunner,
      machineDetails: realMachineDetails,
    })
    console.log(`record rehearsal passed migration-set ${lines.hash}`)
    for (const line of renderRehearsalNotices(lines)) console.log(line)
  } catch (error) {
    console.error(
      `record rehearsal failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
