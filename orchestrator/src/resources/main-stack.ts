// concern: main-checkout Docker stack adapter

import type { Database } from 'bun:sqlite'
import { pidAlive } from '../../../shared/process-identity.ts'
import { nowIso, SESSION_LIVE_MS, writableDb, writeTransaction } from '../database/db.ts'
import type { MainStackConsumer } from '../project/project-settings.ts'
import type { Project } from '../project/projects.ts'
import { recordedRunLivenessFacts, runAlive } from '../run/run-alive.ts'
import { runLeaseState } from '../run/run-lease.ts'
import {
  decideMainStackEnsure,
  decideMainStackIdleStop,
  decideMainStackStopGuard,
  newlyStartedMainStackServices,
} from './main-stack-decision.ts'

export const MAIN_STACK_IDLE_STOP_AFTER_MS_DEFAULT = 4 * 60 * 60 * 1_000
const MAIN_STACK_IDLE_STOP_AFTER_KEY = 'BOTTEGA_MAIN_STACK_IDLE_STOP_AFTER_MS'
const MAIN_STACK_COMMAND_TIMEOUT_MS = 120_000

type CommandResult = { ok: true; output: string } | { ok: false; reason: string }

function dockerCompose(cwd: string, args: string[]): CommandResult {
  const command = ['docker', 'compose', ...args]
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(command, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: MAIN_STACK_COMMAND_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, reason: `${command.join(' ')} failed: ${(error as Error).message}` }
  }
  if (result.exitedDueToTimeout) {
    return {
      ok: false,
      reason: `${command.join(' ')} failed: timed out after ${MAIN_STACK_COMMAND_TIMEOUT_MS}ms`,
    }
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `${command.join(' ')} failed: ${result.stderr?.toString().trim() || `exit ${result.exitCode}`}`,
    }
  }
  return { ok: true, output: result.stdout?.toString().trim() ?? '' }
}

export function mainStackIdleStopAfterMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[MAIN_STACK_IDLE_STOP_AFTER_KEY]
  if (raw === undefined || raw === '') return MAIN_STACK_IDLE_STOP_AFTER_MS_DEFAULT
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${MAIN_STACK_IDLE_STOP_AFTER_KEY} must be a positive number of milliseconds`)
  }
  return value
}

function startMissingMainStackServices(input: {
  projectName: string
  projectPath: string
  consumer: MainStackConsumer
  decision: ReturnType<typeof decideMainStackEnsure>
  observed: Extract<CommandResult, { ok: true }>
  required?: string[]
  remedy: string
}): string[] {
  if (input.decision !== 'start-stack' && input.decision !== 'start-services') return []
  const started = dockerCompose(input.projectPath, [
    'up',
    '-d',
    '--wait',
    ...(input.decision === 'start-services' ? (input.required ?? []) : []),
  ])
  if (!started.ok)
    throw new Error(
      `main stack for ${input.projectName}, required by ${input.consumer}, did not become healthy from registered main checkout ${input.projectPath}: ${started.reason}; run ${input.remedy} there, then retry`,
    )
  let after: string[] | undefined
  if (input.decision === 'start-stack') {
    const confirmed = dockerCompose(input.projectPath, ['ps', '--status', 'running', '--services'])
    if (!confirmed.ok) {
      const stopped = dockerCompose(input.projectPath, ['stop'])
      throw new Error(
        `main stack for ${input.projectName}, required by ${input.consumer}, started but its newly started services could not be identified: ${confirmed.reason}; ${
          stopped.ok
            ? 'the newly started stack was stopped'
            : `stopping it also failed: ${stopped.reason}`
        }; run ${input.remedy} there, then retry`,
      )
    }
    after = confirmed.output.split('\n').filter(Boolean)
  }
  return newlyStartedMainStackServices({
    decision: input.decision,
    before: input.observed.output.split('\n').filter(Boolean),
    requiredServices: input.required,
    after,
  })
}

/** Start a declared consumer's main stack before the consumer runs. */
export function ensureMainStackStarted(input: {
  projectId: string
  projectName: string
  projectPath: string
  declaration: { consumers: MainStackConsumer[]; requiredServices?: string[] } | undefined
  consumer: MainStackConsumer
  database?: Database
}): { startedServices: string[] } {
  if (!input.declaration?.consumers.includes(input.consumer)) return { startedServices: [] }
  const required = input.declaration.requiredServices
  const observed = dockerCompose(input.projectPath, [
    'ps',
    '--status',
    'running',
    '--services',
    ...(required ?? []),
  ])
  const decision = decideMainStackEnsure({
    consumer: input.consumer,
    declaration: input.declaration,
    observed: observed.ok
      ? { runningServices: observed.output.split('\n').filter(Boolean) }
      : 'unknown',
  })
  const command = ['docker', 'compose', 'up', '-d', '--wait', ...(required ?? [])].join(' ')
  if (decision === 'refuse') {
    throw new Error(
      `cannot ascertain main stack for ${input.projectName}, required by ${input.consumer}, from registered main checkout ${input.projectPath}: ${observed.ok ? 'unknown state' : observed.reason}; run ${command} there, then retry`,
    )
  }
  if (!observed.ok) throw new Error(`main stack observation unexpectedly remained unavailable`)
  const startedServices = startMissingMainStackServices({
    projectName: input.projectName,
    projectPath: input.projectPath,
    consumer: input.consumer,
    decision,
    observed,
    required,
    remedy: command,
  })
  if (!input.projectId) return { startedServices }
  try {
    const database = input.database ?? writableDb()
    writeTransaction(() => {
      database
        .query(
          `INSERT INTO main_stack_activity (project_record_id,last_ensured_at) VALUES (?,?)
           ON CONFLICT(project_record_id) DO UPDATE SET last_ensured_at=excluded.last_ensured_at`,
        )
        .run(input.projectId, nowIso())
    }, database)
  } catch {
    // The stack is already available. Missing activity only shortens its idle lease.
  }
  return { startedServices }
}

/** Stop only services returned by this consumer's ensure call. */
export function stopMainStackServices(input: {
  projectId: string
  projectName: string
  projectPath: string
  consumer: MainStackConsumer
  startedServices: readonly string[]
  database?: Database
  nowMs?: number
}): { outcome: 'none' | 'stopped' | 'deferred'; detail?: string } {
  if (input.startedServices.length === 0) return { outcome: 'none' }
  const database = input.database ?? writableDb()
  const nowMs = input.nowMs ?? Date.now()
  let activity: ReturnType<typeof latestActivity>
  try {
    activity = latestActivity(database, input.projectId, nowMs)
  } catch (error) {
    return {
      outcome: 'deferred',
      detail: `main stack services started for ${input.projectName} ${input.consumer} were left running for the idle sweep because liveness could not be ascertained: ${(error as Error).message}`,
    }
  }
  const execObservation = mainStackExecInProgress(input.projectPath)
  const decision = decideMainStackStopGuard({
    execInProgress: execObservation.value,
    liveRun: activity.liveRun,
    liveSession: activity.liveSession,
  })
  if (decision !== 'stop') {
    const reason =
      execObservation.value === 'unknown'
        ? `Docker command activity could not be ascertained: ${execObservation.reason}`
        : execObservation.value
          ? 'a Docker exec is in progress'
          : activity.liveRun
            ? 'a run is running or asking'
            : 'an architect session is live'
    return {
      outcome: 'deferred',
      detail: `main stack services started for ${input.projectName} ${input.consumer} were left running for the idle sweep because ${reason}`,
    }
  }
  const stopped = dockerCompose(input.projectPath, ['stop', ...input.startedServices])
  if (stopped.ok) return { outcome: 'stopped' }
  const command = ['docker', 'compose', 'stop', ...input.startedServices].join(' ')
  throw new Error(
    `main stack services started for ${input.projectName} ${input.consumer} could not be stopped: ${stopped.reason}; run ${command} in ${input.projectPath}, then retry`,
  )
}

export function ensureProjectMainStack(
  project: Project,
  consumer: MainStackConsumer,
  database?: Database,
): { startedServices: string[] } {
  return ensureMainStackStarted({
    projectId: project.recordId,
    projectName: project.name,
    projectPath: project.path,
    declaration: project.settings.mainStack,
    consumer,
    database,
  })
}

function runningMainStackPaths(): CommandResult {
  let result: ReturnType<typeof Bun.spawnSync>
  const command = [
    'docker',
    'ps',
    '--format',
    '{{.Label "com.docker.compose.project.working_dir"}}',
  ]
  try {
    result = Bun.spawnSync(command, {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: MAIN_STACK_COMMAND_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, reason: `main stack inventory unavailable: ${(error as Error).message}` }
  }
  if (result.exitCode !== 0 || result.exitedDueToTimeout) {
    return {
      ok: false,
      reason: `main stack inventory unavailable: ${result.stderr?.toString().trim() || 'timed out'}`,
    }
  }
  return { ok: true, output: result.stdout?.toString() ?? '' }
}

export function mainStackExecInProgress(
  projectPath: string,
): { value: boolean } | { value: 'unknown'; reason: string } {
  const containers = dockerCompose(projectPath, ['ps', '--status', 'running', '-q'])
  if (!containers.ok) return { value: 'unknown', reason: containers.reason }
  const ids = containers.output.split('\n').filter(Boolean)
  if (ids.length === 0) return { value: false }

  const command = ['docker', 'inspect', '-f', '{{json .ExecIDs}}', ...ids]
  let result: ReturnType<typeof Bun.spawnSync>
  try {
    result = Bun.spawnSync(command, {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: MAIN_STACK_COMMAND_TIMEOUT_MS,
    })
  } catch (error) {
    return { value: 'unknown', reason: `${command.join(' ')} failed: ${(error as Error).message}` }
  }
  if (result.exitedDueToTimeout) {
    return {
      value: 'unknown',
      reason: `${command.join(' ')} failed: timed out after ${MAIN_STACK_COMMAND_TIMEOUT_MS}ms`,
    }
  }
  if (result.exitCode !== 0) {
    return {
      value: 'unknown',
      reason: `${command.join(' ')} failed: ${result.stderr?.toString().trim() || `exit ${result.exitCode}`}`,
    }
  }
  try {
    const execIds = (result.stdout?.toString() ?? '')
      .trim()
      .split('\n')
      // A container that has never had an exec reports `null`, not `[]`.
      .map((line) => JSON.parse(line) ?? [])
    if (execIds.length !== ids.length || execIds.some((entry) => !Array.isArray(entry))) {
      return { value: 'unknown', reason: `${command.join(' ')} failed: unparseable output` }
    }
    return { value: execIds.some((entry) => entry.length > 0) }
  } catch {
    return { value: 'unknown', reason: `${command.join(' ')} failed: unparseable output` }
  }
}

function latestActivity(
  database: Database,
  projectId: string,
  nowMs: number,
): {
  liveRun: boolean
  liveSession: boolean
  lastWorktreeCreatedAtMs: number | null
  lastGateAtMs: number | null
  lastEnsureAtMs: number | null
} {
  const liveRows = database
    .query(
      `SELECT record_id,status,pid,executor,session_id,started_at,job,
              (SELECT last_seen FROM session_seen WHERE session_id=run.session_id) session_last_seen
         FROM run WHERE project_record_id=? AND status IN ('running','asking')`,
    )
    .all(projectId) as {
    record_id: string
    status: string
    pid: number | null
    executor: 'external' | 'harness'
    session_id: string | null
    started_at: string
    job: string
    session_last_seen: string | null
  }[]
  const liveRun = liveRows.some((row) =>
    runAlive({
      status: row.status,
      lease: runLeaseState(row.record_id),
      pidAlive: Boolean(row.pid && pidAlive(row.pid)),
      ...recordedRunLivenessFacts(row, nowMs, SESSION_LIVE_MS),
    }),
  )
  const created = database
    .query(
      'SELECT MAX(started_at) value FROM run WHERE project_record_id=? AND worktree IS NOT NULL',
    )
    .get(projectId) as { value: string | null }
  const gated = database
    .query(
      `SELECT MAX(g.requested_at) value FROM gate_execution g
       JOIN run r ON r.record_id=g.run_record_id WHERE r.project_record_id=?`,
    )
    .get(projectId) as { value: string | null }
  const project = database.query('SELECT name FROM project WHERE record_id=?').get(projectId) as {
    name: string
  }
  const sessionCutoff = new Date(nowMs - SESSION_LIVE_MS).toISOString()
  const liveSession = Boolean(
    database
      .query(
        "SELECT 1 FROM presence WHERE role='architect' AND project_record_id=(SELECT record_id FROM project WHERE name=?) AND last_seen>=? LIMIT 1",
      )
      .get(project.name, sessionCutoff),
  )
  const ensured = database
    .query('SELECT last_ensured_at value FROM main_stack_activity WHERE project_record_id=?')
    .get(projectId) as { value: string | null } | null
  const recordedTime = (value: string | null): number | null => {
    if (value === null) return null
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) throw new Error(`invalid recorded activity time ${value}`)
    return parsed
  }
  return {
    liveRun,
    liveSession,
    lastWorktreeCreatedAtMs: recordedTime(created.value),
    lastGateAtMs: recordedTime(gated.value),
    lastEnsureAtMs: recordedTime(ensured?.value ?? null),
  }
}

type MainStackSweepInput = {
  database: Database
  projects: Project[]
  dryRun: boolean
  nowMs?: number
  log(message: string): void
  error(message: string): void
}

function sweepIdleMainStack(
  input: MainStackSweepInput,
  project: Project,
  idleStopAfterMs: number,
): boolean {
  let activity: ReturnType<typeof latestActivity>
  try {
    activity = latestActivity(input.database, project.recordId, input.nowMs ?? Date.now())
  } catch (error) {
    input.error(`main stack ${project.name}: idleness unavailable: ${(error as Error).message}`)
    return true
  }
  const execObservation = mainStackExecInProgress(project.path)
  const decision = decideMainStackIdleStop({
    recordsAvailable: true,
    running: true,
    execInProgress: execObservation.value,
    ...activity,
    nowMs: input.nowMs ?? Date.now(),
    idleStopAfterMs,
  })
  if (decision === 'report') {
    input.error(
      `main stack ${project.name}: command activity unavailable: ${
        execObservation.value === 'unknown' ? execObservation.reason : 'unknown state'
      }`,
    )
    return true
  }
  if (decision !== 'stop') return false
  if (input.dryRun) {
    input.log(`would stop idle main stack for ${project.name}`)
    return false
  }
  const stopped = dockerCompose(project.path, ['stop'])
  if (!stopped.ok) {
    input.error(`main stack ${project.name}: ${stopped.reason}`)
    return true
  }
  input.log(`stopped idle main stack for ${project.name}`)
  return false
}

export function sweepIdleMainStacks(input: MainStackSweepInput): boolean {
  const inventory = runningMainStackPaths()
  if (!inventory.ok) {
    input.error(inventory.reason)
    return true
  }
  const runningPaths = new Set(
    inventory.output
      .split('\n')
      .map((path) => path.trim())
      .filter(Boolean),
  )
  const idleStopAfterMs = mainStackIdleStopAfterMs()
  let failed = false
  for (const project of input.projects) {
    if (!runningPaths.has(project.path)) continue
    failed = sweepIdleMainStack(input, project, idleStopAfterMs) || failed
  }
  return failed
}
