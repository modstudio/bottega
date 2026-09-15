// concern: project-lock

import { dlopen, FFIType } from 'bun:ffi'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { platform } from 'node:os'
import { join, resolve } from 'node:path'
import { scrubbedGitEnv } from '../../shared/git.ts'
import { tryWriteContention } from './db.ts'
import { git } from './git-environment.ts'
import { pidAlive } from './process-liveness.ts'

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
  try {
    value = readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
  if (/^\d+$/.test(value)) {
    const pid = Number(value)
    return Number.isSafeInteger(pid) && pid > 0
      ? {
          pid,
          startTime: null,
          incarnation: null,
          session: null,
          what: 'worktree creation',
          since: new Date(0).toISOString(),
        }
      : null
  }
  try {
    const parsed = JSON.parse(value) as Partial<ProjectLockParticipant>
    return Number.isSafeInteger(parsed.pid) &&
      Number(parsed.pid) > 0 &&
      typeof parsed.what === 'string' &&
      typeof parsed.since === 'string'
      ? {
          pid: Number(parsed.pid),
          session: typeof parsed.session === 'string' ? parsed.session : null,
          what: parsed.what,
          since: parsed.since,
          startTime: typeof parsed.startTime === 'string' ? parsed.startTime : null,
          incarnation: typeof parsed.incarnation === 'string' ? parsed.incarnation : null,
        }
      : null
  } catch {
    return null
  }
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
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (inspected.exitCode !== 0) return null
    const value = inspected.stdout.toString().trim()
    return PROCESS_START_TIME.test(value) ? value : null
  } catch {
    return null
  }
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

export type KernelLease = { release: () => void }

function kernelLease(fd: number): KernelLease {
  let released = false
  return {
    release: () => {
      if (released) return
      released = true
      flock(fd, LOCK_UN)
      closeSync(fd)
    },
  }
}

/** Acquire one non-blocking kernel lease, creating its file when requested. */
export function tryKernelLease(path: string, create = false): KernelLease | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDWR | (create ? constants.O_CREAT : 0), 0o600)
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (flock(fd, LOCK_EX | LOCK_NB) === 0) return kernelLease(fd)
  closeSync(fd)
  return null
}

/** Acquire a required kernel lease or refuse with its exact path. */
export function acquireKernelLease(path: string): KernelLease {
  const lease = tryKernelLease(path, true)
  if (!lease) throw new Error(`could not acquire run lease ${path}: lock is already held`)
  return lease
}

export function projectLockDir(repoRoot: string): string {
  const common = realpathSync(resolve(repoRoot, git(['rev-parse', '--git-common-dir'], repoRoot)))
  return join(common, 'orch', 'locks')
}

function legacyProjectLockPath(repoRoot: string, name: string): string {
  const common = realpathSync(resolve(repoRoot, git(['rev-parse', '--git-common-dir'], repoRoot)))
  return join(common, `orch-${name}.lock`)
}

function projectLockPaths(
  repoRoot: string,
  name: string,
): {
  lock: string
  owner: string
  waiters: string
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
  const lease = tryKernelLease(path)
  if (!lease) return true
  lease.release()
  return false
}

function lockLabel(name: string): string {
  return name === 'create' || name === 'worktree-create' ? 'worktree creation' : name
}

function waiterEntries(
  waitersDir: string,
): { name: string; participant: ProjectLockParticipant }[] {
  if (!existsSync(waitersDir)) return []
  return readdirSync(waitersDir)
    .flatMap((name) => {
      if (name.startsWith('.')) return []
      const participant = projectLockParticipant(join(waitersDir, name))
      return participant && pidAlive(participant.pid) ? [{ name, participant }] : []
    })
    .sort((a, b) => a.name.localeCompare(b.name))
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
        stale =
          !Number.isSafeInteger(held.pid) ||
          !pidAlive(held.pid!) ||
          !Number.isFinite(held.since) ||
          Date.now() - held.since! > TICKET_LOCK_STALE_MS
      } catch {
        // No owner file yet: the holder is between mkdir and write, or died there.
        try {
          stale = Date.now() - statSync(lock).mtimeMs > TICKET_LOCK_STALE_MS
        } catch {
          stale = false
        }
      }
      if (stale) {
        const gone = `${lock}.stale-${process.pid}-${randomUUID()}`
        try {
          renameSync(lock, gone)
          rmSync(gone, { recursive: true, force: true })
        } catch {
          /* lost the race */
        }
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
    try {
      n = Number(readFileSync(file, 'utf8').trim())
    } catch {
      n = 0
    }
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
    waiters: [
      ...waiterEntries(join(paths.waiters, '.legacy')),
      ...waiterEntries(paths.waiters),
    ].map((entry) => entry.participant),
  }
}

