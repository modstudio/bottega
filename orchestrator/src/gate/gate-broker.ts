// concern: worker gate broker
/** Host-side execution of gate requests recorded by sandboxed repository workers. */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHECK_EXECUTION_FILE_ENV,
  type CheckExecutionRecord,
} from '../../../shared/check-execution.ts'
import { scrubbedGitEnv } from '../../../shared/git.ts'
import { db, nowIso, writeTransaction } from '../database/db.ts'
import { HOST_SLOT_HELD_ENV, HostSlotWaitAborted, withGateSlot } from '../gate-load.ts'
import { terminateProcessGroup } from '../idle-kill.ts'
import { workerGateEnvironment } from '../issue/issue-shell.ts'
import { createNoFollowFile } from '../no-follow-file.ts'
import type { MainStackConsumer } from '../project/project-settings.ts'
import { ensureMainStackStarted } from '../resources/main-stack.ts'
import { resolveReviewMergeBase } from '../review/review-target.ts'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import { HOST_TOOL_NICENESS, setChildPriority } from '../run/run-child-priority.ts'
import { type SandboxRuntimeConfig, sandboxLaunchArgv } from '../sandbox/sandbox.ts'
import {
  gateCheckExecutionPath,
  insertGateCheckExecutions,
  readGateCheckExecutions,
} from './gate-check-executions.ts'
import {
  type BrokerConfinement,
  boundedGateOutputTail,
  brokerGateEnvironment,
  changedGateToolingPaths,
  decideBrokerLaunch,
  decideGateExecutionFinalization,
  decideGateHeadCommit,
  decideGateToolingDiffBase,
  GATE_CLOSE_REASON,
  GATE_COMMAND_TIMEOUT_MS,
  resolveGateCommand,
} from './gate-decision.ts'
import { hostSlotWaitCallbacks, recordGateLogEvent } from './host-slot-wait.ts'

/** A pending check is a plain read; only an actual claim takes the write lock. */
const GATE_REQUEST_POLL_MS = 1000
export const GATE_BASE_REFRESH_TIMEOUT_MS = 30_000

type PendingGate = { id: number; run_record_id: string; startedAt: string }
type ActiveGate = {
  completion: Promise<void>
  cancel(reason: string): Promise<void>
}
type HostSlotRunner = typeof withGateSlot
export type GateExecutionMoment = { executionId: number; at: string }
type GateBaseRefresh = (input: {
  mainCheckout: string
  landingBranch: string | null
}) => GateBaseRefreshResult
type GateBaseRefreshResult = { elapsedMs: number; message: string }
type GitInvocationResult = {
  status: number | null
  stdout: Buffer
  stderr: Buffer
  error?: Error
}
type GateProcessState = {
  child: ReturnType<typeof spawn> | null
  termination: Promise<void> | null
  timedOut: boolean
  exitCode: number
}

const PENDING_GATE_SQL = `SELECT id,run_record_id FROM gate_execution
  WHERE run_record_id=? AND started_at IS NULL AND finished_at IS NULL ORDER BY id LIMIT 1`

function claimPendingGate(runId: string): PendingGate | null {
  if (!db().query(PENDING_GATE_SQL).get(runId)) return null
  return writeTransaction(() => {
    const row = db().query(PENDING_GATE_SQL).get(runId) as Omit<PendingGate, 'startedAt'> | null
    if (!row) return null
    const startedAt = nowIso()
    const claimed = db()
      .query('UPDATE gate_execution SET started_at=? WHERE id=? AND started_at IS NULL')
      .run(startedAt, row.id)
    return claimed.changes === 1 ? { ...row, startedAt } : null
  })
}

function gatePlan(runId: string): {
  command: string
  worktree: string
  baseCommit: string
  trunk: string | null
  mainStackConsumers: MainStackConsumer[] | undefined
  mainStackRequiredServices: string[] | undefined
  projectId: string
  projectName: string
} {
  const row = db()
    .query(
      `SELECT r.worktree,r.base_commit,p.record_id project_record_id,p.name project_name,p.settings
       FROM run r JOIN project p ON p.record_id=r.project_record_id WHERE r.record_id=?`,
    )
    .get(runId) as {
    worktree: string | null
    base_commit: string | null
    settings: string | null
    project_record_id: string
    project_name: string
  } | null
  if (!row?.worktree) throw new Error(`run ${runId} has no recorded worktree`)
  if (!row.base_commit) throw new Error(`run ${runId} has no recorded base commit`)
  const settings = JSON.parse(row.settings ?? '{}') as {
    gate?: unknown
    trunk?: unknown
    mainStack?: {
      consumers?: MainStackConsumer[]
      requiredServices?: string[]
    }
  }
  if (typeof settings.gate !== 'string' || !settings.gate.trim()) {
    throw new Error(`run ${runId}'s project has no registered gate`)
  }
  return {
    command: settings.gate.trim(),
    worktree: row.worktree,
    baseCommit: row.base_commit,
    trunk:
      typeof settings.trunk === 'string' && settings.trunk.trim() ? settings.trunk.trim() : null,
    mainStackConsumers: settings.mainStack?.consumers,
    mainStackRequiredServices: settings.mainStack?.requiredServices,
    projectId: row.project_record_id,
    projectName: row.project_name,
  }
}

