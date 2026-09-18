import { type Caps, MIGRATED_AGENT_NAMES } from '../agent/capabilities.ts'
import { DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS, idleKillMs } from '../idle-kill.ts'
import { STALE_AFTER_MS } from '../run/run-liveness.ts'

export type Job = {
  name: string
  what: string
  /** Capabilities an agent must have to be eligible at all. */
  needs: Partial<Caps>
  /** Order to try when history has nothing to say yet. */
  prefer: string[]
  /**
   * Roughly how much context this job's WORKING SET needs, in tokens.
   *
   * Not the prompt — the prompt is small for all of these. This is what
   * accumulates once the agent starts: every file it opens, every MCP document
   * it fetches, every tool result, all of it carried forward turn after turn.
   * An agent whose window cannot hold that is excluded, exactly the way one
   * lacking `readsRepo` is, because it is the same kind of fact.
   *
   * Measured, not guessed, from what these jobs actually consumed. It is a
   * threshold rather than a prediction, so the numbers are deliberately coarse:
   * the question is only ever "does this agent have room", and the two answers
   * observed so far are 64K-and-fails and no-ceiling-and-works.
   */
  contextTokens: number
  /** Maximum UTF-8 bytes of compiled operator canon injected into a first turn. */
  packBytes?: number
  /**
   * How long THIS job may take, overriding the agent's own bound.
   *
   * An agent's `timeoutMs` is set from its measured worst case on the jobs it
   * had — all of them read-only. Building is a different shape of work: a
   * fifteen-file change that then runs PHPStan and PHPUnit in Docker is
   * routinely longer than any review, and the twenty-minute bound killed one
   * that had already delivered its reply and was running the project's gates.
   *
   * Held below STALE_AFTER_MS, asserted in the suite, so a run always writes
   * its own terminal state rather than being swept out from under a process
   * still working. `timeoutCeilingMs` is the declared ceiling; the effective
   * ceiling is that number capped just below the stale cutoff.
   */
  timeoutMs?: number
  /** Declared ceiling for `orch do --timeout`, in ms, before the stale cap. */
  timeoutCeilingMs?: number
  /** This job returns independently triageable review findings. */
  findings?: boolean
  /** Harness-owned checkpoint cadence for writing work; defaults to ten minutes. */
  checkpointMinutes?: number
}

/**
 * Default and ceiling timeouts, in minutes. Help text, the worker's bound
 * sentence, and `orch do --timeout` all read from here.
 *
 * `defaultMinutes: null` means the selected agent's own bound, then the
 * ceiling. Every ceiling is still capped just below STALE_AFTER_MS; when that
 * cap wins, the `--timeout` refusal names the cutoff.
 */
/**
 * The CPU sample cannot observe waits outside the vendor tree at all — Docker,
 * an MCP server, local-stack, a lock, a remote API the vendor CLI is blocked
 * on. Silence-plus-CPU therefore does not protect an external wait, so the
 * default idle bound must be the longer one for every job. Every job can wait
 * on a tool, a subprocess, or a service the sample cannot see.
 */
/** Idle must sit below the wall so the two timers cannot race. */
export const IDLE_BELOW_WALL_MS = 60_000

export function jobDeclaredWallMs(name: string): number | null {
  const bounds = JOB_TIMEOUTS[name as keyof typeof JOB_TIMEOUTS]
  if (!bounds) return null
  if (bounds.defaultMinutes != null) return bounds.defaultMinutes * 60_000
  return bounds.ceilingMinutes * 60_000
}

export function clampIdleKillMs(idleMs: number, wallMs: number): number {
  if (!(wallMs > 0) || idleMs < wallMs) return idleMs
  const gap = wallMs > IDLE_BELOW_WALL_MS ? IDLE_BELOW_WALL_MS : 1
  return Math.max(0, wallMs - gap)
}

export function jobIdleKillMs(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  wallMs?: number,
): number {
  const raw =
    env.ORCH_IDLE_KILL_MS !== undefined && env.ORCH_IDLE_KILL_MS !== ''
      ? idleKillMs(env)
      : DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS
  const wall = wallMs ?? jobDeclaredWallMs(name)
  return wall != null ? clampIdleKillMs(raw, wall) : raw
}

