// concern: worker gate decisions
/** Pure eligibility, concurrency, and result presentation for a registered worker gate. */

import { isAbsolute, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const GATE_INPUTS = ['staged', 'worktree', 'committed'] as const
export type GateInput = (typeof GATE_INPUTS)[number]

export function parseGateInput(
  value: unknown,
  projectName = 'this project',
): GateInput | undefined {
  if (value === undefined) return undefined
  if ((GATE_INPUTS as readonly unknown[]).includes(value)) return value as GateInput
  throw new Error(
    `worker gate refused: project ${JSON.stringify(projectName)} has invalid gateInput ${JSON.stringify(value)}; correct it with ${PLATFORM_SLUG} project set`,
  )
}

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
export const WORKER_GATE_BASE_ENV = 'BOTTEGA_GATE_BASE_COMMIT'
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
  delete environment.BOTTEGA_GATE_PIDS
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

export function decideWorkerGateInput(
  input: GateInput | undefined,
  hasUncommittedTrackedChanges: boolean,
): { kind: 'committed' } | { kind: 'synthetic-index' } | { kind: 'refused'; reason: string } {
  if (input !== 'committed') return { kind: 'synthetic-index' }
  if (!hasUncommittedTrackedChanges) return { kind: 'committed' }
  return {
    kind: 'refused',
    reason:
      'worker check refused: this project declares gateInput committed and the worker tree has uncommitted tracked changes; commit your change, then call run_check again',
  }
}

/**
 * Git's own test for a rebase in progress is the `rebase-merge` or
 * `rebase-apply` directory; `REBASE_HEAD` can outlive the rebase that wrote it,
 * so it is not a marker here.
 */
export const GATE_CHECKOUT_OPERATION_MARKERS = [
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
] as const

const CHECKOUT_OPERATION_BY_MARKER: Record<
  (typeof GATE_CHECKOUT_OPERATION_MARKERS)[number],
  string
> = {
  MERGE_HEAD: 'merge',
  'rebase-merge': 'rebase',
  'rebase-apply': 'rebase',
  CHERRY_PICK_HEAD: 'cherry-pick',
  REVERT_HEAD: 'revert',
}

function uniqueCheckoutPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const path of paths) {
    if (!path || seen.has(path)) continue
    seen.add(path)
    unique.push(path)
  }
  return unique
}

function checkoutOperations(presentMarkers: readonly string[]): string[] {
  const operations: string[] = []
  const seen = new Set<string>()
  for (const marker of GATE_CHECKOUT_OPERATION_MARKERS) {
    if (!presentMarkers.includes(marker)) continue
    const operation = CHECKOUT_OPERATION_BY_MARKER[marker]
    if (seen.has(operation)) continue
    seen.add(operation)
    operations.push(operation)
  }
  return operations
}

function formatCheckoutOperationCondition(operations: readonly string[]): string | null {
  if (operations.length === 0) return null
  if (operations.length === 1) return `a ${operations[0]} in progress`
  const last = operations.at(-1)
  return `${operations.slice(0, -1).join(', ')} and ${last} in progress`
}

/** Refuse a gate on an unfinished git operation or unmerged paths. */
export function decideGateCheckoutRefusal(input: {
  presentMarkers: readonly string[]
  unmergedPaths: readonly string[]
}): string | null {
  const operations = checkoutOperations(input.presentMarkers)
  const unmergedPaths = uniqueCheckoutPaths(input.unmergedPaths)
  if (operations.length === 0 && unmergedPaths.length === 0) return null
  const operationText = formatCheckoutOperationCondition(operations)
  const pathsText =
    unmergedPaths.length === 0 ? null : `unmerged paths: ${unmergedPaths.join(', ')}`
  const condition =
    operationText && pathsText ? `${operationText} with ${pathsText}` : (operationText ?? pathsText)
  return `checkout has ${condition}; finish or abort the operation`
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

export type WorkerCheckEligibility = { eligible: true } | { eligible: false; message: string }

export function decideWorkerCheckEligibility(input: {
  authenticated: boolean
  writer: boolean
  workerCheck: string | null
}): WorkerCheckEligibility {
  if (!input.authenticated) {
    return { eligible: false, message: 'This process is not a recognized orchestrator worker.' }
  }
  if (!input.writer) {
    return { eligible: false, message: 'run_check is available only to a writing worker run.' }
  }
  if (!input.workerCheck?.trim()) {
    return {
      eligible: false,
      message: "This run's project has no registered workerCheck, so nothing was run.",
    }
  }
  return { eligible: true }
}

export type GateRequestDecision =
  | { action: 'start' }
  | { action: 'join'; executionRecordId: string; executionNumber: number }
  | { action: 'return'; executionRecordId: string; executionNumber: number }

/** Decide whether one worker call starts, joins, or collects a gate execution. */
export function decideGateRequest(input: {
  execution: { recordId: string; number: number; finished: boolean } | null
  resultPending: boolean
}): GateRequestDecision {
  if (!input.execution) return { action: 'start' }
  if (!input.execution.finished)
    return {
      action: 'join',
      executionRecordId: input.execution.recordId,
      executionNumber: input.execution.number,
    }
  if (input.resultPending)
    return {
      action: 'return',
      executionRecordId: input.execution.recordId,
      executionNumber: input.execution.number,
    }
  return { action: 'start' }
}

/** Present how a repeated call reached an existing execution. */
export function formatGateRequestDecision(decision: GateRequestDecision): string | null {
  if (decision.action === 'join') {
    return `Check execution ${decision.executionNumber} was already running; this call waited for the same execution.`
  }
  if (decision.action === 'return') {
    return `Check execution ${decision.executionNumber} finished after an earlier run_check call stopped waiting; returning that result.`
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
      `The check is still running after ${input.executionElapsedMs}ms. ` +
      'Call run_check again to wait for this same execution. ' +
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
