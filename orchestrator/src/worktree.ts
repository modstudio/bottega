/**
 * A throwaway checkout for a worker that writes.
 *
 * Every other job here is read-only, so the worst a bad run could do was waste
 * six minutes. An implementation job edits real files, and the interesting
 * question stops being "was the answer good" and becomes "where did it put its
 * mistakes". A worktree answers it: the worker gets a full checkout on a branch
 * of its own, the architect reads a diff, and a run that went wrong is deleted
 * rather than unpicked.
 *
 * This is the convention the four product projects already use — all carry
 * worktrees under `.claude/worktrees`, one per task and
 * session — and it is what the tools in this niche converged on independently
 * (claude-squad and container-use both isolate per agent, by worktree and by
 * container respectively). Borrowing it costs nothing and keeps a delegated run
 * indistinguishable, on disk, from a parallel session doing the same work.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: commit, push, or merge. The repo canon is
 * explicit that a worktree belongs to one task and one session and that nothing
 * scheduled may mutate one behind its author's back; the same reasoning applies
 * to an agent. The worker leaves changes in the tree, orch captures the diff,
 * and landing it is the architect's decision under the project's own ship
 * knobs — which an external agent has never read and cannot honour.
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { db } from './db.ts'
import { projectAt, type WorktreeTool } from './projects.ts'
import { runRecipe, teardownRecipe, dbNameFor, type Recipe } from './recipe.ts'

export type Worktree = {
  /** Where the worker actually runs. */
  path: string
  /** The branch created for it. */
  branch: string
  /** The commit it was cut from, so the diff has a fixed floor. */
  base: string
  /** The repository the worktree belongs to. */
  repoRoot: string
}

/**
 * A MISSING WORKING DIRECTORY IS NOT A MISSING GIT.
 *
 * `Bun.spawnSync` reports a cwd that does not exist as
 * `ENOENT: posix_spawn 'git'`, which reads as "git is not installed" and sent a
 * real debugging session looking for a PATH problem that did not exist. Every
 * call here therefore checks the directory first and answers for itself.
 *
 * It matters because the normal case IS a missing directory: `orch discard` on
 * a worktree somebody already deleted by hand, or on a scratch repository that
 * has since been cleaned up.
 */
function cwdMissing(cwd: string): boolean {
  return !existsSync(cwd)
}

export type WorktreeObjectEnvironment = {
  GIT_OBJECT_DIRECTORY: string
  GIT_ALTERNATE_OBJECT_DIRECTORIES: string
}

/** Resolve linked-worktree metadata without invoking git (git itself uses this environment). */
function linkedWorktreePaths(cwd: string): {
  gitDir: string
  commonDir: string
  objects: string
} | null {
  const dotGit = join(cwd, '.git')
  if (!existsSync(dotGit)) return null
  let pointer: string
  try { pointer = readFileSync(dotGit, 'utf8').trim() } catch { return null }
  if (!pointer.startsWith('gitdir: ')) return null
  const gitDir = realpathSync(resolve(cwd, pointer.slice('gitdir: '.length)))
  const commonDir = realpathSync(resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()))
  const worktrees = realpathSync(join(commonDir, 'worktrees'))
  if (dirname(gitDir) !== worktrees) {
    throw new Error(
      `refusing writable git directory ${gitDir}: expected one worktree below ${worktrees}`,
    )
  }
  return { gitDir, commonDir, objects: join(gitDir, 'objects') }
}

/** Use the isolated object store after it has been provisioned for this worktree. */
export function worktreeGitEnvironment(cwd: string): WorktreeObjectEnvironment | undefined {
  const paths = linkedWorktreePaths(cwd)
  if (!paths || !existsSync(paths.objects)) return undefined
  return {
    GIT_OBJECT_DIRECTORY: paths.objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(paths.commonDir, 'objects'),
  }
}