export const JOB_TIMEOUTS = {
  implement: { defaultMinutes: 45, ceilingMinutes: 90 },
  'issue-worker': { defaultMinutes: 45, ceilingMinutes: 90 },
  fix: { defaultMinutes: 30, ceilingMinutes: 60 },
  diagnose: { defaultMinutes: 40, ceilingMinutes: 60 },
  understand: { defaultMinutes: 40, ceilingMinutes: 60 },
  'review-lens': { defaultMinutes: 30, ceilingMinutes: 45 },
  safety: { defaultMinutes: 30, ceilingMinutes: 45 },
  craft: { defaultMinutes: 30, ceilingMinutes: 45 },
  'file-question': { defaultMinutes: null, ceilingMinutes: 20 },
  'canon-lookup': { defaultMinutes: null, ceilingMinutes: 20 },
  summarize: { defaultMinutes: null, ceilingMinutes: 20 },
  'mcp-query': { defaultMinutes: null, ceilingMinutes: 20 },
  'verify-claim': { defaultMinutes: null, ceilingMinutes: 20 },
  'review-lens-inline': { defaultMinutes: null, ceilingMinutes: 20 },
} as const satisfies Record<string, { defaultMinutes: number | null; ceilingMinutes: number }>

/** Compact defaults/ceilings for `orch do --help`, derived from JOB_TIMEOUTS. */
export function jobTimeoutHelp(): string {
  return Object.entries(JOB_TIMEOUTS)
    .map(
      ([name, bounds]) =>
        `${name} ${bounds.defaultMinutes == null ? 'agent' : `${bounds.defaultMinutes}m`}/${bounds.ceilingMinutes}m`,
    )
    .join(', ')
}

export const READER_JOBS = ['diagnose', 'understand', 'file-question'] as const
export type ReaderJob = (typeof READER_JOBS)[number]

export function isReaderJob(name: string): name is ReaderJob {
  return (READER_JOBS as readonly string[]).includes(name)
}

/** Every repository tree is closed out at terminalisation unless an active `--keep-tree` hold exists. */
export function reclaimsTreeByDefault(name: string): boolean {
  const j = JOBS[name]
  return Boolean(j?.needs.readsRepo)
}

export function jobTimeoutCeilingMs(j: Job): number {
  const declared =
    j.timeoutCeilingMs ?? JOB_TIMEOUTS[j.name as keyof typeof JOB_TIMEOUTS].ceilingMinutes * 60_000
  return Math.min(declared, STALE_AFTER_MS - 1)
}

export function jobTimeoutCeilingMinutes(j: Job): number {
  return Math.floor(jobTimeoutCeilingMs(j) / 60_000)
}

export function timeoutCeilingRefusal(j: Job, requestedMinutes: number): string {
  const declared = Math.round((j.timeoutCeilingMs ?? jobTimeoutCeilingMs(j)) / 60_000)
  const effective = jobTimeoutCeilingMinutes(j)
  const staleMinutes = Math.round(STALE_AFTER_MS / 60_000)
  if (effective < declared) {
    return (
      `${j.name} timeout ceiling is ${effective} minutes ` +
      `(stale cutoff ${staleMinutes}m wins over the job's ${declared}m ceiling); ` +
      `got --timeout ${requestedMinutes}`
    )
  }
  return `${j.name} timeout ceiling is ${effective} minutes; got --timeout ${requestedMinutes}`
}

/**
 * Resolve the wall bound for a run. `overrideMinutes` is `orch do --timeout`.
 * Throws if the override is not a positive integer or exceeds the ceiling.
 */
export function resolveJobTimeoutMs(
  j: Job,
  agentTimeoutMs: number,
  overrideMinutes?: number,
): number {
  const ceiling = jobTimeoutCeilingMs(j)
  if (overrideMinutes !== undefined) {
    if (!Number.isInteger(overrideMinutes) || overrideMinutes < 1) {
      throw new Error(
        `--timeout must be a positive integer number of minutes; got ${overrideMinutes}`,
      )
    }
    const requested = overrideMinutes * 60_000
    if (requested > ceiling) throw new Error(timeoutCeilingRefusal(j, overrideMinutes))
    return requested
  }
  return Math.min(j.timeoutMs ?? agentTimeoutMs, ceiling)
}

/** One sentence naming this job's bound and where to write long tables. */
export function jobBoundInstruction(j: Job, boundMs: number): string {
  const minutes = Math.round(boundMs / 60_000)
  return (
    `This job's bound is ${minutes} minutes. When a step is long, write tables ` +
    `incrementally to a named file under $ORCH_SCRATCH rather than holding them only in the final reply.`
  )
}

