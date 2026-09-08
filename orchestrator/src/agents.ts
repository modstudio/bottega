import { which } from 'bun'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DB_PATH, ROOT, db as dbForAgents, writableDb, nowIso } from './db.ts'

export type Caps = {
  /** Can navigate a repo on its own (find files, grep) without being handed them. */
  readsRepo: boolean
  /** Can call MCP tools from this machine's server config. */
  mcp: boolean
  /** Discovers project MCP configuration from the process working directory. */
  discoversMcpFromCwd: boolean
  /** Can be bound to a JSON schema for its final message. */
  schema: boolean
  /** Proved by registration: writes the universal structured reply artifact. */
  replyFile?: boolean
  /**
   * Can EDIT the checkout it is pointed at, headlessly, without a prompt.
   *
   * Strictly stronger than `readsRepo`, and not implied by it: every agent here
   * that reads a repo does so under a read-only sandbox, and lifting that is a
   * separate flag on every one of them. It is declared per agent rather than
   * inferred because the failure is silent — an agent that cannot write does
   * not error, it reports success having changed nothing, and the empty diff
   * arrives looking exactly like a job that needed no changes.
   *
   * VERIFIED, not assumed, and each agent's own comment records how. codex and
   * grok have both been watched creating a requested file and exiting 0; grok's
   * first attempt had been killed at a two-minute bound with nothing written,
   * which was a question about the bound rather than an answer about grok, and
   * a later round-trip settled it.
   *
   * The two that are false are false for reasons, not for want of trying: agy
   * cannot open a file, so it certainly cannot edit one, and qwen's write path
   * is unverified rather than absent.
   */
  writesRepo: boolean
  /**
   * Can be resumed later, carrying the whole conversation, from an id.
   *
   * This is what makes an escalation cheap rather than ruinous. Without it, a
   * worker that stops to ask a design question has to be restarted from the
   * prompt and re-read every file it had already read, so asking would cost
   * more than guessing — and an escalation channel that costs more than
   * guessing does not get used.
   */
  resumable: boolean
}

/**
 * Everything an agent needs to build a command line, for a first turn or a
 * resumed one.
 *
 * `write` is separate from every other flag here because it is the only one
 * that can change the caller's disk. It defaults to false and each agent must
 * opt a sandbox open for it explicitly, so a job that never asked to write
 * cannot acquire the ability by inheriting a flag.
 */
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
 * What `exec` means to codex.
 *
 * Named here rather than written at the call site so there is exactly one place
 * that decides what the widest level actually grants, and so the grant is
 * legible when someone comes looking for it.
 */
export const CODEX_EXEC_SANDBOX = 'danger-full-access'

/**
 * Parent env names Codex must forward into orch-ask.
 *
 * Codex stdio MCP does not inherit the vendor CLI environment. Measured on
 * live `codex exec` workers: the parent had ORCH_RUN_ID/ORCH_RUN_TOKEN/ORCH_DB
 * and the ask-server grandchild had none, so authorised() failed with
 * "not a recognised orchestrator worker". Grok inherits the same pair by
 * default, including on `--resume`. `env_vars` is Codex's documented forward
 * list; the overlay is per spawn so concurrent runs keep their own values.
 */
export const CODEX_ASK_ENV_VARS = ['ORCH_RUN_ID', 'ORCH_RUN_TOKEN', 'ORCH_DB'] as const

