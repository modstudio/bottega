// concern: project-settings
/** Owns the project settings shape. Must not know stores, SQL, or HTTP. */

import type { RepositoryVisibility } from '../../../shared/repository-visibility.ts'
import type { TrackerSettings } from '../../../shared/trackers.ts'
import type { MechanicalCheckEntry } from '../enforcement/mechanical-check-declaration.ts'
import type { FocusedTestDeclaration } from '../focused-test/focused-test-decision.ts'
import type { GateInput } from '../gate/gate-decision.ts'
import type { Recipe } from '../recipe/recipe.ts'
import type { AutonomySettings, StoredAutonomySettings } from '../workflow/autonomy.ts'
import type { ReadonlyProvision } from '../worktree/worktree-provision.ts'
import type { WorktreeCreate } from '../worktree/worktree-template.ts'
import type { ProjectAgentKeys } from './project-agent-keys.ts'
import type {
  DocsSettings,
  ReferenceSettings,
  ReleaseSettings,
  ReviewSettings,
  SignalsSettings,
  TestSubstanceSettings,
} from './project-injection.ts'

export type MainStackConsumer = 'gate' | 'mcp' | 'worktree-create'

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
   * directory has already gone. Run by `bottega machine sweep`, because the expensive
   * leak is not the directory: it is the database still sitting behind it.
   */
  sweep?: string
  /** Declares that sweep skips every path listed in BOTTEGA_HELD_WORKTREES. */
  sweep_honors_held?: boolean
  /**
   * What a branch is allowed to be called here.
   *
   * `orch/<id>` is fine where nothing enforces a convention, and REJECTED where
   * something does: one project's tool answered "branch 'orch/646' does not match the
   * dev-processes format {type}/{KEY}-{slug}" and refused to make the worktree
   * at all. That is the project being right — its branch names carry a ticket
   * key that its own tooling reads — and orchestrator imposing a name of its own is
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
   * orchestrator therefore refuses to guess: a project listing seeds must be given one.
   * The list is not an allowlist. `--seed` may carry any project-specific spec;
   * where the project exposes `scripts/worktree resolve`, that tool decides
   * whether the spec is valid before orchestrator creates anything.
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
  /** Project-owned sealed secrets that replace matching metered agent secrets for this project's runs. */
  agentKeys?: ProjectAgentKeys
  /** Repository visibility established against the forge when declared. */
  visibility?: RepositoryVisibility
  /** Canonical owner/name whose visibility was verified at declaration time. */
  visibilityRepository?: string
  /** Main-checkout stack consumers that require start-on-demand. */
  mainStack?: {
    consumers: MainStackConsumer[]
    requiredServices?: string[]
    /**
     * Compose project-name prefix used by this project's served worktree stacks.
     *
     * A served worktree stack is one Bottega did not start and holds no record of —
     * a worktree serving compose from the main checkout records that checkout as its
     * working directory — so the only way to see it is the name Compose gives its
     * containers. It is matched as a literal prefix and must end in `_` or `-`,
     * because a prefix without a separator also matches this project's own main-stack
     * Compose project and would then hold the shared stack forever. That own name is
     * not declarable here: Compose derives it from the checkout and its Compose files,
     * so settings cannot refuse a collision and the separator rule stands in its place.
     */
    worktreeComposeProjectPrefix?: string
  }
  /** Local opt-ins for semantic search corpora. */
  search?: { code?: boolean }
  autonomy?: AutonomySettings
  /** Whether Bottega manages and validates this project's hydrated canon context. */
  managedContext?: boolean
  /** Standing task key used by the scheduled repository canon mirror. */
  canonMirrorKey?: string
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
  /** A cheap probe tool and per-server tool names reading jobs may call through the MCP proxy. */
  mcp?: { probe_tool?: string; reader_tools?: Record<string, string[]> }
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
  /** Git state consumed by the gate. Absent keeps existing registrations compatible. */
  gateInput?: GateInput
  /** Fixed executable and argv prefix for writer-requested project-relative test paths. */
  focusedTests?: FocusedTestDeclaration
  /** Ordered promotion and remote-admission facts after the landing branch merges. */
  release?: ReleaseSettings
  /** Where shared workflows read and write this project's docs and canon. */
  docs?: DocsSettings
  /** Generated repository reference and the command that publishes it after a relevant merge. */
  reference?: ReferenceSettings
  /** Where shared workflows list and read this project's open signals. */
  signals?: SignalsSettings
  /** Catalogue lenses selected by tier and changed path for this project. */
  review?: ReviewSettings
  /** PHP policy rules enforced in addition to the universal test-substance rules. */
  testSubstance?: TestSubstanceSettings
  /** Mechanical checks this project overrides or explicitly opts out of. */
  mechanicalChecks?: Record<string, MechanicalCheckEntry>
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
   * Which is exactly what orchestrator was doing. Cutting a worktree with plain git in
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

export type StoredProjectSettings = Omit<ProjectSettings, 'autonomy'> & {
  autonomy?: StoredAutonomySettings
}
