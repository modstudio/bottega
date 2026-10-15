// concern: focused-test-decision
/** Pure contracts and decisions for project-registered focused test runs. */

import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

export const FOCUSED_TEST_MAX_PATHS = 64
const FOCUSED_TEST_OUTPUT_TAIL_BYTES = 16 * 1024

export type FocusedTestRunner = { command: string; args: string[] }
export type FocusedTestRunnerValidation = {
  runner: FocusedTestRunner | null
  problems: string[]
}
export type FocusedTestRequest = { id: string; paths: string[] }
export type FocusedTestResult = {
  exitCode: number
  timedOut: boolean
  elapsedMs: number
  logName: string
  outputTail: string
}

export type FocusedTestEligibility = { eligible: true } | { eligible: false; message: string }

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
  return { eligible: true }
}

export type FocusedTestRequestDecision =
  | { action: 'start' }
  | { action: 'join'; execution: FocusedTestRequest }
  | { action: 'return'; execution: FocusedTestRequest }

/** Decide whether one worker call starts, joins, or collects a focused-test execution. */
export function decideFocusedTestRequest(input: {
  execution: FocusedTestRequest | null
  finished: boolean
  resultPending: boolean
}): FocusedTestRequestDecision {
  if (!input.execution) return { action: 'start' }
  if (!input.finished) return { action: 'join', execution: input.execution }
  if (input.resultPending) return { action: 'return', execution: input.execution }
  return { action: 'start' }
}

function formatFocusedTestPaths(paths: readonly string[]): string {
  return paths.map((path) => JSON.stringify(path)).join(', ')
}

export function formatFocusedTestRequestDecision(
  decision: FocusedTestRequestDecision,
  requestedPaths: readonly string[],
): string | null {
  if (decision.action === 'join') {
    return (
      `Focused tests for ${formatFocusedTestPaths(decision.execution.paths)} were already running; ` +
      `this call ignored its requested paths (${formatFocusedTestPaths(requestedPaths)}) and waited for the same execution.`
    )
  }
  if (decision.action === 'return') {
    return (
      `Focused tests for ${formatFocusedTestPaths(decision.execution.paths)} finished after an earlier ` +
      'run_tests call stopped waiting; returning that result.'
    )
  }
  return null
}

export function decideFocusedTestWait(input: {
  finished: boolean
  waitElapsedMs: number
  paths: readonly string[]
  waitMs: number
}): { wait: true } | { wait: false; message?: string } {
  if (input.finished) return { wait: false }
  if (input.waitElapsedMs < input.waitMs) return { wait: true }
  return {
    wait: false,
    message:
      `Focused tests for ${formatFocusedTestPaths(input.paths)} are still running. ` +
      'Call run_tests again to wait for and collect this same execution.',
  }
}

function parseStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${location} must be an array of strings`)
  }
  return value as string[]
}

export function validateFocusedTestRunner(value: unknown): FocusedTestRunnerValidation {
  if (value === undefined || value === null) return { runner: null, problems: [] }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { runner: null, problems: ['focusedTests must be an object'] }
  }
  const candidate = value as Record<string, unknown>
  const problems: string[] = []
  if (typeof candidate.command !== 'string' || !candidate.command.trim()) {
    problems.push('focusedTests.command must be a non-empty string')
  }
  if (!Array.isArray(candidate.args) || candidate.args.some((item) => typeof item !== 'string')) {
    problems.push('focusedTests.args must be an array of strings')
  }
  if (problems.length) return { runner: null, problems }
  return {
    runner: {
      command: (candidate.command as string).trim(),
      args: candidate.args as string[],
    },
    problems: [],
  }
}

export function parseFocusedTestRunner(value: unknown): FocusedTestRunner | null {
  const validation = validateFocusedTestRunner(value)
  if (validation.problems.length) throw new Error(validation.problems.join('; '))
  return validation.runner
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

export function normalizeFocusedTestPaths(paths: readonly string[]): string[] {
  if (!paths.length) throw new Error('paths must contain at least one project-relative path')
  if (paths.length > FOCUSED_TEST_MAX_PATHS) {
    throw new Error(`paths may contain at most ${FOCUSED_TEST_MAX_PATHS} entries`)
  }
  return paths.map((entry) => {
    if (!entry || isAbsolute(entry)) {
      throw new Error(`focused test path ${JSON.stringify(entry)} must be relative`)
    }
    if (entry.startsWith('-')) {
      throw new Error(`focused test path ${JSON.stringify(entry)} must not start with '-'`)
    }
    const normalized = normalize(entry)
    if (normalized.split(sep).includes('..')) {
      throw new Error(`focused test path ${JSON.stringify(entry)} contains a parent segment`)
    }
    return normalized
  })
}

export type FocusedTestPathFact = {
  entry: string
  normalized: string
  resolvedRoot: string
  resolvedCandidate: string | null
  exists: boolean
}

export function decideFocusedTestPathFacts(facts: readonly FocusedTestPathFact[]): string[] {
  return facts.map(({ entry, normalized, resolvedRoot, resolvedCandidate, exists }) => {
    if (!exists || !resolvedCandidate) {
      throw new Error(`focused test path ${JSON.stringify(entry)} does not exist`)
    }
    if (!beneath(resolvedRoot, resolvedCandidate)) {
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
    command:
      isAbsolute(runner.command) || !runner.command.includes('/')
        ? runner.command
        : resolve(worktree, runner.command),
    argv: [...runner.args, ...paths],
  }
}

export function boundedFocusedTestOutputTail(value: string): string {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= FOCUSED_TEST_OUTPUT_TAIL_BYTES) return value
  return bytes.subarray(bytes.byteLength - FOCUSED_TEST_OUTPUT_TAIL_BYTES).toString()
}