/** A git invocation that throws with git's own words rather than a bare code. */
function git(args: string[], cwd: string): string {
  if (cwdMissing(cwd)) throw new Error(`git ${args[0]}: ${cwd} does not exist`)
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: { ...process.env, ...worktreeGitEnvironment(cwd) }, stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`)
  }
  return p.stdout.toString().trim()
}

/** Same, but a failure is an answer rather than an error. */
function gitOk(args: string[], cwd: string): string | null {
  if (cwdMissing(cwd)) return null
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: { ...process.env, ...worktreeGitEnvironment(cwd) }, stdout: 'pipe', stderr: 'pipe',
  })
  return p.exitCode === 0 ? p.stdout.toString().trim() : null
}

/**
 * Git's output with NOT ONE BYTE CHANGED.
 *
 * A patch is a byte-exact artefact: `git apply` reads trailing newlines as
 * part of the hunk, so trimming one turns a valid patch into `corrupt patch at
 * line 301`. That is not hypothetical — `orch diff 638 > p && git apply p`
 * failed exactly that way on the first real implementation run, while the same
 * diff taken straight from git applied cleanly, because `gitOk` trims and a
 * diff is the one thing here that must not be tidied.
 *
 * Kept beside `gitOk` rather than replacing it: trimming is right for a branch
 * name or a commit id, where a stray newline is noise. It is only wrong for
 * content.
 */
function gitRaw(args: string[], cwd: string): string {
  if (cwdMissing(cwd)) return ''
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: { ...process.env, ...worktreeGitEnvironment(cwd) }, stdout: 'pipe', stderr: 'pipe',
  })
  return p.exitCode === 0 ? p.stdout.toString() : ''
}

/** Run git with byte-exact stdin, used to carry a working tree as a patch. */
function gitInput(args: string[], cwd: string, input: Uint8Array): void {
  if (cwdMissing(cwd)) throw new Error(`git ${args[0]}: ${cwd} does not exist`)
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: { ...process.env, ...worktreeGitEnvironment(cwd) },
    stdin: input, stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`)
  }
}

