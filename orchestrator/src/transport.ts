import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, ArgvOpts, SandboxLevel } from './agents.ts'
import { job } from './jobs.ts'
import type { FailureKind } from './failure.ts'
import { cliTransport } from './transport-cli.ts'
import type { SandboxRuntimeConfig } from './sandbox.ts'

const requireTransport = createRequire(import.meta.url)

/** Task that owns the ACP go/no-go. Named in every refusal. */
export const ACP_PILOT_TASK = 'DEV-352'

/** Read-only jobs the ACP pilot may run. Anything else is refused. */
export const ACP_PILOT_JOBS = ['understand', 'file-question', 'verify-claim', 'summarize'] as const

export type AcpPilotJob = (typeof ACP_PILOT_JOBS)[number]

export type TransportName = 'cli' | 'acp'

export type NormalizedEvent =
  | { kind: 'text'; text: string }
  | { kind: 'usage'; tokens: number; costUsd: number | null }
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'tool'
      title: string
      status?: string
      toolKind?: string
      target?: string
      result?: string
      locations?: Array<{ path: string }>
    }
  | {
      kind: 'permission'
      title: string
      optionKinds: string[]
      toolKind?: string
      decision: 'allow' | 'reject'
    }
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
  failureKind: FailureKind | null
  status: 'ok' | 'asking' | 'failed'
  questions: Array<{
    question: string
    options?: string[]
    recommendation?: string | null
    why: string
  }>
  /** Model the vendor session reports after applying transport configuration. */
  effectiveModel?: string | null
}

export type TransportStartOpts = {
  agent: Agent
  cwd: string
  env: Record<string, string>
  prompt: string
  outPath: string
  session?: string
  schemaPath?: string
  model?: string
  /** Distinguishes an explicit --model from the agent's configured default. */
  modelExplicit?: boolean
  home?: string
  startedAt: number
  write?: boolean
  sandbox?: SandboxLevel
  mcp?: boolean
  trustCwd?: string
  writableRoots?: ArgvOpts['writableRoots']
  gitObjectEnvironment?: ArgvOpts['gitObjectEnvironment']
  gitConfigEnvironment?: ArgvOpts['gitConfigEnvironment']
  srt?: { profile: SandboxRuntimeConfig; settingsPath: string }
  /** ACP binary. CLI uses `agent.bin`. */
  bin?: string
  /** First turn vs resumeArgv. Session may exist on a first grok turn too. */
  resume?: boolean
}

export type TransportHandle = {
  pid: number | null
  /** Available once session/new or session/load has returned. */
  effectiveModel?: string | null
  kill(sig?: number | string): void
  prompt(text: string): Promise<void>
  events(): AsyncIterable<NormalizedEvent>
  cancel(): Promise<void>
  collect(): Promise<TransportResult>
}

/**
 * How an agent is driven. Policy and capabilities stay on `Agent`; this is
 * the spawn / protocol seam. Default is `cli`. The CLI transport reads
 * `Agent.argv` / `resumeArgv` / `parseReply` / `readSession`.
 */
export type AgentTransport = {
  readonly name: TransportName
  start(opts: TransportStartOpts): Promise<TransportHandle>
  prompt(handle: TransportHandle, text: string): Promise<void>
  events(handle: TransportHandle): AsyncIterable<NormalizedEvent>
  cancel(handle: TransportHandle): Promise<void>
  resume(opts: TransportStartOpts & { session: string }): Promise<TransportHandle>
}

/** Test-only override so run() can be driven without a vendor binary. */
let testTransport: AgentTransport | null = null

export function installTestTransport(transport: AgentTransport | null): void {
  testTransport = transport
}

