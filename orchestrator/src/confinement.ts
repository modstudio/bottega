import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import {
  AttributionKindSchema, ConfinementClassSchema, emptyAttribution, type AttributionKind, type ConfinementClass, } from '../../shared/orch-contract.ts'
import { targetGitEnvironment } from './git-environment.ts'

export const UNTRUSTED_INDEX_WINDOW_MS = 1000
export const UNTRUSTED_RETRY_WAIT_MS = 1100

export type { AttributionKind, ConfinementClass }

export type FrozenCheckout = {
  project: string
  path: string
  status: string
  head: string | null
  expectedHead: string | null
  indexTree: string | null
  untrackedHash: string | null
  headOid: string | null
  untrusted: boolean
}

export type ConfinementLockHolder = {
  pid: number
  command: string | null
  sessionId: string | null
}

export type ConfinementEvent = {
  classification: ConfinementClass
  /** Absent on events recorded before DEV-372. */
  checkout?: string
  attribution: AttributionKind
  lockHolder: ConfinementLockHolder | null
  landingSession: string | null
  landingId: number | null
  divergentPaths: string[]
  overlappingPaths: string[]
  chainRoot: string | null
  tripTip: string | null
  freeze: FrozenCheckout[]
  after: FrozenCheckout[]
}

export type CheckoutToWatch = { project: string; path: string; expectedHead?: string | null }

export type FreezeFailure = CheckoutToWatch & { error: string }

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: { ...targetGitEnvironment(cwd), GIT_OPTIONAL_LOCKS: '0' },
    stdout: 'pipe', stderr: 'pipe',
  })
  return {
    ok: p.exitCode === 0,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  }
}

export function porcelainPaths(status: string): string[] {
  const parts = status.split('\0').filter(Boolean)
  const paths: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    const rename = entry.startsWith('R') || entry.startsWith('C')
    const path = entry.length >= 3 && entry[2] === ' ' ? entry.slice(3) : entry.replace(/^.. /, '')
    const next = parts[i + 1]
    if (rename && next && !/^[ MADRCU?!]{2} /.test(next) && !next.startsWith('?? ')) {
      paths.push(path, next)
      i++
    } else if (path.includes(' -> ')) {
      const [from, to] = path.split(' -> ')
      if (from) paths.push(from)
      if (to) paths.push(to)
    } else if (path) {
      paths.push(path)
    }
  }
  return [...new Set(paths)]
}

export function untrackedPathHash(cwd: string): string | null {
  const listed = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (!listed.ok) return null
  const paths = listed.stdout.split('\0').filter(Boolean).sort()
  return createHash('sha256').update(paths.join('\0')).digest('hex')
}

export function indexTreeHash(cwd: string): string | null {
  const written = git(cwd, ['write-tree'])
  return written.ok ? written.stdout.trim() || null : null
}

export function headOid(cwd: string): string | null {
  const parsed = git(cwd, ['rev-parse', 'HEAD'])
  return parsed.ok ? parsed.stdout.trim() || null : null
}

export function indexPath(cwd: string): string | null {
  const parsed = git(cwd, ['rev-parse', '--git-path', 'index'])
  if (!parsed.ok) return null
  const path = parsed.stdout.trim()
  if (!path) return null
  return path.startsWith('/') ? path : join(cwd, path)
}

export function indexIsUntrusted(cwd: string, now = Date.now()): boolean {
  const path = indexPath(cwd)
  if (!path || !existsSync(path)) return false
  try {
    return Math.abs(now - statSync(path).mtimeMs) < UNTRUSTED_INDEX_WINDOW_MS
  } catch {
    return false
  }
}

function samplePorcelain(cwd: string):
  { ok: true; status: string; head: string | null } | { ok: false; error: string } {
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!status.ok) {
    return { ok: false, error: status.stderr.trim() || 'git status failed' }
  }
  const symbolic = git(cwd, ['symbolic-ref', '--short', 'HEAD'])
  return {
    ok: true,
    status: status.stdout,
    head: symbolic.ok ? symbolic.stdout.trim() || null : null,
  }
}