function requiredMainCheckout(environment: Record<string, string>, runId: string): string {
  const mainCheckout = environment.ORCH_MAIN_CHECKOUT
  if (!mainCheckout) throw new Error(`run ${runId} has no recorded main checkout`)
  return mainCheckout
}

function operatorGitEnvironment(): NodeJS.ProcessEnv {
  const environment = scrubbedGitEnv(process.env)
  delete environment.ORCH_RUN_ID
  delete environment.ORCH_RUN_TOKEN
  delete environment.ORCH_DEPTH
  return environment
}

function failedGateBaseRefresh(detail: string): string {
  return `gate base refresh failed: ${detail}`
}

function gitFailureDetail(result: GitInvocationResult, command: string): string {
  const detail = result.error?.message ?? result.stderr.toString().trim()
  return detail || `${command} exited with status ${String(result.status)}`
}

/** Refresh the registered landing ref without exposing the worker's ref guard or run identity. */
export function refreshGateBase(
  input: { mainCheckout: string; landingBranch: string | null },
  invoke: (
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  ) => GitInvocationResult = (args, options) =>
    spawnSync('git', args, { ...options, encoding: 'buffer' }),
): GateBaseRefreshResult {
  const started = Date.now()
  if (!input.landingBranch) {
    return {
      elapsedMs: Date.now() - started,
      message: 'gate base refresh skipped: no registered landing branch',
    }
  }
  const options = {
    cwd: input.mainCheckout,
    env: operatorGitEnvironment(),
    timeout: GATE_BASE_REFRESH_TIMEOUT_MS,
  }
  const configured = invoke(['config', '--get', `branch.${input.landingBranch}.remote`], options)
  if (configured.status === 1) {
    return {
      elapsedMs: Date.now() - started,
      message: `gate base refresh skipped: no configured remote for ${input.landingBranch}`,
    }
  }
  const remote = configured.status === 0 ? configured.stdout.toString().trim() : ''
  if (!remote) {
    const detail = gitFailureDetail(configured, 'git config')
    return {
      elapsedMs: Date.now() - started,
      message: `gate base refresh skipped: could not read branch.${input.landingBranch}.remote: ${detail}`,
    }
  }
  const fetched = invoke(['fetch', '--no-tags', '--', remote, input.landingBranch], options)
  const elapsedMs = Date.now() - started
  if (fetched.status === 0) {
    return {
      elapsedMs,
      message: `gate base refresh passed: fetched ${remote}/${input.landingBranch}`,
    }
  }
  const detail = gitFailureDetail(fetched, 'git fetch')
  return {
    elapsedMs,
    message: failedGateBaseRefresh(`${remote}/${input.landingBranch}: ${detail}`),
  }
}

export async function runGateAfterBaseRefresh(input: {
  refreshInput: Parameters<GateBaseRefresh>[0]
  refreshBase: GateBaseRefresh
  recordRefresh: (refresh: GateBaseRefreshResult) => void
  runGate: () => Promise<void>
}): Promise<void> {
  const refreshStarted = Date.now()
  let refresh: GateBaseRefreshResult
  try {
    refresh = input.refreshBase(input.refreshInput)
  } catch (error) {
    refresh = {
      elapsedMs: Date.now() - refreshStarted,
      message: failedGateBaseRefresh(String(error)),
    }
  }
  input.recordRefresh(refresh)
  await input.runGate()
}

