import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  appendCollectLeaseContention,
  appendCollectLeaseHold,
  COLLECT_LEASE_UNREADABLE_CAUSE,
  type CollectLeaseContentionEntry,
} from '../../shared/collect-lease-log.ts'
import { DEFAULT_IDLE_CAP_MS } from '../../shared/interval.ts'
import { sendOperatorNotification } from '../../shared/operator-notification.ts'
import { refusal, renderRefusal } from '../../shared/refusal.ts'
import { FAST_MS, SLOW_MS } from './collect-cadence.ts'
import {
  type WatchRunningCycle,
  type WatchTick,
  watchCycleDecision,
} from './collect-watch-schedule.ts'
import { db, hostedDeliveryRefusal, nowIso, writeTransaction } from './db.ts'
import {
  type HostedChangeLegReport,
  type HostedChangesReport,
  hostedChangeLegLine,
  hostedChangesLines,
  pullHostedChanges,
} from './hosted-change-cache.ts'
import { resolveHostedUrl } from './hosted-url.ts'

export { resolveHostedUrl }

import type { IngestReport } from './ingest/batches.ts'
import { ingestGit } from './ingest/git.ts'
import { ingestRunChanges, ingestRuns } from './ingest/runs.ts'
import {
  ingestTrackers,
  successfulTrackerRead,
  type TrackerResult,
  trackerLegError,
  trackerProjects,
  trackerProjectsReadSince,
} from './ingest/trackers.ts'
import { ingestTranscripts } from './ingest/transcripts.ts'
import { correctStoredIntervalProjects } from './interval-project-correction.ts'
import { deliverOperatorWaitingEmails } from './operator-waiting-email.ts'
import { claimWaitingNotifications } from './orch.ts'
import {
  drainHostedOutbox,
  type HostedOutboxReport,
  hostedOutboxLine,
  pendingHostedOutboxSummary,
} from './outbox.ts'
import { HostedOutboxDrainSchedule, type PendingHostedOutbox } from './outbox-fast-cycle.ts'
import { pruneOutboxTrace } from './outbox-trace.ts'
import { applyProjectRegisterNames } from './project-record-id.ts'
import { rollUpDays } from './query.ts'
import { readSettingStamp, stampSetting } from './setting-stamp.ts'
import {
  acquireStoredLeaseIntent,
  acquireStoredLeaseWhen,
  holdStoredLease,
  releaseStoredLease,
  type StoredLeaseGuard,
  type StoredLeaseStartFacts,
  storedLeaseHolder,
  storedLeaseSnapshot,
} from './store-lease.ts'
import { hoursAgo } from './time.ts'
import { WRITE_HOLD_LOG_MS } from './write-hold.ts'

/** The liveness window for a watcher heartbeat. */
export const WATCH_LIVE_MS = 3 * FAST_MS

const WATCH_ALIVE_KEY = 'collect.watch.alive'

export type WatcherAlive = {
  holder: string
  pid: number
  at: string
}

export type LiveWatcherHeartbeat = {
  holder: string
  ageSeconds: number
}

const QUIET_MAX_MS = 15 * 60_000
const FAILURE_MAX_MS = 60 * 60_000

type PollState = { nextAt: number; quiet: number; failures: number }

/**
 * Per-project adaptive cadence for the watch loop.
 *
 * A changing tracker stays on the five-minute floor. Quiet trackers step to
 * ten and then fifteen minutes. Failures double out to an hour, so an outage
 * cannot produce a request every tick. This schedule is deliberately
 * process-local: restarting the watch means "fresh now", not "honor an old
 * delay". A one-shot collect instead skips a tracker whose last successful
 * read, persisted by any process, falls within `SLOW_MS`; collecting tasks
 * explicitly, or rebuilding with `--since`, reads every tracker. The injected clock keeps this policy
 * deterministic in tests.
 */
export class TrackerPollSchedule {
  private state = new Map<string, PollState>()
  private clock: () => number

  constructor(clock: () => number = Date.now) {
    this.clock = clock
  }

  due(projects: readonly string[]): Set<string> {
    const now = this.clock()
    return new Set(projects.filter((project) => (this.state.get(project)?.nextAt ?? 0) <= now))
  }

  record(result: TrackerResult) {
    if (result.project === 'backfill') return
    const previous = this.state.get(result.project) ?? {
      nextAt: 0,
      quiet: 0,
      failures: 0,
    }
    const failed = Boolean(result.error || result.skipped)
    const failures = failed ? previous.failures + 1 : 0
    const quiet = failed ? previous.quiet : result.activity ? 0 : previous.quiet + 1
    const delay = failed
      ? Math.min(SLOW_MS * 2 ** failures, FAILURE_MAX_MS)
      : result.activity
        ? SLOW_MS
        : Math.min(SLOW_MS * (quiet + 1), QUIET_MAX_MS)
    this.state.set(result.project, {
      nextAt: this.clock() + delay,
      quiet,
      failures,
    })
  }
}

const trackerSchedule = new TrackerPollSchedule()