export type ArgvOpts = {
  prompt: string
  out: string
  schema?: string
  mcp?: boolean
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

type JSONSchema = Record<string, unknown>

const STRICT_UNSUPPORTED = new Set([
  'allOf', 'not', 'dependentRequired', 'dependentSchemas', 'if', 'then', 'else',
  'patternProperties', 'oneOf',
])

const pathKey = (path: string, key: string) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`

function isSchemaObject(value: unknown): value is JSONSchema {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function permitsNull(schema: JSONSchema): boolean {
  const type = schema.type
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true
  return Array.isArray(schema.anyOf) && schema.anyOf.some(
    (part) => isSchemaObject(part) && permitsNull(part),
  )
}

function nullable(schema: JSONSchema): JSONSchema {
  if (permitsNull(schema)) return schema
  if (typeof schema.type === 'string') return { ...schema, type: [schema.type, 'null'] }
  if (Array.isArray(schema.type)) return { ...schema, type: [...schema.type, 'null'] }
  if (Array.isArray(schema.anyOf)) {
    return { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] }
  }
  return { anyOf: [schema, { type: 'null' }] }
}

/**
 * Convert ordinary JSON Schema to the strict subset Codex passes to OpenAI
 * Structured Outputs.
 *
 * The documented rules checked here are: the root is an object (not anyOf or
 * oneOf); every object has additionalProperties:false and requires every named
 * property; optional fields use a null union; and unsupported allOf, oneOf,
 * not, dependentRequired, dependentSchemas, if/then/else and patternProperties
 * keywords are refused. Nested anyOf, $defs/definitions and recursion by $ref
 * remain supported. Keeping this list beside the transformer makes a vendor
 * change visible instead of spending another run to discover it.
 */
export function strictCodexSchema(input: unknown): JSONSchema {
  if (!isSchemaObject(input)) throw new Error('schema at $ must be a JSON object')
  if (input.type !== 'object') {
    const keyword = 'oneOf' in input ? 'oneOf' : 'anyOf' in input ? 'anyOf' : 'type'
    throw new Error(`schema at $.${keyword} must have an object root`)
  }

  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, i) => visit(item, `${path}[${i}]`))
    if (!isSchemaObject(value)) return value
    for (const key of Object.keys(value)) {
      if (STRICT_UNSUPPORTED.has(key)) {
        throw new Error(`schema at ${pathKey(path, key)} uses unsupported keyword ${key}`)
      }
    }

    const out: JSONSchema = { ...value }
    if (isSchemaObject(value.properties)) {
      const wasRequired = new Set(Array.isArray(value.required) ? value.required : [])
      const properties: JSONSchema = {}
      for (const [name, property] of Object.entries(value.properties)) {
        if (!isSchemaObject(property)) {
          throw new Error(`schema at ${pathKey(pathKey(path, 'properties'), name)} must be an object`)
        }
        const transformed = visit(property, pathKey(pathKey(path, 'properties'), name)) as JSONSchema
        properties[name] = wasRequired.has(name) ? transformed : nullable(transformed)
      }
      out.properties = properties
    }
    if (value.type === 'object' || (Array.isArray(value.type) && value.type.includes('object'))) {
      const names = isSchemaObject(out.properties) ? Object.keys(out.properties) : []
      out.additionalProperties = false
      out.required = names
    }
    for (const key of ['$defs', 'definitions']) {
      if (!isSchemaObject(value[key])) continue
      out[key] = Object.fromEntries(Object.entries(value[key] as JSONSchema).map(([name, schema]) => [
        name, visit(schema, pathKey(pathKey(path, key), name)),
      ]))
    }
    if ('items' in value) out.items = visit(value.items, pathKey(path, 'items'))
    if (Array.isArray(value.anyOf)) {
      out.anyOf = value.anyOf.map((schema, i) => visit(schema, `${path}.anyOf[${i}]`))
    }
    return out
  }

  return visit(input, '$') as JSONSchema
}

export function readStrictCodexSchema(path: string): JSONSchema {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`schema at $ is not valid JSON: ${String((e as Error).message ?? e)}`)
  }
  return strictCodexSchema(parsed)
}

/**
 * Policy and capabilities for a vendor. How it is spawned lives on
 * `AgentTransport` (`cli` by default; `acp` is selectable for paid read-only jobs).
 * `argv` / `resumeArgv` / `parseReply` / `readSession` are the CLI transport's
 * launch and parse surface — `cliTransport` reads them when it builds argv.
 * They are not unused leftovers of the old inlined spawn.
 */
export type Agent = {
  name: string
  harness?: string
  backend?: string | null
  baseUrl?: string | null
  enabled?: boolean
  disabledReason?: string | null
  probedAt?: string | null
  probeResult?: unknown
  probePassed?: boolean
  legacy?: boolean
  bin: string
  /** Oldest CLI release this harness has been verified against. */
  minimumCliVersion: string
  /** Where its usage is billed. Metered is refused; local costs nothing at all. */
  billing: 'subscription' | 'free' | 'local' | 'metered' | 'unknown'
  /**
   * The model this agent runs, PASSED EXPLICITLY on every call.
   *
   * Not left to the CLI's own default, and that is the point. codex takes its
   * model from `~/.codex/config.toml`, which a person can change at any time
   * without telling this tool — and the moment they do, every score already
   * recorded against "codex" silently starts meaning something else. An agent
   * is a harness; the model is what is actually being judged, and evidence
   * gathered under one is not evidence about the other.
   *
   * So orch pins it and records what it pinned. Both subscriptions carry more
   * than one model (grok-4.6 and grok-4.5; the gpt-5.6 line), so this is a real
   * fork rather than a hypothetical one.
   *
   * NOT YET A ROUTING KEY, deliberately. Splitting the key multiplies the cells
   * exactly as the stack key does, and the corpus has no per-model evidence at
   * all yet — routing on it today would starve every cell and fall back to
   * declared preference for ever. Recording it is what makes the question
   * answerable later; routing on it now would repeat a mistake this file has
   * already made once.
   */
  model: string
  caps: Caps
  /** Transport decision and the measured ACP capabilities for this installed adapter. */
  defaultTransport: 'cli' | 'acp'
  acp?: {
    mcpServers: boolean
    mcpReason: string
    nativeElicitation: boolean
    nativeElicitationReason: string
  }
  /** Build argv for a one-shot run. `out` is a file the agent writes its final message to. */
  argv(opts: ArgvOpts): string[]
  /**
   * Build argv to CONTINUE an existing session with one more turn.
   *
   * Present exactly when `caps.resumable`. The prompt here is the orchestrator's
   * ruling on whatever the worker stopped to ask, and the point of resuming
   * rather than re-running is that everything the worker already read is still
   * in its head — answering a design question costs one short turn instead of a
   * second full survey of the code.
   */
  resumeArgv?(opts: ArgvOpts & { session: string }): string[]
  /**
   * Mint the session id BEFORE the run, when the agent lets us choose it.
   *
   * Better than scraping one afterwards, and for the same reason `orch do
   * --detach` reserves its run id before routing: the handle exists before the
   * thing it names, so a worker that dies mid-turn is still resumable. grok
   * takes `--session-id`; codex assigns its own and reports it, which is
   * `readSession` below.
   */
  mintSession?(): string
  /**
   * Whether asking for MCP forces a WRITABLE sandbox on this agent.
   *
   * True for codex: `--approve-for-me` is required for MCP tool calls and is
   * mutually exclusive with `--sandbox`, because it already implies
   * workspace-write. So a job that asked only for tools gets a writable disk as
   * a side effect, invisible in the flag list — and a read-only job cuts no
   * worktree, so that writable disk was the caller's own checkout.
   *
   * Declared rather than merely commented, so `run()` can isolate those runs
   * too rather than a comment reassuring everyone that it does not matter.
   */
  mcpImpliesWrite?: boolean
  /**
   * Recover the session id after the fact, when the agent assigns its own.
   *
   * Takes the run's context and not just stdout, because the two agents that
   * need it hide the id in different places: codex announces it in its event
   * stream, and qwen never prints it at all — it names a chat-recording file
   * after it, on disk, under a directory derived from the cwd.
   */
  readSession?(ctx: {
    stdout: string; cwd: string; prompt: string; startedAt: number
    /** Vendor recording home when a sandbox deliberately overrides HOME. */
    home?: string
  }): string | null
  /** Prompt goes on stdin rather than argv (avoids ARG_MAX on large packs). */
  stdin: boolean
  /**
   * Largest prompt this agent can be handed. An argv agent is bounded by
   * ARG_MAX (1 MB here, shared with the environment), so a fat pack sent to one
   * dies rather than routing elsewhere. Held well below the ceiling.
   */
  maxPromptBytes: number
  /** Read the reply from `out`, or fall back to stdout. */
  readsOut: boolean
  /**
   * How long this agent may take before the run is abandoned.
   *
   * Without one, `orch do` waits on the child for ever: a hung agent hangs the
   * caller, and thirty minutes later another process sweeps the row to `stale`
   * while the parent is still blocked on it. The ceilings are set from measured
   * behaviour with room above the worst case, not from a guess — grok's longest
   * honest review-lens in this database ran 867s, so 25 minutes leaves it
   * headroom while still bounding a hang.
   *
   * Held below STALE_AFTER_MS so a run always writes its own terminal state
   * rather than being reaped out from under itself.
   */
  timeoutMs: number
  /**
   * How much the agent can hold in ONE request, in tokens.
   *
   * Not the same question as `maxPromptBytes`, which is about ARG_MAX — whether
   * the prompt fits on a command line. This is whether the job fits in the
   * model's head once it starts working, and it is the constraint that actually
   * decided things: a lens that opens six files and fetches four documents is
   * nowhere near ARG_MAX and comfortably past a 64K window.
   *
   * It bites through the OUTPUT budget rather than as a rejection. A server
   * allows `window - prompt` for the reply, so as an agentic loop accumulates
   * tool results the room to answer shrinks; a reasoning model spends that room
   * thinking and can hit the cap having emitted nothing. Run 279 is that, and
   * run 294 is the blunter version — a flat 400 saying 65,536.
   */
  contextTokens: number
  /**
   * The vendor's native stop reason for exhausting the reply budget.
   *
   * Null is explicit: it means this agent has not produced an observed value
   * yet, not that somebody forgot to decide how its truncations are named.
   */
  outputCeilingStopReason: string | null
  /** Extra environment for the child process, e.g. to select a local endpoint. */
  env?: () => Record<string, string>
  /**
   * Pull the answer and the usage out of a structured reply. Agents that can
   * report their own token spend are run in a JSON mode, so stdout is an
   * envelope rather than the answer; this unwraps it. Anything unparseable
   * falls back to raw stdout, so a format change degrades to "no usage"
   * rather than to a lost run.
   */
  parseReply?(stdout: string): {
    text: string
    tokens: number | null
    costUsd: number | null
    /** The vendor's native terminal reason, without cross-vendor normalization. */
    stopReason?: string | null
    /** The structured envelope says the run failed even if the process exited 0. */
    error?: string
  }
  notes: string
}

export function parsedCliVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null
}

export function versionBelow(actual: string, minimum: string): boolean {
  const a = actual.split('.').map(Number)
  const m = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== m[i]!) return a[i]! < m[i]!
  }
  return false
}

export function cliVersion(bin: string): { display: string; parsed: string | null } {
  const p = Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = new TextDecoder().decode(p.stdout).trim()
  const stderr = new TextDecoder().decode(p.stderr).trim()
  const display = stdout || stderr || `exit ${p.exitCode}`
  return { display, parsed: parsedCliVersion(`${stdout}\n${stderr}`) }
}

export function minimumCliVersionRefusal(agent: Agent): string | null {
  const version = cliVersion(agent.bin)
  return version.parsed && versionBelow(version.parsed, agent.minimumCliVersion)
    ? `${agent.name} ${version.parsed} is below minimum ${agent.minimumCliVersion}`
    : null
}

/** Argv-agent prompt ceiling used by routing eligibility. */
export const ARGV_PROMPT_BYTES = 200_000

/**
 * Resume puts the prompt on argv for every resumable agent, including Codex
 * whose first turn uses stdin and therefore declares no argv ceiling.
 */
export function resumePromptByteLimit(agent: Agent): number {
  if (Number.isFinite(agent.maxPromptBytes)) return agent.maxPromptBytes
  return ARGV_PROMPT_BYTES
}

/** Where a local OpenAI-compatible endpoint lives, e.g. http://127.0.0.1:8010/v1 */
export const LOCAL_BASE_URL = process.env.ORCH_LOCAL_BASE_URL ?? ''
export const LOCAL_MODEL = process.env.ORCH_LOCAL_MODEL ?? 'Qwen/Qwen3.6-35B-A3B'
/**
 * What the local endpoint is actually serving. Verified by `orch doctor`.
 *
 * Raised from 65,536 once the served window was measured rather than assumed.
 * 65,536 had been badly conservative: at the same --gpu-memory-utilization the
 * box reports a 233,376-token KV cache, which is 6.91 concurrent requests at
 * the full 131,072 — so the ceiling that excluded the local model from 74% of
 * all delegated work was costing nothing to hold.
 */
export const LOCAL_CONTEXT_TOKENS = Number(process.env.ORCH_LOCAL_CONTEXT ?? 131_072)

/** Shared shape: the reply could not be unwrapped, so take stdout at face value. */
const rawReply = (stdout: string) => ({ text: stdout.trim(), tokens: null, costUsd: null })

/**
 * The flags codex needs on a first turn and a resumed one alike.
 *
 * Shared because the two must not drift: a resume that dropped `--json` would
 * lose the thread id, and one that dropped `-s workspace-write` would hand a
 * half-finished implementation a read-only disk and report success having
 * changed nothing.
 *
 * `--json` is now unconditional. It was only ever needed for the thread id, but
 * it also carries `turn.completed.usage`, which is a better source for token
 * spend than scraping "tokens used" off stderr.
 *
 * THE SANDBOX AND MCP ARE ENTANGLED, and not by us. `--approve-for-me` is
 * required for MCP tool calls — `exec` defaults to `approval_policy=never` and
 * refuses them outright — and it is mutually exclusive with `--sandbox` because
 * it already implies workspace-write. So a job that asks for `mcp` gets a
 * writable disk whether or not it asked for one.
 *
 * Repository jobs are safe under that implication because run() gives each one
 * a disposable worktree and grants only its linked metadata directory.
 */
function codexCommon(o: Omit<ArgvOpts, 'prompt'>): string[] {
  // -m always, never the config file's default: see Agent.model for why an
  // unpinned model quietly rewrites the meaning of every score already taken.
  const a = [
    '--strict-config', '--skip-git-repo-check', '--json', '-o', o.out,
    '-m', o.model ?? AGENTS.codex!.model,
  ]
  /**
   * MCP AND THE SANDBOX CANNOT BOTH BE CHOSEN, and the split falls out well.
   *
   * `--approve-for-me` is required for MCP tool calls and is mutually exclusive
   * with `--sandbox`, so a job needing the ask channel gets workspace-write and
   * cannot also have `exec`. That sounds like a compromise and is not. What
   * `exec` buys is EXECUTION — running the suite, reaching Docker — and that is
   * what REVIEW lenses need, and they use no MCP at all. An implementation
   * worker needs the ask channel more than it needs the container, because a
   * worker that cannot ask guesses, which is the failure this whole system
   * exists to prevent.
   *
   * All repository work now takes this bounded workspace-write path.
   *
   * IT IS A CODEX LIMITATION, NOT THE SYSTEM'S, and that distinction was worth
   * establishing rather than assuming. grok has no such conflict: it discovers
   * Claude-compatible MCP configuration natively and needs no approval flag, so
   * nothing competes with its sandbox setting. Repo-local servers are separately
   * gated by Grok's persistent folder trust; run() passes `--trust` only for an
   * orch-created disposable worktree when MCP was requested. The resulting
   * entry is harmless residue after that unique worktree path is removed.
   * Verified directly — with
   * `--permission-mode acceptEdits` it reported `ask_orchestrator` among its
   * tools AND wrote the requested file in the same run.
   *
   * So an implementation worker CAN have both; it just cannot be codex today.
   * Not encoded as a routing preference, because grok has no scored implement
   * runs yet and preferring an agent on zero evidence is the mistake this file
   * already warns about twice. The router will find it: grok is eligible now,
   * exploration will send it work, and if it is better here the score will say
   * so. What this note buys is that nobody re-derives the constraint and
   * concludes the system cannot do it.
   */
  if (o.writableRoots?.length) {
    a.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(o.writableRoots)}`)
  }
  if (o.gitObjectEnvironment) {
    for (const [key, value] of Object.entries(o.gitObjectEnvironment)) {
      a.push('-c', `shell_environment_policy.set.${key}=${JSON.stringify(value)}`)
    }
  }
  if (o.gitConfigEnvironment) {
    for (const [key, value] of Object.entries(o.gitConfigEnvironment)) {
      a.push('-c', `shell_environment_policy.set.${key}=${JSON.stringify(value)}`)
    }
  }
  if (o.mcp) {
    a.push('-c', `mcp_servers.orch-ask.env_vars=${JSON.stringify([...CODEX_ASK_ENV_VARS])}`)
    a.push('--approve-for-me')
  } else if (o.sandbox === 'exec') a.push('-s', CODEX_EXEC_SANDBOX)
  else a.push('-s', o.write || o.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only')
  if (o.schema) a.push('--output-schema', o.schema)
  return a
}