function gitPaths(worktree: string, args: string[]): string[] {
  const result = spawnSync('git', args, { cwd: worktree, encoding: 'buffer' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString().split('\0').filter(Boolean)
}

function changedGateTooling(
  plan: ReturnType<typeof gatePlan>,
  log: (line: string) => void,
): string[] {
  let mergeBase: string | null = null
  try {
    if (!plan.trunk) throw new Error('the project has no registered trunk')
    mergeBase = resolveReviewMergeBase(plan.worktree, 'HEAD', plan.trunk)
    if (!mergeBase) throw new Error(`no merge-base with trunk ${plan.trunk}`)
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replaceAll('\n', ' ')
    log(`gate tooling diff fell back to recorded base ${plan.baseCommit}: ${reason}\n`)
  }
  const base = decideGateToolingDiffBase({
    recordedBase: plan.baseCommit,
    mergeBase,
  })
  return changedGateToolingPaths({
    diffPaths: gitPaths(plan.worktree, ['diff', '--name-only', '-z', base, '--']),
    untrackedPaths: gitPaths(plan.worktree, ['ls-files', '--others', '--exclude-standard', '-z']),
    gateCommand: plan.command,
  })
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once('close', () => resolve())
    child.once('error', () => resolve())
  })
}

function gateScratchLogPath(scratchDir: string, executionId: number): string {
  return join(scratchDir, `gate-${executionId}.log`)
}

function createGateLog(path: string): number {
  try {
    return createNoFollowFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`gate log path is occupied: ${path}; gate did not run`)
    }
    throw error
  }
}

function finishGateLog(
  fd: number | null,
  checkExecutionPath: string,
  record: (chunk: Buffer | string) => void,
): CheckExecutionRecord[] {
  const records = readGateCheckExecutions(checkExecutionPath, record)
  if (fd !== null) closeSync(fd)
  return records
}

function gateExecutionEnvironment(
  environment: Record<string, string>,
  checkExecutionPath: string,
): Record<string, string> {
  return { ...environment, [CHECK_EXECUTION_FILE_ENV]: checkExecutionPath }
}

function recordFinishedGate(input: {
  requestId: number
  finishedAt: string
  exitCode: number
  timedOut: boolean
  elapsedMs: number
  tail: string
  artifactPath: string | null
  cancelledReason: string | null
  command: string | null
  checkExecutions: readonly CheckExecutionRecord[]
}): void {
  const database = db()
  writeTransaction(() => {
    database
      .query(
        `UPDATE gate_execution SET finished_at=?,exit_code=?,timed_out=?,elapsed_ms=?,
       output_tail=?,output_artifact=?,cancelled_reason=?,resolved_command=COALESCE(resolved_command,?)
       WHERE id=?`,
      )
      .run(
        input.finishedAt,
        input.exitCode,
        input.timedOut ? 1 : 0,
        input.elapsedMs,
        input.tail,
        input.artifactPath,
        input.cancelledReason,
        input.command,
        input.requestId,
      )
    insertGateCheckExecutions(database, input.requestId, input.checkExecutions)
  }, database)
}

export async function gateBrokerLaunchArgv(
  confinement: BrokerConfinement<SandboxRuntimeConfig>,
  command: string,
  launchSandbox: typeof sandboxLaunchArgv = sandboxLaunchArgv,
): Promise<string[]> {
  const decision = decideBrokerLaunch(confinement, 'sh', ['-c', command])
  return decision.kind === 'srt'
    ? launchSandbox(decision.profile, decision.bin, decision.argv)
    : decision.argv
}

