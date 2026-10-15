// concern: focused-test-broker
/** Host-side execution of focused test requests from a sandboxed writing worker. */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { db, nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import { brokerGateEnvironment, GATE_COMMAND_TIMEOUT_MS } from '../gate/gate-decision.ts'
import { terminateProcessGroup } from '../idle-kill.ts'
import { workerGateEnvironment } from '../issue/issue-shell.ts'
import type { MainStackConsumer } from '../project/project-settings.ts'
import { ensureMainStackStarted } from '../resources/main-stack.ts'
import {
  boundedFocusedTestOutputTail,
  type FocusedTestRequest,
  type FocusedTestResult,
  focusedTestInvocation,
  parseFocusedTestRequest,
  parseFocusedTestRunner,
} from './focused-test-decision.ts'
import {
  createFocusedTestFile,
  readFocusedTestRegularFile,
  writeFocusedTestFileAtomic,
  writeFocusedTestFileExclusive,
} from './focused-test-files.ts'
import { validateFocusedTestPaths } from './focused-test-paths.ts'
import {
  FOCUSED_TEST_ACTIVE_FILE,
  FOCUSED_TEST_LOCK_FILE,
  FOCUSED_TEST_REQUEST_FILE,
  focusedTestResultFile,
} from './focused-test-request.ts'

const FOCUSED_TEST_REQUEST_POLL_MS = 250
const FOCUSED_TEST_CLOSE_REASON = 'Focused test run cancelled because the supervising run closed.'

type ActiveFocusedTest = { completion: Promise<void>; cancel(): Promise<void> }
export type FocusedTestBroker = { close(): Promise<void> }

function focusedTestPlan(runId: number) {
  const row = db()
    .query(
      `SELECT r.worktree,p.id project_id,p.name project_name,p.settings
       FROM run r JOIN project p ON p.id=r.project_id WHERE r.id=?`,
    )
    .get(runId) as {
    worktree: string | null
    project_id: number
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
    projectId: row.project_id,
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
  if (!existsSync(requestPath)) return null
  const activePath = join(scratchDir, FOCUSED_TEST_ACTIVE_FILE)
  let contents: string
  try {
    contents = readFocusedTestRegularFile(requestPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  writeFocusedTestFileExclusive(activePath, contents)
  rmSync(requestPath)
  return parseFocusedTestRequest(JSON.parse(contents))
}

function startFocusedTest(input: {
  runId: number
  scratchDir: string
  environment: Record<string, string>
  request: FocusedTestRequest
  registerActive: (terminate: () => Promise<void>) => () => void
}): ActiveFocusedTest {
  let child: ReturnType<typeof spawn> | null = null
  let termination: Promise<void> | null = null
  let cancelled = false
  const stop = (): Promise<void> => {
    cancelled = true
    if (!child || child.exitCode !== null) return Promise.resolve()
    termination ??= terminateProcessGroup(child.pid ?? 0, { direct: child }).then((result) => {
      if (!result.exited)
        throw new Error(result.reason ?? 'focused test process group did not exit')
    })
    return termination
  }
  let completion!: Promise<void>
  const unregister = input.registerActive(async () => {
    await stop()
    await completion
  })
  completion = (async () => {
    const logName = `focused-test-${input.request.id}.log`
    const logPath = join(input.scratchDir, logName)
    const fd = createFocusedTestFile(logPath)
    const started = Date.now()
    let outputTail = ''
    let exitCode = -1
    let timedOut = false
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
      child = spawn(invocation.command, invocation.argv, {
        cwd: plan.worktree,
        env: brokerGateEnvironment(
          workerGateEnvironment(process.env),
          process.env,
          input.environment,
        ),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.on('data', record)
      child.stderr?.on('data', record)
      child.once('error', (error) =>
        record(`focused test runner could not start: ${String(error)}\n`),
      )
      const timeout = setTimeout(() => {
        timedOut = true
        void stop()
      }, GATE_COMMAND_TIMEOUT_MS)
      await waitForExit(child)
      clearTimeout(timeout)
      if (termination) await termination
      exitCode = child.exitCode ?? -1
      if (timedOut) record(`\nfocused tests timed out after ${GATE_COMMAND_TIMEOUT_MS}ms\n`)
      if (cancelled && !timedOut) record(`\n${FOCUSED_TEST_CLOSE_REASON}\n`)
    } catch (error) {
      record(`focused test broker failed: ${String(error)}\n`)
    } finally {
      closeSync(fd)
    }
    const elapsedMs = Date.now() - started
    const result = { exitCode, timedOut, elapsedMs, logName, outputTail }
    writeResult(input.scratchDir, input.request.id, result)
    appendRunEvent(input.runId, {
      ts: nowIso(),
      type: 'focused_test',
      paths: input.request.paths,
      exitCode,
      timedOut,
      elapsedMs,
      logName,
    })
  })()
    .finally(() => {
      rmSync(join(input.scratchDir, FOCUSED_TEST_ACTIVE_FILE), { force: true })
      rmSync(join(input.scratchDir, FOCUSED_TEST_LOCK_FILE), { force: true })
    })
    .finally(unregister)
  return { completion, cancel: stop }
}

export function startFocusedTestBroker(input: {
  runId: number
  scratchDir: string
  environment: Record<string, string>
  registerActive?: (terminate: () => Promise<void>) => () => void
}): FocusedTestBroker {
  mkdirSync(input.scratchDir, { recursive: true })
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
      rmSync(join(input.scratchDir, FOCUSED_TEST_ACTIVE_FILE), { force: true })
      rmSync(join(input.scratchDir, FOCUSED_TEST_LOCK_FILE), { force: true })
      return
    }
    if (!request) return
    const execution = startFocusedTest({
      ...input,
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
      rmSync(join(input.scratchDir, FOCUSED_TEST_REQUEST_FILE), { force: true })
      rmSync(join(input.scratchDir, FOCUSED_TEST_ACTIVE_FILE), { force: true })
      rmSync(join(input.scratchDir, FOCUSED_TEST_LOCK_FILE), { force: true })
    },
  }
}