export function jobBoundInstructionForContract(j: Job): string {
  const defaults = JOB_TIMEOUTS[j.name as keyof typeof JOB_TIMEOUTS]
  const bound =
    defaults?.defaultMinutes != null
      ? `${defaults.defaultMinutes} minutes`
      : `the selected agent's bound, capped at ${jobTimeoutCeilingMinutes(j)} minutes`
  return (
    `This job's bound is ${bound}. When a step is long, write tables ` +
    `incrementally to a named file under $ORCH_SCRATCH rather than holding them only in the final reply.`
  )
}

export { DEFAULT_PACK_BYTES } from '../canon/pack-budget.ts'

import { DEFAULT_PACK_BYTES } from '../canon/pack-budget.ts'

/**
 * A short bounded errand: one question, a handful of files, an answer.
 * Measured: file-question on the 64K local model runs in 8 seconds and 25k
 * cumulative tokens, and is judged `right`.
 */
const ERRAND = 32_768

/**
 * A long agentic loop: read widely, fetch canon, hold it all, then judge.
 * Measured on the 64K local model: review-lens burned 300-590k cumulative
 * tokens across its turns and was never once judged `right` in four attempts —
 * three `mixed` and one that returned nothing at all. `understand` did not even
 * get that far, failing outright on a 400 naming the window. The cloud agents
 * do the same jobs without a single context failure in eighty-odd runs.
 */
const DEEP = 131_072

export const JOBS: Record<string, Job> = {
  'file-question': {
    name: 'file-question',
    what: 'Answer a question about files in this repo, citing paths and lines.',
    needs: { readsRepo: true },
    prefer: ['qwen36-goose', 'codex', 'grok'],
    contextTokens: ERRAND,
  },
  understand: {
    name: 'understand',
    what: 'Survey existing code, services and reusable patterns around a change.',
    needs: { readsRepo: true },
    prefer: ['grok', 'codex'],
    contextTokens: DEEP,
  },
  diagnose: {
    name: 'diagnose',
    what: 'Investigate what is actually true before a spec exists. Correlate repository, database, and process evidence without changing anything.',
    needs: { readsRepo: true },
    prefer: ['codex', 'grok'],
    contextTokens: DEEP,
  },
  'issue-worker': {
    name: 'issue-worker',
    what: 'Fix one independently diagnosed filed issue and return measured, structured evidence.',
    needs: { readsRepo: true, writesRepo: true, resumable: true },
    prefer: ['codex'],
    contextTokens: DEEP,
  },
  'review-lens': {
    name: 'review-lens',
    what: 'Review a change through one named dimension, under a fixed return contract.',
    /**
     * Thirty minutes, because a lens EXECUTES now.
     *
     * codex's own bound is twenty, measured when a lens read source and
     * reasoned. Since registered projects grant their toolchain, a lens runs
     * the suite in Docker instead — and the numbers moved with it: four lenses
     * that completed took 5 to 9 minutes running only the changed test files,
     * and the dead-code lens was killed at twenty with a gate script still
     * going seven minutes in. A lens running a wider slice does not fit.
     *
     * Matched to `fix` rather than to `implement`: a review is bounded work on
     * a known diff, not an open-ended build. The number is the reporting
     * session's, from its own measurements, not my estimate. Defaults and
     * ceilings live in JOB_TIMEOUTS.
     */
    // A pack NAMES its sources rather than quoting them — quoting would mean the
    // orchestrator read them, which is the cost delegation exists to avoid. So a
    // lens must be able to open what the pack points at.
    needs: { readsRepo: true },
    prefer: ['grok', 'codex'],
    contextTokens: DEEP,
    findings: true,
  },
  'review-lens-inline': {
    name: 'review-lens-inline',
    what: 'Review a fully self-contained pack. Everything needed is in the prompt; nothing is fetched.',
    // False is stronger than absence: this job is not merely able to work
    // without a repository, its self-contained contract forbids being handed
    // one. run() turns this declaration into an empty working directory.
    needs: { readsRepo: false },
    prefer: ['agy', 'grok', 'codex'],
    contextTokens: ERRAND,
    findings: true,
  },
  safety: {
    name: 'safety',
    what: 'Check tenancy, PII, payments, idempotency and agent boundaries.',
    needs: { readsRepo: true },
    prefer: ['codex'],
    contextTokens: DEEP,
    findings: true,
  },
  craft: {
    name: 'craft',
    what: 'Check architecture, domain modelling, tests, comments and naming.',
    needs: { readsRepo: true },
    prefer: ['grok', 'codex'],
    contextTokens: DEEP,
    findings: true,
  },
  'verify-claim': {
    name: 'verify-claim',
    what: 'Check one specific claim against the code and report true, false or undecidable.',
    needs: { readsRepo: true },
    prefer: ['codex', 'grok'],
    contextTokens: ERRAND,
  },
  'canon-lookup': {
    name: 'canon-lookup',
    what: 'Report what the canon states about a topic, quoting the governing file.',
    needs: { readsRepo: true },
    prefer: ['qwen36-goose', 'codex', 'grok'],
    contextTokens: ERRAND,
  },
  summarize: {
    name: 'summarize',
    what: 'Condense supplied text. Context is inline; no repo access needed.',
    needs: { readsRepo: false },
    prefer: ['qwen36-goose', 'agy'],
    contextTokens: ERRAND,
  },
  /**
   * The first job here that CHANGES something, and the reason the escalation
   * contract exists.
   *
   * Fanning out implementation is the thing every practitioner account warns
   * about: parallel workers make conflicting IMPLICIT decisions and the results
   * do not merge. Cognition's write-up is the clearest statement of it, and
   * Anthropic's own multi-agent post — 90.2% over single-agent on breadth
   * research — still names most coding tasks as the case for one thread.
   *
   * The word doing the work in that objection is *implicit*. A worker that must
   * stop and ask when it hits a design decision converts an implicit decision
   * into an explicit one and routes it to the single place holding the whole
   * picture. So the shape that is safe here is not "many agents implementing",
   * it is "one agent implementing one bounded spec, escalating every judgement
   * call to the architect". That is what `needs.resumable` encodes: an agent
   * that cannot be resumed cannot be asked to escalate, because starting over
   * would cost more than guessing, and a channel that costs more than guessing
   * does not get used.
   */
  implement: {
    name: 'implement',
    what: 'Implement a bounded spec in a throwaway worktree. Escalate every design decision; never guess.',
    needs: { readsRepo: true, writesRepo: true, resumable: true },
    prefer: ['codex'],
    contextTokens: DEEP,
    // Measured against a real one: fifteen files, then PHPStan and PHPUnit in
    // Docker. Twenty minutes killed it after it had finished. Bound in JOB_TIMEOUTS.
  },
  /**
   * A narrow, already-diagnosed change: the fault is known and the fix is
   * agreed. Separate from `implement` because it is a different question to an
   * agent — no design latitude at all — and because keeping them apart is what
   * lets the router learn that an agent good at one is not automatically good
   * at the other. Merging them would average two different skills into one cell.
   */
  fix: {
    name: 'fix',
    what: 'Apply one specific, already-diagnosed change. No design latitude.',
    needs: { readsRepo: true, writesRepo: true, resumable: true },
    prefer: ['codex'],
    contextTokens: ERRAND,
    // Narrower than `implement` by design, but still a build-and-verify cycle.
    // Bound in JOB_TIMEOUTS.
  },
  'mcp-query': {
    name: 'mcp-query',
    what: 'Answer using this machine’s MCP servers (tracker, docs store, database).',
    needs: { readsRepo: false, mcp: true },
    prefer: ['codex', 'grok'],
    contextTokens: DEEP,
  },
}

