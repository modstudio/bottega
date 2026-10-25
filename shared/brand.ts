/**
 * What this is called, and the only place it is written.
 *
 * Borrowed wholesale from a sibling project's `brand.ts`, including the part that makes it
 * work: a brand module nobody is obliged to use collects leaked literals until
 * the rename it existed to make cheap is a hunt through twenty files. So
 * `check-brand` enforces that the name appears nowhere else in the tree.
 *
 * ## Why this name
 *
 * This is a system with a specific shape: one designer
 * holding the whole picture, several hands building to that design, and nothing
 * shipping that the designer has not reviewed and signed.
 *
 * That is the Renaissance workshop, and the word for it is **bottega** —
 * Verrocchio's, where assistants executed to the master's drawing and the
 * master put their name to the result. The metaphor is not decoration: it is
 * the exact division this codebase enforces. A worker builds to a spec and
 * escalates every decision it was not given; the architect rules, reads the
 * diff, and judges it on whether it built what it was asked to build.
 *
 * The product has one executable, `bottega`.
 *
 * ## What must NOT be renamed
 *
 * Some strings contain a name and are not the brand. They are protocol — frozen
 * the moment something outside this repository depended on them:
 *
 * - **`BOTTEGA_*` environment variables** are the process protocol. Old
 *   environment names exist only as inputs to the operator setup migration.
 * - **`.orch-run`**, the persisted worktree ownership marker.
 * - **the orchestrator and hub databases**, which are files on disk with history in them.
 * Renaming one of those is a migration with a rollout, not a find-and-replace,
 * which is exactly why they are listed rather than left to judgment.
 */

/** The platform: the system, the repository, the thing all the concerns share. */
export const PLATFORM_NAME = 'Bottega'

/** Machine form: the directory, the package name, anything a path needs. */
export const PLATFORM_SLUG = 'bottega'

/** Stable MCP identities derived from the platform name. */
export const MCP_SERVER_NAME = PLATFORM_SLUG
export const WORKER_MCP_SERVER_NAME = `${PLATFORM_SLUG}-ask`
export const MCP_TOOL_PREFIX = `mcp__${PLATFORM_SLUG}__`

/** On-disk state names are protocol: changing one requires an operator migration. */
export const FROZEN_STATE_NAMES = {
  orchestratorDatabase: 'orchestrator.db',
  hubDatabase: 'hub.db',
  retrievalDatabase: 'retrieval.db',
  runsDirectory: 'runs',
} as const

/** Environment names are process protocol and share the brand's rename boundary. */
export const FROZEN_ENV_NAMES = {
  mainCheckout: 'BOTTEGA_MAIN_CHECKOUT',
  gateFacts: 'BOTTEGA_GATE_FACTS',
} as const

/**
 * The concerns, which are the reason this is a platform rather than a tool.
 *
 * Listed here because more than one thing needs to enumerate them — the
 * boundary check, the brand check, and anything that reports across them — and
 * three independent copies of this list is how a fifth concern comes to be
 * policed by none of them.
 */
export const CONCERNS = ['orchestrator', 'hub', 'ops', 'local-stack', 'retrieval', 'cli'] as const
