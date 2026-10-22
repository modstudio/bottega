// concern: focused-test-broker
/** Host-side execution of focused test requests from a sandboxed writing worker. */

import { spawn } from 'node:child_process'
import { closeSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { db, nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import {
  type BrokerConfinement,
  type BrokerLaunchDecision,
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
import { lowerRunChildPriority } from '../run/run-child-priority.ts'
import { type SandboxRuntimeConfig, sandboxLaunchArgv } from '../sandbox/sandbox.ts'
import {
  boundedFocusedTestOutputTail,
  type FocusedTestRequest,
  type FocusedTestResult,
  focusedTestInvocation,
  parseFocusedTestRequest,
  parseFocusedTestRunner,
} from './focused-test-decision.ts'
import {
  ensureFocusedTestDirectory,
  focusedTestFileExists,
  readFocusedTestRegularFile,
  removeFocusedTestFile,
  writeFocusedTestFileAtomic,
  writeFocusedTestFileExclusive,
} from './focused-test-files.ts'
import { validateFocusedTestPaths } from './focused-test-paths.ts'
import {
  FOCUSED_TEST_ACTIVE_FILE,
  FOCUSED_TEST_LOCK_FILE,
  FOCUSED_TEST_REQUEST_FILE,
  focusedTestProgressFile,
  focusedTestResultFile,
} from './focused-test-request.ts'

const FOCUSED_TEST_REQUEST_POLL_MS = 250
const FOCUSED_TEST_CLOSE_REASON = 'Focused test run cancelled because the supervising run closed.'

type ActiveFocusedTest = { completion: Promise<void>; cancel(): Promise<void> }
export type FocusedTestBroker = { close(): Promise<void> }
type FocusedTestProcessState = {
  child: ReturnType<typeof spawn> | null
  termination: Promise<void> | null
  started: boolean
  cancelled: boolean
  timedOut: boolean
  exitCode: number
}

function focusedTestPlan(runId: string) {
  const row = db()
    .query(
      `SELECT r.worktree,p.record_id project_record_id,p.name project_name,p.settings
       FROM run r JOIN project p ON p.record_id=r.project_record_id WHERE r.record_id=?`,
    )
    .get(runId) as {
    worktree: string | null
    project_record_id: string
    project_name: string
    settings: string | null
  } | null
  if (!row?.worktree) throw new Error(`run ${runId} has no recorded worktree`)
  const settings = JSON.parse(row.settings ?? '{}') as {
    focusedTests?: unknown
    mainStack?: { consumers?: MainStackConsumer[]; requiredServices?: string[] }
  }
  const runner = parseFocusedTestRunner(settings.focusedTests)
  if (!runner) throw new Error(`run ${runId}'s project has no registered focused test runner`)
  return {
    runner,
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
  const mainCheckout = environment.ORCH_MAIN_CHECKOUT
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
): Promise<string[]> {
  const decision = focusedTestBrokerLaunchDecision(confinement, command, argv)
  return decision.kind === 'srt'
    ? sandboxLaunchArgv(decision.profile, decision.bin, decision.argv)
    : decision.argv
}

export function focusedTestBrokerLaunchDecision(
  confinement: BrokerConfinement<SandboxRuntimeConfig>,
  command: string,
  argv: string[],
): BrokerLaunchDecision<SandboxRuntimeConfig> {
  return decideBrokerLaunch(confinement, command, argv)
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
  return lowerRunChildPriority(
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
  stop: () => Promise<void>
}): Promise<void> {
  const { state } = input
  state.child = await spawnFocusedTestChild(input)
  state.child.stdout?.on('data', input.record)
  state.child.stderr?.on('data', input.record)
  state.child.once('spawn', () => {
    state.started = true
  })
  state.child.once('error', (error) =>
    input.record(`focused test runner could not start: ${String(error)}\n`),
  )
  const timeout = setTimeout(() => {
    state.timedOut = true
    void input.stop()
  }, GATE_COMMAND_TIMEOUT_MS)
  await waitForExit(state.child)
  clearTimeout(timeout)
  if (state.termination) await state.termination
  state.exitCode = state.child.exitCode ?? -1
  if (state.timedOut) input.record(`\nfocused tests timed out after ${GATE_COMMAND_TIMEOUT_MS}ms\n`)
  if (state.cancelled && !state.timedOut) input.record(`\n${FOCUSED_TEST_CLOSE_REASON}\n`)
}

function focusedTestWaitCallbacks(input: { runId: string; progressPath: string }) {
  return hostSlotWaitCallbacks({
    runId: input.runId,
    writeProgress: (message) => writeFocusedTestFileAtomic(input.progressPath, message),
  })
}

function startFocusedTest(input: {
  runId: string
  scratchDir: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  request: FocusedTestRequest
  registerActive: (terminate: () => Promise<void>) => () => void
}): ActiveFocusedTest {
  const state: FocusedTestProcessState = {
    child: null,
    termination: null,
    started: false,
    cancelled: false,
    timedOut: false,
    exitCode: -1,
  }
  const slotWait = new AbortController()
  const stop = (): Promise<void> => {
    state.cancelled = true
    slotWait.abort()
    if (!state.child || state.child.exitCode !== null) return Promise.resolve()
    state.termination ??= terminateProcessGroup(state.child.pid ?? 0, {
      direct: state.child,
    }).then((result) => {
      if (!result.exited)
        throw new Error(result.reason ?? 'focused test process group did not exit')
    })
    return state.termination
  }
  let completion!: Promise<void>
  const unregister = input.registerActive(async () => {
    await stop()
    await completion
  })
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
    try {
      const plan = focusedTestPlan(input.runId)
      const paths = validateFocusedTestPaths(input.request.paths, plan.worktree)
      ensureFocusedTestMainStack(plan, input.environment)
      const invocation = focusedTestInvocation(plan.runner, paths, plan.worktree)
      const progressPath = join(input.scratchDir, focusedTestProgressFile(input.request.id))
      await withGateSlot(
        () => {
          removeFocusedTestFile(progressPath)
          return runFocusedTestProcess({
            invocation,
            worktree: plan.worktree,
            environment: input.environment,
            confinement: input.confinement,
            state,
            record,
            stop,
          })
        },
        {
          signal: slotWait.signal,
          ...focusedTestWaitCallbacks({ runId: input.runId, progressPath }),
        },
      )
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
    appendRunEvent(input.runId, {
      ts: nowIso(),
      type: 'focused_test',
      paths: input.request.paths,
      started: state.started,
      exitCode: state.exitCode,
      timedOut: state.timedOut,
      elapsedMs,
      logName,
      logPath,
    })
  })().finally(unregister)
  return { completion, cancel: stop }
}

export function startFocusedTestBroker(input: {
  runId: string
  scratchDir: string
  environment: Record<string, string>
  confinement: BrokerConfinement<SandboxRuntimeConfig>
  registerActive?: (terminate: () => Promise<void>) => () => void
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