/**
 * Every name in a `prefer` list must be a real agent.
 *
 * `pick()` skips a name it cannot find, so a stale entry degrades routing in
 * silence: when the local agent was renamed codex-local -> qwen-local, four
 * jobs kept preferring a name that no longer existed and quietly fell through
 * to their second choice. The local model became unreachable by preference and
 * nothing said so. Checked at import, because a dangling name is a typo and
 * should fail like one.
 */
for (const [jobName, j] of Object.entries(JOBS)) {
  j.packBytes ??= DEFAULT_PACK_BYTES
  const timeouts = JOB_TIMEOUTS[jobName as keyof typeof JOB_TIMEOUTS]
  if (!timeouts) {
    throw new Error(`job "${jobName}" is missing from JOB_TIMEOUTS`)
  }
  j.timeoutMs = timeouts.defaultMinutes == null ? undefined : timeouts.defaultMinutes * 60_000
  j.timeoutCeilingMs = timeouts.ceilingMinutes * 60_000
  for (const agent of j.prefer) {
    if (!(MIGRATED_AGENT_NAMES as readonly string[]).includes(agent)) {
      throw new Error(
        `job "${jobName}" prefers unknown agent "${agent}" - ` +
          `known agents: ${MIGRATED_AGENT_NAMES.join(', ')}`,
      )
    }
  }
}

export function job(name: string): Job {
  const j = JOBS[name]
  if (!j) {
    throw new Error(`unknown job "${name}". Known: ${Object.keys(JOBS).join(', ')}`)
  }
  return j
}
