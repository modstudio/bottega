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
  gitToplevel, inspectCheckout, inspectionGitEnv, resolvedPathsEqual,
  type SequenceKind, type SequenceState,
} from '../../shared/git.ts'
import { db, writableDb, writeTransaction } from './db.ts'

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

/**
 * One argument in a project's create command.
 *
 * A string is always passed, including when one of its placeholders is empty.
 * The other two forms make the exceptional behaviours visible at the argument
 * that requests them: omission names the empty value that removes the argument,
 * and expansion is the one deliberate boundary where a seed string becomes
 * several argv entries.
 */
export type WorktreeCreateArg = string | {
  value: string
  omitWhenEmpty: 'branch' | 'name' | 'base' | 'seed' | 'key' | 'path'
} | {
  expand: 'seed'
}

export type WorktreeCreate = {
  command: string
  args: WorktreeCreateArg[]
  env?: Record<string, string>
} | {
  /**
   * Narrow escape hatch for the one lifecycle tool whose input is piped JSON.
   * Registration refuses this form unless it contains a real pipeline; an
   * ordinary command must use command plus args.
   */
  pipeline: string
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

function parse(row: {
  id: number; name: string; path: string; stack: string | null
  canon: number; settings: string | null
}): Project {
  let settings: ProjectSettings = {}
  try { settings = row.settings ? JSON.parse(row.settings) : {} } catch {
    // Unreadable settings must not take the project out of the register: a
    // typo in one JSON blob would otherwise make a whole repo invisible to
    // routing and reporting at once.
    settings = {}
  }
  return {
    id: row.id, name: row.name, path: row.path, stack: row.stack,
    canon: row.canon === 1, settings,
  }
}

export function projects(): Project[] {
  return (db().query('SELECT * FROM project ORDER BY name').all() as any[]).map(parse)
}

export function projectByName(name: string): Project | null {
  const r = db().query('SELECT * FROM project WHERE name = ?').get(name) as any
  return r ? parse(r) : null
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
  name: string; path: string; stack?: string | null; canon?: boolean
  settings?: ProjectSettings
}): void {
  writableDb()
  db().query(
    `INSERT INTO project (name, path, stack, canon, settings) VALUES (?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET path=excluded.path, stack=excluded.stack,
                                     canon=excluded.canon, settings=excluded.settings`,
  ).run(
    p.name, p.path.replace(/\/$/, ''), p.stack ?? null, p.canon ? 1 : 0,
    JSON.stringify(p.settings ?? {}),
  )
}

/** Rename the referent and refresh every deprecated one-release name mirror atomically. */
export function renameProject(currentName: string, nextName: string): void {
  writableDb()
  if (!nextName.trim()) throw new Error('project --name must be non-empty')
  const current = projectByName(currentName)
  if (!current) throw new Error(`no project "${currentName}"`)
  if (currentName !== nextName && projectByName(nextName)) throw new Error(`project "${nextName}" already exists`)
  const d = db()
  writeTransaction(() => {
    d.query('UPDATE project SET name=? WHERE id=?').run(nextName, current.id)
    for (const [table, column] of [
      ['run','repo'], ['canon_pack','project'], ['landing','project'],
      ['landing_override','project'], ['landing_review_carry','project'],
    ]) d.query(`UPDATE ${table} SET ${column}=? WHERE project_id=?`).run(nextName,current.id)
    d.query("UPDATE doc SET subject=? WHERE scope='project' AND project_id=?").run(nextName,current.id)
    d.query("UPDATE doc_revision SET subject=? WHERE scope='project' AND project_id=?").run(nextName,current.id)
  }, d)
}

export function removeProject(name: string): boolean {
  writableDb()
  const project = projectByName(name)
  if (!project) return false
  const d=db()
  return writeTransaction(()=>{
    for(const table of ['run','canon_pack','landing','landing_override','landing_review_carry','doc','doc_revision','review']) {
      d.query(`UPDATE ${table} SET project_id=NULL WHERE project_id=?`).run(project.id)
    }
    return d.query('DELETE FROM project WHERE id = ?').run(project.id).changes > 0
  },d)
}

