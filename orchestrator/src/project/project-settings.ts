// concern: project-settings
/** Owns the project settings shape. Must not know stores, SQL, or HTTP. */

import type { TrackerSettings } from '../../../shared/trackers.ts'
import type { Recipe } from '../recipe/recipe.ts'
import type { AutonomySettings } from '../workflow/autonomy.ts'
import type { ReadonlyProvision } from '../worktree/worktree-provision.ts'
import type { WorktreeCreate } from '../worktree/worktree-template.ts'
import type { DocsSettings, ReleaseSettings } from './project-injection.ts'

/** A project's own worktree lifecycle, as declared commands. */
export type WorktreeTool = {
  /** Whether this project's create command can check out a requested base detached. */
  detached?: boolean
  /**
   * Creates and fully provisions one. Must print the created path.
   *
   * OPTIONAL, because a project need not have one. Declare `recipe` instead and
   * bottega builds the worktree itself from the declaration — which is the
   * whole point of a project being able to adopt this rather than write its
   * fourth several-hundred-line worktree script.
   */
  create?: WorktreeCreate
  /**
   * Optionally provisions a detached shared clone that borrows the main
   * checkout's object store.
   *
   * It receives exactly `{path}` and `{base}`. It must not change task state.
   * When absent, read-only runs use a plain detached shared clone and no
   * project infrastructure.
   */
  readonly_create?: WorktreeCreate
  readonly_provision?: ReadonlyProvision
  /** What a read-only worker is told this project's detached tree can and cannot run. */
  readonly_notes?: string
  /**
   * Read-only trees of this project may reach the Docker socket because the
   * project's checks run inside its containers; the worker is told to run the
   * project's gate and no other Docker verb.
   */
  readonly_docker?: boolean
  /** Optional teardown for readonly_create trees. Receives `{path}` only. */
  readonly_remove?: string
  /**
   * What this project's worktree NEEDS, for bottega to provide it.
   *
   * The alternative to `create`, and the one a new project should reach for.
   * See recipe.ts: base ref, install, env template, database provider, migrate,
   * serve/stop. Every step optional; an empty recipe is plain git, which is
   * correct where a checkout is just files.
   */
  recipe?: Recipe
  /** Relative pointer to the project's tracked recipe; the file is not executable configuration. */
  recipePath?: string
  /** Tears one down, including whatever it provisioned. Optional beside `recipe`. */
  remove?: string
  /**
   * Reclaims orphans — containers, databases, metadata — for worktrees whose
   * directory has already gone. Run by `orch sweep`, because the expensive
   * leak is not the directory: it is the database still sitting behind it.
   */
  sweep?: string
  /**
   * What a branch is allowed to be called here.
   *
   * `orch/<id>` is fine where nothing enforces a convention, and REJECTED where
   * something does: one project's tool answered "branch 'orch/646' does not match the
   * dev-processes format {type}/{KEY}-{slug}" and refused to make the worktree
   * at all. That is the project being right — its branch names carry a ticket
   * key that its own tooling reads — and orch imposing a name of its own is
   * exactly the mistake that delegating the lifecycle was meant to stop.
   *
   * Placeholders: `{id}` the run id and `{key}` a ticket key when the architect
   * supplied one with `--key`.
   * A template naming `{key}` makes that flag required, because inventing a
   * ticket number would be worse than refusing.
   */
  branch?: string
  /** Pattern accepted for a ticket key supplied with `--key`. */
  keyPattern?: string
  /**
   * Common database seed specs, as this project spells them.
   *
   * one application requires the choice with no default, having learned that the
   * default it used to take was silent and left every business table empty.
   * orch therefore refuses to guess: a project listing seeds must be given one.
   * The list is not an allowlist. `--seed` may carry any project-specific spec;
   * where the project exposes `scripts/worktree resolve`, that tool decides
   * whether the spec is valid before orch creates anything.
   */
  seeds?: string[]
  /**
   * What the WORKER is told about the infrastructure it has been handed.
   *
   * A worker that does not know it can serve its own branch on its own port
   * will verify against whatever is already running, which is a different
   * branch's bundle — and that does not fail, it PASSES against the wrong tree.
   * Prose, verbatim into the prompt, because only the project knows it.
   */
  notes?: string
}

