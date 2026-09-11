// concern: isolation
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
import { accessSync, appendFileSync, closeSync, constants, cpSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dlopen, FFIType } from 'bun:ffi'
import { platform } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { db, ROOT, tryWriteContention } from './db.ts'
import { pidAlive } from './process-liveness.ts'
import { projectAt, type WorktreeTool } from './projects.ts'
import { runRecipe, teardownRecipe, dbNameFor, type Recipe } from './recipe.ts'
import { scrubbedGitEnv } from '../../shared/git.ts'
export { inspectionGitEnv, scrubbedGitEnv } from '../../shared/git.ts'
import { assertCreateVarsAvailable, createArgv, fillArg, fillTool, seedArgv, type WorktreeCreate } from './worktree-template.ts'
import { ORCH_RUN_MARKER, extractWorktree } from './worktree-attribution.ts'
import { commonGitDir, git, gitBytes, gitConfigOk, gitInput, gitOk, gitRaw, linkedWorktreePaths, repoRootOf, targetGitEnvironment } from './git-environment.ts'

export type Worktree = {
  /** Where the worker actually runs. */
  path: string
  /** The branch created for it. */
  branch: string
  /** The commit it was cut from, so the diff has a fixed floor. */
  base: string
  /** The repository the worktree belongs to. */
  repoRoot: string
  /** The lifecycle that created this tree, and therefore owns its removal. */
  source?: 'recipe' | 'git' | 'readonly_recipe'
  /** Branch this run minted. Null/absent means it must never delete row.branch. */
  mintedBranch?: string | null
}

export type SharedRefGuardEnvironment = {
  GIT_CONFIG_COUNT: string
  GIT_CONFIG_KEY_0: string
  GIT_CONFIG_VALUE_0: string
  ORCH_GUARDED_GIT_COMMON_DIR: string
  ORCH_ALLOWED_GIT_REF?: string
}

export function worktreeExists(path: string): boolean {
  return existsSync(path)
}

export type CreateWorkerWorktreeOptions = {
  tool: WorktreeTool | null
  cwd: string
  runId: number
  writes: boolean
  readOnlyBase: string
  seed?: string
  key?: string
  baseRef?: string
  record: RecordWorktree
  detached: boolean
  existingBranch?: string
  existingBranchTip?: string
}

/** Create the worker tree through the project lifecycle or Git fallback. */
export function createWorkerWorktree(options: CreateWorkerWorktreeOptions): Worktree {
  if (!options.writes) {
    return options.tool?.readonly_create
      ? createReadOnlyWithTool(
          options.tool, options.cwd, options.runId, options.readOnlyBase, options.record,
        )
      : createReadOnlyWorktree(options.cwd, options.runId, options.readOnlyBase, options.record)
  }
  if (options.tool) {
    return createWithTool(
      options.tool, options.cwd, options.runId, options.seed, options.key,
      options.existingBranchTip ?? options.baseRef, options.record, options.detached,
      options.existingBranch,
    )
  }
  return options.existingBranch
    ? createWorktreeForBranch(options.cwd, options.runId, options.existingBranch, options.record)
    : createWorktree(
        options.cwd, options.runId, options.baseRef, options.record, options.detached,
      )
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
  startTime: string | null
  incarnation: string | null
  since: string
}

export type ProjectLockState = {
  path: string
  holder: ProjectLockParticipant | null
  waiters: ProjectLockParticipant[]
}

const PROCESS_START_TIME =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-3]\d [0-2]\d:[0-5]\d:[0-5]\d \d{4}$/

function projectLockParticipant(path: string): ProjectLockParticipant | null {
  let value: string
  try { value = readFileSync(path, 'utf8').trim() } catch { return null }
  if (/^\d+$/.test(value)) {
    const pid = Number(value)
    return Number.isSafeInteger(pid) && pid > 0
      ? { pid, startTime: null, incarnation: null, session: null, what: 'worktree creation',
          since: new Date(0).toISOString() }
      : null
  }
  try {
    const parsed = JSON.parse(value) as Partial<ProjectLockParticipant>
    return Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0 &&
      typeof parsed.what === 'string' && typeof parsed.since === 'string'
      ? { pid: Number(parsed.pid), session: typeof parsed.session === 'string' ? parsed.session : null,
          what: parsed.what, since: parsed.since,
          startTime: typeof parsed.startTime === 'string' ? parsed.startTime : null,
          incarnation: typeof parsed.incarnation === 'string' ? parsed.incarnation : null }
      : null
  } catch { return null }
}

export type PidRecordIdentity = 'live' | 'dead' | 'reused' | 'unknown'

/**
 * Compare a recorded pid against its recorded birth time.
 * Unknown is not live: destruction requires an established identity.
 */
export function pidRecordIdentity(
  pid: number | null | undefined,
  recordedStartTime: string | null | undefined,
): PidRecordIdentity {
  if (!pid || pid <= 1 || !pidAlive(pid)) return 'dead'
  if (!recordedStartTime) return 'unknown'
  const actual = processStartTime(pid)
  if (actual === null) return 'unknown'
  return actual === recordedStartTime ? 'live' : 'reused'
}

/** Locale-independent process birth; malformed or unreadable identity is unknown. */
export function processStartTime(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (platform() !== 'darwin' && platform() !== 'linux') return null
  try {
    const inspected = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], {
      env: { ...scrubbedGitEnv(), LC_ALL: 'C', LANG: 'C' },
      stdout: 'pipe', stderr: 'ignore',
    })
    if (inspected.exitCode !== 0) return null
    const value = inspected.stdout.toString().trim()
    return PROCESS_START_TIME.test(value) ? value : null
  } catch { return null }
}

export function staleProjectLockHolder(holder: ProjectLockParticipant): string | null {
  if (!pidAlive(holder.pid)) return `dead holder pid ${holder.pid}`
  if (holder.startTime === null) return null
  const actual = processStartTime(holder.pid)
  if (actual === null) return null
  if (actual !== holder.startTime) {
    return `pid ${holder.pid} start time changed from ${holder.startTime} to ${actual}`
  }
  return null
}

const flockLibrary = dlopen(platform() === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})
const flock = flockLibrary.symbols.flock
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

export function projectLockDir(repoRoot: string): string {
  const common = realpathSync(resolve(repoRoot, git(['rev-parse', '--git-common-dir'], repoRoot)))
  return join(common, 'orch', 'locks')
}

