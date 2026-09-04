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
 * WHAT THIS DELIBERATELY DOES NOT DO ITSELF: commit, push, or merge. The worker's
 * contract governs those operations. Implement and fix workers may commit on
 * their own run branch and leave all changes there for the architect to judge
 * through `orch diff`; a land worker alone may fast-forward trunk from its
 * disposable worktree. No worker pushes.
 */
import { accessSync, appendFileSync, closeSync, constants, cpSync, existsSync,
         fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
         realpathSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { db, pidAlive, ROOT } from './db.ts'
import { createHasPlaceholder, projectAt, type WorktreeCreate, type WorktreeTool } from './projects.ts'
import { runRecipe, teardownRecipe, dbNameFor, type Recipe } from './recipe.ts'
import { mainCheckoutOf } from '../../shared/git.ts'

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

export type SharedRefGuardEnvironment = {
  GIT_CONFIG_COUNT: string
  GIT_CONFIG_KEY_0: string
  GIT_CONFIG_VALUE_0: string
  ORCH_GUARDED_GIT_COMMON_DIR: string
  ORCH_ALLOWED_GIT_REF?: string
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

/** Measure the checkout's complete visible content without touching its index. */
export function contentTree(cwd: string): string {
  const temporary = join(tmpdir(), `orch-index-${process.pid}-${randomUUID()}`)
  mkdirSync(temporary, { recursive: true })
  const index = join(temporary, 'index')
  const env = { ...process.env, ...worktreeGitEnvironment(cwd), GIT_INDEX_FILE: index }
  try {
    const read = Bun.spawnSync(['git', 'read-tree', 'HEAD'], {
      cwd, env, stdout: 'pipe', stderr: 'pipe',
    })
    if (read.exitCode !== 0) {
      throw new Error(`git read-tree HEAD failed while measuring content tree: ${read.stderr.toString().trim() || `exit ${read.exitCode}`}`)
    }
    const add = Bun.spawnSync(['git', 'add', '-A', '.'], {
      cwd, env, stdout: 'pipe', stderr: 'pipe',
    })
    if (add.exitCode !== 0) {
      throw new Error(`git add -A . failed while measuring content tree: ${add.stderr.toString().trim() || `exit ${add.exitCode}`}`)
    }
    const write = Bun.spawnSync(['git', 'write-tree'], {
      cwd, env, stdout: 'pipe', stderr: 'pipe',
    })
    if (write.exitCode !== 0) {
      throw new Error(`git write-tree failed while measuring content tree: ${write.stderr.toString().trim() || `exit ${write.exitCode}`}`)
    }
    return write.stdout.toString().trim()
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Read repository configuration without inheriting the worker config we return below. */
function gitConfigOk(args: string[], cwd: string): string | null {
  if (cwdMissing(cwd)) return null
  const p = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_COUNT: '0', ...worktreeGitEnvironment(cwd) },
    stdout: 'pipe', stderr: 'pipe',
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
  return mainCheckoutOf(cwd, worktreeGitEnvironment(cwd))
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

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const WORKTREE_CREATE_LOCK_TIMEOUT_MS = 5 * 60_000
const WORKTREE_CREATE_LOCK_POLL_MS = 100
const heldProjectLocks = new Set<string>()

export type ProjectLockIdentity = {
  session: string | null
  what: string
}

export type ProjectLockParticipant = ProjectLockIdentity & {
  pid: number
  since: string
}

export type ProjectLockState = {
  path: string
  holder: ProjectLockParticipant | null
  waiters: ProjectLockParticipant[]
}

function projectLockParticipant(path: string): ProjectLockParticipant | null {
  let value: string
  try { value = readFileSync(path, 'utf8').trim() } catch { return null }
  if (/^\d+$/.test(value)) {
    const pid = Number(value)
    return Number.isSafeInteger(pid) && pid > 0
      ? { pid, session: null, what: 'worktree creation', since: new Date(0).toISOString() }
      : null
  }
  try {
    const parsed = JSON.parse(value) as Partial<ProjectLockParticipant>
    return Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0 &&
      typeof parsed.what === 'string' && typeof parsed.since === 'string'
      ? { pid: Number(parsed.pid), session: typeof parsed.session === 'string' ? parsed.session : null,
          what: parsed.what, since: parsed.since }
      : null
  } catch { return null }
}

function projectLockPaths(repoRoot: string, name: string): {
  lock: string; owner: string; waiters: string
} {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid project lock name: ${name}`)
  const common = realpathSync(resolve(repoRoot, git(['rev-parse', '--git-common-dir'], repoRoot)))
  const lock = join(common, `orch-${name}.lock`)
  return { lock, owner: join(lock, 'owner'), waiters: join(common, `orch-${name}.waiters`) }
}

/** Read coordination state without acquiring or changing the lock. */
export function projectLockState(repoRoot: string, name: string): ProjectLockState {
  const paths = projectLockPaths(repoRoot, name)
  const waiters = existsSync(paths.waiters)
    ? readdirSync(paths.waiters).flatMap((entry) => {
        const participant = projectLockParticipant(join(paths.waiters, entry))
        return participant && pidAlive(participant.pid) ? [participant] : []
      }).sort((a, b) => a.since.localeCompare(b.since))
    : []
  return { path: paths.lock, holder: projectLockParticipant(paths.owner), waiters }
}

/**
 * The mkdir lock shared by repository-wide operations.
 *
 * Names keep unrelated resources separate while retaining the proven atomic
 * acquisition, bounded wait and dead-owner reclamation used for worktrees.
 */
export function withProjectLock<T>(
  repoRoot: string, name: string, identity: ProjectLockIdentity, action: () => T,
  timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS, exposeWaiters = false,
): T {
  const paths = projectLockPaths(repoRoot, name)
  if (heldProjectLocks.has(paths.lock)) return action()
  const participant: ProjectLockParticipant = {
    pid: process.pid, session: identity.session, what: identity.what, since: new Date().toISOString(),
  }
  const waiter = join(paths.waiters, `${process.pid}-${randomUUID()}`)
  if (exposeWaiters) {
    mkdirSync(paths.waiters, { recursive: true })
    writeFileSync(waiter, `${JSON.stringify(participant)}\n`)
  }
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))

  try {
    while (true) {
      try {
        mkdirSync(paths.lock)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        const held = projectLockParticipant(paths.owner)
        if (held !== null && !pidAlive(held.pid)) {
          const stale = `${paths.lock}.stale-${process.pid}-${randomUUID()}`
          try { renameSync(paths.lock, stale) } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue
            throw renameError
          }
          const label = name === 'worktree-create' ? 'worktree creation' : name
          console.error(`orch: reclaimed ${label} lock from dead holder pid ${held.pid}: ${paths.lock}`)
          rmSync(stale, { recursive: true, force: true })
          continue
        }
        if (Date.now() >= deadline) {
          const heldFor = held ? Math.max(0, Date.now() - Date.parse(held.since)) : null
          const detail = name === 'worktree-create'
            ? (held ? ` (holder pid ${held.pid})` : '')
            : (held ? ` (holder session ${held.session ?? 'unknown'}, pid ${held.pid}, ` +
                `landing ${held.what}, held for ${Math.round(heldFor! / 1000)}s)` : '')
          const label = name === 'worktree-create' ? 'worktree creation' : name
          throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ` +
            `this project's ${label} lock${detail}: ${paths.lock}`)
        }
        Atomics.wait(sleeper, 0, 0, WORKTREE_CREATE_LOCK_POLL_MS)
        continue
      }
      try {
        const holder = { ...participant, since: new Date().toISOString() }
        writeFileSync(paths.owner, `${JSON.stringify(holder)}\n`)
        heldProjectLocks.add(paths.lock)
        if (exposeWaiters) rmSync(waiter, { force: true })
        break
      } catch (e) {
        rmSync(paths.lock, { recursive: true, force: true })
        throw e
      }
    }

    try { return action() } finally {
      heldProjectLocks.delete(paths.lock)
      rmSync(paths.lock, { recursive: true, force: true })
    }
  } finally {
    if (exposeWaiters) rmSync(waiter, { force: true })
  }
}