/** Byte-exact git output where failure must stop setup rather than look empty. */
function gitBytes(args: string[], cwd: string): Buffer {
  if (cwdMissing(cwd)) throw new Error(`git ${args[0]}: ${cwd} does not exist`)
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: { ...process.env, ...worktreeGitEnvironment(cwd) }, stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${p.stderr.toString().trim() || `exit ${p.exitCode}`}`)
  }
  return Buffer.from(p.stdout)
}

/**
 * The MAIN checkout, not this tree's own root.
 *
 * `--show-toplevel` from a worktree answers that worktree. Creating the next
 * one relative to it nests `orch-N` under the caller's tree, which is how an
 * one session lost a day: it ran orch from
 * `.../application/.claude/worktrees/AB-2581`, the project's script put the
 * new tree at the checkout root, and orch looked for it at
 * `AB-2581/.claude/worktrees/orch-657`. `--git-common-dir` is the main
 * `.git`; the working tree sits next to it.
 */
export function repoRootOf(cwd: string): string | null {
  const common = gitOk(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd,
  )
  if (!common) return null
  return dirname(common)
}

/**
 * The metadata directory belonging to THIS linked worktree, and no other git state.
 *
 * A writing worker needs its index so `git add`/`git rm`-aware gates can run,
 * but granting the common `.git` directory would also expose refs, objects and
 * the main checkout's config. Resolve the linked-worktree pointers, then require the
 * result to be one immediate child of the common directory's `worktrees/`.
 */
export function worktreeGitDir(cwd: string): string {
  const paths = linkedWorktreePaths(cwd)
  if (!paths) throw new Error(`refusing writable git directory: ${cwd} is not a linked worktree`)
  return paths.gitDir
}

/** Create the worker-local object database and describe how git must read it. */
export function prepareWorktreeObjects(cwd: string): WorktreeObjectEnvironment {
  const paths = linkedWorktreePaths(cwd)
  if (!paths) throw new Error(`cannot isolate git objects: ${cwd} is not a linked worktree`)
  mkdirSync(paths.objects, { recursive: true })
  return worktreeGitEnvironment(cwd)!
}

export type OrphanSafety = {
  removable: boolean
  branch: string
  detail: string
}

export const ORCH_RUN_MARKER = '.orch-run'

/** Mark a tree as orch-owned without asking the project to track orch metadata. */
function markWorktree(path: string, runId: number, repoRoot: string): void {
  writeFileSync(join(path, ORCH_RUN_MARKER), `${runId}\n${repoRoot}\n`)
  const exclude = resolve(path, git(['rev-parse', '--git-path', 'info/exclude'], path))
  const existing = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!existing.split('\n').includes(ORCH_RUN_MARKER)) {
    appendFileSync(exclude, `${existing && !existing.endsWith('\n') ? '\n' : ''}${ORCH_RUN_MARKER}\n`)
  }
}

/** Recognise current markers and the naming schemes used before markers existed. */
export function isOrchWorktree(path: string, branchTemplate?: string): boolean {
  if (existsSync(join(path, ORCH_RUN_MARKER))) return true
  const name = basename(path)
  if (/^orch-\d+$/.test(name)) return true
  if (!branchTemplate?.includes('{id}')) return false
  const templateName = basename(branchTemplate)
  const pattern = templateName
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{id\\\}/g, '\\d+')
    .replace(/\\\{key\\\}/g, '[^/]+')
  return new RegExp(`^${pattern}$`).test(name)
}

/**
 * Prove that an unremembered tree contains nothing the main checkout cannot
 * reproduce before sweep is allowed to remove it.
 *
 * An absent database pointer means orch knows LESS about this directory, not
 * more. Clean files alone are insufficient: the branch may carry commits that
 * have never reached trunk. Conversely, ancestry alone misses uncommitted and
 * untracked files. Every failed git query is therefore a reason to keep the
 * tree; uncertainty is not evidence that it is disposable.
 */
export function orphanSafety(path: string, repoRoot: string, trunk: string): OrphanSafety {
  const listed = gitOk(['worktree', 'list', '--porcelain'], repoRoot)
  const actual = existsSync(path) ? realpathSync(path) : path
  const registered = listed?.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .some((candidate) => existsSync(candidate) && realpathSync(candidate) === actual)
  if (!registered) {
    return { removable: false, branch: '', detail: 'not a registered git worktree' }
  }

  const dirty = gitOk(['status', '--porcelain', '--untracked-files=all'], path)
  if (dirty === null) return { removable: false, branch: '', detail: 'could not inspect changes' }
  if (dirty) return { removable: false, branch: '', detail: 'has uncommitted changes' }

  const head = gitOk(['rev-parse', 'HEAD'], path)
  if (!head) return { removable: false, branch: '', detail: 'could not identify HEAD' }
  if (gitOk(['rev-parse', '--verify', trunk], repoRoot) === null) {
    return { removable: false, branch: '', detail: `cannot prove reachability: ${trunk} is missing` }
  }
  if (gitOk(['merge-base', '--is-ancestor', head, trunk], repoRoot) === null) {
    return { removable: false, branch: '', detail: `has commits not reachable from ${trunk}` }
  }

  const branch = gitOk(['symbolic-ref', '--quiet', '--short', 'HEAD'], path) ?? ''
  return { removable: true, branch, detail: `clean and HEAD is reachable from ${trunk}` }
}

/**
 * Cut a worktree for one run.
 *
 * Named by run id, which makes the mapping between a row and a directory
 * total in both directions: no run owns two worktrees and no worktree is
 * orphaned from its row. A timestamp or a slug would read better and would not
 * survive two runs of the same job in the same minute.
 *
 * The caller's visible state is transferred after creation by
 * `carryWorkingState`; cutting the directory is only the first half of setup.
 */
/**
 * Fill a project's command template and run it.
 *
 * `sh -c`, deliberately: these templates are written by whoever registered the
 * project, they are configuration rather than input, and they need a shell
 * because that is how their own documentation spells them
 * (`WORKTREE_SEED=... scripts/worktree add ...`). Anything reaching here that
 * a stranger could influence would be a different problem entirely — a project
 * row is as trusted as the code in the checkout it points at.
 */
function runTool(
  template: string, vars: Record<string, string>, cwd: string,
): { ok: boolean; out: string; stdout: string } {
  const cmd = fillTool(template, vars)
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stdout = p.stdout.toString()
  const out = `${stdout}${p.stderr.toString()}`.trim()
  return { ok: p.exitCode === 0, out, stdout }
}

/** Fill a trusted project command without running it. */
export function fillTool(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, k: string, offset: number) => {
    const value = vars[k] ?? ''
    let quote: "'" | '"' | null = null
    for (let i = 0; i < offset; i++) {
      const char = template[i]
      if (char === '\\' && quote !== "'") {
        i++
      } else if (char === "'" && quote !== '"') {
        quote = quote === "'" ? null : "'"
      } else if (char === '"' && quote !== "'") {
        quote = quote === '"' ? null : '"'
      }
    }
    if (quote === "'") return value.replace(/'/g, "'\\''")
    if (quote === '"') return value.replace(/[\\"$`]/g, '\\$&')
    return `'${value.replace(/'/g, "'\\''")}'`
  })
}

