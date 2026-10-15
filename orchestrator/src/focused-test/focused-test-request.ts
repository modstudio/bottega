// concern: focused-test-request
/** Scratch-file request transport used by the worker-facing run_tests tool. */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { RUN_GATE_WAIT_MS } from '../gate/gate-decision.ts'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import {
  decideFocusedTestRequest,
  decideFocusedTestWait,
  type FocusedTestRequest,
  formatFocusedTestRequestDecision,
  parseFocusedTestRequest,
  parseFocusedTestResult,
} from './focused-test-decision.ts'
import {
  ensureFocusedTestDirectory,
  focusedTestFileExists,
  readFocusedTestRegularFile,
  removeFocusedTestFile,
  writeFocusedTestFileAtomic,
  writeFocusedTestFileExclusive,
} from './focused-test-files.ts'

export const FOCUSED_TEST_LOCK_FILE = 'focused-test.lock'
export const FOCUSED_TEST_REQUEST_FILE = 'focused-test-request.json'
export const FOCUSED_TEST_ACTIVE_FILE = 'focused-test-active.json'
export const focusedTestResultFile = (id: string) => `focused-test-result-${id}.json`
const FOCUSED_TEST_POLL_MS = 250
const pendingResults = new Set<string>()

type FocusedTestWaitDependencies = {
  waitMs: number
  now(): number
  wait(ms: number): Promise<void>
}

const defaultWaitDependencies: FocusedTestWaitDependencies = {
  waitMs: RUN_GATE_WAIT_MS,
  now: Date.now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

function waitForPoll(
  ms: number,
  signal: AbortSignal,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const aborted = () => finish(resolve)
    const finish = (settle: () => void) => {
      signal.removeEventListener('abort', aborted)
      settle()
    }
    signal.addEventListener('abort', aborted, { once: true })
    wait(ms).then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    )
  })
}

function tryCreateExecution(scratchDir: string, request: FocusedTestRequest): boolean {
  try {
    writeFocusedTestFileExclusive(join(scratchDir, FOCUSED_TEST_LOCK_FILE), JSON.stringify(request))
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    throw error
  }
}

function currentExecution(scratchDir: string): FocusedTestRequest | null {
  const lockPath = join(scratchDir, FOCUSED_TEST_LOCK_FILE)
  if (!focusedTestFileExists(lockPath)) return null
  return parseFocusedTestRequest(JSON.parse(readFocusedTestRegularFile(lockPath)))
}

function clearExecution(scratchDir: string, execution: FocusedTestRequest): void {
  removeFocusedTestFile(join(scratchDir, focusedTestResultFile(execution.id)))
  removeFocusedTestFile(join(scratchDir, FOCUSED_TEST_REQUEST_FILE))
  removeFocusedTestFile(join(scratchDir, FOCUSED_TEST_ACTIVE_FILE))
  removeFocusedTestFile(join(scratchDir, FOCUSED_TEST_LOCK_FILE))
}

function formatResult(
  runId: number,
  scratchDir: string,
  result: ReturnType<typeof parseFocusedTestResult>,
) {
  const liveLog = join(scratchDir, result.logName)
  const artifact = join(runArtifactsDir(runId), result.logName)
  return [
    `Focused tests exited ${result.exitCode}${result.timedOut ? ' after timing out' : ''} in ${result.elapsedMs}ms.`,
    `Full log: ${liveLog}`,
    `After the run closes: ${artifact}`,
    result.outputTail ? `Output tail:\n${result.outputTail}` : 'Output tail: (empty)',
  ].join('\n')
}

export async function requestFocusedTests(
  input: {
    runId: number
    scratchDir: string
    paths: string[]
    signal: AbortSignal
  },
  dependencies: FocusedTestWaitDependencies = defaultWaitDependencies,
): Promise<string> {
  ensureFocusedTestDirectory(input.scratchDir)
  let execution = currentExecution(input.scratchDir)
  let resultPath = execution ? join(input.scratchDir, focusedTestResultFile(execution.id)) : null
  let decision = decideFocusedTestRequest({
    execution,
    finished: resultPath ? focusedTestFileExists(resultPath) : false,
    resultPending: execution ? pendingResults.has(execution.id) : false,
  })

  if (decision.action === 'start' && execution) {
    clearExecution(input.scratchDir, execution)
    execution = null
  }
  if (decision.action === 'start') {
    const request = { id: randomUUID(), paths: input.paths }
    if (!tryCreateExecution(input.scratchDir, request)) {
      execution = currentExecution(input.scratchDir)
      if (!execution) throw new Error('focused test execution lock has no request')
      resultPath = join(input.scratchDir, focusedTestResultFile(execution.id))
      decision = decideFocusedTestRequest({
        execution,
        finished: focusedTestFileExists(resultPath),
        resultPending: pendingResults.has(execution.id),
      })
    } else {
      execution = request
      resultPath = join(input.scratchDir, focusedTestResultFile(request.id))
      try {
        writeFocusedTestFileAtomic(
          join(input.scratchDir, FOCUSED_TEST_REQUEST_FILE),
          JSON.stringify(request),
        )
      } catch (error) {
        clearExecution(input.scratchDir, request)
        throw error
      }
    }
  }

  if (!execution || !resultPath) throw new Error('focused test request has no execution')
  const introduction = formatFocusedTestRequestDecision(decision, input.paths)
  pendingResults.add(execution.id)
  const waitStartedAt = dependencies.now()
  const requestPath = join(input.scratchDir, FOCUSED_TEST_REQUEST_FILE)
  const requestTempPath = `${requestPath}.tmp`
  try {
    for (;;) {
      if (input.signal.aborted) {
        return 'The focused test wait stopped because the run_tests call was cancelled.'
      }
      const finished = focusedTestFileExists(resultPath)
      const now = dependencies.now()
      const waitDecision = decideFocusedTestWait({
        finished,
        waitElapsedMs: now - waitStartedAt,
        paths: execution.paths,
        waitMs: dependencies.waitMs,
      })
      if (finished) {
        const result = parseFocusedTestResult(JSON.parse(readFocusedTestRegularFile(resultPath)))
        pendingResults.delete(execution.id)
        const formatted = formatResult(input.runId, input.scratchDir, result)
        return introduction ? `${introduction}\n${formatted}` : formatted
      }
      if (!waitDecision.wait) return waitDecision.message!
      await waitForPoll(
        Math.min(FOCUSED_TEST_POLL_MS, dependencies.waitMs - (now - waitStartedAt)),
        input.signal,
        dependencies.wait,
      )
    }
  } finally {
    removeFocusedTestFile(requestTempPath)
  }
}