async function spawnGateChild(input: {
  command: string
  worktree: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  record: (chunk: Buffer | string) => void
}) {
  const launch = await gateBrokerLaunchArgv(input.confinement, input.command)
  return setChildPriority(
    spawn(launch[0]!, launch.slice(1), {
      cwd: input.worktree,
      env: {
        ...brokerGateEnvironment(
          workerGateEnvironment(process.env),
          process.env,
          input.environment,
        ),
        [HOST_SLOT_HELD_ENV]: '1',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    HOST_TOOL_NICENESS,
    (message) => input.record(`warning: ${message}\n`),
  )
}

async function runGateProcess(input: {
  command: string
  worktree: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  state: GateProcessState
  record: (chunk: Buffer | string) => void
  stop: () => Promise<void>
}): Promise<void> {
  const { state } = input
  state.child = await spawnGateChild(input)
  state.child.stdout?.on('data', input.record)
  state.child.stderr?.on('data', input.record)
  state.child.once('error', (error) => input.record(`gate could not start: ${String(error)}\n`))
  const timeout = setTimeout(() => {
    state.timedOut = true
    void input.stop()
  }, GATE_COMMAND_TIMEOUT_MS)
  await waitForExit(state.child)
  clearTimeout(timeout)
  if (state.termination) await state.termination
  state.exitCode = state.child.exitCode ?? -1
  if (state.timedOut) input.record(`\ngate timed out after ${GATE_COMMAND_TIMEOUT_MS}ms\n`)
}

function gateWaitCallbacks(request: PendingGate) {
  return hostSlotWaitCallbacks({
    runId: request.run_record_id,
    writeProgress: (message) => {
      db().query('UPDATE gate_execution SET output_tail=? WHERE id=?').run(message, request.id)
    },
  })
}

function prepareGateExecution(input: {
  request: PendingGate
  environment: Record<string, string>
  record: (chunk: Buffer | string) => void
}) {
  const plan = gatePlan(input.request.run_record_id)
  const mainCheckout = requiredMainCheckout(input.environment, input.request.run_record_id)
  ensureMainStackStarted({
    projectId: plan.projectId,
    projectName: plan.projectName,
    projectPath: mainCheckout,
    declaration: plan.mainStackConsumers
      ? {
          consumers: plan.mainStackConsumers,
          requiredServices: plan.mainStackRequiredServices,
        }
      : undefined,
    consumer: 'gate',
  })
  const command = resolveGateCommand(plan.command, plan.worktree)
  const toolingPaths = changedGateTooling(plan, input.record)
  const headCommit = decideGateHeadCommit({
    headCommit:
      gitPaths(plan.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])[0]?.trim() ?? '',
    porcelainPaths: gitPaths(plan.worktree, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
    ]),
  })
  db()
    .query('UPDATE gate_execution SET tooling_paths=?,resolved_command=?,head_commit=? WHERE id=?')
    .run(JSON.stringify(toolingPaths), command, headCommit, input.request.id)
  return {
    command,
    worktree: plan.worktree,
    refreshInput: { mainCheckout, landingBranch: plan.trunk },
  }
}

async function runPreparedGate(input: {
  requestId: number
  prepared: ReturnType<typeof prepareGateExecution>
  refreshBase: GateBaseRefresh
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  state: GateProcessState
  record: (chunk: Buffer | string) => void
  stop: () => Promise<void>
}): Promise<void> {
  await runGateAfterBaseRefresh({
    refreshInput: input.prepared.refreshInput,
    refreshBase: input.refreshBase,
    recordRefresh: (refresh) => {
      input.record(`${refresh.message} (${refresh.elapsedMs}ms)\n`)
      db()
        .query(
          'UPDATE gate_execution SET base_refresh_elapsed_ms=?,base_refresh_result=? WHERE id=?',
        )
        .run(refresh.elapsedMs, refresh.message, input.requestId)
    },
    runGate: () =>
      runGateProcess({
        command: input.prepared.command,
        worktree: input.prepared.worktree,
        environment: input.environment,
        confinement: input.confinement,
        state: input.state,
        record: input.record,
        stop: input.stop,
      }),
  })
}

/** Decide how a finished gate execution is recorded, record it, and name its retained log. */
function completeGateExecution(input: {
  request: PendingGate
  scratchDir: string
  finishedAt: string
  state: GateProcessState
  cancelledReason: string | null
  logCreated: boolean
  artifactPath: string
  elapsedMs: number
  tail: string
  command: string | null
  checkExecutions: readonly CheckExecutionRecord[]
}): void {
  const finalization = decideGateExecutionFinalization({
    exitCode: input.state.exitCode,
    timedOut: input.state.timedOut,
    cancelledReason: input.cancelledReason,
    logCreated: input.logCreated,
    artifactPath: input.artifactPath,
  })
  recordFinishedGate({
    requestId: input.request.id,
    finishedAt: input.finishedAt,
    exitCode: finalization.exitCode,
    timedOut: finalization.timedOut,
    elapsedMs: input.elapsedMs,
    tail: input.tail,
    artifactPath: finalization.artifactPath,
    cancelledReason: finalization.cancelledReason,
    command: input.command,
    checkExecutions: input.checkExecutions,
  })
  if (finalization.artifactPath) {
    recordGateLogEvent(
      input.request.run_record_id,
      input.finishedAt,
      gateScratchLogPath(input.scratchDir, input.request.id),
    )
  }
}

function startGateExecution(
  request: PendingGate,
  scratchDir: string,
  environment: Record<string, string>,
  confinement: BrokerConfinement<SandboxRuntimeConfig>,
  registerActive: (terminate: () => Promise<void>) => () => void,
  onFinish: ((moment: GateExecutionMoment) => void) | undefined,
  hostSlot: HostSlotRunner,
  refreshBase: GateBaseRefresh,
): ActiveGate {
  const state: GateProcessState = {
    child: null,
    termination: null,
    timedOut: false,
    exitCode: -1,
  }
  let cancelledReason: string | null = null
  const slotWait = new AbortController()
  const stop = (reason?: string): Promise<void> => {
    if (reason) cancelledReason ??= reason
    slotWait.abort()
    if (!state.child || state.child.exitCode !== null) return Promise.resolve()
    state.termination ??= terminateProcessGroup(state.child.pid ?? 0, {
      direct: state.child,
    }).then((result) => {
      if (!result.exited) throw new Error(result.reason ?? 'gate process group did not exit')
    })
    return state.termination
  }
  let completion!: Promise<void>
  const unregister = registerActive(async () => {
    await stop(GATE_CLOSE_REASON)
    await completion
  })
  let finishedAt: string | null = null
  completion = (async () => {
    mkdirSync(scratchDir, { recursive: true })
    const artifactPath = join(runArtifactsDir(request.run_record_id), `gate-${request.id}.log`)
    const started = Date.now()
    let fd: number | null = null
    let tail = ''
    let command: string | null = null
    let checkExecutions: CheckExecutionRecord[] = []
    const checkExecutionPath = gateCheckExecutionPath(scratchDir)
    const record = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (fd === null) throw new Error('gate log is not open')
      writeSync(fd, bytes)
      tail = boundedGateOutputTail(tail + bytes.toString())
    }
    try {
      fd = createGateLog(gateScratchLogPath(scratchDir, request.id))
      const prepared = prepareGateExecution({ request, environment, record })
      command = prepared.command
      await hostSlot(
        () =>
          runPreparedGate({
            requestId: request.id,
            prepared,
            refreshBase,
            environment: gateExecutionEnvironment(environment, checkExecutionPath),
            confinement,
            state,
            record,
            stop,
          }),
        {
          signal: slotWait.signal,
          ...gateWaitCallbacks(request),
        },
      )
    } catch (error) {
      const line =
        error instanceof HostSlotWaitAborted && cancelledReason
          ? `${cancelledReason}\n`
          : `gate broker failed: ${String(error)}\n`
      if (fd !== null) writeSync(fd, line)
      tail = boundedGateOutputTail(tail + line)
      if (state.termination) throw error
    } finally {
      checkExecutions = finishGateLog(fd, checkExecutionPath, record)
    }
    finishedAt = nowIso()
    completeGateExecution({
      request,
      scratchDir,
      finishedAt,
      state,
      cancelledReason,
      logCreated: fd !== null,
      artifactPath,
      elapsedMs: Date.now() - started,
      tail,
      command,
      checkExecutions,
    })
  })()
    .finally(() => onFinish?.({ executionId: request.id, at: finishedAt ?? nowIso() }))
    .finally(unregister)
  return { completion, cancel: (reason) => stop(reason) }
}