/** Resolve a caller's base before any worktree or run row is created. */
export function resolveBase(cwd: string, ref: string): string {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  return git(['rev-parse', '--verify', ref], repoRoot)
}

/** The project's own worktree tool, if it declared one. */
export function toolFor(cwd: string): WorktreeTool | null {
  return projectAt(cwd)?.settings.worktree ?? null
}

/**
 * Cut a worktree using the PROJECT'S OWN tool.
 *
 * Not an optimisation and not politeness. In these repositories a checkout is a
 * running application — a generated `.env`, a cloned vendor tree, a database at
 * a chosen size, a port, a queue worker — and their own script says what a bare
 * `git worktree add` leaves you with: no .env, no vendor, compose interpolating
 * to nothing, and not one quality gate able to run. A worker handed that
 * directory runs tests that are meaningless and reports them green.
 *
 * The seed is REQUIRED where the project lists seeds, because the project
 * requires it — one application removed its default after discovering the default was
 * silent and left every business table empty. orch will not reinstate by
 * omission a default that was deliberately removed.
 */
export function createWithTool(
  tool: WorktreeTool, cwd: string, runId: number, seed?: string, key?: string, baseRef?: string,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  if (tool.seeds?.length && !seed) {
    throw new Error(
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed ${tool.seeds.join('\n  --seed ')}\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
  }
  // The project's own naming rule wins where it has one. `orch/<id>` is fine
  // where nothing enforces a convention and is refused outright where something
  // does — imposing our name on a repository whose tooling reads branch names
  // is the mistake delegating the lifecycle was meant to stop.
  /**
   * A RECIPE builds the tree here; a COMMAND hands it to the project's script.
   *
   * Both end with a fully provisioned worktree and differ only in who does the
   * provisioning. A project that already has a script keeps it — nothing here
   * is better than several hundred lines written against that project's actual
   * infrastructure. A project that has none declares what it needs and never
   * writes the script at all, which is the point.
   */
  if (!tool.create) {
    if (!tool.recipe) {
      throw new Error(
        "this project's worktree settings declare neither `create` nor `recipe`",
      )
    }
    return createFromRecipe(tool, tool.recipe, repoRoot, runId, key, baseRef)
  }

  if (baseRef && !tool.create.includes('{base}')) {
    throw new Error(
      `this project's command-based worktree path cannot honor --base because its create ` +
      `template does not contain {base}`,
    )
  }

  const branch = (tool.branch ?? 'orch/{id}')
    .replace(/\{id\}/g, String(runId))
    .replace(/\{key\}/g, key ?? '')
  const name = `orch-${runId}`
  // A command tool receives the caller's base only through {base}; the guard
  // above refuses an explicit base when the template has no way to receive it.
  // Without an explicit request, some tools deliberately resolve their own
  // floor; HEAD is only the template default, and the created tree is inspected
  // below before its base is recorded.
  const base = baseRef && tool.create.includes('{base}')
    ? resolveBase(repoRoot, baseRef)
    : git(['rev-parse', 'HEAD'], repoRoot)
  const vars = { branch, name, base, seed: seed ?? '', key: key ?? '', path: '' }
  const r = runTool(tool.create, vars, repoRoot)
  if (!r.ok) throw new Error(`the project's worktree tool failed:\n${r.out.slice(-1500)}`)

  /**
   * A successful project tool may still fail orch's postconditions. At that
   * point the tree, branch and database belong to the project's lifecycle and
   * are deliberately left intact: uncertainty is exactly when automatic
   * teardown has lost work. Every such error therefore carries the branch and
   * the project's ready-to-paste remove command.
   */
  const leftover = (path: string) => {
    const remove = tool.remove
      ? fillTool(tool.remove, { ...vars, path })
      : '(project declares no remove command)'
    return `\nThe project created branch ${branch} and may have provisioned resources.\n` +
      `Remove them when you have inspected the tree:\n  ${remove}`
  }

  /**
   * WHERE IT PUT THE WORKTREE is read from the tool's LAST LINE, not hunted for.
   *
   * This used to take the last path-looking line that happened to exist
   * anywhere in the output, which is how a run in one application came back owning
   * `.claude/worktrees/STAR-5084` — a directory belonging to the session's own
   * task, matched out of progress output because the create template printed no
   * path of its own. Three runs then shared one tree and a fourth worked in it.
   *
   * So a project's `create` must END by printing its path, and that is the line
   * taken. A tool that logs progress sends it to stderr, which these templates
   * now do.
   *
   * The last line OF STDOUT, and that qualifier is the whole fix for run 735.
   * one project's tool did exactly what is asked: the path on stdout, progress on
   * stderr. This read the last line of stdout and stderr joined together,
   * with stderr second — so the line it saw was `✓ task status not written`,
   * not a path, and it fell back to `orch-735`, a directory nothing had made.
   * A tool that separates its streams properly must not lose to one that
   * does not; the streams are read apart.
   */
  const lastLine = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  /**
   * Prefer what the tool printed over anything we compute.
   *
   * A project that knows where it puts its worktrees should not be
   * second-guessed by a join against our idea of the layout. An absolute
   * last line is that path, even if it does not exist yet — the check
   * below then names the path the tool claimed, not a nested guess.
   * A relative last line is resolved against the MAIN checkout, and only
   * trusted if that directory is actually there, so a progress line is
   * not mistaken for a path.
   */
  const printed = lastLine ? join(repoRoot, lastLine) : ''
  const path = lastLine.startsWith('/')
    ? lastLine
    : printed && existsSync(printed)
      ? printed
      : join(repoRoot, '.claude', 'worktrees', name)
  if (!existsSync(path)) {
    throw new Error(
      `the project's worktree tool reported success but ${path} does not exist.\n` +
      `Its create command must print the worktree path as the last line of stdout.\n${r.out.slice(-800)}` +
      leftover(path),
    )
  }

  /**
   * EACH RUN GETS ITS OWN TREE. A shared one is refused, not tolerated.
   *
   * A project's script may name a directory from the ticket key rather than
   * from the run, so two runs carrying the same `--key` can be handed the same
   * directory — and the second would edit the first's work in place, with the
   * diffs of both interleaved beyond separating. The `discard` guard added
   * earlier stops orch DELETING a shared tree; this stops one being handed out
   * in the first place, which is the failure that matters.
   *
   * Read-only jobs never reach here: they get no worktree at all, and need
   * none.
   */
  const owner = db().query(
    `SELECT id FROM run WHERE worktree = ? AND status IN ('running','asking') LIMIT 1`,
  ).get(path) as { id: number } | null
  if (owner) {
    throw new Error(
      `the project's worktree tool returned ${path}, which run ${owner.id} is still using.\n` +
      `Each run needs its own tree. Check that this project's branch template makes the\n` +
      `directory unique per run — a template keyed only on a ticket collides on the second.` +
      leftover(path),
    )
  }
  // A command without {base} may deliberately choose its own floor. Read the
  // commit from the tree it actually created so the run record and every later
  // diff name that floor rather than the caller checkout's incidental HEAD.
  const actualBase = gitOk(['rev-parse', 'HEAD'], path) ?? base
  markWorktree(path, runId, repoRoot)
  return { path, branch, base: actualBase, repoRoot }
}

export function createWorktree(cwd: string, runId: number, baseRef?: string): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)

  const base = baseRef ? resolveBase(repoRoot, baseRef) : git(['rev-parse', 'HEAD'], repoRoot)
  const dir = join(repoRoot, '.claude', 'worktrees')
  mkdirSync(dir, { recursive: true })

  const branch = `orch/${runId}`
  const path = join(dir, `orch-${runId}`)
  if (existsSync(path)) {
    throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  }
  git(['worktree', 'add', '-b', branch, path, base], repoRoot)
  markWorktree(path, runId, repoRoot)
  return { path, branch, base, repoRoot }
}