const CREATE_VARS = new Set(['branch', 'name', 'base', 'seed', 'key', 'path'])

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!)
}

function hasPipelineOperator(template: string): boolean {
  return scanPipelineOperators(template).positions.length > 0
}

function scanPipelineOperators(template: string): {
  positions: number[]
  ands: number[]
  unclosed: { quote: "'" | '"'; position: number } | null
} {
  const positions: number[] = []
  const ands: number[] = []
  let quote: "'" | '"' | null = null
  let quoteStart = 0
  for (let i = 0; i < template.length; i++) {
    const char = template[i]
    if (char === '\\' && quote !== "'") {
      i++
    } else if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'"
      if (quote) quoteStart = i
    } else if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"'
      if (quote) quoteStart = i
    } else if (char === '|' && quote === null &&
               template[i - 1] !== '|' && template[i + 1] !== '|') {
      positions.push(i)
    } else if (char === '&' && quote === null && template[i + 1] === '&') {
      ands.push(i)
      i++
    }
  }
  return {
    positions,
    ands,
    unclosed: quote ? { quote, position: quoteStart } : null,
  }
}

/**
 * Refuse malformed lifecycle declarations while the operator is registering
 * them, before a worker is waiting on a vendor clone to discover the mistake.
 */
export function validateProjectSettings(settings: ProjectSettings): string[] {
  const problems = [
    ...validateCreate(settings.worktree?.create as unknown, 'worktree.create', CREATE_VARS),
    ...validateCreate(
      settings.worktree?.readonly_create as unknown,
      'worktree.readonly_create',
      new Set(['path', 'base']),
    ),
  ]
  if (settings.secretPaths !== undefined && (
    !Array.isArray(settings.secretPaths) ||
    settings.secretPaths.some((path) => typeof path !== 'string' || !path.trim())
  )) {
    problems.push('secretPaths must be an array of non-empty path strings')
  }
  if (settings.requireCleanMain !== undefined && typeof settings.requireCleanMain !== 'boolean') {
    problems.push('requireCleanMain must be a boolean')
  }
  if (settings.mcpServer !== undefined &&
      (typeof settings.mcpServer !== 'string' || !settings.mcpServer.trim())) {
    problems.push('mcpServer must be a non-empty string')
  }
  if (settings.mcp !== undefined &&
      (!settings.mcp || typeof settings.mcp !== 'object' || Array.isArray(settings.mcp))) {
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
      if (unknown) problems.push(`worktree.readonly_remove contains unknown placeholder {${unknown}}`)
      if (!placeholders(readonlyRemove).includes('path')) {
        problems.push('worktree.readonly_remove must contain {path}')
      }
    }
  }
  return problems
}

/** Validate a stored row without re-refusing its unchanged legacy create string. */
export function validateStoredProjectSettings(settings: ProjectSettings): string[] {
  return validateProjectSettings(settings).filter((problem) =>
    !(typeof settings.worktree?.create === 'string' &&
      problem === 'worktree.create is a shell string; migrate it (DEV-308)'))
}

export type RegisterBranchCheck = {
  head: string | null
  landing: string | null
  canonIntegration: string | null
  problems: string[]
}

