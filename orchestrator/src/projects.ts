/**
 * The projects this machine works on, as DATA rather than as code.
 *
 * Everything here used to know four repository names and one person's home
 * directory. `repoOf` matched `/Users/<someone>/Projects/<name>`; the canon
 * list was an array literal; the trackers each had their status vocabulary
 * written into a switch. None of that is wrong for one machine, and all of it
 * makes the tool unusable by anyone else — you cannot adopt a router whose
 * notion of "a project" is somebody else's filesystem.
 *
 * So a project is a row: where it lives, what it is built out of, and how its
 * tracker's vocabulary maps onto the one used here. The code knows the SHAPE of
 * a project and none of the instances.
 *
 * THE STACK IS THE INTERESTING COLUMN, and it is why this is not merely
 * tidying. Agents are not uniformly good: one may be strong on PHP and weak on
 * a Vue component, and a router keyed only on job type averages those together
 * and reports a number that is true of neither. Keying on stack lets the
 * difference show — and stack rather than project because two Laravel apps
 * share evidence where two arbitrary repos do not. Here that is immediate:
 * two Laravel apps are the same stack, so a verdict from one is real
 * evidence about the other.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  gitToplevel,
  inspectCheckout,
  inspectionGitEnv,
  resolvedPathsEqual,
  type SequenceKind,
  type SequenceState,
} from '../../shared/git.ts'
import { db, nowIso, writableDb, writeTransaction } from './db.ts'
import { type ReadonlyProvision, validateReadonlyProvision } from './readonly-provision.ts'
import { loadTrackedRecipe, recipePointerErrors } from './recipe-loader.ts'
import { DEFAULT_PROJECT_CONFIG_PATH, resolveWorktreeLifecycle } from './worktree-lifecycle.ts'
import {
  CREATE_VARS,
  createHasPlaceholder,
  placeholders,
  validateCreate,
  type WorktreeCreate,
} from './worktree-template.ts'

export { migrateCreate, type WorktreeCreate, type WorktreeCreateArg } from './worktree-template.ts'

export type Project = {
  id: number
  /** What it is called. Matches the directory name by default, not necessarily. */
  name: string
  /** Absolute path to its main checkout. */
  path: string
  /**
   * What it is built out of, as a coarse label like `php-laravel-vue`.
   *
   * Deliberately coarse and deliberately shared. Its whole job is to be the
   * same string for two projects that an agent would find similar, so evidence
   * pools; a precise per-project label would be a project id with extra steps.
   */
  stack: string | null
  /** Whether work here counts toward the canon denominator in the ratio. */
  canon: boolean
  /** ISO timestamp when the row was retired; null while the project is live. */
  retiredAt: string | null
  /**
   * Per-project settings, as JSON.
   *
   * A blob rather than columns because what a project needs to declare is not
   * knowable in advance — a tracker's status vocabulary, a display colour, the
   * branch its trunk is called — and every one of those added as a column would
   * be another thing the code has to know about. The shapes that ARE relied on
   * are named in `ProjectSettings`, so the reliance is at least written down.
   */
  settings: ProjectSettings
}
export type ProjectSettings = {
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
  /**
   * Whether dispatch refuses tracked modifications in this project's main
   * checkout. Default ON: absent and true both enforce it. A project opts out
   * with `{"requireCleanMain": false}`, the same settings blob it uses for
   * every other concern it keeps for itself.
   */
  requireCleanMain?: boolean
  /** Display colour, for anything that draws a project. */
  color?: string
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
  [k: string]: unknown
}

export function resolveBranchRef(value: string): { branch: string; runId: number | null } {
  if (!/^\d+$/.test(value)) return { branch: value, runId: null }
  const runId = Number(value)
  const row = db().query('SELECT branch FROM run WHERE id=?').get(runId) as {
    branch: string | null
  } | null
  if (!row) throw new Error(`no run ${runId}`)
  if (!row.branch) throw new Error(`run ${runId} has no branch and cannot be landed`)
  return { branch: row.branch, runId }
}

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
   * Optionally provisions a read-only checkout at a detached HEAD.
   *
   * It receives exactly `{path}` and `{base}`. It must not change task state.
   * When absent, read-only runs use a plain detached git worktree and no
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
  recipe?: import('./recipe.ts').Recipe
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
   * Placeholders: `{id}` the run id, `{key}` a ticket key when the architect
   * supplied one with `--key`. A template naming `{key}` makes that flag
   * required, because inventing a ticket number would be worse than refusing.
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