/**
 * Put the caller's complete visible git state into a newly cut tree.
 *
 * The patch is against the destination's actual base, not necessarily the
 * caller's HEAD. That matters for project-owned worktree tools which choose
 * their own floor: the resulting tracked files still exactly match what the
 * caller was looking at, including committed branch work, staged changes,
 * unstaged changes, deletions and binary files. Untracked, non-ignored paths
 * are copied separately because no git diff can contain them.
 *
 * Ignored files are deliberately left to the project's worktree recipe. They
 * are environment (dependencies, databases, generated .env files), not review
 * input, and copying them would both defeat provisioning and turn one checkout's
 * runtime state into another's.
 */
export function carryWorkingState(cwd: string, worktree: Worktree): void {
  const patch = gitBytes(['diff', '--binary', '--full-index', worktree.base, '--'], cwd)
  if (patch.byteLength) gitInput(['apply', '--binary', '--whitespace=nowarn', '-'], worktree.path, patch)

  const untracked = gitBytes(['ls-files', '--others', '--exclude-standard', '-z'], cwd).toString()
    .split('\0').filter(Boolean)
  const otherWorktrees = (gitOk(['worktree', 'list', '--porcelain'], cwd) ?? '')
    .split('\n').filter((line) => line.startsWith('worktree '))
    .map((line) => realpathSync(line.slice('worktree '.length)))
    .filter((path) => path !== realpathSync(cwd))
  for (const relative of untracked) {
    const source = join(cwd, relative)
    const absoluteSource = realpathSync(source)
    if (otherWorktrees.some((path) => absoluteSource === path || path.startsWith(`${absoluteSource}/`))) {
      continue
    }
    const destination = join(worktree.path, relative)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true })
  }
}

