// concern: worker gate decisions
/** Pure eligibility, concurrency, and result presentation for a registered worker gate. */

import { isAbsolute, resolve } from 'node:path'
export type BrokerConfinement<Profile = unknown> =
  | { kind: 'host' }
  | { kind: 'srt'; profile: Profile }

export type BrokerLaunchDecision<Profile = unknown> =
  | { kind: 'host'; argv: string[] }
  | { kind: 'srt'; profile: Profile; bin: string; argv: string[] }

export function decideBrokerLaunch<Profile>(
  confinement: BrokerConfinement<Profile>,
  bin: string,
  argv: string[],
): BrokerLaunchDecision<Profile> {
  return confinement.kind === 'srt'
    ? { kind: 'srt', profile: confinement.profile, bin, argv }
    : { kind: 'host', argv: [bin, ...argv] }
}

export const GATE_OUTPUT_TAIL_BYTES = 16 * 1024
export const GATE_COMMAND_TIMEOUT_MS = 20 * 60_000
/** Stay below the shortest harness tool-call ceiling observed. */
export const RUN_GATE_WAIT_MS = 4 * 60_000
export const GATE_CLOSE_REASON = 'Gate run cancelled because the supervising run closed.'
const GATE_TOOLING_PATH_NAMES = [
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'deno.lock',
  'Cargo.lock',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'Makefile',
] as const

/** Add broker-only host paths before applying the orchestrator environment overlay. */
export function brokerGateEnvironment(
  base: Readonly<Record<string, string>>,
  source: Readonly<Record<string, string | undefined>>,
  overlay: Readonly<Record<string, string>>,
): Record<string, string> {
  const hostPaths: Record<string, string> = {}
  if (source.HOME) hostPaths.HOME = source.HOME
  if (source.TMPDIR) hostPaths.TMPDIR = source.TMPDIR
  const environment = { ...base, ...hostPaths, ...overlay }
  delete environment.ORCH_GATE_PIDS
  return environment
}

function quoteShellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** Resolve a registered relative executable from the tree the gate checks. */
export function resolveGateCommand(command: string, worktree: string): string {
  const match = /^(\s*)(\S+)([\s\S]*)$/.exec(command)
  if (!match) return command
  const [, leading, first, rest] = match
  if (!first!.includes('/') || isAbsolute(first!)) return command
  return `${leading}${quoteShellWord(resolve(worktree, first!))}${rest}`
}

/** Attribute a gate to a commit only when it tested that commit's clean tree. */
export function decideGateHeadCommit(input: {
  headCommit: string
  porcelainPaths: readonly string[]
}): string | null {
  return input.headCommit && input.porcelainPaths.length === 0 ? input.headCommit : null
}

/** Prefer the live trunk merge-base so a rebased worker excludes trunk-only changes. */
export function decideGateToolingDiffBase(input: {
  recordedBase: string
  mergeBase: string | null
}): string {
  return input.mergeBase?.trim() || input.recordedBase
}

/** Reduce process state to the durable broker completion fields. */
export function decideGateExecutionFinalization(input: {
  exitCode: number
  timedOut: boolean
  cancelledReason: string | null
  logCreated: boolean
  artifactPath: string
}): {
  exitCode: number
  timedOut: boolean
  cancelledReason: string | null
  artifactPath: string | null
} {
  return {
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    cancelledReason: input.cancelledReason,
    artifactPath: input.logCreated ? input.artifactPath : null,
  }
}

export type GateEligibility =
  | { eligible: true; gate: string }
  | { eligible: false; message: string }

export function decideGateEligibility(input: {
  authenticated: boolean
  writer: boolean
  gate: string | null
}): GateEligibility {
  if (!input.authenticated) {
    return { eligible: false, message: 'This process is not a recognized orchestrator worker.' }
  }
  if (!input.writer) {
    return { eligible: false, message: 'run_gate is available only to a writing worker run.' }
  }
  const gate = input.gate?.trim()
  if (!gate) {
    return {
      eligible: false,
      message: "This run's project has no registered gate, so nothing was run.",
    }
  }
  return { eligible: true, gate }
}

export type GateRequestDecision =
  | { action: 'start' }
  | { action: 'join'; executionId: number }
  | { action: 'return'; executionId: number }