/** Apply the repository-local default without persisting derived config into the register. */
export function resolvedWorktreeTool(
  project: Pick<Project, 'path' | 'settings'> | null | undefined,
  fileExists: (path: string) => boolean = existsSync,
): WorktreeTool | null {
  if (!project) return null
  const declared = project.settings.worktree
  let resolution = resolveWorktreeLifecycle(declared)
  if (resolution.form === 'none') {
    resolution = resolveWorktreeLifecycle(
      declared,
      fileExists(resolve(project.path, DEFAULT_PROJECT_CONFIG_PATH)),
    )
  }
  if (resolution.form === 'tracked-recipe' && resolution.source === 'default') {
    return { ...declared, recipePath: resolution.recipePath }
  }
  return declared ?? null
}

function parse(row: {
  id: number
  name: string
  path: string
  stack: string | null
  canon: number
  settings: string | null
  retired_at?: string | null
}): Project {
  let settings: ProjectSettings = {}
  try {
    settings = row.settings ? JSON.parse(row.settings) : {}
  } catch {
    // Unreadable settings must not take the project out of the register: a
    // typo in one JSON blob would otherwise make a whole repo invisible to
    // routing and reporting at once.
    settings = {}
  }
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    stack: row.stack,
    canon: row.canon === 1,
    retiredAt: row.retired_at ?? null,
    settings,
  }
}

export function projects(opts?: { retired?: boolean }): Project[] {
  const sql = opts?.retired
    ? 'SELECT * FROM project WHERE retired_at IS NOT NULL ORDER BY name'
    : 'SELECT * FROM project WHERE retired_at IS NULL ORDER BY name'
  return (db().query(sql).all() as Parameters<typeof parse>[0][]).map(parse)
}

function projectRowByName(name: string): Project | null {
  const r = db().query('SELECT * FROM project WHERE name = ?').get(name) as
    | Parameters<typeof parse>[0]
    | null
  return r ? parse(r) : null
}

export function projectByName(name: string): Project | null {
  const project = projectRowByName(name)
  return project?.retiredAt ? null : project
}

export function retiredProjectByName(name: string): Project | null {
  const project = projectRowByName(name)
  return project?.retiredAt ? project : null
}

/** Dispatching into a retired project names the undo, not emptiness. */
export function retiredProjectRefusal(name: string): string {
  return `project ${name} is retired; cleared by: orch project retire ${name} --undo`
}

export function retiredProjectAt(cwd: string): Project | null {
  let best: Project | null = null
  for (const p of projects({ retired: true })) {
    if (cwd === p.path || cwd.startsWith(`${p.path}/`)) {
      if (!best || p.path.length > best.path.length) best = p
    }
  }
  return best
}

/**
 * Which project a directory belongs to.
 *
 * LONGEST PATH WINS, which is what makes worktrees work. A worktree lives at
 * `<repo>/.claude/worktrees/orch-123`, so it is inside its project's path and
 * resolves correctly with no special case — and if one project were ever nested
 * inside another, the inner one is the right answer.
 *
 * Returns null for anywhere unregistered rather than guessing from the path
 * shape. Guessing is what the old `/Users/<someone>/Projects/<name>` regex did,
 * and its failure mode was silent: an unrecognised layout produced `null` that
 * read as "no project" rather than as "this tool has never been told about your
 * machine".
 */
export function projectAt(cwd: string): Project | null {
  let best: Project | null = null
  for (const p of projects()) {
    if (cwd === p.path || cwd.startsWith(`${p.path}/`)) {
      if (!best || p.path.length > best.path.length) best = p
    }
  }
  return best
}

/** The stack a directory's work is in, for routing. */
export function stackAt(cwd: string): string | null {
  return projectAt(cwd)?.stack ?? null
}

