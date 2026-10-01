// concern: worker gate decisions
/** Pure eligibility, concurrency, and result presentation for a registered worker gate. */

import { isAbsolute, resolve } from 'node:path'

export const GATE_OUTPUT_TAIL_BYTES = 16 * 1024
export const GATE_COMMAND_TIMEOUT_MS = 20 * 60_000
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
  return { ...base, ...hostPaths, ...overlay }
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

export function decideGateConcurrency(inProgress: boolean): { allowed: boolean; message?: string } {
  return inProgress
    ? { allowed: false, message: 'A gate run is already in progress.' }
    : { allowed: true }
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
  outputPath: string
  artifactPath: string
}

export function shapeGateResult(input: {
  exitCode: number
  timedOut: boolean
  elapsedMs: number
  output: string
  outputPath: string
  artifactPath: string
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
    `Full output now: ${result.outputPath}`,
    `This log moves to the run artifacts at close: ${result.artifactPath}`,
    'Combined output tail:',
    result.outputTail || '(no output)',
  ].join('\n')
}