/**
 * Build a worktree from a declaration, doing what a project's script would.
 *
 * Torn down on ANY failure, and that is not tidiness. A half-provisioned tree —
 * dependencies installed, database missing — is the single worst outcome here:
 * a worker runs the suite in it, the suite passes against nothing, and the run
 * comes back green. Better no worktree and a named failure.
 */
function createFromRecipe(
  tool: WorktreeTool, recipe: Recipe, repoRoot: string, runId: number, key?: string,
  baseRef?: string,
): Worktree {
  const branch = (tool.branch ?? 'orch/{id}')
    .replace(/\{id\}/g, String(runId))
    .replace(/\{key\}/g, key ?? '')
  const name = `orch-${runId}`
  const dir = join(repoRoot, '.claude', 'worktrees')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  if (existsSync(path)) {
    throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  }

  // An explicit caller base wins. Without one, the base is the project's to
  // choose: two of these repos branch from origin/develop and one from local
  // HEAD, and branching from the wrong one hands a worker a tree the spec does
  // not describe.
  const base = baseRef
    ? resolveBase(repoRoot, baseRef)
    : recipe.baseRef
    ? (gitOk(['rev-parse', recipe.baseRef], repoRoot) ?? git(['rev-parse', 'HEAD'], repoRoot))
    : git(['rev-parse', 'HEAD'], repoRoot)

  git(['worktree', 'add', '-b', branch, path, base], repoRoot)
  const w: Worktree = { path, branch, base, repoRoot }
  markWorktree(path, runId, repoRoot)

  const dbName = dbNameFor(repoRoot.split('/').pop() ?? 'app', runId)
  const steps = runRecipe(recipe, path, dbName, String(recipe.serve ? portFor(runId) : ''))
  const failed = steps.find((r) => !r.ok)
  if (failed) {
    removeFor(w, repoRoot)
    throw new Error(
      `worktree setup failed at "${failed.step}":\n${failed.detail.slice(-1200)}`,
    )
  }
  return w
}

/**
 * A port nothing else on this machine is using, derived from the run id.
 *
 * Derived rather than allocated, so it is the same on every read — a caller
 * that has to ask twice must get the same answer, or a worker serves on one
 * port and something else fetches from another. The range is high enough to
 * miss the usual development ports and wide enough that collisions between
 * concurrent runs are rare rather than impossible; a project needing a
 * guaranteed-free port allocates its own in its recipe.
 */