export function upsertProject(p: {
  name: string
  path: string
  stack?: string | null
  canon?: boolean
  settings?: ProjectSettings
}): void {
  writableDb()
  db()
    .query(
      `INSERT INTO project (name, path, stack, canon, settings, retired_at) VALUES (?,?,?,?,?,NULL)
     ON CONFLICT(name) DO UPDATE SET path=excluded.path, stack=excluded.stack,
                                     canon=excluded.canon, settings=excluded.settings,
                                     retired_at=NULL`,
    )
    .run(
      p.name,
      p.path.replace(/\/$/, ''),
      p.stack ?? null,
      p.canon ? 1 : 0,
      JSON.stringify(p.settings ?? {}),
    )
}

/** Rename the referent and refresh every deprecated one-release name mirror atomically. */
export function renameProject(currentName: string, nextName: string): void {
  writableDb()
  if (!nextName.trim()) throw new Error('project --name must be non-empty')
  const current = projectByName(currentName)
  if (!current) throw new Error(`no project "${currentName}"`)
  if (currentName !== nextName && projectByName(nextName))
    throw new Error(`project "${nextName}" already exists`)
  const d = db()
  writeTransaction(() => {
    d.query('UPDATE project SET name=? WHERE id=?').run(nextName, current.id)
    for (const [table, column] of [
      ['run', 'repo'],
      ['canon_pack', 'project'],
      ['landing', 'project'],
      ['landing_override', 'project'],
      ['landing_review_carry', 'project'],
    ])
      d.query(`UPDATE ${table} SET ${column}=? WHERE project_id=?`).run(nextName, current.id)
    d.query("UPDATE doc SET subject=? WHERE scope='project' AND project_id=?").run(
      nextName,
      current.id,
    )
    d.query("UPDATE doc_revision SET subject=? WHERE scope='project' AND project_id=?").run(
      nextName,
      current.id,
    )
  }, d)
}

export type ProjectReferenceCounts = {
  run: number
  resource_claim: number
  canon_pack: number
  landing: number
  landing_override: number
  landing_review_carry: number
  doc: number
  doc_revision: number
  review: number
}

const REFERENCE_LABELS: { key: keyof ProjectReferenceCounts; label: string }[] = [
  { key: 'run', label: 'run' },
  { key: 'resource_claim', label: 'claim' },
  { key: 'canon_pack', label: 'canon_pack' },
  { key: 'landing', label: 'landing' },
  { key: 'landing_override', label: 'landing_override' },
  { key: 'landing_review_carry', label: 'landing_review_carry' },
  { key: 'doc', label: 'doc' },
  { key: 'doc_revision', label: 'doc_revision' },
  { key: 'review', label: 'review' },
]

/** Two anchored lines, or null when the row may be deleted. */
export function projectRemovalRefusal(
  name: string,
  counts: ProjectReferenceCounts,
): string[] | null {
  const named = REFERENCE_LABELS.filter(({ key }) => counts[key] > 0).map(
    ({ key, label }) => `${counts[key]} ${label}(s)`,
  )
  if (!named.length) return null
  return [
    `project ${name} is referenced by ${named.join(', ')}; removing it would blank their project attribution`,
    `cleared by: orch project retire ${name}`,
  ]
}

export function projectReferenceCounts(projectId: number): ProjectReferenceCounts {
  const count = (table: string) =>
    (
      db().query(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).get(projectId) as {
        n: number
      }
    ).n
  return {
    run: count('run'),
    resource_claim: count('resource_claim'),
    canon_pack: count('canon_pack'),
    landing: count('landing'),
    landing_override: count('landing_override'),
    landing_review_carry: count('landing_review_carry'),
    doc: count('doc'),
    doc_revision: count('doc_revision'),
    review: count('review'),
  }
}

export function removeProject(name: string): boolean {
  writableDb()
  const project = projectByName(name)
  if (!project) return false
  const refusal = projectRemovalRefusal(name, projectReferenceCounts(project.id))
  if (refusal) throw new Error(refusal.join('\n'))
  return db().query('DELETE FROM project WHERE id = ?').run(project.id).changes > 0
}

export function retireProject(name: string): 'retired' | 'already-retired' {
  writableDb()
  const project = projectRowByName(name)
  if (!project) throw new Error(`no project "${name}"`)
  if (project.retiredAt) return 'already-retired'
  db().query('UPDATE project SET retired_at=? WHERE id=?').run(nowIso(), project.id)
  return 'retired'
}

