/**
 * What this is called, and the only place it is written.
 *
 * Borrowed wholesale from a sibling project's `brand.ts`, including the part that makes it
 * work: a brand module nobody is obliged to use collects leaked literals until
 * the rename it existed to make cheap is a hunt through twenty files. So
 * `check-brand` enforces that the name appears nowhere else in the tree.
 *
 * ## Why the name changed
 *
 * `devbox` described a scratch directory for one machine's odds and ends, which
 * is what this was. It is now a system with a specific shape: one designer
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
 * ## What must NOT be renamed
 *
 * Some strings contain a name and are not the brand. They are protocol — frozen
 * the moment something outside this repository depended on them:
 *
 * - **`orch` and `hub`**, the per-concern binaries. A concern's tool is named
 *   for the concern, not for the platform, and both are wired into shell PATH,
 *   muscle memory, and the deny message of a hook that runs in every session.
 * - **`ORCH_*` environment variables**, read from a developer's own shell and
 *   from launchd plists that this repo does not own.
 * - **`orch.db` and `hub.db`**, which are files on disk with history in them.
 * - **The MCP server name `orch-ask`**, registered inside codex's and grok's
 *   own configuration; renaming it there is a migration, not a substitution.
 *
 * Renaming one of those is a migration with a rollout, not a find-and-replace,
 * which is exactly why they are listed rather than left to judgement.
 */

/** The platform: the system, the repository, the thing all the concerns share. */
export const PLATFORM_NAME = 'Bottega'

/** Machine form: the directory, the package name, anything a path needs. */
export const PLATFORM_SLUG = 'bottega'

/**
 * One line on what it is, for a README or a `--help` header.
 *
 * Kept here rather than in each concern's own docs because a tagline repeated
 * in four places is a tagline that will disagree with itself within a month.
 */
export const PLATFORM_TAGLINE = 'One designer, many hands: delegate the building, keep the design.'

/**
 * The concerns, which are the reason this is a platform rather than a tool.
 *
 * Listed here because more than one thing needs to enumerate them — the
 * boundary check, the brand check, and anything that reports across them — and
 * three independent copies of this list is how a fifth concern comes to be
 * policed by none of them.
 */
export const CONCERNS = ['orchestrator', 'hub', 'ops', 'local-stack'] as const
export type Concern = (typeof CONCERNS)[number]