/**
 * Serialize the whole worktree lifecycle for one repository across orch processes.
 *
 * The directory creation is the lock operation: mkdir is atomic even when the
 * contenders are unrelated processes. The lock lives in the common git directory,
 * so callers from the main checkout and any linked worktree contend on the same
 * path, while unrelated projects do not. It deliberately surrounds project tools
 * and recipes as well as orch's own git calls; a fetch inside a project recipe was
 * the operation that exposed the original race.
 */
export function withWorktreeCreateLock<T>(
  repoRoot: string, create: () => T, timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS,
): T {
  return withProjectLock(repoRoot, 'worktree-create',
    { session: null, what: 'worktree creation' }, create, timeoutMs)
}

const REF_GUARD_WRAPPER_MARKER = '# orch shared-ref guard wrapper\n'

function sharedRefGuardWrapper(hookDir: string, guard: string, original: string): string {
  const guardMarker = Buffer.from(guard).toString('base64')
  const originalMarker = Buffer.from(original).toString('base64')
  return `#!/bin/sh\n${REF_GUARD_WRAPPER_MARKER}# guard-hook-base64: ${guardMarker}\n# original-hook-base64: ${originalMarker}\nset -eu\nprotected_common=\${ORCH_GUARDED_GIT_COMMON_DIR:-}\n[ -n "$protected_common" ] || exit 0\ncurrent_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0\ncurrent_common=$(cd "$current_common" 2>/dev/null && pwd -P) || exit 0\n[ "$current_common" = "$protected_common" ] || exit 0\ninput=${shellQuote(join(hookDir, '.reference-transaction-input'))}.$$\ntrap 'rm -f "$input"' EXIT HUP INT TERM\ncat > "$input"\n${shellQuote(guard)} "$@" < "$input"\n${shellQuote(original)} "$@" < "$input"\n`
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

type InstalledRefGuard = {
  kind: 'guard' | 'wrapper'
  content: Buffer
  executable: boolean
  wrappedGuard?: string
  original?: string
}

function sameFileBytes(left: string, right: string): boolean {
  try { return readFileSync(left).equals(readFileSync(right)) } catch { return false }
}

function installedRefGuard(installed: string, guard: string): InstalledRefGuard | null {
  if (!pathEntryExists(installed)) return null
  let executable: boolean
  let content: Buffer
  try {
    accessSync(installed, constants.X_OK)
    executable = true
    content = readFileSync(installed)
  } catch {
    try {
      content = readFileSync(installed)
      executable = false
    } catch {
      return null
    }
  }
  if (sameFileBytes(installed, guard)) {
    return { kind: 'guard', content, executable }
  }
  const text = content.toString()
  const marker = text.match(/^#!\/bin\/sh\n# orch shared-ref guard wrapper\n# guard-hook-base64: ([A-Za-z0-9+/=]+)\n# original-hook-base64: ([A-Za-z0-9+/=]+)\n/)
  if (!marker) return null
  const wrappedGuard = Buffer.from(marker[1]!, 'base64').toString()
  const original = Buffer.from(marker[2]!, 'base64').toString()
  if (!sameFileBytes(wrappedGuard, guard)) return null
  try { accessSync(wrappedGuard, constants.X_OK) } catch { return null }
  return text === sharedRefGuardWrapper(dirname(installed), wrappedGuard, original)
    ? { kind: 'wrapper', content, executable, wrappedGuard, original }
    : null
}

const REF_GUARD_STAGE_PREFIX = '.orch-hooks-'

function refGuardCheckpoint(name: string): void {
  if (process.env.ORCH_TEST_REF_GUARD_CHECKPOINT !== name) return
  const ready = process.env.ORCH_TEST_REF_GUARD_READY
  if (!ready) return
  writeFileSync(ready, `${name}\n`)
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
}

function cleanupRefGuardLitter(gitDir: string, hookDir?: string): void {
  for (const name of readdirSync(gitDir)) {
    if (!name.startsWith(REF_GUARD_STAGE_PREFIX)) continue
    const pid = Number(name.slice(REF_GUARD_STAGE_PREFIX.length).split('-', 1)[0])
    if (Number.isInteger(pid) && pidAlive(pid)) continue
    rmSync(join(gitDir, name), { recursive: true, force: true })
  }
  if (!hookDir || !pathEntryExists(hookDir) || !lstatSync(hookDir).isDirectory()) return
  for (const name of readdirSync(hookDir)) {
    const temporary = name.match(/^\.reference-transaction-(\d+)-/)
    if (!temporary) continue
    if (temporary && pidAlive(Number(temporary[1]))) continue
    rmSync(join(hookDir, name), { recursive: true, force: true })
  }
}

function stageRefGuardDirectory(
  gitDir: string, hookDir: string, guard: string, wrapper: string | null,
): void {
  const stage = join(gitDir, `${REF_GUARD_STAGE_PREFIX}${process.pid}-${randomUUID()}`)
  const staged = join(stage, 'reference-transaction')
  let fd: number | null = null
  try {
    mkdirSync(stage)
    refGuardCheckpoint('mkdir')
    cleanupRefGuardLitter(gitDir)
    refGuardCheckpoint('cleanup')
    fd = openSync(staged, 'wx', 0o600)
    refGuardCheckpoint('temporary-open')
    writeFileSync(fd, wrapper ?? readFileSync(guard))
    refGuardCheckpoint('write')
    fchmodSync(fd, 0o755)
    refGuardCheckpoint('chmod')
    fsyncSync(fd)
    refGuardCheckpoint('fsync')
    closeSync(fd)
    fd = null
    refGuardCheckpoint('close')
    const directoryFd = openSync(stage, constants.O_RDONLY)
    try {
      fsyncSync(directoryFd)
    } finally { closeSync(directoryFd) }
    renameSync(stage, hookDir)
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(stage, { recursive: true, force: true })
  }
}

function verifiedSharedRefGuardEnvironment(
  paths: { commonDir: string }, hookDir: string, guard: string, allowedRef?: string,
): SharedRefGuardEnvironment {
  const installed = join(hookDir, 'reference-transaction')
  const verified = installedRefGuard(installed, guard)
  if (!verified?.executable) {
    throw new Error(
      `refusing to expose unverified shared ref guard hooks path: ${hookDir}`,
    )
  }
  return sharedRefGuardEnvironment(paths, hookDir, allowedRef)
}

/** Install the ref-update boundary without changing the shared repository config. */
export function prepareSharedRefGuard(
  cwd: string, allowedRef?: string,
): SharedRefGuardEnvironment {
  const paths = linkedWorktreePaths(cwd)
  if (!paths) throw new Error(`cannot guard shared refs: ${cwd} is not a linked worktree`)
  const hookDir = join(paths.gitDir, 'orch-hooks')
  if (pathEntryExists(hookDir) && realpathSync(hookDir) !== resolve(hookDir)) {
    throw new Error(`refusing shared ref guard hook directory symlink: ${hookDir}`)
  }
  cleanupRefGuardLitter(paths.gitDir, hookDir)

  const configured = gitConfigOk(['config', '--path', 'core.hooksPath'], cwd)
  const originalDir = configured
    ? (configured.startsWith('/') ? configured : resolve(cwd, configured))
    : join(paths.commonDir, 'hooks')

  const guard = realpathSync(join(ROOT, 'hooks', 'reference-transaction'))
  const originalReferenceHook = join(originalDir, 'reference-transaction')
  const installed = join(hookDir, 'reference-transaction')
  const installedGuard = installedRefGuard(installed, guard)
  let wrapper: string | null = null

  if (pathEntryExists(originalReferenceHook)) {
    let original: string
    try { original = realpathSync(originalReferenceHook) } catch {
      throw new Error(`refusing shared ref guard wrapper: original hook cannot be resolved: ${originalReferenceHook}`)
    }
    if (resolve(originalReferenceHook) === resolve(installed)) {
      throw new Error(
        `refusing shared ref guard wrapper: original hook resolves to its own path ${installed}`,
      )
    }
    if (original === resolve(installed)) {
      throw new Error(
        `refusing shared ref guard wrapper: original hook resolves to its own path ${installed}`,
      )
    }
    if (sameFileBytes(original, guard)) {
      throw new Error(
        `refusing shared ref guard wrapper: original hook ${originalReferenceHook} ` +
        `resolves to tracked shared guard ${guard}`,
      )
    }
    wrapper = sharedRefGuardWrapper(hookDir, guard, original)
    if (installedGuard?.kind === 'wrapper' && installedGuard.original === original) {
      if (installedGuard.executable) {
        return verifiedSharedRefGuardEnvironment(paths, hookDir, guard, allowedRef)
      }
    }
    if (pathEntryExists(installed)) {
      let target = installed
      if (lstatSync(installed).isSymbolicLink()) {
        try { target = realpathSync(installed) } catch { target = '(dangling symlink)' }
      }
      throw new Error(`refusing to replace existing shared ref guard hook ${installed} (resolves to ${target})`)
    }
  } else if (installedGuard !== null) {
    if (installedGuard.executable) {
      return verifiedSharedRefGuardEnvironment(paths, hookDir, guard, allowedRef)
    }
    throw new Error(`shared ref guard is not executable: ${realpathSync(installed)}`)
  } else if (pathEntryExists(installed)) {
    throw new Error(`refusing to replace unrecognized shared ref guard hook ${installed}`)
  }

  try {
    accessSync(existsSync(hookDir) ? hookDir : paths.gitDir, constants.W_OK)
  } catch {
    throw new Error(`cannot install shared ref guard: hook path is not writable: ${hookDir}`)
  }
  // core.hooksPath is injected into the worker's process environment, not
  // configured for this repository. It therefore reaches every scratch
  // repository the worker touches. Project hooks such as commit-msg have no
  // business running there, so this directory carries only the ref-update
  // guard. Worker commits do not accidentally inherit checkout-local hooks.
  // The complete directory is assembled and synced under a private sibling
  // name. Only one rename publishes it at the path a worker may receive.
  try {
    stageRefGuardDirectory(paths.gitDir, hookDir, guard, wrapper)
  } catch (error) {
    if (!pathEntryExists(hookDir)) throw error
    const winner = installedRefGuard(installed, guard)
    const expectedOriginal = wrapper === null ? undefined : realpathSync(originalReferenceHook)
    if (!winner?.executable || winner.kind !== (wrapper === null ? 'guard' : 'wrapper') ||
        winner.original !== expectedOriginal) {
      throw new Error(`shared ref guard publication raced with an unsafe hook at ${installed}`)
    }
  }

  return verifiedSharedRefGuardEnvironment(paths, hookDir, guard, allowedRef)
}

function sharedRefGuardEnvironment(
  paths: { commonDir: string }, hookDir: string, allowedRef?: string,
): SharedRefGuardEnvironment {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hookDir,
    ORCH_GUARDED_GIT_COMMON_DIR: paths.commonDir,
    ...(allowedRef ? { ORCH_ALLOWED_GIT_REF: allowedRef } : {}),
  }
}

/** Common immutable objects plus the run branch's ref/reflog directories are the only shared writes. */
export function workerSharedGitRoots(cwd: string, branch: string): string[] {
  const paths = linkedWorktreePaths(cwd)
  if (!paths) throw new Error(`cannot resolve shared git roots: ${cwd} is not a linked worktree`)
  const ref = resolve(paths.commonDir, 'refs', 'heads', ...branch.split('/'))
  const reflog = resolve(paths.commonDir, 'logs', 'refs', 'heads', ...branch.split('/'))
  return [join(paths.commonDir, 'objects'), dirname(ref), dirname(reflog)]
}

export type OrphanSafety = {
  removable: boolean
  branch: string
  detail: string
}

export const ORCH_RUN_MARKER = '.orch-run'

export type RecordWorktree = (worktree: Worktree) => void

/** Mark a tree as orch-owned without asking the project to track orch metadata. */
function markWorktree(path: string, runId: number, repoRoot: string): void {
  writeFileSync(join(path, ORCH_RUN_MARKER), `${runId}\n${repoRoot}\n`)
  const exclude = resolve(path, git(['rev-parse', '--git-path', 'info/exclude'], path))
  const existing = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!existing.split('\n').includes(ORCH_RUN_MARKER)) {
    appendFileSync(exclude, `${existing && !existing.endsWith('\n') ? '\n' : ''}${ORCH_RUN_MARKER}\n`)
  }
}