export function unretireProject(name: string): boolean {
  writableDb()
  const project = projectRowByName(name)
  if (!project) throw new Error(`no project "${name}"`)
  if (!project.retiredAt) return false
  db().query('UPDATE project SET retired_at=NULL WHERE id=?').run(project.id)
  return true
}

/**
 * Refuse malformed lifecycle declarations while the operator is registering
 * them, before a worker is waiting on a vendor clone to discover the mistake.
 */
export function validateProjectSettings(settings: ProjectSettings, projectPath?: string): string[] {
  const problems = [
    ...validateCreate(settings.worktree?.create as unknown, 'worktree.create', CREATE_VARS),
    ...validateCreate(
      settings.worktree?.readonly_create as unknown,
      'worktree.readonly_create',
      new Set(['path', 'base']),
    ),
    ...validateReadonlyProvision(settings.worktree?.readonly_provision),
    ...trackedRecipeProblems(settings.worktree, projectPath),
  ]

  if (invalidOptionalStringArray(settings.secretPaths)) {
    problems.push('secretPaths must be an array of non-empty path strings')
  }
  if (invalidOptionalStringArray(settings.workerMcpServers))
    problems.push('workerMcpServers must be an array of non-empty strings')
  if (settings.requireCleanMain !== undefined && typeof settings.requireCleanMain !== 'boolean') {
    problems.push('requireCleanMain must be a boolean')
  }
  if (
    settings.mcpServer !== undefined &&
    (typeof settings.mcpServer !== 'string' || !settings.mcpServer.trim())
  ) {
    problems.push('mcpServer must be a non-empty string')
  }
  if (
    settings.mcp !== undefined &&
    (!settings.mcp || typeof settings.mcp !== 'object' || Array.isArray(settings.mcp))
  ) {
    problems.push('mcp must be an object')
  } else if (settings.mcp?.probe_tool !== undefined) {
    const tool = settings.mcp.probe_tool
    if (typeof tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tool)) {
      problems.push('mcp.probe_tool must be a plain non-empty tool name')
    }
  }
  const readonly = settings.worktree?.readonly_create
  if (readonly && !createHasPlaceholder(readonly, 'path')) {
    problems.push('worktree.readonly_create must contain {path}')
  }
  if (readonly && !createHasPlaceholder(readonly, 'base')) {
    problems.push('worktree.readonly_create must contain {base}')
  }
  const readonlyRemove = settings.worktree?.readonly_remove
  if (readonlyRemove !== undefined) {
    if (typeof readonlyRemove !== 'string' || !readonlyRemove.trim()) {
      problems.push('worktree.readonly_remove must be a non-empty template')
    } else {
      const unknown = placeholders(readonlyRemove).find((name) => name !== 'path')
      if (unknown)
        problems.push(`worktree.readonly_remove contains unknown placeholder {${unknown}}`)
      if (!placeholders(readonlyRemove).includes('path')) {
        problems.push('worktree.readonly_remove must contain {path}')
      }
    }
  }
  return problems
}

function trackedRecipeProblems(worktree: WorktreeTool | undefined, projectPath?: string): string[] {
  const problems: string[] = []
  if (worktree?.recipePath !== undefined && typeof worktree.recipePath !== 'string') {
    problems.push('recipe path rule: worktree.recipePath must be a string')
    return problems
  }
  let resolution = resolveWorktreeLifecycle(worktree)
  if (resolution.form === 'none' && projectPath) {
    resolution = resolveWorktreeLifecycle(
      worktree,
      existsSync(resolve(projectPath, DEFAULT_PROJECT_CONFIG_PATH)),
    )
  }
  if (resolution.form === 'tracked-recipe') {
    const pointerProblems = recipePointerErrors(resolution.recipePath).map(
      (problem) => `worktree.recipePath: ${problem}`,
    )
    problems.push(...pointerProblems)
    if (!pointerProblems.length && projectPath) {
      const loaded = loadTrackedRecipe(projectPath, resolution.recipePath)
      if (!loaded.ok) problems.push(...loaded.errors)
    }
  }
  return problems
}

function invalidOptionalStringArray(value: unknown): boolean {
  return (
    value !== undefined &&
    (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim()))
  )
}

