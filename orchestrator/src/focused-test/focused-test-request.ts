// concern: focused-test-request
/** Scratch-file request transport used by the worker-facing run_tests tool. */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import { decideFocusedTestRequest, parseFocusedTestResult } from './focused-test-decision.ts'

export const FOCUSED_TEST_LOCK_FILE = 'focused-test.lock'
export const FOCUSED_TEST_REQUEST_FILE = 'focused-test-request.json'
export const FOCUSED_TEST_ACTIVE_FILE = 'focused-test-active.json'
export const focusedTestResultFile = (id: string) => `focused-test-result-${id}.json`
const FOCUSED_TEST_POLL_MS = 250

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    const aborted = () => finish()
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      resolve()
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

function acquireRequestLock(scratchDir: string): string | null {
  const path = join(scratchDir, FOCUSED_TEST_LOCK_FILE)
  try {
    closeSync(openSync(path, 'wx'))
    return null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return decideFocusedTestRequest(true)
    throw error
  }
}

export async function requestFocusedTests(input: {
  runId: number
  scratchDir: string
  paths: string[]
  signal: AbortSignal
}): Promise<string> {
  mkdirSync(input.scratchDir, { recursive: true })
  const refusal = acquireRequestLock(input.scratchDir)
  if (refusal) return refusal
  const lockPath = join(input.scratchDir, FOCUSED_TEST_LOCK_FILE)
  const requestPath = join(input.scratchDir, FOCUSED_TEST_REQUEST_FILE)
  const requestTempPath = `${requestPath}.tmp`
  const request = { id: randomUUID(), paths: input.paths }
  const resultPath = join(input.scratchDir, focusedTestResultFile(request.id))
  let submitted = false
  try {
    rmSync(resultPath, { force: true })
    writeFileSync(requestTempPath, JSON.stringify(request))
    renameSync(requestTempPath, requestPath)
    submitted = true
    while (!existsSync(resultPath)) {
      if (input.signal.aborted) {
        return 'The focused test wait stopped because the run_tests call was cancelled.'
      }
      await waitForPoll(FOCUSED_TEST_POLL_MS, input.signal)
    }
    const result = parseFocusedTestResult(JSON.parse(readFileSync(resultPath, 'utf8')))
    rmSync(resultPath, { force: true })
    const artifact = join(runArtifactsDir(input.runId), result.logName)
    return [
      `Focused tests exited ${result.exitCode}${result.timedOut ? ' after timing out' : ''} in ${result.elapsedMs}ms.`,
      `Full log: ${artifact}`,
      result.outputTail ? `Output tail:\n${result.outputTail}` : 'Output tail: (empty)',
    ].join('\n')
  } finally {
    rmSync(requestTempPath, { force: true })
    if (!submitted) {
      rmSync(requestPath, { force: true })
      rmSync(lockPath, { force: true })
    }
  }
}
