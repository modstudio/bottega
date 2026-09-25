// concern: worker gate decisions
/** Pure eligibility, concurrency, and result presentation for a registered worker gate. */

import { isAbsolute, resolve } from 'node:path'

export const GATE_OUTPUT_TAIL_BYTES = 16 * 1024
export const GATE_COMMAND_TIMEOUT_MS = 20 * 60_000

function quoteShellWord(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

/** Resolve a registered relative executable from the immutable main checkout. */
export function resolveGateCommand(command: string, mainCheckout: string): string {
  const match = /^(\s*)(\S+)([\s\S]*)$/.exec(command)
  if (!match) return command
  const [, leading, first, rest] = match
  if (!first!.includes('/') || isAbsolute(first!)) return command
  return `${leading}${quoteShellWord(resolve(mainCheckout, first!))}${rest}`
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