export function portFor(runId: number): number {
  return 21000 + (runId % 4000)
}

export type Changes = {
  /** The unified diff against the base commit, including files never added. */
  diff: string
  /** Paths the worker touched, so scope can be checked without reading the diff. */
  files: string[]
  insertions: number
  deletions: number
}

/**
 * What the worker actually changed.
 *
 * `git add -A` first, then diff against the base. Staging is what makes
 * UNTRACKED files visible: a plain `git diff` shows nothing for a brand new
 * file, so a worker whose whole job was to add one would report an empty
 * change set and look like it had done nothing. That is the single most likely
 * way this could silently under-report, so it is handled first rather than
 * discovered later.
 *
 * Staging is not committing. The index is scratch state inside a throwaway
 * checkout; nothing here writes a commit, and the branch stays exactly as
 * `createWorktree` left it.
 */
export function changesIn(w: Worktree): Changes {
  git(['add', '-A'], w.path)
  // Raw: this is a patch, and `git apply` counts its bytes.
  const diff = gitRaw(['diff', '--cached', w.base], w.path)
  const names = gitOk(['diff', '--cached', '--name-only', w.base], w.path) ?? ''
  const stat = gitOk(['diff', '--cached', '--numstat', w.base], w.path) ?? ''

  let insertions = 0
  let deletions = 0
  for (const line of stat.split('\n')) {
    const [add, del] = line.split('\t')
    // A binary file reports '-' for both. Counting those as zero is right:
    // they are real changes and they have no line count, and inventing one
    // would put noise into a number the fidelity check reads.
    insertions += Number(add) || 0
    deletions += Number(del) || 0
  }
  return {
    diff,
    files: names ? names.split('\n').filter(Boolean) : [],
    insertions,
    deletions,
  }
}

/**
 * Delete a worktree and its branch.
 *
 * `--force` because the tree is dirty by construction — the worker's changes
 * are staged and uncommitted, which is exactly what git refuses to discard
 * without being told to. That is the right default for git and the wrong one
 * here: the whole point of the directory is that it is disposable, and a
 * removal that silently fails leaves the run's changes on disk with nothing
 * pointing at them.
 *
 * Never called automatically on failure. A failed implementation run is the
 * case where the half-finished tree is most worth reading, and a cleanup that
 * ran on error would destroy the evidence at precisely the moment it mattered.
 * `orch discard` is a decision someone makes.
 */
/**
 * Take one down with the project's own tool, so its INFRASTRUCTURE goes too.
 *
 * The directory is the cheap part. What actually accumulates is everything the
 * setup provisioned behind it — a database of up to a few gigabytes, a
 * container, a port reservation, a queue worker — and `git worktree remove`
 * knows about none of that. Removing the directory without calling the tool is
 * how a machine fills up with databases nobody can name.
 */
