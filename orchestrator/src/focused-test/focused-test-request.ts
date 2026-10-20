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
export const focusedTestProgressFile = (id: string) => `focused-test-progress-${id}.txt`
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
  removeFocusedTestFile(join(scratchDir, focusedTestProgressFile(execution.id)))
  removeFocusedTestFile(join(scratchDir, FOCUSED_TEST_REQUEST_FILE))
  removeFocusedTestFile(join(scratchDir, FOCUSED_TEST_ACTIVE_FILE))
  removeFocusedTestFile(join(scratchDir, FOCUSED_TEST_LOCK_FILE))
}

function formatResult(
  runId: string,
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

function decideCurrentExecution(scratchDir: string): {
  execution: FocusedTestRequest | null
  resultPath: string | null
  decision: ReturnType<typeof decideFocusedTestRequest>
} {
  const execution = currentExecution(scratchDir)
  const resultPath = execution ? join(scratchDir, focusedTestResultFile(execution.id)) : null
  return {
    execution,
    resultPath,
    decision: decideFocusedTestRequest({
      execution,
      finished: resultPath ? focusedTestFileExists(resultPath) : false,
      resultPending: execution ? pendingResults.has(execution.id) : false,
    }),
  }
}

function startFocusedTestExecution(
  scratchDir: string,
  paths: string[],
): ReturnType<typeof decideCurrentExecution> {
  const request = { id: randomUUID(), paths }
  if (!tryCreateExecution(scratchDir, request)) return decideCurrentExecution(scratchDir)
  try {
    writeFocusedTestFileAtomic(join(scratchDir, FOCUSED_TEST_REQUEST_FILE), JSON.stringify(request))
  } catch (error) {
    clearExecution(scratchDir, request)
    throw error
  }
  return {
    execution: request,
    resultPath: join(scratchDir, focusedTestResultFile(request.id)),
    decision: { action: 'start' },
  }
}

function admitFocusedTestExecution(
  scratchDir: string,
  paths: string[],
): ReturnType<typeof decideCurrentExecution> {
  const current = decideCurrentExecution(scratchDir)
  if (current.decision.action !== 'start') return current
  if (current.execution) clearExecution(scratchDir, current.execution)
  const admitted = startFocusedTestExecution(scratchDir, paths)
  if (!admitted.execution) throw new Error('focused test execution lock has no request')
  return admitted
}

async function waitForFocusedTestExecution(input: {
  runId: string
  scratchDir: string
  signal: AbortSignal
  execution: FocusedTestRequest
  resultPath: string
  introduction: string | null
  dependencies: FocusedTestWaitDependencies
}): Promise<string> {
  pendingResults.add(input.execution.id)
  const waitStartedAt = input.dependencies.now()
  for (;;) {
    if (input.signal.aborted) {
      return 'The focused test wait stopped because the run_tests call was cancelled.'
    }
    const finished = focusedTestFileExists(input.resultPath)
    const now = input.dependencies.now()
    const waitDecision = decideFocusedTestWait({
      finished,
      waitElapsedMs: now - waitStartedAt,
      paths: input.execution.paths,
      waitMs: input.dependencies.waitMs,
    })
    if (finished) {
      const result = parseFocusedTestResult(
        JSON.parse(readFocusedTestRegularFile(input.resultPath)),
      )
      pendingResults.delete(input.execution.id)
      const formatted = formatResult(input.runId, input.scratchDir, result)
      return input.introduction ? `${input.introduction}\n${formatted}` : formatted
    }
    if (!waitDecision.wait) {
      const progressPath = join(input.scratchDir, focusedTestProgressFile(input.execution.id))
      const progress = focusedTestFileExists(progressPath)
        ? `\n${readFocusedTestRegularFile(progressPath)}`
        : ''
      return `${waitDecision.message!}${progress}`
    }
    await waitForPoll(
      Math.min(FOCUSED_TEST_POLL_MS, input.dependencies.waitMs - (now - waitStartedAt)),
      input.signal,
      input.dependencies.wait,
    )
  }
}

export async function requestFocusedTests(
  input: {
    runId: string
    scratchDir: string
    paths: string[]
    signal: AbortSignal
  },
  dependencies: FocusedTestWaitDependencies = defaultWaitDependencies,
): Promise<string> {
  ensureFocusedTestDirectory(input.scratchDir)
  const { execution, resultPath, decision } = admitFocusedTestExecution(
    input.scratchDir,
    input.paths,
  )
  if (!execution || !resultPath) throw new Error('focused test request has no execution')
  const introduction = formatFocusedTestRequestDecision(decision, input.paths)
  const requestPath = join(input.scratchDir, FOCUSED_TEST_REQUEST_FILE)
  const requestTempPath = `${requestPath}.tmp`
  try {
    return await waitForFocusedTestExecution({
      runId: input.runId,
      scratchDir: input.scratchDir,
      signal: input.signal,
      execution,
      resultPath,
      introduction,
      dependencies,
    })
  } finally {
    removeFocusedTestFile(requestTempPath)
  }
}