/**
 * The flags grok needs on a first turn and a resumed one alike.
 *
 * Everything except the prompt and the session, because those are the two the
 * two builders disagree about: `--session-id` names a NEW conversation and
 * `--resume` continues an existing one, and passing both is an error.
 */
function grokCommon(o: Omit<ArgvOpts, 'prompt' | 'session'>): string[] {
  /**
   * Aggregate `json` welds every assistant text turn together: progress before
   * tool calls lands directly against the final report, sometimes as
   * `...used.## Heading`. The Anthropic-compatible stream keeps those turns
   * separate and ends with a structured `result` carrying only the final
   * answer. `--json-schema` implies aggregate JSON at the point it is parsed,
   * so the explicit stream flag comes AFTER it; verified against a
   * schema-constrained run whose terminal result also carried structured data.
   */
  const a: string[] = ['-m', o.model ?? AGENTS.grok!.model]
  if (o.trustCwd) a.unshift('--cwd', o.trustCwd, '--trust')
  // --json-schema takes the schema inline, not a path.
  if (o.schema) a.push('--json-schema', readFileSync(o.schema, 'utf8'))
  a.push('--output-format', 'streaming-messages-json')
  /**
   * HEADLESS GROK MUST NEVER PROMPT. Runs 773, 785, 789, 809, 853, 856, 867 and
   * 883 all ended `cancelled` when a shell segment fell outside grok's
   * read-only list. Probes 916/917 reproduced it from a worktree: `default`
   * cancelled at `rm`, and `dontAsk` also prompted and cancelled rather than
   * denying. `bypassPermissions` completed every command. A read-only sandbox
   * could not start on this machine because `/var/run/docker.sock` is a
   * symlink, while the workspace sandbox still allowed writes under `/tmp`.
   * The worktree plus the dirtied-tree detector are therefore the guards for
   * lenses as well as writing jobs.
   */
  a.push('--permission-mode', 'bypassPermissions')
  return a
}