/** Validate a stored row without re-refusing its unchanged legacy create string. */
export function validateStoredProjectSettings(
  settings: ProjectSettings,
  projectPath?: string,
): string[] {
  return validateProjectSettings(settings, projectPath).filter(
    (problem) =>
      !(
        typeof settings.worktree?.create === 'string' &&
        problem === 'worktree.create is a shell string; migrate it (DEV-308)'
      ),
  )
}

export type RegisterBranchCheck = {
  head: string | null
  landing: string | null
  canonIntegration: string | null
  problems: string[]
}

/** Verify branch facts at registration time; never guess a detached HEAD. */
export function registerBranchCheck(
  project: Pick<Project, 'name' | 'path' | 'settings'>,
): RegisterBranchCheck {
  const landing =
    typeof project.settings.trunk === 'string' && project.settings.trunk.trim()
      ? project.settings.trunk.trim()
      : null
  const headResult = Bun.spawnSync(
    ['git', '-C', project.path, 'symbolic-ref', '--quiet', '--short', 'HEAD'],
    {
      env: inspectionGitEnv(),
      stdout: 'pipe',
      stderr: 'ignore',
    },
  )
  const head = headResult.exitCode === 0 ? headResult.stdout.toString().trim() || null : null
  let canonIntegration: string | null = null
  const canonPath = join(project.path, 'AGENTS.md')
  if (existsSync(canonPath)) {
    const canon = readFileSync(canonPath, 'utf8')
    const match = canon.match(
      /\bintegration branch\s+(?:is|:)\s*[`'"]?([A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?)/i,
    )
    canonIntegration = match?.[1] ?? null
  }
  const problems: string[] = []
  if (landing && head !== landing)
    problems.push(`checkout HEAD is ${head ?? 'detached'}, not landing branch ${landing}`)
  if (landing && canonIntegration && canonIntegration !== landing) {
    problems.push(
      `canon names integration branch ${canonIntegration}, not landing branch ${landing}`,
    )
  }
  const production =
    typeof project.settings.productionBranch === 'string'
      ? project.settings.productionBranch.trim()
      : ''
  if (landing && production && production === landing) {
    problems.push(`production branch ${production} must be distinct from landing branch ${landing}`)
  }
  return { head, landing, canonIntegration, problems }
}

export function assertRegisterBranches(project: Pick<Project, 'name' | 'path' | 'settings'>): void {
  const check = registerBranchCheck(project)
  if (!check.problems.length) return
  throw new Error(
    `${project.name}: ${check.problems.join('; ')}\n` +
      'invariant: the register landing branch agrees with the main checkout and its integration-branch canon\n' +
      `cleared by: check out ${check.landing ?? '<landing-branch>'} in ${project.path} or correct it with orch project set ${project.name} --settings '{"trunk":"<branch>"}'`,
  )
}

export const MAIN_CHECKOUT_INVARIANT =
  'A registered main checkout stays clean; work happens in a worktree'

/** Default ON. Only an explicit false is an exemption. */
export function requiresCleanMain(settings: ProjectSettings): boolean {
  return settings.requireCleanMain !== false
}

export function mainCheckoutWorktreeHint(projectPath: string): string {
  return join(projectPath, '.claude', 'worktrees')
}

export type MainCheckoutInspection = {
  dirtyTracked: string[]
  untracked: string[]
  sequence: SequenceState
}

/**
 * Cleanliness of one main checkout.
 *
 * Encoded, not inferred:
 * - tracked modifications block
 * - an in-progress sequence blocks (merge / cherry-pick / rebase / revert /
 *   am / bisect); residue of a pseudo-ref over a clean tree does not —
 *   refusing residue would recreate DEV-432
 * - untracked files warn and do not block (orch.db and build output live there)
 * - ignored files are silent
 * - submodules: `--ignore-submodules=untracked`, so a dirty gitlink or tracked
 *   change inside a submodule still blocks, and untracked files inside a
 *   submodule are not this checkout's untracked set
 *
 * Dirty check is `git --no-optional-locks status --porcelain=v1`. It does
 * not write the index. Unrunnable git is
 * INDETERMINATE: this returns null and the caller fails open. A false
 * refusal on a clean tree is worse than a missed dirty one.
 *
 * The registered path must be the git toplevel; a subdirectory is not a main
 * checkout and is left alone.
 */
export function inspectMainCheckout(projectPath: string): MainCheckoutInspection | null {
  const toplevel = gitToplevel(projectPath)
  if (!toplevel) return null
  if (!resolvedPathsEqual(projectPath, toplevel)) return null
  const state = inspectCheckout(projectPath)
  if (state.cleanliness === 'indeterminate') return null
  return {
    dirtyTracked: state.dirtyTracked,
    untracked: state.untracked,
    sequence: state.sequence,
  }
}

/** POSIX single-quote so a cleared-by line can be pasted into a shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function mainCheckoutRefusal(
  project: Pick<Project, 'name' | 'path'>,
  dirtyTracked: string[],
): string {
  const hint = mainCheckoutWorktreeHint(project.path)
  return (
    `${project.name}: main checkout ${project.path} has tracked modifications: ${dirtyTracked.join(', ')}\n` +
    `work from a worktree under ${hint} instead\n` +
    `invariant: ${MAIN_CHECKOUT_INVARIANT}\n` +
    `cleared by: orch do --cwd ${shellQuote(`${hint}/<tree>`)}`
  )
}

function sequenceClearCommand(kind: SequenceKind, path: string): string {
  const quoted = shellQuote(path)
  if (kind === 'bisect') return `git -C ${quoted} bisect reset`
  if (kind === 'am') return `git -C ${quoted} am --abort`
  return `git -C ${quoted} ${kind} --abort`
}

export function mainCheckoutSequenceRefusal(
  project: Pick<Project, 'name' | 'path'>,
  kind: SequenceKind,
): string {
  const hint = mainCheckoutWorktreeHint(project.path)
  if (kind === 'cherry-pick') {
    return (
      `${project.name}: main checkout ${project.path} has cherry-pick state; git status cannot distinguish ` +
      `a live empty cherry-pick from a leftover CHERRY_PICK_HEAD\n` +
      `work from a worktree under ${hint} instead\n` +
      `invariant: ${MAIN_CHECKOUT_INVARIANT}\n` +
      `inspect with: git -C ${shellQuote(project.path)} status`
    )
  }
  return (
    `${project.name}: main checkout ${project.path} has an in-progress ${kind}\n` +
    `work from a worktree under ${hint} instead\n` +
    `invariant: ${MAIN_CHECKOUT_INVARIANT}\n` +
    `cleared by: ${sequenceClearCommand(kind, project.path)}`
  )
}

/** Throws on tracked dirt or an in-progress sequence. Returns an untracked warning, or null when silent. */
export function assertMainCheckoutClean(
  project: Pick<Project, 'name' | 'path' | 'settings'>,
): string | null {
  if (!requiresCleanMain(project.settings)) return null
  const inspection = inspectMainCheckout(project.path)
  if (!inspection) return null
  if (inspection.sequence.status === 'in-progress') {
    throw new Error(mainCheckoutSequenceRefusal(project, inspection.sequence.kind))
  }
  if (inspection.dirtyTracked.length) {
    throw new Error(mainCheckoutRefusal(project, inspection.dirtyTracked))
  }
  if (!inspection.untracked.length) return null
  const hint = mainCheckoutWorktreeHint(project.path)
  return (
    `! ${project.name}: main checkout ${project.path} has untracked files: ${inspection.untracked.join(', ')}\n` +
    `  they do not block dispatch; work from a worktree under ${hint}`
  )
}

function configuredHooksPath(projectPath: string): string | null {
  if (existsSync(join(projectPath, '.githooks'))) return join(projectPath, '.githooks')
  const configured = Bun.spawnSync(
    ['git', '-C', projectPath, 'config', '--path', 'core.hooksPath'],
    {
      env: inspectionGitEnv(),
      stdout: 'pipe',
      stderr: 'ignore',
    },
  )
  if (configured.exitCode === 0) {
    const value = configured.stdout.toString().trim()
    if (value) return value.startsWith('/') ? value : resolve(projectPath, value)
  }
  const gitHooks = join(projectPath, '.git', 'hooks')
  return existsSync(gitHooks) ? gitHooks : null
}

/** Doctor: a gate that declares nothing while the hooks directory carries pre-commit checks. */
export function undeclaredCommitHooks(project: Project): string | null {
  if (typeof project.settings.gate === 'string' && project.settings.gate.trim()) return null
  const hooks = configuredHooksPath(project.path)
  if (!hooks) return null
  const checks = ['pre-commit', 'commit-msg', 'pre-push'].filter((name) =>
    existsSync(join(hooks, name)),
  )
  if (!checks.length) return null
  return `${project.name}: gate undeclared while hooks carry pre-commit checks (${checks.join(', ')} in ${hooks})`
}

/**
 * Guess a stack by looking at what a checkout contains.
 *
 * Only ever used to SUGGEST a value when registering, never to decide one at
 * routing time. A guess that runs on every routing decision is a guess nobody
 * ever reviews; a guess offered once, at the moment a person is registering the
 * project and looking straight at it, is a convenience they can correct.
 */
export function sniffStack(path: string): string | null {
  const has = (f: string) => Bun.spawnSync(['test', '-e', `${path}/${f}`]).exitCode === 0
  const read = (f: string) => {
    try {
      return Bun.spawnSync(['cat', `${path}/${f}`]).stdout.toString()
    } catch {
      return ''
    }
  }
  const parts: string[] = []
  if (has('composer.json')) parts.push('php')
  if (has('artisan')) parts.push('laravel')
  const pkg = has('package.json') ? read('package.json') : ''
  if (pkg && !parts.length) parts.push('node')
  for (const [dep, label] of [
    ['"vue"', 'vue'],
    ['"react"', 'react'],
    ['"next"', 'next'],
    ['"svelte"', 'svelte'],
    ['drizzle', 'drizzle'],
  ] as const) {
    if (pkg.includes(dep)) parts.push(label)
  }
  if (has('go.mod')) parts.push('go')
  if (has('Cargo.toml')) parts.push('rust')
  if (has('pyproject.toml') || has('requirements.txt')) parts.push('python')
  return parts.length ? parts.join('-') : null
}

/**
 * Ways a project's worktree settings contradict themselves.
 *
 * A settings write used to merge only one level deep, so updating
 * `worktree.notes` replaced the whole `worktree` object and silently discarded
 * its create, remove, sweep and branch template. One project spent hours in that
 * state — a `create` command with no branch template, so every run was handed
 * `orch/<id>`, which its own script correctly refuses. The merge is deep now
 * and cannot do that again, but nothing would have NOTICED, and the state is
 * cheap to recognise: a tool that can make a worktree and not remove one is
 * incoherent however it got that way.
 *
 * Reported, never enforced. A half-configured project should say so and keep
 * working, not refuse to run.
 */
export function worktreeWarnings(p: Project): string[] {
  const w = p.settings.worktree
  if (!w) return []
  const resolved = resolveWorktreeLifecycle(
    w,
    existsSync(resolve(p.path, DEFAULT_PROJECT_CONFIG_PATH)),
  )
  const out: string[] = []
  if (w.create && !w.remove) {
    out.push('has a create command but no remove: orch cannot tear down what it makes')
  }
  if (w.create && w.recipe) {
    out.push('declares both create and recipe; create wins and the recipe is ignored')
  }
  if (resolved.form === 'none') {
    out.push(
      `declares no worktree lifecycle and has no ${DEFAULT_PROJECT_CONFIG_PATH}, so it cannot make a worktree at all`,
    )
  }
  /*
   * Only for a project running its OWN script.
   *
   * That script may enforce a branch format, and orch's default `orch/<id>` is
   * what it then refuses — which is how this was found, twice. A recipe project
   * has no such script: orch names the branch itself, so the default is correct
   * and warning about it would be noise on the one project that cannot have the
   * problem.
   */
  if (w.create && !w.branch) {
    out.push(
      'has a create command but no branch template, so runs get orch/<id> - ' +
        'which a project enforcing a branch format will reject',
    )
  }
  if (createHasPlaceholder(w.create, 'seed') && !w.seeds?.length) {
    out.push(
      'has a create command with a {seed} placeholder but no seeds list, so orch cannot ' +
        'say which values are valid',
    )
  }
  return out
}
