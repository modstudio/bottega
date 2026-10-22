import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  type AttributionKind,
  AttributionKindSchema,
  type ConfinementClass,
  ConfinementClassSchema,
  emptyAttribution,
} from '../../../shared/orch-contract.ts'
import { observeBoundedSubprocess } from '../../../shared/process-identity.ts'
import type { CheckoutToWatch } from '../git/checkout-identity.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'

const UNTRUSTED_INDEX_WINDOW_MS = 1000
const UNTRUSTED_RETRY_WAIT_MS = 1100

export type { AttributionKind }

export type FrozenCheckout = CheckoutToWatch & {
  status: string
  head: string | null
  expectedHead: string | null
  indexTree: string | null
  untrackedHash: string | null
  headOid: string | null
  untrusted: boolean
}

type ConfinementLockHolder = {
  pid: number
  command: string | null
  sessionId: string | null
}

export type ConfinementEvent = {
  classification: ConfinementClass
  /** Optional because stored events may not include a checkout. */
  checkout?: string
  attribution: AttributionKind
  lockHolderObservation?: 'complete' | 'unknown'
  lockHolder: ConfinementLockHolder | null
  landingSession: string | null
  landingId: string | null
  removalSession?: string | null
  removalRun?: string | null
  divergentPaths: string[]
  overlappingPaths: string[]
  chainRoot: string | null
  tripTip: string | null
  freeze: FrozenCheckout[]
  after: FrozenCheckout[]
}

export type { CheckoutToWatch } from '../git/checkout-identity.ts'
export type FreezeFailure = CheckoutToWatch & { error: string; missing?: boolean }

function checkoutIsMissing(path: string): boolean {
  try {
    statSync(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: { ...targetGitEnvironment(cwd), GIT_OPTIONAL_LOCKS: '0' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    ok: p.exitCode === 0,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  }
}

function porcelainPaths(status: string): string[] {
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

function untrackedPathHash(cwd: string): string | null {
  const listed = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (!listed.ok) return null
  const paths = listed.stdout.split('\0').filter(Boolean).sort()
  return createHash('sha256').update(paths.join('\0')).digest('hex')
}

function indexTreeHash(cwd: string): string | null {
  const written = git(cwd, ['write-tree'])
  return written.ok ? written.stdout.trim() || null : null
}

function headOid(cwd: string): string | null {
  const parsed = git(cwd, ['rev-parse', 'HEAD'])
  return parsed.ok ? parsed.stdout.trim() || null : null
}

function indexPath(cwd: string): string | null {
  const parsed = git(cwd, ['rev-parse', '--git-path', 'index'])
  if (!parsed.ok) return null
  const path = parsed.stdout.trim()
  if (!path) return null
  return path.startsWith('/') ? path : join(cwd, path)
}

function indexIsUntrusted(cwd: string, now = Date.now()): boolean {
  const path = indexPath(cwd)
  if (!path || !existsSync(path)) return false
  try {
    return Math.abs(now - statSync(path).mtimeMs) < UNTRUSTED_INDEX_WINDOW_MS
  } catch {
    return false
  }
}

function samplePorcelain(
  cwd: string,
): { ok: true; status: string; head: string | null } | { ok: false; error: string } {
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

function freezeCheckout(
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
    caller: checkout.caller,
    writeExcluded: checkout.writeExcluded,
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
        missing: checkoutIsMissing(checkout.path),
      })
    }
  }
  return { snapshots, failures }
}