export function oneShotTrackerSelection(
  projectNames: readonly string[],
  fresh: ReadonlySet<string>,
  forced: boolean,
  liveWatcher: boolean,
): { only: ReadonlySet<string> | null; skippedFresh: number; leftToWatcher: number } {
  if (forced) return { only: null, skippedFresh: 0, leftToWatcher: 0 }
  if (liveWatcher) return { only: new Set(), skippedFresh: 0, leftToWatcher: projectNames.length }
  return {
    only: new Set(projectNames.filter((project) => !fresh.has(project))),
    skippedFresh: fresh.size,
    leftToWatcher: 0,
  }
}

function liveWatcherHeartbeat(
  alive: string | null | undefined,
  now: number,
): LiveWatcherHeartbeat | null {
  if (!alive) return null
  try {
    const parsed: unknown = JSON.parse(alive)
    if (!parsed || typeof parsed !== 'object') return null
    const value = parsed as Partial<WatcherAlive>
    if (
      typeof value.holder !== 'string' ||
      typeof value.pid !== 'number' ||
      typeof value.at !== 'string'
    )
      return null
    const at = Date.parse(value.at)
    if (!Number.isFinite(at) || now - at > WATCH_LIVE_MS) return null
    return { holder: value.holder, ageSeconds: Math.max(0, Math.floor((now - at) / 1000)) }
  } catch {
    return null
  }
}

export function watcherLive(alive: string | null | undefined, now: number): boolean {
  return liveWatcherHeartbeat(alive, now) !== null
}

export type CollectLegResult =
  | {
      source: string
      ok: true
      durationMs: number
      metrics?: CollectLegMetrics
      hostedChanges?: HostedChangeLegReport | HostedChangesReport
      hostedOutbox?: HostedOutboxReport
      trackerCounts?: { read: number; skippedFresh: number; leftToWatcher: number }
    }
  | { source: string; ok: false; error: string; durationMs: number }

/** Cycle work returns the legs it ran, or nothing when it ran none. */
type CollectCycleResult = CollectLegResult[] | undefined

type CollectLegMetrics = {
  examined: number
  written: number
  unchanged: number
  skippedUnlinked?: number
  unreadable?: number
}

function collectLegMetrics(report: IngestReport): CollectLegMetrics {
  return {
    examined: report.examined,
    written: report.rows,
    unchanged: report.skipped,
    ...(report.skippedUnlinked ? { skippedUnlinked: report.skippedUnlinked } : {}),
    ...(report.unreadable ? { unreadable: report.unreadable } : {}),
  }
}

export function formatCollectLeg(result: CollectLegResult): string {
  const separator = result.source.length >= 18 ? ' ' : ''
  if (!result.ok) return `${result.source.padEnd(18)}${separator}FAILED: ${result.error}`
  if (result.hostedChanges)
    return `${result.source.padEnd(18)}${separator}${
      'families' in result.hostedChanges
        ? hostedChangesLines(result.hostedChanges) || 'ok'
        : hostedChangeLegLine(result.hostedChanges)
    }`
  if (result.hostedOutbox)
    return `${result.source.padEnd(18)}${separator}${hostedOutboxLine(result.hostedOutbox)}`
  if (result.trackerCounts) {
    const counts = [`${result.trackerCounts.read} trackers read`]
    if (result.trackerCounts.leftToWatcher)
      counts.push(
        `${result.trackerCounts.leftToWatcher} left to the watcher; force with ${PLATFORM_SLUG} record pull --only tasks`,
      )
    if (result.trackerCounts.skippedFresh)
      counts.push(`${result.trackerCounts.skippedFresh} skipped fresh`)
    return `${result.source.padEnd(18)}${separator}ok (${counts.join(', ')})`
  }
  return `${result.source.padEnd(18)}ok`
}

type CollectLegSuccess = Omit<Extract<CollectLegResult, { ok: true }>, 'source' | 'durationMs'>

async function settleTimedLeg<T>(
  source: string,
  work: () => Promise<T>,
  success: (value: T) => CollectLegSuccess | null,
): Promise<CollectLegResult | null> {
  const startedAt = Date.now()
  try {
    const details = success(await work())
    return details === null ? null : { source, ...details, durationMs: Date.now() - startedAt }
  } catch (error) {
    const message = (error as Error).message
    console.error(`hub: ${source} collect failed: ${message}`)
    return { source, ok: false, error: message, durationMs: Date.now() - startedAt }
  }
}

async function settleLeg<T>(
  source: string,
  work: () => Promise<T>,
  metrics?: (value: T) => CollectLegMetrics,
): Promise<CollectLegResult> {
  return (await settleTimedLeg(source, work, (value) => ({
    ok: true,
    ...(metrics ? { metrics: metrics(value) } : {}),
  })))!
}

type HostedCollectDependencies = {
  outbox: () => Promise<HostedOutboxReport>
  correctIntervals?: () => void
  changes?: () => Promise<HostedChangesReport | HostedChangeLegReport | null | undefined>
}