/** Kernel locks are released on process death, so there is no stale lock to reclaim. */
export function reclaimStaleProjectLock(
  repoRoot: string,
  name: string,
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
  repoRoot: string,
  name: string,
  identity: ProjectLockIdentity,
  action: () => T,
  timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS,
  _exposeWaiters = false,
  onWait?: (holder: ProjectLockParticipant | null, remainingMs: number) => void,
): T {
  const paths = projectLockPaths(repoRoot, name)
  if (heldProjectLocks.has(paths.lock)) return action()
  const incarnation = randomUUID()
  const participant: ProjectLockParticipant = {
    pid: process.pid,
    startTime: processStartTime(process.pid),
    incarnation,
    session: identity.session,
    what: identity.what,
    since: new Date().toISOString(),
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
    tryWriteContention(
      {
        sessionId: lockSession,
        resourceKind: 'lock',
        resourceKey: name,
        eventKind: 'timeout',
        durationMs: Math.max(0, Date.now() - waitStarted),
        cause: held
          ? `holder session ${held.session ?? 'unknown'}, pid ${held.pid}, ${held.what}`
          : `timed out waiting for ${lockLabel(name)}`,
      },
      lockContention,
    )
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

    try {
      return action()
    } finally {
      heldProjectLocks.delete(paths.lock)
      const ours = projectLockParticipant(paths.owner)
      if (lockFd !== null) {
        flock(lockFd, LOCK_UN)
        closeSync(lockFd)
      }
      if (ours?.incarnation === incarnation) rmSync(paths.owner, { force: true })
      if (waitedMs > 0) {
        tryWriteContention(
          {
            sessionId: lockSession,
            resourceKind: 'lock',
            resourceKey: name,
            eventKind: 'wait',
            durationMs: waitedMs,
            cause: `waited for ${lockLabel(name)}`,
          },
          lockContention,
        )
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
  repoRoot: string,
  name: string,
  identity: ProjectLockIdentity,
  action: () => T,
  timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS,
  exposeWaiters = false,
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
    pid: process.pid,
    startTime: processStartTime(process.pid),
    incarnation,
    session: identity.session,
    what: identity.what,
    since: new Date().toISOString(),
  }
  mkdirSync(paths.waiters, { recursive: true })
  const legacyWaiters = join(paths.waiters, '.legacy')
  mkdirSync(legacyWaiters, { recursive: true })
  const waiterName = `${nextWaiterTicket(legacyWaiters, deadline)}-${process.pid}-${incarnation}`
  const waiter = join(legacyWaiters, waiterName)
  writeFileSync(waiter, `${JSON.stringify(participant)}\n`)
  const lockSession = identity.session ?? process.env.CLAUDE_CODE_SESSION_ID ?? null
  const recordLegacyContention = (
    eventKind: 'timeout' | 'wait',
    holder: ProjectLockParticipant | null,
  ) => {
    tryWriteContention(
      {
        sessionId: lockSession,
        resourceKind: 'lock',
        resourceKey: name,
        eventKind,
        durationMs: Math.max(0, Date.now() - waitStarted),
        cause: holder
          ? `holder session ${holder.session ?? 'unknown'}, pid ${holder.pid}, ${holder.what}`
          : `${eventKind === 'timeout' ? 'timed out waiting' : 'waited'} for ${lockLabel(name)}`,
      },
      { busyTimeoutMs: 0 },
    )
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
            if (renamed?.incarnation === holder.incarnation)
              rmSync(gone, { recursive: true, force: true })
            else renameSync(gone, legacy)
          } catch {
            /* another contender changed the legacy gate */
          }
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
        repoRoot,
        name,
        identity,
        action,
        Math.max(0, deadline - Date.now()),
        exposeWaiters,
        onWait,
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
  name: string,
  timeoutMs: number,
  lock: string,
  held: ProjectLockParticipant | null,
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
  repoRoot: string,
  create: () => T,
  timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS,
): T {
  return withProjectLock(
    repoRoot,
    'create',
    { session: null, what: 'worktree creation' },
    create,
    timeoutMs,
  )
}

export function withCleanupLock<T>(
  repoRoot: string,
  identity: ProjectLockIdentity,
  action: () => T,
  timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS,
): T {
  return withProjectLock(repoRoot, 'cleanup', identity, action, timeoutMs, true)
}

export function worktreeLeaseName(worktreePath: string): string {
  let real = worktreePath
  try {
    real = realpathSync(worktreePath)
  } catch {
    /* the spelled path still keys the artifact */
  }
  return `tree-${createHash('sha256').update(real).digest('hex').slice(0, 16)}`
}

/**
 * Per-artifact lease. Holders take this first and the purpose lock second so
 * attachment, landing and cleanup of one tree cannot interleave, and cannot
 * deadlock with the purpose locks.
 */
export function withWorktreeLease<T>(
  repoRoot: string,
  worktreePath: string,
  identity: ProjectLockIdentity,
  action: () => T,
  timeoutMs = WORKTREE_CREATE_LOCK_TIMEOUT_MS,
): T {
  return withProjectLock(repoRoot, worktreeLeaseName(worktreePath), identity, action, timeoutMs)
}
