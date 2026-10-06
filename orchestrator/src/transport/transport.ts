import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { embeddedDistributionManifest } from '../../../shared/embedded-assets.ts'
import type { FailureKind } from '../failure/failure.ts'
import { job } from '../jobs/jobs.ts'
import type { SandboxRuntimeConfig } from '../sandbox/sandbox.ts'
import type { AjvValidator } from './ajv-validator.ts'

const requireTransport = createRequire(import.meta.url)

/** Task that owns the ACP go/no-go. Named in every refusal. */
export const ACP_PILOT_TASK = 'DEV-352'

/** Read-only jobs the ACP pilot may run. Anything else is refused. */
const ACP_PILOT_JOBS = [
  'understand',
  'file-question',
  'canon-lookup',
  'verify-claim',
  'summarize',
] as const

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
 * disposable worktree. A no-repository Codex job gets workspace-write only in
 * its run isolate; other no-repository jobs stay read-only. Isolation is the
 * worktree or run isolate, not a per-project vendor-sandbox knob.
 */
type SandboxLevel = 'read-only' | 'workspace-write' | 'exec'

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
  /** Credential-free project MCP launch definitions resolved by dispatch. */
  projectServers?: Record<string, { command?: string; args?: string[]; cwd?: string; url?: string }>
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
   * Repository jobs get workspace-write in their disposable worktree. Codex
   * no-repository jobs get workspace-write in their isolate so they can write
   * run artifacts. `exec` remains available when a job passes it explicitly.
   */
  sandbox?: SandboxLevel
  /** Open outbound network in Codex's workspace-write sandbox. */
  sandboxWorkspaceWriteNetworkAccess?: boolean
  /** Exact extra paths made writable inside Codex's workspace-write sandbox. */
  writableRoots?: string[]
  /** Command-scoped git configuration enforced inside the worker's shell. */
  gitConfigEnvironment?: Record<string, string>
  /** Tracked-recipe allocation values (ORCH_INDEX, ORCH_PORTS_*, ORCH_ALLOC_*) set inside the worker's shell. */
  recipeEnvironment?: Record<string, string>
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
    stdout: string
    cwd: string
    prompt: string
    startedAt: number
    home?: string
  }): string | null
  stdin: boolean
  readsOut: boolean
  parseReply?(stdout: string): {
    text: string
    tokens: number | null
    costUsd: number | null
    stopReason?: string | null
    error?: string
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
      server?: string
      target?: string
      result?: string
      error?: string
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

type ParsedReply = {
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
  sandboxWorkspaceWriteNetworkAccess?: boolean
  mcp?: boolean
  mcpServer?: string
  projectServers?: ArgvOpts['projectServers']
  trustCwd?: string
  writableRoots?: ArgvOpts['writableRoots']
  gitConfigEnvironment?: ArgvOpts['gitConfigEnvironment']
  recipeEnvironment?: ArgvOpts['recipeEnvironment']
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
  /** Whether prompt() can add context while a turn is already running. */
  readonly canInjectMidTurn: boolean
  start(opts: TransportStartOpts): Promise<TransportHandle>
  prompt(handle: TransportHandle, text: string): Promise<void>
  events(handle: TransportHandle): AsyncIterable<NormalizedEvent>
  cancel(handle: TransportHandle): Promise<void>
  resume(opts: TransportStartOpts & { session: string }): Promise<TransportHandle>
}

export type TransportFactory = () => AgentTransport

export class TransportOperationTimeout extends Error {
  readonly operation: string
  readonly timeoutMs: number

  constructor(operation: string, timeoutMs: number) {
    super(`transport operation ${operation} timed out after ${timeoutMs}ms`)
    this.name = 'TransportOperationTimeout'
    this.operation = operation
    this.timeoutMs = timeoutMs
  }
}

/** Bound one transport operation without knowing which caller or run owns it. */
export async function withTransportDeadline<T>(opts: {
  operation: Promise<T>
  operationName: string
  timeoutMs: number
  onTimeout: () => unknown | Promise<unknown>
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void
}): Promise<T> {
  const schedule = opts.schedule ?? setTimeout
  const unschedule = opts.unschedule ?? clearTimeout
  let timer: ReturnType<typeof setTimeout> | null = null
  let deadline: TransportOperationTimeout | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = schedule(() => {
      deadline = new TransportOperationTimeout(opts.operationName, opts.timeoutMs)
      void Promise.resolve(opts.onTimeout())
        .catch(() => {
          /* the timeout remains the operation's terminal fact */
        })
        .finally(() => reject(deadline))
    }, opts.timeoutMs)
  })
  try {
    return await Promise.race([opts.operation, timeout])
  } catch (error) {
    if (deadline) throw deadline
    throw error
  } finally {
    if (timer !== null) unschedule(timer)
  }
}