function legacyProjectLockPath(repoRoot: string, name: string): string {
  const common = realpathSync(resolve(repoRoot, git(['rev-parse', '--git-common-dir'], repoRoot)))
  return join(common, `orch-${name}.lock`)
}

function projectLockPaths(repoRoot: string, name: string): {
  lock: string; owner: string; waiters: string
} {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid project lock name: ${name}`)
  const runtime = projectLockDir(repoRoot)
  return {
    lock: join(runtime, `orch-${name}.lock`),
    owner: join(runtime, `orch-${name}.owner`),
    waiters: join(runtime, `orch-${name}.waiters`),
  }
}

function kernelLockHeld(path: string): boolean {
  if (!existsSync(path)) return false
  const fd = openSync(path, constants.O_RDWR)
  try {
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) return true
    flock(fd, LOCK_UN)
    return false
  } finally { closeSync(fd) }
}

function lockLabel(name: string): string {
  return name === 'create' || name === 'worktree-create' ? 'worktree creation' : name
}

function waiterEntries(waitersDir: string): { name: string; participant: ProjectLockParticipant }[] {
  if (!existsSync(waitersDir)) return []
  return readdirSync(waitersDir).flatMap((name) => {
    if (name.startsWith('.')) return []
    const participant = projectLockParticipant(join(waitersDir, name))
    return participant && pidAlive(participant.pid) ? [{ name, participant }] : []
  }).sort((a, b) => a.name.localeCompare(b.name))
}

const TICKET_LOCK_STALE_MS = 10_000

/**
 * Hand out the next arrival ticket under a tiny mkdir lock. The lock is
 * bounded by the caller's deadline and reclaimed when its owner is dead or
 * has held it past TICKET_LOCK_STALE_MS (a ticket write takes microseconds),
 * so one killed allocator cannot wedge every lock in the repository
 * (lens run 2346).
 */
function nextWaiterTicket(waitersDir: string, deadline: number): string {
  const lock = join(waitersDir, '.ticket.lock')
  const owner = join(lock, 'owner')
  const file = join(waitersDir, '.ticket')
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(owner, `${JSON.stringify({ pid: process.pid, since: Date.now() })}\n`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let stale = false
      try {
        const held = JSON.parse(readFileSync(owner, 'utf8')) as { pid?: number; since?: number }
        stale = !Number.isSafeInteger(held.pid) || !pidAlive(held.pid!) ||
          !Number.isFinite(held.since) || Date.now() - held.since! > TICKET_LOCK_STALE_MS
      } catch {
        // No owner file yet: the holder is between mkdir and write, or died there.
        try { stale = Date.now() - statSync(lock).mtimeMs > TICKET_LOCK_STALE_MS } catch { stale = false }
      }
      if (stale) {
        const gone = `${lock}.stale-${process.pid}-${randomUUID()}`
        try { renameSync(lock, gone); rmSync(gone, { recursive: true, force: true }) } catch { /* lost the race */ }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for the waiter-ticket lock ${lock}\n` +
          'invariant: A lock waiter is served in arrival order.\n' +
          'cleared by: the holder finishing; orch monitor names a dead holder, which the next arrival reclaims',
        )
      }
      Atomics.wait(sleeper, 0, 0, 10)
    }
  }
  try {
    let n = 0
    try { n = Number(readFileSync(file, 'utf8').trim()) } catch { n = 0 }
    if (!Number.isSafeInteger(n) || n < 0) n = 0
    n += 1
    writeFileSync(file, `${n}\n`)
    return String(n).padStart(16, '0')
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** Read coordination state without acquiring or changing the lock. */
export function projectLockState(repoRoot: string, name: string): ProjectLockState {
  const paths = projectLockPaths(repoRoot, name)
  return {
    path: paths.lock,
    holder: kernelLockHeld(paths.lock) ? projectLockParticipant(paths.owner) : null,
    waiters: [...waiterEntries(join(paths.waiters, '.legacy')), ...waiterEntries(paths.waiters)]
      .map((entry) => entry.participant),
  }
}

/** Kernel locks are released on process death, so there is no stale lock to reclaim. */
export function reclaimStaleProjectLock(
  repoRoot: string, name: string,
): { holder: ProjectLockParticipant; reason: string; path: string } | null {
  projectLockPaths(repoRoot, name)
  return null
}

/**
 * The flock(2) lock shared by repository-wide operations.
 *
 * Names keep unrelated resources separate while retaining bounded waiting.
 * Waiters are served in arrival order so a stream of short holders cannot
 * pass a process that arrived first.
 */
function withKernelProjectLock<T>(
  repoRoot: string, name: string, identity: ProjectLockIdentity, action: () => T,
  timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS, _exposeWaiters = false,
  onWait?: (holder: ProjectLockParticipant | null, remainingMs: number) => void,
): T {
  const paths = projectLockPaths(repoRoot, name)
  if (heldProjectLocks.has(paths.lock)) return action()
  const incarnation = randomUUID()
  const participant: ProjectLockParticipant = {
    pid: process.pid, startTime: processStartTime(process.pid), incarnation,
    session: identity.session, what: identity.what, since: new Date().toISOString(),
  }
  mkdirSync(paths.waiters, { recursive: true })
  const deadline = Date.now() + timeoutMs
  const waitStarted = Date.now()
  let waited = false
  const waiterName = `${nextWaiterTicket(paths.waiters, deadline)}-${process.pid}-${incarnation}`
  const waiter = join(paths.waiters, waiterName)
  writeFileSync(waiter, `${JSON.stringify(participant)}\n`)
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  let lastWaitNotice = 0
  const waiting = (holder: ProjectLockParticipant | null) => {
    waited = true
    if (!onWait || Date.now() - lastWaitNotice < 1_000) return
    lastWaitNotice = Date.now()
    onWait(holder, Math.max(0, deadline - Date.now()))
  }
  const lockSession = identity.session ?? process.env.CLAUDE_CODE_SESSION_ID ?? null
  const lockContention = { busyTimeoutMs: 0 as const }
  const recordLockTimeout = (held: ProjectLockParticipant | null) => {
    tryWriteContention({
      sessionId: lockSession, resourceKind: 'lock', resourceKey: name, eventKind: 'timeout',
      durationMs: Math.max(0, Date.now() - waitStarted),
      cause: held
        ? `holder session ${held.session ?? 'unknown'}, pid ${held.pid}, ${held.what}`
        : `timed out waiting for ${lockLabel(name)}`,
    }, lockContention)
  }
  let waitedMs = 0
  let lockFd: number | null = null

  try {
    while (true) {
      const first = waiterEntries(paths.waiters)[0]
      if (first && first.name !== waiterName) {
        if (Date.now() >= deadline) {
          const held = projectLockParticipant(paths.owner)
          recordLockTimeout(held)
          throw lockTimeout(name, timeoutMs, paths.lock, held)
        }
        waiting(projectLockParticipant(paths.owner))
        Atomics.wait(sleeper, 0, 0, WORKTREE_CREATE_LOCK_POLL_MS)
        continue
      }
      const candidate = openSync(paths.lock, constants.O_CREAT | constants.O_RDWR, 0o600)
      if (flock(candidate, LOCK_EX | LOCK_NB) !== 0) {
        closeSync(candidate)
        const held = projectLockParticipant(paths.owner)
        if (Date.now() >= deadline) {
          recordLockTimeout(held)
          throw lockTimeout(name, timeoutMs, paths.lock, held)
        }
        waiting(held)
        Atomics.wait(sleeper, 0, 0, WORKTREE_CREATE_LOCK_POLL_MS)
        continue
      }
      try {
        const holder = { ...participant, since: new Date().toISOString() }
        writeFileSync(paths.owner, `${JSON.stringify(holder)}\n`)
        lockFd = candidate
        heldProjectLocks.add(paths.lock)
        rmSync(waiter, { force: true })
        if (waited) waitedMs = Date.now() - waitStarted
        break
      } catch (e) {
        flock(candidate, LOCK_UN)
        closeSync(candidate)
        throw e
      }
    }

    try { return action() } finally {
      heldProjectLocks.delete(paths.lock)
      const ours = projectLockParticipant(paths.owner)
      if (lockFd !== null) {
        flock(lockFd, LOCK_UN)
        closeSync(lockFd)
      }
      if (ours?.incarnation === incarnation) rmSync(paths.owner, { force: true })
      if (waitedMs > 0) {
        tryWriteContention({
          sessionId: lockSession, resourceKind: 'lock', resourceKey: name, eventKind: 'wait',
          durationMs: waitedMs,
          cause: `waited for ${lockLabel(name)}`,
        }, lockContention)
      }
    }
  } finally {
    rmSync(waiter, { force: true })
  }
}

/**
 * Hold the pre-flock mkdir lock as a compatibility gate around the kernel lock.
 *
 * The legacy path is acquired first and the kernel path second everywhere; release
 * is in reverse order. This prevents a process loaded before the flock migration
 * from overlapping one loaded after it. The legacy gate can be removed once no
 * process predating the migration commit can still be running.
 */
export function withProjectLock<T>(
  repoRoot: string, name: string, identity: ProjectLockIdentity, action: () => T,
  timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS, exposeWaiters = false,
  onWait?: (holder: ProjectLockParticipant | null, remainingMs: number) => void,
): T {
  const legacy = legacyProjectLockPath(repoRoot, name)
  if (heldProjectLocks.has(legacy)) {
    return withKernelProjectLock(repoRoot, name, identity, action, timeoutMs, exposeWaiters, onWait)
  }
  const deadline = Date.now() + timeoutMs
  const waitStarted = Date.now()
  let waitedForLegacy = false
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const paths = projectLockPaths(repoRoot, name)
  const incarnation = randomUUID()
  const participant: ProjectLockParticipant = {
    pid: process.pid, startTime: processStartTime(process.pid), incarnation,
    session: identity.session, what: identity.what, since: new Date().toISOString(),
  }
  mkdirSync(paths.waiters, { recursive: true })
  const legacyWaiters = join(paths.waiters, '.legacy')
  mkdirSync(legacyWaiters, { recursive: true })
  const waiterName = `${nextWaiterTicket(legacyWaiters, deadline)}-${process.pid}-${incarnation}`
  const waiter = join(legacyWaiters, waiterName)
  writeFileSync(waiter, `${JSON.stringify(participant)}\n`)
  const lockSession = identity.session ?? process.env.CLAUDE_CODE_SESSION_ID ?? null
  const recordLegacyContention = (eventKind: 'timeout' | 'wait', holder: ProjectLockParticipant | null) => {
    tryWriteContention({
      sessionId: lockSession, resourceKind: 'lock', resourceKey: name, eventKind,
      durationMs: Math.max(0, Date.now() - waitStarted),
      cause: holder
        ? `holder session ${holder.session ?? 'unknown'}, pid ${holder.pid}, ${holder.what}`
        : `${eventKind === 'timeout' ? 'timed out waiting' : 'waited'} for ${lockLabel(name)}`,
    }, { busyTimeoutMs: 0 })
  }
  try {
    for (;;) {
      const first = waiterEntries(legacyWaiters)[0]
      if (first && first.name !== waiterName) {
        const holder = projectLockParticipant(join(legacy, 'owner'))
        if (Date.now() >= deadline) {
          recordLegacyContention('timeout', holder)
          throw lockTimeout(name, timeoutMs, legacy, holder)
        }
        waitedForLegacy = true
        onWait?.(holder, Math.max(0, deadline - Date.now()))
        Atomics.wait(sleeper, 0, 0, WORKTREE_CREATE_LOCK_POLL_MS)
        continue
      }
      try {
        mkdirSync(legacy)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const holder = projectLockParticipant(join(legacy, 'owner'))
        const stale = holder && staleProjectLockHolder(holder)
        if (holder && stale) {
          const gone = `${legacy}.stale-${process.pid}-${randomUUID()}`
          try {
            renameSync(legacy, gone)
            const renamed = projectLockParticipant(join(gone, 'owner'))
            if (renamed?.incarnation === holder.incarnation) rmSync(gone, { recursive: true, force: true })
            else renameSync(gone, legacy)
          } catch { /* another contender changed the legacy gate */ }
          continue
        }
        if (Date.now() >= deadline) {
          recordLegacyContention('timeout', holder)
          throw lockTimeout(name, timeoutMs, legacy, holder)
        }
        waitedForLegacy = true
        onWait?.(holder, Math.max(0, deadline - Date.now()))
        Atomics.wait(sleeper, 0, 0, WORKTREE_CREATE_LOCK_POLL_MS)
      }
    }
    writeFileSync(join(legacy, 'owner'), `${JSON.stringify(participant)}\n`)
    heldProjectLocks.add(legacy)
    rmSync(waiter, { force: true })
    try {
      return withKernelProjectLock(
        repoRoot, name, identity, action, Math.max(0, deadline - Date.now()), exposeWaiters, onWait,
      )
    } finally {
      if (waitedForLegacy) recordLegacyContention('wait', null)
    }
  } finally {
    heldProjectLocks.delete(legacy)
    const ours = projectLockParticipant(join(legacy, 'owner'))
    if (ours?.incarnation === incarnation) rmSync(legacy, { recursive: true, force: true })
    rmSync(waiter, { force: true })
  }
}

function lockTimeout(
  name: string, timeoutMs: number, lock: string, held: ProjectLockParticipant | null,
): Error {
  const label = lockLabel(name)
  const heldFor = held ? Math.max(0, Date.now() - Date.parse(held.since)) : null
  const detail = held
    ? ` (holder session ${held.session ?? 'unknown'}, pid ${held.pid}, ` +
      `${held.what}, held for ${Math.round(heldFor! / 1000)}s)`
    : ''
  return new Error(
    `timed out after ${timeoutMs / 1000}s waiting for this project's ${label} lock${detail}: ${lock}\n` +
    `invariant: A lock waiter is served in arrival order.\n` +
    `cleared by: the holder${held ? ` (pid ${held.pid})` : ''} finishing; ` +
    'the kernel releases the lock if its process exits',
  )
}

/**
 * Serialize worktree creation and resume attribution for one repository.
 *
 * flock(2) is the lock operation, while FIFO tickets preserve arrival order.
 * Runtime paths are keyed by the common git directory, so callers from the main
 * checkout and any linked worktree contend while unrelated projects do not.
 * It deliberately surrounds project tools
 * and recipes as well as orch's own git calls; a fetch inside a project recipe was
 * the operation that exposed the original race.
 */
export function withWorktreeCreateLock<T>(
  repoRoot: string, create: () => T, timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS,
): T {
  return withProjectLock(repoRoot, 'create',
    { session: null, what: 'worktree creation' }, create, timeoutMs)
}

export function withCleanupLock<T>(
  repoRoot: string, identity: ProjectLockIdentity, action: () => T,
  timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS,
): T {
  return withProjectLock(repoRoot, 'cleanup', identity, action, timeoutMs, true)
}

export function worktreeLeaseName(worktreePath: string): string {
  let real = worktreePath
  try { real = realpathSync(worktreePath) } catch { /* the spelled path still keys the artifact */ }
  return `tree-${createHash('sha256').update(real).digest('hex').slice(0, 16)}`
}

/**
 * Per-artifact lease. Holders take this first and the purpose lock second so
 * attachment, landing and cleanup of one tree cannot interleave, and cannot
 * deadlock with the purpose locks.
 */
export function withWorktreeLease<T>(
  repoRoot: string, worktreePath: string, identity: ProjectLockIdentity, action: () => T,
  timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS,
): T {
  return withProjectLock(repoRoot, worktreeLeaseName(worktreePath), identity, action, timeoutMs)
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

const UNMARKED_GUARD_PREFIX = 'unmarked-'

/**
 * The guard directory's name. A tree orch cut carries its run id in the
 * marker; a tree built by hand (the lifecycle harness, an operator landing a
 * branch from a tree orch did not cut) has none and gets a key derived from
 * its real path, so concurrent preparations on one tree still converge on one
 * directory (DEV-225). Refusing here would leave a hand-made tree UNGUARDED at
 * the point the guard matters most. Unmarked guards are not reclaimed as
 * litter: nothing records which tree they served once it is gone, and a
 * hand-made tree is rare.
 */
function refGuardOwner(cwd: string): string {
  const value = markedWorktreeRunId(cwd)
  if (value !== null) return String(value)
  let real = cwd
  try { real = realpathSync(cwd) } catch { /* the path as given still keys deterministically */ }
  return `${UNMARKED_GUARD_PREFIX}${createHash('sha256').update(real).digest('hex').slice(0, 16)}`
}

function markedWorktreeRunId(cwd: string): number | null {
  try {
    const value = Number(readFileSync(join(cwd, ORCH_RUN_MARKER), 'utf8').split('\n', 1)[0])
    return Number.isInteger(value) && value > 0 ? value : null
  } catch { return null }
}

function refGuardCheckpoint(name: string): void {
  if (process.env.ORCH_TEST_REF_GUARD_CHECKPOINT !== name) return
  const ready = process.env.ORCH_TEST_REF_GUARD_READY
  if (!ready) return
  writeFileSync(ready, `${name}\n`)
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
}

function cleanupRefGuardLitter(gitDir: string, hookDir?: string): void {
  for (const name of readdirSync(gitDir)) {
    if (name.startsWith(REF_GUARD_STAGE_PREFIX)) {
      const pid = Number(name.slice(REF_GUARD_STAGE_PREFIX.length).split('-', 1)[0])
      if (Number.isInteger(pid) && pidAlive(pid)) continue
      rmSync(join(gitDir, name), { recursive: true, force: true })
      continue
    }
    if (!/^\d+$/.test(name)) continue
    const run = db().query(
      `SELECT status, worktree FROM run WHERE id=?`,
    ).get(Number(name)) as { status: string; worktree: string | null } | null
    if (!run || run.worktree !== null || !['ok', 'failed', 'stale', 'stopped'].includes(run.status)) {
      continue
    }
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
  const hookDir = join(paths.commonDir, 'orch-guards', refGuardOwner(cwd))
  if (pathEntryExists(hookDir) && realpathSync(hookDir) !== resolve(hookDir)) {
    throw new Error(`refusing shared ref guard hook directory symlink: ${hookDir}`)
  }
  const guardRoot = dirname(hookDir)
  mkdirSync(guardRoot, { recursive: true })
  cleanupRefGuardLitter(guardRoot, hookDir)

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
    accessSync(existsSync(hookDir) ? hookDir : guardRoot, constants.W_OK)
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
    stageRefGuardDirectory(guardRoot, hookDir, guard, wrapper)
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

/** Remove the guard owned by one run. A missing repository or directory is already clean. */
export function removeSharedRefGuard(cwd: string, runId: number): void {
  const commonDir = commonGitDir(cwd)
  if (!commonDir) return
  rmSync(join(commonDir, 'orch-guards', String(runId)), { recursive: true, force: true })
}

/**
 * Refuse dispatch if the worker can write the hook that constrains its shared ref writes.
 * Existing paths are canonicalised before containment is compared so symlinks cannot
 * make a writable ancestor look unrelated to the published directory.
 */
export function assertSharedRefGuardOutsideWritableRoots(
  hookDir: string, writableRoots: string[],
): void {
  const published = realpathSync(hookDir)
  for (const root of writableRoots) {
    const canonicalRoot = realpathSync(root)
    const rel = relative(canonicalRoot, published)
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
      throw new Error(
        `THE GUARD LIVES OUTSIDE EVERY ROOT THE WORKER CAN WRITE invariant failed: ` +
        `${published} is inside writable root ${canonicalRoot}`,
      )
    }
  }
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

/**
 * Common immutable objects plus the run branch's ref/reflog directories are the only shared writes.
 * A flat branch necessarily grants all of refs/heads and logs/refs/heads. That is acceptable only
 * because the guard is outside those roots and refuses every ref except the worker's exact branch.
 */
export function workerSharedGitRoots(cwd: string, branch: string): string[] {
  const paths = linkedWorktreePaths(cwd)
  if (!paths) throw new Error(`cannot resolve shared git roots: ${cwd} is not a linked worktree`)
  const ref = resolve(paths.commonDir, 'refs', 'heads', ...branch.split('/'))
  const reflog = resolve(paths.commonDir, 'logs', 'refs', 'heads', ...branch.split('/'))
  return [join(paths.commonDir, 'objects'), dirname(ref), dirname(reflog)]
}

export type RecordWorktree = (worktree: Worktree) => void

/** Mark a tree as orch-owned without asking the project to track orch metadata. */
function markWorktree(
  path: string, runId: number, repoRoot: string, source: NonNullable<Worktree['source']>,
): void {
  writeFileSync(join(path, ORCH_RUN_MARKER), `${runId}\n${repoRoot}\nsource: ${source}\n`)
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
    const cleanup = removeFor(worktree, worktree.repoRoot, false, false, runId)
    throw new Error(
      `${String((e as Error)?.message ?? e)}\n` +
      `unrecorded worktree cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
    )
  }
  const recorded = db().query('SELECT status FROM run WHERE id=?').get(runId) as
    { status: string } | null
  if (recorded?.status === 'stopped') {
    const cleanup = removeFor(worktree, worktree.repoRoot, false, false, runId)
    if (cleanup.removed) {
      db().query('UPDATE run SET worktree=NULL WHERE id=?').run(runId)
    }
    throw new Error(
      `run ${runId} stopped during worktree creation; ` +
      `cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
    )
  }
  if (!worktree.source) throw new Error(`worktree ${worktree.path} has no lifecycle source`)
  markWorktree(worktree.path, runId, worktree.repoRoot, worktree.source)
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
): { ok: boolean; out: string; stdout: string; exitCode: number | null } {
  const cmd = fillTool(template, vars)
  const p = Bun.spawnSync(['sh', '-c', cmd], {
    cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  const stdout = p.stdout.toString()
  const out = `${stdout}${p.stderr.toString()}`.trim()
  return { ok: p.exitCode === 0, out, stdout, exitCode: p.exitCode }
}

function runCreateTool(
  create: WorktreeCreate | string, vars: Record<string, string>, cwd: string,
  env?: NodeJS.ProcessEnv,
): { ok: boolean; out: string; stdout: string } {
  const argv = createArgv(create, vars)
  const declaredEnv = typeof create === 'object' && 'command' in create
    ? Object.fromEntries(Object.entries(create.env ?? {}).map(([name, value]) => [name, fillArg(value, vars)]))
    : {}
  const p = Bun.spawnSync(argv, {
    cwd, env: { ...(env ?? process.env), ...declaredEnv }, stdout: 'pipe', stderr: 'pipe',
  })
  const stdout = p.stdout.toString()
  const out = `${stdout}${p.stderr.toString()}`.trim()
  return { ok: p.exitCode === 0, out, stdout }
}

/** Resolve a caller's base before any worktree or run row is created. */
export function resolveBase(cwd: string, ref: string): string {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], repoRoot)
}

/** Resolve a read-only snapshot against the checkout the operator invoked. */
export function resolveReadOnlyBase(cwd: string, ref: string): string {
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], cwd)
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Resolve a structured create command exactly as its direct spawn will. */
export function createCommandExists(create: WorktreeCreate | string, repoRoot: string): boolean {
  if (typeof create === 'string' || !('command' in create)) return true
  const command = create.command
  if (command.includes('/')) return executableFile(resolve(repoRoot, command))
  return (process.env.PATH ?? '').split(delimiter).some((entry) =>
    executableFile(resolve(repoRoot, entry || '.', command)))
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
  // This legacy resolver probe stays deliberately optional. Dispatch command
  // availability is enforced separately in preflight; changing this silent
  // return would make seed resolution a new required capability.
  if (!existsSync(worktreeTool)) return

  const usage = Bun.spawnSync([worktreeTool], {
    cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe',
  })
  const advertised = `${usage.stdout.toString()}${usage.stderr.toString()}`
  if (!/scripts\/worktree resolve(?:\s|\[)/.test(advertised)) return

  const resolved = Bun.spawnSync(
    [worktreeTool, 'resolve', ...seedArgv(project.settings.worktree?.create, seed)],
    { cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe' },
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
  record?: RecordWorktree, detached = false, existingBranch?: string,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  const projectName = projectAt(cwd)?.name ?? projectAt(repoRoot)?.name ?? '(unregistered)'
  if (tool.seeds?.length && !seed) {
    throw new Error(
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed ${tool.seeds.join('\n  --seed ')}\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
  }
  return withWorktreeCreateLock(
    repoRoot,
    () => createWithToolUnlocked(
      tool, repoRoot, runId, seed, key, baseRef, record, detached, projectName, existingBranch,
    ),
  )
}

function createWithToolUnlocked(
  tool: WorktreeTool, repoRoot: string, runId: number, seed?: string, key?: string,
  baseRef?: string, record?: RecordWorktree, detached = false,
  projectName = '(unregistered)', existingBranch?: string,
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
    return createFromRecipe(
      tool, tool.recipe, repoRoot, runId, key, baseRef, record, detached, existingBranch,
    )
  }

  const branch = existingBranch ?? (tool.branch ?? 'orch/{id}')
      .replace(/\{id\}/g, String(runId))
      .replace(/\{key\}/g, key ?? '')
  const name = `orch-${runId}`
  // A base is a commit, not a recipe argument. {base} is passed when the
  // template has a slot; without one the branch is still cut at that commit
  // after the tool returns.
  const base = baseRef
    ? resolveBase(repoRoot, baseRef)
    : git(['rev-parse', 'HEAD'], repoRoot)
  const vars = { branch, name, base, seed: seed ?? '', key: key ?? '', path: '' }
  const r = runCreateTool(tool.create, vars, repoRoot, targetGitEnvironment(repoRoot))
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
  if (detached) {
    const symbolicHead = gitOk(['symbolic-ref', '-q', 'HEAD'], path)
    const head = gitOk(['rev-parse', 'HEAD'], path)
    if (symbolicHead !== null || head !== base) {
      throw new Error(
        `project ${projectName}: worktree.create detached review ` +
        `postcondition failed; expected detached HEAD at ${base}, got ` +
        `${symbolicHead ?? '(detached HEAD)'} at ${head ?? '(unresolved)'}.` + leftover(path),
      )
    }
  }
  // A command without {base} may deliberately choose its own floor. Read the
  // commit from the tree it actually created so the run record and every later
  // diff name that floor rather than the caller checkout's incidental HEAD.
  const actualBase = gitOk(['rev-parse', 'HEAD'], path) ?? base
  if (!detached) {
    const dirty = gitOk(['status', '--porcelain=v1', '--untracked-files=no'], path)
    if (baseRef && !dirty) git(['checkout', '-B', branch, base], path)
    else gitOk(['checkout', '-B', branch], path)
  }
  const worktree = {
    path,
    branch: detached ? '' : branch,
    base: gitOk(['rev-parse', 'HEAD'], path) ?? actualBase,
    repoRoot,
    source: 'recipe' as const,
    mintedBranch: detached || existingBranch ? null : branch,
  }
  try {
    attributeWorktree(worktree, runId, record)
    verifyFreshWorktree(worktree)
  } catch (e) {
    throw new Error(`${String((e as Error)?.message ?? e)}${leftover(path)}`)
  }
  return worktree
}

export function createWorktree(
  cwd: string, runId: number, baseRef?: string, record?: RecordWorktree, detached = false,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  return withWorktreeCreateLock(
    repoRoot, () => createWorktreeUnlocked(repoRoot, runId, baseRef, record, detached),
  )
}

/** Cut a new disposable tree on a task branch that already exists. */
export function createWorktreeForBranch(
  cwd: string, runId: number, branch: string, record?: RecordWorktree,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  const base = resolveBase(repoRoot, branch)
  const path = join(repoRoot, '.claude', 'worktrees', `orch-${runId}`)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  git(['worktree', 'add', path, branch], repoRoot)
  const worktree: Worktree = {
    path, branch, base, repoRoot, source: 'git', mintedBranch: null,
  }
  attributeWorktree(worktree, runId, record)
  verifyFreshWorktree(worktree)
  return worktree
}

function createWorktreeUnlocked(
  repoRoot: string, runId: number, baseRef?: string, record?: RecordWorktree, detached = false,
): Worktree {
  const base = baseRef ? resolveBase(repoRoot, baseRef) : git(['rev-parse', 'HEAD'], repoRoot)
  const dir = join(repoRoot, '.claude', 'worktrees')
  mkdirSync(dir, { recursive: true })

  const branch = `orch/${runId}`
  const path = join(dir, `orch-${runId}`)
  if (existsSync(path)) {
    throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  }
  git(['worktree', 'add', ...(detached ? ['--detach'] : ['-b', branch]), path, base], repoRoot)
  const worktree = {
    path, branch: detached ? '' : branch, base, repoRoot, source: 'git' as const,
    mintedBranch: detached ? null : branch,
  }
  attributeWorktree(worktree, runId, record)
  verifyFreshWorktree(worktree)
  return worktree
}

/** Cut the unprovisioned checkout used by a read-only repository job. */
export function createReadOnlyWorktree(
  cwd: string, runId: number, base: string, record?: RecordWorktree,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  const path = join(repoRoot, '.claude', 'worktrees', `orch-${runId}`)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  git(['worktree', 'add', '--detach', path, base], repoRoot)
  const worktree = { path, branch: '', base, repoRoot, source: 'git' as const }
  attributeWorktree(worktree, runId, record)
  verifyFreshWorktree(worktree)
  return worktree
}

/** Let a project provision a detached read-only checkout at orch's chosen path. */
export function createReadOnlyWithTool(
  tool: WorktreeTool, cwd: string, runId: number, base: string,
  record?: RecordWorktree,
): Worktree {
  const repoRoot = repoRootOf(cwd)
  if (!repoRoot) throw new Error(`not a git repository: ${cwd}`)
  if (!tool.readonly_create) throw new Error('project declares no readonly_create command')
  const path = join(repoRoot, '.claude', 'worktrees', `orch-${runId}`)
  if (existsSync(path)) throw new Error(`worktree ${path} already exists; run ${runId} would overwrite it`)
  const vars = { path, base }
  assertCreateVarsAvailable(tool.readonly_create, vars)
  const branchesBefore = localBranchTips(repoRoot)
  const result = runCreateTool(tool.readonly_create, vars, repoRoot, targetGitEnvironment(cwd))
  let branch = ''
  try {
    if (!result.ok) throw new Error(`the project's read-only worktree tool failed:\n${result.out.slice(-1500)}`)
    if (!existsSync(path)) {
      throw new Error(`the project's read-only worktree tool reported success but ${path} does not exist`)
    }
    branch = gitOk(['symbolic-ref', '--quiet', '--short', 'HEAD'], path) ?? ''
    if (branch) throw new Error(`the project's read-only worktree tool created attached branch ${branch}`)
    const worktree = {
      path, branch: '', base, repoRoot, source: 'readonly_recipe' as const, mintedBranch: null,
    }
    attributeWorktree(worktree, runId, record)
    verifyFreshWorktree(worktree)
    return worktree
  } catch (error) {
    if (!existsSync(path)) throw error
    const previousTip = branch ? branchesBefore.get(branch) : undefined
    const cleanup = removeReadOnlyTree(tool, {
      path, branch, base, repoRoot, source: 'readonly_recipe',
    }, previousTip !== undefined)
    if (cleanup.removed && branch && previousTip !== undefined) {
      const restored = restoreBranchToTip(repoRoot, branch, previousTip)
      if (!restored.ok) {
        cleanup.removed = false
        cleanup.detail = `${cleanup.detail}; could not restore pre-existing branch ${branch} ` +
          `to ${previousTip}: ${restored.error}`
      }
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
      `cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
    )
  }
}

function localBranchTips(repoRoot: string): Map<string, string> {
  const lines = git(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/'], repoRoot)
  return new Map(lines.split('\n').filter(Boolean).map((line) => {
    const split = line.lastIndexOf(' ')
    return [line.slice(0, split), line.slice(split + 1)]
  }))
}

function restoreBranchToTip(
  repoRoot: string, branch: string, tip: string,
): { ok: true } | { ok: false; error: string } {
  const current = branchTip(repoRoot, branch)
  if (current === tip) return { ok: true }
  const expected = current ?? '0000000000000000000000000000000000000000'
  const p = Bun.spawnSync(['git', 'update-ref', `refs/heads/${branch}`, tip, expected], {
    cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe',
  })
  return p.exitCode === 0
    ? { ok: true }
    : { ok: false, error: p.stderr.toString().trim() || `exit ${p.exitCode}` }
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
      `update the caller checkout so its HEAD descends from the tree's base, then retry\n` +
      `invariant: A resume is always possible on a stale checkout.\n` +
      `cleared by: git merge --ff-only ${worktree.base}`,
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
  baseRef?: string, record?: RecordWorktree, detached = false, existingBranch?: string,
): Worktree {
  const branch = existingBranch ?? (tool.branch ?? 'orch/{id}')
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

  git(
    [
      'worktree', 'add', ...(detached ? ['--detach'] : existingBranch ? [] : ['-b', branch]),
      path, existingBranch && !detached ? branch : base,
    ],
    repoRoot,
  )
  const w: Worktree = {
    path, branch: detached ? '' : branch, base, repoRoot, source: 'recipe',
    mintedBranch: detached || existingBranch ? null : branch,
  }
  attributeWorktree(w, runId, record)

  const dbName = dbNameFor(repoRoot.split('/').pop() ?? 'app', runId)
  const steps = runRecipe(recipe, path, dbName, String(recipe.serve ? portFor(runId) : ''))
  const failed = steps.find((r) => !r.ok)
  if (failed) {
    removeFor(w, repoRoot, false, false, runId)
    throw new Error(
      `worktree setup failed at "${failed.step}":\n${failed.detail.slice(-1200)}`,
    )
  }
  try {
    verifyFreshWorktree(w)
  } catch (e) {
    removeFor(w, repoRoot, false, false, runId)
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
  /** The unified diff against the run's trunk merge-base, including files never added. */
  diff: string
  /** Paths the worker touched, so scope can be checked without reading the diff. */
  files: string[]
  insertions: number
  deletions: number
  /** The commit used as the lower end of the diff. */
  since: string
  /** The configured trunk, or `main` when the register has none. */
  trunk: string
  /** Whether trunk came from the project register. */
  trunkConfigured: boolean
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
 * patch. The comparison is against the run tip's merge-base with current
 * trunk, so commits on the run branch and working-tree changes are captured
 * together without attributing commits that subsequently landed on trunk.
 */
export function changesIn(w: Worktree, sinceBase = false): Changes {
  git(['add', '-A'], w.path)
  const configuredTrunk = projectAt(w.repoRoot)?.settings.trunk?.trim()
  const trunk = configuredTrunk || 'main'
  const mergeBase = sinceBase ? w.base : gitOk(['merge-base', 'HEAD', trunk], w.path)
  if (!mergeBase && configuredTrunk) {
    throw new Error(`cannot find merge-base between the run tip and trunk ${trunk}`)
  }
  // Unregistered scratch repositories predate the register and do not all call
  // their initial branch `main`. Their only truthful fallback is the recorded
  // base; registered projects must resolve their declared trunk above.
  const since = mergeBase ?? w.base
  // Raw: this is a patch, and `git apply` counts its bytes.
  const diff = gitRaw(['diff', '--cached', since], w.path)
  const names = gitOk(['diff', '--cached', '--name-only', since], w.path) ?? ''
  const stat = gitOk(['diff', '--cached', '--numstat', since], w.path) ?? ''

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
    since,
    trunk,
    trunkConfigured: Boolean(configuredTrunk),
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
  runId?: number,
): { removed: boolean; detail: string; output?: string } {
  const name = w.path.split('/').pop() ?? w.path
  const branchBefore = branchTip(w.repoRoot, w.branch)
  const uniqueBefore = unmergedBranch(w.repoRoot, w.branch, null)

  // A recipe-built tree is torn down the same way it was made: bottega
  // provisioned the database, so bottega drops it. Done BEFORE the directory
  // goes, because a compose file that lives in the worktree cannot bring
  // anything down once the worktree has been deleted.
  if (!tool.remove) {
    if (tool.recipe) {
      // Recipe infrastructure is owned by the run that is being discarded,
      // never by an id inferred from another run's retained directory.
      if (runId === undefined) return removeWorktree(w, keepBranch)
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

  const vars: Record<string, string> = { name, path: w.path }
  if (w.branch) vars.branch = w.branch
  const r = runShellTool(tool.remove, vars, w.repoRoot)
  if (r.ok && !existsSync(w.path)) {
    const branchAfter = branchTip(w.repoRoot, w.branch)
    if (branchAfter !== null && branchAfter !== branchBefore &&
        (uniqueBefore !== null || !keepBranch)) {
      return {
        removed: false,
        detail: branchBefore === null
          ? `project remove tool created unprotected branch ${w.branch} at ${branchAfter}; it was left in place`
          : uniqueBefore
          ? `project remove tool moved unique branch ${w.branch} from ${branchBefore} to ${branchAfter}; it was left in place`
          : `project remove tool moved unprotected branch ${w.branch} from ${branchBefore} to ${branchAfter}; it was left in place`,
        ...(r.out ? { output: r.out } : {}),
      }
    }
    const reconciled = removeWorktree(w, keepBranch)
    return { ...reconciled, ...(r.out ? { output: r.out } : {}) }
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

function removeReadOnlyTree(
  tool: WorktreeTool, w: Worktree, keepBranch = false,
): { removed: boolean; detail: string; output?: string } {
  if (!tool.readonly_remove) return removeWorktree(w, keepBranch)
  const result = runShellTool(tool.readonly_remove, { path: w.path }, w.repoRoot)
  if (!result.ok) {
    return {
      removed: false,
      detail: `${w.path} was NOT removed — the project's read-only remove tool refused:\n` +
        `${result.out.slice(-600) || `exit code from ${tool.readonly_remove}`}`,
    }
  }
  const reconciled = removeWorktree(w, keepBranch)
  return result.out ? { ...reconciled, output: result.out } : reconciled
}

function mintedBranchOwnedBy(w: Worktree, runId?: number): string | null {
  if (runId !== undefined) {
    try {
      const row = db().query('SELECT minted_branch FROM run WHERE id=?').get(runId) as
        { minted_branch: string | null } | null
      if (row) return row.minted_branch
    } catch { /* a store mid-migrate has no minted_branch yet */ }
  }
  return w.mintedBranch ?? null
}

/** Remove a tree through the lifecycle declared by its registered project. */
export function removeFor(
  w: Worktree, repoRoot: string, forceOrchTree = false, keepBranch = false, runId?: number,
  forceUnmerged = false,
): { removed: boolean; detail: string; output?: string } {
  // The marker identifies who created a tree; it does not transfer that run's
  // branch ownership to a later attacher. Cleanup names only the discarding
  // run's minted branch.
  const owningRunId = runId ?? markedWorktreeRunId(w.path)
  if (existsSync(w.path)) {
    const extracted = extractWorktree(w.path, owningRunId)
    if (!extracted.ok) return { removed: false, detail: extracted.detail }
  }
  const minted = mintedBranchOwnedBy(w, runId)
  // Unminted: the git branch is not ours to name to a project tool. Pass the
  // tree only. Minted: the tool receives that branch name, never ''.
  const owned = { ...w, branch: minted ?? '' }
  const project = projectAt(repoRoot)
  const tool = project?.settings.worktree
  const retainBranch = keepBranch || !minted ||
    (!forceUnmerged && unmergedBranch(repoRoot, minted, null) !== null)
  let result: { removed: boolean; detail: string; output?: string }
  if (w.source === 'readonly_recipe') {
    const removed = removeReadOnlyTree(tool ?? {}, owned, retainBranch)
    result = removed.output
      ? { ...removed, output: `${project!.name} readonly remove:\n${removed.output}` }
      : removed
  } else {
    const projectOwned = w.source === 'recipe' ||
      (w.source === undefined && Boolean(tool))
    const removed: { removed: boolean; detail: string; output?: string } = tool && projectOwned
      ? removeWithTool(tool, owned, forceOrchTree, retainBranch, runId)
      : removeWorktree(owned, retainBranch)
    result = removed.output
      ? { ...removed, output: `${project!.name} remove:\n${removed.output}` }
      : removed
  }
  if (result.removed && owningRunId !== undefined && owningRunId !== null) {
    removeSharedRefGuard(repoRoot, owningRunId)
  }
  return result
}

/** Reclaim orphans the project knows about — databases, containers, metadata. */
export function sweepWithTool(
  tool: WorktreeTool, repoRoot: string,
): { ok: boolean; out: string; exitCode: number | null } | null {
  if (!tool.sweep) return null
  const result = runShellTool(tool.sweep, {}, repoRoot)
  return { ok: result.ok, out: result.out, exitCode: result.exitCode }
}

export function removeWorktree(w: Worktree, keepBranch = false): { removed: boolean; detail: string } {
  const deleteBranch = Boolean(w.branch) && !keepBranch
  // Never prune the repository; remove only this worktree's own record.
  // Already gone is a SUCCESS, not an error. A worktree deleted by hand, or one
  // in a scratch repository that has since been cleaned up, leaves a database
  // pointer that ought to be clearable — refusing would strand it for ever.
  if (!existsSync(w.path)) {
    gitOk(['worktree', 'remove', '--force', w.path], w.repoRoot)
    if (deleteBranch) gitOk(['branch', '-D', w.branch], w.repoRoot)
    const branch = deleteBranch ? branchTip(w.repoRoot, w.branch) : null
    return branch !== null
      ? { removed: false, detail: `git could not remove branch ${w.branch}; it remains at ${branch}` }
      : { removed: true, detail: `${w.path} was already gone` }
  }
  // REPORTED, not swallowed. This function's own comment says a removal that
  // silently fails leaves the run's changes on disk with nothing pointing at
  // them — and then it discarded git's answer, after which `orch discard`
  // cleared the database pointer and said "discarded". A locked or busy
  // worktree produced exactly the orphan the comment warned about, announced
  // as a success.
  const gone = gitOk(['worktree', 'remove', '--force', w.path], w.repoRoot) !== null
  if (deleteBranch) gitOk(['branch', '-D', w.branch], w.repoRoot)
  const branch = deleteBranch ? branchTip(w.repoRoot, w.branch) : null
  return (gone || !existsSync(w.path)) && (!deleteBranch || branch === null)
    ? { removed: true, detail: w.path }
    : branch !== null
    ? { removed: false, detail: `git could not remove branch ${w.branch}; it remains at ${branch}` }
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

/** Read a local branch tip so cleanup can restore a ref another run still records. */
export function branchTip(repoRoot: string, branch: string): string | null {
  return gitOk(['rev-parse', '--verify', `refs/heads/${branch}`], repoRoot)
}

export type UnmergedBranch = { count: number; tip: string }

/**
 * Commits reachable only from this local branch — deleting it would lose them.
 *
 * Counted against every other branch, remote, and tag. Callers may additionally
 * exclude the recorded cut when they need the human-facing count of commits
 * made after that cut, but branch retention always uses the null-base form:
 * deleting the ref must not lose its cut commit after another ref is rewound.
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

/** Restore a protected branch, retaining git's refusal for an actionable cleanup report. */
export function restoreBranch(
  repoRoot: string, branch: string, tip: string,
): { ok: true } | { ok: false; error: string } {
  const ref = `refs/heads/${branch}`
  const existing = gitOk(['rev-parse', '--verify', ref], repoRoot)
  if (existing === tip) return { ok: true }
  if (existing !== null) {
    return { ok: false, error: `branch already exists at ${existing}` }
  }
  const zero = '0000000000000000000000000000000000000000'
  const p = Bun.spawnSync(['git', 'update-ref', ref, tip, zero], {
    cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe',
  })
  return p.exitCode === 0
    ? { ok: true }
    : { ok: false, error: p.stderr.toString().trim() || `exit ${p.exitCode}` }
}
