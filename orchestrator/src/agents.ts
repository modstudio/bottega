import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Caps } from './capabilities.ts'
import { codexScopeArgs } from './codex-mcp-scope.ts'
import type { ArgvOpts } from './transport.ts'

export type { Caps } from './capabilities.ts'
export { MIGRATED_AGENT_NAMES } from './capabilities.ts'
export { CODEX_ASK_ENV_VARS } from './codex-mcp-scope.ts'
export type { ArgvOpts, SandboxLevel } from './transport.ts'

/**
 * What `exec` means to codex.
 *
 * Named here rather than written at the call site so there is exactly one place
 * that decides what the widest level actually grants, and so the grant is
 * legible when someone comes looking for it.
 */
export const CODEX_EXEC_SANDBOX = 'danger-full-access'
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
  probePassed?: boolean | null
  legacy?: boolean
  jobs?: string[] | null
  preferredJobs?: string[]
  maxConcurrent?: number | null
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
    stdout: string
    cwd: string
    prompt: string
    startedAt: number
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
    '--strict-config',
    '--skip-git-repo-check',
    '--json',
    '-o',
    o.out,
    '-m',
    o.model ?? BUILTIN_AGENTS.codex!.model,
    ...codexScopeArgs(o),
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
   * gated by folder trust; run() passes `--trust` only for an orch-created
   * disposable worktree and stores that grant in the run's GROK_HOME.
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
  const a: string[] = ['-m', o.model ?? BUILTIN_AGENTS.grok!.model]
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

export const BUILTIN_AGENTS: Record<string, Agent> = {
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
    caps: {
      readsRepo: true,
      mcp: true,
      discoversMcpFromCwd: false,
      schema: true,
      writesRepo: true,
      resumable: true,
    },
    defaultTransport: 'cli',
    acp: {
      mcpServers: true,
      mcpReason:
        'codex-acp 1.10.0 accepts session/new mcpServers, but the 2026-09-07 ask case returned prose without calling orch-ask',
      nativeElicitation: false,
      nativeElicitationReason:
        'codex-acp 1.10.0 answered the requested user question as prose and emitted no elicitation/create',
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
        } catch {
          /* a half-written line carries neither */
        }
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
        } catch {
          /* a half-written line is not a thread id */
        }
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
    // Project servers come from the worker tree's `.mcp.json`; the run-scoped
    // GROK_HOME disables entries the project's workerMcpServers does not own.
    // Dispatch preflights that clamped view and stores folder trust there too.
    //
    // writesRepo VERIFIED directly from a shell in a scratch git repo: with
    // `--permission-mode acceptEdits`, v1.0.13 created the requested uncommitted
    // 28-byte file containing exactly GROK_WRITE_PROOF_2026_09_02 plus newline,
    // and exited 0 in 13.38s.
    caps: {
      readsRepo: true,
      mcp: true,
      discoversMcpFromCwd: true,
      schema: true,
      writesRepo: true,
      resumable: true,
    },
    defaultTransport: 'cli',
    acp: {
      mcpServers: false,
      mcpReason:
        'grok 1.0.13 rejects session/new with an stdio mcpServers entry as "Path not found."; its per-run GROK_HOME fallback delivered the live orch-answer ruling in the 2026-09-07 parity run',
      nativeElicitation: false,
      nativeElicitationReason:
        'grok 1.0.13 reported ask_user_question unavailable and emitted no elicitation/create',
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
      let final: {
        usage?: Record<string, number>
        result?: unknown
        errors?: unknown
        stop_reason?: unknown
        total_cost_usd?: number | null
      } | null = null
      let stream = false
      let stopReason: string | null = null
      for (const line of stdout.split('\n')) {
        const s = line.trimStart()
        if (!s.startsWith('{')) continue
        try {
          const event = JSON.parse(s) as {
            type?: string
            subtype?: string
            message?: { stop_reason?: unknown }
            usage?: Record<string, number>
            result?: unknown
            errors?: unknown
            stop_reason?: unknown
            total_cost_usd?: number | null
          }
          if (event.type === 'system' && event.subtype === 'init') stream = true
          if (event.type === 'assistant' && event.message?.stop_reason) {
            stopReason = String(event.message.stop_reason)
          }
          if (event.type === 'result') final = event
        } catch {
          /* a partial line cannot be the terminal result */
        }
      }
      if (final) {
        const usage = final.usage
        const tokens = usage
          ? (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.output_tokens ?? 0)
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
          ...(errors.length
            ? { error: errors.join('\n') }
            : !text
              ? { error: 'grok result contained no final text' }
              : {}),
        }
      }
      if (stream) {
        return {
          text: '',
          tokens: null,
          costUsd: null,
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
      } catch {
        return rawReply(stdout)
      }
    },
  },
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
export function assertResumableAgent(name: string, a: Agent, requireExact: boolean): void {
  if (a.enabled === false || a.legacy) return
  const hasId = Boolean(a.mintSession ?? a.readSession)
  if (a.caps.resumable && !(a.resumeArgv && hasId)) {
    throw new Error(
      `agent "${name}" declares resumable but cannot be resumed: ` +
        `${a.resumeArgv ? '' : 'no resumeArgv; '}${hasId ? '' : 'no way to learn its session id'}`,
    )
  }
  if (requireExact && !a.caps.resumable && a.resumeArgv && hasId) {
    throw new Error(`agent "${name}" has everything needed to resume but declares resumable: false`)
  }
}
for (const [name, a] of Object.entries(BUILTIN_AGENTS)) assertResumableAgent(name, a, true)
