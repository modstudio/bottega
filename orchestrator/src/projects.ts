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
import { db } from './db.ts'
import type { SandboxLevel } from './agents.ts'

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
  /** Display colour, for anything that draws a project. */
  color?: string
  /**
   * How much of the machine an agent working here may actually use.
   *
   * `exec` lets it run the project's real toolchain — containers, package
   * managers, the test suite. Without it a review lens reasons from source and
   * says so: four runs in one session reported they could not execute anything
   * (a denied Docker socket, no PHP on the host), and one downgraded its entire
   * test verdict to "static review". It still found real defects; it would have
   * found more.
   *
   * Defaults to `exec` for a REGISTERED project, deliberately. The register is
   * the list of repositories this machine's owner works in, and an agent
   * invited into one is being asked to do the work that repository requires —
   * one registered project's own rule is that everything runs through Docker. Anywhere
   * unregistered stays read-only, because "a directory an agent was pointed at"
   * is a different proposition from "a project someone registered".
   *
   * A setting rather than a constant precisely so it can be narrowed per
   * project without a code change.
   */
  agentSandbox?: SandboxLevel
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
 * A project's own worktree lifecycle, as commands.
 *
 * Templates rather than arguments, because these tools do not agree on argument
 * order and never will: one takes the seed in the environment
 * (`WORKTREE_SEED=...`), another takes it positionally. A template lets each
 * project spell its own call, and keeps orch from encoding one project's
 * grammar as everybody's.
 *
 * Placeholders: `{branch}` `{name}` `{base}` `{seed}` `{path}`.
 */
export type WorktreeTool = {
  /**
   * Creates and fully provisions one. Must print the created path.
   *
   * OPTIONAL, because a project need not have one. Declare `recipe` instead and
   * bottega builds the worktree itself from the declaration — which is the
   * whole point of a project being able to adopt this rather than write its
   * fourth several-hundred-line worktree script.
   */
  create?: string
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
   * How much database, as this project spells it.
   *
   * one application requires the choice with no default, having learned that the
   * default it used to take was silent and left every business table empty.
   * orch therefore refuses to guess: a project listing seeds must be given one.
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
  db().query(
    `INSERT INTO project (name, path, stack, canon, settings) VALUES (?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET path=excluded.path, stack=excluded.stack,
                                     canon=excluded.canon, settings=excluded.settings`,
  ).run(
    p.name, p.path.replace(/\/$/, ''), p.stack ?? null, p.canon ? 1 : 0,
    JSON.stringify(p.settings ?? {}),
  )
}

export function removeProject(name: string): boolean {
  return db().query('DELETE FROM project WHERE name = ?').run(name).changes > 0
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
  if (w.create?.includes('{seed}') && !w.seeds?.length) {
    out.push('has a create command with a {seed} placeholder but no seeds list, so orch cannot '
      + 'say which values are valid')
  }
  return out
}
