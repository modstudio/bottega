// concern: focused-test-decision
/** Pure contracts and path confinement for project-registered focused test runs. */

import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

export const FOCUSED_TEST_MAX_PATHS = 64
export const FOCUSED_TEST_OUTPUT_TAIL_BYTES = 16 * 1024

export type FocusedTestRunner = { command: string; args: string[] }
export type FocusedTestRequest = { id: string; paths: string[] }
export type FocusedTestResult = {
  exitCode: number
  timedOut: boolean
  elapsedMs: number
  logName: string
  outputTail: string
}

export type FocusedTestEligibility =
  | { eligible: true; runner: FocusedTestRunner }
  | { eligible: false; message: string }

export function decideFocusedTestEligibility(input: {
  authenticated: boolean
  writer: boolean
  runner: FocusedTestRunner | null
}): FocusedTestEligibility {
  if (!input.authenticated) {
    return { eligible: false, message: 'This process is not a recognized orchestrator worker.' }
  }
  if (!input.writer) {
    return { eligible: false, message: 'run_tests is available only to a writing worker run.' }
  }
  if (!input.runner) {
    return {
      eligible: false,
      message: "This run's project has no registered focused test runner, so nothing was run.",
    }
  }
  return { eligible: true, runner: input.runner }
}

export function decideFocusedTestRequest(busy: boolean): string | null {
  return busy ? 'A focused test run is already in flight for this run.' : null
}

function parseStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${location} must be an array of strings`)
  }
  return value as string[]
}

export function parseFocusedTestRunner(value: unknown): FocusedTestRunner | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('focusedTests must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.command !== 'string' || !candidate.command.trim()) {
    throw new Error('focusedTests.command must be a non-empty string')
  }
  return {
    command: candidate.command.trim(),
    args: parseStringArray(candidate.args, 'focusedTests.args'),
  }
}

export function parseFocusedTestRequest(value: unknown): FocusedTestRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('focused test request must be an object')
  }
  const request = value as Record<string, unknown>
  if (typeof request.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(request.id)) {
    throw new Error('focused test request id is invalid')
  }
  return { id: request.id, paths: parseStringArray(request.paths, 'paths') }
}

export function parseFocusedTestResult(value: unknown): FocusedTestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('focused test result must be an object')
  }
  const result = value as Record<string, unknown>
  if (!Number.isInteger(result.exitCode)) throw new Error('focused test result exitCode is invalid')
  if (typeof result.timedOut !== 'boolean') {
    throw new Error('focused test result timedOut is invalid')
  }
  if (typeof result.elapsedMs !== 'number' || !Number.isFinite(result.elapsedMs)) {
    throw new Error('focused test result elapsedMs is invalid')
  }
  if (typeof result.logName !== 'string' || !result.logName || result.logName.includes('/')) {
    throw new Error('focused test result logName is invalid')
  }
  if (typeof result.outputTail !== 'string') {
    throw new Error('focused test result outputTail is invalid')
  }
  return result as FocusedTestResult
}

function beneath(root: string, candidate: string): boolean {
  const offset = relative(root, candidate)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

export function validateFocusedTestPaths(paths: readonly string[], worktree: string): string[] {
  if (!paths.length) throw new Error('paths must contain at least one project-relative path')
  if (paths.length > FOCUSED_TEST_MAX_PATHS) {
    throw new Error(`paths may contain at most ${FOCUSED_TEST_MAX_PATHS} entries`)
  }
  const root = realpathSync(worktree)
  return paths.map((entry) => {
    if (!entry || isAbsolute(entry)) {
      throw new Error(`focused test path ${JSON.stringify(entry)} must be relative`)
    }
    const normalized = normalize(entry)
    if (normalized.split(sep).includes('..')) {
      throw new Error(`focused test path ${JSON.stringify(entry)} contains a parent segment`)
    }
    let actual: string
    try {
      actual = realpathSync(resolve(root, normalized))
      statSync(actual)
    } catch {
      throw new Error(`focused test path ${JSON.stringify(entry)} does not exist`)
    }
    if (!beneath(root, actual)) {
      throw new Error(
        `focused test path ${JSON.stringify(entry)} resolves outside the run worktree`,
      )
    }
    return normalized
  })
}

export function focusedTestInvocation(
  runner: FocusedTestRunner,
  paths: readonly string[],
  worktree: string,
): { command: string; argv: string[] } {
  return {
    command: isAbsolute(runner.command) ? runner.command : resolve(worktree, runner.command),
    argv: [...runner.args, ...paths],
  }
}

export function boundedFocusedTestOutputTail(value: string): string {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= FOCUSED_TEST_OUTPUT_TAIL_BYTES) return value
  return bytes.subarray(bytes.byteLength - FOCUSED_TEST_OUTPUT_TAIL_BYTES).toString()
}
