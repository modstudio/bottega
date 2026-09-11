// concern: capabilities
/** Knows the capability vocabulary and seeded registry names. Must import nothing. */

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

/** Names seeded by the registry migration and therefore valid in job preferences. */
export const MIGRATED_AGENT_NAMES = ['agy', 'codex', 'grok', 'qwen-local', 'local-acp'] as const