const BUILTIN_AGENTS: Record<string, Agent> = {
  codex: {
    name: 'codex',
    bin: 'codex',
    // The official Configuration Reference documents this as "Additional
    // environment variables to whitelist for an MCP stdio server" but names
    // no introducing release. 0.153.4 is therefore the installed version on
    // which the env_vars overlay and --strict-config were verified together.
    // https://developers.openai.com/codex/config-reference#mcp_serversidenv_vars
    minimumCliVersion: '0.153.4',
    model: process.env.ORCH_CODEX_MODEL ?? 'gpt-5.6-sol',
    billing: 'subscription',
    // writesRepo VERIFIED: `-s workspace-write` in a scratch git repo created
    // the requested file and exited 0. resumable VERIFIED: `--json` emits
    // `thread.started` on the first line and `exec resume <thread_id>` recalled
    // the previous turn.
    caps: { readsRepo: true, mcp: true, discoversMcpFromCwd: false, schema: true, writesRepo: true, resumable: true },
    defaultTransport: 'cli',
    acp: {
      mcpServers: true,
      mcpReason: 'codex-acp 1.10.0 accepts session/new mcpServers, but the 2026-09-07 ask case returned prose without calling orch-ask',
      nativeElicitation: false,
      nativeElicitationReason: 'codex-acp 1.10.0 answered the requested user question as prose and emitted no elicitation/create',
    },
    mcpImpliesWrite: true,
    stdin: true,
    maxPromptBytes: Number.POSITIVE_INFINITY,
    readsOut: true,
    // Slowest honest run measured: 621s.
    timeoutMs: 20 * 60_000,
    // No measured ceiling. Eighty-odd runs, not one context failure — so the
    // honest encoding is "not the binding constraint here", not a number
    // copied off a model card. The day one of these fails on window, put the
    // real figure in and the router will start respecting it.
    contextTokens: Number.POSITIVE_INFINITY,
    // output-ceiling stop reason not yet observed; record it from a real run
    outputCeilingStopReason: null,
    notes: 'ChatGPT auth. Bundled ripgrep. Reads AGENTS.md natively, root and nested.',
    argv(o) {
      return ['exec', ...codexCommon(o), '-']
    },
    /**
     * FLAGS BEFORE THE SUBCOMMAND, always.
     *
     * `codex exec resume <id> -s read-only` is rejected outright — "unexpected
     * argument '-s' found" — because parsing stops at the subcommand. The
     * working order is `codex exec <flags> resume <id> <prompt>`, which reads
     * backwards and is exactly the kind of thing that gets helpfully "tidied"
     * into the broken form by someone who has not tried it.
     *
     * The prompt goes on argv here rather than stdin: `resume` takes it
     * positionally, and a ruling on a design question is a sentence or two, so
     * the ARG_MAX that makes stdin necessary for a first-turn pack is not in
     * play.
     */
    resumeArgv({ session, prompt, ...rest }) {
      return ['exec', ...codexCommon(rest), 'resume', session, prompt]
    },
    /**
     * `--json` makes stdout an event stream, so the reply and the usage both
     * have to be lifted out of it.
     *
     * The token count comes from `turn.completed.usage` now rather than from
     * scraping "tokens used" off stderr. Both are the vendor's own number, but
     * one is a field and the other is a line of human-readable output that has
     * changed shape before. `input_tokens` already includes the cached portion,
     * so adding `cached_input_tokens` would double-count it.
     */
    parseReply(stdout) {
      let text = ''
      let tokens: number | null = null
      for (const line of stdout.split('\n')) {
        const s = line.trimStart()
        if (!s.startsWith('{')) continue
        try {
          const e = JSON.parse(s)
          if (e.type === 'item.completed' && e.item?.type === 'agent_message') {
            text = String(e.item.text ?? '')
          } else if (e.type === 'turn.completed' && e.usage) {
            tokens = (e.usage.input_tokens ?? 0) + (e.usage.output_tokens ?? 0)
          }
        } catch { /* a half-written line carries neither */ }
      }
      // No events parsed at all means the format moved under us: fall back to
      // raw stdout so a change degrades to "no usage" rather than a lost run.
      return text || tokens !== null
        ? { text: text.trim(), tokens, costUsd: null }
        : rawReply(stdout)
    },
    /** Codex names its own thread and announces it on the first line of --json. */
    readSession({ stdout }) {
      for (const line of stdout.split('\n')) {
        const s = line.trimStart()
        if (!s.startsWith('{')) continue
        try {
          const e = JSON.parse(s)
          if (e.type === 'thread.started' && e.thread_id) return String(e.thread_id)
        } catch { /* a half-written line is not a thread id */ }
      }
      return null
    },
  },
  grok: {
    name: 'grok',
    bin: 'grok',
    minimumCliVersion: '1.0.13',
    model: process.env.ORCH_GROK_MODEL ?? 'grok-4.6',
    billing: 'subscription',
    // Project servers are discovered from the process cwd. For a repository
    // run requesting `--mcp` (required) or `--mcp=prefer` (mirror fallback),
    // dispatch therefore preflights the worker tree's `.mcp.json`. When only
    // the registered checkout has it, orch links that copy into the worker
    // tree before probing; when neither has it, required mode refuses before
    // Grok starts and prefer mode records and discloses the mirror fallback.
    // A removed tree's unique path never recurs, so its vendor trust entry is
    // harmless residue reported by sweep rather than state orch edits.
    //
    // writesRepo VERIFIED directly from a shell in a scratch git repo: with
    // `--permission-mode acceptEdits`, v1.0.13 created the requested uncommitted
    // 28-byte file containing exactly GROK_WRITE_PROOF_2026_09_02 plus newline,
    // and exited 0 in 13.38s.
    caps: { readsRepo: true, mcp: true, discoversMcpFromCwd: true, schema: true, writesRepo: true, resumable: true },
    defaultTransport: 'cli',
    acp: {
      mcpServers: false,
      mcpReason: 'grok 1.0.13 rejects session/new with an stdio mcpServers entry as "Path not found."; its per-run GROK_HOME fallback delivered the live orch-answer ruling in the 2026-09-07 parity run',
      nativeElicitation: false,
      nativeElicitationReason: 'grok 1.0.13 reported ask_user_question unavailable and emitted no elicitation/create',
    },
    stdin: false,
    maxPromptBytes: ARGV_PROMPT_BYTES,
    readsOut: false,
    // The slowest agent by a distance: 867s is the longest honest run recorded.
    timeoutMs: 25 * 60_000,
    contextTokens: Number.POSITIVE_INFINITY,
    outputCeilingStopReason: 'max_tokens',
    notes: 'OIDC subscription auth. Inherits Claude rules and MCP config with no setup.',
    argv({ prompt, ...o }) {
      // The session id is minted by US and handed in, so the resume handle
      // exists before the run does. `--session-id` is only legal for a NEW
      // conversation; resuming with it is an error, which is why the two argv
      // builders do not share this line.
      const a = grokCommon(o)
      if (o.session) a.push('--session-id', o.session)
      a.push('-p', prompt)
      return a
    },
    resumeArgv({ prompt, session, ...o }) {
      return [...grokCommon(o), '--resume', session, '-p', prompt]
    },
    mintSession: () => randomUUID(),
    parseReply(stdout) {
      /**
       * A tool-using run has several assistant messages: narration plus a tool
       * request, then the actual answer. The terminal result is Grok's own
       * final-message boundary, so take it rather than guessing which prose is
       * narration. Schema-constrained runs expose the same terminal boundary.
       */
      let final: any = null
      let stream = false
      let stopReason: string | null = null
      for (const line of stdout.split('\n')) {
        const s = line.trimStart()
        if (!s.startsWith('{')) continue
        try {
          const event = JSON.parse(s)
          if (event.type === 'system' && event.subtype === 'init') stream = true
          if (event.type === 'assistant' && event.message?.stop_reason) {
            stopReason = String(event.message.stop_reason)
          }
          if (event.type === 'result') final = event
        } catch { /* a partial line cannot be the terminal result */ }
      }
      if (final) {
        const usage = final.usage
        const tokens = usage
          ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0)
          : null
        const text = String(final.result ?? '').trim()
        const errors = Array.isArray(final.errors)
          ? final.errors.map((error: unknown) => String(error)).filter(Boolean)
          : []
        const nativeStopReason = final.stop_reason ? String(final.stop_reason) : stopReason
        return {
          text,
          tokens,
          costUsd: final.total_cost_usd ?? null,
          ...(nativeStopReason ? { stopReason: nativeStopReason } : {}),
          ...errors.length
            ? { error: errors.join('\n') }
            : !text ? { error: 'grok result contained no final text' } : {},
        }
      }
      if (stream) {
        return {
          text: '', tokens: null, costUsd: null,
          error: 'grok stream contained no result event',
        }
      }
      try {
        const j = JSON.parse(stdout)
        return {
          text: String(j.text ?? '').trim(),
          tokens: j.usage?.total_tokens ?? null,
          costUsd: j.total_cost_usd ?? null,
        }
      } catch { return rawReply(stdout) }
    },
  },
}