export function removeWithTool(
  tool: WorktreeTool, w: Worktree, ): { removed: boolean; detail: string } {
  const name = w.path.split('/').pop() ?? w.path

  // A recipe-built tree is torn down the same way it was made: bottega
  // provisioned the database, so bottega drops it. Done BEFORE the directory
  // goes, because a compose file that lives in the worktree cannot bring
  // anything down once the worktree has been deleted.
  if (!tool.remove) {
    if (tool.recipe) {
      const runId = Number(name.replace(/^orch-/, '')) || 0
      const dbName = dbNameFor(w.repoRoot.split('/').pop() ?? 'app', runId)
      const cwd = existsSync(w.path) ? w.path : w.repoRoot
      for (const step of teardownRecipe(
        tool.recipe, cwd, dbName, String(tool.recipe.serve ? portFor(runId) : ''),
      )) {
        if (!step.ok) console.error(`orch: ${step.step} failed: ${step.detail.slice(-200)}`)
      }
    }
    return removeWorktree(w)
  }

  const r = runTool(tool.remove, { name, branch: w.branch, path: w.path }, w.repoRoot)
  if (r.ok && !existsSync(w.path)) return { removed: true, detail: w.path }

  /**
   * A PROJECT'S REFUSAL IS FINAL. Never retry with force.
   *
   * This used to fall through to plain `git worktree remove --force` when the
   * tool exited non-zero, which is the ordinary orchestrator mistake and the
   * dangerous one: the refusals fire in exactly the case where the work is
   * irreplaceable. One project's tool will not remove a tree with uncommitted changes
   * without `--force`, and uses `git branch -d` so an unmerged branch survives
   * — both deliberate, because a leftover branch is recoverable and a deleted
   * one is not. Our worker contract scopes a worker to commit-only, so a dirty
   * tree it left behind may be the ONLY copy of what it did.
   *
   * Forcing past that automatically is the same class of act as a worker
   * pushing its own change: a destructive decision belonging to the architect,
   * taken by machinery on their behalf. So the refusal is surfaced instead. A
   * leftover worktree costs a directory and a database name, and the project's
   * own sweep reclaims the database later anyway.
   */
  return {
    removed: false,
    detail:
      `${w.path} was NOT removed — the project's own tool refused, and orch will not ` +
      `force past that:\n${r.out.slice(-600) || `exit code from ${tool.remove}`}\n\n` +
      `Those refusals guard uncommitted work and unmerged branches. Look before overriding.`,
  }
}

/** Remove a tree through the lifecycle declared by its registered project. */
export function removeFor(w: Worktree, repoRoot: string): { removed: boolean; detail: string } {
  const tool = projectAt(repoRoot)?.settings.worktree
  return tool ? removeWithTool(tool, w) : removeWorktree(w)
}

/** Reclaim orphans the project knows about — databases, containers, metadata. */
export function sweepWithTool(tool: WorktreeTool, repoRoot: string): string {
  if (!tool.sweep) return ''
  return runTool(tool.sweep, {}, repoRoot).out
}

export function removeWorktree(w: Worktree): { removed: boolean; detail: string } {
  // Already gone is a SUCCESS, not an error. A worktree deleted by hand, or one
  // in a scratch repository that has since been cleaned up, leaves a database
  // pointer that ought to be clearable — refusing would strand it for ever.
  if (!existsSync(w.path)) {
    gitOk(['worktree', 'prune'], w.repoRoot)
    return { removed: true, detail: `${w.path} was already gone` }
  }
  // REPORTED, not swallowed. This function's own comment says a removal that
  // silently fails leaves the run's changes on disk with nothing pointing at
  // them — and then it discarded git's answer, after which `orch discard`
  // cleared the database pointer and said "discarded". A locked or busy
  // worktree produced exactly the orphan the comment warned about, announced
  // as a success.
  const gone = gitOk(['worktree', 'remove', '--force', w.path], w.repoRoot) !== null
  gitOk(['branch', '-D', w.branch], w.repoRoot)
  // Prunes the administrative record if the directory went missing by other
  // means, so `git worktree list` does not accumulate ghosts.
  gitOk(['worktree', 'prune'], w.repoRoot)
  return gone || !existsSync(w.path)
    ? { removed: true, detail: w.path }
    : { removed: false, detail: `git could not remove ${w.path}; it is still on disk` }
}

/** Delete a local branch when it exists, reporting whether there was work to do. */
export function removeBranch(repoRoot: string, branch: string): boolean {
  if (gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot) === null) {
    return false
  }
  git(['branch', '-D', branch], repoRoot)
  return true
}

export type UnmergedBranch = { count: number; tip: string }

/** Commits a local branch has that the project's trunk does not. */
export function unmergedBranch(
  repoRoot: string, branch: string, trunk: string,
): UnmergedBranch | null {
  const ref = `refs/heads/${branch}`
  if (gitOk(['show-ref', '--verify', '--quiet', ref], repoRoot) === null) return null
  const tip = git(['rev-parse', ref], repoRoot)
  const count = Number(git(['rev-list', '--count', `${trunk}..${ref}`], repoRoot))
  return count > 0 ? { count, tip } : null
}

/** Restore a protected branch if a project's removal command deleted it. */
export function restoreBranch(repoRoot: string, branch: string, tip: string): void {
  if (gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot) === null) {
    git(['branch', branch, tip], repoRoot)
  }
}