export function freezeCheckout(
  checkout: CheckoutToWatch,
  opts: { now?: number; wait?: (ms: number) => void } = {},
): FrozenCheckout {
  const now = opts.now ?? Date.now()
  let untrusted = indexIsUntrusted(checkout.path, now)
  if (untrusted) {
    opts.wait?.(UNTRUSTED_RETRY_WAIT_MS)
    untrusted = indexIsUntrusted(checkout.path, Date.now())
  }
  const porcelain = samplePorcelain(checkout.path)
  if (!porcelain.ok) throw new Error(porcelain.error)
  return {
    project: checkout.project,
    path: checkout.path,
    status: porcelain.status,
    head: porcelain.head,
    expectedHead: checkout.expectedHead ?? null,
    indexTree: indexTreeHash(checkout.path),
    untrackedHash: untrackedPathHash(checkout.path),
    headOid: headOid(checkout.path),
    untrusted,
  }
}

export function freezeCheckouts(
  watched: CheckoutToWatch[],
  opts: { now?: number; wait?: (ms: number) => void } = {},
): { snapshots: FrozenCheckout[]; failures: FreezeFailure[] } {
  const snapshots: FrozenCheckout[] = []
  const failures: FreezeFailure[] = []
  for (const checkout of watched) {
    try {
      snapshots.push(freezeCheckout(checkout, opts))
    } catch (error) {
      failures.push({
        ...checkout,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { snapshots, failures }
}

function lockHolderPids(checkout: string): ConfinementLockHolder[] {
  const gitDir = git(checkout, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const lock = gitDir.ok ? join(gitDir.stdout.trim(), 'index.lock') : null
  if (!lock || !existsSync(lock)) return []
  const owner = Bun.spawnSync(['lsof', '-nP', '-Fpc', '--', lock], {
    stdout: 'pipe', stderr: 'ignore',
  })
  if (owner.exitCode !== 0) return []
  let pid: number | null = null
  let command: string | null = null
  const holders: ConfinementLockHolder[] = []
  for (const line of owner.stdout.toString().split('\n')) {
    if (line.startsWith('p')) {
      if (pid !== null) holders.push({ pid, command, sessionId: null })
      pid = Number(line.slice(1))
      command = null
    } else if (line.startsWith('c')) {
      command = line.slice(1)
    }
  }
  if (pid !== null) holders.push({ pid, command, sessionId: null })
  return holders.filter((holder) => Number.isInteger(holder.pid) && holder.pid > 0)
}

export function sessionForPid(database: Database, pid: number): string | null {
  const row = database.query(
    `SELECT session_id FROM run WHERE pid=? OR agent_pid=? ORDER BY id DESC LIMIT 1`,
  ).get(pid, pid) as { session_id: string | null } | null
  return row?.session_id ?? null
}

export function landingThatMovedHead(
  database: Database,
  project: string,
  startedAt: string,
): { sessionId: string | null; landingId: number } | null {
  const row = database.query(
    `SELECT id, session_id FROM landing
      WHERE project=? AND status='landed'
        AND datetime(COALESCE(finished_at, started_at)) >= datetime(?)
      ORDER BY id DESC LIMIT 1`,
  ).get(project, startedAt) as { id: number; session_id: string | null } | null
  return row ? { sessionId: row.session_id, landingId: row.id } : null
}

export function attributeDivergence(
  database: Database,
  checkout: FrozenCheckout,
  opts: { startedAt: string; headMoved: boolean },
): Pick<ConfinementEvent, 'attribution' | 'lockHolder' | 'landingSession' | 'landingId'> {
  const holders = lockHolderPids(checkout.path)
  const holder = holders[0]
    ? { ...holders[0], sessionId: sessionForPid(database, holders[0].pid) }
    : null
  const landing = opts.headMoved
    ? landingThatMovedHead(database, checkout.project, opts.startedAt)
    : null
  if (holder) {
    return {
      attribution: 'lock_holder',
      lockHolder: holder,
      landingSession: landing?.sessionId ?? null,
      landingId: landing?.landingId ?? null,
    }
  }
  if (landing) {
    return {
      attribution: 'landing',
      lockHolder: null,
      landingSession: landing.sessionId,
      landingId: landing.landingId,
    }
  }
  return {
    attribution: 'unattributed',
    lockHolder: null,
    landingSession: null,
    landingId: null,
  }
}

export function classifyDivergence(input: {
  before: FrozenCheckout[]
  after: FrozenCheckout[]
  ownDiffPaths: string[]
  chainRoot: string | null
  database: Database
  startedAt: string
}): ConfinementEvent | null {
  const prior = new Map(input.before.map((snapshot) => [snapshot.path, snapshot]))
  const own = new Set(input.ownDiffPaths)
  const divergentPaths: string[] = []
  const overlappingPaths: string[] = []
  const strength: Record<ConfinementClass, number> = {
    non_overlapping: 1,
    edit_commit_cycle: 2,
    overlapping: 3,
  }
  let selected: {
    checkout: FrozenCheckout
    classification: ConfinementClass
    headMoved: boolean
  } | null = null
  for (const current of input.after) {
    const original = prior.get(current.path)
    if (!original) continue
    const paths = porcelainPaths(current.status)
    const originalPaths = new Set(porcelainPaths(original.status))
    const changedPaths = paths.filter((path) => !originalPaths.has(path) || original.status !== current.status)
    const oidMoved = Boolean(original.headOid && current.headOid && original.headOid !== current.headOid)
    const treeMoved = original.indexTree !== current.indexTree
      || original.untrackedHash !== current.untrackedHash
    const porcelainMoved = original.status !== current.status
    if (!oidMoved && !treeMoved && !porcelainMoved && original.head === current.head) continue
    const checkoutOverlaps: string[] = []
    for (const path of changedPaths.length ? changedPaths : paths) {
      divergentPaths.push(path)
      if (own.has(path)) {
        overlappingPaths.push(path)
        checkoutOverlaps.push(path)
      }
    }
    const cleanTree = !current.status && !porcelainMoved
    const classification: ConfinementClass = checkoutOverlaps.length
      ? 'overlapping'
      : oidMoved && cleanTree
        ? 'edit_commit_cycle'
        : 'non_overlapping'
    if (!selected || strength[classification] > strength[selected.classification]) {
      selected = { checkout: current, classification, headMoved: oidMoved }
    }
  }
  if (!selected) return null
  const who = attributeDivergence(input.database, selected.checkout, {
    startedAt: input.startedAt, headMoved: selected.headMoved,
  })
  return {
    classification: selected.classification,
    checkout: selected.checkout.path,
    ...who,
    divergentPaths: [...new Set(divergentPaths)],
    overlappingPaths: [...new Set(overlappingPaths)],
    chainRoot: input.chainRoot,
    tripTip: selected.checkout.headOid,
    freeze: input.before,
    after: input.after,
  }
}

export function overlappingError(event: ConfinementEvent): string {
  const who = event.attribution === 'lock_holder'
    ? `lock_holder pid ${event.lockHolder?.pid ?? 'unknown'}`
      + (event.lockHolder?.sessionId ? ` session ${event.lockHolder.sessionId}` : '')
      + (event.lockHolder?.command ? ` (${event.lockHolder.command})` : '')
    : event.attribution === 'landing'
      ? `landing session ${event.landingSession ?? 'unknown'}`
      : 'unattributed'
  const detail = event.after.map((change, index) => {
    const before = event.freeze[index]
    const porcelain = (status: string) => status
      ? status.split('\0').filter(Boolean).join('\n')
      : '(clean)'
    return `registered checkout ${change.project} at ${change.path}\n` +
      `attribution: ${who}\n` +
      `before HEAD: ${before?.headOid ?? before?.head ?? '(unknown)'}\n` +
      `after HEAD: ${change.headOid ?? change.head ?? '(unknown)'}\n` +
      `overlapping: ${event.overlappingPaths.join(', ') || '(none)'}\n` +
      `before:\n${porcelain(before?.status ?? '')}\nafter:\n${porcelain(change.status)}`
  }).join('\n\n')
  const message =
    `confinement: overlapping outside change\nattribution: ${who}\n${detail}`
  const bytes = Buffer.from(message)
  if (bytes.length <= 1500) return message
  const suffix = Buffer.from('\n… [error bounded to 1500 bytes]')
  return Buffer.from(bytes.subarray(0, 1500 - suffix.length))
    .toString('utf8').replace(/\uFFFD$/, '') + suffix.toString()
}

export function parseConfinement(value: string | null): ConfinementEvent | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as ConfinementEvent
    if (!ConfinementClassSchema.safeParse(parsed?.classification).success) return null
    if (!AttributionKindSchema.safeParse(parsed?.attribution).success) return null
    return parsed
  } catch {
    return null
  }
}

export function attributionCounts(events: Array<ConfinementEvent | null>): Record<AttributionKind, number> {
  const counts = emptyAttribution()
  for (const event of events) {
    if (!event) continue
    counts[event.attribution] += 1
  }
  return counts
}