/** Names seeded by the registry migration and therefore valid in job preferences. */
export const MIGRATED_AGENT_NAMES = ['agy', 'codex', 'grok', 'qwen-local'] as const

export const HARNESSES = ['codex', 'grok', 'opencode', 'goose', 'claude-code'] as const
export const BACKENDS = ['vllm', 'ollama', 'lmstudio', 'vendor'] as const
export type Harness = (typeof HARNESSES)[number]
export type Backend = (typeof BACKENDS)[number]
export type AgentRow = {
  name: string; harness: string; backend: string | null; model: string; base_url: string | null
  transport: 'cli' | 'acp'; caps: string; billing: Agent['billing']; enabled: number
  disabled_reason: string | null; probed_at: string | null; probe_result: string | null
}

function rowAgent(row: AgentRow): Agent {
  const stored = JSON.parse(row.caps) as Caps & { contextTokens?: number | null }
  const harnessBuiltin = BUILTIN_AGENTS[row.harness]
  const legacy = !HARNESSES.includes(row.harness as Harness)
  const adapter = harnessBuiltin
  const base: Agent = adapter ? { ...adapter } : {
    name: row.name,
    bin: row.harness,
    minimumCliVersion: '0.0.0',
    billing: row.billing,
    model: row.model,
    caps: stored,
    defaultTransport: row.transport,
    stdin: false,
    maxPromptBytes: Number.POSITIVE_INFINITY,
    readsOut: false,
    timeoutMs: 20 * 60_000,
    contextTokens: stored.contextTokens ?? 0,
    outputCeilingStopReason: null,
    notes: `${legacy ? 'Legacy agent; historical evidence only.' : `${row.harness} ACP harness.`}`,
    argv() { throw new Error(`${row.name} has no CLI transport; use ACP`) },
  }
  return {
    ...base,
    name: row.name,
    harness: row.harness,
    backend: row.backend,
    baseUrl: row.base_url,
    model: row.model,
    billing: row.billing,
    caps: stored,
    defaultTransport: row.transport,
    contextTokens: Object.hasOwn(stored, 'contextTokens')
      ? (stored.contextTokens === null ? Number.POSITIVE_INFINITY : stored.contextTokens!)
      : 0,
    enabled: Boolean(row.enabled),
    disabledReason: row.disabled_reason,
    probedAt: row.probed_at,
    probeResult: row.probe_result ? JSON.parse(row.probe_result) : null,
    probePassed: row.probe_result ? JSON.parse(row.probe_result).ok !== false : false,
    legacy,
    ...(row.base_url ? { env: () => ({
      ...(base.env?.() ?? {}),
      ORCH_LOCAL_BASE_URL: row.base_url!,
      OPENAI_BASE_URL: row.base_url!,
      OPENAI_API_KEY: 'local',
      ...(row.harness === 'goose' ? {
        GOOSE_PROVIDER: 'openai',
        GOOSE_MODEL: row.model,
        GOOSE_TELEMETRY_ENABLED: 'false',
      } : {}),
    }) } : {}),
  }
}

const FALLBACK_AGENTS: Record<string, Agent> = {
  ...BUILTIN_AGENTS,
  ...Object.fromEntries([
    {
      name: 'agy', harness: 'agy', backend: 'vendor', model: 'gemini-3.1-pro-high',
      base_url: null, transport: 'cli', billing: 'free', enabled: 0,
      disabled_reason: 'no readsRepo; only two inline jobs and negligible evidence',
      probed_at: '2026-09-07T00:00:00.000Z',
      probe_result: '{"source":"migrated verified capabilities","legacy":true}',
      caps: '{"readsRepo":false,"mcp":false,"discoversMcpFromCwd":false,"schema":true,"writesRepo":false,"resumable":false,"contextTokens":null}',
    },
    {
      name: 'qwen-local', harness: 'qwen', backend: 'vllm', model: 'Qwen/Qwen3.6-35B-A3B',
      base_url: null, transport: 'cli', billing: 'local', enabled: 0,
      disabled_reason: 'retired bespoke driver; replacement is local-acp',
      probed_at: '2026-09-07T00:00:00.000Z',
      probe_result: '{"source":"migrated verified capabilities","legacy":true}',
      caps: '{"readsRepo":true,"mcp":true,"discoversMcpFromCwd":false,"schema":false,"writesRepo":false,"resumable":false,"contextTokens":131072}',
    },
  ].map((row) => [row.name, rowAgent(row as AgentRow)])),
}

export function agentRows(): AgentRow[] {
  if (!ROOT) return []
  if (!existsSync(DB_PATH)) throw new Error(`orchestrator database does not exist: ${DB_PATH}`)
  // Let the canonical opener diagnose a stranded WAL. SQLite cannot open this
  // shape read-only without its shared-memory sidecar, and db() carries the
  // actionable lifecycle refusal for it.
  if (existsSync(`${DB_PATH}-wal`) && !existsSync(`${DB_PATH}-shm`)) {
    return dbForAgents().query('SELECT * FROM agent ORDER BY name').all() as AgentRow[]
  }
  // Registry reads happen during jobs.ts import. Keep them genuinely read-only:
  // reporting commands such as review coverage-audit promise not to alter the
  // database bytes merely by importing the job/agent catalogues.
  const database = new Database(DB_PATH, { readonly: true })
  try {
    return database.query('SELECT * FROM agent ORDER BY name').all() as AgentRow[]
  } finally {
    database.close()
  }
}

let agentCache: Record<string, Agent> | null = null
function loadedAgents(): Record<string, Agent> {
  if (agentCache) return agentCache
  try {
    const rows = agentRows()
    const loaded = Object.fromEntries(rows.map((row) => [row.name, rowAgent(row)]))
    for (const [name, agent] of Object.entries(loaded)) assertResumableAgent(name, agent, false)
    return agentCache = loaded
  } catch (error) {
    if (String((error as Error).message).includes('database does not exist')) return FALLBACK_AGENTS
    throw error
  }
}
/** Reload registry rows at a mutation or long-lived reporting boundary. */
export function refreshAgents(): void { agentCache = null }
export const AGENTS: Record<string, Agent> = new Proxy({}, {
  get: (_target, property) => loadedAgents()[property as string],
  ownKeys: () => Reflect.ownKeys(loadedAgents()),
  has: (_target, property) => property in loadedAgents(),
  getOwnPropertyDescriptor: (_target, property) => property in loadedAgents()
    ? { enumerable: true, configurable: true, value: loadedAgents()[property as string] }
    : undefined,
})

export type AgentMutation = {
  harness?: Harness; backend?: Backend; model?: string; baseUrl?: string | null
  transport?: 'cli' | 'acp'; billing?: Agent['billing']; contextTokens?: number
  enabled?: boolean; reason?: string
}