async function hostedCollectLegs(
  guard: LeaseGuard | undefined,
  dependencies: HostedCollectDependencies,
): Promise<CollectLegResult[]> {
  ;(dependencies.correctIntervals ?? correctStoredIntervalProjects)()
  const results: CollectLegResult[] = []
  guard?.assertHeld()
  results.push(await collectHostedOutboxOnce(dependencies.outbox))
  guard?.assertHeld('hosted outbox')
  const changeLegs = [{ source: 'hosted changes', work: dependencies.changes ?? pullHostedChanges }]
  let previous = 'hosted outbox'
  for (const { source, work } of changeLegs) {
    guard?.assertHeld(previous)
    const result = await settleChangeLeg(source, work)
    if (result) results.push(result)
    previous = source
    guard?.assertHeld(previous)
  }
  return results
}

export async function collectHostedOutboxOnce(
  outbox: () => Promise<HostedOutboxReport> = () => drainHostedOutbox({ processKind: 'collector' }),
): Promise<CollectLegResult> {
  return (await settleTimedLeg('hosted outbox', outbox, (report) => ({
    ok: true,
    hostedOutbox: report,
  })))!
}

async function settleChangeLeg(
  source: string,
  work: () => Promise<HostedChangesReport | HostedChangeLegReport | null | undefined>,
): Promise<CollectLegResult | null> {
  return settleTimedLeg(source, work, (report) =>
    report == null ? null : { ok: true, hostedChanges: report },
  )
}

/** Long enough to outlast a slow pass, short enough that a dead holder frees it. */
export const COLLECT_LEASE_MS = 60_000
const LEASE_RENEW_MS = 20_000
const COLLECT_LEASE_KEY = 'collect.lease'
const COLLECT_INTENT_KEY = 'collect.lease.intent'

export type LeaseGuard = StoredLeaseGuard

export type CollectLeaseRefusalObservation = {
  heldBy: string | null
  holderAgeMs: number | null
  waitedMs: number
  /** The lease row exists but could not be parsed, so no holder could be observed. */
  leaseUnreadable?: true
}

function collectLeaseHolderClause(observation: CollectLeaseRefusalObservation): string {
  if (observation.leaseUnreadable) return `holder: ${COLLECT_LEASE_UNREADABLE_CAUSE}`
  if (!observation.heldBy) return 'holder: unknown'
  const age = observation.holderAgeMs === null ? '' : ` for ${observation.holderAgeMs / 1_000}s`
  return `holder: ${observation.heldBy}${age}`
}

/** Add the one collect-lease holder observation and remedy to a site's effect statement. */
export function formatCollectLeaseRefusal(
  firstClause: string,
  observation: CollectLeaseRefusalObservation,
): string {
  const holder = collectLeaseHolderClause(observation)
  return renderRefusal(
    refusal(`${firstClause}; ${holder}`, {
      kind: 'edit',
      text: `retry the command; the collect lease is held only while one collection runs; see the holder with ${PLATFORM_SLUG} record lease`,
    }),
  )
}

function collectLeaseContentionEntry(
  outcome: CollectLeaseContentionEntry['outcome'],
  waiter: string,
  observation: CollectLeaseRefusalObservation,
): CollectLeaseContentionEntry {
  return {
    at: new Date().toISOString(),
    waiter,
    waitedMs: observation.waitedMs,
    holder: observation.heldBy,
    holderAgeMs: observation.holderAgeMs,
    outcome,
    leaseUnreadable: observation.leaseUnreadable === true,
  }
}

function collectLeaseWaitObservation(
  lease: ReturnType<typeof collectLease>,
  waitedMs: number,
  expectedHolder?: string | null,
): CollectLeaseRefusalObservation {
  const unreadable = lease !== null && 'unreadable' in lease
  const observed = lease && !('unreadable' in lease) ? lease : null
  const expectsHolder = expectedHolder !== undefined
  const matchingObserved =
    observed && (!expectsHolder || observed.holder === expectedHolder) ? observed : null
  return {
    heldBy: expectsHolder ? expectedHolder : (observed?.holder ?? null),
    holderAgeMs: matchingObserved?.age ?? null,
    waitedMs,
    ...(unreadable ? { leaseUnreadable: true } : {}),
  }
}

/** Run work under one renewing lease that has already been acquired. */
async function holdAndRenewLease(
  holder: string,
  fn: (guard: LeaseGuard) => Promise<CollectCycleResult>,
  renewEveryMs: number,
) {
  const startedAt = Date.now()
  let legs: CollectLegResult[] = []
  let lossRecorded = false
  try {
    const result = await holdStoredLease({
      key: COLLECT_LEASE_KEY,
      holder,
      durationMs: COLLECT_LEASE_MS,
      renewEveryMs,
      trackSince: true,
      work: fn,
      lostMessage: (heldBy, afterLeg) => {
        const observation = collectLeaseWaitObservation(collectLease(), 0, heldBy)
        if (!lossRecorded) {
          appendCollectLeaseContention(collectLeaseContentionEntry('lost', holder, observation))
          lossRecorded = true
        }
        return formatCollectLeaseRefusal(
          `collection stopped${afterLeg ? ` after ${afterLeg}` : ''}, a running leg was allowed to finish`,
          observation,
        )
      },
    })
    if (result.value) legs = result.value
    return result
  } finally {
    const legDurations = legs
      .map((leg) => {
        const metrics = leg.ok ? leg.metrics : undefined
        return `${JSON.stringify(leg.source)}=${leg.durationMs}ms${
          metrics
            ? ` examined=${metrics.examined} written=${metrics.written} unchanged=${metrics.unchanged}${metrics.unreadable ? ` unreadable=${metrics.unreadable}` : ''}`
            : ''
        }`
      })
      .join(' ')
    const heldMs = Date.now() - startedAt
    console.error(
      `hub: collect lease hold holder=${JSON.stringify(holder)} held_ms=${heldMs}${legDurations ? ` legs ${legDurations}` : ''}`,
    )
    if (heldMs >= WRITE_HOLD_LOG_MS)
      appendCollectLeaseHold({
        at: new Date().toISOString(),
        holder,
        heldMs,
        legs: legDurations,
      })
  }
}

