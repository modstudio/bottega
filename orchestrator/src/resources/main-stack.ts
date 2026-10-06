// concern: main-checkout Docker stack adapter

import type { Database } from 'bun:sqlite'
import { pidAlive } from '../../../shared/process-identity.ts'
import { nowIso, SESSION_LIVE_MS, writableDb, writeTransaction } from '../database/db.ts'
import type { MainStackConsumer } from '../project/project-settings.ts'
import type { Project } from '../project/projects.ts'
import { runAlive } from '../run/run-alive.ts'
import { runLeaseState } from '../run/run-lease.ts'
import { decideMainStackEnsure, decideMainStackIdleStop } from './main-stack-decision.ts'

export const MAIN_STACK_IDLE_STOP_AFTER_MS_DEFAULT = 4 * 60 * 60 * 1_000
const MAIN_STACK_IDLE_STOP_AFTER_KEY = 'ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS'
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

/** Start a declared consumer's main stack before the consumer runs. */
export function ensureMainStackStarted(input: {
  projectId: number
  projectName: string
  projectPath: string
  declaration: { consumers: MainStackConsumer[]; requiredServices?: string[] } | undefined
  consumer: MainStackConsumer
  database?: Database
}): void {
  if (!input.declaration?.consumers.includes(input.consumer)) return
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
  if (decision === 'start-stack' || decision === 'start-services') {
    const started = dockerCompose(input.projectPath, [
      'up',
      '-d',
      '--wait',
      ...(decision === 'start-services' ? (required ?? []) : []),
    ])
    if (!started.ok)
      throw new Error(
        `main stack for ${input.projectName}, required by ${input.consumer}, did not become healthy from registered main checkout ${input.projectPath}: ${started.reason}; run ${command} there, then retry`,
      )
  }
  if (input.projectId === 0) return
  const database = input.database ?? writableDb()
  writeTransaction(() => {
    database
      .query(
        `INSERT INTO main_stack_activity (project_id,last_ensured_at) VALUES (?,?)
         ON CONFLICT(project_id) DO UPDATE SET last_ensured_at=excluded.last_ensured_at`,
      )
      .run(input.projectId, nowIso())
  }, database)
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

function latestActivity(
  database: Database,
  projectId: number,
  nowMs: number,
): {
  liveRun: boolean
  liveSession: boolean
  lastWorktreeCreatedAtMs: number | null
  lastGateAtMs: number | null
  lastEnsureAtMs: number | null
} {
  const liveRows = database
    .query("SELECT id,status,pid FROM run WHERE project_id=? AND status IN ('running','asking')")
    .all(projectId) as { id: number; status: string; pid: number | null }[]
  const liveRun = liveRows.some((row) =>
    runAlive({
      status: row.status,
      lease: runLeaseState(row.id),
      pidAlive: Boolean(row.pid && pidAlive(row.pid)),
    }),
  )
  const created = database
    .query('SELECT MAX(started_at) value FROM run WHERE project_id=? AND worktree IS NOT NULL')
    .get(projectId) as { value: string | null }
  const gated = database
    .query(
      `SELECT MAX(g.requested_at) value FROM gate_execution g
       JOIN run r ON r.id=g.run_id WHERE r.project_id=?`,
    )
    .get(projectId) as { value: string | null }
  const project = database.query('SELECT name FROM project WHERE id=?').get(projectId) as {
    name: string
  }
  const sessionCutoff = new Date(nowMs - SESSION_LIVE_MS).toISOString()
  const liveSession = Boolean(
    database
      .query("SELECT 1 FROM presence WHERE role='architect' AND project=? AND last_seen>=? LIMIT 1")
      .get(project.name, sessionCutoff),
  )
  const ensured = database
    .query('SELECT last_ensured_at value FROM main_stack_activity WHERE project_id=?')
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

export function sweepIdleMainStacks(input: {
  database: Database
  projects: Project[]
  dryRun: boolean
  nowMs?: number
  log(message: string): void
  error(message: string): void
}): boolean {
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
    let activity: ReturnType<typeof latestActivity>
    try {
      activity = latestActivity(input.database, project.id, input.nowMs ?? Date.now())
    } catch (error) {
      input.error(`main stack ${project.name}: idleness unavailable: ${(error as Error).message}`)
      failed = true
      continue
    }
    const decision = decideMainStackIdleStop({
      recordsAvailable: true,
      running: true,
      ...activity,
      nowMs: input.nowMs ?? Date.now(),
      idleStopAfterMs,
    })
    if (decision !== 'stop') continue
    if (input.dryRun) {
      input.log(`would stop idle main stack for ${project.name}`)
      continue
    }
    const stopped = dockerCompose(project.path, ['stop'])
    if (!stopped.ok) {
      input.error(`main stack ${project.name}: ${stopped.reason}`)
      failed = true
    } else {
      input.log(`stopped idle main stack for ${project.name}`)
    }
  }
  return failed
}