function assertAgentMutation(input: AgentMutation, adding: boolean): void {
  if (input.harness && !HARNESSES.includes(input.harness)) throw new Error(`unknown harness "${input.harness}"`)
  if (input.backend && !BACKENDS.includes(input.backend)) throw new Error(`unknown backend "${input.backend}"`)
  if (input.transport && !['cli', 'acp'].includes(input.transport)) throw new Error(`unknown transport "${input.transport}"`)
  if (input.billing && !['subscription','free','local','metered','unknown'].includes(input.billing)) {
    throw new Error(`unknown billing "${input.billing}"`)
  }
  if (input.enabled === false && !input.reason?.trim()) {
    throw new Error('disabling an agent requires --reason')
  }
  if (input.enabled !== false && input.reason !== undefined) {
    throw new Error('--reason is only valid with --enabled false')
  }
  if (input.contextTokens !== undefined && (!Number.isInteger(input.contextTokens) || input.contextTokens <= 0)) {
    throw new Error('--context-tokens must be a positive integer')
  }
  if (adding && (!input.harness || !input.backend || !input.model)) {
    throw new Error('agent add requires --harness, --backend, and --model')
  }
}

export function addAgent(name: string, input: AgentMutation): AgentRow {
  assertAgentMutation(input, true)
  const caps = {
    readsRepo: false, mcp: false, discoversMcpFromCwd: false, schema: false,
    writesRepo: false, resumable: false,
    ...(input.contextTokens ? { contextTokens: input.contextTokens } : {}),
  }
  writableDb().query(
    `INSERT INTO agent (name,harness,backend,model,base_url,transport,caps,billing,enabled,disabled_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(name, input.harness!, input.backend!, input.model!, input.baseUrl ?? null,
    input.transport ?? 'acp', JSON.stringify(caps), input.billing ?? (input.backend === 'vendor' ? 'subscription' : 'local'),
    input.enabled === false ? 0 : 1, input.enabled === false ? input.reason!.trim() : null)
  refreshAgents()
  return agentRows().find((row) => row.name === name)!
}

export function setAgent(name: string, input: AgentMutation): AgentRow {
  assertAgentMutation(input, false)
  const current = agentRows().find((row) => row.name === name)
  if (!current) throw new Error(`unknown agent "${name}"`)
  let caps = JSON.parse(current.caps) as Record<string, unknown>
  const enabled = input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0
  const reason = input.enabled === false ? input.reason!.trim()
    : input.enabled === true ? null : current.disabled_reason
  const identityChanged =
    (input.harness !== undefined && input.harness !== current.harness) ||
    (input.backend !== undefined && input.backend !== current.backend) ||
    (input.model !== undefined && input.model !== current.model) ||
    (input.baseUrl !== undefined && input.baseUrl !== current.base_url)
  let probedAt = current.probed_at
  let probeResult = current.probe_result
  if (identityChanged) {
    const previous = current.probe_result ? JSON.parse(current.probe_result) : null
    const attempts = Array.isArray(previous?.attempts) ? previous.attempts : []
    if (previous && !previous.pendingIdentity) {
      attempts.push({ harness: previous.harness ?? current.harness, result: previous })
    }
    const declaredContext = input.contextTokens ??
      (previous?.contextSource === 'declared' ? Number(caps.contextTokens) : undefined)
    caps = {
      readsRepo: false, mcp: false, discoversMcpFromCwd: false, schema: false,
      writesRepo: false, resumable: false,
      ...(declaredContext ? { contextTokens: declaredContext } : {}),
    }
    probedAt = null
    probeResult = JSON.stringify({
      ok: false,
      pendingIdentity: {
        harness: input.harness ?? current.harness,
        backend: input.backend ?? current.backend,
        model: input.model ?? current.model,
        baseUrl: input.baseUrl === undefined ? current.base_url : input.baseUrl,
      },
      attempts,
    })
  } else if (input.contextTokens !== undefined) {
    caps.contextTokens = input.contextTokens
  }
  writableDb().query(
    `UPDATE agent SET harness=?,backend=?,model=?,base_url=?,transport=?,caps=?,billing=?,enabled=?,disabled_reason=?,probed_at=?,probe_result=? WHERE name=?`,
  ).run(input.harness ?? current.harness, input.backend ?? current.backend,
    input.model ?? current.model, input.baseUrl === undefined ? current.base_url : input.baseUrl,
    input.transport ?? current.transport, JSON.stringify(caps), input.billing ?? current.billing,
    enabled, reason, probedAt, probeResult, name)
  refreshAgents()
  return agentRows().find((row) => row.name === name)!
}

export function removeAgent(name: string): void {
  const count = (dbForAgents().query('SELECT COUNT(*) n FROM run WHERE agent=?').get(name) as { n: number }).n
  if (count) {
    throw new Error(
      `refusing to remove agent "${name}": ${count} run row${count === 1 ? '' : 's'} name it\n` +
      `disable it instead: orch agent set ${name} --enabled false --reason <reason>`,
    )
  }
  const result = writableDb().query('DELETE FROM agent WHERE name=?').run(name)
  if (!result.changes) throw new Error(`unknown agent "${name}"`)
  refreshAgents()
}

export const REGISTRATION_PROBE_FILE = 'probe.txt'
export const REGISTRATION_PROBE_SENTINEL = 'REGISTRATION_PROBE_FILE_OK'

function namesProbeFile(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return normalized === REGISTRATION_PROBE_FILE ||
    normalized.endsWith(`/${REGISTRATION_PROBE_FILE}`) ||
    new RegExp(`(?:^|[\\s"'/])${REGISTRATION_PROBE_FILE.replace('.', '\\.')}(?:$|[\\s"'])`).test(normalized)
}

/** True only for a completed read of the probe file whose result or final reply carries the sentinel. */
export function registrationProbeReadsRepo(
  events: import('./transport.ts').NormalizedEvent[],
  output: string,
): boolean {
  const reads = events.filter((event) =>
    event.kind === 'tool' &&
    event.status === 'completed' &&
    event.toolKind === 'read' &&
    (namesProbeFile(event.target ?? '') || namesProbeFile(event.title)))
  if (!reads.length) return false
  return reads.some((event) => event.kind === 'tool' &&
    typeof event.result === 'string' && event.result.includes(REGISTRATION_PROBE_SENTINEL)) ||
    output.includes(REGISTRATION_PROBE_SENTINEL)
}

export type RegistrationProbeResult = {
  harness: string
  ok: boolean
  reply: { ok: boolean; output: string }
  tool: { ok: boolean; output: string; toolEvents: number; statuses: string[] }
  schema: { ok: boolean; output: string }
  file?: { ok: boolean; output: string }
  contextTokens: number | null
  contextSource: 'harness' | 'declared' | null
  attempts?: { harness: string; result: unknown }[]
}

export function recordAgentProbe(name: string, result: RegistrationProbeResult): void {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row) throw new Error(`unknown agent "${name}"`)
  const prior = JSON.parse(row.caps) as Caps & { contextTokens?: number | null }
  const caps = {
    ...prior,
    readsRepo: result.tool.ok,
    schema: result.schema.ok,
    replyFile: result.file?.ok ?? false,
    ...(result.contextTokens !== null ? { contextTokens: result.contextTokens } : {}),
  }
  writableDb().query('UPDATE agent SET caps=?,probed_at=?,probe_result=? WHERE name=?')
    .run(JSON.stringify(caps), nowIso(), JSON.stringify(result), name)
  if (name === 'local-acp' && result.ok) {
    writableDb().query(`UPDATE agent SET enabled=0,disabled_reason=? WHERE name='qwen-local'`)
      .run('retired bespoke driver; local-acp passed registration probe')
  }
  refreshAgents()
}

/** Prove capabilities before routing spends a worktree discovering them. */
export async function probeAgent(name: string): Promise<RegistrationProbeResult> {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row) throw new Error(`unknown agent "${name}"`)
  if (!HARNESSES.includes(row.harness as Harness)) {
    throw new Error(`legacy agent "${name}" has no runnable harness`)
  }
  const agent = rowAgent(row)
  if (which(agent.bin) === null) throw new Error(`${agent.harness} harness is not installed`)
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'orch-agent-probe-'))
  mkdirSync(join(scratch, 'repo'))
  writeFileSync(join(scratch, 'repo', REGISTRATION_PROBE_FILE), `${REGISTRATION_PROBE_SENTINEL}\n`)
  const schemaPath = join(scratch, 'schema.json')
  writeFileSync(schemaPath, JSON.stringify({
    type: 'object', additionalProperties: false, required: ['status'],
    properties: { status: { type: 'string', enum: ['ok'] } },
  }))
  const { transportFor, valueMatchesStrictSchema } = await import('./transport.ts')
  const transport = transportFor(agent.defaultTransport)
  const runOne = async (id: string, prompt: string, schema?: string) => {
    const started = Date.now()
    const inserted = writableDb().query(
      `INSERT INTO run
       (started_at,agent,job,cwd,prompt_sha,prompt_bytes,prompt_head,probe,status,model,transport)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    ).get(new Date(started).toISOString(), name, `agent-probe-${id}`, join(scratch, 'repo'),
      createHash('sha256').update(prompt).digest('hex'), Buffer.byteLength(prompt), prompt.slice(0, 240),
      1, 'running', agent.model, agent.defaultTransport) as { id: number }
    try {
      const handle = await transport.start({
        agent, cwd: join(scratch, 'repo'), prompt, outPath: join(scratch, `${id}.out`),
        schemaPath: schema, model: agent.model, modelExplicit: true, startedAt: Date.now(),
        write: true, sandbox: 'workspace-write',
        writableRoots: [scratch],
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string,string] => e[1] !== undefined)),
          ...(agent.env?.() ?? {}),
          ORCH_SCRATCH: scratch,
        },
      })
      try {
        await transport.prompt(handle, prompt)
        const outcome = await handle.collect()
        writableDb().query(
          `UPDATE run SET status=?,latency_ms=?,exit_code=?,output_bytes=?,error=? WHERE id=?`,
        ).run(outcome.status === 'ok' ? 'ok' : 'failed', Date.now() - started,
          outcome.status === 'ok' ? 0 : 1, Buffer.byteLength(outcome.output),
          outcome.status === 'ok' ? null : outcome.output, inserted.id)
        return outcome
      } finally { try { handle.kill(9) } catch { /* exited */ } }
    } catch (error) {
      const detail = String((error as Error).message ?? error)
      writableDb().query(
        `UPDATE run SET status='failed',latency_ms=?,exit_code=1,error=? WHERE id=?`,
      ).run(Date.now() - started, detail, inserted.id)
      return {
        status: 'failed' as const, output: detail,
        parsed: null, events: [] as import('./transport.ts').NormalizedEvent[],
      }
    }
  }
  const reply = await runOne('reply', 'Reply with exactly: ok')
  const tool = await runOne('tool',
    `Read ${REGISTRATION_PROBE_FILE} with a file tool and reply with exactly its contents.`)
  const replyPath = join(scratch, 'reply.json')
  rmSync(replyPath, { force: true })
  const structured = await runOne(
    'schema',
    'Write {"status":"ok"} to $ORCH_SCRATCH/reply.json, then return a final message using the supplied schema.',
    schemaPath,
  )
  const parsedSchema = (() => {
    try { return JSON.parse(structured.parsed?.text ?? structured.output) } catch { return null }
  })()
  const fileOutput = existsSync(replyPath) ? readFileSync(replyPath, 'utf8') : ''
  const parsedFile = (() => {
    try { return JSON.parse(fileOutput) } catch { return null }
  })()
  const prior = JSON.parse(row.caps) as Caps & { contextTokens?: number | null }
  const previousProbe = row.probe_result ? JSON.parse(row.probe_result) : null
  const attempts = Array.isArray(previousProbe?.attempts) ? previousProbe.attempts : []
  let contextTokens = Object.hasOwn(prior, 'contextTokens') ? prior.contextTokens ?? null : null
  let contextSource: RegistrationProbeResult['contextSource'] = contextTokens ? 'declared' : null
  if (row.base_url) {
    const health = await localReachable(4000, row.base_url)
    if (health.contextTokens) { contextTokens = health.contextTokens; contextSource = 'harness' }
  }
  const result: RegistrationProbeResult = {
    harness: row.harness,
    ok: false,
    reply: { ok: reply.status === 'ok' && reply.output.trim().toLowerCase() === 'ok', output: reply.output },
    tool: {
      // ACP reports the harness tool lifecycle separately from its final prose.
      // Goose emits an empty final message after a successful read, so the
      // sentinel may live in the tool result rather than the echoed reply.
      // Any completed tool is not enough: the read must target the probe file
      // and the exact sentinel must appear in that result or the final reply.
      ok: tool.status === 'ok' && registrationProbeReadsRepo(tool.events, tool.output),
      output: tool.output, toolEvents: tool.events.filter((e) => e.kind === 'tool').length,
      statuses: tool.events.filter((e) => e.kind === 'tool').map((e) => e.status ?? 'unknown'),
    },
    schema: { ok: structured.status === 'ok' && parsedSchema?.status === 'ok', output: structured.output },
    file: { ok: valueMatchesStrictSchema(JSON.parse(readFileSync(schemaPath, 'utf8')), parsedFile), output: fileOutput },
    contextTokens, contextSource,
    ...(attempts.length ? { attempts } : {}),
  }
  result.ok = result.reply.ok && result.tool.ok && result.file!.ok && contextTokens !== null
  recordAgentProbe(name, result)
  return result
}

/**
 * What the last reachability probe found, or null if none has run yet.
 *
 * Process-local and deliberately not persisted. A cached verdict on disk would
 * be a second source of truth about a thing that changes without warning — the
 * box comes back and the file still says it is down — and `orch` processes are
 * short-lived enough that one probe each is cheap: 2ms when the endpoint is
 * healthy, and when it is not, it replaces a run that was going to fail anyway.
 */
let localHealth: { ok: boolean; detail: string; contextTokens?: number } | null = null

/**
 * MAC address to wake the local box at, or empty to never try.
 *
 * OPT-IN, and deliberately so. Powering on a remote host is an operator
 * decision. Whoever sets this is saying "wake it when work needs it"; unset,
 * nothing here ever sends a packet.
 *
 * It is configuration rather than a code dependency, which is what keeps the
 * contract with local-stack the same shape it always was: an endpoint and some
 * environment, never an import.
 */
export const LOCAL_WOL_MAC = process.env.ORCH_LOCAL_WOL_MAC ?? ''

/**
 * How long to leave the box alone after sending a magic packet.
 *
 * A second packet during boot cannot make the model load faster; it can only
 * turn one wake into a stream of packets. Leave enough time for the host and
 * model server to start.
 */
export const WAKE_COOLDOWN_MS = 10 * 60_000

const wakeStampPath = () => join(ROOT, '.last-wake')

export function lastWakeAttempt(): Date | null {
  try {
    const d = new Date(readFileSync(wakeStampPath(), 'utf8').trim())
    return Number.isNaN(d.getTime()) ? null : d
  } catch { return null }
}

/**
 * Whether to send a magic packet, decided from facts alone.
 *
 * Pure, and separate from the sending, so the four cases are pinned by tests
 * rather than by powering a machine off to see what happens — which is the only
 * way the real thing can be exercised.
 */
export function wakeDecision(o: {
  mac: string; haveBinary: boolean; last: Date | null; now: number
}): { send: boolean; detail: string } {
  if (!o.mac) return { send: false, detail: 'ORCH_LOCAL_WOL_MAC not set — waking is opt-in' }
  if (!o.haveBinary) {
    return { send: false, detail: 'wakeonlan not installed (brew install wakeonlan)' }
  }
  if (o.last) {
    const ago = o.now - o.last.getTime()
    if (ago < WAKE_COOLDOWN_MS) {
      return {
        send: false,
        detail: `woken ${Math.round(ago / 60_000)}m ago; a cold start takes ~6m, so waiting`,
      }
    }
  }
  return { send: true, detail: `magic packet to ${o.mac}` }
}

/**
 * The decision, with today's facts gathered, and nothing sent.
 *
 * One gatherer for both callers. Written because the alternative — doctor
 * assembling its own arguments to wakeDecision — immediately produced a wrong
 * one, and a status line that reports something other than what will happen is
 * the whole class of bug this codebase keeps finding.
 */
export function wakeStatus(now = Date.now()): { send: boolean; detail: string } {
  return wakeDecision({
    mac: LOCAL_WOL_MAC,
    haveBinary: which('wakeonlan') !== null,
    last: lastWakeAttempt(),
    now,
  })
}

/**
 * Send one magic packet, if that is the right thing to do.
 *
 * Fire and forget. A cold start is 5m42s and no caller can wait that long, so
 * this never blocks and never reports success at waking — only at asking. The
 * job in hand still routes elsewhere; the next one, minutes later, finds the
 * endpoint up on its own.
 */
export function tryWake(now = Date.now()): { sent: boolean; detail: string } {
  const d = wakeStatus(now)
  if (!d.send) return { sent: false, detail: d.detail }
  // Stamped BEFORE the spawn. If the spawn throws, the attempt still counts —
  // the alternative is a failure that retries on every single run.
  try { writeFileSync(wakeStampPath(), new Date(now).toISOString()) } catch { /* best effort */ }
  try {
    Bun.spawn(['wakeonlan', LOCAL_WOL_MAC],
              { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' }).unref()
  } catch { return { sent: false, detail: 'wakeonlan could not be spawned' } }
  return { sent: true, detail: d.detail }
}

/**
 * Commands that must know whether an agent can be reached before they answer.
 *
 * Anything that ROUTES (`do`) or REPORTS A ROUTE (`pick`, `guide`, `doctor`,
 * `agents`). Exported rather than left in cli.ts so it can be asserted against:
 * a command added to the switch that prints eligibility and is missing here
 * reports a route that `orch do` would not take, which is exactly what
 * happened to `pick` and `guide`.
 *
 * `stats` is deliberately absent — it reports recorded history, and history does
 * not change when a machine is switched off.
 */
export const NEEDS_HEALTH = new Set(['do', 'pick', 'guide', 'doctor', 'agents'])

/** What the probe found, without running one. Null until something has asked. */
export function localHealthCached() {
  return localHealth
}

/**
 * Probe the local endpoint once per process, and remember the answer.
 *
 * This is what makes reachability a ROUTING INPUT rather than a run outcome.
 * `available()` reads the result, so anything that calls this before routing
 * gets an honest answer, and anything that does not behaves exactly as it did
 * before — which is why the reporting views can stay synchronous.
 */
export async function ensureLocalHealth(
  opts: { force?: boolean; baseUrl?: string } = {},
) {
  if (!localHealth || opts.force) {
    localHealth = await localReachable(undefined, opts.baseUrl ?? LOCAL_BASE_URL)
  }
  return localHealth
}

/**
 * Forget the probe, so the next caller takes a fresh one.
 *
 * The cache is right for `orch do`, which lives for one run. It is wrong for
 * anything long-lived — `orch serve` runs for days, and a verdict taken when the
 * box happened to be rebooting would outlive the reboot by the life of the
 * process. Whoever holds a process open longer than a run is responsible for
 * calling this.
 */
export function resetLocalHealth() {
  localHealth = null
}

/**
 * Why this agent cannot be used at all, or null if it can.
 *
 * The reason is returned rather than a bare boolean because it is the thing
 * anyone actually needs. `--agent qwen-local` against a powered-down host used
 * to be refused as "not installed", which sends you looking for a missing
 * binary that is sitting right there on PATH.
 */
export function unavailableReason(name: string): string | null {
  const a = AGENTS[name]
  if (!a) return 'unknown agent'
  if (a.enabled === false) return `disabled — ${a.disabledReason}`
  if (a.probedAt && a.probePassed === false) return 'registration probe failed'
  if (a.contextTokens === 0) return 'unprobed and has no declared context window'
  if (which(a.bin) === null) return 'not installed'
  if (a.billing === 'local') {
    // A local agent is only real once an endpoint is configured...
    if (!LOCAL_BASE_URL) return 'ORCH_LOCAL_BASE_URL not set'
    // ...and only usable once it ANSWERS. Configuration is not reachability:
    // the env var stayed correct for the whole eleven hours the box was off.
    // Only a probe that has actually run can say no here, so a caller that
    // never awaited ensureLocalHealth() is left exactly as it was.
    if (localHealth && !localHealth.ok) return `endpoint unreachable — ${localHealth.detail}`
  }
  return null
}

export function available(name: string): boolean {
  return unavailableReason(name) === null
}

/** Confirm the local endpoint actually answers. Reachability is not configuration. */
export async function localReachable(
  timeoutMs = 4000,
  // Defaults to the configured endpoint. Taken as a parameter so this can be
  // pointed at a URL that is known to be dead, or known to be the wrong
  // service, without reconfiguring the machine — which is the only way to test
  // the "answered 200 with HTML" case that Docker Desktop actually produced.
  baseUrl = LOCAL_BASE_URL,
): Promise<{ ok: boolean; detail: string; contextTokens?: number }> {
  if (!baseUrl) return { ok: false, detail: 'ORCH_LOCAL_BASE_URL not set' }
  try {
    const res = await fetch(new URL('models', baseUrl.replace(/\/?$/, '/')), {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
    // A 200 is not proof it is the right service: another process holding the
    // port answers 200 too. Require an OpenAI-shaped model list.
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('json')) {
      return { ok: false, detail: `not an API — answered ${type.split(';')[0] || 'unknown'}; something else owns this port` }
    }
    const body = (await res.json()) as { data?: { id: string; max_model_len?: number }[] }
    if (!Array.isArray(body.data)) return { ok: false, detail: 'JSON but no model list — not an OpenAI-compatible endpoint' }
    const ids = body.data.map((m) => m.id)
    // The window the server is actually serving, which is a routing input: a job
    // whose working set will not fit is excluded outright. It is declared in
    // AGENTS because routing is synchronous, so the declaration can fall out of
    // step with a re-serve — reading it back here is what notices.
    const served = body.data.find((m) => m.max_model_len)?.max_model_len
    return {
      ok: true,
      detail: ids.length ? ids.join(', ') : 'reachable, no models listed',
      contextTokens: served,
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message }
  }
}

export function installed(): string[] {
  return Object.keys(AGENTS).filter(available)
}

/**
 * `resumable` must mean orch can actually resume it, not that the CLI has a flag.
 *
 * The two come apart, and quietly: qwen has `--resume <id>` and announces its
 * session id nowhere, so it looks resumable in every help text and cannot be
 * resumed by anything here. Declaring it true on the strength of the flag would
 * tell the router that escalation is cheap for an agent that would have to be
 * restarted from the prompt — and the whole reason to prefer a resumable worker
 * is that answering a design question costs one turn instead of a fresh survey.
 *
 * So the capability is checked against the three things it actually requires: a
 * way to build the resumed command, and a way to know the id — either because
 * we chose it or because the agent told us.
 *
 * Checked at import, like the `prefer` names above, because this is a
 * contradiction rather than a condition and should fail where it is written.
 */
function assertResumableAgent(name: string, a: Agent, requireExact: boolean): void {
  if (a.enabled === false || a.legacy) return
  const hasId = Boolean(a.mintSession ?? a.readSession)
  if (a.caps.resumable && !(a.resumeArgv && hasId)) {
    throw new Error(
      `agent "${name}" declares resumable but cannot be resumed: ` +
      `${a.resumeArgv ? '' : 'no resumeArgv; '}${hasId ? '' : 'no way to learn its session id'}`,
    )
  }
  if (requireExact && !a.caps.resumable && a.resumeArgv && hasId) {
    throw new Error(
      `agent "${name}" has everything needed to resume but declares resumable: false`,
    )
  }
}
for (const [name, a] of Object.entries(BUILTIN_AGENTS)) assertResumableAgent(name, a, true)