/** Verify branch facts at registration time; never guess a detached HEAD. */
export function registerBranchCheck(project: Pick<Project, 'name' | 'path' | 'settings'>): RegisterBranchCheck {
  const landing = typeof project.settings.trunk === 'string' && project.settings.trunk.trim()
    ? project.settings.trunk.trim() : null
  const headResult = Bun.spawnSync(['git', '-C', project.path, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    env: inspectionGitEnv(), stdout: 'pipe', stderr: 'ignore',
  })
  const head = headResult.exitCode === 0 ? headResult.stdout.toString().trim() || null : null
  let canonIntegration: string | null = null
  const canonPath = join(project.path, 'AGENTS.md')
  if (existsSync(canonPath)) {
    const canon = readFileSync(canonPath, 'utf8')
    const match = canon.match(/\bintegration branch\s+(?:is|:)\s*[`'\"]?([A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?)/i)
    canonIntegration = match?.[1] ?? null
  }
  const problems: string[] = []
  if (landing && head !== landing) problems.push(`checkout HEAD is ${head ?? 'detached'}, not landing branch ${landing}`)
  if (landing && canonIntegration && canonIntegration !== landing) {
    problems.push(`canon names integration branch ${canonIntegration}, not landing branch ${landing}`)
  }
  const production = typeof project.settings.productionBranch === 'string'
    ? project.settings.productionBranch.trim() : ''
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
  project: Pick<Project, 'name' | 'path'>, dirtyTracked: string[],
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
  project: Pick<Project, 'name' | 'path'>, kind: SequenceKind,
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
  const configured = Bun.spawnSync(['git', '-C', projectPath, 'config', '--path', 'core.hooksPath'], {
    env: inspectionGitEnv(), stdout: 'pipe', stderr: 'ignore',
  })
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
  const checks = ['pre-commit', 'commit-msg', 'pre-push']
    .filter((name) => existsSync(join(hooks, name)))
  if (!checks.length) return null
  return `${project.name}: gate undeclared while hooks carry pre-commit checks (${checks.join(', ')} in ${hooks})`
}

function validateCreate(create: unknown, at: string, allowedVars: Set<string>): string[] {
  if (create === undefined) return []
  if (typeof create === 'string') {
    return [`${at} is a shell string; migrate it (DEV-308)`]
  }
  if (!create || typeof create !== 'object' || Array.isArray(create)) {
    return [`${at} must be an object with command and args`]
  }
  const value = create as Record<string, unknown>
  if ('pipeline' in value) {
    if (Object.keys(value).length !== 1 || typeof value.pipeline !== 'string' || !value.pipeline.trim()) {
      return [`${at}.pipeline must be the declaration's only key and must be a non-empty string`]
    }
    if (!hasPipelineOperator(value.pipeline)) {
      return [`${at}.pipeline is only for a command that uses a pipe; use command and args`]
    }
    const unknown = placeholders(value.pipeline).find((name) => !allowedVars.has(name))
    if (unknown) return [`${at}.pipeline contains unknown placeholder {${unknown}}`]
    const capability = placeholders(value.pipeline).find((name) => name === 'base' || name === 'seed')
    return capability
      ? [`${at}.pipeline cannot declare {${capability}} semantics; use command and args`]
      : []
  }
  const problems: string[] = []
  if (typeof value.command !== 'string' || !value.command.trim()) {
    problems.push(`${at}.command must be a non-empty string`)
  } else if (/\s/.test(value.command)) {
    problems.push(`${at}.command must name one executable; put each argument in args`)
  } else if (/(^|\/)(?:ba|z|da)?sh$/.test(value.command) &&
             Array.isArray(value.args) && value.args.includes('-c')) {
    problems.push(`${at} may not disguise a shell string as ${value.command} -c; use command and args`)
  }
  if (!Array.isArray(value.args)) {
    problems.push(`${at}.args must be an array`)
    return problems
  }
  if (Object.keys(value).some((key) => key !== 'command' && key !== 'args' && key !== 'env')) {
    problems.push(`${at} may contain only command, args, and env`)
  }
  if (value.env !== undefined) {
    if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env)) {
      problems.push(`${at}.env must be an object mapping names to string values`)
    } else {
      for (const [name, envValue] of Object.entries(value.env as Record<string, unknown>)) {
        const envAt = `${at}.env.${name}`
        if (typeof envValue !== 'string') {
          problems.push(`${envAt} must be a string`)
          continue
        }
        const unknown = placeholders(envValue).find((variable) => !CREATE_VARS.has(variable))
        if (unknown) problems.push(`${envAt} contains unknown placeholder {${unknown}}`)
      }
    }
  }
  value.args.forEach((arg, index) => {
    const argAt = `${at}.args[${index}]`
    if (typeof arg === 'string') {
      const unknown = placeholders(arg).find((name) => !allowedVars.has(name))
      if (unknown) problems.push(`${argAt} contains unknown placeholder {${unknown}}`)
      return
    }
    if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
      problems.push(`${argAt} must be a string, omit-when-empty argument, or seed expansion`)
      return
    }
    const item = arg as Record<string, unknown>
    if ('expand' in item) {
      if (Object.keys(item).length !== 1 || item.expand !== 'seed') {
        problems.push(`${argAt}.expand must be exactly "seed"`)
      }
      return
    }
    const variable = item.omitWhenEmpty
    if (Object.keys(item).some((key) => key !== 'value' && key !== 'omitWhenEmpty') ||
        typeof item.value !== 'string' || typeof variable !== 'string' ||
        !allowedVars.has(variable)) {
      problems.push(`${argAt} must have a string value and one valid omitWhenEmpty variable`)
      return
    }
    if (!placeholders(item.value).includes(variable)) {
      problems.push(`${argAt}.value must contain {${variable}}, the value named by omitWhenEmpty`)
    }
    const unknown = placeholders(item.value).find((name) => !allowedVars.has(name))
    if (unknown) problems.push(`${argAt}.value contains unknown placeholder {${unknown}}`)
  })
  return problems
}

