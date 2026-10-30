#!/usr/bin/env bun
import { PLATFORM_SLUG } from '../shared/brand.ts'

const REHEARSAL_APP = `${PLATFORM_SLUG}-record-backup`
const REHEARSAL_VM_SIZE = 'shared-cpu-1x'
const REHEARSAL_VM_MEMORY_MB = '1024'
const REHEARSAL_WAIT_TIMEOUT_MS = 20 * 60 * 1000
const GITHUB_STATUS_DESCRIPTION_LIMIT = 140

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
  hash?: string
  failure?: string
}

export function parseRehearsalLines(output: string): RehearsalLines {
  const value = (prefix: string) => {
    for (const line of output.split('\n')) {
      const start = line.indexOf(prefix)
      if (start >= 0) return line.slice(start + prefix.length).trim()
    }
    return undefined
  }
  const number = (prefix: string) => Number(value(prefix))
  const lines: RehearsalLines = {
    dump: value('REHEARSAL DUMP ') ?? '',
    pending: number('REHEARSAL PENDING '),
    restoreMs: number('REHEARSAL RESTORE '),
    migrateMs: number('REHEARSAL MIGRATE '),
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
): {
  state: 'success' | 'failure'
  description: string
} {
  const passed =
    exitCode === 0 &&
    Boolean(lines.hash?.match(/^[0-9a-f]{64}$/)) &&
    lines.dump.length > 0 &&
    Number.isFinite(lines.restoreMs) &&
    Number.isFinite(lines.migrateMs)
  const description = passed
    ? `migration-set ${lines.hash}; restore ${lines.restoreMs}; migrate ${lines.migrateMs}; dump ${lines.dump}`
    : `REHEARSAL FAIL ${lines.failure ?? `machine exit ${exitCode ?? 'unknown'} without a valid PASS`}`
  return {
    state: passed ? 'success' : 'failure',
    description: description.slice(0, GITHUB_STATUS_DESCRIPTION_LIMIT),
  }
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
  const child = Bun.spawn(argv, {
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
    `context=record-rehearsal`,
    '--raw-field',
    `state=${status.state}`,
    '--raw-field',
    `description=${status.description}`,
  ]
  checked(await runner(argv), argv)
}

function runMachineArgv(): string[] {
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
    '--vm-size',
    REHEARSAL_VM_SIZE,
    '--vm-memory',
    REHEARSAL_VM_MEMORY_MB,
  ]
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
  const headArgv = ['git', 'rev-parse', 'HEAD']
  const sha = checked(await input.runner(headArgv), headArgv)
  const flyEnv = { FLY_API_TOKEN: input.token }
  let statusPosted = false
  let machineId: string | null = null
  let result: RehearsalLines | undefined
  let failure: unknown
  try {
    const runArgv = runMachineArgv()
    const runResult = await input.runner(runArgv, {
      env: flyEnv,
      timeoutMs: REHEARSAL_WAIT_TIMEOUT_MS,
    })
    machineId = launchedMachineId(`${runResult.stdout}\n${runResult.stderr}`)
    checked(runResult, runArgv)
    if (!machineId) throw new Error('flyctl machine run did not report the launched Machine ID')
    const waitArgv = [
      'flyctl',
      'machine',
      'wait',
      machineId,
      '--app',
      REHEARSAL_APP,
      '--state',
      'stopped',
      '--wait-timeout',
      `${REHEARSAL_WAIT_TIMEOUT_MS / 1000}s`,
    ]
    checked(
      await input.runner(waitArgv, { env: flyEnv, timeoutMs: REHEARSAL_WAIT_TIMEOUT_MS + 30_000 }),
      waitArgv,
    )
    const details = await input.machineDetails(machineId, input.token)
    const logsArgv = ['flyctl', 'logs', '--app', REHEARSAL_APP, '--no-tail', '--machine', machineId]
    const logs = checked(await input.runner(logsArgv, { env: flyEnv }), logsArgv)
    const lines = parseRehearsalLines(logs)
    const status = rehearsalStatus(lines, machineExitCode(details))
    await postStatus(input.runner, sha, status)
    statusPosted = true
    if (status.state === 'failure') throw new Error(status.description)
    result = lines
  } catch (error) {
    if (!statusPosted) {
      const message = error instanceof Error ? error.message : String(error)
      await postStatus(input.runner, sha, {
        state: 'failure',
        description: `REHEARSAL FAIL ${message}`.slice(0, GITHUB_STATUS_DESCRIPTION_LIMIT),
      })
    }
    failure = error
  } finally {
    if (machineId) {
      const destroyArgv = [
        'flyctl',
        'machine',
        'destroy',
        machineId,
        '--app',
        REHEARSAL_APP,
        '--force',
      ]
      const destroyed = await input.runner(destroyArgv, { env: flyEnv })
      if (destroyed.exitCode !== 0)
        failure = new Error(
          `record rehearsal cleanup failed: ${destroyed.stderr.trim() || destroyed.stdout.trim()}`,
        )
    }
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
  } catch (error) {
    console.error(
      `record rehearsal failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