const transports = new Map<TransportName, TransportFactory>()

export function registerTransport(name: TransportName, factory: TransportFactory): void {
  transports.set(name, factory)
}

/** Test-only reset for proving the unregistered refusal. */
export function clearRegisteredTransportsForTest(): void {
  transports.clear()
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
  transport: TransportName,
  agent?: string,
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
  jobName: string,
  agentName: string | undefined,
  registered?: TransportAgent,
): void {
  if (
    agentName &&
    !['codex', 'grok'].includes(agentName) &&
    registered?.defaultTransport !== 'acp'
  ) {
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

/**
 * Resolve the Codex ACP helper. This is an external executable, not a Bottega
 * install asset, so it is not routed through assetPath.
 */
export function resolveCodexAcpBin(opts?: {
  env?: Record<string, string | undefined>
  checkoutBin?: string
  exists?: (path: string) => boolean
  which?: (name: string) => string | null
}): string {
  const override = (opts?.env ?? process.env).ORCH_ACP_BIN
  if (override) return override
  const checkoutBin =
    opts?.checkoutBin ??
    (embeddedDistributionManifest()
      ? null
      : join(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          '..',
          'node_modules',
          '.bin',
          'codex-acp',
        ))
  if (checkoutBin && (opts?.exists ?? existsSync)(checkoutBin)) return checkoutBin
  const found = (opts?.which ?? ((name: string) => Bun.which(name)))('codex-acp')
  if (found) return found
  throw new Error(
    `cannot find a codex-acp executable: ${checkoutBin ? `none at ${checkoutBin} and ` : ''}PATH lookup found nothing; set ORCH_ACP_BIN to its path, or install it so it is on PATH`,
  )
}

type AcpRuntimeGapOptions = {
  sdkResolve?: () => string
  ajvResolve?: () => string
  binPath?: string
  binExists?: (path: string) => boolean
  env?: Record<string, string | undefined>
  which?: (name: string) => string | null
  agentName?: string
  agent?: TransportAgent
}

function resolveAcpRuntimeBin(
  opts: AcpRuntimeGapOptions | undefined,
  agentName: string,
  registered: TransportAgent | undefined,
  which: (name: string) => string | null,
  binExists: (path: string) => boolean,
): string {
  if (opts?.binPath) return opts.binPath
  if (agentName === 'grok') return which('grok') ?? 'grok'
  const registeredBin = registered ? which(registered.bin) : null
  return registeredBin ?? resolveCodexAcpBin({ env: opts?.env, exists: binExists, which })
}

function missingAcpExecutableGap(
  agentName: string,
  registered: TransportAgent | undefined,
): string {
  const executable =
    agentName === 'grok'
      ? 'grok'
      : agentName === 'codex'
        ? 'codex-acp'
        : registered
          ? `${agentName} ACP harness`
          : 'codex-acp'
  return `ACP transport is a ${ACP_PILOT_TASK} pilot; the ${executable} executable is not installed`
}

export function acpRuntimeGaps(opts?: AcpRuntimeGapOptions): string | null {
  const sdkResolve =
    opts?.sdkResolve ?? (() => requireTransport.resolve('@agentclientprotocol/sdk'))
  const ajvResolve =
    opts?.ajvResolve ??
    (() => {
      loadAjvValidator()
      return 'ajv'
    })
  const agentName = opts?.agentName ?? 'codex'
  const registered = opts?.agent
  const which = opts?.which ?? ((name: string) => Bun.which(name))
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
  let binPath: string
  try {
    binPath = resolveAcpRuntimeBin(opts, agentName, registered, which, binExists)
  } catch {
    return missingAcpExecutableGap(agentName, registered)
  }
  if (!binExists(binPath)) {
    return missingAcpExecutableGap(agentName, registered)
  }
  return null
}

export function assertAcpReady(agentName = 'codex', agent?: TransportAgent): void {
  const gap = acpRuntimeGaps({ agentName, agent })
  if (gap) throw new Error(gap)
}

export function transportFor(name: TransportName): AgentTransport {
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
    return {
      status: 'failed',
      failureKind: failureKindFromStop(result.stopReason, result.error),
    }
  }
  if (result.error || result.exitCode !== 0 || !result.output.trim()) {
    return {
      status: 'failed',
      failureKind: failureKindFromStop(result.stopReason, result.error),
    }
  }
  return { status: 'ok', failureKind: null }
}

const READ_PERMISSION_KINDS = new Set(['read', 'search', 'think', 'fetch'])

export function decideAcpPermission(
  toolKind: string | undefined,
  options: Array<{ optionId: string; kind: string }>,
  resolvedLocations?: string[],
  resolvedScratchRoot?: string,
): {
  decision: 'allow' | 'reject'
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
} {
  const allowRead = READ_PERMISSION_KINDS.has(toolKind ?? '')
  const allowScratchEdit =
    toolKind === 'edit' &&
    resolvedScratchRoot !== undefined &&
    resolvedLocations !== undefined &&
    resolvedLocations.length > 0 &&
    resolvedLocations.every((path) => pathIsWithinRoot(path, resolvedScratchRoot))
  if (allowRead || allowScratchEdit) {
    const allow =
      options.find((option) => option.kind === 'allow_once') ??
      (allowRead ? options.find((option) => option.kind === 'allow_always') : undefined)
    if (allow)
      return {
        decision: 'allow',
        outcome: { outcome: 'selected', optionId: allow.optionId },
      }
  }
  const reject =
    options.find((option) => option.kind === 'reject_once') ??
    options.find((option) => option.kind === 'reject_always')
  if (reject)
    return {
      decision: 'reject',
      outcome: { outcome: 'selected', optionId: reject.optionId },
    }
  return { decision: 'reject', outcome: { outcome: 'cancelled' } }
}

function pathIsWithinRoot(path: string, root: string): boolean {
  const fromRoot = relative(root, path)
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  )
}

