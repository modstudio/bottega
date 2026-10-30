// concern: focused-test-broker
/** Host-side execution of focused test requests from a sandboxed writing worker. */

import { spawn } from 'node:child_process'
import { closeSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { projectCodeGitEnv } from '../../../shared/git.ts'
import { RUN_PROCESS_MARKER_ENV } from '../../../shared/run-process-marker.ts'
import { db, nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import {
  type BrokerConfinement,
  brokerGateEnvironment,
  decideBrokerLaunch,
  GATE_COMMAND_TIMEOUT_MS,
} from '../gate/gate-decision.ts'
import { hostSlotWaitCallbacks } from '../gate/host-slot-wait.ts'
import { HOST_SLOT_HELD_ENV, HostSlotWaitAborted, withGateSlot } from '../gate-load.ts'
import { terminateProcessGroup } from '../idle-kill.ts'
import { workerGateEnvironment } from '../issue/issue-shell.ts'
import { createNoFollowFile } from '../no-follow-file.ts'
import type { MainStackConsumer } from '../project/project-settings.ts'
import { ensureMainStackStarted } from '../resources/main-stack.ts'
import { HOST_TOOL_NICENESS, setChildPriority } from '../run/run-child-priority.ts'
import { type SandboxRuntimeConfig, sandboxLaunchArgv } from '../sandbox/sandbox.ts'
import {
  affectedSelectorPathRefusal,
  boundedFocusedTestOutputTail,
  decideFocusedTestSelection,
  decideFocusedTestSelectorOutcome,
  declaredFocusedTestCommands,
  FOCUSED_TEST_CLOSE_REASON,
  FOCUSED_TEST_SELECTOR_OUTPUT_MAX_BYTES,
  type FocusedTestRequest,
  type FocusedTestResult,
  type FocusedTestSelection,
  type FocusedTestSelector,
  type FocusedTestSelectorOutcome,
  focusedTestInvocation,
  parseFocusedTestRequest,
  splitFocusedTestPaths,
} from './focused-test-decision.ts'
import {
  ensureFocusedTestDirectory,
  focusedTestFileExists,
  readFocusedTestRegularFile,
  removeFocusedTestFile,
  writeFocusedTestFileAtomic,
  writeFocusedTestFileExclusive,
} from './focused-test-files.ts'
import { validateFocusedTestRunPaths } from './focused-test-paths.ts'
import {
  FOCUSED_TEST_ACTIVE_FILE,
  FOCUSED_TEST_LOCK_FILE,
  FOCUSED_TEST_REQUEST_FILE,
  focusedTestProgressFile,
  focusedTestResultFile,
} from './focused-test-request.ts'

const FOCUSED_TEST_REQUEST_POLL_MS = 250

type ActiveFocusedTest = { completion: Promise<void>; cancel(): Promise<void> }
export type FocusedTestBroker = { close(): Promise<void> }
type FocusedTestProcessState = {
  child: ReturnType<typeof spawn> | null
  termination: Promise<void> | null
  started: boolean
  /** The supervising run closed this execution; stopping a child for its own reason never sets it. */
  cancelled: boolean
  timedOut: boolean
  exitCode: number
}
type FocusedTestRunSelection = Extract<FocusedTestSelection, { kind: 'run' }>

function focusedTestPlan(runId: string) {
  const row = db()
    .query(
      `SELECT r.worktree,r.base_commit,p.record_id project_record_id,p.name project_name,p.settings
       FROM run r JOIN project p ON p.record_id=r.project_record_id WHERE r.record_id=?`,
    )
    .get(runId) as {
    worktree: string | null
    base_commit: string | null
    project_record_id: string
    project_name: string
    settings: string | null
  } | null
  if (!row?.worktree) throw new Error(`run ${runId} has no recorded worktree`)
  const settings = JSON.parse(row.settings ?? '{}') as {
    mainStack?: { consumers?: MainStackConsumer[]; requiredServices?: string[] }
  }
  const { runner, runners, selectorProblem } = declaredFocusedTestCommands(row.settings)
  if (!runner || !runners.length)
    throw new Error(`run ${runId}'s project has no registered focused test runner`)
  return {
    runner,
    runners,
    selectorProblem,
    baseCommit: row.base_commit,
    worktree: row.worktree,
    projectId: row.project_record_id,
    projectName: row.project_name,
    mainStackConsumers: settings.mainStack?.consumers,
    mainStackRequiredServices: settings.mainStack?.requiredServices,
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    child.once('close', () => resolve())
    child.once('error', () => resolve())
  })
}

function ensureFocusedTestMainStack(
  plan: ReturnType<typeof focusedTestPlan>,
  environment: Record<string, string>,
): void {
  const mainCheckout = environment.BOTTEGA_MAIN_CHECKOUT
  if (!mainCheckout) throw new Error('focused test run has no recorded main checkout')
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
}

function writeResult(scratchDir: string, requestId: string, result: FocusedTestResult): void {
  const path = join(scratchDir, focusedTestResultFile(requestId))
  writeFocusedTestFileAtomic(path, JSON.stringify(result))
}

function claimRequest(scratchDir: string): FocusedTestRequest | null {
  const requestPath = join(scratchDir, FOCUSED_TEST_REQUEST_FILE)
  if (!focusedTestFileExists(requestPath)) return null
  const activePath = join(scratchDir, FOCUSED_TEST_ACTIVE_FILE)
  let contents: string
  try {
    contents = readFocusedTestRegularFile(requestPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  writeFocusedTestFileExclusive(activePath, contents)
  removeFocusedTestFile(requestPath)
  return parseFocusedTestRequest(JSON.parse(contents))
}

export async function focusedTestBrokerLaunchArgv(
  confinement: BrokerConfinement<SandboxRuntimeConfig>,
  command: string,
  argv: string[],
  launchSandbox: typeof sandboxLaunchArgv = sandboxLaunchArgv,
): Promise<string[]> {
  const decision = decideBrokerLaunch(confinement, command, argv)
  return decision.kind === 'srt'
    ? launchSandbox(decision.profile, decision.bin, decision.argv)
    : decision.argv
}

async function spawnFocusedTestChild(input: {
  invocation: ReturnType<typeof focusedTestInvocation>
  worktree: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  record: (chunk: Buffer | string) => void
}) {
  const launch = await focusedTestBrokerLaunchArgv(
    input.confinement,
    input.invocation.command,
    input.invocation.argv,
  )
  return setChildPriority(
    spawn(launch[0]!, launch.slice(1), {
      cwd: input.worktree,
      env: {
        ...brokerGateEnvironment(
          workerGateEnvironment(projectCodeGitEnv(process.env)),
          process.env,
          input.environment,
        ),
        [RUN_PROCESS_MARKER_ENV]: '1',
        [HOST_SLOT_HELD_ENV]: '1',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    HOST_TOOL_NICENESS,
    (message) => input.record(`warning: ${message}\n`),
  )
}

async function runFocusedTestProcess(input: {
  invocation: ReturnType<typeof focusedTestInvocation>
  worktree: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  state: FocusedTestProcessState
  record: (chunk: Buffer | string) => void
  stopChild: () => Promise<void>
}): Promise<void> {
  const { state } = input
  const outcome = await runFocusedTestChild({
    ...input,
    stdoutLimit: null,
    marksStarted: true,
    startFailurePrefix: 'focused test runner',
  })
  state.exitCode = outcome.exitCode
  state.timedOut = outcome.timedOut
  if (state.timedOut) input.record(`\nfocused tests timed out after ${GATE_COMMAND_TIMEOUT_MS}ms\n`)
  if (state.cancelled && !state.timedOut) input.record(`\n${FOCUSED_TEST_CLOSE_REASON}\n`)
}

type FocusedTestChildOutcome = {
  exitCode: number
  timedOut: boolean
  overflowed: boolean
  stdout: string
  stderrTail: string
}

/**
 * One child process of a focused test execution: spawn it under the run's confinement, record its
 * output, stop it when it times out — or, for a caller that collects stdout, when it prints past
 * its limit — and wait for it to exit. The runner and the selector differ in what they do with
 * stdout and with the outcome; the lifecycle of the child is the one below.
 */
async function runFocusedTestChild(input: {
  invocation: ReturnType<typeof focusedTestInvocation>
  worktree: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  state: FocusedTestProcessState
  record: (chunk: Buffer | string) => void
  /** Stops this child for its own reason, which is never the supervising run's cancellation. */
  stopChild: () => Promise<void>
  /** Collect this many bytes of stdout, stopping the child when it prints more; null collects none. */
  stdoutLimit: number | null
  /** Whether this child's spawn is what the run event reports as the execution starting. */
  marksStarted: boolean
  startFailurePrefix: string
}): Promise<FocusedTestChildOutcome> {
  const child = await spawnFocusedTestChild(input)
  input.state.child = child
  let stdout = ''
  let stderrTail = ''
  let timedOut = false
  let overflowed = false
  child.stdout?.on('data', (chunk: Buffer) => {
    input.record(chunk)
    if (input.stdoutLimit === null) return
    stdout += chunk.toString()
    if (Buffer.byteLength(stdout) > input.stdoutLimit) {
      overflowed = true
      void input.stopChild()
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    input.record(chunk)
    stderrTail = boundedFocusedTestOutputTail(`${stderrTail}${chunk.toString()}`)
  })
  if (input.marksStarted) {
    child.once('spawn', () => {
      input.state.started = true
    })
  }
  child.once('error', (error) =>
    input.record(`${input.startFailurePrefix} could not start: ${String(error)}\n`),
  )
  const timeout = setTimeout(() => {
    timedOut = true
    void input.stopChild()
  }, GATE_COMMAND_TIMEOUT_MS)
  await waitForExit(child)
  clearTimeout(timeout)
  if (input.state.termination) await input.state.termination
  input.state.child = null
  return { exitCode: child.exitCode ?? -1, timedOut, overflowed, stdout, stderrTail }
}

function selectionMessage(selection: Exclude<FocusedTestSelection, { kind: 'run' }>): string {
  return selection.kind === 'none'
    ? selection.message
    : `focused tests refused: ${selection.message}`
}

/**
 * Runs one project-registered selector against the run's recorded base commit and reports what it
 * printed, its exit, or that it never started. The selector runs in the run's worktree under the
 * same confinement as the focused test runner, and the base commit is appended as its last argv.
 */
async function runFocusedTestSelector(input: {
  selector: FocusedTestSelector
  baseCommit: string
  worktree: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  state: FocusedTestProcessState
  record: (chunk: Buffer | string) => void
  stopChild: () => Promise<void>
}): Promise<FocusedTestSelectorOutcome> {
  const outcome = await runFocusedTestChild({
    invocation: focusedTestInvocation(input.selector, [input.baseCommit], input.worktree),
    worktree: input.worktree,
    environment: input.environment,
    confinement: input.confinement,
    state: input.state,
    record: input.record,
    stopChild: input.stopChild,
    stdoutLimit: FOCUSED_TEST_SELECTOR_OUTPUT_MAX_BYTES,
    marksStarted: false,
    startFailurePrefix: 'affected-test selector',
  })
  if (!outcome.timedOut && !outcome.overflowed && outcome.exitCode === 0) {
    return { kind: 'printed', stdout: outcome.stdout }
  }
  return {
    kind: 'failed',
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    overflowed: outcome.overflowed,
    stderrTail: outcome.stderrTail,
  }
}

/**
 * The refusal a path the project's selector printed earns when it cannot run, or null when every
 * path it printed is usable. Only the selector's own paths are turned into a refusal here: the
 * paths this call named for itself are held to the same facts through the union check the runner
 * has always been preceded by, so a path a worker named keeps failing as it always has.
 */
function unusableSelectedPath(input: {
  selection: FocusedTestRunSelection
  worktree: string
}): { kind: 'refuse'; message: string } | null {
  if (!input.selection.selectorPaths.length) return null
  try {
    validateFocusedTestRunPaths(input.selection.selectorPaths, input.worktree)
  } catch (error) {
    return {
      kind: 'refuse',
      message: affectedSelectorPathRefusal(error instanceof Error ? error.message : String(error)),
    }
  }
  return null
}

/** The paths one request runs: the worker's own, the selector's, or the refusal it earns. */
async function selectFocusedTestPaths(input: {
  plan: ReturnType<typeof focusedTestPlan>
  request: FocusedTestRequest
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  state: FocusedTestProcessState
  record: (chunk: Buffer | string) => void
  stopChild: () => Promise<void>
}): Promise<FocusedTestSelection> {
  if (!input.request.affected) {
    return decideFocusedTestSelection({
      affected: false,
      requestedPaths: input.request.paths,
    })
  }
  const affected = (selector: FocusedTestSelectorOutcome) =>
    decideFocusedTestSelection({
      affected: true,
      requestedPaths: input.request.paths,
      selector,
    })
  if (input.plan.selectorProblem) {
    return affected({ kind: 'ill-declared', problem: input.plan.selectorProblem })
  }
  if (input.plan.runners.some((runner) => !runner.affected))
    return affected({ kind: 'not-declared' })
  if (!input.plan.baseCommit) return affected({ kind: 'no-base' })
  const selected: string[] = []
  for (const runner of input.plan.runners) {
    const outcome = decideFocusedTestSelectorOutcome({
      cancelled: input.state.cancelled,
      outcome: await runFocusedTestSelector({
        selector: runner.affected!,
        baseCommit: input.plan.baseCommit,
        worktree: input.plan.worktree,
        environment: input.environment,
        confinement: input.confinement,
        state: input.state,
        record: input.record,
        stopChild: input.stopChild,
      }),
    })
    if (outcome.kind !== 'printed') return affected(outcome)
    const parsed = decideFocusedTestSelection({
      affected: true,
      requestedPaths: [],
      selector: outcome,
    })
    if (parsed.kind === 'refuse') return parsed
    if (parsed.kind === 'run') selected.push(...parsed.paths)
  }
  return affected({ kind: 'printed', stdout: [...new Set(selected)].join('\n') })
}

/**
 * One focused test inside the host slot: select what this request runs, record a refusal or the
 * selection note, then run the runner over the selected paths. Reports the paths the run records.
 */
async function runFocusedTestSelection(input: {
  plan: ReturnType<typeof focusedTestPlan>
  request: FocusedTestRequest
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  state: FocusedTestProcessState
  record: (chunk: Buffer | string) => void
  stopChild: () => Promise<void>
  progressPath: string
}): Promise<{
  executions: Array<{ paths: string[]; started: boolean; exitCode: number; timedOut: boolean }>
  refusedPaths: string[]
}> {
  removeFocusedTestFile(input.progressPath)
  const selection = await selectFocusedTestPaths(input)
  if (selection.kind !== 'run') {
    input.record(`\n${selectionMessage(selection)}\n`)
    if (selection.kind === 'none') input.state.exitCode = 0
    return { executions: [], refusedPaths: [] }
  }
  const refusal = unusableSelectedPath({ selection, worktree: input.plan.worktree })
  if (refusal) {
    input.record(`\n${selectionMessage(refusal)}\n`)
    return { executions: [], refusedPaths: [] }
  }
  if (selection.note) input.record(`\n${selection.note}\n`)
  validateFocusedTestRunPaths(selection.paths, input.plan.worktree)
  const split = splitFocusedTestPaths(input.plan.runners, selection.paths)
  if (split.kind === 'invalid-register') {
    input.record(`\nfocused tests refused: ${split.message}\n`)
    return { executions: [], refusedPaths: [] }
  }
  if (split.kind === 'refuse') {
    input.record(`\n${split.message}\n`)
    return { executions: [], refusedPaths: split.paths }
  }
  const executions: Array<{
    paths: string[]
    started: boolean
    exitCode: number
    timedOut: boolean
  }> = []
  let aggregateExit = 0
  let aggregateTimedOut = false
  for (const group of split.groups) {
    input.state.started = false
    input.state.timedOut = false
    input.state.exitCode = -1
    await runFocusedTestProcess({
      invocation: focusedTestInvocation(group.runner, group.paths, input.plan.worktree),
      worktree: input.plan.worktree,
      environment: input.environment,
      confinement: input.confinement,
      state: input.state,
      record: input.record,
      stopChild: input.stopChild,
    })
    executions.push({
      paths: group.paths,
      started: input.state.started,
      exitCode: input.state.exitCode,
      timedOut: input.state.timedOut,
    })
    if (input.state.exitCode !== 0) aggregateExit = input.state.exitCode
    aggregateTimedOut ||= input.state.timedOut
  }
  input.state.exitCode = aggregateExit
  input.state.timedOut = aggregateTimedOut
  input.state.started = executions.some((execution) => execution.started)
  return { executions, refusedPaths: [] }
}

function focusedTestWaitCallbacks(input: { runId: string; progressPath: string }) {
  return hostSlotWaitCallbacks({
    runId: input.runId,
    writeProgress: (message) => writeFocusedTestFileAtomic(input.progressPath, message),
  })
}

type FocusedTestStartInput = {
  runId: string
  scratchDir: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  request: FocusedTestRequest
  registerActive: (terminate: () => Promise<void>) => () => void
  onStart: (() => void) | undefined
  onFinish: (() => void) | undefined
}
type FocusedTestExecutionEvent = {
  paths: string[]
  started: boolean
  exitCode: number
  timedOut: boolean
}

function recordFocusedTestEvents(input: {
  runId: string
  executions: readonly FocusedTestExecutionEvent[]
  refusedPaths: readonly string[]
  elapsedMs: number
  logName: string
  logPath: string
}): void {
  for (const execution of input.executions) {
    appendRunEvent(input.runId, {
      ts: nowIso(),
      type: 'focused_test',
      ...execution,
      elapsedMs: input.elapsedMs,
      logName: input.logName,
      logPath: input.logPath,
    })
  }
  if (input.refusedPaths.length) {
    appendRunEvent(input.runId, {
      ts: nowIso(),
      type: 'focused_test_refusal',
      paths: [...input.refusedPaths],
    })
  }
}

function registerFocusedTestExecution(
  input: FocusedTestStartInput,
  stop: () => Promise<void>,
  completion: () => Promise<void>,
): () => void {
  input.onStart?.()
  try {
    return input.registerActive(async () => {
      await stop()
      await completion()
    })
  } catch (error) {
    input.onFinish?.()
    throw error
  }
}

function startFocusedTest(input: FocusedTestStartInput): ActiveFocusedTest {
  const state: FocusedTestProcessState = {
    child: null,
    termination: null,
    started: false,
    cancelled: false,
    timedOut: false,
    exitCode: -1,
  }
  const slotWait = new AbortController()
  const stopChild = (): Promise<void> => {
    if (!state.child || state.child.exitCode !== null) return Promise.resolve()
    state.termination ??= terminateProcessGroup(state.child.pid ?? 0, {
      direct: state.child,
    }).then((result) => {
      if (!result.exited)
        throw new Error(result.reason ?? 'focused test process group did not exit')
    })
    return state.termination
  }
  /**
   * The supervising run closed: record that this execution was cancelled, release a pending host
   * slot wait, and stop whatever it is running. A child stopped for its own timeout or output
   * overflow is stopped by `stopChild` instead, so it never reports itself as a closed run.
   */
  const stop = async (): Promise<void> => {
    state.cancelled = true
    slotWait.abort()
    await stopChild()
  }
  let completion!: Promise<void>
  const unregister = registerFocusedTestExecution(input, stop, () => completion)
  completion = (async () => {
    const logName = `focused-test-${input.request.id}.log`
    const logPath = join(input.scratchDir, logName)
    const fd = createNoFollowFile(logPath)
    const started = Date.now()
    let outputTail = ''
    const record = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      writeSync(fd, bytes)
      outputTail = boundedFocusedTestOutputTail(outputTail + bytes.toString())
    }
    let executions: FocusedTestExecutionEvent[] = []
    let refusedPaths: string[] = []
    try {
      const plan = focusedTestPlan(input.runId)
      ensureFocusedTestMainStack(plan, input.environment)
      const progressPath = join(input.scratchDir, focusedTestProgressFile(input.request.id))
      const selected = await withGateSlot(
        () =>
          runFocusedTestSelection({
            plan,
            request: input.request,
            environment: input.environment,
            confinement: input.confinement,
            state,
            record,
            stopChild,
            progressPath,
          }),
        {
          signal: slotWait.signal,
          ...focusedTestWaitCallbacks({ runId: input.runId, progressPath }),
        },
      )
      executions = selected.executions
      refusedPaths = selected.refusedPaths
    } catch (error) {
      if (error instanceof HostSlotWaitAborted && state.cancelled)
        record(`\n${FOCUSED_TEST_CLOSE_REASON}\n`)
      else record(`focused test broker failed: ${String(error)}\n`)
    } finally {
      closeSync(fd)
    }
    const elapsedMs = Date.now() - started
    const result = {
      exitCode: state.exitCode,
      timedOut: state.timedOut,
      elapsedMs,
      logName,
      outputTail,
    }
    writeResult(input.scratchDir, input.request.id, result)
    recordFocusedTestEvents({
      runId: input.runId,
      executions,
      refusedPaths,
      elapsedMs,
      logName,
      logPath,
    })
  })()
    .finally(() => input.onFinish?.())
    .finally(unregister)
  return { completion, cancel: stop }
}

export function startFocusedTestBroker(input: {
  runId: string
  scratchDir: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  registerActive?: (terminate: () => Promise<void>) => () => void
  onExecutionStart?: () => void
  onExecutionFinish?: () => void
}): FocusedTestBroker {
  ensureFocusedTestDirectory(input.scratchDir)
  let closed = false
  let active: ActiveFocusedTest | null = null
  const poll = () => {
    if (closed || active) return
    let request: FocusedTestRequest | null = null
    try {
      request = claimRequest(input.scratchDir)
    } catch (error) {
      const outputTail = `focused test broker failed: ${String(error)}\n`
      writeResult(input.scratchDir, 'invalid-request', {
        exitCode: -1,
        timedOut: false,
        elapsedMs: 0,
        logName: 'focused-test-invalid-request.log',
        outputTail,
      })
      writeFocusedTestFileExclusive(
        join(input.scratchDir, 'focused-test-invalid-request.log'),
        outputTail,
      )
      removeFocusedTestFile(join(input.scratchDir, FOCUSED_TEST_ACTIVE_FILE))
      removeFocusedTestFile(join(input.scratchDir, FOCUSED_TEST_LOCK_FILE))
      return
    }
    if (!request) return
    const execution = startFocusedTest({
      ...input,
      confinement: input.confinement,
      request,
      registerActive: input.registerActive ?? (() => () => {}),
      onStart: input.onExecutionStart,
      onFinish: input.onExecutionFinish,
    })
    active = execution
    void execution.completion.then(
      () => {
        if (active === execution) active = null
      },
      () => {},
    )
  }
  const timer = setInterval(poll, FOCUSED_TEST_REQUEST_POLL_MS)
  poll()
  return {
    async close() {
      closed = true
      clearInterval(timer)
      if (active) {
        await active.cancel()
        await active.completion
      }
      removeFocusedTestFile(join(input.scratchDir, FOCUSED_TEST_REQUEST_FILE))
      removeFocusedTestFile(join(input.scratchDir, FOCUSED_TEST_ACTIVE_FILE))
      removeFocusedTestFile(join(input.scratchDir, FOCUSED_TEST_LOCK_FILE))
    },
  }
}