/**
 * Only one process collects at a time, across the whole machine.
 *
 * The server collects so the page is fresh while it is open, and a launchd
 * daemon collects so it is fresh when it is not. Both running means two writers
 * doing identical work — and the transcripts leg CLEARS a session's spans
 * before reinserting them, so an interleaved pair can have one process delete
 * rows the other is midway through writing.
 *
 * An in-process flag cannot see another process, so the lease lives in the
 * database. Acquisition is a single conditional UPDATE, which SQLite settles
 * atomically; whoever wins renews it each cycle and the loser simply waits.
 * A holder that dies renews nothing and the lease expires on its own.
 *
 * This decision stays separate from the adapter that atomically applies it.
 */
export function watcherMayStartCycle(watcherHolder: string, facts: StoredLeaseStartFacts): boolean {
  if (facts.leaseHolder !== null && facts.leaseHolder !== watcherHolder) return false
  if (facts.intentHolder === null) return true
  if (facts.intentHolder === watcherHolder) return true
  return facts.intentUntil !== null && facts.intentUntil <= facts.now
}

export function acquireLease(holder: string): boolean {
  return acquireStoredLeaseWhen(
    COLLECT_LEASE_KEY,
    COLLECT_INTENT_KEY,
    holder,
    COLLECT_LEASE_MS,
    (facts) => watcherMayStartCycle(holder, facts),
    true,
  )
}

export function explicitRequestMayAcquire(
  requestHolder: string,
  facts: StoredLeaseStartFacts,
): boolean {
  return (
    facts.intentHolder === null ||
    facts.intentHolder === requestHolder ||
    facts.intentUntil === null ||
    facts.intentUntil <= facts.now
  )
}

function acquireExplicitLease(holder: string): boolean {
  return acquireStoredLeaseWhen(
    COLLECT_LEASE_KEY,
    COLLECT_INTENT_KEY,
    holder,
    COLLECT_LEASE_MS,
    (facts) => explicitRequestMayAcquire(holder, facts),
    true,
  )
}

/**
 * Hand the lease back on the way out.
 *
 * Without this, stopping the dashboard leaves a lease nobody is renewing and
 * the daemon waits out its full sixty seconds before taking over — measured,
 * and a minute of a stale page for no reason. A holder that CRASHES still
 * relies on expiry, which is why the timeout exists at all.
 */
export function releaseLease(holder: string) {
  releaseStoredLease(COLLECT_LEASE_KEY, holder)
}

/** Observe the holder that outlasted a wait, record the refusal, and return it. */
function refuseLeaseWait(
  waiter: string,
  waitedMs: number,
): { ran: false } & CollectLeaseRefusalObservation {
  const observation = collectLeaseWaitObservation(collectLease(), waitedMs)
  console.error(
    `hub: collect lease wait waiter=${JSON.stringify(waiter)} waited_ms=${waitedMs} refused holder=${JSON.stringify(observation.heldBy ?? 'unknown')} holder_age_ms=${observation.holderAgeMs ?? 'unknown'}`,
  )
  appendCollectLeaseContention(collectLeaseContentionEntry('refused', waiter, observation))
  return { ran: false, ...observation }
}

/**
 * Run something holding the lease, WAITING for it rather than racing it.
 *
 * `watch()` may skip a cycle when another process is collecting - there will be
 * another along in twenty seconds. A one-shot `bottega record pull` and the refresh
 * button cannot skip: somebody asked for this pass specifically, and a backfill
 * over thirty days has no next cycle to fall back on.
 *
 * They must not simply barge in either, which is what they did. `bottega record pull`
 * called collect() directly and never touched the lease, so it interleaved
 * freely with the server's watcher and the launchd daemon - and the transcripts
 * leg CLEARS a session's spans before reinserting them. Measured: two identical
 * collects run beside `bottega dashboard start` disagreed by two hours on one project, and
 * were byte-identical the moment the server was stopped.
 *
 * The wait is generous next to the work - a fast pass is ~300ms and a slow one
 * a few seconds - so in practice this returns immediately or after one cycle.
 */