const pathIsAtOrBelow = (path: string, root: string): boolean => {
  const offset = relative(resolve(root), resolve(path))
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

const pathsOverlap = (left: string, right: string): boolean =>
  pathIsAtOrBelow(left, right) || pathIsAtOrBelow(right, left)

export function callerCheckoutWatch(
  watched: CheckoutToWatch[],
  writableRoots: string[] | null,
): CheckoutToWatch[] {
  return watched.map((checkout) => ({
    ...checkout,
    caller: true,
    writeExcluded: Boolean(
      writableRoots && !writableRoots.some((root) => pathsOverlap(checkout.path, root)),
    ),
  }))
}

export function classifyRemovedCallerCheckout(
  failure: FreezeFailure,
): 'removed' | 'unverified' | null {
  if (!failure.missing || !failure.caller) return null
  return failure.writeExcluded ? 'removed' : 'unverified'
}

const CONFINEMENT_LOCK_LSOF_TIMEOUT_MS = 10_000

export function lockHolderObservationIsUnknown(result: {
  exitCode: number | null
  signalCode?: string | number | null
  exitedDueToTimeout?: boolean
}): boolean {
  return (
    result.exitedDueToTimeout === true ||
    (result.signalCode !== null && result.signalCode !== undefined) ||
    result.exitCode === null
  )
}

function lockHolderPids(checkout: string): {
  holders: ConfinementLockHolder[]
  observation: 'complete' | 'unknown'
} {
  const gitDir = git(checkout, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const lock = gitDir.ok ? join(gitDir.stdout.trim(), 'index.lock') : null
  if (!lock || !existsSync(lock)) return { holders: [], observation: 'complete' }
  let owner: ReturnType<typeof Bun.spawnSync>
  try {
    ;({ process: owner } = observeBoundedSubprocess(
      'lsof',
      ['lsof', '-nP', '-Fpc', '--', lock],
      {
        stdout: 'pipe',
        stderr: 'ignore',
      },
      CONFINEMENT_LOCK_LSOF_TIMEOUT_MS,
    ))
  } catch {
    return { holders: [], observation: 'unknown' }
  }
  if (lockHolderObservationIsUnknown(owner)) return { holders: [], observation: 'unknown' }
  if (owner.exitCode !== 0) return { holders: [], observation: 'complete' }
  let pid: number | null = null
  let command: string | null = null
  const holders: ConfinementLockHolder[] = []
  for (const line of (owner.stdout?.toString() ?? '').split('\n')) {
    if (line.startsWith('p')) {
      if (pid !== null) holders.push({ pid, command, sessionId: null })
      pid = Number(line.slice(1))
      command = null
    } else if (line.startsWith('c')) {
      command = line.slice(1)
    }
  }
  if (pid !== null) holders.push({ pid, command, sessionId: null })
  return {
    holders: holders.filter((holder) => Number.isInteger(holder.pid) && holder.pid > 0),
    observation: 'complete',
  }
}

function sessionForPid(database: Database, pid: number): string | null {
  const row = database
    .query(`SELECT session_id FROM run WHERE pid=? OR agent_pid=? ORDER BY number DESC LIMIT 1`)
    .get(pid, pid) as { session_id: string | null } | null
  return row?.session_id ?? null
}

function landingThatMovedHead(
  database: Database,
  project: string,
  startedAt: string,
): { sessionId: string | null; landingId: string } | null {
  const row = database
    .query(
      `SELECT record_id, session_id FROM landing
      WHERE project_record_id=(SELECT record_id FROM project WHERE name=?) AND status='landed'
        AND datetime(COALESCE(finished_at, started_at)) >= datetime(?)
      ORDER BY started_at DESC,record_id DESC LIMIT 1`,
    )
    .get(project, startedAt) as { record_id: string; session_id: string | null } | null
  return row ? { sessionId: row.session_id, landingId: row.record_id } : null
}

function attributeDivergence(
  database: Database,
  checkout: FrozenCheckout,
  opts: { startedAt: string; headMoved: boolean },
): Pick<
  ConfinementEvent,
  'attribution' | 'lockHolderObservation' | 'lockHolder' | 'landingSession' | 'landingId'
> {
  const lockHolders = lockHolderPids(checkout.path)
  const holder = lockHolders.holders[0]
    ? {
        ...lockHolders.holders[0],
        sessionId: sessionForPid(database, lockHolders.holders[0].pid),
      }
    : null
  const landing = opts.headMoved
    ? landingThatMovedHead(database, checkout.project, opts.startedAt)
    : null
  if (lockHolders.observation === 'unknown') {
    return {
      attribution: 'unattributed',
      lockHolderObservation: 'unknown',
      lockHolder: null,
      landingSession: landing?.sessionId ?? null,
      landingId: landing?.landingId ?? null,
    }
  }
  if (holder) {
    return {
      attribution: 'lock_holder',
      lockHolderObservation: 'complete',
      lockHolder: holder,
      landingSession: landing?.sessionId ?? null,
      landingId: landing?.landingId ?? null,
    }
  }
  if (landing) {
    return {
      attribution: 'landing',
      lockHolderObservation: 'complete',
      lockHolder: null,
      landingSession: landing.sessionId,
      landingId: landing.landingId,
    }
  }
  return {
    attribution: 'unattributed',
    lockHolderObservation: 'complete',
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
    removed: 0,
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
    const changedPaths = paths.filter(
      (path) => !originalPaths.has(path) || original.status !== current.status,
    )
    const oidMoved = Boolean(
      original.headOid && current.headOid && original.headOid !== current.headOid,
    )
    const treeMoved =
      original.indexTree !== current.indexTree || original.untrackedHash !== current.untrackedHash
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
    startedAt: input.startedAt,
    headMoved: selected.headMoved,
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

export type CheckoutRemovalAttribution = {
  attribution: Extract<AttributionKind, 'tree_removal' | 'unattributed'>
  removalSession: string | null
  removalRun: string | null
}

function checkoutRemovalAttribution(
  database: Database,
  checkout: string,
  startedAt: string,
): CheckoutRemovalAttribution {
  const removal = database
    .query(
      `SELECT resource_claim.root_run_record_id removal_run, run.session_id removal_session
       FROM resource_claim JOIN run ON run.record_id=resource_claim.root_run_record_id
       WHERE resource_claim.kind='worktree' AND resource_claim.allocation_key=?
         AND resource_claim.state IN ('released','absent')
         AND datetime(resource_claim.settled_at) >= datetime(?)
       ORDER BY resource_claim.settled_at DESC, resource_claim.id DESC LIMIT 1`,
    )
    .get(checkout, startedAt) as {
    removal_run: string
    removal_session: string | null
  } | null
  return {
    attribution: removal ? 'tree_removal' : 'unattributed',
    removalSession: removal?.removal_session ?? null,
    removalRun: removal?.removal_run ?? null,
  }
}

export function removedCallerCheckoutError(
  path: string,
  removal: CheckoutRemovalAttribution,
): string {
  const attribution =
    removal.attribution === 'tree_removal'
      ? `; removal attributed to session ${removal.removalSession ?? 'unknown'} (run ${removal.removalRun ?? 'unknown'})`
      : ''
  return `caller checkout ${path} was removed during the run and this run could have written it; confinement cannot be verified${attribution}`
}

export function freezeAfterCheckouts(input: {
  watched: CheckoutToWatch[]
  before: FrozenCheckout[]
  database: Database
  startedAt: string
}): {
  snapshots: FrozenCheckout[]
  failures: FreezeFailure[]
  removedCaller: FrozenCheckout | null
} {
  const after = freezeCheckouts(input.watched)
  const failures: FreezeFailure[] = []
  let removedCaller: FrozenCheckout | null = null
  for (const failure of after.failures) {
    const classification = classifyRemovedCallerCheckout(failure)
    if (classification === 'removed') {
      removedCaller = input.before.find((snapshot) => snapshot.path === failure.path) ?? null
      continue
    }
    failures.push({
      ...failure,
      error:
        classification === 'unverified'
          ? removedCallerCheckoutError(
              failure.path,
              checkoutRemovalAttribution(input.database, failure.path, input.startedAt),
            )
          : `after snapshot: ${failure.error}`,
    })
  }
  return { snapshots: after.snapshots, failures, removedCaller }
}

export function removedCheckoutEvent(input: {
  database: Database
  checkout: FrozenCheckout
  freeze: FrozenCheckout[]
  after: FrozenCheckout[]
  chainRoot: string | null
  startedAt: string
}): ConfinementEvent {
  const removal = checkoutRemovalAttribution(input.database, input.checkout.path, input.startedAt)
  return {
    classification: 'removed',
    checkout: input.checkout.path,
    attribution: removal.attribution,
    lockHolderObservation: 'complete',
    lockHolder: null,
    landingSession: null,
    landingId: null,
    removalSession: removal.removalSession,
    removalRun: removal.removalRun,
    divergentPaths: [],
    overlappingPaths: [],
    chainRoot: input.chainRoot,
    tripTip: null,
    freeze: input.freeze,
    after: input.after,
  }
}

export function classifyCheckoutChanges(input: {
  before: FrozenCheckout[]
  after: FrozenCheckout[]
  removedCaller: FrozenCheckout | null
  ownDiffPaths: string[]
  chainRoot: string | null
  database: Database
  startedAt: string
}): ConfinementEvent | null {
  const divergence = classifyDivergence(input)
  return divergence || !input.removedCaller
    ? divergence
    : removedCheckoutEvent({
        database: input.database,
        checkout: input.removedCaller,
        freeze: input.before,
        after: input.after,
        chainRoot: input.chainRoot,
        startedAt: input.startedAt,
      })
}

export function divergenceAttributionLabel(
  event: Pick<
    ConfinementEvent,
    'attribution' | 'lockHolderObservation' | 'lockHolder' | 'landingSession' | 'removalSession'
  >,
): string {
  return event.attribution === 'lock_holder'
    ? `lock_holder pid ${event.lockHolder?.pid ?? 'unknown'}` +
        (event.lockHolder?.sessionId ? ` session ${event.lockHolder.sessionId}` : '') +
        (event.lockHolder?.command ? ` (${event.lockHolder.command})` : '')
    : event.attribution === 'landing'
      ? `landing session ${event.landingSession ?? 'unknown'}`
      : event.attribution === 'tree_removal'
        ? `tree removal session ${event.removalSession ?? 'unknown'}`
        : event.lockHolderObservation === 'unknown'
          ? 'unattributed (lock holder unknown)'
          : 'unattributed'
}

export function overlappingError(event: ConfinementEvent): string {
  const who = divergenceAttributionLabel(event)
  const detail = event.after
    .map((change, index) => {
      const before = event.freeze[index]
      const porcelain = (status: string) =>
        status ? status.split('\0').filter(Boolean).join('\n') : '(clean)'
      return (
        `registered checkout ${change.project} at ${change.path}\n` +
        `attribution: ${who}\n` +
        `before HEAD: ${before?.headOid ?? before?.head ?? '(unknown)'}\n` +
        `after HEAD: ${change.headOid ?? change.head ?? '(unknown)'}\n` +
        `overlapping: ${event.overlappingPaths.join(', ') || '(none)'}\n` +
        `before:\n${porcelain(before?.status ?? '')}\nafter:\n${porcelain(change.status)}`
      )
    })
    .join('\n\n')
  const message = `confinement: overlapping outside change\nattribution: ${who}\n${detail}`
  const bytes = Buffer.from(message)
  if (bytes.length <= 1500) return message
  const suffix = Buffer.from('\n… [error bounded to 1500 bytes]')
  return (
    Buffer.from(bytes.subarray(0, 1500 - suffix.length))
      .toString('utf8')
      .replace(/\uFFFD$/, '') + suffix.toString()
  )
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

export function attributionCounts(
  events: Array<ConfinementEvent | null>,
): Record<AttributionKind, number> {
  const counts = emptyAttribution()
  for (const event of events) {
    if (!event) continue
    counts[event.attribution] += 1
  }
  return counts
}