/** Resolve a possibly missing path through the realpath of its nearest existing ancestor. */
export function resolveFsPath(path: string, relativeRoot?: string): string {
  let ancestor = isAbsolute(path) ? path : join(relativeRoot ?? process.cwd(), path)
  const remainder: string[] = []
  while (true) {
    try {
      return join(realpathSync(ancestor), ...remainder.reverse())
    } catch {
      try {
        lstatSync(ancestor)
        throw new Error(`cannot resolve filesystem path ${path}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`cannot resolve filesystem path ${path}`)
        }
      }
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new Error(`cannot resolve filesystem path ${path}`)
      remainder.push(basename(ancestor))
      ancestor = parent
    }
  }
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
    throw new Error(
      `ACP fs.${method} refused: ${method === 'readTextFile' ? 'worktree' : 'root'} ${root} is not readable`,
    )
  }
  let candidate: string
  try {
    candidate = resolveFsPath(path, realRoot)
  } catch {
    throw new Error(`ACP fs.${method} refused: ${path} is outside the ${rootName}`)
  }
  if (!pathIsWithinRoot(candidate, realRoot)) {
    throw new Error(`ACP fs.${method} refused: ${path} is outside the ${rootName}`)
  }
  return candidate
}

let schemaValidator: AjvValidator | null = null

function loadAjvValidator(): AjvValidator {
  if (schemaValidator) return schemaValidator
  // Loaded here, not at module load: doctor and every reporting command reach
  // this module through run.ts, and the hermetic linked-tree fixtures carry no
  // orchestrator/node_modules, so a static import broke `orch doctor`.
  try {
    const loaded = require('./ajv-validator.ts') as typeof import('./ajv-validator.ts')
    schemaValidator = loaded.createStrictSchemaValidator()
    return schemaValidator
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to load or construct the strict schema validator: ${cause}`)
  }
}

/** Validate a reply against the same Codex-normalized schema the CLI path hands the vendor. */
export function valueMatchesStrictSchema(
  schema: unknown,
  value: unknown,
  loadValidator: () => AjvValidator = loadAjvValidator,
): boolean {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false
  const validator = loadValidator()
  try {
    return validator.compile(schema)(value)
  } catch {
    return false
  }
}

export function schemaMismatchError(output: string): string {
  return `reply did not match the worker contract:\n${output}`
}
