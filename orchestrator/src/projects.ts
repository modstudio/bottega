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
import { db, writableDb } from './db.ts'

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
  /** Ticket-key prefixes whose committed tasks count as this project's shipped work. */
  keyPrefixes?: string[]
  /** MCP server this project's agents attach to. Defaults to the project name. */
  mcpServer?: string
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
  /** The project's complete landing gate, run from the branch worktree. */
  gate?: string
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

export function removeProject(name: string): boolean {
  writableDb()
  return db().query('DELETE FROM project WHERE name = ?').run(name).changes > 0
}

const CREATE_VARS = new Set(['branch', 'name', 'base', 'seed', 'key', 'path'])

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!)
}

function hasPipelineOperator(template: string): boolean {
  let quote: "'" | '"' | null = null
  for (let i = 0; i < template.length; i++) {
    const char = template[i]
    if (char === '\\' && quote !== "'") {
      i++
    } else if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'"
    } else if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"'
    } else if (char === '|' && quote === null && template[i + 1] !== '|') {
      return true
    }
  }
  return false
}

/**
 * Refuse malformed lifecycle declarations while the operator is registering
 * them, before a worker is waiting on a vendor clone to discover the mistake.
 */
export function validateProjectSettings(settings: ProjectSettings): string[] {
  const create = settings.worktree?.create as unknown
  if (create === undefined) return []
  const at = 'worktree.create'
  if (typeof create === 'string') {
    return [`${at} must be an object with command and args; shell strings are not commands`]
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
    const unknown = placeholders(value.pipeline).find((name) => !CREATE_VARS.has(name))
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
  if (Object.keys(value).some((key) => key !== 'command' && key !== 'args')) {
    problems.push(`${at} may contain only command and args`)
  }
  value.args.forEach((arg, index) => {
    const argAt = `${at}.args[${index}]`
    if (typeof arg === 'string') {
      const unknown = placeholders(arg).find((name) => !CREATE_VARS.has(name))
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
        !CREATE_VARS.has(variable)) {
      problems.push(`${argAt} must have a string value and one valid omitWhenEmpty variable`)
      return
    }
    if (!placeholders(item.value).includes(variable)) {
      problems.push(`${argAt}.value must contain {${variable}}, the value named by omitWhenEmpty`)
    }
    const unknown = placeholders(item.value).find((name) => !CREATE_VARS.has(name))
    if (unknown) problems.push(`${argAt}.value contains unknown placeholder {${unknown}}`)
  })
  return problems
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
  out.push(...validateProjectSettings(p.settings))
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
  })
}
