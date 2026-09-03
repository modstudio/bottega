import { AGENTS, type Caps } from './agents.ts'

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
   * still working.
   */
  timeoutMs?: number
}

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
    prefer: ['qwen-local', 'codex', 'grok'],
    contextTokens: ERRAND,
  },
  understand: {
    name: 'understand',
    what: 'Survey existing code, services and reusable patterns around a change.',
    needs: { readsRepo: true },
    prefer: ['grok', 'codex'],
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
     * session's, from its own measurements, not my estimate.
     */
    timeoutMs: 30 * 60_000,
    // A pack NAMES its sources rather than quoting them — quoting would mean the
    // orchestrator read them, which is the cost delegation exists to avoid. So a
    // lens must be able to open what the pack points at.
    needs: { readsRepo: true },
    prefer: ['grok', 'codex'],
    contextTokens: DEEP,
  },
  'review-lens-inline': {
    name: 'review-lens-inline',
    what: 'Review a fully self-contained pack. Everything needed is in the prompt; nothing is fetched.',
    needs: {},
    prefer: ['agy', 'grok', 'codex'],
    contextTokens: ERRAND,
  },
  safety: {
    name: 'safety',
    what: 'Check tenancy, PII, payments, idempotency and agent boundaries.',
    needs: { readsRepo: true },
    prefer: ['codex'],
    contextTokens: DEEP,
  },
  craft: {
    name: 'craft',
    what: 'Check architecture, domain modelling, tests, comments and naming.',
    needs: { readsRepo: true },
    prefer: ['grok', 'codex'],
    contextTokens: DEEP,
  },
  'verify-claim': {
    name: 'verify-claim',
    what: 'Check one specific claim against the code and report true, false or undecidable.',
    needs: { readsRepo: true },
    prefer: ['codex', 'grok', 'qwen-local'],
    contextTokens: ERRAND,
  },
  'canon-lookup': {
    name: 'canon-lookup',
    what: 'Report what the canon states about a topic, quoting the governing file.',
    needs: { readsRepo: true },
    prefer: ['qwen-local', 'codex', 'grok'],
    contextTokens: ERRAND,
  },
  summarize: {
    name: 'summarize',
    what: 'Condense supplied text. Context is inline; no repo access needed.',
    needs: {},
    prefer: ['qwen-local', 'agy'],
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
    // Docker. Twenty minutes killed it after it had finished.
    timeoutMs: 45 * 60_000,
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
    timeoutMs: 30 * 60_000,
  },
  'mcp-query': {
    name: 'mcp-query',
    what: 'Answer using this machine’s MCP servers (tracker, docs store, database).',
    needs: { mcp: true },
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
  for (const agent of j.prefer) {
    if (!(agent in AGENTS)) {
      throw new Error(
        `job "${jobName}" prefers unknown agent "${agent}" - ` +
        `known agents: ${Object.keys(AGENTS).join(', ')}`,
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