export type CreateMigration =
  | { kind: 'migrated'; after: WorktreeCreate }
  | { kind: 'refused'; message: string }

/** Convert the legacy shell subset represented by the live project register. */
export function migrateCreate(create: string): CreateMigration {
  const pipeline = scanPipelineOperators(create)
  if (pipeline.unclosed) {
    return {
      kind: 'refused',
      message: unsupportedShellToken(
        pipeline.unclosed.quote, pipeline.unclosed.position, 'unclosed quote',
      ).message,
    }
  }
  const pipes = pipeline.positions
  if (pipes.length) {
    if (pipes.length !== 1) {
      return { kind: 'refused', message: 'only a single pipe can be migrated' }
    }
    const capability = placeholders(create).find((name) => name === 'seed' || name === 'base')
    if (capability) {
      return {
        kind: 'refused',
        message: `a pipe using {${capability}} cannot be migrated; the pipe must move into the project's script`,
      }
    }
    return { kind: 'migrated', after: { pipeline: create } }
  }

  const and = pipeline.ands[0]
  if (and !== undefined) {
    const before = shellTokens(create.slice(0, and))
    if (!before.ok) return { kind: 'refused', message: before.message }
    return {
      kind: 'refused',
      message: `'&&'-chained tail ${JSON.stringify(create.slice(and + 2).trim())} cannot be migrated; ` +
        `the chain must move into the project's script`,
    }
  }
  const parsed = shellTokens(create)
  if (!parsed.ok) return { kind: 'refused', message: parsed.message }
  const tokens = parsed.tokens

  const env: Record<string, string> = {}
  while (tokens.length) {
    const match = tokens[0]!.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)
    if (!match) break
    env[match[1]!] = match[2]!
    tokens.shift()
  }
  const command = tokens.shift()
  if (!command) return { kind: 'refused', message: 'create string has no command to migrate' }
  return {
    kind: 'migrated',
    after: { command, args: tokens, ...(Object.keys(env).length ? { env } : {}) },
  }
}

type ShellTokens = { ok: true; tokens: string[] } | { ok: false; message: string }