/** Decide whether one worker call starts, joins, or collects a gate execution. */
export function decideGateRequest(input: {
  execution: { id: number; finished: boolean } | null
  resultPending: boolean
}): GateRequestDecision {
  if (!input.execution) return { action: 'start' }
  if (!input.execution.finished) return { action: 'join', executionId: input.execution.id }
  if (input.resultPending) return { action: 'return', executionId: input.execution.id }
  return { action: 'start' }
}

/** Present how a repeated call reached an existing execution. */
export function formatGateRequestDecision(decision: GateRequestDecision): string | null {
  if (decision.action === 'join') {
    return `Gate execution ${decision.executionId} was already running; this call waited for the same execution.`
  }
  if (decision.action === 'return') {
    return `Gate execution ${decision.executionId} finished after an earlier run_gate call stopped waiting; returning that result.`
  }
  return null
}

export function decideGateWait(input: {
  finished: boolean
  waitElapsedMs: number
  executionElapsedMs: number
  waitMs?: number
}): { wait: true } | { wait: false; message?: string } {
  if (input.finished) return { wait: false }
  if (input.waitElapsedMs < (input.waitMs ?? RUN_GATE_WAIT_MS)) return { wait: true }
  return {
    wait: false,
    message:
      `The gate is still running after ${input.executionElapsedMs}ms. ` +
      'Call run_gate again to wait for this same execution. ' +
      'Do not report done before you have its result.',
  }
}

export function decideGateCancellation(input: {
  requestsClosed: boolean
  runLive: boolean
}): string | null {
  if (input.requestsClosed) return GATE_CLOSE_REASON
  if (!input.runLive) return 'Gate run cancelled because the supervising run is no longer live.'
  return null
}

function registeredGatePath(command: string): string | null {
  const first = /^\s*(\S+)/.exec(command)?.[1]
  if (!first || isAbsolute(first) || !first.includes('/')) return null
  return first.replace(/^\.\//, '')
}

/** Classify a changed path that can affect what a registered gate executes. */
export function isGateToolingPath(path: string, gateCommand: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  const parts = normalized.split('/')
  const name = parts.at(-1) ?? ''
  if (normalized === registeredGatePath(gateCommand)) return true
  if (parts.includes('scripts') || parts.includes('.githooks')) return true
  if ((GATE_TOOLING_PATH_NAMES as readonly string[]).includes(name)) return true
  if (/^docker-compose/i.test(name) || /^compose.*\.ya?ml$/i.test(name)) return true
  if (parts.length !== 1) return false
  return (
    /^.+\.config\..+$/.test(name) ||
    name.endsWith('.jsonc') ||
    name.endsWith('.toml') ||
    name.startsWith('.env')
  )
}

/** Reduce the repository observations to the sorted gate inputs recorded as evidence. */
export function changedGateToolingPaths(input: {
  diffPaths: readonly string[]
  untrackedPaths: readonly string[]
  gateCommand: string
}): string[] {
  return [...new Set([...input.diffPaths, ...input.untrackedPaths])]
    .filter((path) => isGateToolingPath(path, input.gateCommand))
    .sort()
}

/** Keep the last complete UTF-8 text that fits in the worker-context bound. */
export function boundedGateOutputTail(output: string, bound = GATE_OUTPUT_TAIL_BYTES): string {
  const bytes = Buffer.from(output)
  if (bytes.byteLength <= bound) return output
  return bytes
    .subarray(bytes.byteLength - bound)
    .toString('utf8')
    .replace(/^\uFFFD/, '')
}

export type GateResult = {
  exitCode: number
  timedOut: boolean
  elapsedMs: number
  outputTail: string
  outputPath?: string
  artifactPath?: string
}

export function shapeGateResult(input: {
  exitCode: number
  timedOut: boolean
  elapsedMs: number
  output: string
  outputPath?: string
  artifactPath?: string
}): GateResult {
  return {
    exitCode: input.exitCode,
    timedOut: input.timedOut,
    elapsedMs: input.elapsedMs,
    outputTail: boundedGateOutputTail(input.output),
    outputPath: input.outputPath,
    artifactPath: input.artifactPath,
  }
}

export function formatGateResult(result: GateResult): string {
  return [
    `Gate exit code: ${result.exitCode}`,
    `Timed out: ${result.timedOut}`,
    `Elapsed: ${result.elapsedMs}ms`,
    ...(result.outputPath && result.artifactPath
      ? [
          `Full output now: ${result.outputPath}`,
          `This log moves to the run artifacts at close: ${result.artifactPath}`,
        ]
      : ['No gate log was created.']),
    'Combined output tail:',
    result.outputTail || '(no output)',
  ].join('\n')
}
