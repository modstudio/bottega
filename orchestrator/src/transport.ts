import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { job } from './jobs.ts'
import type { FailureKind } from './failure.ts'
import type { SandboxRuntimeConfig } from './sandbox.ts'

const requireTransport = createRequire(import.meta.url)

/** Task that owns the ACP go/no-go. Named in every refusal. */
export const ACP_PILOT_TASK = 'DEV-352'

/** Read-only jobs the ACP pilot may run. Anything else is refused. */
export const ACP_PILOT_JOBS = ['understand', 'file-question', 'verify-claim', 'summarize'] as const

export type AcpPilotJob = (typeof ACP_PILOT_JOBS)[number]

export type TransportName = 'cli' | 'acp'

/**
 * How much of the machine an agent may use.
 *
 * `exec` remains available to non-repository jobs. Repository jobs never use
 * it: their boundary is workspace-write in their own disposable worktree.
 *
 * The case for it is measured rather than argued. Four review runs in a single
 * session reported, unprompted, that they could execute nothing: the Docker
 * socket was denied, PHP was not on the host, a native binding was missing. One
 * downgraded its entire test verdict to "static review" and still found two
 * real defects. `orch blockers` now counts these — nine runs across two
 * projects losing their build to one missing binding — which is what turned it
 * from an anecdote into a decision worth making.
 *
 * The boundary is the JOB. A repository job gets workspace-write in a
 * disposable worktree; a job that does not read a repository stays read-only.
 * Isolation is the worktree, not a per-project vendor-sandbox knob.
 */
export type SandboxLevel = 'read-only' | 'workspace-write' | 'exec'

/**
 * Everything an agent needs to build a command line, for a first turn or a
 * resumed one.
 *
 * `write` is separate from every other flag here because it is the only one
 * that can change the caller's disk. It defaults to false and each agent must
 * opt a sandbox open for it explicitly, so a job that never asked to write
 * cannot acquire the ability by inheriting a flag.
 */
export type ArgvOpts = {
  prompt: string
  out: string
  schema?: string
  mcp?: boolean
  /** Required project MCP server already resolved by dispatch. */
  mcpServer?: string
  /** HOME inherited by the vendor process. */
  home?: string
  /** Grok-only scoped trust for the disposable cwd orch created. */
  trustCwd?: string
  model?: string
  /** Open the sandbox for editing. True for every job that reads a repository. */
  write?: boolean
  /**
   * How much of the machine this run may use.
   *
   * Repository jobs get workspace-write in their disposable worktree. Anything
   * else is read-only. `exec` remains available when a non-repository job
   * passes it explicitly.
   */
  sandbox?: SandboxLevel
  /** Exact extra paths made writable inside Codex's workspace-write sandbox. */
  writableRoots?: string[]
  /** Object-store override used to isolate scratch objects for read-only repository jobs. */
  gitObjectEnvironment?: {
    GIT_OBJECT_DIRECTORY: string
    GIT_ALTERNATE_OBJECT_DIRECTORIES: string
  }
  /** Command-scoped git configuration enforced inside the worker's shell. */
  gitConfigEnvironment?: Record<string, string>
  /**
   * The conversation this turn belongs to.
   *
   * On a first turn it is the id we MINTED for an agent that lets us choose one
   * (grok), and absent for an agent that names its own (codex). On a resumed
   * turn it is required and identifies what to resume.
   */
  session?: string
}

export type TransportAgent = {
  name: string
  harness?: string
  baseUrl?: string | null
  bin: string
  defaultTransport: TransportName
  argv(opts: ArgvOpts): string[]
  resumeArgv?(opts: ArgvOpts & { session: string }): string[]
  readSession?(ctx: {
    stdout: string; cwd: string; prompt: string; startedAt: number; home?: string
  }): string | null
  stdin: boolean
  readsOut: boolean
  parseReply?(stdout: string): {
    text: string; tokens: number | null; costUsd: number | null
    stopReason?: string | null; error?: string
  }
}

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
  agent: TransportAgent
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
  mcpServer?: string
  trustCwd?: string
  writableRoots?: ArgvOpts['writableRoots']
  gitObjectEnvironment?: ArgvOpts['gitObjectEnvironment']
  gitConfigEnvironment?: ArgvOpts['gitConfigEnvironment']
  srt?: { profile: SandboxRuntimeConfig; runtimeDir: string }
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

export type TransportFactory = () => AgentTransport

const transports = new Map<TransportName, TransportFactory>()

export function registerTransport(name: TransportName, factory: TransportFactory): void {
  transports.set(name, factory)
}

/** Test-only reset for proving the unregistered refusal. */
export function clearRegisteredTransportsForTest(): void {
  transports.clear()
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
export function assertAcpAllowed(
  jobName: string, agentName: string | undefined, registered?: TransportAgent,
): void {
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
  agent?: TransportAgent
}): string | null {
  const sdkResolve = opts?.sdkResolve ?? (() => requireTransport.resolve('@agentclientprotocol/sdk'))
  const ajvResolve = opts?.ajvResolve ?? (() => requireTransport.resolve('ajv/dist/2020.js'))
  const agentName = opts?.agentName ?? 'codex'
  const registered = opts?.agent
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

export function assertAcpReady(agentName = 'codex', agent?: TransportAgent): void {
  const gap = acpRuntimeGaps({ agentName, agent })
  if (gap) throw new Error(gap)
}

export function transportFor(name: TransportName): AgentTransport {
  if (testTransport) return testTransport
  const factory = transports.get(name)
  if (!factory) {
    throw new Error(
      `refusing transport selection: transport "${name}" is not registered\n` +
      'invariant: Entrypoints register the standard transport adapters before selection.\n' +
      'cleared by: call registerStandardTransports() before selecting a transport',
    )
  }
  return factory()
}

export function failureKindFromStop(stopReason: string | null, error: string | null): FailureKind {
  if (stopReason === 'max_tokens') return 'truncated'
  if (stopReason === 'refusal') return 'content_refusal'
  if (stopReason === 'cancelled') return 'interrupted'
  if (stopReason === 'timeout') return 'timeout'
  if (stopReason === 'max_turn_requests') return 'context'
  if (stopReason === 'context_window' || stopReason === 'context_limit') return 'context'
  if (stopReason === 'cost_limit') return 'cost'
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
export function confineFsPath(path: string, root: string, method = 'readTextFile'): string {
  const rootName = method === 'readTextFile' ? 'run worktree' : 'allowed root'
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    throw new Error(`ACP fs.${method} refused: ${method === 'readTextFile' ? 'worktree' : 'root'} ${root} is not readable`)
  }
  const rootedPath = isAbsolute(path) ? path : join(realRoot, path)
  let candidate: string
  try {
    candidate = realpathSync(rootedPath)
  } catch {
    try {
      candidate = join(realpathSync(dirname(rootedPath)), basename(rootedPath))
    } catch {
      throw new Error(`ACP fs.${method} refused: ${path} is outside the ${rootName}`)
    }
  }
  const prefix = realRoot.endsWith('/') ? realRoot : `${realRoot}/`
  if (candidate !== realRoot && !candidate.startsWith(prefix)) {
    throw new Error(`ACP fs.${method} refused: ${path} is outside the ${rootName}`)
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