export function isTestTransportInstalled(): boolean {
  return testTransport !== null
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

/** ACP pins to codex when the caller did not name an agent. */
export function selectAgentForTransport(
  transport: TransportName, agent?: string,
): string | undefined {
  if (transport === 'acp') return agent ?? 'codex'
  return agent
}

/**
 * Refuse an ACP opt-in that the pilot does not cover.
 *
 * Writing jobs name the pilot task explicitly. Other jobs outside the
 * allow-list are refused too — the spec listed four read-only jobs, not
 * every job that happens not to write.
 */
export function assertAcpAllowed(jobName: string, agentName: string | undefined): void {
  const registered = agentName ? registeredAgent(agentName) : null
  if (agentName && !['codex', 'grok'].includes(agentName) && registered?.defaultTransport !== 'acp') {
    throw new Error(
      `ACP transport is a ${ACP_PILOT_TASK} pilot and is only available for registered ACP agents`,
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

export function resolveCodexAcpBin(): string {
  return process.env.ORCH_ACP_BIN ||
    join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'codex-acp')
}

export function acpRuntimeGaps(opts?: {
  sdkResolve?: () => string
  ajvResolve?: () => string
  binPath?: string
  binExists?: (path: string) => boolean
  agentName?: string
}): string | null {
  const sdkResolve = opts?.sdkResolve ?? (() => requireTransport.resolve('@agentclientprotocol/sdk'))
  const ajvResolve = opts?.ajvResolve ?? (() => requireTransport.resolve('ajv/dist/2020.js'))
  const agentName = opts?.agentName ?? 'codex'
  const registered = agentName ? registeredAgent(agentName) : null
  const registeredBin = registered ? Bun.which(registered.bin) : null
  const binPath = opts?.binPath ?? (agentName === 'grok' ? (Bun.which('grok') ?? 'grok') : registeredBin ?? resolveCodexAcpBin())
  const binExists = opts?.binExists ?? existsSync
  try {
    sdkResolve()
  } catch {
    return `ACP transport is a ${ACP_PILOT_TASK} pilot; the SDK @agentclientprotocol/sdk is not installed`
  }
  try {
    ajvResolve()
  } catch {
    return `ACP transport is a ${ACP_PILOT_TASK} pilot; ajv is not installed`
  }
  if (!binExists(binPath)) {
    return `ACP transport is a ${ACP_PILOT_TASK} pilot; the ${agentName === 'grok' ? 'grok' : agentName === 'codex' ? 'codex-acp' : registered ? `${agentName} ACP harness` : 'codex-acp'} executable is not installed`
  }
  return null
}

function registeredAgent(name: string): Agent | null {
  try {
    const { AGENTS } = requireTransport('./agents.ts') as typeof import('./agents.ts')
    return AGENTS[name] ?? null
  } catch { return null }
}

export function assertAcpReady(agentName = 'codex'): void {
  const gap = acpRuntimeGaps({ agentName })
  if (gap) throw new Error(gap)
}

export function transportFor(name: TransportName): AgentTransport {
  if (testTransport) return testTransport
  if (name === 'acp') {
    // Loaded only on the ACP opt-in so a source-only fixture without the
    // SDK still boots the default CLI path (linked-worktree-database.test).
    return (requireTransport('./transport-acp.ts') as typeof import('./transport-acp.ts')).acpTransport
  }
  return cliTransport
}

export function failureKindFromStop(stopReason: string | null, error: string | null): FailureKind {
  if (stopReason === 'max_tokens') return 'truncated'
  if (stopReason === 'refusal') return 'content_refusal'
  if (stopReason === 'cancelled') return 'interrupted'
  if (stopReason === 'timeout') return 'timeout'
  if (error) return 'other'
  return 'other'
}

export function stopErrorMessage(stopReason: string): string {
  if (stopReason === 'max_tokens') return 'response truncated at output ceiling (max_tokens)'
  if (stopReason === 'refusal') return 'the agent refused to continue'
  if (stopReason === 'timeout') return 'no reply within the run bound; the agent was killed'
  if (stopReason === 'cancelled') return 'the turn was cancelled'
  if (stopReason === 'max_turn_requests') return 'the turn exceeded its model-request budget'
  return `ACP stop reason: ${stopReason}`
}

/**
 * Fold a finished turn into orch's three terminal states.
 *
 * A non-end_turn stop is a failure even when the agent already streamed
 * some text — except elicitation, which is asking.
 */
export function outcomeFromTransport(result: {
  asking: boolean
  error: string | null
  exitCode: number
  output: string
  stopReason: string | null
}): { status: 'ok' | 'asking' | 'failed'; failureKind: FailureKind | null } {
  if (result.asking) return { status: 'asking', failureKind: null }
  if (result.stopReason && result.stopReason !== 'end_turn') {
    return { status: 'failed', failureKind: failureKindFromStop(result.stopReason, result.error) }
  }
  if (result.error || result.exitCode !== 0 || !result.output.trim()) {
    return { status: 'failed', failureKind: failureKindFromStop(result.stopReason, result.error) }
  }
  return { status: 'ok', failureKind: null }
}

const READ_PERMISSION_KINDS = new Set(['read', 'search', 'think', 'fetch'])

export function decideAcpPermission(
  toolKind: string | undefined,
  options: Array<{ optionId: string; kind: string }>,
): { decision: 'allow' | 'reject'; outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } {
  const allowRead = READ_PERMISSION_KINDS.has(toolKind ?? '')
  if (allowRead) {
    const allow = options.find((option) => option.kind === 'allow_once')
      ?? options.find((option) => option.kind === 'allow_always')
    if (allow) return { decision: 'allow', outcome: { outcome: 'selected', optionId: allow.optionId } }
  }
  const reject = options.find((option) => option.kind === 'reject_once')
    ?? options.find((option) => option.kind === 'reject_always')
  if (reject) return { decision: 'reject', outcome: { outcome: 'selected', optionId: reject.optionId } }
  return { decision: 'reject', outcome: { outcome: 'cancelled' } }
}

/**
 * The orch process, not the sandboxed child, serves fs/read_text_file.
 * Reads are confined to the run worktree by realpath prefix.
 */
export function confineFsPath(path: string, root: string): string {
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    throw new Error(`ACP fs.readTextFile refused: worktree ${root} is not readable`)
  }
  const rootedPath = isAbsolute(path) ? path : join(realRoot, path)
  let candidate: string
  try {
    candidate = realpathSync(rootedPath)
  } catch {
    try {
      candidate = join(realpathSync(dirname(rootedPath)), basename(rootedPath))
    } catch {
      throw new Error(`ACP fs.readTextFile refused: ${path} is outside the run worktree`)
    }
  }
  const prefix = realRoot.endsWith('/') ? realRoot : `${realRoot}/`
  if (candidate !== realRoot && !candidate.startsWith(prefix)) {
    throw new Error(`ACP fs.readTextFile refused: ${path} is outside the run worktree`)
  }
  return candidate
}

type AjvValidator = { compile(schema: object): (value: unknown) => boolean }
type Ajv2020Ctor = new (opts?: { strict?: boolean }) => AjvValidator
let schemaValidator: AjvValidator | null = null

function loadAjvValidator(): AjvValidator {
  if (schemaValidator) return schemaValidator
  // ajv is loaded here, not at module load: doctor and every reporting command
  // reach this module through run.ts, and the hermetic linked-tree fixtures
  // carry no orchestrator/node_modules, so a static import broke `orch doctor`.
  const loaded: unknown = requireTransport('ajv/dist/2020.js')
  const candidate: unknown = typeof loaded === 'function'
    ? loaded
    : (loaded as { default?: unknown } | null)?.default
  if (typeof candidate !== 'function') throw new Error('ajv/dist/2020.js did not export a constructor')
  const validator = new (candidate as Ajv2020Ctor)({ strict: false })
  schemaValidator = validator
  return validator
}

/** Validate a reply against the same Codex-normalised schema the CLI path hands the vendor. */
export function valueMatchesStrictSchema(schema: unknown, value: unknown): boolean {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false
  try {
    return loadAjvValidator().compile(schema)(value)
  } catch {
    return false
  }
}

export function schemaMismatchError(output: string): string {
  return `reply did not match the worker contract:\n${output}`
}
