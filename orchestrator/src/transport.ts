import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from './agents.ts'
import { job } from './jobs.ts'
import type { FailureKind } from './failure.ts'
import { cliTransport } from './transport-cli.ts'

const requireTransport = createRequire(import.meta.url)

/** Pilot task that owns the ACP opt-in. Named in every refusal. */
export const ACP_PILOT_TASK = 'DEV-342'

/** Read-only jobs the ACP pilot may run. Anything else is refused. */
export const ACP_PILOT_JOBS = ['understand', 'file-question', 'verify-claim', 'summarize'] as const

export type AcpPilotJob = (typeof ACP_PILOT_JOBS)[number]

export type TransportName = 'cli' | 'acp'

export type NormalizedEvent =
  | { kind: 'text'; text: string }
  | { kind: 'usage'; tokens: number; costUsd: number | null }
  | { kind: 'session'; sessionId: string }
  | { kind: 'tool'; title: string; status?: string; toolKind?: string }
  | { kind: 'permission'; title: string; optionKinds: string[] }
  | { kind: 'elicitation'; message: string }
  | { kind: 'error'; error: string }
  | { kind: 'stop'; reason: string }

export type ParsedReply = {
  text: string
  tokens: number | null
  costUsd: number | null
  stopReason?: string | null
  error?: string
}

export type TransportResult = {
  output: string
  stdout: string
  stderr: string
  raw: string
  parsed: ParsedReply | null
  tokens: number | null
  costUsd: number | null
  sessionId: string | null
  stopReason: string | null
  error: string | null
  exitCode: number
  pid: number | null
  events: NormalizedEvent[]
  asking: boolean
  questions: Array<{
    question: string
    options?: string[]
    recommendation?: string | null
    why: string
  }>
}

export type TransportStartOpts = {
  agent: Agent
  cwd: string
  env: Record<string, string>
  launchArgv: string[]
  stdinPrompt?: string
  prompt: string
  outPath: string
  session?: string
  schemaPath?: string
  model?: string
  home?: string
  startedAt: number
}

export type TransportHandle = {
  pid: number | null
  kill(sig?: number | string): void
  prompt(text: string): Promise<void>
  events(): AsyncIterable<NormalizedEvent>
  cancel(): Promise<void>
  collect(): Promise<TransportResult>
}

/**
 * How an agent is driven. Policy and capabilities stay on `Agent`; this is
 * the spawn / protocol seam. Default is `cli`.
 */
export type AgentTransport = {
  readonly name: TransportName
  start(opts: TransportStartOpts): Promise<TransportHandle>
  prompt(handle: TransportHandle, text: string): Promise<void>
  events(handle: TransportHandle): AsyncIterable<NormalizedEvent>
  cancel(handle: TransportHandle): Promise<void>
  resume(opts: TransportStartOpts & { session: string }): Promise<TransportHandle>
}

export function isAcpPilotJob(name: string): name is AcpPilotJob {
  return (ACP_PILOT_JOBS as readonly string[]).includes(name)
}

export function resolveTransportName(
  explicit?: string | null,
  env = process.env.ORCH_TRANSPORT,
): TransportName {
  const raw = (explicit ?? env ?? 'cli').trim().toLowerCase()
  if (!raw || raw === 'cli') return 'cli'
  if (raw === 'acp') return 'acp'
  throw new Error(`unknown transport "${raw}"; expected cli or acp`)
}

/**
 * Refuse an ACP opt-in that the pilot does not cover.
 *
 * Writing jobs name the pilot task explicitly. Other jobs outside the
 * allow-list are refused too — the spec listed four read-only jobs, not
 * every job that happens not to write.
 */
export function assertAcpAllowed(jobName: string, agentName: string | undefined): void {
  if (agentName && agentName !== 'codex') {
    throw new Error(
      `ACP transport is a ${ACP_PILOT_TASK} pilot and is only available for codex`,
    )
  }
  if (isAcpPilotJob(jobName)) return
  if (job(jobName).needs.writesRepo) {
    throw new Error(
      `ACP transport is a ${ACP_PILOT_TASK} pilot and is not available for writing jobs`,
    )
  }
  throw new Error(
    `ACP transport is a ${ACP_PILOT_TASK} pilot; allowed jobs: ${ACP_PILOT_JOBS.join(', ')}`,
  )
}

export function transportFor(name: TransportName): AgentTransport {
  if (name === 'acp') {
    // Loaded only on the ACP opt-in so a source-only fixture without the
    // SDK still boots the default CLI path (linked-worktree-database.test).
    return (requireTransport('./transport-acp.ts') as typeof import('./transport-acp.ts')).acpTransport
  }
  return cliTransport
}

export function resolveCodexAcpBin(): string {
  return process.env.ORCH_ACP_BIN ||
    join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'codex-acp')
}

export function outcomeFromTransport(result: TransportResult): {
  status: 'ok' | 'asking' | 'failed'
  failureKind: FailureKind | null
} {
  if (result.asking) return { status: 'asking', failureKind: null }
  if (result.error || result.exitCode !== 0 || !result.output.trim()) {
    return { status: 'failed', failureKind: failureKindFromStop(result.stopReason, result.error) }
  }
  return { status: 'ok', failureKind: null }
}

export function failureKindFromStop(stopReason: string | null, error: string | null): FailureKind {
  if (stopReason === 'max_tokens') return 'truncated'
  if (stopReason === 'refusal') return 'content_refusal'
  if (stopReason === 'cancelled') return 'interrupted'
  if (stopReason === 'timeout') return 'timeout'
  if (error) return 'other'
  return 'other'
}