/**
 * Give a newly-created directory an owner before any later setup can fail.
 *
 * The database pointer deliberately comes before the marker. If recording
 * succeeds and marking fails, the run still names the directory and explicit
 * cleanup can reclaim it. The reverse order recreates the orphan this boundary
 * exists to prevent. A failed record tears the new tree down immediately.
 */
function attributeWorktree(
  worktree: Worktree, runId: number, record?: RecordWorktree,
): void {
  try {
    record?.(worktree)
  } catch (e) {
    const cleanup = removeFor(worktree, worktree.repoRoot)
    throw new Error(
      `${String((e as Error)?.message ?? e)}\n` +
      `unrecorded worktree cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
    )
  }
  markWorktree(worktree.path, runId, worktree.repoRoot)
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
 * `carryWorkingState` only when the launch opted in; cutting the directory is
 * the first half of setup either way.
 */
/**
 * Fill and run a trusted shell declaration. Create reaches this only through
 * the registration-validated pipeline escape hatch; remove and sweep remain
 * lifecycle shell templates outside DEV-182's create-command migration.
 */
function runShellTool(
  template: string, vars: Record<string, string>, cwd: string,
): { ok: boolean; out: string; stdout: string } {
  const cmd = fillTool(template, vars)
  const p = Bun.spawnSync(['sh', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stdout = p.stdout.toString()
  const out = `${stdout}${p.stderr.toString()}`.trim()
  return { ok: p.exitCode === 0, out, stdout }
}

function fillArg(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_placeholder, key: string) => vars[key] ?? '')
}

/** Render the declared process argv. Empty strings remain real argv entries. */
export function createArgv(
  stored: WorktreeCreate | string, vars: Record<string, string>,
): string[] {
  // TOLERANT READ, STRICT WRITE. A legacy row becomes the equivalent shell
  // declaration in memory; validateProjectSettings still refuses anyone
  // trying to register that row shape again. This is a migration ramp, not a
  // permanent format: remove it once every authoritative `project list --json`
  // reports zero string-valued worktree.create declarations.
  const create: WorktreeCreate = typeof stored === 'string' ? { pipeline: stored } : stored
  if ('pipeline' in create) return ['sh', '-c', fillTool(create.pipeline, vars)]
  const args: string[] = []
  for (const arg of create.args) {
    if (typeof arg === 'string') {
      args.push(fillArg(arg, vars))
    } else if ('expand' in arg) {
      // The only call to shellWords: splitting is possible only when the
      // declaration visibly selects the explicit seed-expansion argument.
      args.push(...expandedSeed(vars[arg.expand] ?? ''))
    } else if (vars[arg.omitWhenEmpty]) {
      args.push(fillArg(arg.value, vars))
    }
  }
  return [create.command, ...args]
}

function runCreateTool(
  create: WorktreeCreate | string, vars: Record<string, string>, cwd: string,
): { ok: boolean; out: string; stdout: string } {
  const argv = createArgv(create, vars)
  const p = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stdout = p.stdout.toString()
  const out = `${stdout}${p.stderr.toString()}`.trim()
  return { ok: p.exitCode === 0, out, stdout }
}

function quoteAt(template: string, offset: number): "'" | '"' | null {
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
  return quote
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Split a seed the way the shell splits words, honouring quotes inside the spec.
 *
 * `--tables='a,b'` and a value containing a space stay one word. Whitespace
 * splits; `;` and other operators remain ordinary characters in the resulting
 * argv because the structured create path never invokes a shell.
 */
function shellWords(spec: string): string[] {
  const words: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < spec.length; i++) {
    const char = spec[i]!
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (char === '\\' && i + 1 < spec.length && '"$`\\\n'.includes(spec[i + 1]!)) {
        current += spec[++i]!
      } else {
        current += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && i + 1 < spec.length) {
      current += spec[++i]!
      started = true
      continue
    }
    if (char === ' ' || char === '\t' || char === '\n') {
      if (started) {
        words.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quote) throw new Error(`unclosed quote in seed: ${spec}`)
  if (started) words.push(current)
  return words
}

function expandedSeed(seed: string): string[] {
  return shellWords(seed)
}

/**
 * How a seed reaches the project's tool.
 *
 * Expansion is declaration-driven. A normal argument passes the seed once;
 * only the explicit `{ expand: 'seed' }` form enters expandedSeed.
 */
export function seedArgv(create: WorktreeCreate | string | undefined, seed: string): string[] {
  if (typeof create === 'string') {
    const offset = create.indexOf('{seed}')
    if (offset < 0 || quoteAt(create, offset) !== null) return [seed]
    return expandedSeed(seed)
  }
  if (!create || !('command' in create)) return [seed]
  return create.args.some((arg) => typeof arg === 'object' && 'expand' in arg)
    ? expandedSeed(seed)
    : [seed]
}

/** Fill a trusted project command without running it. */
export function fillTool(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, k: string, offset: number) => {
    const value = vars[k] ?? ''
    const quote = quoteAt(template, offset)
    if (quote === "'") return value.replace(/'/g, "'\\''")
    if (quote === '"') return value.replace(/[\\"$`]/g, '\\$&')
    // Compatibility for stored string declarations only. New declarations
    // reach expansion through the explicit argument kind instead.
    if (k === 'seed') return seedArgv(template, value).map(shSingleQuote).join(' ')
    return shSingleQuote(value)
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
 * Ask the PROJECT'S OWN worktree tool whether a seed can succeed.
 *
 * `scripts/worktree resolve` is a capability, not a requirement of every
 * project tool. The tool's usage text is its declaration that the subcommand
 * exists; an older tool with no resolver gets no invented verdict from orch.
 *
 * The argv after `resolve` is seedArgv of the create declaration: the same words
 * the create command will pass. That is not orch parsing the seed
 * grammar — it is delivering the spec the way the project declared it wants
 * the spec delivered.
 */
export function validateSeedWithTool(cwd: string, seed?: string): void {
  if (!seed) return
  // projectAt resolves a caller inside a nested worktree back to the registered
  // main checkout, which is where the lifecycle tool and its live config live.
  const project = projectAt(cwd)
  const repoRoot = project?.path
  if (!repoRoot) return
  const worktreeTool = join(repoRoot, 'scripts', 'worktree')
  if (!existsSync(worktreeTool)) return

  const usage = Bun.spawnSync([worktreeTool], {
    cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
  })
  const advertised = `${usage.stdout.toString()}${usage.stderr.toString()}`
  if (!/scripts\/worktree resolve(?:\s|\[)/.test(advertised)) return

  const resolved = Bun.spawnSync(
    [worktreeTool, 'resolve', ...seedArgv(project.settings.worktree?.create, seed)],
    { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
  )
  if (resolved.exitCode === 0) return
  const out = `${resolved.stdout.toString()}${resolved.stderr.toString()}`.trim()
  const detail = out ? `:\n${out.slice(-1500)}` : ` (exit ${resolved.exitCode ?? 1})`
  if (resolved.exitCode === 2) {
    throw new Error(`the project's seed resolver rejected the seed${detail}`)
  }
  throw new Error(`the project's seed resolver rejected the seed or could not check it${detail}`)
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
  record?: RecordWorktree,
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
  return withWorktreeCreateLock(
    repoRoot,
    () => createWithToolUnlocked(tool, repoRoot, runId, seed, key, baseRef, record),
  )
}

function createWithToolUnlocked(
  tool: WorktreeTool, repoRoot: string, runId: number, seed?: string, key?: string,
  baseRef?: string, record?: RecordWorktree,
): Worktree {
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
    return createFromRecipe(tool, tool.recipe, repoRoot, runId, key, baseRef, record)
  }

  if (baseRef && !createHasPlaceholder(tool.create, 'base')) {
    throw new Error(
      `this project's command-based worktree path cannot honor --base because its create ` +
      `arguments do not declare {base}`,
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
  const base = baseRef && createHasPlaceholder(tool.create, 'base')
    ? resolveBase(repoRoot, baseRef)
    : git(['rev-parse', 'HEAD'], repoRoot)
  const vars = { branch, name, base, seed: seed ?? '', key: key ?? '', path: '' }
  const r = runCreateTool(tool.create, vars, repoRoot)
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
  const worktree = { path, branch, base: actualBase, repoRoot }
  try {
    attributeWorktree(worktree, runId, record)
    verifyFreshWorktree(worktree)
  } catch (e) {
    throw new Error(`${String((e as Error)?.message ?? e)}${leftover(path)}`)
  }
  return worktree
}

export function createWorktree(
  cwd: string, runId: number, baseRef?: string, record?: RecordWorktree,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  return withWorktreeCreateLock(
    repoRoot, () => createWorktreeUnlocked(repoRoot, runId, baseRef, record),
  )
}

function createWorktreeUnlocked(
  repoRoot: string, runId: number, baseRef?: string, record?: RecordWorktree,
): Worktree {
  const base = baseRef ? resolveBase(repoRoot, baseRef) : git(['rev-parse', 'HEAD'], repoRoot)
  const dir = join(repoRoot, '.claude', 'worktrees')
  mkdirSync(dir, { recursive: true })

  const branch = `orch/${runId}`
  const path = join(dir, `orch-${runId}`)
  if (existsSync(path)) {
    throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  }
  git(['worktree', 'add', '-b', branch, path, base], repoRoot)
  const worktree = { path, branch, base, repoRoot }
  attributeWorktree(worktree, runId, record)
  verifyFreshWorktree(worktree)
  return worktree
}

/** Refuse a newly created tree whose files or index do not exactly describe HEAD. */
function verifyFreshWorktree(worktree: Worktree): void {
  const head = git(['rev-parse', 'HEAD'], worktree.path)
  if (head !== worktree.base) {
    throw new Error(
      `worktree verification failed: ${worktree.path} claims HEAD ${head}, ` +
      `but was created for ${worktree.base}`,
    )
  }

  // `status` compares HEAD, index and disk together and names non-ignored
  // untracked paths. A corrupt index is a hard git failure here, not an empty
  // answer, so the "unable to read <oid>" incident is made loud as well.
  let status: string
  try {
    status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree.path)
  } catch (e) {
    throw new Error(
      `worktree verification failed: could not compare ${worktree.path} with HEAD ${head}: ` +
      String((e as Error)?.message ?? e),
    )
  }
  if (status) {
    const detail = status.split('\0').filter(Boolean).join('\n').slice(0, 1500)
    throw new Error(
      `worktree verification failed: ${worktree.path} does not agree with HEAD ${head}:\n${detail}`,
    )
  }
}

/**
 * Put the caller's complete visible git state into a newly cut tree.
 *
 * Opt-in at the launch. The default is off, and that will look wrong: this
 * function exists so an architect iterating on unfinished work can dispatch a
 * run and have the worker see it. The asymmetry is what decides the default.
 * Not carrying fails as a worker that lacks context and says so — visible,
 * recoverable, cheap. Carrying fails as another author's half-finished work
 * inside a diff that is then judged, scored and possibly landed as the
 * worker's — silent, and it corrupts the evidence the whole system runs on.
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
export type CarriedWorkingState = {
  /** The commit the tracked patch was computed against. */
  base: string
  /** Paths represented by the git patch applied to the new tree. */
  tracked: string[]
  /** Non-ignored untracked paths copied outside the patch. */
  untracked: string[]
}

/**
 * Refuse a caller whose HEAD does not descend from the tree's base.
 *
 * Orthogonal to whether carrying was requested. A behind-or-diverged caller
 * applying a patch would revert the tree; opting in does not license that, and
 * opting out does not skip the check.
 */
export function assertCallerAncestry(cwd: string, worktree: Worktree): void {
  const callerHead = git(['rev-parse', 'HEAD'], cwd)
  if (gitOk(['merge-base', '--is-ancestor', worktree.base, callerHead], cwd) === null) {
    throw new Error(
      `caller HEAD ${callerHead} is behind or diverged from the tree's base ${worktree.base}; ` +
      `update the caller checkout so its HEAD descends from the tree's base, then retry`,
    )
  }
}

export type CallerDrift = { callerHead: string; base: string; baseRef: string }

/**
 * Detect the ancestry mismatch before a repository run is dispatched.
 *
 * Project-owned worktree creation may choose a fresher floor than the caller's
 * checkout. For a recipe that floor is declared directly. A command-based tool
 * owns the choice, so its best pre-creation proxy is the registered trunk's
 * upstream: that is the ref fetch advances while leaving the caller behind.
 * Plain git worktrees need no preview because their default floor is HEAD.
 */
export function callerDrift(cwd: string, baseRef?: string): CallerDrift | null {
  const project = projectAt(cwd)
  const tool = project?.settings.worktree
  if (!project || !tool) return null

  let ref = baseRef
  if (!ref && tool.recipe?.baseRef) ref = tool.recipe.baseRef
  if (!ref && tool.create) {
    const trunk = project.settings.trunk
      ?? gitOk(['symbolic-ref', '--short', 'HEAD'], project.path)
    if (!trunk) return null
    ref = gitOk(['rev-parse', '--abbrev-ref', `${trunk}@{upstream}`], project.path)
      ?? `origin/${trunk}`
  }
  if (!ref) return null

  const base = gitOk(['rev-parse', '--verify', ref], project.path)
  const callerHead = gitOk(['rev-parse', 'HEAD'], cwd)
  if (!base || !callerHead) return null
  if (gitOk(['merge-base', '--is-ancestor', base, callerHead], cwd) !== null) return null
  return { callerHead, base, baseRef: ref }
}

/** Non-ignored uncommitted paths, including untracked files. False if git cannot answer. */
export function checkoutHasUncommittedWork(cwd: string): boolean {
  return Boolean(gitOk(['status', '--porcelain', '--untracked-files=all'], cwd))
}

export function carryWorkingState(cwd: string, worktree: Worktree): CarriedWorkingState {
  assertCallerAncestry(cwd, worktree)

  const patch = gitBytes(['diff', '--binary', '--full-index', worktree.base, '--'], cwd)
  const tracked = gitBytes(['diff', '--name-only', '-z', worktree.base, '--'], cwd).toString()
    .split('\0').filter(Boolean)
  if (patch.byteLength) gitInput(['apply', '--binary', '--whitespace=nowarn', '-'], worktree.path, patch)

  const untracked = gitBytes(['ls-files', '--others', '--exclude-standard', '-z'], cwd).toString()
    .split('\0').filter(Boolean)
  const otherWorktrees = (gitOk(['worktree', 'list', '--porcelain'], cwd) ?? '')
    .split('\n').filter((line) => line.startsWith('worktree '))
    .map((line) => realpathSync(line.slice('worktree '.length)))
    .filter((path) => path !== realpathSync(cwd))
  const copied: string[] = []
  for (const relative of untracked) {
    const source = join(cwd, relative)
    const absoluteSource = realpathSync(source)
    if (otherWorktrees.some((path) => absoluteSource === path || path.startsWith(`${absoluteSource}/`))) {
      continue
    }
    const destination = join(worktree.path, relative)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true })
    copied.push(relative)
  }
  return { base: worktree.base, tracked, untracked: copied }
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
  baseRef?: string, record?: RecordWorktree,
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
  attributeWorktree(w, runId, record)

  const dbName = dbNameFor(repoRoot.split('/').pop() ?? 'app', runId)
  const steps = runRecipe(recipe, path, dbName, String(recipe.serve ? portFor(runId) : ''))
  const failed = steps.find((r) => !r.ok)
  if (failed) {
    removeFor(w, repoRoot)
    throw new Error(
      `worktree setup failed at "${failed.step}":\n${failed.detail.slice(-1200)}`,
    )
  }
  try {
    verifyFreshWorktree(w)
  } catch (e) {
    removeFor(w, repoRoot)
    throw e
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
 * Staging is also what makes a mixed committed/uncommitted result one complete
 * patch. The comparison is against the immutable run base, so commits on the
 * run branch and working-tree changes are captured together.
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
 * `--force` because a worker may leave staged or unstaged changes even when it
 * also committed. Unique commits are protected separately by `unmergedBranch`:
 * ordinary discard keeps their branch and names `--force`, while a run that
 * committed nothing still discards routinely. A removal that silently fails
 * leaves changes on disk with nothing pointing at them.
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
  tool: WorktreeTool, w: Worktree, forceOrchTree = false, keepBranch = false,
): { removed: boolean; detail: string; output?: string } {
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
    return removeWorktree(w, keepBranch)
  }

  const r = runShellTool(tool.remove, { name, branch: w.branch, path: w.path }, w.repoRoot)
  if (r.ok && !existsSync(w.path)) {
    return { removed: true, detail: w.path, ...(r.out ? { output: r.out } : {}) }
  }

  // The marker is the proof that orch made and owns this disposable checkout.
  // A project's removal guard can therefore be forced only when the operator
  // explicitly asked and this exact proof is still present. Names and branch
  // templates also recognise old trees for sweep, but are deliberately not
  // strong enough evidence for destructive fallback here.
  if (forceOrchTree && existsSync(join(w.path, ORCH_RUN_MARKER))) {
    return removeWorktree(w)
  }

  /**
   * A PROJECT'S REFUSAL IS FINAL UNLESS THE OPERATOR FORCES AN ORCH-OWNED TREE.
   *
   * This used to fall through to plain `git worktree remove --force` when the
   * tool exited non-zero, which is the ordinary orchestrator mistake and the
   * dangerous one: the refusals fire in exactly the case where the work is
   * irreplaceable. One project's tool will not remove a tree with uncommitted changes
   * without `--force`, and uses `git branch -d` so an unmerged branch survives
   * — both deliberate, because a leftover branch is recoverable and a deleted
   * one is not. Orch ownership, proved by the marker, is what permits an
   * operator-requested forced fallback; whether the worker committed is no
   * longer part of that proof. A dirty tree it left behind may still be the
   * ONLY copy of work it did not commit.
   *
   * Forcing past that for an unmarked tree is the same class of act as a worker
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
      `Those refusals guard uncommitted work and unmerged branches. Inspect and resolve ` +
      `the protected work with the project's own tooling, then run orch discard again. ` +
      `--force will not override a project tool's refusal unless the tree carries orch's ` +
      `${ORCH_RUN_MARKER} ownership marker.`,
  }
}

/** Remove a tree through the lifecycle declared by its registered project. */
export function removeFor(
  w: Worktree, repoRoot: string, forceOrchTree = false, keepBranch = false,
): { removed: boolean; detail: string; output?: string } {
  const project = projectAt(repoRoot)
  const tool = project?.settings.worktree
  const result: { removed: boolean; detail: string; output?: string } = tool
    ? removeWithTool(tool, w, forceOrchTree, keepBranch)
    : removeWorktree(w, keepBranch)
  return result.output
    ? { ...result, output: `${project!.name} remove:\n${result.output}` }
    : result
}

/** Reclaim orphans the project knows about — databases, containers, metadata. */
export function sweepWithTool(tool: WorktreeTool, repoRoot: string): string {
  if (!tool.sweep) return ''
  return runShellTool(tool.sweep, {}, repoRoot).out
}

export function removeWorktree(w: Worktree, keepBranch = false): { removed: boolean; detail: string } {
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
  if (!keepBranch) gitOk(['branch', '-D', w.branch], w.repoRoot)
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

/**
 * Commits reachable only from this local branch — deleting it would lose them.
 *
 * Counted from the recorded cut, not against a trunk ref: a local trunk goes
 * stale, and commits already on another branch, remote, or tag are not lost
 * by deleting this one. A missing base (rows that predate the column) drops
 * that term; unique commits are still counted.
 */
export function unmergedBranch(
  repoRoot: string, branch: string, baseCommit: string | null,
): UnmergedBranch | null {
  const ref = `refs/heads/${branch}`
  if (gitOk(['show-ref', '--verify', '--quiet', ref], repoRoot) === null) return null
  const tip = git(['rev-parse', ref], repoRoot)
  const args = ['rev-list', '--count', branch]
  if (baseCommit) args.push(`^${baseCommit}`)
  args.push('--not', `--exclude=${branch}`, '--branches', '--remotes', '--tags')
  const count = Number(git(args, repoRoot))
  return count > 0 ? { count, tip } : null
}

/** Restore a protected branch if a project's removal command deleted it. */
export function restoreBranch(repoRoot: string, branch: string, tip: string): void {
  if (gitOk(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot) === null) {
    git(['branch', branch, tip], repoRoot)
  }
}