export async function withLease<T>(
  holder: string,
  fn: (guard: LeaseGuard) => Promise<T>,
  waitMs = 30_000,
  renewEveryMs = LEASE_RENEW_MS,
  collectLegs?: (value: T) => CollectLegResult[],
): Promise<{ ran: true; value: T } | ({ ran: false } & CollectLeaseRefusalObservation)> {
  const startedAt = Date.now()
  const deadline = startedAt + waitMs
  let polls = 0
  let ownsIntent = false
  let lastLeaseObservation: ReturnType<typeof collectLease> = null
  try {
    while (!acquireExplicitLease(holder)) {
      polls++
      lastLeaseObservation = collectLease()
      if (!ownsIntent) ownsIntent = acquireStoredLeaseIntent(COLLECT_INTENT_KEY, holder, deadline)
      if (Date.now() >= deadline) {
        return refuseLeaseWait(holder, Date.now() - startedAt)
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    if (polls > 1) {
      const observation = collectLeaseWaitObservation(lastLeaseObservation, Date.now() - startedAt)
      console.error(
        `hub: collect lease wait waiter=${JSON.stringify(holder)} waited_ms=${observation.waitedMs} acquired`,
      )
      appendCollectLeaseContention(collectLeaseContentionEntry('acquired', holder, observation))
    }
    if (ownsIntent) {
      releaseStoredLease(COLLECT_INTENT_KEY, holder)
      ownsIntent = false
    }
    let value: T | undefined
    const result = await holdAndRenewLease(
      holder,
      async (guard) => {
        value = await fn(guard)
        return collectLegs?.(value)
      },
      renewEveryMs,
    )
    if (result.ran) return { ran: true, value: value as T }
    return {
      ran: false,
      ...collectLeaseWaitObservation(collectLease(), Date.now() - startedAt, result.heldBy),
    }
  } finally {
    if (ownsIntent) releaseStoredLease(COLLECT_INTENT_KEY, holder)
  }
}

export function leaseHolder(): string | null {
  return storedLeaseHolder(COLLECT_LEASE_KEY)
}

export type CollectLeaseStatus = {
  holder: string
  since: number | null
  age: number | null
  until: number
}

/** Current collect lease state for read-only operator and cross-concern observation. */
export function collectLease(
  now = Date.now(),
): CollectLeaseStatus | import('./store-lease.ts').UnreadableStoredLease | null {
  const lease = storedLeaseSnapshot(COLLECT_LEASE_KEY, now)
  if (!lease) return null
  if ('unreadable' in lease) return lease
  return {
    ...lease,
    age: lease.since === null ? null : Math.max(0, now - lease.since),
  }
}

function watcherAliveValue(): string | null {
  return (
    db()
      .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key = ?')
      .get(WATCH_ALIVE_KEY)?.value ?? null
  )
}

export function currentLiveWatcher(now = Date.now()): LiveWatcherHeartbeat | null {
  return liveWatcherHeartbeat(watcherAliveValue(), now)
}

function writeWatcherAlive(holder: WatcherAlive['holder']) {
  const alive: WatcherAlive = { holder, pid: process.pid, at: nowIso() }
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO setting (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(WATCH_ALIVE_KEY, JSON.stringify(alive)),
  )
}

function deleteWatcherAlive(holder: WatcherAlive['holder']) {
  releaseStoredLease(WATCH_ALIVE_KEY, holder)
}

function attemptWatcherAliveWrite(action: () => void, onError: (error: Error) => void) {
  try {
    action()
  } catch (e) {
    onError(e as Error)
  }
}

function refreshWatcherAliveIfHeld(
  enabled: boolean,
  holder: string,
  onError: (error: Error) => void,
) {
  if (enabled && leaseHolder() === holder)
    attemptWatcherAliveWrite(() => writeWatcherAlive(holder), onError)
}

/**
 * How far back the fast runs collect looks.
 *
 * The rolling two-hour window is the ceiling when collection is current. If
 * the last successful ingest (collect.runs.at) is older than that, --since
 * is that watermark so a gap is caught up rather than skipped.
 */
export function runsSince(now = Date.now()): string {
  const windowStart = new Date(now - 2 * 3600_000).toISOString()
  const last = readSettingStamp('collect.runs.at')
  if (last === null) return windowStart
  if (!Number.isFinite(Date.parse(last))) return windowStart
  return last < windowStart ? last : windowStart
}

/**
 * The cheap legs: what changed in the last couple of hours.
 *
 * Two hours rather than the whole window because a span that changed is a
 * recent one, and re-reading thirty days every twenty seconds would burn the
 * machine re-deriving rows that cannot have moved. A missed collect looks
 * further back, to collect.runs.at, so an answer older than two hours is
 * not skipped.
 */
export async function collectFast(
  dependencies: {
    runs?: (since: string) => Promise<IngestReport>
    transcripts?: (since: string) => Promise<IngestReport>
  } = {},
  guard?: LeaseGuard,
  only?: string,
) {
  const selected = (source: string) => !only || only === source
  const runsFastLeg = selected('runs') || selected('transcripts')
  const results = [] as CollectLegResult[]
  guard?.assertHeld()
  if (selected('runs'))
    results.push(
      await settleLeg(
        'runs',
        () => (dependencies.runs ?? ingestRunChanges)(runsSince()),
        collectLegMetrics,
      ),
    )
  guard?.assertHeld(selected('runs') ? 'runs' : undefined)
  if (selected('transcripts'))
    results.push(
      await settleLeg(
        'transcripts',
        () => (dependencies.transcripts ?? ingestTranscripts)(hoursAgo(2)),
        collectLegMetrics,
      ),
    )
  guard?.assertHeld(selected('transcripts') ? 'transcripts' : undefined)
  if (runsFastLeg) {
    rollUpDays()
    guard?.assertHeld('roll up days')
    stampSetting('collect.at')
  }
  return results
}

export async function collectFastHostedOutbox(
  schedule: HostedOutboxDrainSchedule<HostedOutboxReport>,
  dependencies: { pending?: () => PendingHostedOutbox } = {},
  guard?: LeaseGuard,
): Promise<CollectLegResult | null> {
  const source = 'hosted outbox'
  guard?.assertHeld()
  const result = await settleTimedLeg(
    source,
    () => schedule.fast((dependencies.pending ?? pendingHostedOutboxSummary)()),
    (report) => (report ? { ok: true, hostedOutbox: report } : null),
  )
  guard?.assertHeld(result ? source : undefined)
  return result
}

/** Claim and deliver each waiting episode without allowing notification failure to stop collection. */
export async function deliverOperatorNotifications(
  dependencies: {
    claim?: typeof claimWaitingNotifications
    notify?: typeof sendOperatorNotification
    error?: (message: string) => void
  } = {},
): Promise<void> {
  const claim = dependencies.claim ?? claimWaitingNotifications
  const notify = dependencies.notify ?? sendOperatorNotification
  const error = dependencies.error ?? console.error
  let items: Awaited<ReturnType<typeof claimWaitingNotifications>>
  try {
    items = await claim()
  } catch (cause) {
    error(`hub: operator notification claim failed: ${String(cause)}`)
    return
  }
  for (const item of items) {
    try {
      notify(item.notification)
    } catch (cause) {
      error(`hub: operator notification delivery failed: ${String(cause)}`)
    }
  }
}

/** Keep waiting-email delivery behind the store identity decided once when the watcher starts. */
export async function deliverOperatorWaitingEmailsWhenAllowed(
  deliveryOffReason: string | null,
  deliver: typeof deliverOperatorWaitingEmails = deliverOperatorWaitingEmails,
): Promise<void> {
  if (!deliveryOffReason) await deliver()
}

function reportWatchDeliveryRefusal(results: CollectCycleResult): boolean {
  const refused = results?.find((leg) => leg.ok && leg.hostedOutbox?.deliveryOffReason)
  if (!refused) return false
  console.log(formatCollectLeg(refused))
  return true
}

async function collectSlowSourceLegs(
  scheduled: boolean,
  guard: LeaseGuard | undefined,
  only?: string,
) {
  const collectGit = !only || only === 'git'
  const collectTasks = !only || only === 'tasks'
  const results = [] as CollectLegResult[]
  let lastCompleted = 'project identity'
  if (collectGit) {
    results.push(await settleLeg('git', () => ingestGit(hoursAgo(24 * 7).slice(0, 10))))
    lastCompleted = 'git'
  }
  guard?.assertHeld(lastCompleted)
  const registeredTrackers = collectTasks ? trackerProjects() : []
  const fresh =
    collectTasks && !scheduled && !only
      ? trackerProjectsReadSince(registeredTrackers, Date.now() - SLOW_MS)
      : new Set<string>()
  const liveWatcher = !scheduled && watcherLive(watcherAliveValue(), Date.now())
  const selection = oneShotTrackerSelection(
    registeredTrackers,
    fresh,
    only === 'tasks',
    liveWatcher,
  )
  const due = scheduled ? trackerSchedule.due(registeredTrackers) : selection.only
  let trackerResults: TrackerResult[] = []
  if (collectTasks) {
    results.push(
      (await settleTimedLeg(
        'tasks',
        async () => {
          trackerResults = due?.size === 0 ? [] : await ingestTrackers(due)
          if (scheduled) for (const result of trackerResults) trackerSchedule.record(result)
          const error = trackerLegError(trackerResults)
          if (error) throw new Error(error)
          return {
            read: trackerResults.filter(successfulTrackerRead).length,
            skippedFresh: selection.skippedFresh,
            leftToWatcher: selection.leftToWatcher,
          }
        },
        (trackerCounts) => ({ ok: true, trackerCounts }),
      ))!,
    )
    lastCompleted = 'tasks'
  }
  guard?.assertHeld(lastCompleted)
  return { results, lastCompleted, ran: collectGit || collectTasks }
}

/** The remote and commit-shaped legs. */
async function collectSlow(
  scheduled = false,
  guard?: LeaseGuard,
  outboxSchedule?: HostedOutboxDrainSchedule<HostedOutboxReport>,
  only?: string,
) {
  guard?.assertHeld()
  writeTransaction((conn) => applyProjectRegisterNames(conn))
  guard?.assertHeld('project identity')
  const slow = await collectSlowSourceLegs(scheduled, guard, only)
  const results = slow.results
  let lastCompleted = slow.lastCompleted
  if (slow.ran) {
    stampSetting('collect.slow.at')
    pruneOutboxTrace()
  }
  if (!only && resolveHostedUrl()) {
    const outbox = outboxSchedule
      ? () => outboxSchedule.slow()
      : () => drainHostedOutbox({ processKind: 'collector' })
    guard?.assertHeld(lastCompleted)
    const hostedResults = await hostedCollectLegs(guard, { outbox })
    results.push(...hostedResults)
    lastCompleted = hostedResults.at(-1)?.source ?? lastCompleted
    guard?.assertHeld('hosted')
  }
  guard?.assertHeld(lastCompleted)
  if (slow.ran) {
    if (only) {
      rollUpDays()
      guard?.assertHeld('roll up days')
    }
    stampSetting('collect.at')
  }
  return results
}

const UNGUARDED_LEASE: LeaseGuard = { assertHeld() {} }

/** Run both incremental cadences immediately, without tracker scheduling. */
export async function collectIncremental(
  only?: string,
  guard: LeaseGuard = UNGUARDED_LEASE,
): Promise<CollectLegResult[]> {
  const fast = await collectFast({}, guard, only)
  const slow = await collectSlow(false, guard, undefined, only)
  return [...fast, ...slow]
}

export async function collectOnce(
  since: string,
  only?: string,
  guard: LeaseGuard = UNGUARDED_LEASE,
  dependencies: {
    git?: typeof ingestGit
    runs?: typeof ingestRuns
    transcripts?: typeof ingestTranscripts
    trackers?: typeof ingestTrackers
  } = {},
) {
  const selected = (source: string) => !only || only === source
  const results = [] as CollectLegResult[]
  let previous: string | undefined
  guard.assertHeld()
  writeTransaction((conn) => applyProjectRegisterNames(conn))
  previous = 'project identity'
  if (selected('git')) {
    guard.assertHeld(previous)
    results.push(await settleLeg('git', () => (dependencies.git ?? ingestGit)(since.slice(0, 10))))
    previous = 'git'
    guard.assertHeld(previous)
  }
  if (selected('runs')) {
    guard.assertHeld(previous)
    results.push(
      await settleLeg(
        'runs',
        () => (dependencies.runs ?? ingestRuns)(since),
        (report) => collectLegMetrics({ examined: report.rows + report.skipped, ...report }),
      ),
    )
    previous = 'runs'
    guard.assertHeld(previous)
  }
  if (selected('transcripts')) {
    guard.assertHeld(previous)
    results.push(
      await settleLeg(
        'transcripts',
        () =>
          (dependencies.transcripts ?? ingestTranscripts)(since, DEFAULT_IDLE_CAP_MS, undefined, {
            rebuild: true,
          }),
        collectLegMetrics,
      ),
    )
    previous = 'transcripts'
    guard.assertHeld(previous)
  }
  if (selected('tasks')) {
    guard.assertHeld(previous)
    results.push(
      (await settleTimedLeg(
        'tasks',
        async () => {
          const trackerResults = await (dependencies.trackers ?? ingestTrackers)()
          for (const result of trackerResults) {
            const note = result.skipped
              ? `skipped: ${result.skipped}`
              : result.error
                ? `FAILED: ${result.error}`
                : `${result.mode ? `${result.mode} read, ` : ''}${result.tasks} tasks, ${result.changed} status changes${result.deleted ? `, ${result.deleted} deleted dropped` : ''}`
            console.log(`${`tracker/${result.project}`.padEnd(21)}${note}`)
          }
          const error = trackerLegError(trackerResults)
          if (error) throw new Error(error)
          return {
            read: trackerResults.filter(successfulTrackerRead).length,
            skippedFresh: 0,
            leftToWatcher: 0,
          }
        },
        (trackerCounts) => ({ ok: true, trackerCounts }),
      ))!,
    )
    previous = 'tasks'
    guard.assertHeld(previous)
  }
  if (!only && resolveHostedUrl()) {
    const outbox = () => drainHostedOutbox({ processKind: 'collector' })
    guard.assertHeld(previous)
    const hostedResults = await hostedCollectLegs(guard, { outbox })
    results.push(...hostedResults)
    previous = hostedResults.at(-1)?.source ?? previous
    guard.assertHeld(previous)
  }
  guard.assertHeld(previous)
  rollUpDays()
  guard.assertHeld('roll up days')
  stampSetting('collect.at')
  return results
}

/**
 * Collect on a clock until stopped.
 *
 * Used by `bottega record pull --watch` under launchd and by `bottega dashboard start`, which is why
 * it takes a holder name: whichever acquires the lease does the work, and the
 * other waits without duplicating it.
 */
type WatchDependencies = {
  initial?: (
    guard: LeaseGuard,
    outboxSchedule: HostedOutboxDrainSchedule<HostedOutboxReport> | null,
  ) => Promise<CollectCycleResult>
  fast?: (
    guard: LeaseGuard,
    outboxSchedule: HostedOutboxDrainSchedule<HostedOutboxReport> | null,
  ) => Promise<CollectCycleResult>
  slow?: (
    guard: LeaseGuard,
    outboxSchedule: HostedOutboxDrainSchedule<HostedOutboxReport> | null,
  ) => Promise<CollectCycleResult>
  outbox?: () => Promise<HostedOutboxReport>
  pendingOutbox?: () => PendingHostedOutbox
  outboxClock?: () => string
  renewEveryMs?: number
}

function watchOutboxSchedule(
  dependencies: WatchDependencies,
): HostedOutboxDrainSchedule<HostedOutboxReport> | null {
  if (!resolveHostedUrl()) return null
  return new HostedOutboxDrainSchedule(
    dependencies.outbox ?? (() => drainHostedOutbox({ processKind: 'collector' })),
    dependencies.outboxClock ?? nowIso,
  )
}

async function runFastWatchPreamble(
  deliveryOffReason: string | null,
  leaseGuard: LeaseGuard,
): Promise<CollectLegResult[]> {
  leaseGuard.assertHeld()
  await deliverOperatorNotifications()
  leaseGuard.assertHeld('operator notifications')
  await deliverOperatorWaitingEmailsWhenAllowed(deliveryOffReason)
  leaseGuard.assertHeld('operator waiting emails')
  return collectFast({}, leaseGuard)
}

function initialWatchWork(
  deliveryOffReason: string | null,
  outboxSchedule: HostedOutboxDrainSchedule<HostedOutboxReport> | null,
): NonNullable<WatchDependencies['initial']> {
  return async (leaseGuard) => {
    const fastResults = await runFastWatchPreamble(deliveryOffReason, leaseGuard)
    const slowResults = await collectSlow(true, leaseGuard, outboxSchedule ?? undefined)
    return [...fastResults, ...slowResults]
  }
}

export function watch(
  holder: string,
  onError = (e: Error) => console.error(`hub: ${e.message}`),
  dependencies: WatchDependencies = {},
) {
  const outboxSchedule = watchOutboxSchedule(dependencies)
  const deliveryOffReason = hostedDeliveryRefusal()
  let running: WatchRunningCycle = null
  let slowOwed = false
  let stopping = false
  let reportedDeliveryOff = false
  let dispatch = (_tick: WatchTick) => {}
  const startCycle = (
    work: (
      guard: LeaseGuard,
      outboxSchedule: HostedOutboxDrainSchedule<HostedOutboxReport> | null,
    ) => Promise<CollectCycleResult>,
    cycle: Exclude<WatchRunningCycle, null>,
    heartbeat = false,
  ) => {
    if (stopping || running !== null || !acquireLease(holder)) return false
    running = cycle
    if (heartbeat) attemptWatcherAliveWrite(() => writeWatcherAlive(holder), onError)
    void (async () => {
      // A failed collect must not stop the loop or take the server down: the
      // stored data is still the last good reading, which is the point of having
      // stored it.
      try {
        const result = await holdAndRenewLease(
          holder,
          (guard) => work(guard, outboxSchedule),
          dependencies.renewEveryMs ?? LEASE_RENEW_MS,
        )
        if (!result.ran) onError(result.error)
        else if (!reportedDeliveryOff)
          reportedDeliveryOff = reportWatchDeliveryRefusal(result.value)
      } catch (e) {
        onError(e as Error)
      } finally {
        running = null
        dispatch(null)
      }
    })()
    return true
  }

  const fast =
    dependencies.fast ??
    (async (leaseGuard) => {
      const results = await runFastWatchPreamble(deliveryOffReason, leaseGuard)
      if (outboxSchedule) {
        const result = await collectFastHostedOutbox(
          outboxSchedule,
          { pending: dependencies.pendingOutbox },
          leaseGuard,
        )
        if (result && (!result.ok || !result.hostedOutbox?.deliveryOffReason))
          console.log(formatCollectLeg(result))
        if (result) results.push(result)
      }
      return results
    })
  const slow =
    dependencies.slow ??
    ((leaseGuard) => collectSlow(true, leaseGuard, outboxSchedule ?? undefined))
  // The old pair of fire-and-forget calls made `slow` observe `busy` from
  // `fast` and skip the initial tracker pass. Keep both initial legs under the
  // same guard so scheduling starts with a real observation.
  const initial = dependencies.initial ?? initialWatchWork(deliveryOffReason, outboxSchedule)
  dispatch = (tick) => {
    const decision = watchCycleDecision({ running, slowOwed, tick, stopping })
    slowOwed = decision.slowOwed
    if (!decision.run) {
      if (running !== null && tick === 'fast') refreshWatcherAliveIfHeld(true, holder, onError)
      return
    }
    const started = startCycle(
      decision.run === 'fast' ? fast : slow,
      decision.run,
      decision.run === 'fast',
    )
    if (!started && decision.run === 'slow') slowOwed = true
  }
  startCycle(initial, 'initial', true)
  const a = setInterval(() => dispatch('fast'), FAST_MS)
  const b = setInterval(() => dispatch('slow'), SLOW_MS)

  const stop = async () => {
    stopping = true
    clearInterval(a)
    clearInterval(b)
    while (running !== null) await Bun.sleep(10)
    releaseLease(holder)
    attemptWatcherAliveWrite(() => deleteWatcherAlive(holder), onError)
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await stop()
      process.exit(0)
    })
  }
  return stop
}