export type GateBroker = { close(): Promise<void> }

/** Poll while the supervised worker lives; no resident service is introduced. */
export function startGateBroker(input: {
  runId: string
  scratchDir: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  registerActive?: (terminate: () => Promise<void>) => () => void
  onExecutionStart?: (moment: GateExecutionMoment) => void
  onExecutionFinish?: (moment: GateExecutionMoment) => void
  withHostSlot?: HostSlotRunner
  refreshBase?: GateBaseRefresh
}): GateBroker {
  let closed = false
  let active: ActiveGate | null = null
  const registerActive = input.registerActive ?? (() => () => {})
  const poll = () => {
    if (closed || active) return
    const request = claimPendingGate(input.runId)
    if (!request) return
    input.onExecutionStart?.({
      executionId: request.id,
      at: request.startedAt,
    })
    const execution = startGateExecution(
      request,
      input.scratchDir,
      input.environment,
      input.confinement,
      registerActive,
      input.onExecutionFinish,
      input.withHostSlot ?? withGateSlot,
      input.refreshBase ?? refreshGateBase,
    )
    active = execution
    void execution.completion.then(
      () => {
        if (active === execution) active = null
      },
      () => {},
    )
  }
  const timer = setInterval(poll, GATE_REQUEST_POLL_MS)
  poll()
  return {
    async close() {
      closed = true
      clearInterval(timer)
      if (active) {
        await active.cancel(GATE_CLOSE_REASON)
        await active.completion
      }
      writeTransaction(() => {
        db().query('UPDATE run SET gate_requests_closed=1 WHERE record_id=?').run(input.runId)
        db()
          .query(
            `UPDATE gate_execution SET finished_at=?,exit_code=-1,timed_out=0,elapsed_ms=0,
             cancelled_reason=? WHERE run_record_id=? AND finished_at IS NULL`,
          )
          .run(nowIso(), GATE_CLOSE_REASON, input.runId)
      })
    },
  }
}