export type ProjectSettings = {
  autonomy?: AutonomySettings
  /** Whether Bottega manages and validates this project's hydrated canon context. */
  managedContext?: boolean
  /** Optional repository checks. Absent and false both leave a check disabled. */
  checks?: {
    spelling?: boolean
    attribution?: boolean
    commentTaskKeys?: boolean
    commentHistory?: boolean | { phrases: string[] }
  }
  /** Record space slug that owns this project's hosted evidence. */
  space?: string
  /**
   * Paths a read-only worker must not read. Absolute paths are used as-is,
   * `~` expands to the operator home, and relative paths resolve from this
   * project's registered main checkout (never from a disposable worktree).
   */
  secretPaths?: string[]
  /** Ticket-key prefixes whose committed tasks count as this project's shipped work. */
  keyPrefixes?: string[]
  /** MCP server this project's agents attach to. Defaults to the project name. */
  mcpServer?: string
  /**
   * Servers in this checkout's `.mcp.json` its workers may start. A checkout
   * can also list other projects' servers, as bottega's does.
   */
  workerMcpServers?: string[]
  /** A cheap plain-named read tool used to prove the MCP attachment. */
  mcp?: { probe_tool?: string }
  /** How this project's task tracker is reached and how its vocabulary maps. */
  tracker?: TrackerSettings
  /**
   * How this tracker's task states map onto the vocabulary used here.
   *
   * The trackers genuinely disagree — one speaks
   * `backlog|unstarted|started|completed|canceled`, another
   * `backlog|todo|in_progress|in_review|done` — and a report that treats those
   * as one vocabulary silently miscounts what is in flight. Written per project
   * because it is a fact about that tracker, not about this tool.
   */
  states?: Record<string, 'backlog' | 'open' | 'active' | 'review' | 'done' | 'dropped'>
  /** What the trunk is called here. Several of these are `develop`, not `main`. */
  trunk?: string
  /** Branch production deploys from when it is distinct from the landing branch. */
  productionBranch?: string
  /** The project's complete landing gate, run from the branch worktree. */
  gate?: string
  /** Ordered promotion and remote-admission facts after the landing branch merges. */
  release?: ReleaseSettings
  /** Where shared workflows read and write this project's docs and canon. */
  docs?: DocsSettings
  /**
   * Whether dispatch refuses tracked modifications in this project's main
   * checkout. Default ON: absent and true both enforce it. A project opts out
   * with `{"requireCleanMain": false}`, the same settings blob it uses for
   * every other concern it keeps for itself.
   */
  requireCleanMain?: boolean
  /** Display color, for anything that draws a project. */
  color?: string
  /** Display color used on dark surfaces. */
  colorDark?: string
  /** Prefix used for project-scoped environment variables. */
  envPrefix?: string
  /**
   * How THIS project makes a worktree, and how it takes one down.
   *
   * Declared per project because a worktree is not a git concept here. In
   * two Laravel apps a checkout is an application: it needs a generated
   * `.env`, a cloned vendor directory, its own database at a chosen size, its
   * own port and its own queue worker. Their own `scripts/worktree` sets all of
   * that up, and says plainly what happens without it — "a bare `git worktree
   * add` leaves no .env and no vendor, so compose interpolates to nothing and
   * not one quality gate can run in the result".
   *
   * Which is exactly what orch was doing. Cutting a worktree with plain git in
   * one of those repositories produces a directory that LOOKS right, and in
   * which every test a worker runs is meaningless. That failure is silent and
   * arrives as a confident green.
   *
   * So a project that owns a worktree tool keeps ownership of it and orch
   * shells out. A project that declares none gets the built-in git worktree,
   * which is correct for a repo where a checkout is just files — this one, for
   * instance.
   */
  worktree?: WorktreeTool
}