/** Plain shell words plus &&; unsupported shell semantics fail at their first offset. */
function shellTokens(input: string): ShellTokens {
  const tokens: string[] = []
  let token = ''
  let started = false
  let quote: "'" | '"' | null = null
  let quoteStart = 0
  const push = () => {
    if (!started) return
    tokens.push(token)
    token = ''
    started = false
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (quote) {
      if (char === quote) {
        quote = null
      } else if (quote !== "'" && char === '\\') {
        return unsupportedShellToken('\\', i)
      } else if (quote !== "'" && char === '$') {
        return unsupportedShellToken('$', i)
      } else if (quote !== "'" && char === '`') {
        return unsupportedShellToken('`', i)
      } else {
        token += char
      }
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      quoteStart = i
      started = true
      continue
    }
    if (char === ' ' || char === '\t') {
      push()
      continue
    }
    if (char === '&' && input[i + 1] === '&') {
      push()
      tokens.push('&&')
      i++
      continue
    }
    if (char === '{') {
      const placeholder = input.slice(i).match(/^\{[A-Za-z_][A-Za-z0-9_]*\}/)?.[0]
      if (!placeholder) return unsupportedShellToken(char, i)
      token += placeholder
      started = true
      i += placeholder.length - 1
      continue
    }
    if (/[A-Za-z0-9_\-./:=@,+%]/.test(char)) {
      token += char
      started = true
      continue
    }
    return unsupportedShellToken(char, i)
  }
  if (quote) return unsupportedShellToken(quote, quoteStart, 'unclosed quote')
  push()
  return { ok: true, tokens }
}

function unsupportedShellToken(
  token: string, position: number, kind = 'unsupported shell token',
): { ok: false; message: string } {
  return { ok: false, message: `${kind} ${JSON.stringify(token)} at position ${position}; cannot migrate` }
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
    try { return Bun.spawnSync(['cat', `${path}/${f}`]).stdout.toString() } catch { return '' }
  }
  const parts: string[] = []
  if (has('composer.json')) parts.push('php')
  if (has('artisan')) parts.push('laravel')
  const pkg = has('package.json') ? read('package.json') : ''
  if (pkg && !parts.length) parts.push('node')
  for (const [dep, label] of [
    ['"vue"', 'vue'], ['"react"', 'react'], ['"next"', 'next'],
    ['"svelte"', 'svelte'], ['drizzle', 'drizzle'],
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
  const out: string[] = []
  if (w.create && !w.remove) {
    out.push('has a create command but no remove: orch cannot tear down what it makes')
  }
  if (w.create && w.recipe) {
    out.push('declares both create and recipe; create wins and the recipe is ignored')
  }
  if (!w.create && !w.recipe) {
    out.push('declares neither create nor recipe, so it cannot make a worktree at all')
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
    out.push('has a create command but no branch template, so runs get orch/<id> - '
      + 'which a project enforcing a branch format will reject')
  }
  if (createHasPlaceholder(w.create, 'seed') && !w.seeds?.length) {
    out.push('has a create command with a {seed} placeholder but no seeds list, so orch cannot '
      + 'say which values are valid')
  }
  return out
}

/** Capabilities declared by structured argv, never inferred from shell text. */
export function createHasPlaceholder(
  create: WorktreeCreate | string | undefined,
  variable: 'branch' | 'name' | 'base' | 'seed' | 'key' | 'path',
): boolean {
  // Legacy rows remain readable during the register migration. Registration
  // still refuses this shape; this substring inference exists only on the
  // compatibility ramp and disappears with its last stored string.
  if (typeof create === 'string') return create.includes(`{${variable}}`)
  if (!create || !('command' in create)) return false
  return create.args.some((arg) => {
    if (typeof arg === 'string') return placeholders(arg).includes(variable)
    if ('expand' in arg) return arg.expand === variable
    return placeholders(arg.value).includes(variable)
  }) || Object.values(create.env ?? {}).some((value) => placeholders(value).includes(variable))
}
